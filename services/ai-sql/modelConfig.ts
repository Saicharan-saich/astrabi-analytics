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

/**
 * OpenRouter model ladder for AI SQL. All three are OpenAI GPT-5.6 models and
 * are requested through the existing backend proxy, so keys, quotas and the
 * request/response shape remain unchanged.
 */
export const LUNA_MODEL = 'openai/gpt-5.6-luna';
export const TERRA_MODEL = 'openai/gpt-5.6-terra';
export const SOL_MODEL = 'openai/gpt-5.6-sol';

/** Fast path for straightforward questions and single-table SQL. */
export const PRIMARY_MODEL = LUNA_MODEL;

/** Balanced default for structured analytical planning. */
export const PLANNER_MODEL = TERRA_MODEL;

/** A short, user-readable description for the AI SQL screen. */
export const MODEL_LADDER_LABEL = 'GPT-5.6 Luna · Terra · Sol';

export type AISQLWorkload = 'plan' | 'sql';

export interface AISQLModelRoute {
    model: string;
    tier: 'luna' | 'terra' | 'sol';
    workload: AISQLWorkload;
    reason: string;
}

/**
 * Route only the unresolved part of a request to the lightest capable model.
 * Most everyday questions are answered by the deterministic semantic plan and
 * compiler without an LLM call; this selector is used only for plan ambiguity
 * or a genuinely unsupported analytical shape.
 */
export function selectAISQLRoute(question: string, workload: AISQLWorkload): AISQLModelRoute {
    const normalized = question.toLowerCase();

    const needsDeepReasoning = /\b(join|across\s+(multiple|several)|subquery|cohort|retention|funnel|correlation|moving\s+(average|avg)|rolling\s+(average|avg)|what[-\s]?if|forecast|anomal(?:y|ies)|compound|fiscal\s+(?:year|quarter|calendar)|custom\s+calendar)\b/.test(normalized);
    if (needsDeepReasoning) {
        return { model: SOL_MODEL, tier: 'sol', workload, reason: 'Complex analytical shape requires deeper reasoning' };
    }

    const needsStructuredPlanning = /\b(compare|versus|\bvs\b|growth|trend|share|percentage|percent|ratio|rank|top\s+\d+|bottom\s+\d+|distinct|average|between|before|after|month[-\s]?over[-\s]?month|year[-\s]?over[-\s]?year)\b/.test(normalized);
    if (workload === 'plan' || needsStructuredPlanning) {
        return { model: TERRA_MODEL, tier: 'terra', workload, reason: 'Structured analytical planning or validation is required' };
    }

    return { model: LUNA_MODEL, tier: 'luna', workload, reason: 'Straightforward semantic clarification' };
}

/** Compatibility helper for existing callers. */
export function selectAISQLModel(question: string, workload: AISQLWorkload): string {
    return selectAISQLRoute(question, workload).model;
}

/** Default timeout for AI requests */
export const DEFAULT_TIMEOUT_MS = 60000;

/** Fallback delay when a rate-limited response omits server timing headers. */
const RATE_LIMIT_RETRY_DELAY_MS = 3000;

/**
 * Respect the backend's actual rate-limit window instead of retrying every two
 * seconds. express-rate-limit returns Retry-After in seconds; OpenRouter and
 * proxies may return an HTTP date or a RateLimit reset value.
 */
export function getRateLimitRetryDelayMs(response: Pick<Response, 'headers'>, now = Date.now()): number {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.max(1000, Math.ceil(seconds * 1000) + 250);
        }
        const retryDate = Date.parse(retryAfter);
        if (Number.isFinite(retryDate)) {
            return Math.max(1000, retryDate - now + 250);
        }
    }

    const standardRateLimit = response.headers.get('RateLimit');
    const resetMatch = standardRateLimit?.match(/reset\s*=\s*"?(\d+)"?/i);
    if (resetMatch) {
        return Math.max(1000, Number(resetMatch[1]) * 1000 + 250);
    }

    const legacyReset = Number(response.headers.get('RateLimit-Reset') || response.headers.get('X-RateLimit-Reset'));
    if (Number.isFinite(legacyReset) && legacyReset > 0) {
        const delay = legacyReset > 1_000_000_000
            ? legacyReset * 1000 - now
            : legacyReset * 1000;
        return Math.max(1000, delay + 250);
    }

    return RATE_LIMIT_RETRY_DELAY_MS;
}

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
        model?: string;
        /**
         * Admin Benchmark Lab calls use a separately audited server-side quota.
         * The backend still verifies the authenticated database role, so this
         * marker cannot grant benchmark capacity to a normal user.
         */
        requestPurpose?: 'benchmark';
    }
): Promise<{ data: any; model: string }> {

    const token = getAuthToken();
    if (!token) {
        throw new Error('Please log in to use AI features. Your session may have expired.');
    }

    const temperature = options?.temperature ?? 0.0;
    // 2000 is high enough that a full analysis plan or a moderately complex SQL
    // statement fits without being cut off mid-JSON at the token ceiling — the
    // "LLM returned unparseable JSON" truncation failure came from too low a cap.
    const max_tokens = options?.max_tokens ?? 2000;
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
    const model = options?.model ?? PRIMARY_MODEL;

    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(BACKEND_LLM_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    ...(options?.requestPurpose === 'benchmark'
                        ? { 'X-QuickInsight-AI-Purpose': 'benchmark' }
                        : {}),
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

                if (!content) {
                    throw new Error(
                        'The AI model returned an empty response. Please try again in a few seconds.'
                    );
                }

                return { data, model };
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
                    const retryDelayMs = getRateLimitRetryDelayMs(response);
                    console.warn(`[AI] Rate limited — waiting ${retryDelayMs}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
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

            const errData = await response.json().catch(() => ({} as Record<string, unknown>));
            const providerType = typeof errData.providerErrorType === 'string' ? ` [${errData.providerErrorType}]` : '';
            const requestId = typeof errData.requestId === 'string' ? ` (request ${errData.requestId})` : '';
            const providerMessage = typeof errData.error === 'string'
                ? errData.error
                : `AI provider returned HTTP ${response.status}.`;
            throw new Error(`${providerMessage}${providerType}${requestId}`);

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

