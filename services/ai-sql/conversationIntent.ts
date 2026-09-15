import type { Dataset } from '../../types';

export type ConversationTurnKind = 'analysis' | 'follow_up' | 'greeting' | 'help' | 'thanks' | 'goodbye';

export interface ConversationTurnResolution {
    kind: ConversationTurnKind;
    resolvedQuestion: string;
}

const GREETING = /^(?:hello|helo|hi|hey|hiya|howdy)(?:\s+there)?[!?.,\s]*$|^(?:good\s+(?:morning|afternoon|evening)|how are you|what'?s up)[!?.,\s]*$/i;
const HELP = /^(?:help|help me|what can you do|who are you|what are you|how (?:does this work|do i ask|should i ask)|show me (?:how|examples?)|give me examples?)[!?.,\s]*$/i;
const THANKS = /^(?:thanks|thank you|thank you very much|great thanks|okay thanks|ok thanks|cheers)[!?.,\s]*$/i;
const GOODBYE = /^(?:bye|goodbye|see you|that'?s all|done for now)[!?.,\s]*$/i;
const FOLLOW_UP_START = /^(?:and|also|now|then|but|instead|what about|how about|same|only|exclude|include|filter|break it down|split it|compare it|by\b|for\b|in\b|during\b|where\b)/i;
const ANALYTICAL_LANGUAGE = /\b(?:show|list|count|total|sum|average|avg|minimum|min|max|maximum|compare|versus|vs|trend|growth|share|percentage|percent|top|bottom|highest|lowest|rank|distribution|correlation|summary|overview|dashboard|records?|rows?|sales|revenue|profit|amount|value|quantity|orders?|customers?|products?|category|region|period|month|quarter|year|week|day|fy\s*\d+)\b/i;

function normalize(value: string): string {
    return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function mentionsDatasetField(question: string, dataset: Dataset): boolean {
    const normalizedQuestion = ` ${normalize(question).toLowerCase()} `;
    const fields = dataset.aiSqlSemanticModel?.fields || [];
    return fields.some(field => [field.name, field.displayLabel, ...(field.synonyms || [])]
        .filter(Boolean)
        .some(value => {
            const normalizedValue = normalize(String(value)).toLowerCase();
            return normalizedValue.length > 2 && normalizedQuestion.includes(` ${normalizedValue} `);
        }));
}

/**
 * Resolve lightweight conversation locally. Only the immediately preceding
 * business question may be reused, and only when the new turn is clearly a
 * follow-up. No answer text, SQL, result rows, or full transcript is retained.
 */
export function resolveConversationTurn(
    question: string,
    dataset: Dataset,
    previousBusinessQuestion?: string | null,
): ConversationTurnResolution {
    const normalized = normalize(question);
    if (GREETING.test(normalized)) return { kind: 'greeting', resolvedQuestion: normalized };
    if (HELP.test(normalized)) return { kind: 'help', resolvedQuestion: normalized };
    if (THANKS.test(normalized)) return { kind: 'thanks', resolvedQuestion: normalized };
    if (GOODBYE.test(normalized)) return { kind: 'goodbye', resolvedQuestion: normalized };

    const looksLikeFollowUp = Boolean(previousBusinessQuestion)
        && normalized.length <= 120
        && (FOLLOW_UP_START.test(normalized)
            || (!ANALYTICAL_LANGUAGE.test(normalized) && !mentionsDatasetField(normalized, dataset) && normalized.split(/\s+/).length <= 6));

    if (looksLikeFollowUp) {
        return {
            kind: 'follow_up',
            resolvedQuestion: `${previousBusinessQuestion!.replace(/[?.!]+$/, '')}; ${normalized}`,
        };
    }

    return { kind: 'analysis', resolvedQuestion: normalized };
}
