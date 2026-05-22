/**
 * AI Model Configuration — Shared across all AI services
 *
 * Implements a model fallback chain with retry logic:
 * - 404: model removed from OpenRouter → skip immediately
 * - 429: rate limited → wait 3s then retry ONCE, then move to next
 * - 502/503: temporarily down → skip to next
 * - 200 but empty content → skip to next
 *
 * All free models on OpenRouter have rate limits (~20 req/min).
 * By cycling through multiple models, we effectively multiply
 * our available quota.
 */

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';

/**
 * Ordered fallback chain of free models.
 * Only include models confirmed to exist on OpenRouter.
 * The `openrouter/free` meta-router auto-picks any available free model.
 */
export const MODEL_CHAIN: string[] = [
    'meta-llama/llama-3.3-70b-instruct:free', // Primary — confirmed working (429 = exists)
    'openrouter/free',                          // Meta-router — picks ANY available free model
];

/** The primary model (for UI display) */
export const PRIMARY_MODEL = MODEL_CHAIN[0];

/** Default timeout for AI requests */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Delay before retrying a 429'd model */
const RATE_LIMIT_RETRY_DELAY_MS = 3000;

/** Max retries per model for 429 errors */
const MAX_429_RETRIES = 2;

/**
 * Fetch with automatic model fallback and 429 retry logic.
 *
 * For each model:
 * 1. Send request
 * 2. If 429 (rate limited) → wait 3s and retry up to 2 times
 * 3. If 404/502/503 → skip to next model immediately
 * 4. If 200 but empty content → skip to next model
 * 5. If all models fail → throw with summary
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

    const skipStatuses = new Set([404, 502, 503]); // Skip immediately
    const errors: string[] = [];

    for (const model of MODEL_CHAIN) {
        // Try each model with up to MAX_429_RETRIES retries for rate limits
        for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
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
                    const content = data.choices?.[0]?.message?.content?.trim();

                    // Empty content — skip to next model (not a retry, the model just returned nothing)
                    if (!content) {
                        console.warn(`[AI] ${model} returned 200 but empty content — trying next model`);
                        errors.push(`${model}: empty content`);
                        break; // Break retry loop, move to next model
                    }

                    if (model !== MODEL_CHAIN[0]) {
                        console.log(`[AI] Primary model unavailable — used fallback: ${model}`);
                    }
                    return { data, model };
                }

                // 429 Rate Limited — wait and retry this same model
                if (response.status === 429) {
                    if (attempt < MAX_429_RETRIES) {
                        console.warn(`[AI] ${model} returned 429 — waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`);
                        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
                        continue; // Retry same model
                    }
                    // Exhausted retries for this model
                    console.warn(`[AI] ${model} returned 429 after ${MAX_429_RETRIES} retries — trying next model`);
                    errors.push(`${model}: 429 (${MAX_429_RETRIES} retries exhausted)`);
                    break; // Move to next model
                }

                // 404/502/503 — skip immediately to next model
                if (skipStatuses.has(response.status)) {
                    console.warn(`[AI] ${model} returned ${response.status} — trying next model`);
                    errors.push(`${model}: ${response.status}`);
                    break; // Move to next model
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
                    break; // Move to next model
                }

                // Non-retryable error — throw
                throw err;
            }
        }
    }

    // All models exhausted
    throw new Error(
        `All AI models are currently unavailable. Tried: ${errors.join(', ')}. ` +
        `Please wait 30-60 seconds and try again.`
    );
}
