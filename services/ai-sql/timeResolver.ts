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
    /** Prior period offset for comparison (e.g., '1 year', '1 month') */
    comparisonOffset?: string | null;
}

/**
 * All supported relative time patterns.
 * Ordered by specificity (most specific first).
 */
const TIME_PATTERNS: { regex: RegExp; resolve: (anchor: Date, match: RegExpMatchArray) => { start: Date; end: Date; desc: string } }[] = [
    // Fiscal year / QX FYYY
    {
        regex: /\b(?:q([1-4])\s+)?(?:fy|fiscal\s+year)\s*(\d{2,4})?\b/i,
        resolve: (anchor, match) => {
            const qStr = match[1];
            const yearStr = match[2];
            let targetYear = anchor.getFullYear();
            if (yearStr) {
                targetYear = parseInt(yearStr);
                if (targetYear < 100) {
                    const century = Math.floor(anchor.getFullYear() / 100) * 100;
                    targetYear += century;
                    if (targetYear > anchor.getFullYear() + 10) {
                        targetYear -= 100;
                    }
                }
            } else {
                targetYear = anchor.getMonth() >= 9 ? anchor.getFullYear() + 1 : anchor.getFullYear();
            }

            const fyStartYear = targetYear - 1;

            if (qStr) {
                const q = parseInt(qStr);
                let startMonth = 0;
                let startYear = 0;
                if (q === 1) {
                    startMonth = 9;
                    startYear = fyStartYear;
                } else {
                    startMonth = (q - 2) * 3;
                    startYear = targetYear;
                }
                const start = new Date(startYear, startMonth, 1);
                const end = new Date(startYear, startMonth + 3, 0);
                return { start, end, desc: `Q${q} FY${targetYear}` };
            } else {
                const start = new Date(fyStartYear, 9, 1);
                const end = new Date(targetYear, 8, 30);
                return { start, end, desc: `FY${targetYear}` };
            }
        }
    },
    // Rolling/Trailing periods
    {
        regex: /\b(?:rolling|trailing|last\s+rolling)\s+(\d+)\s+(months?|quarters?|years?)\b|\b(?:ttm|r12m|trailing\s+12\s+months|last\s+rolling\s+quarter)\b/i,
        resolve: (anchor, match) => {
            const isTTM = /ttm|r12m|trailing\s+12\s+months/i.test(match[0]);
            const isLRQ = /last\s+rolling\s+quarter/i.test(match[0]);
            const n = isTTM ? 12 : (isLRQ ? 3 : parseInt(match[1]));
            const unit = isTTM || isLRQ ? 'months' : match[2].toLowerCase();
            
            const start = new Date(anchor);
            if (unit.startsWith('month')) {
                start.setMonth(start.getMonth() - n);
            } else if (unit.startsWith('quarter')) {
                start.setMonth(start.getMonth() - (n * 3));
            } else if (unit.startsWith('year')) {
                start.setFullYear(start.getFullYear() - n);
            }
            start.setDate(start.getDate() + 1);
            return { start, end: new Date(anchor), desc: isTTM ? 'trailing 12 months' : (isLRQ ? 'last rolling quarter' : `trailing ${n} ${unit}`) };
        }
    },
    // Multi-Unit Relative Offsets: "N units ago"
    {
        regex: /\b(\d+)\s+(years?|quarters?|months?|weeks?|days?)\s+ago\b/i,
        resolve: (anchor, match) => {
            const n = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            const start = new Date(anchor);
            const end = new Date(anchor);
            
            if (unit.startsWith('year')) {
                start.setFullYear(start.getFullYear() - n);
                start.setMonth(0, 1);
                end.setFullYear(end.getFullYear() - n);
                end.setMonth(11, 31);
            } else if (unit.startsWith('quarter')) {
                const currentQ = Math.floor(anchor.getMonth() / 3);
                const targetTotalQ = (anchor.getFullYear() * 4 + currentQ) - n;
                const targetYear = Math.floor(targetTotalQ / 4);
                const targetQ = targetTotalQ % 4;
                start.setFullYear(targetYear, targetQ * 3, 1);
                end.setFullYear(targetYear, targetQ * 3 + 3, 0);
            } else if (unit.startsWith('month')) {
                start.setMonth(start.getMonth() - n, 1);
                end.setMonth(end.getMonth() - n + 1, 0);
            } else if (unit.startsWith('week')) {
                start.setDate(start.getDate() - (n * 7) - start.getDay());
                end.setTime(start.getTime());
                end.setDate(start.getDate() + 6);
            } else if (unit.startsWith('day')) {
                start.setDate(start.getDate() - n);
                end.setDate(end.getDate() - n);
            }
            return { start, end, desc: `${n} ${unit} ago` };
        }
    },
    // Multi-Unit Relative Offsets: "unit before last"
    {
        regex: /\b(month|year|quarter|week)\s+before\s+last\b/i,
        resolve: (anchor, match) => {
            const unit = match[1].toLowerCase();
            const start = new Date(anchor);
            const end = new Date(anchor);
            if (unit === 'year') {
                start.setFullYear(start.getFullYear() - 2);
                start.setMonth(0, 1);
                end.setFullYear(end.getFullYear() - 2);
                end.setMonth(11, 31);
            } else if (unit === 'quarter') {
                const currentQ = Math.floor(anchor.getMonth() / 3);
                const targetTotalQ = (anchor.getFullYear() * 4 + currentQ) - 2;
                const targetYear = Math.floor(targetTotalQ / 4);
                const targetQ = targetTotalQ % 4;
                start.setFullYear(targetYear, targetQ * 3, 1);
                end.setFullYear(targetYear, targetQ * 3 + 3, 0);
            } else if (unit === 'month') {
                start.setMonth(start.getMonth() - 2, 1);
                end.setMonth(end.getMonth() - 2 + 1, 0);
            } else if (unit === 'week') {
                start.setDate(start.getDate() - 14 - start.getDay());
                end.setTime(start.getTime());
                end.setDate(start.getDate() + 6);
            }
            return { start, end, desc: `${unit} before last` };
        }
    },
    // Preposition + Bare month
    {
        regex: /\b(in|since|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
        resolve: (anchor, match) => {
            const prep = match[1].toLowerCase();
            const monthStr = match[2];
            const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const targetMonth = months.indexOf(monthStr.toLowerCase());
            let year = anchor.getFullYear();
            if (targetMonth > anchor.getMonth()) {
                year -= 1;
            }
            if (prep === 'since') {
                return { start: new Date(year, targetMonth, 1), end: new Date(anchor), desc: `since ${monthStr}` };
            } else if (prep === 'before') {
                return { start: new Date(1900, 0, 1), end: new Date(year, targetMonth, 0), desc: `before ${monthStr}` };
            } else {
                return { start: new Date(year, targetMonth, 1), end: new Date(year, targetMonth + 1, 0), desc: `in ${monthStr}` };
            }
        }
    },
    // Bare month
    {
        regex: /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
        resolve: (anchor, match) => {
            const monthStr = match[1];
            const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const targetMonth = months.indexOf(monthStr.toLowerCase());
            let year = anchor.getFullYear();
            if (targetMonth > anchor.getMonth()) {
                year -= 1;
            }
            return { start: new Date(year, targetMonth, 1), end: new Date(year, targetMonth + 1, 0), desc: monthStr };
        }
    },
    // "last N days"
    {
        regex: /\b(?:last|past|previous)\s+(\d+)\s+days?\b/i,
        resolve: (anchor, match) => {
            const n = parseInt(match[1]);
            const end = new Date(anchor);
            const start = new Date(anchor);
            start.setDate(start.getDate() - (n - 1)); // inclusive BETWEEN: N-1 to get exactly N days
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
            start.setDate(start.getDate() - (n * 7 - 1)); // inclusive BETWEEN: N*7-1 to get exactly N weeks
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
            start.setDate(start.getDate() + 1); // inclusive BETWEEN: shift 1 day forward
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
    // "quarter to date" / "qtd"
    {
        regex: /\b(?:quarter\s+to\s+date|qtd)\b/i,
        resolve: (anchor) => {
            const q = Math.floor(anchor.getMonth() / 3);
            const start = new Date(anchor.getFullYear(), q * 3, 1);
            return { start, end: new Date(anchor), desc: 'quarter to date' };
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

/** Resolve the shared unit in shorthand such as "compare this and last month".
 * The general pattern list sees "last month" first; without this pre-pass it
 * incorrectly makes the previous month the current comparison window. */
function coordinatedCurrentPeriodGrain(question: string): 'day' | 'week' | 'month' | 'quarter' | 'year' | null {
    const q = question.toLowerCase();
    const comparison = /\b(?:compare|comparison|versus|vs\.?)\b/.test(q);
    if (!comparison) return null;
    const coordinated = /\b(?:this|current)\b[\s\S]{0,35}\b(?:and|with|to|against|versus|vs\.?)\b[\s\S]{0,20}\b(?:last|previous|prior)\b/i.test(q)
        || /\b(?:last|previous|prior)\b[\s\S]{0,35}\b(?:and|with|to|against|versus|vs\.?)\b[\s\S]{0,20}\b(?:this|current)\b/i.test(q);
    if (!coordinated) return null;
    if (/\bquarter\b/.test(q)) return 'quarter';
    if (/\byear\b/.test(q)) return 'year';
    if (/\bweek\b/.test(q)) return 'week';
    if (/\bday\b/.test(q)) return 'day';
    if (/\bmonth\b/.test(q)) return 'month';
    return null;
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

    const coordinatedGrain = coordinatedCurrentPeriodGrain(question);
    if (coordinatedGrain) {
        let start: Date;
        let end: Date;
        if (coordinatedGrain === 'month') {
            start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
            end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
        } else if (coordinatedGrain === 'quarter') {
            const quarter = Math.floor(anchor.getUTCMonth() / 3);
            start = new Date(Date.UTC(anchor.getUTCFullYear(), quarter * 3, 1));
            end = new Date(Date.UTC(anchor.getUTCFullYear(), quarter * 3 + 3, 0));
        } else if (coordinatedGrain === 'year') {
            start = new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
            end = new Date(Date.UTC(anchor.getUTCFullYear(), 11, 31));
        } else if (coordinatedGrain === 'week') {
            start = new Date(anchor);
            start.setUTCDate(anchor.getUTCDate() - anchor.getUTCDay());
            end = new Date(start);
            end.setUTCDate(start.getUTCDate() + 6);
        } else {
            start = new Date(anchor);
            end = new Date(anchor);
        }
        const startStr = toISO(start);
        const endStr = toISO(end);
        console.log(`[Time Resolver] coordinated ${coordinatedGrain} comparison → ${dateField} BETWEEN ${startStr} AND ${endStr}`);
        return {
            filter: { field: dateField, op: 'between', value: [startStr, endStr] },
            matchedPhrase: `this and last ${coordinatedGrain}`,
            description: `this ${coordinatedGrain}: ${startStr} to ${endStr}`,
            comparisonOffset: `1 ${coordinatedGrain}`,
        };
    }

    let comparisonOffset = null;
    const comparisonMatch = question.match(/\b(yoy|mom|qoq|wow|sply)\b/i);
    if (comparisonMatch) {
        const comp = comparisonMatch[1].toLowerCase();
        if (comp === 'yoy' || comp === 'sply') comparisonOffset = '1 year';
        else if (comp === 'mom') comparisonOffset = '1 month';
        else if (comp === 'qoq') comparisonOffset = '1 quarter';
        else if (comp === 'wow') comparisonOffset = '1 week';
    }

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
                description: `${desc}: ${startStr} to ${endStr}`,
                comparisonOffset: comparisonOffset || undefined
            };
        }
    }

    if (comparisonOffset) {
        return { filter: null, matchedPhrase: comparisonMatch[0], description: null, comparisonOffset };
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
