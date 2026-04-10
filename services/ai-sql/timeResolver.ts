/**
 * Time Resolver — Pre-LLM time context resolution
 *
 * Resolves relative time references ("this month", "last 30 days", "this year")
 * to concrete date ranges BEFORE the LLM sees the question.
 *
 * This eliminates ambiguity: the LLM never has to interpret "this_month"
 * because it receives concrete BETWEEN filters.
 *
 * Uses the dataset's anchor date (max date) as "today".
 */

import { SemanticModel, PlanFilter } from './types';

export interface ResolvedTimeContext {
    /** The concrete filter to inject into the plan */
    filter: PlanFilter | null;
    /** The original phrase that was matched */
    matchedPhrase: string | null;
    /** Human-readable description of the resolved period */
    description: string | null;
}

/**
 * All supported relative time patterns.
 * Ordered by specificity (most specific first).
 */
const TIME_PATTERNS: { regex: RegExp; resolve: (anchor: Date, match: RegExpMatchArray) => { start: Date; end: Date; desc: string } }[] = [
    // "last N days"
    {
        regex: /\b(?:last|past|previous)\s+(\d+)\s+days?\b/i,
        resolve: (anchor, match) => {
            const n = parseInt(match[1]);
            const end = new Date(anchor);
            const start = new Date(anchor);
            start.setDate(start.getDate() - n);
            return { start, end, desc: `last ${n} days` };
        }
    },
    // "last N weeks"
    {
        regex: /\b(?:last|past|previous)\s+(\d+)\s+weeks?\b/i,
        resolve: (anchor, match) => {
            const n = parseInt(match[1]);
            const end = new Date(anchor);
            const start = new Date(anchor);
            start.setDate(start.getDate() - n * 7);
            return { start, end, desc: `last ${n} weeks` };
        }
    },
    // "last N months"
    {
        regex: /\b(?:last|past|previous)\s+(\d+)\s+months?\b/i,
        resolve: (anchor, match) => {
            const n = parseInt(match[1]);
            const end = new Date(anchor);
            const start = new Date(anchor);
            start.setMonth(start.getMonth() - n);
            return { start, end, desc: `last ${n} months` };
        }
    },
    // "last month" (the entire previous calendar month)
    {
        regex: /\b(?:last|previous)\s+month\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
            const end = new Date(anchor.getFullYear(), anchor.getMonth(), 0); // last day of prev month
            return { start, end, desc: 'last month' };
        }
    },
    // "last week" (the entire previous calendar week, Sun-Sat)
    {
        regex: /\b(?:last|previous)\s+week\b/i,
        resolve: (anchor) => {
            const day = anchor.getDay();
            const thisWeekStart = new Date(anchor);
            thisWeekStart.setDate(anchor.getDate() - day);
            const lastWeekStart = new Date(thisWeekStart);
            lastWeekStart.setDate(thisWeekStart.getDate() - 7);
            const lastWeekEnd = new Date(thisWeekStart);
            lastWeekEnd.setDate(thisWeekStart.getDate() - 1);
            return { start: lastWeekStart, end: lastWeekEnd, desc: 'last week' };
        }
    },
    // "last year" (entire previous calendar year)
    {
        regex: /\b(?:last|previous)\s+year\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear() - 1, 0, 1);
            const end = new Date(anchor.getFullYear() - 1, 11, 31);
            return { start, end, desc: 'last year' };
        }
    },
    // "last quarter"
    {
        regex: /\b(?:last|previous)\s+quarter\b/i,
        resolve: (anchor) => {
            const currentQ = Math.floor(anchor.getMonth() / 3);
            const prevQ = currentQ === 0 ? 3 : currentQ - 1;
            const year = currentQ === 0 ? anchor.getFullYear() - 1 : anchor.getFullYear();
            const start = new Date(year, prevQ * 3, 1);
            const end = new Date(year, prevQ * 3 + 3, 0);
            return { start, end, desc: 'last quarter' };
        }
    },
    // "this month" / "current month"
    {
        regex: /\b(?:this|current)\s+month\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
            const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
            return { start, end, desc: 'this month' };
        }
    },
    // "this week" / "current week"
    {
        regex: /\b(?:this|current)\s+week\b/i,
        resolve: (anchor) => {
            const day = anchor.getDay();
            const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - day);
            const end = new Date(start);
            end.setDate(start.getDate() + 6);
            return { start, end, desc: 'this week' };
        }
    },
    // "this year" / "current year"
    {
        regex: /\b(?:this|current)\s+year\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear(), 0, 1);
            const end = new Date(anchor.getFullYear(), 11, 31);
            return { start, end, desc: 'this year' };
        }
    },
    // "this quarter" / "current quarter"
    {
        regex: /\b(?:this|current)\s+quarter\b/i,
        resolve: (anchor) => {
            const q = Math.floor(anchor.getMonth() / 3);
            const start = new Date(anchor.getFullYear(), q * 3, 1);
            const end = new Date(anchor.getFullYear(), q * 3 + 3, 0);
            return { start, end, desc: 'this quarter' };
        }
    },
    // "today"
    {
        regex: /\btoday\b/i,
        resolve: (anchor) => {
            return { start: new Date(anchor), end: new Date(anchor), desc: 'today' };
        }
    },
    // "yesterday"
    {
        regex: /\byesterday\b/i,
        resolve: (anchor) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - 1);
            return { start: d, end: d, desc: 'yesterday' };
        }
    },
    // "year to date" / "ytd"
    {
        regex: /\b(?:year\s+to\s+date|ytd)\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear(), 0, 1);
            return { start, end: new Date(anchor), desc: 'year to date' };
        }
    },
    // "month to date" / "mtd"
    {
        regex: /\b(?:month\s+to\s+date|mtd)\b/i,
        resolve: (anchor) => {
            const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
            return { start, end: new Date(anchor), desc: 'month to date' };
        }
    },
];

function toISO(d: Date): string {
    return d.toISOString().split('T')[0];
}

/**
 * Resolve relative time references in a question to concrete date filters.
 * Runs BEFORE the LLM planner so it receives unambiguous dates.
 */
export function resolveTimeContext(question: string, model: SemanticModel): ResolvedTimeContext {
    // Use the dataset's anchor date as "today"
    const anchorStr = model.timeContext?.anchorDate;
    if (!anchorStr) {
        return { filter: null, matchedPhrase: null, description: null };
    }

    const anchor = new Date(anchorStr);
    if (isNaN(anchor.getTime())) {
        return { filter: null, matchedPhrase: null, description: null };
    }

    // Find the primary date column
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
        || model.timeContext?.primaryDateColumn
        || 'order_date';

    // Try each pattern in order (most specific first)
    for (const pattern of TIME_PATTERNS) {
        const match = question.match(pattern.regex);
        if (match) {
            const { start, end, desc } = pattern.resolve(anchor, match);
            const startStr = toISO(start);
            const endStr = toISO(end);

            console.log(`[Time Resolver] "${match[0]}" → ${dateField} BETWEEN ${startStr} AND ${endStr}`);

            return {
                filter: {
                    field: dateField,
                    op: 'between',
                    value: [startStr, endStr]
                },
                matchedPhrase: match[0],
                description: `${desc}: ${startStr} to ${endStr}`
            };
        }
    }

    return { filter: null, matchedPhrase: null, description: null };
}

/**
 * Inject the resolved time filter into the question context
 * that will be sent to the LLM, replacing the vague phrase
 * with concrete dates.
 */
export function augmentQuestionWithTime(
    question: string,
    resolved: ResolvedTimeContext
): string {
    if (!resolved.filter || !resolved.matchedPhrase) return question;

    const [start, end] = resolved.filter.value as string[];
    // Replace the vague phrase with concrete dates so the LLM doesn't need to interpret it
    return question.replace(
        new RegExp(resolved.matchedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `(date range: ${start} to ${end})`
    );
}
