'use strict';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function cleanMessage(value) {
    if (typeof value !== 'string') return '';
    const compact = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!compact || /(?:bearer\s+|api[_ -]?key|gho_|sk-)[a-z0-9_\-]{8,}/i.test(compact)) return '';
    return compact.slice(0, 280);
}

function parseProviderError(status, rawBody) {
    let payload = null;
    try { payload = JSON.parse(rawBody); } catch { /* OpenRouter can return text/html. */ }

    const providerError = payload?.error;
    const message = cleanMessage(
        (typeof providerError === 'string' ? providerError : providerError?.message)
        || payload?.message
    );
    const providerErrorType = cleanMessage(
        providerError?.metadata?.error_type
        || providerError?.type
        || payload?.error_type
    );
    const retryable = RETRYABLE_STATUS.has(Number(status));
    const category = status === 403
        ? (/(guardrail|moderation|policy)/i.test(`${providerErrorType} ${message}`) ? 'guardrail_blocked' : 'permission_denied')
        : status === 402 ? 'credits_exhausted'
            : status === 429 ? 'rate_limited'
                : retryable ? 'provider_temporarily_unavailable'
                    : 'provider_error';
    const defaultMessage = status === 403
        ? 'The model provider denied this request. Check model access or provider guardrail settings.'
        : `LLM provider returned HTTP ${status}.`;

    return {
        message: message || defaultMessage,
        providerErrorType: providerErrorType || category,
        category,
        retryable,
    };
}

module.exports = { parseProviderError };
