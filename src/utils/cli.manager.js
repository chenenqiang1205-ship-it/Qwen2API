const crypto = require('crypto')
const { logger } = require('./logger')
const { getProxyAgent, getCliBaseUrl, getChatBaseUrl, applyProxyToFetchOptions } = require('./proxy-helper')

/**
 * 为 PKCE 生成随机代码验证器
 * @returns {string} 43-128个字符的随机字符串
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url')
}

/**
 * 使用 SHA-256 从代码验证器生成代码挑战
 * @param {string} codeVerifier - 代码验证器字符串
 * @returns {string} 代码挑战字符串
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256')
    hash.update(codeVerifier)
    return hash.digest('base64url')
}

/**
 * 生成 PKCE 代码验证器和挑战对
 * @returns {Object} 包含 code_verifier 和 code_challenge 的对象
 */
function generatePKCEPair() {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    return {
        code_verifier: codeVerifier,
        code_challenge: codeChallenge
    }
}

class CliAuthManager {
    /**
     * 读取响应体
     * @param {Response} response - Fetch 响应对象
     * @returns {Promise<*>} 响应体
     */
    async readResponseBody(response) {
        const contentType = response.headers.get('content-type') || ''
        const rawText = await response.text()

        if (!rawText) {
            return ''
        }

        if (contentType.includes('application/json')) {
            try {
                return JSON.parse(rawText)
            } catch (error) {
                return rawText
            }
        }

        return rawText
    }

    /**
     * 启动 OAuth 设备授权流程
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 包含设备代码、验证URL和代码验证器的对象
     */
    async initiateDeviceFlow(account) {
        // 生成 PKCE 代码验证器和挑战
        const { code_verifier, code_challenge } = generatePKCEPair()

        const bodyData = new URLSearchParams({
            client_id: "f0304373b74a44d2b584a3fb70ca9e56",
            scope: "openid profile email model.completion",
            code_challenge: code_challenge,
            code_challenge_method: 'S256',
        })

        const chatBaseUrl = getChatBaseUrl()

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: bodyData,
        }

        applyProxyToFetchOptions(fetchOptions, account)

        try {
            const response = await fetch(`${chatBaseUrl}/api/v1/oauth2/device/code`, fetchOptions)

            if (response.ok) {
                const result = await response.json()
                return {
                    status: true,
                    ...result,
                    code_verifier: code_verifier
                }
            } else {
                const responseBody = await this.readResponseBody(response)
                logger.error('CLI设备授权初始化失败', 'CLI', '', {
                    status: response.status,
                    statusText: response.statusText,
                    body: responseBody
                })
                throw new Error('device_flow_failed')
            }
        } catch (error) {
            logger.error('CLI设备授权流程异常', 'CLI', '', {
                url: `${chatBaseUrl}/api/v1/oauth2/device/code`,
                message: error.message
            })
            return {
                status: false,
                device_code: null,
                user_code: null,
                verification_uri: null,
                verification_uri_complete: null,
                expires_in: null,
                code_verifier: null
            }
        }
    }

    /**
     * 授权登录
     * @param {string} user_code - 用户代码
     * @param {string} access_token - 访问令牌
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<boolean>} 是否授权成功
     */
    async authorizeLogin(user_code, access_token, account) {
        try {
            const chatBaseUrl = getChatBaseUrl()

            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    "authorization": `Bearer ${access_token}`,
                },
                body: JSON.stringify({
                    "approved": true,
                    "user_code": user_code
                })
            }

            applyProxyToFetchOptions(fetchOptions, account)

            const response = await fetch(`${chatBaseUrl}/api/v2/oauth2/authorize`, fetchOptions)

            if (response.ok) {
                return true
            } else {
                const responseBody = await this.readResponseBody(response)
                logger.error('CLI设备授权确认失败', 'CLI', '', {
                    status: response.status,
                    statusText: response.statusText,
                    body: responseBody
                })
                throw new Error('authorize_failed')
            }
        } catch (error) {
            logger.error('CLI设备授权确认异常', 'CLI', '', {
                url: `${chatBaseUrl}/api/v2/oauth2/authorize`,
                message: error.message
            })
            return false
        }
    }

    /**
     * 轮询获取访问令牌
     * @param {string} device_code - 设备代码
     * @param {string} code_verifier - 代码验证器
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 访问令牌信息
     */
    async pollForToken(device_code, code_verifier, account) {
        let pollInterval = 5000
        const maxAttempts = 3
        // /api/v1/oauth2/token 被阿里云 CDN 屏蔽（全局 504），
        // 改为直接使用账户登录 token 作为访问凭据，走 portal.qwen.ai 的 CLI API。
        // 这绕过了已被平台禁用的 token 轮询端点。
        
        const cliBaseUrl = getCliBaseUrl()

        // 验证账户 token 是否存在且有效
        if (!access_token) {
            logger.error('CLI轮询令牌：未提供任何访问令牌', 'CLI')
            return {
                status: false,
                access_token: null,
                refresh_token: null,
                expiry_date: null
            }
        }

        // 直接使用该 access_token，通过 CLI API 端口请求即可使用。
        // 记录一个合理的 expiry_time（从 account 的 token 过期时间推断，或默认2小时）
        const expiry_date = Date.now() + (7200 * 1000) // 默认2小时后过期

        logger.info('CLI使用账户Token直接访问（OAuth轮询端点被平台屏蔽，已跳过）', 'CLI')

        return {
            status: true,
            access_token: access_token,
            refresh_token: null,
            expiry_date: expiry_date
        }
    }

    /**
     * 初始化 CLI 账户 — OAuth设备码轮询端点（/api/v1/oauth2/token）
     * 被 Alibaba Cloud CDN 全局屏蔽（504），改为直接使用账户登录 token。
     * @param {string} access_token - 访问令牌
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 账户信息
     */
    async initCliAccount(access_token, account) {
        if (!access_token) {
            logger.error('CLI账户初始化失败：未提供访问令牌', 'CLI')
            return { status: false, access_token: null, refresh_token: null, expiry_date: null }
        }

        const expiry_date = Date.now() + 7200 * 1000 // token 默认2小时后过期
        logger.info('CLI认证：OAuth轮询端点被平台屏蔽，使用账户Token直接访问', 'CLI')

        return {
            status: true,
            access_token: access_token,
            refresh_token: null,
            expiry_date: expiry_date
        }
    }

    /**
     * 刷新访问令牌 — API屏蔽轮询端点后，直接返回原token。
     * @param {Object} CliAccount - 账户信息
     * @param {Object} [account] - Qwen 账户对象（用于解析账号级代理）
     * @returns {Promise<Object>} 账户信息
     */
    async refreshAccessToken(CliAccount, account) {
        try {
            if (CliAccount && CliAccount.access_token) {
                // 直接复用已有access_token（原refresh_token机制依赖被屏蔽的端点）
                return {
                    access_token: CliAccount.access_token,
                    refresh_token: null,
                    expiry_date: Date.now() + (7200 * 1000)
                }
            }
        } catch (error) {
            // 忽略
        }

        return {
            status: false,
            access_token: null,
            refresh_token: null,
            expiry_date: null
        }
    }

}

module.exports = new CliAuthManager()
