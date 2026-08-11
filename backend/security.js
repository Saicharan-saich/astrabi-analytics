'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_ALLOWED_LLM_MODELS = Object.freeze([
    'openai/gpt-5.6-luna',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-sol',
    // Retained for non-AI-SQL callers that rely on the proxy default.
    'google/gemini-2.5-flash',
]);

function createConnectionId(prefix = 'db') {
    const safePrefix = String(prefix).replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'db';
    return `${safePrefix}_${crypto.randomUUID()}`;
}

function isPrivateOrReservedAddress(address) {
    const normalized = String(address || '').trim().toLowerCase();
    const version = net.isIP(normalized);
    if (version === 4) {
        const octets = normalized.split('.').map(Number);
        const [a, b] = octets;
        return a === 0
            || a === 10
            || (a === 100 && b >= 64 && b <= 127)
            || a === 127
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0)
            || (a === 192 && b === 168)
            || (a === 192 && b === 2)
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51)
            || (a === 203 && b === 0)
            || a >= 224;
    }
    if (version === 6) {
        if (normalized === '::' || normalized === '::1') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        if (/^fe[89ab]/.test(normalized)) return true;
        if (normalized.startsWith('ff')) return true;
        const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return mapped ? isPrivateOrReservedAddress(mapped[1]) : false;
    }
    return true;
}

function validatePort(port, defaultPort) {
    const parsed = Number(port || defaultPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error('Database port must be an integer between 1 and 65535');
    }
    return parsed;
}

async function assertSafeDatabaseHost(host, port, options = {}) {
    const value = String(host || '').trim();
    if (!value) throw new Error('Database host is required');
    if (value.length > 253 || value.includes('://') || /[\/@?#\s]/.test(value)) {
        throw new Error('Database host must be a hostname or IP address, not a URL');
    }
    validatePort(port, options.defaultPort || 5432);
    if (options.allowPrivate === true) return value;

    let addresses;
    try {
        addresses = net.isIP(value)
            ? [{ address: value }]
            : await dns.lookup(value, { all: true, verbatim: true });
    } catch {
        throw new Error('Database host could not be resolved');
    }
    if (!addresses.length || addresses.some(entry => isPrivateOrReservedAddress(entry.address))) {
        throw new Error('Connections to private, loopback, link-local, or reserved network addresses are blocked');
    }
    return value;
}

function allowedLlmModels(extraModels = '') {
    const extras = String(extraModels || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_LLM_MODELS, ...extras]);
}

function contentSize(content) {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content) || content.length > 8) return -1;
    let total = 0;
    for (const part of content) {
        if (!part || typeof part !== 'object') return -1;
        if (part.type === 'text' && typeof part.text === 'string') {
            total += part.text.length;
        } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
            const url = part.image_url.url;
            if (!/^data:image\/(png|jpeg|webp);base64,/i.test(url)) return -1;
            total += url.length;
        } else {
            return -1;
        }
    }
    return total;
}

function validateLlmRequest(body, allowedModels = allowedLlmModels()) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { valid: false, error: 'Request body must be an object' };
    }
    const model = typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : 'google/gemini-2.5-flash';
    if (!allowedModels.has(model)) {
        return { valid: false, error: 'Requested AI model is not enabled' };
    }
    if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 24) {
        return { valid: false, error: 'messages must contain between 1 and 24 entries' };
    }

    let totalSize = 0;
    for (const message of body.messages) {
        if (!message || typeof message !== 'object'
            || !['system', 'user', 'assistant'].includes(message.role)) {
            return { valid: false, error: 'Each message must have a supported role' };
        }
        const size = contentSize(message.content);
        if (size < 0) return { valid: false, error: 'Message content has an unsupported format' };
        totalSize += size;
    }
    // Allows one rendered chart image while preventing unbounded proxy payloads.
    if (totalSize > 13_000_000) {
        return { valid: false, error: 'AI request content is too large' };
    }

    const maxTokens = body.max_tokens === undefined ? 2000 : Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4000) {
        return { valid: false, error: 'max_tokens must be an integer between 1 and 4000' };
    }
    const temperature = body.temperature === undefined ? 0.1 : Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
        return { valid: false, error: 'temperature must be between 0 and 1' };
    }
    return {
        valid: true,
        value: {
            model,
            messages: body.messages,
            max_tokens: maxTokens,
            temperature,
        },
    };
}

module.exports = {
    DEFAULT_ALLOWED_LLM_MODELS,
    allowedLlmModels,
    assertSafeDatabaseHost,
    createConnectionId,
    isPrivateOrReservedAddress,
    validateLlmRequest,
    validatePort,
};
