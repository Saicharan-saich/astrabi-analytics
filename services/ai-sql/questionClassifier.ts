/**
 * Question Classifier — Deterministic intent detection from natural language.
 *
 * Uses regex patterns to classify 80% of analytics questions WITHOUT the LLM.
 * Only falls back to LLM for truly ambiguous queries.
 *
 * Priority order: exact pattern match → keyword combination → fallback to LLM
 */

/** Tokens that mark a TIME period rather than a data value. */
const TIME_TOKEN = /^(today|yesterday|tomorrow|now|ytd|mtd|qtd|yoy|mom|qoq|wow|last|previous|prior|this|current|next|year|years|quarter|quarters|month|months|week|weeks|day|days|period|periods|q[1-4]|h[12]|fy\d*|\d{4}|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)$/i;

/**
 * True only when a comparison keyword is flanked by TIME words.
 *
 * "this month vs last month" compares two periods. "Coffee vs Tea" and
 * "card vs cash" compare two CATEGORY VALUES — a filtered breakdown, not a
 * period comparison. A bare /\bvs\b/ test cannot tell them apart and used to
 * rewrite category questions into period comparisons, injecting a spurious
 * date filter and the wrong chart.
 */
export function isTimePeriodComparison(question: string): boolean {
    const q = question.toLowerCase();
    const KEYWORD = /\b(?:vs\b\.?|versus|compared?\s+(?:to|with|against))/g;
    const STOPWORD = /^(the|a|an|our|my|its|their|of|in|for)$/;
    const clean = (w: string) => w.replace(/[^a-z0-9]/gi, '');

    // Only the operand IMMEDIATELY either side of the keyword counts (skipping
    // articles). In "Coffee vs Tea last month" the operands are Coffee and Tea —
    // "last month" merely scopes the question, so this is still a category
    // comparison. Looking further out would wrongly catch that trailing period.
    const firstMeaningful = (words: string[]): string | null => {
        for (const w of words) {
            const c = clean(w);
            if (c && !STOPWORD.test(c)) return c;
        }
        return null;
    };

    let m: RegExpExecArray | null;
    while ((m = KEYWORD.exec(q)) !== null) {
        const before = firstMeaningful(q.slice(0, m.index).trim().split(/\s+/).filter(Boolean).reverse());
        const after = firstMeaningful(q.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean));
        if ((before && TIME_TOKEN.test(before)) || (after && TIME_TOKEN.test(after))) return true;
    }
    return false;
}

export type ClassifiedIntent =
    | 'trend' | 'ranking' | 'breakdown' | 'share_of_total'
    | 'single_metric' | 'comparison' | 'distribution' | 'correlation'
    | 'derived_metric' | 'aggregate_filter' | 'growth_analysis' | 'ambiguous' | 'distinct_values';

export interface ClassificationResult {
    intent: ClassifiedIntent;
    confidence: number;          // 0-1
    timeGrain?: string;          // detected grain (month, quarter, day_of_week, etc.)
    sortDirection?: 'asc' | 'desc';
    limit?: number;
    needsLLM: boolean;           // true if LLM should handle field mapping
    reason: string;              // human-readable explanation
}

// ── Pattern Groups ──────────────────────────────────────────────

const TREND_PATTERNS = [
    /\b(trend|over\s+time|timeline|over\s+the\s+(past|last))\b/i,
    /\b(monthly|weekly|daily|quarterly|yearly|annual)\s+(sales|revenue|profit|growth|trend|performance)\b/i,
    /\b(sales|revenue|profit|orders?)\s+(trend|over\s+time)\b/i,
    /\bshow\s+(me\s+)?(the\s+)?(monthly|weekly|daily|quarterly)\b/i,
    /\bhow\s+(has|have|did|does)\s+.+\s+(changed?|grown?|trended?|performed?)\b/i,
    /\b(running\s+total|cumulative|rolling\s+average|moving\s+average|\d+-month\s+moving|\d+-day\s+rolling|year-to-date\s+cumulative)\b/i,
];

const RANKING_PATTERNS = [
    /\b(top|bottom)\s+\d+\b/i,
    /\b(highest|lowest|best|worst|most|least|biggest|smallest|greatest|busiest|slowest)\b/i,
    /\bwhich\s+\w+\s+(has|had|have|is|are|was|were|generated?|produced?|sold)\b/i,
    /\brank(ing|ed)?\b/i,
    /\bleader\s*board\b/i,
    /\b(80\/20|pareto|80\s*percent|80%|concentrate|account\s+for\s+most|majority\s+of)\b/i,
];

const SHARE_PATTERNS = [
    /\b(share|percentage|proportion|percent|what\s+%)\b/i,
    /\b(contribut(e|es|ion|ing))\b/i,
    /\b(breakdown|split)\s+(of|by)\b/i,
    /\bpie\s+chart\b/i,
];

const COMPARISON_PATTERNS = [
    // NOTE: no bare compare/vs/versus pattern — it cannot distinguish
    // "Coffee vs Tea" (two category VALUES) from "this month vs last month"
    // (two PERIODS). isTimePeriodComparison() makes that call instead and is
    // added to the comparison score below.
    /\b(yoy|mom|qoq|wow)\b/i,
    /\b(year|month|quarter|week)\s*(-|\s+)over\s*(-|\s+)(year|month|quarter|week)\b/i,
    /\b(same\s+(day|week|month|quarter)\s+last\s+(week|month|quarter|year))\b/i,
    /\b(this\s+(week|month|quarter|year)\s+(vs\.?|versus|compared))\b/i,
    /\b(growth|change|changing|grew|declined|increasing|decreasing)\b/i,
];

const SINGLE_METRIC_PATTERNS = [
    /\b(what\s+is|what's|how\s+much|how\s+many|total|overall)\s+(the\s+)?(total|average|avg|sum|count|number\s+of)\b/i,
    /\b(total|overall|grand\s+total)\s+(sales|revenue|profit|orders?|quantity|amount)\b/i,
    /\b(count|number)\s+of\s+(all\s+)?\w+\b/i,
    // "How many customers ordered more than once?" is a scalar count. Excluded
    // when the question groups ("how many orders per category"), so the
    // breakdown intent keeps those.
    /\bhow\s+many\b(?!.*\b(by|per|for\s+each|across)\b)/i,
];

const BREAKDOWN_PATTERNS = [
    /\b(by|per|for\s+each|group\s+by|across|breakdown)\s+(category|region|segment|product|customer|department|state|city|country|type|group|status)\b/i,
    /\b(category|region|segment|product|department|state|city)\s+(breakdown|analysis|performance|summary)\b/i,
    /\bsales\s+by\b/i,
    /\brevenue\s+by\b/i,
    /\bprofit\s+by\b/i,
];

const DISTRIBUTION_PATTERNS = [
    /\b(distribution|histogram|spread|frequency|bell\s+curve)\b/i,
    /\bhow\s+(are|is)\s+.+\s+distributed\b/i,
];

const AGGREGATE_FILTER_PATTERNS = [
    /\b(above|below|over|under|exceed(?:ing|s)?|greater\s+than|higher\s+than|less\s+than|lower\s+than)\s*(?:the\s+)?(?:average|avg|mean)\b/i,
    /\bwith\s+(high|low|above|below).+(margin|aov|rate|ratio|sales|revenue|profit)\b/i,
    /\b(outperform|underperform)(?:ing|s|ed)?\b/i,
    /\b(unusual|anomaly|anomalies|outlier|outliers|abnormal|unexpected|spike|dip|irregular)\b/i,
];

const GROWTH_ANALYSIS_PATTERNS = [
    /\b(driving|drove)\s+(?:\w+\s+)*(?:revenue|sales|profit)?\s*growth\b/i,
    /\bcontribut\w+\s+(?:\w+\s+)*(?:to\s+)?(?:revenue|sales|profit)?\s*growth\b/i,
    /\b(grow(?:ing|n|th)|grew)\s+(?:the\s+)?(fastest|most|slowest|least)\b/i,
    /\b(largest|biggest|smallest|highest|lowest)\s+(increase|decrease|decline|drop|gain|growth)\b/i,
    /\b(growth|decline)\s+(contribut|driver|leader)\b/i,
    /\b(revenue|sales|profit)\s+growth\s+by\s+(product|category|region|segment)\b/i,
    /\bfastest\s+grow(ing|th)\b/i,
    /\b(increase|decrease|growth|decline)\s+(%|percent|percentage|rate)\b/i,
    /\bwhich\s+\w+\s+(?:are|is)\s+(?:\w+\s+)*grow/i,
];

const LISTING_PATTERNS = [
    /\b(?:what\s+are|list|show|get)\s+(?:the\s+)?(?:all\s+)?(?:different|distinct|unique|various)?\s*(?:types?|kinds?|categories|values?)\s+(?:of|for|in)\b/i,
    /\b(?:list|show|display|enumerate)\s+(?:all\s+)?(?:the\s+)?(?:distinct|unique)\s/i,
    /\b(?:distinct|unique)\s+(?:values?\s+)?(?:of|for|in)\b/i,
    /\b(?:list\s+out|list|enumerate|give\s+me)\s+(?:the\s+)?(?:all\s+)?(?:id|ids|names?|numbers?)\b/i,
    /\b(?:what\s+are)\s+(?:the\s+)?(?:all\s+)?(?:different|distinct|unique|various)\s/i,
];

const DAY_OF_WEEK_PATTERNS = [
    /\bday(s)?\s+(of\s+)?(the\s+)?week\b/i,
    /\bweekday(s)?\b/i,
    /\bbusiest\s+(sales\s+)?day(s)?\b/i,
    /\bslowest\s+(sales\s+)?day(s)?\b/i,
];

const MONTH_OF_YEAR_PATTERNS = [
    /\bmonth(s)?\s+(of\s+)?(the\s+)?year\b/i,
    /\bbusiest\s+month(s)?\b/i,
    /\bslowest\s+month(s)?\b/i,
];

// ── Time Grain Detection ────────────────────────────────────────

function detectTimeGrain(q: string): string | undefined {
    const lower = q.toLowerCase();

    if (DAY_OF_WEEK_PATTERNS.some(p => p.test(lower))) return 'day_of_week';
    if (MONTH_OF_YEAR_PATTERNS.some(p => p.test(lower))) return 'month_of_year';
    if (/\b(hourly|by\s+hour|per\s+hour)\b/.test(lower)) return 'hour';
    if (/\b(daily|by\s+day|per\s+day|day\s+by\s+day)\b/.test(lower)) return 'day';
    if (/\b(weekly|by\s+week|per\s+week|week\s+by\s+week)\b/.test(lower)) return 'week';
    if (/\b(monthly|by\s+month|per\s+month|month\s+by\s+month)\b/.test(lower)) return 'month';
    if (/\b(quarterly|by\s+quarter|per\s+quarter)\b/.test(lower)) return 'quarter';
    if (/\b(yearly|annual|by\s+year|per\s+year)\b/.test(lower)) return 'year';

    return undefined;
}

// ── Sort Direction Detection ────────────────────────────────────

function detectSortDirection(q: string): 'asc' | 'desc' | undefined {
    const lower = q.toLowerCase();
    if (/\b(lowest|least|worst|bottom|smallest|fewest|minimum|slowest)\b/.test(lower)) return 'asc';
    if (/\b(highest|most|best|top|largest|biggest|greatest|maximum|busiest)\b/.test(lower)) return 'desc';
    return undefined;
}

// ── Limit Detection ─────────────────────────────────────────────

function detectLimit(q: string): number | undefined {
    const lower = q.toLowerCase();

    // "top 5", "bottom 10"
    const topNMatch = lower.match(/\b(top|bottom|first|last)\s+(\d+)\b/);
    if (topNMatch) return parseInt(topNMatch[2]);

    // "which X" → limit 1
    if (/\bwhich\s+\w+\b/.test(lower)) return 1;

    // day of week → 7
    if (DAY_OF_WEEK_PATTERNS.some(p => p.test(lower))) return 7;

    // month of year → 12
    if (MONTH_OF_YEAR_PATTERNS.some(p => p.test(lower))) return 12;

    return undefined;
}

// ── Main Classifier ─────────────────────────────────────────────

function matchPatterns(q: string, patterns: RegExp[]): number {
    return patterns.filter(p => p.test(q)).length;
}

export function classifyQuestion(question: string): ClassificationResult {
    const q = question.toLowerCase();
    const timeGrain = detectTimeGrain(question);
    const sortDir = detectSortDirection(question);
    const limit = detectLimit(question);

    const CORRELATION_PATTERNS = [
        /\b(correlation|relationship\s+between|affect|impact|associated\s+with|correlated|vs\.?|versus|compared\s+to)\b/i,
    ];

    // Score each intent
    const scores: { intent: ClassifiedIntent; score: number; reason: string }[] = [
        { intent: 'trend', score: matchPatterns(q, TREND_PATTERNS), reason: 'time-series keywords detected' },
        { intent: 'ranking', score: matchPatterns(q, RANKING_PATTERNS), reason: 'ranking/superlative keywords detected' },
        { intent: 'share_of_total', score: matchPatterns(q, SHARE_PATTERNS), reason: 'percentage/share keywords detected' },
        { intent: 'comparison', score: matchPatterns(q, COMPARISON_PATTERNS) + (isTimePeriodComparison(q) ? 1 : 0), reason: 'comparison/growth keywords detected' },
        { intent: 'single_metric', score: matchPatterns(q, SINGLE_METRIC_PATTERNS), reason: 'scalar/total keywords detected' },
        { intent: 'breakdown', score: matchPatterns(q, BREAKDOWN_PATTERNS), reason: 'dimension breakdown keywords detected' },
        { intent: 'distribution', score: matchPatterns(q, DISTRIBUTION_PATTERNS), reason: 'distribution/histogram keywords detected' },
        { intent: 'correlation', score: matchPatterns(q, CORRELATION_PATTERNS), reason: 'correlation/relationship keywords detected' },
        { intent: 'distinct_values', score: matchPatterns(q, LISTING_PATTERNS), reason: 'listing/distinct values keywords detected' },
    ];

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const second = scores[1];

    // If no patterns matched, it's ambiguous
    if (best.score === 0) {
        return {
            intent: 'ambiguous',
            confidence: 0,
            timeGrain,
            sortDirection: sortDir,
            limit,
            needsLLM: true,
            reason: 'No recognizable intent patterns found',
        };
    }

    // Special: growth_analysis (driving growth / fastest growing) → highest priority
    const growthScore = matchPatterns(q, GROWTH_ANALYSIS_PATTERNS);
    if (growthScore > 0) {
        return {
            intent: 'growth_analysis',
            confidence: Math.min(1, 0.75 + growthScore * 0.1),
            timeGrain,
            sortDirection: sortDir || 'desc',
            limit: limit || 10,
            needsLLM: true,
            reason: 'growth/decline analysis detected',
        };
    }

    // Special: aggregate_filter (above/below average) → highest priority
    const aggFilterScore = matchPatterns(q, AGGREGATE_FILTER_PATTERNS);
    if (aggFilterScore > 0) {
        return {
            intent: 'aggregate_filter',
            confidence: Math.min(1, 0.7 + aggFilterScore * 0.15),
            timeGrain,
            sortDirection: sortDir,
            limit: undefined,
            needsLLM: true,
            reason: 'above/below average comparison detected',
        };
    }

    // Confidence based on score difference
    const scoreDiff = best.score - (second?.score || 0);
    const confidence = Math.min(1, best.score * 0.3 + scoreDiff * 0.2);

    // Special: trend with time grain → high confidence
    if (best.intent === 'trend' && timeGrain && !['day_of_week', 'month_of_year'].includes(timeGrain)) {
        return {
            intent: 'trend',
            confidence: Math.max(confidence, 0.9),
            timeGrain,
            sortDirection: sortDir,
            limit: null as any,
            needsLLM: true, // Still need LLM for field mapping
            reason: best.reason,
        };
    }

    // Special: ranking with day_of_week/month_of_year → high confidence
    if (timeGrain === 'day_of_week' || timeGrain === 'month_of_year') {
        return {
            intent: 'ranking',
            confidence: 0.95,
            timeGrain,
            sortDirection: sortDir || 'desc',
            limit: limit || (timeGrain === 'day_of_week' ? 7 : 12),
            needsLLM: true,
            reason: `Cyclic grain detected: ${timeGrain}`,
        };
    }

    // If comparison patterns dominate, override to comparison
    if (best.intent === 'comparison') {
        return {
            intent: 'comparison',
            confidence: Math.max(confidence, 0.8),
            timeGrain,
            sortDirection: sortDir,
            limit,
            needsLLM: true,
            reason: best.reason,
        };
    }

    return {
        intent: best.intent,
        confidence,
        timeGrain,
        sortDirection: sortDir,
        limit,
        needsLLM: true, // Always need LLM for field mapping for now
        reason: best.reason,
    };
}
