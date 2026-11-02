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

const FILLER_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'by', 'is', 'are', 'was', 'were', 'be',
    'my', 'our', 'your', 'i', 'we', 'you', 'me', 'us', 'please', 'can', 'could', 'would', 'will',
    'what', 'which', 'who', 'how', 'show', 'give', 'tell', 'make', 'do', 'does', 'did', 'get', 'let',
    'see', 'now', 'about', 'with', 'just', 'also', 'again', 'more', 'same', 'compare', 'fix', 'one', 'ones',
    'it', 'its', 'them', 'that', 'this', 'those', 'these', 'there', 'here', 'thing', 'things', 'stuff',
]);

/**
 * True when the message carries something to analyse ("best performing
 * product", "revenue by region"), as opposed to a bare reference such as
 * "compare them" or "fix it". Vague wording is answered with an explained
 * default by the analysis planner, which can see the dataset; only a message
 * with nothing to act on needs a question back.
 */
export function hasAnalyticalContent(question: string): boolean {
    const words = question.toLowerCase().match(/[a-z0-9£$€%]+/g) || [];
    return words.some(word => !FILLER_WORDS.has(word));
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
    const resolution = normalizeAIConversationResolution(
        response.resolution,
        currentQuestion,
        previous,
        response.model,
        tokens,
    );
    // The resolver sees only the sentence, not the data, so it cannot tell
    // that "best performing" has a sensible default here. A real analytical
    // question goes on to analysis; the planner picks and explains the measure.
    if (resolution.route === 'clarification' && hasAnalyticalContent(currentQuestion)) {
        console.log('[AI SQL Conversation] Clarification overridden: the question can be answered with an explained default.');
        return {
            ...resolution,
            route: 'analysis',
            turnType: resolution.usedPreviousQuestion ? 'follow_up' : 'new_question',
            resolvedQuestion: resolution.resolvedQuestion || currentQuestion,
            clarificationQuestion: undefined,
        };
    }
    return resolution;
}
