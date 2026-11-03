/**
 * AI SQL chat: decide, locally and for free, where a message goes.
 *
 *  - chat        → conversation: "hi", "how does this work?", "how do you know
 *                  if my question is a follow-up?", "what does median mean?".
 *                  Answered by the AI in plain English, with the column names
 *                  only (never rows), on the lighter model.
 *  - summary     → "give me an overview of my data" — opens the data story.
 *  - new         → a self-contained analysis question — sent with NO history.
 *  - follow_up   → "now by month", "what about profit?" — sent with the last
 *                  few questions and their SQL (never results or rows).
 *
 * Both AIs can redirect: the analysis AI replies in words when a message turns
 * out to be conversation, and the chat AI hands a data question to analysis.
 */
import type { Dataset } from '../../types';

export type TurnKind = 'chat' | 'summary' | 'new' | 'follow_up';

export interface ContextTurn {
    /** The standalone question that was answered. */
    question: string;
    /** The SQL that answered it. */
    sql: string;
}

export interface TurnDecision {
    kind: TurnKind;
    /** Plain-English reason, shown to the user on hover. */
    reason: string;
    /** For chat: a reply to fall back on if the AI cannot be reached. */
    fallback?: { title: string; message: string };
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9£$€%\s'-]/g, ' ').split(/\s+/).filter(Boolean);

const GREETING = /^(hi|hello|hey|hiya|howdy|yo|good (morning|afternoon|evening))( there| team| quickinsight)?[\s!.,]*$/i;
const THANKS = /^(thanks|thank you|thx|ty|cheers|great|perfect|awesome|nice|cool|brilliant|lovely|ok|okay|got it|amazing)( (so much|a lot|mate|again))?( thanks| thank you)?[\s!.,]*$/i;
const GOODBYE = /^(bye|goodbye|see you|see ya|that'?s all|that is all|i'?m done|done)( for now| thanks| thank you)?[\s!.,]*$/i;
const SUMMARY = /^(?:(?:please |can you |could you )?(?:give|show|tell) me )?(?:a |an )?(?:quick |short |full )?(?:summary|overview|story|rundown)(?: of)?(?: (?:my|the|this) (?:data|dataset|file|sheet))?[\s?!.]*$|^(?:please )?summari[sz]e (?:my|the|this) (?:data|dataset|file|sheet)[\s?!.]*$/i;

/** Asking for numbers from the data. */
const ANALYSIS_WORDS = /\b(show|total|sum|average|avg|mean|median|count|how many|how much|top|bottom|best|worst|highest|lowest|most|least|trend|compare|comparison|break ?down|by|per|list|chart|plot|graph|growth|share|percentage|rank|ranking|filter|between|over time|monthly|yearly|weekly|daily|each|split|distribution)\b/i;
/** About the assistant, the app or how things work. */
const ABOUT_THE_APP = /\b(you|your|yourself|quickinsight|this app|the app|this tool|ai sql|chat ?bot|bot|memory|follow[- ]?up|isolated|privacy|private|safe|secure|security|tokens?|how does (this|it) work|what can i ask|help)\b/i;
/** Asking what something means. */
const DEFINITION = /^(what is|what's|what are|what does|define|explain|meaning of|difference between|why (do|did|does|is|are) you|how (do|did|does) you|how (do|does|did) (this|it)|can you explain)\b/i;

/** Openers that only make sense after a previous answer. */
const CONTINUES = /^(and|but|also|now|then|so|ok(ay)?,?|what about|how about|and what about|what if|same|instead|only|just|excluding|exclude|without|except|plus|versus|vs\.?|compared? (to|with)|split|break( it| that| this)? down|drill( down)?|sort|order|rank|show (it|that|this|them|those|these)|make (it|that|this)|change|switch|turn (it|that|this)|as a|as an|top \d+|bottom \d+|filter|group|limit|remove|add|include|exclude)\b/i;
/** "by month", "for 2024": a follow-up when short, a new question when long. */
const PREPOSITION_START = /^(by|per|for|in|within|during|over)\b/i;
/** Talking about the answer itself: "the chart", "the visual", "this table". */
const ABOUT_THE_ANSWER = /\b(the|this|that|your) (visual|visualisation|visualization|chart|graph|plot|result|results|answer|table|output|query|sql|numbers?|figures?|labels?|legend|axis|bars?|lines?)\b/i;
/** A complaint or question about the last answer: "I can't see the names", "that's wrong". */
const ABOUT_A_PROBLEM = /\b(can'?t|cannot|can not|don'?t|doesn'?t|isn'?t|aren'?t|not|no|missing|wrong|incorrect|instead of)\b[\s\S]*\b(see|seeing|show|shown|showing|visible|included|include|there|right|correct|listed|named|names?)\b|^why\b[\s\S]*\b(not|no|only|missing|wrong|same|zero|empty)\b/i;
/** Words that point back at the previous answer. */
const REFERS_BACK = /\b(it|its|that|those|these|them|they|the same|previous|above|earlier|last (one|answer|chart|result|query)|this (chart|result|answer|one|table)|as well|too|instead|again|also)\b/i;

/** Column names and their words, for spotting a question about the data. */
function columnVocabulary(dataset: Pick<Dataset, 'columns'> | null | undefined): Set<string> {
    const vocabulary = new Set<string>();
    for (const column of dataset?.columns || []) {
        const name = column.name.toLowerCase();
        vocabulary.add(name);
        for (const part of name.split(/[^a-z0-9]+/)) if (part.length >= 3) vocabulary.add(part);
    }
    return vocabulary;
}

const FALLBACK_HELP = {
    title: 'How AI SQL works',
    message: 'Ask a question about your data in plain English. The AI sees only your column names and types, never your rows, and writes one read-only query that runs here in your browser. Follow-ups like "now by month" build on the last answer.',
};

/**
 * Classify the message. `hasPreviousAnswer` is true when the chat already has
 * an answered question this message could build on.
 */
export function classifyTurn(message: string, hasPreviousAnswer: boolean, dataset?: Pick<Dataset, 'columns'> | null): TurnDecision {
    const text = message.replace(/\s+/g, ' ').trim();
    if (GREETING.test(text)) return { kind: 'chat', reason: 'A greeting — the AI replies in words.', fallback: { title: 'Hello!', message: 'Ask me anything about your data — a total, a ranking, a comparison or a trend.' } };
    if (THANKS.test(text)) return { kind: 'chat', reason: 'A thank-you — the AI replies in words.', fallback: { title: 'You’re welcome', message: 'Ask another question whenever you are ready.' } };
    if (GOODBYE.test(text)) return { kind: 'chat', reason: 'A goodbye — the AI replies in words.', fallback: { title: 'See you soon', message: 'Your conversation is saved here.' } };
    if (SUMMARY.test(text)) return { kind: 'summary', reason: 'An overview of the whole dataset.' };

    const core = text.replace(/^(great|perfect|thanks|thank you|cool|nice|ok|okay|good|lovely|awesome|right|alright|interesting)[,!.]?\s+/i, '');
    const tokens = words(core);
    const vocabulary = columnVocabulary(dataset);
    const mentionsColumns = tokens.filter(token => vocabulary.has(token.replace(/'s$/, ''))).length;
    const asksForNumbers = ANALYSIS_WORDS.test(core) && mentionsColumns > 0;

    // Conversation: about the assistant or the app, or what something means,
    // and not a request for numbers from the data.
    if (!asksForNumbers && (ABOUT_THE_APP.test(core) || DEFINITION.test(core)) && !ABOUT_A_PROBLEM.test(core)) {
        return { kind: 'chat', reason: 'A question for the assistant — the AI replies in words.', fallback: FALLBACK_HELP };
    }
    if (!hasPreviousAnswer) {
        return { kind: 'new', reason: 'The first question in this chat — sent without history.' };
    }
    if (CONTINUES.test(core) || (PREPOSITION_START.test(core) && tokens.length <= 5)) {
        return { kind: 'follow_up', reason: 'Starts like a follow-up, so the last answer is included.' };
    }
    if (ABOUT_THE_ANSWER.test(core) || ABOUT_A_PROBLEM.test(core)) {
        return { kind: 'follow_up', reason: 'Talks about the last answer, so it is included.' };
    }
    if (REFERS_BACK.test(core)) {
        return { kind: 'follow_up', reason: 'Refers back to the last answer, so it is included.' };
    }
    // A short fragment ("profit", "2024 only") needs the last answer, unless it
    // names both what to measure and how to split it ("revenue by region").
    if (tokens.length <= 4 && mentionsColumns < 2 && !/^(what|which|who|how|show|list|give|count|compare|is|are|does|do|did)\b/i.test(core)) {
        return { kind: 'follow_up', reason: 'A short fragment, so it builds on the last answer.' };
    }
    if (mentionsColumns >= 1 || tokens.length >= 5) {
        return { kind: 'new', reason: 'A complete question on its own — sent without history to save tokens.' };
    }
    return { kind: 'follow_up', reason: 'Not clearly a new topic, so the last answer is included.' };
}

/** The most recent answered turns, oldest first, limited to `window`. */
export function contextForFollowUp(answered: ContextTurn[], window: number): ContextTurn[] {
    if (window <= 0) return [];
    return answered.filter(turn => turn.question && turn.sql).slice(-window);
}

/** The context block placed in the AI prompt: questions and SQL only. */
export function formatContextForPrompt(context: ContextTurn[]): string {
    return context.map((turn, index) => `${index + 1}. Asked: ${JSON.stringify(turn.question)}\n   SQL: ${turn.sql.replace(/\s+/g, ' ').trim()}`).join('\n');
}

/** Rough token count (≈4 characters per token) for showing what context costs. */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

const humanName = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One-click follow-ups after an answer, written locally from the column list.
 * Each is phrased so the classifier sends it as a follow-up.
 */
export function suggestFollowUps(
    answer: { sql: string; analysis: { xKey?: string; data?: any[]; vis?: string } },
    dataset: Pick<Dataset, 'columns'> | null | undefined,
): string[] {
    const columns = dataset?.columns || [];
    const sql = answer.sql.toLowerCase();
    const used = (name: string) => sql.includes(`"${name.toLowerCase()}"`) || new RegExp(`\\b${name.toLowerCase().replace(/[^a-z0-9_]/g, '')}\\b`).test(sql);
    const dimensions = columns.filter(column => String(column.type) === 'DIMENSION');
    const measures = columns.filter(column => String(column.type) === 'METRIC');
    const date = columns.find(column => String(column.type) === 'DATE');
    const rows = answer.analysis.data?.length || 0;
    const isTime = /date_trunc|month|year|quarter|week/i.test(answer.analysis.xKey || '') || /date_trunc\(/i.test(sql);
    const suggestions: string[] = [];

    if (date && !isTime && rows > 1) suggestions.push('Now show it by month');
    if (isTime) suggestions.push('Only the last 12 months');
    if (!isTime && rows > 5) suggestions.push('Only the top 5');
    const otherDimension = dimensions.find(column => !used(column.name));
    if (otherDimension && rows >= 1) suggestions.push(`Break it down by ${humanName(otherDimension.name)}`);
    const otherMeasure = measures.find(column => !used(column.name));
    if (otherMeasure) suggestions.push(`What about ${humanName(otherMeasure.name)}?`);
    if (!isTime && rows >= 2 && rows <= 8 && answer.analysis.vis !== 'doughnut' && answer.analysis.vis !== 'pie') suggestions.push('Show it as a pie');
    return [...new Set(suggestions)].slice(0, 4);
}
