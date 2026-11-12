/**
 * Did the AI read the question the other way round? The AI restates every
 * question in its own words ("Which departments have negative total variance,
 * meaning actual spending was below budget?"). When the person asked about
 * losing money or overspending and the restatement is about spending BELOW
 * budget (a saving), or the person asked about missing a target and the
 * restatement is about beating it, the reading is turned around. Words only:
 * no data values are involved.
 */

const LOSS_ASKED = /\b(loss|losses|losing|lose|lost|loses|overspen\w*|over[- ]budget|over[- ]spend\w*|in the red|deficits?|bleeding|money pits?|costing (?:me|us) (?:too much|more))\b/i;
const SHORTFALL_ASKED = /\b(shortfalls?|short of|(?:miss|missed|missing|misses) (?:the |its |their |our |my )?(?:target|goal|budget|forecast)s?|below (?:target|goal|forecast)|under (?:target|goal|forecast)|behind (?:target|plan|forecast))\b/i;

/** Spending or costs described as below, under or less than the budget: a saving. */
const SAVING_READ = /\b(under[- ]?spen\w*|under budget|below budget|within budget|saved|savings?)\b|\b(spen\w*|spent|costs?|expens\w*|expenditure|outgoings)\b[^.?!]{0,60}\b(below|under|less than|lower than|smaller than)\b[^.?!]{0,30}\b(budget\w*|plan\w*|forecast\w*|allocat\w*)/i;
/** Income described as above, over or beating its target: not a shortfall. */
const BEAT_READ = /\b(above|over|exceed\w*|beat\w*|ahead of|more than|higher than)\b[^.?!]{0,30}\b(target|goal|forecast|plan)\b/i;

export interface TurnedAround {
    /** What the person asked about, in words. */
    asked: string;
    /** What the AI's reading is about instead. */
    read: string;
}

export function readingTurnedAround(question: string, reading: string | undefined): TurnedAround | null {
    if (!reading || !question) return null;
    if (LOSS_ASKED.test(question) && SAVING_READ.test(reading) && !/\b(above|over|more than|higher than|exceed\w*)\b[^.?!]{0,30}\bbudget/i.test(reading)) {
        return { asked: 'losing money or spending more than budgeted', read: 'spending less than budgeted, which is a saving, not a loss' };
    }
    if (SHORTFALL_ASKED.test(question) && BEAT_READ.test(reading) && !SHORTFALL_ASKED.test(reading)) {
        return { asked: 'falling short of a target', read: 'beating the target' };
    }
    return null;
}

/**
 * The general check, for any data: the AI says which column it judged a
 * judgement word by and which way it took as worse; the column dictionary
 * (rules, the AI's own meanings, or the user's setting) says which way is
 * good. If they disagree, the answer is turned around.
 */
export function judgedAgainstMeaning(judgedBy: { column: string; worse: 'higher' | 'lower' } | undefined, good: 'higher' | 'lower' | 'neutral' | undefined): TurnedAround | null {
    if (!judgedBy || !good || good === 'neutral') return null;
    const name = judgedBy.column.replace(/_/g, ' ');
    const conflict = (good === 'higher' && judgedBy.worse === 'higher') || (good === 'lower' && judgedBy.worse === 'lower');
    if (!conflict) return null;
    return {
        asked: `the column meanings, which say a higher ${name} is ${good === 'higher' ? 'better' : 'worse'}`,
        read: `a ${judgedBy.worse} ${name} as worse`,
    };
}

/** The instruction sent back to the AI when its reading is turned around. */
export function turnAroundRepair(turned: TurnedAround, reading: string): string {
    return `Your reading of the question ("${reading}") ${turned.asked.startsWith('the column meanings') ? `takes ${turned.read}` : `is about ${turned.read}`}, but that goes against ${turned.asked.startsWith('the column meanings') ? turned.asked : `what the person asked about: ${turned.asked}`}. Answer the question the way it was asked: judge by the COLUMN MEANINGS (which way is good, what below 0 means, what people call it), follow any formula under "How columns are worked out", name the result for what it means, return every group worst first, and fill "judged_by".`;
}

/**
 * "Which departments are overspending?" answered with HAVING overspend > 0
 * returns one row and reads as if the others were never looked at — and if
 * the person believes another department is over, there is nothing to see.
 * True when the query keeps only the groups whose result is on one side of
 * zero and the question did not ask for a count or for "only" those.
 */
export function oneSidedFilter(sql: string, question: string): boolean {
    if (!/\bGROUP\s+BY\b/i.test(sql)) return false;
    if (/^\s*(how many|count|number of)\b/i.test(question) || /\b(only|just|exclud\w+|leave out|without)\b/i.test(question)) return false;
    const body = sql.replace(/--[^\n]*/g, ' ');
    // HAVING <something> > 0, >= 0, < 0, <= 0, <> 0 on a result of the grouping.
    if (/\bHAVING\b[^;]*?(?:<>|!=|[<>]=?)\s*-?0(?:\.0+)?\b(?!\s*\.\d)/i.test(body)) return true;
    // The same filter written outside: WITH t AS (… GROUP BY …) SELECT … FROM t WHERE overspend > 0
    const aliases = [...body.matchAll(/\bAS\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/gi)].map(m => m[2].toLowerCase());
    for (const m of body.matchAll(/\bWHERE\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:<>|!=|[<>]=?)\s*-?0(?:\.0+)?\b(?!\s*\.\d)/gi)) {
        if (aliases.includes(m[2].toLowerCase())) return true;
    }
    return false;
}

/** Sent back to the AI when its query keeps only one side. */
export const ONE_SIDED_REPAIR = 'Your query keeps only the groups on one side of zero (a HAVING or WHERE that compares the result with 0). Return EVERY group, ordered worst first, with no such filter: the answer itself says which groups are over and which are under, so the person can see that the others were checked too.';
