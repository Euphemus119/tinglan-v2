/* 听澜 2 · 接口层
   只做一件事：把 DeepSeek 的流式返回拆成「思考链」和「正文」两股。
   所有错误都转成带 kind 的 ApiError，界面据此给出人话提示。
*/
'use strict';

const API = (function () {
    const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
    const TIMEOUT_MS = 180000;

    class ApiError extends Error {
        constructor(kind, message, status) {
            super(message);
            this.name = 'ApiError';
            this.kind = kind;
            this.status = status || 0;
        }
    }

    function friendlyMessage(status, detail) {
        if (status === 401) return 'API Key 无效或已失效，请重新设置。';
        if (status === 402) return '账户余额不足，请到 platform.deepseek.com 充值后再试。';
        if (status === 422) return '请求参数有问题，换一句短一点的内容再试。';
        if (status === 429) return '请求太频繁了，等几秒再发。';
        if (status === 500 || status === 502 || status === 503 || status === 504) return 'DeepSeek 服务暂时不可用，稍后再试。';
        if (status === 404) return '接口地址或模型名称不对（可能需要更新模型名）。';
        return '请求失败' + (status ? '（HTTP ' + status + '）' : '') + (detail ? '：' + detail : '');
    }

    async function readErrorDetail(res) {
        let raw = '';
        try { raw = await res.text(); } catch (e) { return ''; }
        if (!raw) return '';
        try {
            const json = JSON.parse(raw);
            const err = json && json.error;
            if (err) return String(err.message || err.type || '').slice(0, 200);
        } catch (e) { /* 不是 JSON，直接截断原文 */ }
        return raw.slice(0, 200);
    }

    /**
     * 发起一次流式请求。
     * onReasoning / onContent 会收到「累计到当前为止」的全文，界面直接整体替换即可。
     */
    async function stream(options) {
        const apiKey = options.apiKey;
        const model = options.model;
        const messages = options.messages;
        const signal = options.signal;
        const onReasoning = options.onReasoning || function () {};
        const onContent = options.onContent || function () {};

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(function () { timedOut = true; controller.abort(); }, TIMEOUT_MS);
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
        }

        let res;
        try {
            res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + apiKey
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    stream: true,
                    max_tokens: 8192
                }),
                signal: controller.signal
            });
        } catch (err) {
            clearTimeout(timer);
            if (err && (err.name === 'AbortError' || err.code === 20)) {
                if (timedOut) throw new ApiError('timeout', '等了太久没有响应，请重试。');
                const e = new Error('已停止');
                e.name = 'AbortError';
                throw e;
            }
            throw new ApiError('network', '网络连接失败，请检查网络后重试。');
        }

        if (!res.ok) {
            clearTimeout(timer);
            const detail = await readErrorDetail(res);
            const kind = res.status === 401 ? 'auth' : res.status === 402 ? 'quota' : res.status === 429 ? 'rate' : 'server';
            throw new ApiError(kind, friendlyMessage(res.status, detail), res.status);
        }

        let parser;
        try {
            // 某些环境（或代理）会把流式响应变成普通 JSON，这里做兜底
            if (!res.body || typeof res.body.getReader !== 'function') {
                const data = await res.json();
                const choice = data.choices && data.choices[0];
                const msg = choice && choice.message;
                if (!msg) throw new ApiError('empty', '模型没有返回内容，请重试。');
                if (msg.reasoning_content) onReasoning(msg.reasoning_content);
                if (msg.content) onContent(msg.content);
                return { content: msg.content || '', reasoning: msg.reasoning_content || '' };
            }

            parser = createParser(onReasoning, onContent);
            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                parser.push(decoder.decode(chunk.value, { stream: true }));
                if (parser.done()) break;
            }
            parser.flush();
            const result = parser.result();
            if (!result.content && !result.reasoning) {
                throw new ApiError('empty', '模型没有返回内容，请重试。');
            }
            return result;
        } catch (err) {
            if (err && err.name === 'AbortError') {
                if (timedOut) throw new ApiError('timeout', '回复超时了，请重试。');
                throw err;
            }
            if (err && err.name === 'ApiError') throw err;
            throw new ApiError('stream', '接收回复时出错：' + ((err && err.message) || '未知错误'));
        } finally {
            clearTimeout(timer);
        }
    }

    function createParser(onReasoning, onContent) {
        let buffer = '';
        let content = '';
        let reasoning = '';
        let finished = false;
        let error = null;

        function feedLine(raw) {
            const line = raw.replace(/\r$/, '').trim();
            if (!line || line.indexOf('data:') !== 0) return;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { finished = true; return; }
            let json;
            try { json = JSON.parse(payload); } catch (e) { return; }
            if (json.error) {
                error = new ApiError('server', friendlyMessage(0, String(json.error.message || json.error.type || '')));
                finished = true;
                return;
            }
            const choice = json.choices && json.choices[0];
            const delta = choice && (choice.delta || choice.message);
            if (!delta) return;
            if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                onReasoning(reasoning);
            }
            if (delta.content) {
                content += delta.content;
                onContent(content);
            }
        }

        return {
            push: function (text) {
                buffer += text;
                let nl;
                while (!finished && (nl = buffer.indexOf('\n')) >= 0) {
                    const raw = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    feedLine(raw);
                }
                if (finished) buffer = '';
            },
            flush: function () {
                if (!finished && buffer.trim()) feedLine(buffer);
                buffer = '';
            },
            result: function () {
                if (error) throw error;
                return { content: content, reasoning: reasoning };
            },
            done: function () { return finished; }
        };
    }

    return { stream: stream, ApiError: ApiError, MODELS: { chat: 'deepseek-chat', think: 'deepseek-reasoner' } };
})();
