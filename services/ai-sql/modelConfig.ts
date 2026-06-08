/**
 * AI Model Configuration — Shared across all AI services
 *
 * ALL AI requests are routed through the backend proxy (/api/llm/chat)
 * which handles:
 *   - API key security (never exposed to frontend)
 *   - Per-user JWT authentication
 *   - Daily quota enforcement
 *   - Usage tracking in PostgreSQL
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';
export const BACKEND_LLM_URL = `${API_BASE}/llm/chat`;

// Legacy exports kept for compatibility — NOT used for direct calls
export const OPENROUTER_API_URL = BACKEND_LLM_URL;
export const API_KEY = '__ROUTED_THROUGH_BACKEND__';

/** The model to use for all AI requests */
export const PRIMARY_MODEL = 'google/gemini-2.0-flash-001';

/** Default timeout for AI requests */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Delay before retrying a rate-limited request */
const RATE_LIMIT_RETRY_DELAY_MS = 2000;

/** Max retries for 429 errors */
const MAX_429_RETRIES = 3;

/** Get JWT token for authenticated AI requests */
function getAuthToken(): string {
    return localStorage.getItem('qi_token') || '';
}

/**
 * Fetch from the AI model via backend proxy with retry logic.
 *
 * 1. Send request to backend proxy with JWT auth
 * 2. Backend validates user, checks quota, then forwards to OpenRouter
 * 3. If 429 (rate limited) → wait 2s and retry up to 3 times
 * 4. If any other error → throw clean user-facing message
 */
export async function fetchWithFallback(
    messages: Array<{ role: string; content: any }>,
    options?: {
        temperature?: number;
        max_tokens?: number;
        timeout?: number;
    }
): Promise<{ data: any; model: string }> {

    const token = getAuthToken();
    if (!token) {
        throw new Error('Please log in to use AI features. Your session may have expired.');
    }

    const temperature = options?.temperature ?? 0.0;
    const max_tokens = options?.max_tokens ?? 1500;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(BACKEND_LLM_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
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

            // 401 Unauthorized — user not logged in or session revoked
            if (response.status === 401) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Please log in to use AI features.');
            }

            // 429 Rate Limited or Quota Exceeded
            if (response.status === 429) {
                const errData = await response.json().catch(() => ({}));
                if (errData.quotaExceeded) {
                    throw new Error(errData.error || 'Daily AI quota exceeded. Contact your admin.');
                }
                if (attempt < MAX_429_RETRIES) {
                    console.warn(`[AI] Rate limited — waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
                    continue;
                }
                throw new Error(
                    'AI model is currently busy (rate limited). Please wait a moment and try again.'
                );
            }

            // Other errors
            if (response.status === 402) {
                throw new Error('AI credits exhausted. Please contact admin.');
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

