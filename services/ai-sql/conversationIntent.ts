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
