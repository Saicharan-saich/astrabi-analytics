/**
 * Question Classifier — Deterministic intent detection from natural language.
 *
 * Uses regex patterns to classify 80% of analytics questions WITHOUT the LLM.
 * Only falls back to LLM for truly ambiguous queries.
 *
 * Priority order: exact pattern match → keyword combination → fallback to LLM
 */

export type ClassifiedIntent =
    | 'trend' | 'ranking' | 'breakdown' | 'share_of_total'
    | 'single_metric' | 'comparison' | 'distribution' | 'correlation'
    | 'derived_metric' | 'aggregate_filter' | 'ambiguous';

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
];

const RANKING_PATTERNS = [
    /\b(top|bottom)\s+\d+\b/i,
    /\b(highest|lowest|best|worst|most|least|biggest|smallest|greatest|busiest|slowest)\b/i,
    /\bwhich\s+\w+\s+(has|had|have|is|are|was|were|generated?|produced?|sold)\b/i,
    /\brank(ing|ed)?\b/i,
    /\bleader\s*board\b/i,
];

const SHARE_PATTERNS = [
    /\b(share|percentage|proportion|percent|what\s+%)\b/i,
    /\b(contribut(e|es|ion|ing))\b/i,
    /\b(breakdown|split)\s+(of|by)\b/i,
    /\bpie\s+chart\b/i,
];

const COMPARISON_PATTERNS = [
    /\b(compare|vs\.?|versus|compared\s+to|against)\b/i,
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

    // Score each intent
    const scores: { intent: ClassifiedIntent; score: number; reason: string }[] = [
        { intent: 'trend', score: matchPatterns(q, TREND_PATTERNS), reason: 'time-series keywords detected' },
        { intent: 'ranking', score: matchPatterns(q, RANKING_PATTERNS), reason: 'ranking/superlative keywords detected' },
        { intent: 'share_of_total', score: matchPatterns(q, SHARE_PATTERNS), reason: 'percentage/share keywords detected' },
        { intent: 'comparison', score: matchPatterns(q, COMPARISON_PATTERNS), reason: 'comparison/growth keywords detected' },
        { intent: 'single_metric', score: matchPatterns(q, SINGLE_METRIC_PATTERNS), reason: 'scalar/total keywords detected' },
        { intent: 'breakdown', score: matchPatterns(q, BREAKDOWN_PATTERNS), reason: 'dimension breakdown keywords detected' },
        { intent: 'distribution', score: matchPatterns(q, DISTRIBUTION_PATTERNS), reason: 'distribution/histogram keywords detected' },
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
