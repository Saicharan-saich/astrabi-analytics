/**
 * AI Model Configuration — Shared across all AI services
 *
 * Uses Google Gemini 2.5 Flash (paid) for best SQL generation quality
 * at minimal cost (~$0.0005 per query).
 *
 * $5 budget ≈ 10,000 queries.
 */

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';

/** The model to use for all AI requests */
export const PRIMARY_MODEL = 'google/gemini-2.5-flash-preview';

/** Default timeout for AI requests */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Delay before retrying a rate-limited request */
const RATE_LIMIT_RETRY_DELAY_MS = 2000;

/** Max retries for 429 errors */
const MAX_429_RETRIES = 3;

/**
 * Fetch from the AI model with retry logic.
 *
 * 1. Send request to PRIMARY_MODEL
 * 2. If 429 (rate limited) → wait 2s and retry up to 3 times
 * 3. If any other error → throw clean user-facing message
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
                    model: PRIMARY_MODEL,
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

                if (!content) {
                    throw new Error(
                        'The AI model returned an empty response. Please try again in a few seconds.'
                    );
                }

                return { data, model: PRIMARY_MODEL };
            }

            // 429 Rate Limited — wait and retry
            if (response.status === 429) {
                if (attempt < MAX_429_RETRIES) {
                    console.warn(`[AI] Rate limited — waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
                    continue;
                }
                throw new Error(
                    'AI model is currently busy (rate limited). Please wait a moment and try again.'
                );
            }

            // Other errors — clean message
            if (response.status === 404) {
                throw new Error(
                    'AI model is temporarily unavailable. Please try again later.'
                );
            }

            if (response.status === 402) {
                throw new Error(
                    'OpenRouter credits exhausted. Please add more credits at openrouter.ai.'
                );
            }

            if (response.status === 502 || response.status === 503) {
                throw new Error(
                    'AI service is experiencing downtime. Please try again in a few minutes.'
                );
            }

            const errorBody = await response.text().catch(() => 'Unknown error');
            throw new Error(`AI service error (${response.status}): ${errorBody}`);

        } catch (err: any) {
            clearTimeout(timer);

            if (err.name === 'AbortError') {
                throw new Error(
                    'AI request timed out. Please try a simpler question or try again later.'
                );
            }

            throw err;
        }
    }

    throw new Error('AI model is currently unavailable. Please try again later.');
}
