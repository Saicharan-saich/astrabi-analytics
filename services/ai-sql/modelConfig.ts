/**
 * AI Model Configuration — Shared across all AI services
 *
 * Implements a model fallback chain so that if one free model is
 * rate-limited (429), the request automatically retries with the
 * next model. This eliminates single-model fragility.
 *
 * All free models on OpenRouter have rate limits (~20 req/min).
 * By cycling through multiple models, we effectively multiply
 * our available quota.
 */

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';

/**
 * Ordered fallback chain of free models.
 * If any returns 429/502/503, the next one is tried automatically.
 * `openrouter/free` is a meta-router that auto-picks any available free model.
 */
export const MODEL_CHAIN: string[] = [
    'google/gemma-3-27b-it:free',       // Primary — strong structured output
    'meta-llama/llama-4-maverick:free',  // Fallback 1 — Meta Llama 4 Maverick
    'deepseek/deepseek-r1:free',         // Fallback 2 — DeepSeek R1
    'openrouter/free',                    // Meta-router — picks ANY available free model
];

/** The primary model (for UI display) */
export const PRIMARY_MODEL = MODEL_CHAIN[0];

/** Default timeout for AI requests */
export const DEFAULT_TIMEOUT_MS = 25000;

/**
 * Fetch with automatic model fallback.
 *
 * Tries each model in the chain. If a model returns 429 (rate limit)
 * or 503 (temporarily unavailable), moves to the next model.
 * Other errors (401, 402, 500) are thrown immediately.
 *
 * @param messages - Chat messages to send
 * @param options - Optional overrides for temperature, max_tokens, timeout
 * @returns The parsed API response data + which model was used
 */
export async function fetchWithFallback(
    messages: Array<{ role: string; content: any }>,
    options?: {
        temperature?: number;
        max_tokens?: number;
        timeout?: number;
    }
): Promise<{ data: any; model: string }> {

    if (!API_KEY) {
        throw new Error('OpenRouter API key not configured. Set VITE_OPENROUTER_API_KEY in .env');
    }

    const temperature = options?.temperature ?? 0.0;
    const max_tokens = options?.max_tokens ?? 1500;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    const retryableStatuses = new Set([429, 502, 503, 404]);
    const errors: string[] = [];

    for (const model of MODEL_CHAIN) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(OPENROUTER_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://astrabi.app',
                    'X-Title': 'Astrabi Analytics',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature,
                    max_tokens,
                }),
                signal: controller.signal,
            });

            clearTimeout(timer);

            if (response.ok) {
                const data = await response.json();
                if (model !== MODEL_CHAIN[0]) {
                    console.log(`[AI] Primary model unavailable — used fallback: ${model}`);
                }
                return { data, model };
            }

            // Retryable error — log and try next model
            if (retryableStatuses.has(response.status)) {
                const body = await response.text().catch(() => '');
                console.warn(`[AI] ${model} returned ${response.status} — trying next model`);
                errors.push(`${model}: ${response.status}`);
                continue;
            }

            // Non-retryable error — throw immediately
            const errorBody = await response.text().catch(() => 'Unknown error');
            throw new Error(`API error (${response.status}): ${errorBody}`);

        } catch (err: any) {
            clearTimeout(timer);

            // Abort (timeout) — try next model
            if (err.name === 'AbortError') {
                console.warn(`[AI] ${model} timed out — trying next model`);
                errors.push(`${model}: timeout`);
                continue;
            }

            // Non-retryable error — throw
            throw err;
        }
    }

    // All models exhausted
    throw new Error(
        `All AI models are currently rate-limited. Tried: ${errors.join(', ')}. ` +
        `Please wait 30-60 seconds and try again.`
    );
}
