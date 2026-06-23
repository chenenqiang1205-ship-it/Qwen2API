const axios = require('axios')
const { logger } = require('../utils/logger')
const accountManager = require('../utils/account')
const { getProxyAgent, applyProxyToAxiosConfig } = require('../utils/proxy-helper')
const { generateUUID } = require('../utils/tools')
const { buildToolSystemPrompt, foldToolMessages, createToolCallStreamParser } = require('../utils/tool-prompt')

// 直接从 request.js 复用聊天请求机制（SSXMOD cookie + chat_id 创建流程）
// CLI 不再尝试独立的 OAuth 设备码流程（portal.qwen.ai 已死），而是通过
// chat.qwen.ai 与聊天控制器完全一致的认证管道发送请求。

const request = require('../utils/request')

// 直接从 request.js 复用聊天请求机制（SSXMOD cookie + chat_id 创建流程）。
// CLI 不再尝试独立的 OAuth 设备码流程（portal.qwen.ai 已死），而是通过
// chat.qwen.ai 与聊天控制器完全一致的认证管道发送请求。

const isJson = (obj) => obj && typeof obj === 'object'

module.exports = isJson

/**
 * 静默累计 CLI daily stats——异常不影响响应
 * @param {string} email - 账户邮箱
 * @param {Object} usage - upstream usage { prompt_tokens, completion_tokens }
 */
const attributeCliUsage = (email, usage) => {
    if (!email) return
    try {
        accountManager.accumulateStats(email, 'cli', {
            calls: 1,
            input: Number(usage?.prompt_tokens) || 0,
            output: Number(usage?.completion_tokens) || 0
        })
    } catch (e) {
        // 静默
    }
}

const MODEL_REDIRECT = {
    'qwen3.5-plus': 'coder-model',
}

const CLI_UNSUPPORTED_FIELDS = new Set([
    'frequency_penalty',
    'presence_penalty',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'n',
    'seed',
    'service_tier',
    'user'
])
const CLI_DEFAULT_SYSTEM_PART = {
    type: 'text',
    text: '',
    cache_control: {
        type: 'ephemeral'
    }
}

function pruneCliPayload(value) {
    if (Array.isArray(value)) {
        return value
            .map(item => pruneCliPayload(item))
            .filter(item => item !== undefined)
    }

    if (value && typeof value === 'object') {
        const nextObject = {}

        for (const [key, item] of Object.entries(value)) {
            if (CLI_UNSUPPORTED_FIELDS.has(key)) {
                continue
            }

            const nextValue = pruneCliPayload(item)
            if (nextValue === undefined) {
                continue
            }

            if (Array.isArray(nextValue) && nextValue.length === 0 && key !== 'messages') {
                continue
            }

            if (
                nextValue &&
                typeof nextValue === 'object' &&
                !Array.isArray(nextValue) &&
                Object.keys(nextValue).length === 0
            ) {
                continue
            }

            nextObject[key] = nextValue
        }

        return nextObject
    }

    if (value === null || value === undefined) {
        return undefined
    }

    return value
}

function isInjectedSystemPart(part) {
    return Boolean(
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        part.cache_control &&
        part.cache_control.type === 'ephemeral' &&
        typeof part.text === 'string'
    )
}

function makeCliTextPart(text) {
    return {
        type: 'text',
        text: typeof text === 'string' ? text : String(text ?? '')
    }
}

function appendCliSystemContent(systemParts, content) {
    if (content === undefined || content === null) {
        return
    }

    if (Array.isArray(content)) {
        for (const item of content) {
            appendCliSystemContent(systemParts, item)
        }
        return
    }

    if (typeof content === 'string') {
        systemParts.push(makeCliTextPart(content))
        return
    }

    if (typeof content === 'object') {
        if (isInjectedSystemPart(content)) {
            return
        }

        if (typeof content.text === 'string' && content.type === 'text') {
            systemParts.push(content)
            return
        }

        systemParts.push(content)
        return
    }

    systemParts.push(makeCliTextPart(content))
}

function ensureCliSystemMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return messages
    }

    const systemParts = [JSON.parse(JSON.stringify(CLI_DEFAULT_SYSTEM_PART))]
    const nonSystemMessages = []

    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue
        }

        const role = typeof message.role === 'string' ? message.role.toLowerCase() : ''
        if (role === 'system') {
            appendCliSystemContent(systemParts, message.content)
            continue
        }

        nonSystemMessages.push(message)
    }

    return [
        {
            role: 'system',
            content: systemParts
        },
        ...nonSystemMessages
    ]
}

/**
 * 读取流响应体为文本
 * @param {*} stream - 响应流
 * @returns {Promise<string>} 文本结果
 */
function readStreamBody(stream) {
    return new Promise((resolve, reject) => {
        if (!stream || typeof stream.on !== 'function') {
            resolve('')
            return
        }

        const chunks = []
        stream.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        })
        stream.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'))
        })
        stream.on('error', reject)
    })
}

/**
 * 尝试解析 CLI 错误详情
 * @param {*} data - 原始响应体
 * @returns {Promise<*>} 可序列化的详情
 */
async function normalizeCliErrorDetails(data) {
    if (data && typeof data.on === 'function') {
        const rawText = await readStreamBody(data)
        if (!rawText) {
            return ''
        }

        try {
            return JSON.parse(rawText)
        } catch (error) {
            return rawText
        }
    }

    if (Buffer.isBuffer(data)) {
        const rawText = data.toString('utf8')
        try {
            return JSON.parse(rawText)
        } catch (error) {
            return rawText
        }
    }

    return data
}

/**
 * 构造 CLI 错误日志上下文
 * @param {Error} error - 错误对象
 * @returns {Promise<object>} 日志上下文
 */
async function buildCliAxiosErrorLog(error) {
    return {
        message: error?.message,
        code: error?.code,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        details: await normalizeCliErrorDetails(error?.response?.data)
    }
}

function preprocessCliRequestBody(rawBody) {
    const clonedBody = rawBody && typeof rawBody === 'object' ? JSON.parse(JSON.stringify(rawBody)) : {}
    const body = pruneCliPayload(clonedBody) || {}

    if (body.model && MODEL_REDIRECT[body.model]) {
        body.model = MODEL_REDIRECT[body.model]
    }

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    let toolSystemPrompt = ''
    if (hasTools) {
        toolSystemPrompt = buildToolSystemPrompt(body.tools, { tool_choice: body.tool_choice })
        body.messages = foldToolMessages(body.messages || [])
    }

    if (Array.isArray(body.messages) && body.messages.length > 0) {
        body.messages = ensureCliSystemMessage(body.messages)

        if (hasTools && toolSystemPrompt) {
            const systemMsg = body.messages[0]
            if (systemMsg && systemMsg.role === 'system' && Array.isArray(systemMsg.content)) {
                systemMsg.content.push({ type: 'text', text: toolSystemPrompt })
            }
        }
    }

    if (body.stream_options && typeof body.stream_options === 'object' && Object.keys(body.stream_options).length === 0) {
        delete body.stream_options
    }

    return { body, hasTools, toolChoice: body.tool_choice || 'auto' }
}

function formatCliJsonResponse(data, fallbackModel) {
    if (!data || typeof data !== 'object') {
        return data
    }
    if (!data.object) {
        data.object = 'chat.completion'
    }
    if (!data.model && fallbackModel) {
        data.model = fallbackModel
    }
    if (!Array.isArray(data.choices)) {
        data.choices = []
    }
    return data
}

/**
 * 处理CLI聊天完成请求（支持OpenAI格式的流式和JSON响应）
 * @param {Object} req - Express请求对象
 * @param {Object} res - Express响应对象
 */
const handleCliChatCompletion = async (req, res) => {
    try {
        const { body, hasTools, toolChoice } = preprocessCliRequestBody(req.body)
        const isStream = body.stream === true

        logger.info(`CLI请求使用账号[${req.account.email}]开始处理`, 'CLI', '🚀')
        req.account.cli_info.request_number++

        const account = { ...req.account }
        if (req.account.cli_info && req.account.cli_info.access_token) {
            account.token = req.account.cli_info.access_token
        }

        const result = await request.sendChatRequest({ ...body, stream: true })

        if (!result.status) {
            logger.error(`CLI请求使用账号[${req.account.email}]处理失败 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '💥', result)
            accountManager.recordAccountFailure(req.account.email, null)
            return res.status(503).json({ error: { message: 'connection_error', type: 'connection_error', code: 503 } })
        }

        let buffer = ''
        const isSSE = result.response && typeof result.response.on === 'function'

        if (isSSE) {
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')

            let sseBuffer = ''
            let cliUsage = null
            const messageId = generateUUID()
            const toolParser = hasTools ? createToolCallStreamParser() : null

            result.response.on('data', (chunk) => {
                const text = chunk.toString('utf8')
                buffer += text

                sseBuffer += text
                let idx
                while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                    const frame = sseBuffer.slice(0, idx)
                    sseBuffer = sseBuffer.slice(idx + 2)
                    if (!frame.startsWith('data:')) continue
                    const payload = frame.slice(frame.indexOf(':') + 1).trim()
                    if (!payload || payload === '[DONE]') continue

                    try {
                        const parsed = JSON.parse(payload)
                        if (parsed?.usage) cliUsage = parsed.usage

                        if (toolParser && parsed?.choices?.[0]?.delta?.content) {
                            const content = parsed.choices[0].delta.content
                            const parsed2 = toolParser.push(content)
                            if (parsed2.textDelta) {
                                parsed.choices[0].delta.content = parsed2.textDelta
                                res.write(`data: ${JSON.stringify(parsed)}\n\n`)
                            }
                            if (parsed2.completedCalls.length > 0) {
                                for (const call of parsed2.completedCalls) {
                                    const headerDelta = {
                                        id: `chatcmpl-${messageId}`,
                                        object: 'chat.completion.chunk',
                                        created: Math.round(Date.now() / 1000),
                                        choices: [{
                                            index: 0,
                                            delta: {
                                                tool_calls: [{
                                                    index: call.index,
                                                    id: call.id,
                                                    type: 'function',
                                                    function: { name: call.function.name, arguments: '' }
                                                }]
                                            },
                                            finish_reason: null
                                        }]
                                    }
                                    res.write(`data: ${JSON.stringify(headerDelta)}\n\n`)

                                    const args = call.function.arguments || ''
                                    for (let offset = 0; offset < args.length; offset += 32) {
                                        const piece = args.slice(offset, offset + 32)
                                        res.write(`data: ${JSON.stringify({
                                            id: `chatcmpl-${messageId}`,
                                            object: 'chat.completion.chunk',
                                            created: Math.round(Date.now() / 1000),
                                            choices: [{
                                                index: 0,
                                                delta: { tool_calls: [{ index: call.index, function: { arguments: piece } }] },
                                                finish_reason: null
                                            }]
                                        })}\n\n`)
                                    }
                                }
                            }
                        } else {
                            res.write(`data: ${JSON.stringify(parsed)}\n\n`)
                        }
                    } catch (e) {
                        res.write(`data: ${payload}\n\n`)
                    }
                }

                if (!text.includes('data:') && (text.includes('FAIL') || text.includes('choices'))) {
                    logger.warn(`CLI检测到非SSE响应（可能是WAF），转为透传`, 'CLI')
                    res.write(text)
                    res.end()
                    return
                }
            })

            result.response.on('error', (streamError) => {
                logger.error(`CLI请求使用账号[${req.account.email}]流式传输失败 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '❌')
                accountManager.recordAccountFailure(req.account.email, streamError?.code)
                if (!res.headersSent) {
                    res.status(500).json({ error: { message: 'stream_error', type: 'stream_error', code: 500 } })
                }
            })

            result.response.on('end', () => {
                attributeCliUsage(req.account.email, cliUsage)

                if (toolParser) {
                    const tail = toolParser.flush()
                    if (tail.textDelta) {
                        res.write(`data: ${JSON.stringify({
                            id: `chatcmpl-${messageId}`,
                            object: 'chat.completion.chunk',
                            created: Math.round(Date.now() / 1000),
                            choices: [{ index: 0, delta: { content: tail.textDelta }, finish_reason: null }]
                        })}\n\n`)
                    }
                }

                const finishReason = (toolParser && toolParser.hasEmittedAnyCall()) ? 'tool_calls' : 'stop'
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl-${messageId}`,
                    object: 'chat.completion.chunk',
                    created: Math.round(Date.now() / 1000),
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
                })}\n\n`)

                if (cliUsage) {
                    res.write(`data: ${JSON.stringify({
                        id: `chatcmpl-${messageId}`,
                        object: 'chat.completion.chunk',
                        created: Math.round(Date.now() / 1000),
                        choices: [],
                        usage: cliUsage
                    })}\n\n`)
                }

                res.write('data: [DONE]\n\n')

                if (buffer && !res.headersSent) {
                    logger.warn(`CLI将非SSE响应透传为JSON`, 'CLI')
                    try {
                        const parsed = JSON.parse(buffer)
                        res.json(parsed)
                    } catch (e) {
                        logger.error(`CLI非SSE响应JSON解析失败`, 'CLI', '', e)
                        res.json({ error: { message: 'invalid_response', type: 'parse_error', code: 500 } })
                    }
                } else {
                    logger.success(`CLI请求使用账号[${req.account.email}]转发成功 (流式) - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI')
                    if (!res.writableEnded) {
                        res.end()
                    }
                }
            })
        }

    } catch (error) {
        logger.error(`CLI请求使用账号[${req.account.email}]处理异常 - 当前请求数: ${req.account.cli_info.request_number}`, 'CLI', '💥')
        accountManager.recordAccountFailure(req.account.email, error?.code)
        return res.status(503).json({ error: { message: 'connection_error', type: 'connection_error', code: 503 } })
    }
}

module.exports = {
    handleCliChatCompletion
}
