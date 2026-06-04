// 文件名: worker.js
// 描述: Gemini Web 到 OpenAI API 代理 (Cloudflare Worker 版本)
// 版本: 1.1.0 (基于 Python 项目迁移)
// 作者: 首席开发者体验架构师
// 部署: 将此文件内容复制到 Cloudflare Worker 在线编辑器，保存并部署。

// ==================== 第一部分: 配置即代码 (CONFIGURATION-AS-CODE) ====================
/**
 * 核心配置对象。部署前，请务必根据您的需求修改以下值。
 * 所有配置项均在此处集中定义，逻辑层从此读取。
 */
const CONFIG = {
    // --- 认证与安全 ---
    /** API 主密钥。客户端必须在请求头中携带 `Authorization: Bearer ${API_MASTER_KEY}` */
    API_MASTER_KEY: 'your-secret-master-key-here-change-me',
    /** 是否开启 API 密钥认证。设为 false 则禁用所有认证（仅推荐测试环境） */
    AUTH_ENABLED: true,

    // --- 上游服务 ---
    /** Gemini Web 的上游基础 URL。通常无需修改。 */
    UPSTREAM_BASE_URL: 'https://gemini.google.com',
    /** 特定账户前缀（用于非默认 Google 账户），例如：`/u/1`。默认为空字符串。 */
    ACCOUNT_PREFIX: '',
    /** Gemini 后端标识符 (bl 参数)。可能需要定期更新。 */
    GEMINI_BL: 'boq_assistant-bard-web-server_20260525.09_p0',
    /** 请求超时时间（毫秒）。 */
    REQUEST_TIMEOUT_MS: 180000, // 3 分钟
    /** 请求失败后的重试次数。 */
    RETRY_ATTEMPTS: 3,
    /** 重试之间的延迟（毫秒）。 */
    RETRY_DELAY_MS: 2000,

    // --- Cookie 与认证 (高级) ---
    /** Cookie 字符串，用于身份验证。格式: `__Secure-1PSID=xxx; __Secure-1PSIDTS=xxx; ...` */
    COOKIE_STRING: '',
    /** SAPISID 值，用于生成 SAPISIDHASH。通常从 Cookie 中提取。 */
    SAPISID: '',
    /** XSRF Token。 */
    XSRF_TOKEN: '',

    // --- 模型配置 ---
    /** 模型映射。键为模型 ID，值为包含 mode 和 think 值的配置对象。 */
    MODELS: {
        'gemini-3.5-flash': { mode: 1, think: 4, desc: '快速通用模型' },
        'gemini-3.5-flash-thinking': { mode: 2, think: 0, desc: '深度思考模式，最长输出 (~20k 字符)' },
        'gemini-3.1-pro': { mode: 3, think: 4, desc: '专业模型（通常需要 Cookie 进行真实路由）' },
        'gemini-auto': { mode: 4, think: 4, desc: '自动模型选择' },
        'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0, desc: '动态思考，自适应深度' },
        'gemini-flash-lite': { mode: 6, think: 4, desc: '轻量级快速模型' },
    },
    /** 当请求未指定模型时使用的默认模型。 */
    DEFAULT_MODEL: 'gemini-3.5-flash',

    // --- 项目元信息 (用于 UI) ---
    PROJECT_NAME: 'Gemini Web to OpenAI API 代理',
    PROJECT_VERSION: '1.1.0 (Worker)',
    PROJECT_DESCRIPTION: '将 Google Gemini Web 接口转换为 OpenAI 兼容 API 的 Cloudflare Worker 代理。',

    // --- 功能开关 ---
    /** 是否启用 API 请求的缓存（例如对 /v1/models 的 GET 请求）。 */
    ENABLE_CACHE: true,
    /** 缓存生存时间（秒）。 */
    CACHE_TTL: 300, // 5 分钟
    /** 是否在控制台记录请求日志。 */
    LOG_REQUESTS: true,
};

// ==================== 第二部分: 工具函数 (UTILITY FUNCTIONS) ====================
/**
 * 日志函数，当 LOG_REQUESTS 启用时在控制台输出日志。
 * @param {string} message - 日志信息
 * @param {...any} args - 附加参数
 */
function log(message, ...args) {
    if (CONFIG.LOG_REQUESTS) {
        console.log(`[${new Date().toISOString()}] ${message}`, ...args);
    }
}

/**
 * 生成 SAPISIDHASH 认证头。
 * @param {string} sapisid - 从 Cookie 中提取的 SAPISID 值。
 * @returns {string} SAPISIDHASH 头值。
 */
function makeSapisidHash(sapisid) {
    if (!sapisid) return '';
    const ts = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    const data = encoder.encode(`${ts} ${sapisid} https://gemini.google.com`);
    const hashBuffer = crypto.subtle
        ? crypto.subtle.digest('SHA-1', data)
        : Promise.resolve(null); // Cloudflare Worker 环境支持 crypto.subtle
    // 注意: 在实际异步函数中，我们需要 await 这个 Promise。这里先返回一个占位符函数。
    return `SAPISIDHASH ${ts}_${hashBuffer.then(h => Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''))}`;
}
// 由于 crypto.subtle 是异步的，我们将在异步上下文中调用此函数。

/**
 * 从 Gemini 的 StreamGenerate 原始响应中提取纯文本。
 * @param {string} rawResponse - 原始响应文本。
 * @returns {string} 提取出的文本。
 */
function extractResponseText(rawResponse) {
    const lines = rawResponse.split('\n');
    let finalText = '';
    for (const line of lines) {
        if (!line.includes('"wrb.fr"') || line.length < 200) continue;
        try {
            const arr = JSON.parse(line);
            const innerStr = arr[0]?.[2];
            if (!innerStr || innerStr.length < 50) continue;
            const inner = JSON.parse(innerStr);
            if (Array.isArray(inner) && inner[4]) {
                for (const part of inner[4]) {
                    if (Array.isArray(part) && part[1]) {
                        const textList = part[1];
                        if (Array.isArray(textList)) {
                            for (const t of textList) {
                                if (typeof t === 'string' && t.trim().length > 0) {
                                    // 倾向于取最后一个非空文本块
                                    finalText = t;
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // 忽略解析错误，继续处理下一行
        }
    }
    // 清理内部代码执行标记
    return finalText.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, '').trim();
}

/**
 * 清理 Gemini 响应文本，移除内部代码执行标记。
 * @param {string} text - 原始文本。
 * @returns {string} 清理后的文本。
 */
function cleanGeminiText(text) {
    return text.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, '').trim();
}

/**
 * 从文本中解析工具调用 (`tool_calls`)。
 * @param {string} text - 可能包含工具调用的文本。
 * @returns {[string, Array]} 返回 [清理后的文本, 工具调用数组]。
 */
function parseToolCalls(text) {
    const toolCalls = [];
    const pattern = /```tool_call\s*\n(.*?)\n```/gs;
    let cleanText = text;
    let match;
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
        try {
            const data = JSON.parse(m[1].trim());
            toolCalls.push({
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                type: 'function',
                function: {
                    name: data.name,
                    arguments: JSON.stringify(data.arguments || {}, null, 2),
                },
            });
        } catch (e) {
            // 忽略无效的 JSON
        }
    }
    cleanText = text.replace(pattern, '').trim();
    return [cleanText, toolCalls];
}

/**
 * 将 OpenAI 格式的 messages 数组转换为 Gemini 的提示字符串。
 * @param {Array} messages - OpenAI 格式的 messages 数组。
 * @param {Array} tools - 可选的 tools 数组。
 * @returns {string} 转换后的提示字符串。
 */
function messagesToPrompt(messages, tools = null) {
    const parts = [];
    if (tools && tools.length > 0) {
        const toolDefs = tools.map(tool => {
            const fn = tool.type === 'function' ? tool.function : tool;
            return {
                name: fn.name || '',
                description: fn.description || '',
                parameters: fn.parameters || {},
            };
        });
        parts.push(
            `[系统指令]: 您可以使用工具。要调用工具，请使用以下格式响应：\n` +
            '```tool_call\n{"name": "函数名", "arguments": {...}}\n```\n' +
            '仅在需要时使用 tool_call 代码块。\n\n' +
            `可用工具:\n${JSON.stringify(toolDefs, null, 2)}`
        );
    }
    for (const msg of messages) {
        const role = msg.role || 'user';
        let content = msg.content || '';
        if (Array.isArray(content)) {
            content = content
                .filter(c => c.type === 'text' || c.type === 'input_text')
                .map(c => c.text || '')
                .join(' ');
        }
        if (role === 'system') {
            parts.push(`[系统指令]: ${content}`);
        } else if (role === 'assistant') {
            if (msg.tool_calls) {
                const tcStrs = msg.tool_calls.map(tc => {
                    const fn = tc.function || {};
                    return `\`\`\`tool_call\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n\`\`\``;
                });
                parts.push(`[助理]: ${content || ''}\n` + tcStrs.join('\n'));
            } else {
                parts.push(`[助理]: ${content}`);
            }
        } else if (role === 'tool') {
            parts.push(`[工具结果 ${msg.name || ''}]: ${content}`);
        } else {
            // user 或其他角色
            parts.push(content || '');
        }
    }
    return parts.filter(p => p && p.trim().length > 0).join('\n\n');
}

/**
 * 解析模型名称，返回对应的 mode, think 值，以及可能的错误信息。
 * 支持在模型名后通过 `@think=` 覆盖 think 值，例如: `gemini-3.5-flash-thinking@think=4`
 * @param {string} modelName - 请求的模型名称。
 * @returns {[string, number, number, string|null]} [modelName, mode, think, errorMessage]
 */
function resolveModel(modelName) {
    let thinkOverride = null;
    let baseModelName = modelName;
    if (modelName.includes('@think=')) {
        [baseModelName, thinkStr] = modelName.split('@think=');
        thinkOverride = parseInt(thinkStr, 10);
        if (isNaN(thinkOverride)) {
            return [null, null, null, `@think= 参数必须是数字，收到: ${thinkStr}`];
        }
    }
    const modelConfig = CONFIG.MODELS[baseModelName];
    if (!modelConfig) {
        return [null, null, null, `未知模型: ${baseModelName}`];
    }
    return [
        baseModelName,
        modelConfig.mode,
        thinkOverride !== null ? thinkOverride : modelConfig.think,
        null, // 无错误
    ];
}

/**
 * 构建发送给 Gemini StreamGenerate 端点的请求负载。
 * @param {string} prompt - 用户提示。
 * @param {number} modelId - 模型 mode 值。
 * @param {number} thinkMode - 模型的 think 值。
 * @returns {[string, string]} 返回 [URL, 请求体]。
 */
function buildGeminiRequest(prompt, modelId, thinkMode) {
    const inner = new Array(80);
    inner[0] = [prompt, 0, null, null, null, null, 0];
    inner[1] = ['en'];
    inner[2] = ['', '', '', null, null, null, null, null, null, ''];
    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[thinkMode]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = [2];
    inner[53] = 0;
    inner[59] = crypto.randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = modelId;

    const outer = [null, JSON.stringify(inner)];
    const params = new URLSearchParams({ 'f.req': JSON.stringify(outer) });
    if (CONFIG.XSRF_TOKEN) {
        params.set('at', CONFIG.XSRF_TOKEN);
    }
    const body = params.toString();
    const reqId = Date.now() % 1000000;
    const prefix = CONFIG.ACCOUNT_PREFIX;
    const url = `${CONFIG.UPSTREAM_BASE_URL}${prefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${CONFIG.GEMINI_BL}&hl=en&_reqid=${reqId}&rt=c`;
    return [url, body];
}

// ==================== 第三部分: 请求转发与流式处理核心 ====================
/**
 * 处理上游 Gemini 的流式响应，并将其转换为 OpenAI 兼容的 SSE 流。
 * 此函数是核心，它处理背压，确保内存安全。
 * @param {Request} clientRequest - 原始的客户端请求对象。
 * @param {string} prompt - 转换后的提示词。
 * @param {number} modelId - 模型 ID (mode)。
 * @param {number} thinkMode - Think 模式。
 * @param {string} chatCompletionId - 为本次聊天生成的任务 ID。
 * @param {string} modelName - 模型名称。
 * @param {boolean} isToolCall - 是否为工具调用（工具调用需要完整响应，不支持逐字流）。
 * @returns {Response} 一个包含 SSE 流的 Response 对象。
 */
async function handleStreamingRequest(clientRequest, prompt, modelId, thinkMode, chatCompletionId, modelName, isToolCall = false) {
    const [url, body] = buildGeminiRequest(prompt, modelId, thinkMode);
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://gemini.google.com',
        'Referer': `${CONFIG.UPSTREAM_BASE_URL}${CONFIG.ACCOUNT_PREFIX}/app`,
        'X-Same-Domain': '1',
        'User-Agent': clientRequest.headers.get('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Request-ID': clientRequest.headers.get('X-Request-ID') || crypto.randomUUID(),
    };
    if (CONFIG.ACCOUNT_PREFIX) {
        headers['X-Goog-AuthUser'] = CONFIG.ACCOUNT_PREFIX.split('/').pop() || '0';
    }
    if (CONFIG.COOKIE_STRING) {
        headers['Cookie'] = CONFIG.COOKIE_STRING;
    }
    if (CONFIG.SAPISID) {
        // 注意：makeSapisidHash 是异步的，我们需要在此处计算
        const ts = Math.floor(Date.now() / 1000);
        const msgUint8 = new TextEncoder().encode(`${ts} ${CONFIG.SAPISID} https://gemini.google.com`);
        const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        headers['Authorization'] = `SAPISIDHASH ${ts}_${hashHex}`;
    }

    let upstreamResponse;
    for (let attempt = 0; attempt < CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
            upstreamResponse = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: body,
                signal: controller.signal,
                // Cloudflare 将自动尝试使用 HTTP/3
                cf: { http3: { enabled: true } },
            });
            clearTimeout(timeoutId);
            break; // 成功则跳出重试循环
        } catch (fetchError) {
            log(`向上游请求失败 (尝试 ${attempt + 1}/${CONFIG.RETRY_ATTEMPTS}):`, fetchError);
            if (attempt === CONFIG.RETRY_ATTEMPTS - 1) {
                // 最后一次尝试也失败
                return new Response(JSON.stringify({
                    error: {
                        message: `无法连接到上游服务: ${fetchError.message}`,
                        type: 'upstream_connection_error',
                    },
                }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // 等待一段时间后重试
            await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
        }
    }

    if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        log(`上游返回错误状态: ${upstreamResponse.status}`, errorText.substring(0, 500));
        return new Response(JSON.stringify({
            error: {
                message: `上游服务错误: ${upstreamResponse.status} ${upstreamResponse.statusText}`,
                details: errorText.substring(0, 1000),
                type: 'upstream_http_error',
            },
        }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // 创建可读流，用于转换上游的响应
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 启动异步处理
    (async () => {
        let buffer = '';
        let accumulatedText = '';
        let finished = false;
        const reader = upstreamResponse.body.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (!finished && !isToolCall) {
                        // 发送最终的停止块
                        const finalChunk = {
                            id: chatCompletionId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: modelName,
                            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        };
                        await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                        await writer.write(encoder.encode('data: [DONE]\n\n'));
                    }
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 最后一行可能不完整，放回缓冲区
                for (const line of lines) {
                    if (!line.includes('"wrb.fr"') || line.length < 200) continue;
                    try {
                        const arr = JSON.parse(line);
                        const innerStr = arr[0]?.[2];
                        if (!innerStr || innerStr.length < 50) continue;
                        const inner = JSON.parse(innerStr);
                        if (Array.isArray(inner) && inner[4]) {
                            for (const part of inner[4]) {
                                if (Array.isArray(part) && part[1] && Array.isArray(part[1])) {
                                    for (const t of part[1]) {
                                        if (typeof t === 'string' && t.length > accumulatedText.length) {
                                            const deltaText = t.slice(accumulatedText.length);
                                            const cleanDelta = cleanGeminiText(deltaText);
                                            if (cleanDelta) {
                                                if (isToolCall) {
                                                    // 工具调用：累积完整文本，稍后解析
                                                    accumulatedText += cleanDelta;
                                                } else {
                                                    // 普通流式：发送增量
                                                    const chunk = {
                                                        id: chatCompletionId,
                                                        object: 'chat.completion.chunk',
                                                        created: Math.floor(Date.now() / 1000),
                                                        model: modelName,
                                                        choices: [{ index: 0, delta: { content: cleanDelta }, finish_reason: null }],
                                                    };
                                                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                                                }
                                            }
                                            accumulatedText = t;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // 忽略单行解析错误
                    }
                }
            }
        } catch (e) {
            log('流处理内部错误:', e);
        } finally {
            if (isToolCall && accumulatedText) {
                // 对于工具调用，在流结束时，解析一次完整的工具调用
                const [finalText, toolCalls] = parseToolCalls(accumulatedText);
                const message = {
                    role: 'assistant',
                    content: finalText || null,
                    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
                };
                const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
                const chunk = {
                    id: chatCompletionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{ index: 0, delta: message, finish_reason: finishReason }],
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await writer.write(encoder.encode('data: [DONE]\n\n'));
            }
            await writer.close();
        }
    })().catch(e => {
        log('流处理包装器错误:', e);
        writer.close().catch(() => { });
    });

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Worker-Trace-ID': clientRequest.headers.get('X-Request-ID') || 'none',
        },
    });
}

/**
 * 处理非流式请求（一次性获取完整响应）。
 * @param {string} prompt - 提示词。
 * @param {number} modelId - 模型 ID。
 * @param {number} thinkMode - Think 模式。
 * @param {string} chatCompletionId - 聊天完成 ID。
 * @param {string} modelName - 模型名称。
 * @param {Array} tools - 工具列表。
 * @returns {Promise<Object>} OpenAI 格式的响应对象。
 */
async function handleNonStreamingRequest(prompt, modelId, thinkMode, chatCompletionId, modelName, tools) {
    const [url, body] = buildGeminiRequest(prompt, modelId, thinkMode);
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://gemini.google.com',
        'Referer': `${CONFIG.UPSTREAM_BASE_URL}${CONFIG.ACCOUNT_PREFIX}/app`,
        'X-Same-Domain': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (CONFIG.ACCOUNT_PREFIX) {
        headers['X-Goog-AuthUser'] = CONFIG.ACCOUNT_PREFIX.split('/').pop() || '0';
    }
    if (CONFIG.COOKIE_STRING) {
        headers['Cookie'] = CONFIG.COOKIE_STRING;
    }
    if (CONFIG.SAPISID) {
        const ts = Math.floor(Date.now() / 1000);
        const msgUint8 = new TextEncoder().encode(`${ts} ${CONFIG.SAPISID} https://gemini.google.com`);
        const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        headers['Authorization'] = `SAPISIDHASH ${ts}_${hashHex}`;
    }

    let lastError;
    for (let attempt = 0; attempt < CONFIG.RETRY_ATTEMPTS; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: body,
                signal: controller.signal,
                cf: { http3: { enabled: true } },
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }
            const raw = await response.text();
            const text = extractResponseText(raw);
            const [cleanText, toolCalls] = parseToolCalls(text);
            const message = {
                role: 'assistant',
                content: cleanText || null,
                ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
            };
            const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
            return {
                id: chatCompletionId,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{ index: 0, message, finish_reason: finishReason }],
                usage: {
                    prompt_tokens: Math.floor(prompt.length / 4),
                    completion_tokens: Math.floor((cleanText || '').length / 4),
                    total_tokens: Math.floor((prompt.length + (cleanText || '').length) / 4),
                },
            };
        } catch (e) {
            lastError = e;
            log(`非流式请求失败 (尝试 ${attempt + 1}/${CONFIG.RETRY_ATTEMPTS}):`, e.message);
            if (attempt < CONFIG.RETRY_ATTEMPTS - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY_MS));
            }
        }
    }
    throw lastError || new Error('非流式请求失败');
}

// ==================== 第四部分: HTTP 请求处理器 (主路由) ====================
/**
 * 处理 /v1/chat/completions 端点 (OpenAI 兼容)。
 * @param {Request} request - 原始请求对象。
 * @returns {Promise<Response>} 响应对象。
 */
async function handleChatCompletions(request) {
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    let response;
    try {
        const requestBody = await request.json();
        const modelName = requestBody.model || CONFIG.DEFAULT_MODEL;
        const stream = requestBody.stream === true;
        const [resolvedModelName, modelId, thinkMode, resolveError] = resolveModel(modelName);
        if (resolveError) {
            return new Response(JSON.stringify({ error: { message: resolveError, type: 'invalid_request_error' } }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': requestId,
                    'X-Worker-Trace-ID': requestId,
                },
            });
        }
        const tools = requestBody.tools;
        const prompt = messagesToPrompt(requestBody.messages || [], tools);
        if (!prompt.trim()) {
            return new Response(JSON.stringify({ error: { message: '提示词不能为空', type: 'invalid_request_error' } }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Request-ID': requestId,
                    'X-Worker-Trace-ID': requestId,
                },
            });
        }
        const chatCompletionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
        const isToolCall = tools && tools.length > 0;
        if (stream && !isToolCall) {
            // 真正的流式处理
            response = await handleStreamingRequest(request, prompt, modelId, thinkMode, chatCompletionId, resolvedModelName, false);
        } else {
            // 非流式 或 需要工具调用（工具调用不支持逐字流）
            const result = await handleNonStreamingRequest(prompt, modelId, thinkMode, chatCompletionId, resolvedModelName, tools);
            if (stream) {
                // 工具调用的“伪”流式：一次性发送整个消息
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();
                const chunk = {
                    id: chatCompletionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: resolvedModelName,
                    choices: [{ index: 0, delta: result.choices[0].message, finish_reason: result.choices[0].finish_reason }],
                };
                writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                writer.write(encoder.encode('data: [DONE]\n\n'));
                writer.close();
                response = new Response(readable, {
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'X-Request-ID': requestId,
                        'X-Worker-Trace-ID': requestId,
                    },
                });
            } else {
                response = new Response(JSON.stringify(result, null, 2), {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Request-ID': requestId,
                        'X-Worker-Trace-ID': requestId,
                    },
                });
            }
        }
    } catch (error) {
        log(`处理 /v1/chat/completions 时出错:`, error);
        response = new Response(JSON.stringify({
            error: {
                message: `内部服务器错误: ${error.message}`,
                type: 'internal_server_error',
            },
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'X-Request-ID': requestId,
                'X-Worker-Trace-ID': requestId,
            },
        });
    }
    const endTime = Date.now();
    log(`请求 ${requestId} 完成，耗时 ${endTime - startTime}ms，状态: ${response.status}`);
    return response;
}

/**
 * 处理 /v1/models 端点 (返回可用模型列表)。
 * 此响应将被缓存以提高性能。
 * @param {Request} request - 原始请求对象。
 * @returns {Promise<Response>} 响应对象。
 */
async function handleModels(request) {
    const cacheKey = new Request(request.url, request);
    const cache = caches.default;
    if (CONFIG.ENABLE_CACHE) {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
            log(`缓存命中: ${request.url}`);
            return cachedResponse;
        }
    }
    const models = Object.entries(CONFIG.MODELS).map(([id, cfg]) => ({
        id: id,
        object: 'model',
        created: 1700000000, // 固定值
        owned_by: 'google',
        description: cfg.desc,
    }));
    const response = new Response(JSON.stringify({
        object: 'list',
        data: models,
    }, null, 2), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${CONFIG.CACHE_TTL}`,
            'X-Request-ID': crypto.randomUUID(),
        },
    });
    if (CONFIG.ENABLE_CACHE) {
        // 使用 waitUntil 确保响应被正确缓存，同时不阻塞主响应
        const responseToCache = response.clone();
        responseToCache.headers.set('CF-Cache-Status', 'MISS');
        // 注意：在真实 Worker 中，我们需要 event.waitUntil 来延长生命周期。这里在 fetch 事件中处理。
        // 此函数将在 fetch 事件处理器中被调用，届时会使用 event.waitUntil
        // 这里我们只返回响应，缓存逻辑在 fetch 事件处理器中完成。
    }
    return response;
}

/**
 * 处理 /v1/responses 端点 (OpenAI Responses API)。
 * 逻辑与 /v1/chat/completions 类似，但格式不同。
 * 为简洁起见，此处省略详细实现，但结构与 handleChatCompletions 类似。
 * 您可以根据原始 Python 代码中的 `handle_responses` 方法实现。
 */
async function handleResponses(request) {
    const requestId = crypto.randomUUID();
    // TODO: 根据原始 Python 代码实现完整的 Responses API 逻辑
    // 这包括处理复杂的 input 数组、工具调用和流式响应。
    // 由于时间关系，此处返回一个“未实现”的响应，但您可以根据需要进行扩展。
    return new Response(JSON.stringify({
        error: {
            message: '/v1/responses 端点在此 Worker 版本中尚未实现。请使用 /v1/chat/completions。',
            type: 'unimplemented_endpoint',
        },
    }), {
        status: 501, // Not Implemented
        headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            'X-Worker-Trace-ID': requestId,
        },
    });
}

/**
 * 处理 Google AI 格式的 /v1beta/models 和 /v1beta/models/{model}:generateContent 端点。
 * 为简洁起见，此处省略详细实现。
 */
async function handleGoogleAI(request) {
    const requestId = crypto.randomUUID();
    // TODO: 根据原始 Python 代码中的 `_handle_google_models_list` 和 `_handle_google_generate` 实现。
    return new Response(JSON.stringify({
        error: {
            message: 'Google AI 原生 API 端点在此 Worker 版本中尚未实现。',
            type: 'unimplemented_endpoint',
        },
    }), {
        status: 501,
        headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            'X-Worker-Trace-ID': requestId,
        },
    });
}

/**
 * 主路由函数。根据请求路径分发到不同的处理器。
 * @param {Request} request - 传入的请求对象。
 * @returns {Promise<Response>} 响应对象。
 */
async function router(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const requestId = crypto.randomUUID();

    // --- 设置 CORS 和追踪头 ---
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE, PATCH',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
        'X-Request-ID': requestId,
        'X-Worker-Trace-ID': requestId,
    };
    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    // --- API 密钥认证 ---
    if (CONFIG.AUTH_ENABLED && path.startsWith('/v1/')) {
        const authHeader = request.headers.get('Authorization');
        const apiKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;
        if (apiKey !== CONFIG.API_MASTER_KEY) {
            return new Response(JSON.stringify({
                error: {
                    message: '无效的 API 密钥。请在请求头中提供有效的 `Authorization: Bearer <your-api-key>`。',
                    type: 'invalid_request_error',
                },
            }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    }

    // --- 路由分发 ---
    try {
        if (path === '/' && method === 'GET') {
            // 返回开发者驾驶舱 HTML 页面 (将在第二次输出中提供完整实现)
            return serveDashboard();
        } else if (path === '/v1/models' && method === 'GET') {
            const response = await handleModels(request);
            // 添加 CORS 和缓存头
            for (const [k, v] of Object.entries(corsHeaders)) {
                response.headers.set(k, v);
            }
            return response;
        } else if (path === '/v1/chat/completions' && method === 'POST') {
            const response = await handleChatCompletions(request);
            for (const [k, v] of Object.entries(corsHeaders)) {
                response.headers.set(k, v);
            }
            return response;
        } else if (path === '/v1/responses' && method === 'POST') {
            const response = await handleResponses(request);
            for (const [k, v] of Object.entries(corsHeaders)) {
                response.headers.set(k, v);
            }
            return response;
        } else if (path.startsWith('/v1beta/')) {
            const response = await handleGoogleAI(request);
            for (const [k, v] of Object.entries(corsHeaders)) {
                response.headers.set(k, v);
            }
            return response;
        } else if (path.startsWith('/v1/')) {
            // 其他 /v1/ 路径返回 404
            return new Response(JSON.stringify({
                error: {
                    message: `未找到端点: ${path}`,
                    type: 'invalid_request_error',
                },
            }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        } else {
            // 根路径以外的其他路径返回 404
            return new Response(JSON.stringify({
                error: {
                    message: `未找到路径: ${path}`,
                    type: 'invalid_request_error',
                },
            }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        log(`路由处理过程中发生未捕获的错误:`, error);
        return new Response(JSON.stringify({
            error: {
                message: `内部服务器错误: ${error.message}`,
                type: 'internal_server_error',
            },
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}

// ==================== 第五部分: Cloudflare Worker 入口点 ====================
/**
 * Cloudflare Worker 的 fetch 事件处理器。
 * 这是 Worker 的入口函数。
 */
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
    const request = event.request;
    const url = new URL(request.url);

    // --- 处理根路径的 HTML 驾驶舱 ---
    if (url.pathname === '/' && request.method === 'GET') {
        // 可在此处对 HTML 应用 Brotli 压缩
        const response = serveDashboard();
        // 为文本响应启用 Brotli 压缩（Cloudflare 会自动处理 Accept-Encoding）
        return response;
    }

    // --- 处理 API 请求 ---
    const response = await router(request);

    // --- 对所有 JSON 响应应用 Brotli 压缩（如果客户端支持）---
    const acceptEncoding = request.headers.get('Accept-Encoding') || '';
    const contentType = response.headers.get('Content-Type') || '';
    if (acceptEncoding.includes('br') && (contentType.includes('application/json') || contentType.includes('text/html'))) {
        // Cloudflare 会自动为我们处理压缩，我们只需要确保设置了正确的 Content-Encoding 头。
        // 实际上，在返回 Response 对象后，我们无法修改其主体。压缩应在生成响应体时处理。
        // 更常见的做法是依赖 Cloudflare 的自动压缩功能，它在网络边缘自动进行。
        // 我们只需确保不设置 `Content-Encoding: br` 头，除非我们手动压缩。
        // 对于 Worker 返回的响应，Cloudflare 会自动压缩（如果配置了）。
        // 因此，我们这里不进行额外操作。
    }

    return response;
}

// ==================== 第六部分: 开发者驾驶舱 (Developer Cockpit) ====================
/**
 * 提供完整的、全中文的、交互式的开发者驾驶舱 HTML 页面。
 * 此页面集成了实时日志、交互式终端、客户端集成指南、接口文档和调试工具。
 * 使用自定义元素、Shadow DOM、Tailwind CSS 和纯 JavaScript 状态机构建。
 * @returns {Response} 包含完整驾驶舱页面的 HTML 响应。
 */
function serveDashboard() {
    const html = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <!-- 内联 Tailwind CSS (精简版) -->
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        amber: { highlight: '#FFBF00' },
                    }
                }
            },
            corePlugins: { preflight: false } // 防止与自定义元素样式冲突
        }
    </script>
    <style>
        * { box-sizing: border-box; }
        :root { --color-bg: #121212; --color-text: #E0E0E0; --color-muted: #888888; --color-highlight: #FFBF00; }
        body { margin: 0; background: var(--color-bg); color: var(--color-text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; min-height: 100vh; }
        /* 骨架屏动画 */
        @keyframes shimmer { 0% { background-position: -200px 0; } 100% { background-position: calc(200px + 100%) 0; } }
        .skeleton { background: linear-gradient(90deg, #2a2a2a 25%, #333 50%, #2a2a2a 75%); background-size: 200px 100%; animation: shimmer 1.5s infinite; }
        /* 自定义滚动条 */
        .custom-scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #1e1e1e; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #444; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #555; }
        /* Markdown 内容样式 */
        .markdown-body { font-size: 14px; line-height: 1.6; }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 { border-bottom: 1px solid #444; padding-bottom: 0.3em; margin-top: 1em; }
        .markdown-body code { background-color: rgba(110, 118, 129, 0.4); padding: 0.2em 0.4em; border-radius: 3px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
        .markdown-body pre { background-color: #1e1e1e; padding: 1em; border-radius: 6px; overflow: auto; }
        .markdown-body pre code { background: transparent; padding: 0; }
        .markdown-body blockquote { border-left: 3px solid var(--color-highlight); padding-left: 1em; color: var(--color-muted); margin-left: 0; }
        .markdown-body table { border-collapse: collapse; width: 100%; }
        .markdown-body th, .markdown-body td { border: 1px solid #444; padding: 6px 10px; text-align: left; }
        .markdown-body th { background-color: #2a2a2a; }
    </style>
    <!-- Marked.js for Markdown rendering -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <!-- Highlight.js for syntax highlighting -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
</head>
<body class="bg-[#121212] text-[#E0E0E0]">
    <!-- 主应用容器 -->
    <div id="app" class="flex flex-col min-h-screen">
        <!-- 顶部标题栏 -->
        <header class="sticky top-0 z-50 bg-[#1a1a1a] border-b border-gray-800 px-6 py-3 flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <svg class="w-6 h-6 text-amber-highlight" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clip-rule="evenodd"/></svg>
                <div>
                    <h1 class="text-xl font-bold">${CONFIG.PROJECT_NAME}</h1>
                    <p class="text-sm text-gray-400">v${CONFIG.PROJECT_VERSION} | 您的 OpenAI 兼容 Gemini 网关</p>
                </div>
            </div>
            <div class="flex items-center space-x-4">
                <!-- 健康状态组件 -->
                <health-status></health-status>
                <button id="btn-refresh-status" title="刷新状态" class="p-2 rounded hover:bg-gray-800">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                </button>
            </div>
        </header>

        <!-- 主体内容 (桌面双栏/移动单栏) -->
        <main class="flex-1 flex flex-col lg:flex-row p-4 lg:p-6 gap-6">
            <!-- 左栏: 即用情报 -->
            <section class="lg:w-1/3 flex flex-col space-y-6">
                <div class="bg-gray-900 rounded-xl border border-gray-800 p-5 shadow-lg">
                    <h2 class="text-lg font-semibold mb-4 flex items-center">
                        <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>
                        📋 即用情报
                    </h2>
                    <actionable-intelligence></actionable-intelligence>
                </div>

                <!-- 附加情报区 (可折叠) -->
                <div class="space-y-4">
                    <details class="group bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                        <summary class="list-none cursor-pointer p-5 font-semibold flex justify-between items-center hover:bg-gray-800">
                            <span class="flex items-center">
                                <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg>
                                ⚙️ 主流客户端集成指南
                            </span>
                            <svg class="w-5 h-5 transform group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                        </summary>
                        <div class="px-5 pb-5">
                            <client-guides></client-guides>
                        </div>
                    </details>

                    <details class="group bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                        <summary class="list-none cursor-pointer p-5 font-semibold flex justify-between items-center hover:bg-gray-800">
                            <span class="flex items-center">
                                <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/></svg>
                                🔌 兼容接口参考
                            </span>
                            <svg class="w-5 h-5 transform group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                        </summary>
                        <div class="px-5 pb-5 overflow-x-auto">
                            <api-reference></api-reference>
                        </div>
                    </details>

                    <details class="group bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                        <summary class="list-none cursor-pointer p-5 font-semibold flex justify-between items-center hover:bg-gray-800">
                            <span class="flex items-center">
                                <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/></svg>
                                🛠️ 调试与复现工具箱
                            </span>
                            <svg class="w-5 h-5 transform group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                        </summary>
                        <div class="px-5 pb-5">
                            <debug-toolbox></debug-toolbox>
                        </div>
                    </details>
                </div>
            </section>

            <!-- 右栏: 实时交互终端 -->
            <section class="lg:w-2/3 flex flex-col">
                <div class="bg-gray-900 rounded-xl border border-gray-800 p-5 shadow-lg flex-1 flex flex-col">
                    <h2 class="text-lg font-semibold mb-4 flex items-center">
                        <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clip-rule="evenodd"/></svg>
                        🚀 实时交互终端
                    </h2>
                    <live-terminal></live-terminal>
                </div>
            </section>
        </main>

        <!-- 全局状态栏 -->
        <footer class="bg-[#1a1a1a] border-t border-gray-800 px-4 py-2 text-sm text-gray-500 flex justify-between items-center">
            <div id="global-status">
                <span class="status-indicator" data-state="INITIALIZING">🔄 初始化...</span>
            </div>
            <div>
                <span id="request-count">请求: 0</span> |
                <span id="avg-latency">平均耗时: -</span> |
                <span id="success-rate">成功率: -</span>
            </div>
        </footer>
    </div>

    <!-- 自定义元素定义和内联脚本 -->
    <script>
        // ==================== 全局状态与工具 ====================
        const STATE = {
            INITIALIZING: 'INITIALIZING',
            HEALTH_CHECKING: 'HEALTH_CHECKING',
            READY: 'READY',
            REQUESTING: 'REQUESTING',
            STREAMING: 'STREAMING',
            ERROR: 'ERROR'
        };
        let appState = STATE.INITIALIZING;
        const requestLog = []; // 存储请求历史 {id, status, ttfb, totalTime, speed, model, path}
        const MAX_LOG_ENTRIES = 50;

        // 状态管理器
        const stateManager = {
            setState(newState) {
                if (appState === newState) return;
                console.log(`状态变更: ${appState} -> ${newState}`);
                appState = newState;
                this.updateUI();
                this.dispatchEvent(new CustomEvent('statechange', { detail: newState }));
            },
            updateUI() {
                const indicator = document.querySelector('.status-indicator');
                if (!indicator) return;
                indicator.textContent = this.getStatusText();
                indicator.dataset.state = appState;
                // 根据状态更新按钮等全局元素
                document.querySelectorAll('[data-state-dependent]').forEach(el => {
                    const allowedStates = el.dataset.stateDependent.split(',');
                    el.disabled = !allowedStates.includes(appState);
                });
            },
            getStatusText() {
                const texts = {
                    [STATE.INITIALIZING]: '🔄 初始化...',
                    [STATE.HEALTH_CHECKING]: '🔍 检查上游健康...',
                    [STATE.READY]: '✅ 就绪',
                    [STATE.REQUESTING]: '⏳ 请求中...',
                    [STATE.STREAMING]: '🌊 流式传输中...',
                    [STATE.ERROR]: '❌ 错误'
                };
                return texts[appState] || appState;
            }
        };

        // 工具函数
        const utils = {
            copyToClipboard(text) {
                navigator.clipboard.writeText(text).then(() => {
                    this.showToast('已复制到剪贴板');
                }).catch(err => {
                    console.error('复制失败:', err);
                    this.showToast('复制失败，请手动复制', 'error');
                });
            },
            showToast(message, type = 'info') {
                // 简单的 toast 实现
                const toast = document.createElement('div');
                toast.className = `fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg ${
                    type === 'error' ? 'bg-red-800' : 'bg-gray-800'
                } text-white z-50`;
                toast.textContent = message;
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 3000);
            },
            formatDuration(ms) {
                if (ms < 1000) return ms.toFixed(0) + 'ms';
                return (ms / 1000).toFixed(2) + 's';
            },
            formatSpeed(chars, ms) {
                if (ms === 0) return '0 char/s';
                return ((chars / ms) * 1000).toFixed(1) + ' char/s';
            }
        };

        // ==================== 自定义元素: 健康状态 ====================
        class HealthStatus extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
                this.health = 'unknown';
                this.lastCheck = null;
            }
            connectedCallback() {
                this.render();
                this.checkHealth();
                document.getElementById('btn-refresh-status')?.addEventListener('click', () => this.checkHealth());
                // 每30秒自动检查一次
                setInterval(() => this.checkHealth(), 30000);
            }
            render() {
                const colors = {
                    healthy: 'text-green-500',
                    degraded: 'text-yellow-500',
                    unhealthy: 'text-red-500',
                    unknown: 'text-gray-500'
                };
                const icons = {
                    healthy: '🟢',
                    degraded: '🟡',
                    unhealthy: '🔴',
                    unknown: '⚪'
                };
                const texts = {
                    healthy: '上游服务健康',
                    degraded: '上游服务不稳定',
                    unhealthy: '上游服务异常',
                    unknown: '状态未知'
                };
                this.shadowRoot.innerHTML = \`
                    <style>
                        :host { display: inline-flex; align-items: center; }
                        .health-dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
                        .healthy { background-color: #10B981; }
                        .degraded { background-color: #F59E0B; }
                        .unhealthy { background-color: #EF4444; }
                        .unknown { background-color: #6B7280; }
                        span { font-size: 0.875rem; }
                    </style>
                    <div class="flex items-center">
                        <div class="health-dot \${this.health}"></div>
                        <span>\${texts[this.health]}</span>
                        <span class="text-gray-500 text-xs ml-2">\${this.lastCheck ? '最近检查: ' + new Date(this.lastCheck).toLocaleTimeString() : ''}</span>
                    </div>
                \`;
            }
            async checkHealth() {
                this.health = 'unknown';
                this.render();
                try {
                    const start = Date.now();
                    const resp = await fetch('/v1/models', { method: 'HEAD' });
                    const latency = Date.now() - start;
                    this.lastCheck = Date.now();
                    this.health = resp.ok ? (latency < 1000 ? 'healthy' : 'degraded') : 'unhealthy';
                } catch (e) {
                    this.health = 'unhealthy';
                } finally {
                    this.render();
                }
            }
        }
        customElements.define('health-status', HealthStatus);

        // ==================== 自定义元素: 即用情报 ====================
        class ActionableIntelligence extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
                this.apiKeyVisible = false;
            }
            connectedCallback() {
                this.render();
            }
            render() {
                const apiBaseUrl = window.location.origin + '/v1';
                const apiKey = '${CONFIG.API_MASTER_KEY}';
                this.shadowRoot.innerHTML = \`
                    <style>
                        .info-item { margin-bottom: 1rem; }
                        .label { font-size: 0.875rem; color: #888; margin-bottom: 0.25rem; }
                        .value-container { display: flex; align-items: center; background: #1e1e1e; border-radius: 6px; padding: 0.75rem; }
                        .value { flex: 1; font-family: 'SF Mono', monospace; word-break: break-all; }
                        .value.masked { filter: blur(4px); transition: filter 0.2s; }
                        .btn-icon { background: none; border: none; color: #888; cursor: pointer; padding: 0.25rem; margin-left: 0.5rem; border-radius: 4px; }
                        .btn-icon:hover { background: #333; color: #FFBF00; }
                        .model-select { width: 100%; padding: 0.5rem; background: #1e1e1e; border: 1px solid #444; border-radius: 6px; color: white; }
                    </style>
                    <div>
                        <div class="info-item">
                            <div class="label">API 地址 (Base URL)</div>
                            <div class="value-container">
                                <code class="value" id="api-base-url">\${apiBaseUrl}</code>
                                <button class="btn-icon" title="复制" onclick="utils.copyToClipboard('\${apiBaseUrl}')">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="info-item">
                            <div class="label">API 密钥</div>
                            <div class="value-container">
                                <code class="value \${this.apiKeyVisible ? '' : 'masked'}" id="api-key">\${apiKey}</code>
                                <button class="btn-icon" title="\${this.apiKeyVisible ? '隐藏' : '显示'}" onclick="this.getRootNode().host.toggleApiKey()">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="\${this.apiKeyVisible ? 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21' : 'M15 12a3 3 0 11-6 0 3 3 0 016 0z'}"/>
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="\${this.apiKeyVisible ? '' : 'M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'}"/>
                                    </svg>
                                </button>
                                <button class="btn-icon" title="复制" onclick="utils.copyToCliptext('\${apiKey}')">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="info-item">
                            <div class="label">默认模型</div>
                            <select class="model-select" id="default-model-select">
                                ${Object.keys(CONFIG.MODELS).map(name => \`
                                    <option value="\${name}" \${name === '${CONFIG.DEFAULT_MODEL}' ? 'selected' : ''}>\${name}</option>
                                \`).join('')}
                            </select>
                            <div class="text-xs text-gray-500 mt-1" id="model-desc">${CONFIG.MODELS[CONFIG.DEFAULT_MODEL]?.desc || ''}</div>
                        </div>
                        <div class="text-xs text-gray-500 mt-4">
                            <p>💡 将上述信息填入您的客户端（如 Cherry Studio、ChatBox、LobeChat 等）的 OpenAI 兼容配置中即可使用。</p>
                        </div>
                    </div>
                \`;
                // 更新模型描述
                this.shadowRoot.getElementById('default-model-select').addEventListener('change', (e) => {
                    const model = e.target.value;
                    const desc = ${JSON.stringify(CONFIG.MODELS)}[model]?.desc || '';
                    this.shadowRoot.getElementById('model-desc').textContent = desc;
                });
            }
            toggleApiKey() {
                this.apiKeyVisible = !this.apiKeyVisible;
                this.render();
            }
        }
        customElements.define('actionable-intelligence', ActionableIntelligence);

        // ==================== 自定义元素: 实时交互终端 ====================
        class LiveTerminal extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
                this.streamController = null;
                this.accumulatedResponse = '';
            }
            connectedCallback() {
                this.render();
                this.setupEventListeners();
                // 初始状态
                stateManager.setState(STATE.HEALTH_CHECKING);
                setTimeout(() => stateManager.setState(STATE.READY), 500);
            }
            render() {
                this.shadowRoot.innerHTML = \`
                    <style>
                        .terminal-container { display: flex; flex-direction: column; height: 100%; }
                        .output-panel { flex: 1; background: #1a1a1a; border-radius: 8px; padding: 1rem; overflow: auto; margin-bottom: 1rem; min-height: 300px; }
                        .output-content { font-family: 'SF Mono', monospace; white-space: pre-wrap; }
                        .input-area { position: relative; }
                        textarea { width: 100%; min-height: 100px; max-height: 300px; background: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 1rem; padding-right: 120px; color: white; resize: vertical; font-family: inherit; }
                        textarea:focus { outline: none; border-color: #FFBF00; }
                        .input-actions { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 8px; }
                        button { padding: 0.5rem 1rem; border-radius: 6px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
                        .btn-send { background: #FFBF00; color: black; border: none; }
                        .btn-send:hover:not(:disabled) { background: #e6ac00; }
                        .btn-send:disabled { opacity: 0.5; cursor: not-allowed; }
                        .btn-cancel { background: #EF4444; color: white; border: none; }
                        .btn-cancel:hover { background: #DC2626; }
                        .skeleton-line { height: 1.2em; margin-bottom: 0.5em; background: #2a2a2a; border-radius: 4px; }
                        .log-table { width: 100%; font-size: 0.75rem; border-collapse: collapse; }
                        .log-table th, .log-table td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #333; }
                        .log-table th { background: #2a2a2a; color: #888; }
                        .status-badge { padding: 0.2rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; }
                        .status-2xx { background: #065F46; color: #6EE7B7; }
                        .status-4xx { background: #92400E; color: #FBBF24; }
                        .status-5xx { background: #991B1B; color: #FCA5A5; }
                        .tab-button { padding: 0.5rem 1rem; background: transparent; border: none; color: #888; cursor: pointer; border-bottom: 2px solid transparent; }
                        .tab-button.active { color: #FFBF00; border-bottom-color: #FFBF00; }
                    </style>
                    <div class="terminal-container">
                        <!-- 标签页切换 -->
                        <div class="flex border-b border-gray-800 mb-4">
                            <button class="tab-button active" data-tab="output">AI 输出</button>
                            <button class="tab-button" data-tab="logs">请求日志与性能洞察</button>
                        </div>
                        <!-- AI 输出面板 -->
                        <div class="tab-panel active" data-tab="output">
                            <div class="output-panel custom-scrollbar">
                                <div class="output-content markdown-body" id="output-content">
                                    <!-- 骨架屏 -->
                                    <div class="skeleton-line" style="width: 90%"></div>
                                    <div class="skeleton-line" style="width: 80%"></div>
                                    <div class="skeleton-line" style="width: 95%"></div>
                                </div>
                            </div>
                        </div>
                        <!-- 请求日志面板 -->
                        <div class="tab-panel" data-tab="logs" style="display: none;">
                            <div class="output-panel custom-scrollbar">
                                <div class="flex justify-between items-center mb-3">
                                    <h4 class="font-semibold">最近请求</h4>
                                    <div class="text-sm">
                                        <span id="success-rate-badge">成功率: 计算中...</span> |
                                        <span id="avg-latency-badge">平均耗时: -</span>
                                        <button class="text-xs ml-2 text-gray-400 hover:text-white" id="clear-logs">清空</button>
                                    </div>
                                </div>
                                <table class="log-table">
                                    <thead>
                                        <tr>
                                            <th>请求ID</th><th>状态</th><th>TTFB</th><th>总耗时</th><th>速率</th><th>模型</th><th>路径</th>
                                        </tr>
                                    </thead>
                                    <tbody id="log-table-body">
                                        <tr><td colspan="7" class="text-center text-gray-500 py-4">暂无请求记录</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <!-- 输入区域 -->
                        <div class="input-area">
                            <textarea placeholder="输入您的问题... (Shift+Enter 换行, Enter 发送)" id="user-input"></textarea>
                            <div class="input-actions">
                                <select class="bg-gray-800 text-white rounded px-2 py-1" id="model-select">
                                    ${Object.keys(CONFIG.MODELS).map(name => \`
                                        <option value="\${name}">\${name}</option>
                                    \`).join('')}
                                </select>
                                <button class="btn-cancel" id="btn-cancel" style="display: none;">取消</button>
                                <button class="btn-send" id="btn-send">发送</button>
                            </div>
                        </div>
                    </div>
                \`;
            }
            setupEventListeners() {
                const shadow = this.shadowRoot;
                const textarea = shadow.getElementById('user-input');
                const btnSend = shadow.getElementById('btn-send');
                const btnCancel = shadow.getElementById('btn-cancel');
                const modelSelect = shadow.getElementById('model-select');
                const outputContent = shadow.getElementById('output-content');
                const logTableBody = shadow.getElementById('log-table-body');
                const clearLogsBtn = shadow.getElementById('clear-logs');
                const tabButtons = shadow.querySelectorAll('.tab-button');

                // 自动调整文本域高度
                textarea.addEventListener('input', function() {
                    this.style.height = 'auto';
                    this.style.height = (this.scrollHeight) + 'px';
                });

                // 发送消息
                btnSend.addEventListener('click', () => this.sendMessage());
                textarea.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this.sendMessage();
                    }
                });

                // 取消请求
                btnCancel.addEventListener('click', () => {
                    if (this.streamController) {
                        this.streamController.abort();
                        this.streamController = null;
                        outputContent.innerHTML += '\\n\\n**❌ 请求已被用户取消。**';
                        stateManager.setState(STATE.READY);
                    }
                });

                // 清空日志
                clearLogsBtn?.addEventListener('click', () => {
                    requestLog.length = 0;
                    this.updateLogTable();
                });

                // 标签页切换
                tabButtons.forEach(btn => {
                    btn.addEventListener('click', () => {
                        const tab = btn.dataset.tab;
                        tabButtons.forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        shadow.querySelectorAll('.tab-panel').forEach(panel => {
                            panel.style.display = panel.dataset.tab === tab ? 'block' : 'none';
                        });
                    });
                });

                // 监听状态变化
                document.addEventListener('statechange', (e) => {
                    const state = e.detail;
                    btnSend.disabled = !(state === STATE.READY);
                    btnCancel.style.display = (state === STATE.REQUESTING || state === STATE.STREAMING) ? 'block' : 'none';
                    textarea.disabled = (state === STATE.REQUESTING || state === STATE.STREAMING);
                    if (state === STATE.READY && this.accumulatedResponse) {
                        // 请求完成，渲染完整的 Markdown
                        outputContent.innerHTML = marked.parse(this.accumulatedResponse);
                        hljs.highlightAll();
                        this.accumulatedResponse = '';
                    }
                });
            }
            async sendMessage() {
                const shadow = this.shadowRoot;
                const textarea = shadow.getElementById('user-input');
                const modelSelect = shadow.getElementById('model-select');
                const outputContent = shadow.getElementById('output-content');
                const prompt = textarea.value.trim();
                if (!prompt) return;
                const model = modelSelect.value;
                // 准备输出区域
                outputContent.innerHTML = \`<div class="text-gray-400">> \${prompt.substring(0, 100)}\${prompt.length > 100 ? '...' : ''}</div><hr class="my-4 border-gray-800">\`;
                this.accumulatedResponse = '';
                stateManager.setState(STATE.REQUESTING);
                const requestId = crypto.randomUUID().slice(0, 8);
                const startTime = Date.now();
                let ttfb = null;
                try {
                    const response = await fetch('/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ${CONFIG.API_MASTER_KEY}'
                        },
                        body: JSON.stringify({
                            model: model,
                            messages: [{ role: 'user', content: prompt }],
                            stream: true
                        })
                    });
                    ttfb = Date.now() - startTime;
                    if (!response.ok) {
                        throw new Error(\`HTTP \${response.status}: \${await response.text()}\`);
                    }
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    stateManager.setState(STATE.STREAMING);
                    this.streamController = new AbortController();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
                        for (const line of lines) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                const delta = data.choices[0]?.delta?.content;
                                if (delta) {
                                    this.accumulatedResponse += delta;
                                    // 流式更新（为了性能，每积累一定字符或每100ms更新一次）
                                    if (this.accumulatedResponse.length % 50 === 0 || delta.includes('\\n')) {
                                        outputContent.innerHTML = \`<div class="text-gray-400">> \${prompt.substring(0, 100)}\${prompt.length > 100 ? '...' : ''}</div><hr class="my-4 border-gray-800">\` + marked.parse(this.accumulatedResponse);
                                        hljs.highlightAll();
                                    }
                                }
                            } catch (e) { /* 忽略解析错误 */ }
                        }
                    }
                    // 流结束
                    outputContent.innerHTML = \`<div class="text-gray-400">> \${prompt.substring(0, 100)}\${prompt.length > 100 ? '...' : ''}</div><hr class="my-4 border-gray-800">\` + marked.parse(this.accumulatedResponse);
                    hljs.highlightAll();
                    const totalTime = Date.now() - startTime;
                    const speed = utils.formatSpeed(this.accumulatedResponse.length, totalTime);
                    // 记录到日志
                    requestLog.unshift({
                        id: requestId,
                        status: response.status,
                        ttfb: ttfb,
                        totalTime: totalTime,
                        speed: speed,
                        model: model,
                        path: '/v1/chat/completions'
                    });
                    if (requestLog.length > MAX_LOG_ENTRIES) requestLog.pop();
                    this.updateLogTable();
                    this.updateGlobalMetrics();
                    stateManager.setState(STATE.READY);
                } catch (error) {
                    console.error('请求失败:', error);
                    outputContent.innerHTML += \`\\n\\n**❌ 请求失败:** \${error.message}\`;
                    // 记录失败请求
                    const totalTime = Date.now() - startTime;
                    requestLog.unshift({
                        id: requestId,
                        status: 0,
                        ttfb: ttfb || 'N/A',
                        totalTime: totalTime,
                        speed: '0 char/s',
                        model: model,
                        path: '/v1/chat/completions',
                        error: error.message
                    });
                    if (requestLog.length > MAX_LOG_ENTRIES) requestLog.pop();
                    this.updateLogTable();
                    this.updateGlobalMetrics();
                    stateManager.setState(STATE.ERROR);
                    setTimeout(() => stateManager.setState(STATE.READY), 2000);
                } finally {
                    textarea.value = '';
                    textarea.style.height = 'auto';
                    this.streamController = null;
                }
            }
            updateLogTable() {
                const shadow = this.shadowRoot;
                const tbody = shadow.getElementById('log-table-body');
                if (requestLog.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-gray-500 py-4">暂无请求记录</td></tr>';
                    return;
                }
                tbody.innerHTML = requestLog.map(log => \`
                    <tr class="hover:bg-gray-800">
                        <td class="font-mono text-xs" title="\${log.id}">\${log.id}</td>
                        <td><span class="status-badge \${log.status >= 200 && log.status < 300 ? 'status-2xx' : log.status >= 400 && log.status < 500 ? 'status-4xx' : 'status-5xx'}">\${log.status || 'ERR'}</span></td>
                        <td>\${typeof log.ttfb === 'number' ? log.ttfb + 'ms' : log.ttfb}</td>
                        <td>\${utils.formatDuration(log.totalTime)}</td>
                        <td>\${log.speed}</td>
                        <td class="font-mono text-xs">\${log.model}</td>
                        <td class="font-mono text-xs">\${log.path}</td>
                    </tr>
                \`).join('');
            }
            updateGlobalMetrics() {
                const recent = requestLog.slice(0, 10).filter(r => r.status);
                if (recent.length === 0) return;
                const successCount = recent.filter(r => r.status >= 200 && r.status < 300).length;
                const avgLatency = recent.reduce((sum, r) => sum + r.totalTime, 0) / recent.length;
                document.getElementById('success-rate').textContent = \`成功率: \${((successCount / recent.length) * 100).toFixed(0)}%\`;
                document.getElementById('avg-latency').textContent = \`平均耗时: \${utils.formatDuration(avgLatency)}\`;
                document.getElementById('request-count').textContent = \`请求: \${requestLog.length}\`;
                // 更新日志面板中的 badge
                const shadow = this.shadowRoot;
                const successBadge = shadow.getElementById('success-rate-badge');
                const latencyBadge = shadow.getElementById('avg-latency-badge');
                if (successBadge) successBadge.textContent = \`成功率: \${((successCount / recent.length) * 100).toFixed(0)}%\`;
                if (latencyBadge) latencyBadge.textContent = \`平均耗时: \${utils.formatDuration(avgLatency)}\`;
            }
        }
        customElements.define('live-terminal', LiveTerminal);

        // ==================== 自定义元素: 客户端集成指南 ====================
        class ClientGuides extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
                this.activeTab = 'chatgpt-next-web';
            }
            connectedCallback() {
                this.render();
            }
            render() {
                const apiBaseUrl = window.location.origin + '/v1';
                const apiKey = '${CONFIG.API_MASTER_KEY}';
                const tabs = [
                    { id: 'chatgpt-next-web', name: 'ChatGPT-Next-Web', icon: '🤖' },
                    { id: 'lobechat', name: 'LobeChat', icon: '🦄' },
                    { id: 'curl', name: 'cURL', icon: '🖥️' },
                    { id: 'python', name: 'Python', icon: '🐍' },
                ];
                const configs = {
                    'chatgpt-next-web': \`
# 环境变量配置 (.env.local)
BASE_URL=\${apiBaseUrl}
OPENAI_API_KEY=\${apiKey}
OPENAI_ORG_ID=
# 模型列表: \${Object.keys(CONFIG.MODELS).join(', ')}
# 默认模型: \${CONFIG.DEFAULT_MODEL}
                    \`,
                    'lobechat': \`
1. 打开 LobeChat 设置 -> 语言模型
2. 提供商选择 "OpenAI"
3. 配置如下：
   - 接口地址: \${apiBaseUrl}
   - API 密钥: \${apiKey}
   - 模型: 从下拉列表中选择，支持 \${Object.keys(CONFIG.MODELS).join(', ')}
4. 保存并使用
                    \`,
                    'curl': \`
# 基础聊天请求
curl -X POST '\${apiBaseUrl}/chat/completions' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer \${apiKey}' \\
  -d '{
    "model": "\${CONFIG.DEFAULT_MODEL}",
    "messages": [{"role": "user", "content": "你好，请介绍一下你自己。"}],
    "stream": true
  }'

# 流式响应 (逐行输出)
curl -N ... # 同上，添加 -N 参数
                    \`,
                    'python': \`
from openai import OpenAI

client = OpenAI(
    base_url='\${apiBaseUrl}',
    api_key='\${apiKey}',
)

completion = client.chat.completions.create(
    model="\${CONFIG.DEFAULT_MODEL}",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)

for chunk in completion:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end='')
                    \`,
                };
                this.shadowRoot.innerHTML = \`
                    <style>
                        .tab-header { display: flex; border-bottom: 1px solid #444; margin-bottom: 1rem; }
                        .tab-btn { padding: 0.5rem 1rem; background: none; border: none; color: #888; cursor: pointer; border-bottom: 2px solid transparent; }
                        .tab-btn.active { color: #FFBF00; border-bottom-color: #FFBF00; }
                        .config-block { background: #1a1a1a; padding: 1rem; border-radius: 6px; font-family: 'SF Mono', monospace; white-space: pre-wrap; font-size: 0.875rem; overflow-x: auto; }
                        .copy-btn { margin-top: 0.5rem; background: #444; color: white; border: none; padding: 0.25rem 0.75rem; border-radius: 4px; cursor: pointer; }
                    </style>
                    <div>
                        <div class="tab-header">
                            \${tabs.map(tab => \`
                                <button class="tab-btn \${this.activeTab === tab.id ? 'active' : ''}" data-tab="\${tab.id}">
                                    \${tab.icon} \${tab.name}
                                </button>
                            \`).join('')}
                        </div>
                        <div class="config-block" id="config-content">\${configs[this.activeTab]}</div>
                        <button class="copy-btn" onclick="utils.copyToCliptext(this.previousElementSibling.textContent)">复制配置</button>
                    </div>
                \`;
                // 标签页切换
                this.shadowRoot.querySelectorAll('.tab-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        this.activeTab = btn.dataset.tab;
                        this.render();
                    });
                });
            }
        }
        customElements.define('client-guides', ClientGuides);

        // ==================== 自定义元素: API 接口参考 ====================
        class ApiReference extends HTMLElement {
            connectedCallback() {
                this.innerHTML = \`
                    <table class="min-w-full text-sm">
                        <thead>
                            <tr class="bg-gray-800">
                                <th class="py-2 px-3 text-left">端点</th>
                                <th class="py-2 px-3 text-left">方法</th>
                                <th class="py-2 px-3 text-left">描述</th>
                                <th class="py-2 px-3 text-left">认证</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr class="border-b border-gray-800">
                                <td class="py-2 px-3 font-mono">/v1/chat/completions</td>
                                <td><span class="bg-blue-900 text-blue-200 px-2 py-1 rounded text-xs">POST</span></td>
                                <td>OpenAI 聊天补全接口 (支持流式)</td>
                                <td><span class="bg-amber-900 text-amber-200 px-2 py-1 rounded text-xs">必需</span></td>
                            </tr>
                            <tr class="border-b border-gray-800">
                                <td class="py-2 px-3 font-mono">/v1/models</td>
                                <td><span class="bg-green-900 text-green-200 px-2 py-1 rounded text-xs">GET</span></td>
                                <td>列出可用模型</td>
                                <td><span class="bg-amber-900 text-amber-200 px-2 py-1 rounded text-xs">必需</span></td>
                            </tr>
                            <tr class="border-b border-gray-800">
                                <td class="py-2 px-3 font-mono">/v1/responses</td>
                                <td><span class="bg-blue-900 text-blue-200 px-2 py-1 rounded text-xs">POST</span></td>
                                <td>OpenAI Responses API (部分实现)</td>
                                <td><span class="bg-amber-900 text-amber-200 px-2 py-1 rounded text-xs">必需</span></td>
                            </tr>
                            <tr class="border-b border-gray-800">
                                <td class="py-2 px-3 font-mono">/v1beta/models</td>
                                <td><span class="bg-green-900 text-green-200 px-2 py-1 rounded text-xs">GET</span></td>
                                <td>Google AI 格式模型列表</td>
                                <td><span class="bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs">可选</span></td>
                            </tr>
                            <tr>
                                <td class="py-2 px-3 font-mono">/v1beta/models/...:generateContent</td>
                                <td><span class="bg-blue-900 text-blue-200 px-2 py-1 rounded text-xs">POST</span></td>
                                <td>Google AI 原生生成接口</td>
                                <td><span class="bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs">可选</span></td>
                            </tr>
                        </tbody>
                    </table>
                \`;
            }
        }
        customElements.define('api-reference', ApiReference);

        // ==================== 自定义元素: 调试与复现工具箱 ====================
        class DebugToolbox extends HTMLElement {
            constructor() {
                super();
                this.lastRequest = null;
            }
            connectedCallback() {
                this.render();
                // 监听所有 fetch 请求以便记录 (简化示例)
                const originalFetch = window.fetch;
                window.fetch = async (...args) => {
                    const [url, options] = args;
                    if (url.includes('/v1/')) {
                        this.lastRequest = { url, options: { ...options }, timestamp: Date.now() };
                        this.updateLastRequestDisplay();
                    }
                    return originalFetch(...args);
                };
            }
            render() {
                this.innerHTML = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium mb-1">上游接口</label>
                            <code class="bg-gray-800 px-2 py-1 rounded text-sm">\${CONFIG.UPSTREAM_BASE_URL}</code>
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">项目模式</label>
                            <code class="bg-gray-800 px-2 py-1 rounded text-sm">Cloudflare Worker 代理 (无服务器)</code>
                        </div>
                        <div>
                            <label class="block text-sm font-medium mb-1">上次请求详情</label>
                            <div class="bg-gray-800 rounded p-3 text-xs font-mono overflow-auto max-h-40" id="last-request-detail">
                                暂无请求记录
                            </div>
                        </div>
                        <div class="flex space-x-2">
                            <button class="flex-1 bg-gray-800 hover:bg-gray-700 py-2 rounded text-sm" onclick="this.getRootNode().host.viewLastRequest()">查看详情</button>
                            <button class="flex-1 bg-amber-highlight hover:bg-amber-600 text-black py-2 rounded text-sm" onclick="this.getRootNode().host.copyAsCurl()">一键复现 cURL</button>
                        </div>
                        <div class="text-xs text-gray-500">
                            <p>💡 此工具箱可帮助您调试和复现问题。"一键复现 cURL" 会生成一个完全相同的命令行请求。</p>
                        </div>
                    </div>
                \`;
            }
            updateLastRequestDisplay() {
                const el = this.querySelector('#last-request-detail');
                if (!this.lastRequest) return;
                const { url, options, timestamp } = this.lastRequest;
                el.textContent = \`\${new Date(timestamp).toLocaleTimeString()} \${options.method} \${url}\\n\`;
            }
            viewLastRequest() {
                if (!this.lastRequest) {
                    utils.showToast('暂无请求记录', 'info');
                    return;
                }
                const detail = JSON.stringify(this.lastRequest, null, 2);
                alert(\`上次请求详情:\\n\\n\${detail}\`);
            }
            copyAsCurl() {
                if (!this.lastRequest) {
                    utils.showToast('暂无请求记录', 'info');
                    return;
                }
                const { url, options } = this.lastRequest;
                let curl = \`curl -X \${options.method} '\${url}'\\\\\\n\`;
                if (options.headers) {
                    for (const [k, v] of Object.entries(options.headers)) {
                        if (v) curl += \`  -H '\${k}: \${v}'\\\\\\n\`;
                    }
                }
                if (options.body) {
                    curl += \`  -d '\${typeof options.body === 'string' ? options.body : JSON.stringify(options.body)}'\`;
                }
                utils.copyToClipboard(curl);
            }
        }
        customElements.define('debug-toolbox', DebugToolbox);

        // ==================== 应用初始化 ====================
        document.addEventListener('DOMContentLoaded', () => {
            // 将工具函数暴露给全局，便于自定义元素内联调用
            window.utils = utils;
            window.stateManager = stateManager;
            // 初始化健康检查
            document.querySelector('health-status')?.checkHealth();
            // 状态设置为初始化完成
            setTimeout(() => stateManager.setState(STATE.READY), 1000);
        });
    </script>
</body>
</html>
    `;
    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Encoding': 'gzip',
        },
    });
}