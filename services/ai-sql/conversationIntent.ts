import type { Dataset } from '../../types';
import { requestAIConversationTurn } from './conversationClient';

export type AIConversationRoute = 'analysis' | 'summary_story' | 'conversation' | 'clarification';
export type AIConversationTurnType =
    | 'new_question'
    | 'follow_up'
    | 'multi_intent'
    | 'greeting'
    | 'help'
    | 'thanks'
    | 'goodbye'
    | 'clarification';

export interface AIConversationResolution {
    route: AIConversationRoute;
    turnType: AIConversationTurnType;
    usedPreviousQuestion: boolean;
    resolvedQuestion: string;
    confidence: number;
    replyTitle?: string;
    replyMessage?: string;
    clarificationQuestion?: string;
    model: string;
    tokens: number;
}

function normalizeConfidence(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

export function normalizeAIConversationResolution(
    raw: Record<string, unknown>,
    _currentQuestion: string,
    previousBusinessQuestion: string | null,
    model: string,
    tokens: number,
): AIConversationResolution {
    const routes: AIConversationRoute[] = ['analysis', 'summary_story', 'conversation', 'clarification'];
    const turnTypes: AIConversationTurnType[] = [
        'follow_up', 'greeting', 'help', 'thanks', 'goodbye',
        'new_question', 'multi_intent', 'clarification',
    ];
    const route = String(raw.route || '') as AIConversationRoute;
    const turnType = String(raw.turnType || '') as AIConversationTurnType;
    if (!routes.includes(route) || !turnTypes.includes(turnType)) {
        throw new Error('The AI conversation planner returned an invalid routing decision.');
    }
    if (turnType === 'follow_up' && !previousBusinessQuestion) {
        throw new Error('The AI conversation planner requested context that is not available.');
    }

    const resolvedQuestion = String(raw.resolvedQuestion || '').trim();
    if (!resolvedQuestion) throw new Error('The AI conversation planner did not provide a standalone question.');

    const resolution: AIConversationResolution = {
        route,
        turnType,
        usedPreviousQuestion: turnType === 'follow_up',
        resolvedQuestion,
        confidence: normalizeConfidence(raw.confidence),
        model,
        tokens,
    };
    if (route === 'conversation') {
        resolution.replyTitle = String(raw.replyTitle || '').trim();
        resolution.replyMessage = String(raw.replyMessage || '').trim();
        if (!resolution.replyTitle || !resolution.replyMessage) {
            throw new Error('The AI conversation planner returned an incomplete conversational response.');
        }
    }
    if (route === 'clarification') {
        resolution.clarificationQuestion = String(raw.clarificationQuestion || '').trim();
        if (!resolution.clarificationQuestion) {
            throw new Error('The AI conversation planner did not provide the required clarification.');
        }
    }
    return resolution;
}

/**
 * Resolve conversational meaning exclusively with the server-owned LLM.
 * Dataset is retained in the signature for stable callers, but no dataset
 * schema, values or locally inferred intent are sent to the resolver.
 */
export async function resolveConversationTurnWithAI(
    question: string,
    _dataset: Dataset,
    previousBusinessQuestion?: string | null,
): Promise<AIConversationResolution> {
    const currentQuestion = question.replace(/\s+/g, ' ').trim();
    const previous = previousBusinessQuestion?.replace(/\s+/g, ' ').trim() || null;
    const response = await requestAIConversationTurn({
        currentQuestion,
        previousBusinessQuestion: previous,
    });
    const usage = response.usage || {};
    const tokens = Number(usage.total_tokens)
        || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    return normalizeAIConversationResolution(
        response.resolution,
        currentQuestion,
        previous,
        response.model,
        tokens,
    );
}
