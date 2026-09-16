import type { Dataset } from '../../types';
import { fetchWithFallback, LUNA_MODEL } from './modelConfig';
import { generateLocalPlan } from './intentPlanner';
import { resolveAISQLSemanticModel } from './semanticLayer';
import { detectBroadScopeQuestion, detectSummaryRequest } from './scopeIntent';

export type ConversationTurnKind = 'analysis' | 'follow_up' | 'greeting' | 'help' | 'thanks' | 'goodbye';

export interface ConversationTurnResolution {
    kind: ConversationTurnKind;
    resolvedQuestion: string;
}

export type AIConversationRoute = 'analysis' | 'summary_story' | 'conversation' | 'clarification';
export type AIConversationTurnType = ConversationTurnKind | 'new_question' | 'multi_intent' | 'clarification';

export interface AIConversationResolution {
    route: AIConversationRoute;
    turnType: AIConversationTurnType;
    resolvedQuestion: string;
    confidence: number;
    replyTitle?: string;
    replyMessage?: string;
    clarificationQuestion?: string;
    model: string;
    tokens: number;
}

const GREETING = /^(?:hello|helo|hi|hey|hiya|howdy)(?:\s+there)?[!?.,\s]*$|^(?:good\s+(?:morning|afternoon|evening)|how are you|what'?s up)[!?.,\s]*$/i;
const HELP = /^(?:help|help me|what can you do|who are you|what are you|how (?:does this work|do i ask|should i ask)|show me (?:how|examples?)|give me examples?)[!?.,\s]*$/i;
const THANKS = /^(?:thanks|thank you|thank you very much|great thanks|okay thanks|ok thanks|cheers)[!?.,\s]*$/i;
const GOODBYE = /^(?:bye|goodbye|see you|that'?s all|done for now)[!?.,\s]*$/i;
const FOLLOW_UP_START = /^(?:and|also|now|then|but|instead|what about|how about|same|only|exclude|include|filter|break it down|split it|compare it|by\b|for\b|in\b|during\b|where\b)/i;
const ANAPHORIC_FOLLOW_UP = /\b(?:it|that|those|them|the same|same result|same analysis|previous result|again)\b/i;

function normalize(value: string): string {
    return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve lightweight conversation locally. Only the immediately preceding
 * business question may be reused, and only when the new turn is clearly a
 * follow-up. No answer text, SQL, result rows, or full transcript is retained.
 */
export function resolveConversationTurn(
    question: string,
    _dataset: Dataset,
    previousBusinessQuestion?: string | null,
): ConversationTurnResolution {
    const normalized = normalize(question);
    if (GREETING.test(normalized)) return { kind: 'greeting', resolvedQuestion: normalized };
    if (HELP.test(normalized)) return { kind: 'help', resolvedQuestion: normalized };
    if (THANKS.test(normalized)) return { kind: 'thanks', resolvedQuestion: normalized };
    if (GOODBYE.test(normalized)) return { kind: 'goodbye', resolvedQuestion: normalized };

    // Context inheritance must be opt-in. The earlier broad fallback treated
    // any short question containing an unfamiliar business term as a follow-up.
    // That could turn "Which country are we exporting more?" into
    // "Give me a full data summary; Which country..." and wrongly launch the
    // summary-story workflow. Only explicit connective/anaphoric wording may
    // now reuse the immediately preceding question.
    const looksLikeFollowUp = Boolean(previousBusinessQuestion)
        && normalized.length <= 120
        && (FOLLOW_UP_START.test(normalized) || ANAPHORIC_FOLLOW_UP.test(normalized));

    if (looksLikeFollowUp) {
        return {
            kind: 'follow_up',
            resolvedQuestion: `${previousBusinessQuestion!.replace(/[?.!]+$/, '')}; ${normalized}`,
        };
    }

    return { kind: 'analysis', resolvedQuestion: normalized };
}

const CONVERSATION_SYSTEM_PROMPT = `You are the conversational planning stage of a privacy-first analytics application.
Decide how the CURRENT user message should be handled. You do not generate SQL, execute queries, grant permissions, or override local safety rules.

You receive:
- the current message;
- at most one previous business question (never an answer, SQL, rows, or full transcript);
- a metadata-only semantic field list;
- an advisory local analysis plan and local intent signals.

The current message is authoritative. Local evidence is useful but not authoritative.

Rules:
1. If the current message is a complete question on its own, classify it as a new question. Do not inherit the previous question merely because the wording is short or uses unfamiliar business vocabulary.
2. Use follow_up only when the current message explicitly depends on the previous question, such as "same for imports", "now FY2025", or "make it monthly". Rewrite it as one complete standalone question.
3. Use summary_story only when the current message itself asks for a dataset summary, overview, dashboard, snapshot, or multi-visual story. A previous summary request must never contaminate a new independent question.
4. Use conversation for greetings, thanks, help, and goodbyes. Write a concise, useful reply.
5. Use clarification only when a material choice changes the analytical meaning and cannot be safely expressed as a reasonable assumption.
6. Preserve every metric, grouping, filter, comparison, time period, ranking, and negation from the user's wording.
7. For multiple explicit analytical requests, use multi_intent and produce a faithful standalone request. Choose summary_story only if a summary/story was explicitly requested in the current message.

Return exactly one JSON object with this shape:
{
  "route": "analysis|summary_story|conversation|clarification",
  "turnType": "new_question|follow_up|multi_intent|greeting|help|thanks|goodbye|clarification",
  "resolvedQuestion": "standalone analytical wording, or the current message for conversation",
  "confidence": 0.0,
  "replyTitle": "required only for conversation",
  "replyMessage": "required only for conversation",
  "clarificationQuestion": "required only for clarification"
}`;

function extractJSONObject(content: string): Record<string, unknown> | null {
    const cleaned = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const value = JSON.parse(cleaned.slice(start, end + 1));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function normalizeConfidence(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

export function normalizeAIConversationResolution(
    raw: Record<string, unknown>,
    currentQuestion: string,
    previousBusinessQuestion: string | null,
    model: string,
    tokens: number,
): AIConversationResolution {
    const routes: AIConversationRoute[] = ['analysis', 'summary_story', 'conversation', 'clarification'];
    const turnTypes: AIConversationTurnType[] = [
        'analysis', 'follow_up', 'greeting', 'help', 'thanks', 'goodbye',
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
 * Let the model own conversational meaning while keeping the local engines in
 * front of it. Only metadata and one previous question are shared; no rows,
 * result values, SQL, or answer history are included.
 */
export async function resolveConversationTurnWithAI(
    question: string,
    dataset: Dataset,
    previousBusinessQuestion?: string | null,
): Promise<AIConversationResolution> {
    // Preserve punctuation such as FY2024-25; only collapse whitespace before
    // sending the user's wording to the conversational planner.
    const currentQuestion = question.replace(/\s+/g, ' ').trim();
    const previous = previousBusinessQuestion?.trim() || null;
    const semanticModel = resolveAISQLSemanticModel(dataset).model;
    const localConversationCandidate = resolveConversationTurn(currentQuestion, dataset, previous);
    const localPlan = generateLocalPlan(currentQuestion, semanticModel);
    const localSummarySignal = detectSummaryRequest(currentQuestion);
    const localScopeSignal = detectBroadScopeQuestion(currentQuestion);
    const fields = semanticModel.fields.slice(0, 80).map(field => ({
        name: field.name,
        label: field.displayLabel,
        role: field.role,
        semanticType: field.semanticType,
        synonyms: (field.synonyms || []).slice(0, 6),
    }));
    const localEvidence = {
        candidateTurn: localConversationCandidate.kind,
        candidateStandaloneQuestion: localConversationCandidate.resolvedQuestion,
        summarySignal: localSummarySignal.isSummary,
        broadScopeSignal: localScopeSignal.needsClarification,
        analysisPlan: {
            intent: localPlan.intent,
            metrics: localPlan.metrics,
            dimensions: localPlan.dimensions,
            filters: localPlan.filters,
            sort: localPlan.sort,
            limit: localPlan.limit,
            resultGrain: localPlan.resultGrain,
            ambiguous: localPlan.ambiguous,
        },
    };

    const { data, model } = await fetchWithFallback([
        { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
        {
            role: 'user',
            content: JSON.stringify({
                currentQuestion,
                previousBusinessQuestion: previous,
                dataset: { name: semanticModel.datasetName, grain: semanticModel.grain, fields },
                localEvidence,
            }),
        },
    ], { temperature: 0, max_tokens: 650, timeout: 30_000, model: LUNA_MODEL });

    const content = data.choices?.[0]?.message?.content || '';
    const parsed = extractJSONObject(content);
    if (!parsed) throw new Error('The AI conversation planner returned invalid JSON. Please try again.');
    const usage = data.usage || {};
    const tokens = Number(usage.total_tokens)
        || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    return normalizeAIConversationResolution(parsed, currentQuestion, previous, model, tokens);
}
