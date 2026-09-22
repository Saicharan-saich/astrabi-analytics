const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';
const AI_SQL_TURN_URL = `${API_BASE}/ai-sql/resolve-turn`;

export interface AIConversationTurnRequest {
    currentQuestion: string;
    previousBusinessQuestion: string | null;
}

export interface AIConversationTurnResponse {
    resolution: Record<string, unknown>;
    model: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

function getAuthToken(): string {
    return localStorage.getItem('qi_token') || '';
}

/**
 * Call the dedicated server-owned conversation resolver. The browser cannot
 * choose the model, prompt or token budget and sends no schema, rows, SQL,
 * answers or local classification evidence.
 */
export async function requestAIConversationTurn(
    request: AIConversationTurnRequest,
): Promise<AIConversationTurnResponse> {
    const token = getAuthToken();
    if (!token) {
        throw new Error('Please log in to use AI features. Your session may have expired.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(AI_SQL_TURN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });

        const payload = await response.json().catch(() => ({} as Record<string, unknown>));
        if (!response.ok) {
            const message = typeof payload.error === 'string'
                ? payload.error
                : `AI conversation service returned HTTP ${response.status}.`;
            throw new Error(message);
        }
        if (!payload.resolution || typeof payload.resolution !== 'object' || Array.isArray(payload.resolution)) {
            throw new Error('The AI conversation resolver returned an invalid response. Please try again.');
        }
        return payload as unknown as AIConversationTurnResponse;
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            throw new Error('AI conversation request timed out. Please try again.');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
