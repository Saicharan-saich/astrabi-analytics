/**
 * Intent Planner — Step A of the two-step LLM pipeline
 *
 * Converts a natural language question into a structured AnalysisPlan.
 * The LLM receives the semantic model (not raw schema) and outputs
 * a structured JSON plan with intent, dimensions, metrics, filters.
 *
 * The SQL is generated ONLY from this plan (Step B), not from the raw question.
 *
 * CRITICAL: After the LLM returns, a deterministic post-processing step
 * overrides aggregation based on explicit keywords in the user's question
 * (e.g., "average" → avg, "total" → sum, "count" → count).
 * This ensures the LLM can never ignore the user's explicit aggregation.
 */

import { SemanticModel, SemanticField, AnalysisPlan, AnalysisIntent } from './types';
import { serializeSemanticModel } from './semanticLayer';
import { fetchWithFallback, PRIMARY_MODEL, PLANNER_MODEL, API_KEY } from './modelConfig';
import { classifyQuestion, ClassificationResult } from './questionClassifier';
import { mapFieldsFromQuestion } from './fieldMapper';
import { validatePlan } from './planValidator';

/** Exported for UI display (shows which model family is active) */
export const MODEL = PRIMARY_MODEL;
// Planner uses the stronger (slower) PLANNER_MODEL, so allow more time than the
// old flash-only budget to avoid premature timeouts on complex questions.
const TIMEOUT_MS = 45000;

/**
 * Build the system prompt for the intent planner.
 */
function buildPlannerPrompt(model: SemanticModel): string {
    const serialized = serializeSemanticModel(model);

    return `You are an analytics planner. Given a question about a dataset, output a STRUCTURED PLAN as JSON. You do NOT write SQL — a separate engine does that. Your plan is used to choose the chart, summarise the answer, and as a fallback if the SQL engine fails.

SEMANTIC MODEL:
${serialized}

YOUR JOB: map the question's words to the exact field names above, pick the intent, and describe the shape of the answer. Downstream code independently enforces aggregation keywords and sort direction, so keep it simple and accurate.

VALID INTENTS:
- "single_metric" — one number ("what is total sales?")
- "derived_metric" — a value computed from two columns ("average length of stay")
- "breakdown" — split by a dimension ("sales by category")
- "trend" — over time ("monthly sales")
- "trend_comparison" — a time trend across two periods
- "total_comparison" — totals for two periods side by side
- "ranking" — top/bottom N ("which product sold most")
- "share_of_total" — percentages of a whole
- "correlation" — two metrics together
- "distribution" — histogram-like view
- "aggregate_filter" — entities filtered by an aggregate threshold ("products with above-average sales"; use isHaving:true with op "above_avg"/"below_avg")

KEY RULES:
- Use ONLY field names from the semantic model. Map synonyms ("revenue") to the real field.
- "average"→avg, "total"→sum, "how many"→count. "Which X had the highest/lowest Y" is a RANKING (default agg + sort direction), NOT a max/min aggregation.
- Never aggregate a date column directly. For date arithmetic (duration, length of stay, tenure) use the end-date field; the downstream engine builds the difference.
- "average daily/weekly/monthly X" → set compoundAgg "avg_per_day"/"avg_per_week"/"avg_per_month" with the matching timeGrain.
- Composite metrics: { "field": "gross_margin_pct", "agg": "none", "compositeId": "gross_margin_pct" }
- timeGrain values: day, week, month, quarter, year, day_of_week, month_of_year.
- comparison: { "type": "previous_period" | "same_period_last_year" | "custom", "mode": "trend" | "total", "grain": <timeGrain> }. YoY → same_period_last_year/year; MoM → previous_period/month; QoQ → previous_period/quarter; bare "growth"/"change" → previous_period/month.
- Date filters use the primary date column and the Time Context reference date as "today".
- Numeric ranges ("in their forties", "over 50") use the raw numeric column with between / >= / <=, not a categorical band column.
- Set "ambiguous": true with a "clarificationQuestion" ONLY if the question genuinely cannot be interpreted.
- Always set resultGrain describing what one row represents.

OUTPUT — ONLY this JSON object, no markdown, no prose:
{
  "intent": "single_metric",
  "dimensions": [],
  "metrics": [{ "field": "exact_column_name", "agg": "sum" }],
  "filters": [],
  "comparison": null,
  "sort": [],
  "limit": null,
  "ambiguous": false,
  "clarificationQuestion": null,
  "resultGrain": "one row (scalar)"
}

EXAMPLES:
Q: "Which region generated the highest revenue?"
A: { "intent": "ranking", "dimensions": [{"field":"region"}], "metrics": [{"field":"sales","agg":"sum"}], "filters": [], "sort": [{"dir":"desc"}], "limit": 1, "resultGrain": "one row per region" }

Q: "Show monthly sales trend this year"
A: { "intent": "trend", "dimensions": [{"field":"order_date","timeGrain":"month"}], "metrics": [{"field":"sales","agg":"sum"}], "filters": [{"field":"order_date","op":"between","value":["2023-01-01","2023-12-31"]}], "sort": [], "limit": null, "resultGrain": "one row per month" }

Q: "What percentage of sales does each category contribute?"
A: { "intent": "share_of_total", "dimensions": [{"field":"category"}], "metrics": [{"field":"sales","agg":"sum"}], "filters": [], "sort": [{"dir":"desc"}], "limit": null, "resultGrain": "one row per category with percentage" }

Q: "Find products with above-average sales"
A: { "intent": "aggregate_filter", "dimensions": [{"field":"product_name"}], "metrics": [{"field":"sales","agg":"sum"}], "filters": [{"field":"sales","op":"above_avg","value":null,"isHaving":true}], "sort": [{"dir":"desc"}], "limit": null, "resultGrain": "products whose SUM(sales) exceeds the average" }

Q: "MoM revenue growth"
A: { "intent": "trend", "dimensions": [{"field":"order_date","timeGrain":"month"}], "metrics": [{"field":"sales","agg":"sum"}], "filters": [], "comparison": {"type":"previous_period","mode":"trend","grain":"month"}, "sort": [], "limit": null, "resultGrain": "one row per month with growth" }

Q: "Average order value by region"
A: { "intent": "breakdown", "dimensions": [{"field":"region"}], "metrics": [{"field":"sales","agg":"avg"}], "filters": [], "sort": [], "limit": null, "resultGrain": "one row per region" }

NOTE: all date columns are stored as VARCHAR; the SQL engine handles casting, so ignore it.`;
}

/**
 * Detect the user's explicitly requested aggregation from the question text.
 * Returns the aggregation keyword or null if no explicit aggregation detected.
 * This is the CODE-LEVEL SAFETY NET that overrides the LLM.
 *
 * CRITICAL: "lowest"/"highest" in ranking context ("which X had the lowest Y")
 * are NOT aggregation overrides — they indicate SORT DIRECTION.
 * Only override to min/max when used as scalar functions ("what is the max sales").
 */
export function detectExplicitAggregation(question: string): 'avg' | 'sum' | 'count' | 'count_distinct' | 'max' | 'min' | null {
    const q = question.toLowerCase();

    // Order matters: check specific patterns first
    if (/\b(average|avg|mean)\b/.test(q)) return 'avg';

    // "how many DISTINCT/UNIQUE customers", "number of unique items", "count of
    // distinct servers" → COUNT(DISTINCT entity), not COUNT(*). Must come before
    // the generic "how many → count" rule below.
    if (/\b(distinct|unique|different)\b/.test(q) && /\b(how many|number of|count of|count|distinct count)\b/.test(q)) {
        return 'count_distinct';
    }

    // "total orders", "total customers", "total transactions" → COUNT, not SUM
    // These are count-like nouns where "total" means "how many" not "sum of"
    if (/\b(total|number of)\s+(orders|customers|products|items|transactions|records|employees|users|entries|shipments|returns|invoices|tickets|accounts|contracts|deals|leads|contacts)\b/.test(q)) return 'count';

    // "total sales", "total revenue", "total profit" → SUM
    if (/\b(total|sum|overall|combined|aggregate)\b/.test(q)) return 'sum';
    if (/\b(count of|how many|number of|count distinct)\b/.test(q)) return 'count';

    // For min/max: ONLY apply when used as a scalar aggregation function,
    // NOT when used in ranking context ("which day this week had the lowest/highest").
    // Note: [\\w\\s]+? matches multiple words (e.g., "day this week")
    const isRankingContext = /\b(which|what)[\w\s]+?(had|has|have|with|got)\s+(the\s+)?(lowest|highest|most|least|best|worst|top|bottom)\b/.test(q)
        || /\b(which|what)[\w\s]+?(lowest|highest|most|least|best|worst|top|bottom)\b/.test(q)
        || /\b(lowest|highest|most|least|best|worst|top|bottom)[\w\s]+?(day|week|month|product|category|region|customer|item|store)\b/.test(q);

    if (!isRankingContext) {
        if (/\b(max|maximum|oldest|latest|newest)\b/.test(q)) return 'max';
        if (/\b(min|minimum|youngest|earliest)\b/.test(q)) return 'min';
        // "highest" and "lowest" only map to max/min in non-ranking context
        if (/\b(highest|largest|biggest)\b/.test(q)) return 'max';
        if (/\b(lowest|smallest)\b/.test(q)) return 'min';
    }

    return null;
}

/**
 * Detect ranking sort direction from the question.
 * "lowest" / "least" / "worst" / "bottom" → ascending sort
 * "highest" / "most" / "best" / "top" → descending sort
 * Returns null if no ranking direction detected.
 */
export function detectRankingDirection(question: string): 'asc' | 'desc' | null {
    const q = question.toLowerCase();
    // Compound phrases FIRST — "highest to lowest" contains both words, and the
    // ORDER (high→low = desc) is what matters, not which word appears.
    if (/\b(highest|high|most|largest|biggest|greatest|top)\s+to\s+(lowest|low|least|smallest|bottom)\b/.test(q)
        || /\bdescending\b/.test(q) || /\bhigh\s+to\s+low\b/.test(q)) return 'desc';
    if (/\b(lowest|low|least|smallest|bottom)\s+to\s+(highest|high|most|largest|top)\b/.test(q)
        || /\bascending\b/.test(q) || /\blow\s+to\s+high\b/.test(q)) return 'asc';
    // Single-word superlatives.
    if (/\b(lowest|least|worst|bottom|smallest|fewest|minimum)\b/.test(q)) return 'asc';
    if (/\b(highest|most|best|top|largest|biggest|greatest|maximum)\b/.test(q)) return 'desc';
    return null;
}

/**
 * When a question asks for a cyclic calendar dimension (day of the week) and the
 * dataset already HAS that column (e.g. "DayOfWeek"), group by that column
 * directly — do NOT derive it from the date column or apply a time-period
 * filter. "Day of the week" is a category, not "this week".
 */
export function enforceNativeCyclicDimension(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();
    if (!/\bday(s)?\s+of\s+(the\s+)?week\b|\bweekday\b/.test(q)) return;

    const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, '');
    const dowField = model.fields.find(f => ['dayofweek', 'weekday', 'dayoftheweek'].includes(norm(f.name)));
    if (!dowField) return;

    // Force the native day-of-week column as the sole grouping dimension.
    plan.dimensions = [{ field: dowField.name } as any];
    // Strip any date-column filters — a cyclic category isn't a date range.
    plan.filters = (plan.filters || []).filter(f => {
        const ff = model.fields.find(x => x.name.toLowerCase() === String(f.field).toLowerCase());
        return !(ff && ff.semanticType === 'date');
    });
    console.log(`[Intent Planner] Native day-of-week column enforced: ${dowField.name}`);
}

/**
 * Detect compound average pattern.
 * ONLY triggers for EXPLICIT compound phrases where the user clearly wants
 * AVG of a per-period SUM, e.g.:
 *   - "average of daily total sales"
 *   - "mean total sales per day"
 *   - "average sum per week"
 *   - "avg of total daily revenue"
 *
 * Does NOT trigger for simple phrases like:
 *   - "average daily sales" → this means AVG(sales) with a date filter
 *   - "average monthly profit" → this means AVG(profit) filtered to a month
 */
function detectCompoundAverage(question: string): 'day' | 'week' | 'month' | 'quarter' | 'year' | null {
    const q = question.toLowerCase();

    // Only match explicit compound patterns:
    // "average of daily total X", "avg of total daily X", "mean total X per day"
    if (/\b(average|avg|mean)\s+(of\s+)?(total|sum|summed)\s+(daily|per\s+day)\b/.test(q)) return 'day';
    if (/\b(average|avg|mean)\s+(of\s+)?(daily|per\s+day)\s+(total|sum)\b/.test(q)) return 'day';
    if (/\b(average|avg|mean)\s+(of\s+)?(total|sum|summed)\s+(weekly|per\s+week)\b/.test(q)) return 'week';
    if (/\b(average|avg|mean)\s+(of\s+)?(weekly|per\s+week)\s+(total|sum)\b/.test(q)) return 'week';
    if (/\b(average|avg|mean)\s+(of\s+)?(total|sum|summed)\s+(monthly|per\s+month)\b/.test(q)) return 'month';
    if (/\b(average|avg|mean)\s+(of\s+)?(monthly|per\s+month)\s+(total|sum)\b/.test(q)) return 'month';
    if (/\b(average|avg|mean)\s+(of\s+)?(total|sum|summed)\s+(quarterly|per\s+quarter)\b/.test(q)) return 'quarter';
    if (/\b(average|avg|mean)\s+(of\s+)?(total|sum|summed)\s+(yearly|annual|per\s+year)\b/.test(q)) return 'year';

    return null;
}

/**
 * Detect explicit "this [period]" modifiers in the question
 * to guarantee filters are applied even if the LLM misses them.
 */
function detectCurrentPeriod(question: string): 'year' | 'quarter' | 'month' | 'week' | 'day' | null {
    const q = question.toLowerCase();
    if (/\b(this|current)\s+year\b/.test(q)) return 'year';
    if (/\b(this|current)\s+quarter\b/.test(q)) return 'quarter';
    if (/\b(this|current)\s+month\b/.test(q)) return 'month';
    if (/\b(this|current)\s+week\b/.test(q)) return 'week';
    if (/\b(today|this\s+day)\b/.test(q)) return 'day';
    return null;
}

/**
 * Detect "day of week" / "month of year" patterns in the question.
 * The LLM often misclassifies these as plain "day" or "month" grains.
 * This deterministic detector forcefully corrects timeGrain.
 *
 * Patterns detected:
 *   - "days of the week", "by day of week", "busiest day", "which weekday"
 *   - "months of the year", "busiest month", "by month of year"
 */
function enforceCyclicGrain(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // ── Day-of-week detection ──
    const isDayOfWeek =
        /\bday(s)?\s+(of\s+)?(the\s+)?week\b/.test(q) ||
        /\bweekday(s)?\b/.test(q) ||
        /\bbusiest\s+(sales\s+)?day(s)?\b/.test(q) ||
        /\bslowest\s+(sales\s+)?day(s)?\b/.test(q) ||
        /\bby\s+day\s+of\s+week\b/.test(q) ||
        /\bwhich\s+day\b/.test(q) && /\bweek\b/.test(q);

    if (isDayOfWeek) {
        const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
            || model.timeContext?.primaryDateColumn
            || 'order_date';

        // Find existing time dimension and override its grain
        const timeDim = plan.dimensions.find(d => (d as any).timeGrain);
        if (timeDim) {
            console.log(`[Intent Planner] Day-of-week override: timeGrain "${(timeDim as any).timeGrain}" → "day_of_week"`);
            (timeDim as any).timeGrain = 'day_of_week';
        } else {
            // No time dimension — inject one
            plan.dimensions = [{ field: dateField, timeGrain: 'day_of_week' } as any];
            console.log(`[Intent Planner] Day-of-week override: injected dimension ${dateField} with grain day_of_week`);
        }

        // Set limit to 7 (7 days in a week) if not already set
        if (!plan.limit || plan.limit > 7) {
            plan.limit = 7;
        }
        return;
    }

    // ── Month-of-year detection ──
    const isMonthOfYear =
        /\bmonth(s)?\s+(of\s+)?(the\s+)?year\b/.test(q) ||
        /\bbusiest\s+month(s)?\b/.test(q) ||
        /\bslowest\s+month(s)?\b/.test(q) ||
        /\bby\s+month\s+of\s+year\b/.test(q);

    if (isMonthOfYear) {
        const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
            || model.timeContext?.primaryDateColumn
            || 'order_date';

        const timeDim = plan.dimensions.find(d => (d as any).timeGrain);
        if (timeDim) {
            console.log(`[Intent Planner] Month-of-year override: timeGrain "${(timeDim as any).timeGrain}" → "month_of_year"`);
            (timeDim as any).timeGrain = 'month_of_year';
        } else {
            plan.dimensions = [{ field: dateField, timeGrain: 'month_of_year' } as any];
            console.log(`[Intent Planner] Month-of-year override: injected dimension ${dateField} with grain month_of_year`);
        }

        if (!plan.limit || plan.limit > 12) {
            plan.limit = 12;
        }
    }
}

/**
 * Deterministic intent override based on keywords.
 * Catches cases where the LLM picks the wrong intent type.
 */
function enforceIntentFromKeywords(plan: AnalysisPlan, question: string): void {
    const q = question.toLowerCase();

    // ── "trend" / "over time" → force trend intent if there's a time dimension ──
    if (/\b(trend|over\s+time|over\s+the\s+(past|last)|timeline)\b/.test(q)) {
        const hasTimeDim = plan.dimensions.some(d => (d as any).timeGrain);
        if (hasTimeDim && plan.intent !== 'trend' && plan.intent !== 'trend_comparison') {
            console.log(`[Intent Planner] Intent override: "${plan.intent}" → "trend" (keyword: trend/over time)`);
            plan.intent = 'trend';
            plan.limit = null;
        }
    }

    // ── "share" / "percentage" / "proportion" → force share_of_total ──
    if (/\b(share|percentage|proportion|percent|what\s+%|contribut)\b/.test(q) &&
        !/\b(growth|change|trend)\b/.test(q)) {
        if (plan.intent !== 'share_of_total') {
            console.log(`[Intent Planner] Intent override: "${plan.intent}" → "share_of_total" (keyword: share/percentage)`);
            plan.intent = 'share_of_total';
        }
    }

    // ── "top N" / "bottom N" extraction → enforce limit ──
    const topNMatch = q.match(/\b(top|bottom|first|last)\s+(\d+)\b/);
    if (topNMatch) {
        const n = parseInt(topNMatch[2]);
        if (n > 0 && n <= 100) {
            if (plan.limit !== n) {
                console.log(`[Intent Planner] Limit override: ${plan.limit} → ${n} (detected "${topNMatch[0]}")`);
                plan.limit = n;
            }
            if (plan.intent !== 'ranking') {
                plan.intent = 'ranking';
            }
            if (topNMatch[1] === 'bottom' || topNMatch[1] === 'last') {
                const sortField = plan.metrics.length > 0 ? plan.metrics[0].field : '';
                plan.sort = plan.sort.length > 0
                    ? plan.sort.map(s => ({ ...s, dir: 'asc' as const }))
                    : [{ field: sortField, dir: 'asc' as const }];
            } else {
                const sortField = plan.metrics.length > 0 ? plan.metrics[0].field : '';
                plan.sort = plan.sort.length > 0
                    ? plan.sort.map(s => ({ ...s, dir: 'desc' as const }))
                    : [{ field: sortField, dir: 'desc' as const }];
            }
        }
    }

    // ── "distribution" / "histogram" → force distribution intent ──
    if (/\b(distribution|histogram|spread|frequency)\b/.test(q)) {
        if (plan.intent !== 'distribution') {
            console.log(`[Intent Planner] Intent override: "${plan.intent}" → "distribution" (keyword: distribution)`);
            plan.intent = 'distribution';
        }
    }
}

/**
 * Deterministic composite metric enforcement.
 * When the user asks about a known business KPI (profit margin, AOV, etc.),
 * force the plan to use the governed composite metric formula instead of
 * letting the LLM build its own (often incorrect) formula.
 *
 * This ensures weighted formulas like SUM(profit)/SUM(sales) are used
 * instead of AVG(profit/sales) which gives misleading results.
 */
export function enforceCompositeMetrics(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // Map of keyword patterns → composite metric IDs.
    // ORDER MATTERS: more specific patterns first (e.g. "revenue per customer"
    // must win over the generic "revenue" → computed_revenue at the end).
    const compositePatterns: { pattern: RegExp; metricId: string }[] = [
        { pattern: /\b(profit\s+margin|net\s+margin|profit\s+pct|margin\s+%|profit\s+percentage)\b/, metricId: 'net_profit_margin_pct' },
        { pattern: /\b(gross\s+margin|markup|margin\s+percent)\b/, metricId: 'gross_margin_pct' },
        { pattern: /\b(aov|average\s+order\s+value|avg\s+order|order\s+average)\b/, metricId: 'avg_order_value' },
        { pattern: /\b(items?\s+per\s+order|basket\s+size|order\s+size)\b/, metricId: 'avg_items_per_order' },
        { pattern: /\b(revenue\s+per\s+customer|arpu|ltv|clv|customer\s+value|per\s+customer\s+revenue)\b/, metricId: 'revenue_per_customer' },
        { pattern: /\b(discount\s+rate|markdown\s+rate|discount\s+pct|discount\s+percentage)\b/, metricId: 'discount_rate' },
        // Generic revenue → price × quantity, only when the model actually has the
        // computed_revenue composite (i.e. price + quantity but no revenue column).
        { pattern: /\b(revenue|total\s+sales|turnover|gmv|gross\s+revenue|sales\s+value)\b/, metricId: 'computed_revenue' },
    ];

    for (const { pattern, metricId } of compositePatterns) {
        if (pattern.test(q)) {
            // Check if this composite metric exists in the model
            const composite = model.compositeMetrics.find(m => m.id === metricId);
            if (!composite) continue;

            // Check if the plan already uses this composite
            const alreadyUsed = plan.metrics.some(m => m.compositeId === metricId);
            if (alreadyUsed) continue;

            // Replace all metrics with the governed composite metric
            console.log(`[Intent Planner] Composite override: forcing "${metricId}" (weighted formula: ${composite.formula})`);
            plan.metrics = [{
                field: composite.dependsOn[0],
                agg: 'sum', // Ignored for composite, but required by type
                compositeId: metricId,
            }];
            break;
        }
    }
}

/**
 * Detect growth/decline analysis patterns and force growth_analysis intent.
 * "Which products are driving revenue growth?" → growth_analysis
 * "Fastest growing categories" → growth_analysis
 * "Products with biggest sales decline" → growth_analysis (sort ASC)
 *
 * MUST run BEFORE enforceComparison to intercept "growth" keyword
 * that would otherwise trigger trend_comparison.
 */
function enforceGrowthAnalysis(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    // Already growth_analysis — nothing to do
    if (plan.intent === 'growth_analysis') return;

    const q = question.toLowerCase();

    // Growth analysis patterns
    const growthPatterns = [
        /\b(driving|drove)\s+(?:\w+\s+)*(?:revenue|sales|profit)?\s*growth\b/,
        /\bcontribut\w+\s+(?:\w+\s+)*(?:to\s+)?(?:revenue|sales|profit)?\s*growth\b/,
        /\b(grow(?:ing|n|th)|grew)\s+(?:the\s+)?(fastest|most|slowest|least)\b/,
        /\b(largest|biggest|smallest|highest|lowest)\s+(increase|decrease|decline|drop|gain|growth)\b/,
        /\b(growth|decline)\s+(contribut|driver|leader)\b/,
        /\b(revenue|sales|profit)\s+growth\s+by\s+(product|category|region|segment)\b/,
        /\bfastest\s+grow(ing|th)\b/,
        /\b(increase|decrease|growth|decline)\s+(%|percent|percentage|rate)\b/,
        /\bwhich\s+\w+\s+(?:are|is)\s+(?:\w+\s+)*grow/,
    ];

    const isGrowth = growthPatterns.some(p => p.test(q));
    if (!isGrowth) return;

    // Must have at least one dimension to rank entities by growth
    if (plan.dimensions.length === 0) {
        // Try to infer a dimension from the question
        const dimKeywords: Record<string, string> = {
            'product': 'product_name',
            'category': 'category',
            'region': 'region',
            'segment': 'segment',
            'customer': 'customer_name',
            'city': 'city',
            'state': 'state',
            'country': 'country',
            'sub.category': 'sub_category',
        };
        for (const [keyword, fieldName] of Object.entries(dimKeywords)) {
            if (q.includes(keyword)) {
                const field = model.fields.find(f =>
                    f.name.toLowerCase() === fieldName ||
                    f.name.toLowerCase().replace(/[_-]/g, '') === fieldName.replace(/[_-]/g, '')
                );
                if (field) {
                    plan.dimensions.push({ field: field.name });
                    break;
                }
            }
        }
        // If still no dimension, pick the first non-date dimension
        if (plan.dimensions.length === 0) {
            const defaultDim = model.fields.find(f => f.role === 'dimension' && f.semanticType !== 'date');
            if (defaultDim) {
                plan.dimensions.push({ field: defaultDim.name });
            }
        }
    }

    // Must have at least one metric
    if (plan.metrics.length === 0) {
        // Infer from question
        const metricKeywords: Record<string, string> = {
            'revenue': 'sales', 'sales': 'sales', 'profit': 'profit', 'quantity': 'quantity',
        };
        for (const [keyword, fieldName] of Object.entries(metricKeywords)) {
            if (q.includes(keyword)) {
                const field = model.fields.find(f => f.name.toLowerCase() === fieldName);
                if (field) {
                    plan.metrics.push({ field: field.name, agg: (field.defaultAgg === 'none' ? 'sum' : field.defaultAgg) || 'sum' });
                    break;
                }
            }
        }
        // Default to first metric
        if (plan.metrics.length === 0) {
            const defaultMetric = model.fields.find(f => f.role === 'metric');
            if (defaultMetric) {
                plan.metrics.push({ field: defaultMetric.name, agg: (defaultMetric.defaultAgg === 'none' ? 'sum' : defaultMetric.defaultAgg) || 'sum' });
            }
        }
    }

    console.log(`[Intent Planner] Growth analysis detected: "${plan.intent}" → "growth_analysis"`);
    plan.intent = 'growth_analysis';

    // Detect decline direction
    const sortField = plan.metrics.length > 0 ? plan.metrics[0].field : 'growth_pct';
    if (/\b(decline|decrease|drop|slowest|least|worst|bottom|lowest)\b/.test(q)) {
        plan.sort = [{ field: sortField, dir: 'asc' }];
    } else {
        plan.sort = [{ field: sortField, dir: 'desc' }];
    }

    // Remove limit for growth analysis (show all entities by default)
    plan.limit = plan.limit || 10;
}

/**
 * Detect plural nouns in ranking queries to set a sensible limit.
 * "Which products..." (plural) → top 5
 * "Which product..." (singular) → top 1
 */
function enforcePluralLimit(plan: AnalysisPlan, question: string): void {
    if (plan.intent !== 'ranking') return;
    if (plan.limit && plan.limit > 1) return; // Already has a reasonable limit

    const q = question.toLowerCase();

    // Detect plural nouns after "which" or at the start
    const pluralPattern = /\b(which|what(?: are)?|show|list)\s+(?:the\s+)?(?:top|best|worst|busiest)?\s*(products|categories|regions|customers|items|orders|segments|states|cities|departments|stores|brands|employees|months|days|years)\b/;
    const match = pluralPattern.test(q);

    if (match && (!plan.limit || plan.limit === 1)) {
        console.log(`[Intent Planner] Plural noun detected → limit changed from ${plan.limit} to 5`);
        plan.limit = 5;
    }
}

/**
 * Detect "above average" / "below average" aggregate comparison patterns.
 * Converts the plan to aggregate_filter intent with HAVING-based filters.
 *
 * Handles multi-condition patterns like:
 *   "products with above-average sales but below-average profit margin"
 *
 * Maps KPI keywords (margin, AOV) to composite metric refs so HAVING
 * uses the governed weighted formula, not raw field comparison.
 */
function enforceAggregateFilter(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // Detect "above/below average" patterns
    const aboveAvgPattern = /\b(above|over|exceed(?:ing|s)?|greater\s+than|higher\s+than|more\s+than)\s*(?:the\s+)?(?:average|avg|mean)\b/;
    const belowAvgPattern = /\b(below|under|less\s+than|lower\s+than|beneath)\s*(?:the\s+)?(?:average|avg|mean)\b/;

    const hasAbove = aboveAvgPattern.test(q);
    const hasBelow = belowAvgPattern.test(q);

    if (!hasAbove && !hasBelow) return;

    console.log(`[Intent Planner] Aggregate filter detected: above=${hasAbove}, below=${hasBelow}`);

    // Force intent to aggregate_filter
    plan.intent = 'aggregate_filter';

    // Remove any existing limit (we want ALL matching entities)
    plan.limit = null;

    // KPI keyword → composite metric mapping
    const kpiPatterns: { pattern: RegExp; compositeId: string; fieldHint: string }[] = [
        { pattern: /\b(profit\s+margin|net\s+margin|margin\s*%?)\b/, compositeId: 'net_profit_margin_pct', fieldHint: 'profit' },
        { pattern: /\b(gross\s+margin|markup)\b/, compositeId: 'gross_margin_pct', fieldHint: 'sales' },
        { pattern: /\b(aov|average\s+order\s+value|order\s+value)\b/, compositeId: 'avg_order_value', fieldHint: 'sales' },
        { pattern: /\b(discount\s+rate|markdown)\b/, compositeId: 'discount_rate', fieldHint: 'discount' },
        { pattern: /\b(revenue\s+per\s+customer|arpu|clv|ltv)\b/, compositeId: 'revenue_per_customer', fieldHint: 'sales' },
    ];

    // Parse the question to find WHAT should be above/below average
    // Strategy: split the question by "but"/"and" to handle multi-condition
    const clauses = q.split(/\s+(?:but|and)\s+/);

    // Remove existing HAVING filters to rebuild them
    plan.filters = plan.filters.filter(f => !f.isHaving && !['above_avg', 'below_avg'].includes(f.op));

    for (const clause of clauses) {
        const isAbove = aboveAvgPattern.test(clause);
        const isBelow = belowAvgPattern.test(clause);
        if (!isAbove && !isBelow) continue;

        const op: 'above_avg' | 'below_avg' = isAbove ? 'above_avg' : 'below_avg';

        // Check if this clause refers to a KPI (composite metric)
        let matched = false;
        for (const { pattern, compositeId, fieldHint } of kpiPatterns) {
            if (pattern.test(clause)) {
                // Verify the composite metric exists in the model
                const composite = model.compositeMetrics.find(m => m.id === compositeId);
                if (composite) {
                    plan.filters.push({
                        field: fieldHint,
                        op,
                        value: null,
                        compositeRef: compositeId,
                        isHaving: true,
                    });

                    // Ensure the composite metric is in the plan's metrics (for SELECT)
                    if (!plan.metrics.some(m => m.compositeId === compositeId)) {
                        plan.metrics.push({
                            field: composite.dependsOn[0],
                            agg: 'sum',
                            compositeId: compositeId,
                        });
                    }

                    console.log(`[Intent Planner] HAVING: ${compositeId} ${op} (weighted formula: ${composite.formula})`);
                    matched = true;
                    break;
                }
            }
        }

        if (!matched) {
            // Not a KPI — try to match against a raw metric field
            // Find which metric field the clause refers to
            const metricFields = model.fields.filter(f => f.role === 'metric');
            let bestField: string | null = null;
            let bestScore = 0;

            for (const mf of metricFields) {
                const nameWords = [mf.name, mf.displayLabel || '', ...(mf.synonyms || [])].map(s => s.toLowerCase());
                for (const w of nameWords) {
                    if (w && clause.includes(w) && w.length > bestScore) {
                        bestField = mf.name;
                        bestScore = w.length;
                    }
                }
            }

            if (bestField) {
                plan.filters.push({
                    field: bestField,
                    op,
                    value: null,
                    isHaving: true,
                });

                // Ensure this metric is in the plan's metrics
                if (!plan.metrics.some(m => m.field.toLowerCase() === bestField!.toLowerCase())) {
                    plan.metrics.push({ field: bestField, agg: 'sum' });
                }

                console.log(`[Intent Planner] HAVING: ${bestField} ${op}`);
            }
        }
    }

    // Verify we have at least one HAVING filter
    const havingFilters = plan.filters.filter(f => f.isHaving);
    if (havingFilters.length === 0) {
        console.warn('[Intent Planner] aggregate_filter detected but no HAVING filters could be built. Falling back.');
        plan.intent = 'breakdown';
    } else {
        console.log(`[Intent Planner] aggregate_filter: ${havingFilters.length} HAVING condition(s) set`);
    }
}

/**
 * Post-process the plan to enforce aggregation correctness.
 * This is the CODE-LEVEL OVERRIDE that runs AFTER the LLM.
 * Even if the LLM returns "sum" when the user said "average",
 * this function forcefully corrects it.
 */
/**
 * COUNT questions count ENTITIES (rows), not a numeric field that merely appears
 * as a FILTER. "count of male patients whose age is above 50" means COUNT(*) with
 * gender/age as filters — it must NEVER become SUM(age). This is the single most
 * important correction for count-style questions.
 *
 * Rewrites the plan's metric to COUNT(*) (or COUNT(DISTINCT <dimension>) when the
 * user explicitly asks for distinct values of a categorical entity that isn't a
 * filter). Returns true when it rewrote the metric. Exported for testing.
 */
/**
 * Resolve the entity noun in a "distinct/unique <noun>" question to a model
 * field — e.g. "distinct customers" → customer_id, "unique servers" → server_name.
 * Prefers an identifier column so COUNT(DISTINCT) counts entities, not attributes.
 */
function resolveDistinctEntityField(question: string, model: SemanticModel): string | null {
    const m = question.toLowerCase().match(/\b(?:distinct|unique|different)\s+([a-z][a-z_]*)/);
    if (!m) return null;
    const noun = m[1].replace(/s$/, ''); // customers → customer, items → item
    if (noun.length < 3) return null;
    const candidates = model.fields.filter(f => {
        const n = f.name.toLowerCase();
        return n.includes(noun) || (f.synonyms || []).some(s => s.toLowerCase().includes(noun));
    });
    if (candidates.length === 0) return null;
    // Prefer an identifier / *_id column, else the first match.
    const idField = candidates.find(f => f.semanticType === 'identifier' || f.name.toLowerCase().endsWith('_id'));
    return (idField || candidates[0]).name;
}

export function applyCountSemantics(
    explicitAgg: string | null,
    plan: AnalysisPlan,
    model: SemanticModel,
    question = '',
): boolean {
    if (explicitAgg !== 'count' && explicitAgg !== 'count_distinct') return false;
    const filterFields = new Set((plan.filters || []).map(f => String(f.field).toLowerCase()));
    const primary = plan.metrics.find(m => !(m as any).compositeId);
    const pf = primary ? model.fields.find(f => f.name.toLowerCase() === String(primary.field).toLowerCase()) : undefined;

    if (explicitAgg === 'count_distinct') {
        // 1) The plan already targets a categorical entity that isn't a filter.
        if (pf && pf.role !== 'metric' && !filterFields.has(String(primary!.field).toLowerCase())) {
            plan.metrics = [{ field: primary!.field, agg: 'count_distinct' } as any];
            return true;
        }
        // 2) Resolve the entity from the question ("distinct customers" → customer_id).
        const entity = resolveDistinctEntityField(question, model);
        if (entity) {
            plan.metrics = [{ field: entity, agg: 'count_distinct' } as any];
            return true;
        }
        // else fall through to COUNT(*) — nothing sensible to distinct-count.
    }

    // Plain count → count rows. A numeric field used as a filter (age) is
    // never the count target.
    plan.metrics = [{ field: '*', agg: 'count' } as any];
    return true;
}

/**
 * Over-grouping guard. The field mapper sometimes adds an IDENTIFIER (order_id)
 * or a RAW date column (order_date, no grain) to the GROUP BY of an aggregated
 * query — which collapses the aggregation to one row per record. Example:
 * "which time of day has the highest average order value" was grouped by
 * time_of_day + order_date + order_id, returning a single order.
 *
 * When an aggregated query has >1 grouping dimension and at least one is an
 * id / raw-date column while a genuine categorical dimension remains, drop the
 * id/raw-date dimensions. A date WITH a time grain (monthly, weekly) is kept —
 * that's an intentional time breakdown.
 */
export function enforceAggregationGrain(plan: AnalysisPlan, model: SemanticModel): void {
    if (plan.dimensions.length <= 1) return;
    if (!plan.metrics.some(m => m.agg && (m.agg as string) !== 'none')) return;

    const keep = plan.dimensions.filter(d => {
        const f = model.fields.find(x => x.name.toLowerCase() === String(d.field).toLowerCase());
        if (!f) return true; // unknown column — leave it
        const isId = f.semanticType === 'identifier' || f.name.toLowerCase().endsWith('_id');
        const isRawDate = f.semanticType === 'date' && !(d as any).timeGrain;
        return !isId && !isRawDate;
    });

    if (keep.length >= 1 && keep.length < plan.dimensions.length) {
        console.log(`[Intent Planner] Aggregation grain: dropped ${plan.dimensions.length - keep.length} id/raw-date dimension(s), kept [${keep.map(d => d.field).join(', ')}]`);
        plan.dimensions = keep;
    }
}

function enforceAggregation(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const explicitAgg = detectExplicitAggregation(question);
    const compoundGrain = detectCompoundAverage(question);
    const rankDir = detectRankingDirection(question);

    // Handle ranking direction: enforce sort + limit for ranking queries
    if (rankDir && (plan.intent === 'ranking' || plan.intent === 'breakdown')) {
        console.log(`[Intent Planner] Detected ranking direction: ${rankDir}`);

        // Ensure the plan has ranking intent
        plan.intent = 'ranking';

        // Ensure sort by first metric in the correct direction
        if (plan.metrics.length > 0) {
            const metField = plan.metrics[0].field;
            const metAlias = plan.metrics[0].compositeId || `${metField}_${plan.metrics[0].agg}`;
            // Replace sort with the correct direction
            plan.sort = [{ field: metField, dir: rankDir }];
        }

        // Ensure limit is set (default to 1 for "which day" style questions)
        if (!plan.limit) {
            const q = question.toLowerCase();
            // "top 5", "bottom 3", etc.
            const topNMatch = q.match(/\b(top|bottom)\s+(\d+)\b/);
            plan.limit = topNMatch ? parseInt(topNMatch[2]) : 1;
        }

        // Do NOT override aggregation for rankings — use the field's default
        // (e.g., "lowest sales" should be SUM(sales) sorted ASC, not MIN(sales))
        // Block min/max overrides in ranking context — they are sort direction, not agg
        if (!explicitAgg || explicitAgg === 'min' || explicitAgg === 'max') return;
    }

    if (!explicitAgg) return; // User didn't specify — keep LLM's choice

    console.log(`[Intent Planner] Detected explicit aggregation: "${explicitAgg}" from question`);

    // COUNT questions count rows/entities — handle before the generic override so
    // "count of patients whose age > 50" becomes COUNT(*), never SUM(age).
    if (applyCountSemantics(explicitAgg, plan, model, question)) {
        console.log('[Intent Planner] COUNT question → COUNT(*) of rows (a filter/attribute is never the count target)');
        return;
    }

    // Override all metric aggregations to match the user's explicit request
    for (const met of plan.metrics) {
        if (met.compositeId) continue; // Don't override composite metrics

        if (met.agg !== explicitAgg) {
            console.log(`[Intent Planner] OVERRIDE: "${met.field}" agg changed from "${met.agg}" → "${explicitAgg}"`);
            met.agg = explicitAgg;
        }
    }

    // Handle compound average ONLY for very explicit patterns
    // e.g., "average of total daily sales" (NOT "average daily sales")
    if (compoundGrain && explicitAgg === 'avg') {
        console.log(`[Intent Planner] Detected EXPLICIT compound average: avg of ${compoundGrain} totals`);

        // Mark each metric with compoundAgg
        for (const met of plan.metrics) {
            if (met.compositeId) continue;
            (met as any).compoundAgg = `avg_per_${compoundGrain}`;
        }

        // Ensure the primary date field is included as a dimension with the correct grain
        const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
        if (dateField) {
            const hasDateDimension = plan.dimensions.some(d =>
                d.field.toLowerCase() === dateField.name.toLowerCase()
            );
            if (!hasDateDimension) {
                plan.dimensions.push({ field: dateField.name, timeGrain: compoundGrain });
            }
        }
    }
}

/**
 * Forcefully inject or normalize date filters if the user said "this month", "this year", etc.
 * 1. If the LLM missed the filter entirely, inject it.
 * 2. If the LLM used "this_month" as the operator, normalize it to "between" with strict dates.
 */
function enforceTimeContext(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const periodFromQuestion = detectCurrentPeriod(question);

    // Find the primary date field
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
        || model.timeContext?.primaryDateColumn
        || 'order_date';

    // Check if a filter already exists that is using a "this_X" operator
    const existingThisFilter = plan.filters.find(f => f.op && f.op.startsWith('this_'));

    const period = existingThisFilter
        ? existingThisFilter.op.replace('this_', '') // 'month', 'year', etc.
        : periodFromQuestion;

    if (!period) return;

    // Check if a proper 'between' filter already exists for this field
    const hasProperFilter = plan.filters.some(f =>
        f.field.toLowerCase() === dateField.toLowerCase() && f.op === 'between'
    );

    if (hasProperFilter && !existingThisFilter) return;

    if (!existingThisFilter && !hasProperFilter) {
        console.log(`[Intent Planner] Detected missing "${period}" filter from question! Injecting safety net filter.`);
    } else if (existingThisFilter) {
        console.log(`[Intent Planner] Normalizing operator "${existingThisFilter.op}" to "between".`);
    }

    // Use the dataset's anchor date as "today" (or default to current system date)
    const anchorData = model.timeContext?.anchorDate ? new Date(model.timeContext.anchorDate) : new Date();

    // Compute the start and end of the requested period
    let start: Date, end: Date;

    if (period === 'year') {
        start = new Date(anchorData.getFullYear(), 0, 1);
        end = new Date(anchorData.getFullYear(), 11, 31);
    } else if (period === 'month') {
        start = new Date(anchorData.getFullYear(), anchorData.getMonth(), 1);
        end = new Date(anchorData.getFullYear(), anchorData.getMonth() + 1, 0); // Last day of month
    } else if (period === 'week') {
        // Assume week starts on Sunday
        const day = anchorData.getDay();
        const diff = anchorData.getDate() - day;
        start = new Date(anchorData.getFullYear(), anchorData.getMonth(), diff);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
    } else if (period === 'quarter') {
        const q = Math.floor(anchorData.getMonth() / 3);
        start = new Date(anchorData.getFullYear(), q * 3, 1);
        end = new Date(anchorData.getFullYear(), q * 3 + 3, 0);
    } else { // day
        start = new Date(anchorData);
        end = new Date(anchorData);
    }

    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    if (existingThisFilter) {
        existingThisFilter.op = 'between';
        existingThisFilter.value = [startStr, endStr];
    } else if (!hasProperFilter) {
        plan.filters.push({
            field: dateField,
            op: 'between',
            value: [startStr, endStr]
        });
    }

    console.log(`[Intent Planner] Date filter applied: ${dateField} BETWEEN ${startStr} AND ${endStr}`);
}

/**
 * CODE-LEVEL COMPARISON DETECTION.
 * If the user's question contains comparison language ("vs", "compare",
 * "same day last week", etc.) but the LLM classified it as single_metric
 * or breakdown, forcefully upgrade the intent to total_comparison or
 * trend_comparison and inject the comparison metadata.
 */
function enforceComparison(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // Already a comparison or growth_analysis — nothing to do
    if (plan.comparison || plan.intent === 'total_comparison' || plan.intent === 'trend_comparison' || plan.intent === 'growth_analysis') return;

    // Detect comparison patterns in the question
    const comparisonPatterns = [
        /\bcompare\s+(to|with|against)\b/,
        /\bvs\.?\b/,
        /\bversus\b/,
        /\bcompared\s+to\b/,
        /\bhow\s+do(?:es)?\s+.+\s+compare\b/,
        /\bsame\s+(day|week|month|quarter)\s+last\s+(week|month|quarter|year)\b/,
        /\bthis\s+(week|month|quarter|year)\s+vs\b/,
        /\blast\s+(week|month|quarter|year)\s+vs\b/,
        /\bthis\s+(\w+)\s+(vs\.?|versus|compared\s+to|against)\s+(last|previous)/,
        /\b(today|yesterday)\s+(vs\.?|versus|compared\s+to|against)\b/,
    ];

    const isComparison = comparisonPatterns.some(p => p.test(q));
    if (!isComparison) return;

    console.log('[Intent Planner] DETECTED comparison language in question — upgrading intent');

    // Determine comparison type
    let compType: 'previous_period' | 'same_period_last_year' = 'previous_period';
    if (/last\s+year|same\s+\w+\s+last\s+year/i.test(q)) {
        compType = 'same_period_last_year';
    }

    // Determine the mode: if there's a time dimension in the plan, use trend; otherwise total
    const hasTimeDimension = plan.dimensions.some(d => d.timeGrain);
    const mode = hasTimeDimension ? 'trend' : 'total';
    const grain = hasTimeDimension
        ? (plan.dimensions.find(d => d.timeGrain)?.timeGrain || 'day')
        : 'day';

    // Set the comparison object
    plan.comparison = {
        type: compType,
        mode: mode as 'trend' | 'total',
        grain,
    };

    // Upgrade intent
    plan.intent = mode === 'trend' ? 'trend_comparison' : 'total_comparison';

    // Ensure there's a date filter — comparison SQL needs a BETWEEN filter to compute previous period
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
        || model.timeContext?.primaryDateColumn
        || 'order_date';

    const hasDateFilter = plan.filters.some(f =>
        f.field.toLowerCase() === dateField.toLowerCase() && f.op === 'between'
    );

    if (!hasDateFilter) {
        // Inject a "today" filter as default if no date filter exists
        const anchorDate = model.timeContext?.anchorDate
            ? new Date(model.timeContext.anchorDate)
            : new Date();
        const todayStr = anchorDate.toISOString().split('T')[0];

        // Detect if the user mentioned "this week", "this month" for the current period range
        let startStr = todayStr;
        let endStr = todayStr;

        if (/this\s+week|same\s+day\s+last\s+week/i.test(q)) {
            const day = anchorDate.getDay();
            const diff = anchorDate.getDate() - day;
            const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), diff);
            startStr = start.toISOString().split('T')[0];
            endStr = todayStr;
        } else if (/this\s+month/i.test(q)) {
            const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
            startStr = start.toISOString().split('T')[0];
            endStr = todayStr;
        } else if (/today/i.test(q)) {
            startStr = todayStr;
            endStr = todayStr;
        }

        plan.filters.push({
            field: dateField,
            op: 'between',
            value: [startStr, endStr]
        });
        console.log(`[Intent Planner] Injected comparison date filter: ${dateField} BETWEEN ${startStr} AND ${endStr}`);
    }

    console.log(`[Intent Planner] Comparison enforced: intent=${plan.intent}, type=${compType}, mode=${mode}`);
}

/**
 * MSARE: TIME COMPARISON DETECTION
 * Detects YoY, MoM, QoQ, growth, and temporal change patterns.
 * Unlike enforceComparison (which handles "vs" and "compare to"),
 * this handles analytical growth patterns that need time-grouped aggregation.
 *
 * CRITICAL for derived metrics: ensures "YoY average length of stay"
 * gets a time dimension + comparison metadata so the SQL includes
 * GROUP BY year and the JS engine computes LAG-based growth.
 */
function enforceTimeComparison(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // Already has comparison from enforceComparison — skip; also skip growth_analysis
    if (plan.comparison || plan.intent === 'growth_analysis') return;

    // ── Detect time comparison patterns ──
    type TimePattern = { grain: 'year' | 'quarter' | 'month' | 'week' | 'day'; type: 'same_period_last_year' | 'previous_period' };
    let detected: TimePattern | null = null;

    // YoY patterns
    if (/\b(yoy|y-o-y|year[\s-]*over[\s-]*year|yearly\s+growth|annual\s+growth|year\s+on\s+year)\b/.test(q)) {
        detected = { grain: 'year', type: 'same_period_last_year' };
    }
    // MoM patterns
    else if (/\b(mom|m-o-m|month[\s-]*over[\s-]*month|monthly\s+growth|month\s+on\s+month)\b/.test(q)) {
        detected = { grain: 'month', type: 'previous_period' };
    }
    // QoQ patterns
    else if (/\b(qoq|q-o-q|quarter[\s-]*over[\s-]*quarter|quarterly\s+growth|quarter\s+on\s+quarter)\b/.test(q)) {
        detected = { grain: 'quarter', type: 'previous_period' };
    }
    // WoW patterns
    else if (/\b(wow|w-o-w|week[\s-]*over[\s-]*week|weekly\s+growth)\b/.test(q)) {
        detected = { grain: 'week', type: 'previous_period' };
    }
    // Generic growth/change/trend WITH time hint
    else if (/\b(growth|change|changing|grew|declined|increasing|decreasing)\b/.test(q)) {
        // Determine grain from context
        if (/\b(year|annual|yearly)\b/.test(q)) {
            detected = { grain: 'year', type: 'same_period_last_year' };
        } else if (/\b(quarter|quarterly)\b/.test(q)) {
            detected = { grain: 'quarter', type: 'previous_period' };
        } else if (/\b(week|weekly)\b/.test(q)) {
            detected = { grain: 'week', type: 'previous_period' };
        } else if (/\b(month|monthly)\b/.test(q) || true) {
            // Default: monthly growth
            detected = { grain: 'month', type: 'previous_period' };
        }
    }

    if (!detected) return;

    console.log(`[MSARE] Detected time comparison: ${detected.type}, grain=${detected.grain}`);

    // Find primary date field
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
    if (!dateField) {
        console.warn('[MSARE] No date field found — cannot apply time comparison');
        return;
    }

    // ── Inject time dimension if missing ──
    const hasTimeDim = plan.dimensions.some(d => d.timeGrain);
    if (!hasTimeDim) {
        plan.dimensions.push({ field: dateField.name, timeGrain: detected.grain });
        console.log(`[MSARE] Injected time dimension: ${dateField.name} (grain=${detected.grain})`);
    } else {
        // Override grain to match detected pattern
        const timeDim = plan.dimensions.find(d => d.timeGrain);
        if (timeDim && timeDim.timeGrain !== detected.grain) {
            console.log(`[MSARE] Overriding time grain: ${timeDim.timeGrain} → ${detected.grain}`);
            timeDim.timeGrain = detected.grain;
        }
    }

    // ── Set comparison metadata ──
    plan.comparison = {
        type: detected.type,
        mode: 'trend',
        grain: detected.grain,
    };

    // ── Upgrade intent to trend (not trend_comparison, because the JS engine
    //    handles growth computation post-SQL for trend queries) ──
    if (!['trend', 'trend_comparison', 'ranking'].includes(plan.intent)) {
        console.log(`[MSARE] Upgrading intent: ${plan.intent} → trend`);
        plan.intent = 'trend';
    }

    console.log(`[MSARE] Time comparison applied: intent=${plan.intent}, grain=${detected.grain}, type=${detected.type}`);
}

/**
 * Generate an AnalysisPlan from a natural language question.
 * This is Step A of the two-step LLM pipeline.
 */
export async function generatePlan(
    question: string,
    model: SemanticModel,
    grainOverride?: 'day' | 'week' | 'month' | 'quarter' | 'year'
): Promise<AnalysisPlan> {
    if (!API_KEY) {
        throw new Error('OpenRouter API key not configured. Set VITE_OPENROUTER_API_KEY in .env');
    }

    // ── PRE-CLASSIFICATION: Deterministic question analysis ──
    const classification = classifyQuestion(question);
    const fieldMapping = mapFieldsFromQuestion(question, model);
    console.log(`[Question Classifier] intent=${classification.intent} confidence=${classification.confidence.toFixed(2)} grain=${classification.timeGrain || 'none'} reason="${classification.reason}"`);
    console.log(`[Field Mapper] dims=[${fieldMapping.dimensions.map(d => d.name).join(', ')}] mets=[${fieldMapping.metrics.map(m => m.name).join(', ')}] confidence=${fieldMapping.confidence.toFixed(2)}`);

    const systemPrompt = buildPlannerPrompt(model);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Every question is STANDALONE — no prior turns are ever sent. Intent is
    // derived from this question plus the semantic model alone, so answers can
    // never inherit filters or context from an earlier question.
    const llmMessages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
    ];

    try {
        const { data } = await fetchWithFallback(
            llmMessages as any,
            // Accuracy-critical step: use the stronger planning model and a larger
            // token budget so complex plans (multi-dim + metrics + filters +
            // comparison) don't truncate into invalid JSON.
            { temperature: 0.0, max_tokens: 4000, timeout: TIMEOUT_MS, model: PLANNER_MODEL }
        );

        clearTimeout(timeout);
        const content = data.choices?.[0]?.message?.content?.trim();

        // Exact LLM token cost for THIS question. The prompt is built only from the
        // semantic model (column metadata), never the rows — so this is independent
        // of dataset size. The deterministic steps that follow cost 0 tokens.
        const tokens = extractTokenUsage(data);

        if (!content) {
            throw new Error('Empty response from intent planner');
        }

        // Robustly parse the LLM's JSON (fences, comments, trailing commas). If it
        // is unusable, degrade to a deterministic plan instead of failing the query.
        const parsed = extractPlanJson(content);
        if (parsed) {
            return withTokens(finalizePlan(parsed, question, model, classification, grainOverride), tokens);
        }
        console.warn('[Intent Planner] LLM returned unparseable JSON — using deterministic fallback plan.');
        return withTokens(finalizePlan(buildDeterministicParsed(classification, fieldMapping, model), question, model, classification, grainOverride), tokens);

    } catch (err: any) {
        clearTimeout(timeout);
        // Never fail the whole query because the LLM step errored (timeout, network,
        // bad JSON): fall back to a deterministic plan from the classifier + field
        // mapper so the user still gets an answer. No usable LLM response → 0 tokens.
        console.warn(`[Intent Planner] Plan generation failed (${err?.name === 'AbortError' ? 'timeout' : err?.message}) — using deterministic fallback plan.`);
        return withTokens(finalizePlan(buildDeterministicParsed(classification, fieldMapping, model), question, model, classification, grainOverride), { prompt: 0, completion: 0, total: 0 });
    }
}

/** Token usage for one planner call (the only LLM step in answering a question). */
export interface TokenUsage { prompt: number; completion: number; total: number; }

/** Pull exact token counts from the LLM API response (OpenAI/OpenRouter shape). */
function extractTokenUsage(data: any): TokenUsage {
    const u = data?.usage || {};
    const prompt = Number(u.prompt_tokens) || 0;
    const completion = Number(u.completion_tokens) || 0;
    const total = Number(u.total_tokens) || prompt + completion;
    return { prompt, completion, total };
}

/** Attach the planner's token cost to the plan so the pipeline/UI can surface it. */
function withTokens(plan: AnalysisPlan, tokens: TokenUsage): AnalysisPlan {
    (plan as any).tokenUsage = tokens;
    return plan;
}

/**
 * Extract a JSON object from an LLM response: strip markdown fences, brace-match
 * the outermost object, and retry with common repairs (line/block comments,
 * trailing commas). Returns null if nothing parses.
 */
export function extractPlanJson(content: string): any | null {
    if (!content) return null;
    const s = content.replace(/```json\s*|```\s*/g, '').trim();
    const start = s.indexOf('{');
    if (start < 0) return null;

    // String-aware brace scan: a "}" inside a string value must not close the
    // object, and we remember whether we ever returned to depth 0 so a TRUNCATED
    // response (cut at max_tokens mid-JSON — the "unparseable JSON" case) can still
    // be recovered by closing the open brackets.
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }

    const candidates: string[] = [];
    if (end > start) {
        candidates.push(s.substring(start, end + 1));
    } else {
        // Truncated — close the object by appending the missing brackets/braces.
        let body = s.substring(start);
        if (inStr) body += '"';
        body = body.replace(/,\s*$/, '');
        const openers: string[] = [];
        let st = false, es = false;
        for (const ch of body) {
            if (st) { if (es) es = false; else if (ch === '\\') es = true; else if (ch === '"') st = false; continue; }
            if (ch === '"') st = true;
            else if (ch === '{' || ch === '[') openers.push(ch);
            else if (ch === '}' || ch === ']') openers.pop();
        }
        while (openers.length) body += openers.pop() === '[' ? ']' : '}';
        candidates.push(body);
    }
    candidates.push(s.substring(start)); // last resort

    const repairs: Array<(x: string) => string> = [
        x => x,
        x => x.replace(/,(\s*[}\]])/g, '$1'),                                                    // trailing commas
        x => x.replace(/\/\/[^\n\r]*/g, '').replace(/,(\s*[}\]])/g, '$1'),                        // line comments
        x => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '').replace(/,(\s*[}\]])/g, '$1'), // block comments
    ];
    for (const cand of candidates) {
        for (const r of repairs) {
            try {
                const v = JSON.parse(r(cand));
                if (v && typeof v === 'object' && Object.keys(v).length > 0) return v;
            } catch { /* next */ }
        }
    }
    return null;
}

/**
 * A deterministic best-effort plan for when the LLM plan is unusable. Uses the
 * pre-computed classifier + field mapper so the query still runs. The enforce*
 * safeguards in finalizePlan then refine aggregation / time / intent from the
 * question keywords ("youngest" → MIN, "how many" → COUNT, etc.).
 */
function buildDeterministicParsed(classification: any, fieldMapping: any, model: SemanticModel): any {
    const dimensions = (fieldMapping?.dimensions || []).map((d: any) => ({ field: d.name }));
    let metrics = (fieldMapping?.metrics || []).map((m: any) => ({ field: m.name, agg: 'sum' }));
    if (metrics.length === 0) {
        const firstMetric = model.fields.find(f => f.role === 'metric');
        metrics = [{ field: firstMetric?.name || model.fields[0]?.name || '*', agg: firstMetric ? 'sum' : 'count' }];
    }
    const intent = (classification?.intent && classification.intent !== 'ambiguous')
        ? classification.intent
        : (dimensions.length > 0 ? 'breakdown' : 'single_metric');
    return { intent, dimensions, metrics, filters: [], sort: [], limit: classification?.limit ?? null };
}

/**
 * Build the final AnalysisPlan from a parsed (LLM or deterministic) object and run
 * every code-level safeguard, semantic validation, and smart default. Shared by
 * the normal path and the deterministic fallback so both get the same guarantees.
 */
function finalizePlan(
    parsed: any,
    question: string,
    model: SemanticModel,
    classification: any,
    grainOverride?: 'day' | 'week' | 'month' | 'quarter' | 'year',
): AnalysisPlan {
    const plan: AnalysisPlan = {
        intent: validateIntent(parsed.intent),
        dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions : [],
        metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
        filters: Array.isArray(parsed.filters) ? parsed.filters : [],
        comparison: parsed.comparison || undefined,
        sort: Array.isArray(parsed.sort) ? parsed.sort : [],
        limit: typeof parsed.limit === 'number' ? parsed.limit : null,
        ambiguous: !!parsed.ambiguous,
        clarificationQuestion: parsed.clarificationQuestion || undefined,
        resultGrain: parsed.resultGrain || 'one row per record',
        originalQuestion: question,
    };

    validateFieldReferences(plan, model);
    enforceAggregation(plan, question, model);
    enforceTimeContext(plan, question, model);
    enforceCyclicGrain(plan, question, model);
    enforceIntentFromKeywords(plan, question);
    enforceCompositeMetrics(plan, question, model);
    enforceNativeCyclicDimension(plan, question, model);
    enforceAggregationGrain(plan, model);
    enforceAggregateFilter(plan, question, model);
    enforceGrowthAnalysis(plan, question, model);
    enforcePluralLimit(plan, question);
    enforceComparison(plan, question, model);
    enforceTimeComparison(plan, question, model);
    validateSemantics(plan, model);
    applySmartDefaults(plan, question, model);
    if (grainOverride) (plan as any)._grainOverride = grainOverride;
    enforceGrowthTimeDimension(plan, question, model);
    if ((plan as any)._growthRanking) {
        plan.limit = null;
        plan.sort = [];
        console.log('[Intent Planner] Growth ranking: stripped LIMIT and ORDER BY (applied post-collapse)');
    }
    const validation = validatePlan(plan, model);
    if (!validation.valid) console.warn(`[Plan Validator] Plan has ${validation.errors.length} unrecoverable error(s). Proceeding with best effort.`);
    if (validation.autoFixed > 0) console.log(`[Plan Validator] Auto-fixed ${validation.autoFixed} issue(s) in the plan.`);
    if (classification?.confidence >= 0.8 && classification.intent !== 'ambiguous' && classification.intent !== plan.intent) {
        const validOverrides = ['trend', 'ranking', 'share_of_total', 'distribution'];
        if (validOverrides.includes(classification.intent) && classification.confidence >= 0.9) {
            console.log(`[Classifier Override] intent: "${plan.intent}" → "${classification.intent}" (confidence ${classification.confidence.toFixed(2)})`);
            plan.intent = classification.intent as any;
        }
    }
    console.log('[Intent Planner] Generated plan:', JSON.stringify(plan, null, 2));
    return plan;
}

/**
 * Validate the intent string
 */
function validateIntent(intent: string): AnalysisIntent {
    const validIntents: AnalysisIntent[] = [
        'single_metric', 'derived_metric', 'breakdown', 'trend', 'trend_comparison',
        'total_comparison', 'ranking', 'share_of_total', 'correlation', 'distribution',
        'aggregate_filter', 'growth_analysis'
    ];
    if (validIntents.includes(intent as AnalysisIntent)) {
        return intent as AnalysisIntent;
    }
    return 'breakdown';
}

/**
 * Semantic validation — catches nonsensical queries that would produce
 * misleading results. Marks the plan as ambiguous with a clear message.
 *
 * Rules:
 * 1. AVG/SUM on identifier fields → nonsensical (e.g., AVG(customer_id))
 * 2. COUNT on currency/quantity fields → likely wrong (e.g., COUNT(revenue))
 * 3. Same field as both dimension and metric → invalid (e.g., "revenue by revenue")
 * 4. Metric field doesn't exist in the dataset
 * 5. Dimension field doesn't exist in the dataset
 */
function validateSemantics(plan: AnalysisPlan, model: SemanticModel): void {
    const fieldMap = new Map(model.fields.map(f => [f.name.toLowerCase(), f]));
    const warnings: string[] = [];

    // ── Rule 1: Numeric aggregation on identifiers ──────────────────
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const field = fieldMap.get(met.field.toLowerCase());
        if (field && field.semanticType === 'identifier') {
            if (['avg', 'sum'].includes(met.agg)) {
                warnings.push(
                    `"${field.displayLabel}" is an identifier (like an ID), not a measure. ` +
                    `${met.agg.toUpperCase()}(${field.name}) is mathematically meaningless. ` +
                    `Did you mean COUNT(${field.name}) or COUNT(DISTINCT ${field.name})?`
                );
            }
        }
    }

    // ── Rule 2: COUNT on currency/quantity fields → auto-swap to ID column ──
    // e.g., "count of transactions" + LLM uses sales → swap to COUNT(order_id)
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const field = fieldMap.get(met.field.toLowerCase());
        if (field && (field.semanticType === 'currency' || field.semanticType === 'quantity')) {
            if (met.agg === 'count') {
                // Find the best ID/identifier column for COUNT
                const idField = model.fields.find(f => f.semanticType === 'identifier')
                    || model.fields.find(f => f.name.toLowerCase().endsWith('_id'));
                if (idField) {
                    console.log(`[Intent Planner] AUTO-SWAP: COUNT(${field.name}) → COUNT(${idField.name}) — ${field.name} is a ${field.semanticType}, using grain ID instead`);
                    met.field = idField.name;
                } else {
                    // No ID field → warn but allow (it will still count rows)
                    warnings.push(
                        `"${field.displayLabel}" is a ${field.semanticType} field. ` +
                        `COUNT(${field.name}) just counts non-null rows — it ignores the actual values. ` +
                        `Did you mean SUM(${field.name}) or AVG(${field.name})?`
                    );
                }
            }
        }
    }

    // ── Rule 3: Same field as both dimension and metric ──────────────
    const dimFields = new Set(plan.dimensions.map(d => d.field.toLowerCase()));
    for (const met of plan.metrics) {
        if (dimFields.has(met.field.toLowerCase())) {
            const field = fieldMap.get(met.field.toLowerCase());
            warnings.push(
                `"${field?.displayLabel || met.field}" is used as both a dimension and a metric. ` +
                `You can't group by and aggregate the same column. ` +
                `Try using a different dimension (e.g., category, region) or a different metric.`
            );
        }
    }

    // ── Rule 4: Metric field doesn't exist ───────────────────────────
    const compositeIds = new Set(model.compositeMetrics.map(m => m.id.toLowerCase()));
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        if (met.field === '*') continue; // row-count sentinel — COUNT(*), not a column
        const lower = met.field.toLowerCase();
        if (!fieldMap.has(lower) && !compositeIds.has(lower)) {
            warnings.push(
                `Column "${met.field}" does not exist in this dataset. ` +
                `Available metrics: ${model.fields.filter(f => f.role === 'metric').map(f => f.displayLabel).join(', ')}.`
            );
        }
    }

    // ── Rule 5: Dimension field doesn't exist ────────────────────────
    for (const dim of plan.dimensions) {
        if (!fieldMap.has(dim.field.toLowerCase())) {
            warnings.push(
                `Dimension "${dim.field}" does not exist in this dataset. ` +
                `Available dimensions: ${model.fields.filter(f => f.role === 'dimension').map(f => f.displayLabel).join(', ')}.`
            );
        }
    }

    // If any warnings, mark plan as ambiguous
    if (warnings.length > 0) {
        console.warn(`[Intent Planner] SEMANTIC VALIDATION FAILED (${warnings.length} issue(s)):`);
        warnings.forEach((w, i) => console.warn(`  ${i + 1}. ${w}`));

        plan.ambiguous = true;
        plan.clarificationQuestion =
            `⚠️ This query has semantic issues:\n\n` +
            warnings.map((w, i) => `${i + 1}. ${w}`).join('\n\n') +
            `\n\nPlease rephrase your question with the correct field names and aggregations.`;
    }
}

/**
 * SMART DEFAULTS LAYER
 *
 * When the LLM marks a plan as ambiguous because no specific metric was
 * mentioned, this layer fills in intelligent defaults based on the question type.
 *
 * Rules:
 *   "compare" / "vs"           → default metric = primary revenue (SUM)
 *   "growth" / "growing"       → default metric = primary revenue (SUM) + comparison
 *   "performance" / "doing"    → default metric = primary revenue (SUM), top products
 *   "trend" / "over time"      → default metric = primary revenue (SUM)
 *   generic breakdown          → default metric = primary revenue (SUM)
 *
 * The system annotates the plan with `_smartDefaultApplied` so the UI
 * can show: "Showing revenue by product (you can change metric)"
 */
function applySmartDefaults(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    // Skip growth_analysis — it has its own metric/dimension inference
    if (plan.intent === 'growth_analysis') return;

    // Only apply if the plan is ambiguous OR has no metrics
    if (!plan.ambiguous && plan.metrics.length > 0) return;

    // Find the primary revenue/sales field (the most important metric)
    const primaryMetric = findPrimaryMetric(model);
    if (!primaryMetric) return; // Can't default if there's no obvious metric

    const q = question.toLowerCase();

    // ── Detect question patterns ──────────────────────────────
    const isCompare = /\b(compare|vs\.?|versus|compared|comparison)\b/.test(q);
    const isGrowth = /\b(grow|growing|growth|increase|increasing|decline|declining|changing|change)\b/.test(q);
    const isPerformance = /\b(performance|performing|doing|how.+doing|best|worst)\b/.test(q);
    const isTrend = /\b(trend|over\s+time|over\s+the\s+(past|last)|monthly|weekly|daily|quarterly|yearly)\b/.test(q);
    const isRanking = /\b(top|bottom|best|worst|fastest|slowest|highest|lowest|most|least|leading|lagging)\b/.test(q);
    const isBreakdown = /\b(by\s+\w+|each\s+\w+|per\s+\w+|breakdown|split)\b/.test(q);

    // If none of these patterns match, don't apply defaults
    if (!isCompare && !isGrowth && !isPerformance && !isTrend && !isRanking && !isBreakdown) return;

    console.log('[Smart Defaults] Ambiguous query detected — applying intelligent defaults');

    // ── Determine the default metric and explanation ──────────
    let defaultMetricName = primaryMetric.name;
    let defaultAgg: 'sum' | 'avg' | 'count' = primaryMetric.defaultAgg === 'avg' ? 'avg' : 'sum';
    let explanation = '';

    if (isGrowth) {
        explanation = `Showing ${primaryMetric.displayLabel} growth`;
        // Growth queries should be trend comparisons
        if (!plan.comparison) {
            plan.comparison = { type: 'previous_period', mode: 'trend', grain: 'month' };
            plan.intent = 'trend_comparison';
        }
        // Ensure a time dimension
        const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
        if (dateField && !plan.dimensions.some(d => d.timeGrain)) {
            plan.dimensions = plan.dimensions.filter(d => {
                const f = model.fields.find(ff => ff.name.toLowerCase() === d.field.toLowerCase());
                return f?.semanticType !== 'date';
            });
            plan.dimensions.push({ field: dateField.name, timeGrain: 'month' });
        }
    } else if (isCompare) {
        explanation = `Comparing ${primaryMetric.displayLabel}`;
        if (!plan.comparison) {
            plan.comparison = { type: 'previous_period', mode: 'total' };
            plan.intent = 'total_comparison';
        }
    } else if (isPerformance || isRanking) {
        explanation = `Ranking by ${primaryMetric.displayLabel}`;
        plan.intent = 'ranking';
        if (!plan.sort.length) {
            plan.sort = [{ field: defaultMetricName, dir: 'desc' }];
        }
        if (!plan.limit) plan.limit = 10;
    } else if (isTrend) {
        explanation = `${primaryMetric.displayLabel} over time`;
        plan.intent = 'trend';
        const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
        if (dateField && !plan.dimensions.some(d => d.timeGrain)) {
            plan.dimensions.push({ field: dateField.name, timeGrain: 'month' });
        }
    } else {
        explanation = `${primaryMetric.displayLabel} breakdown`;
    }

    // Add dimension context to explanation
    const nonTimeDims = plan.dimensions.filter(d => !d.timeGrain);
    if (nonTimeDims.length > 0) {
        const dimLabel = model.fields.find(f => f.name.toLowerCase() === nonTimeDims[0].field.toLowerCase())?.displayLabel || nonTimeDims[0].field;
        explanation += ` by ${dimLabel}`;
    }

    // ── Fill in the metrics if empty or replace wrong ones ──────
    if (plan.metrics.length === 0 || plan.ambiguous) {
        plan.metrics = [{ field: defaultMetricName, agg: defaultAgg }];
    }

    // ── Clear ambiguous flag ──────────────────────────────────
    plan.ambiguous = false;
    plan.clarificationQuestion = undefined;

    // ── Annotate for UI explanation ───────────────────────────
    (plan as any)._smartDefaultApplied = true;
    (plan as any)._smartDefaultExplanation = `${explanation} (defaulted to ${primaryMetric.displayLabel})`;

    console.log(`[Smart Defaults] Applied: metric="${defaultMetricName}", agg="${defaultAgg}", intent="${plan.intent}", explanation="${explanation}"`);
}

/**
 * Find the primary metric field in the semantic model.
 * Priorities:
 *   1. Field named 'revenue', 'sale_amt', 'sales', 'total_sales'
 *   2. First currency-type metric field
 *   3. First quantity-type metric field
 *   4. First metric field of any type
 */
function findPrimaryMetric(model: SemanticModel): SemanticField | null {
    const metrics = model.fields.filter(f => f.role === 'metric');
    if (metrics.length === 0) return null;

    // Priority 1: exact name matches
    const priorityNames = ['revenue', 'sale_amt', 'sales_amt', 'total_sales', 'sales', 'amount', 'total_amount'];
    for (const name of priorityNames) {
        const found = metrics.find(f => f.name.toLowerCase() === name);
        if (found) return found;
    }

    // Priority 2: name contains revenue/sales/amount (but not "sales_rep")
    const revenueField = metrics.find(f => {
        const n = f.name.toLowerCase();
        return (n.includes('revenue') || n.includes('sale') || n.includes('amount'))
            && !n.includes('rep') && !n.includes('person') && !n.includes('name');
    });
    if (revenueField) return revenueField;

    // Priority 3: currency type
    const currencyField = metrics.find(f => f.semanticType === 'currency');
    if (currencyField) return currencyField;

    // Priority 4: first metric
    return metrics[0];
}

/**
 * ENFORCE TIME DIMENSION FOR GROWTH/COMPARISON QUERIES
 *
 * Even when the LLM correctly identifies the metric and sets ambiguous=false,
 * it often forgets to include a time dimension with a grain. Without the grain,
 * the correction engine generates a plain GROUP BY (no time series), so
 * growth calculations never fire.
 *
 * This step ALWAYS runs (not conditional on ambiguity) and:
 * 1. Detects growth/comparison intent from plan.comparison OR question keywords
 * 2. Checks if a time dimension with timeGrain exists in the plan
 * 3. If missing, injects the primary date column with timeGrain='month'
 * 4. Upgrades the intent to trend_comparison if needed
 */
function enforceGrowthTimeDimension(plan: AnalysisPlan, question: string, model: SemanticModel): void {
    const q = question.toLowerCase();

    // Broad growth detection — includes fuzzy matching for typos
    const isGrowthQuestion = /\b(grow|growing|growth|growin|growt|increase|increasing|decline|declining|changing|change|faster|fastest|slower|slowest)\b/.test(q);
    const hasComparison = !!plan.comparison;
    const isComparisonIntent = ['trend_comparison', 'total_comparison'].includes(plan.intent);

    // Skip if growth_analysis — it has its own SQL builder
    if (plan.intent === 'growth_analysis') return;

    // Only apply to growth/comparison queries
    if (!isGrowthQuestion && !hasComparison && !isComparisonIntent) return;

    // Check if a time dimension with grain already exists
    const hasTimeDimWithGrain = plan.dimensions.some(d => d.timeGrain);

    // Find the primary date column
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension');
    if (!dateField) return;

    // ── KEY DISTINCTION: Growth Ranking vs Growth Trend ──────────
    // "Which products are growing fastest?" → RANKING (final output = 1 row per entity)
    // "How are sales changing over time?"   → TREND   (final output = time series)
    const hasRankingLanguage = /\b(which|what|who|top|bottom|fastest|slowest|best|worst|most|least|leading|lagging|faster|slower)\b/.test(q);
    const hasEntityDimension = plan.dimensions.some(d => !d.timeGrain); // has a non-time dimension like product_name

    const isGrowthRanking = isGrowthQuestion && hasRankingLanguage && hasEntityDimension;

    // Determine grain: user override > plan comparison grain > default 'month'
    const grain = (plan as any)._grainOverride
        || (plan.comparison?.grain)
        || 'month';

    if (!hasTimeDimWithGrain) {
        console.log(`[Intent Planner] ENFORCE: Growth query missing time dimension — injecting ${dateField.name} with timeGrain="${grain}"`);
        plan.dimensions.push({ field: dateField.name, timeGrain: grain });
    } else if ((plan as any)._grainOverride) {
        // Override existing grain if user explicitly selected one
        const timeDim = plan.dimensions.find(d => d.timeGrain);
        if (timeDim) {
            console.log(`[Intent Planner] GRAIN OVERRIDE: Changing grain from "${timeDim.timeGrain}" to "${grain}"`);
            timeDim.timeGrain = grain;
        }
    }

    // Ensure comparison is set for growth queries (needed for intermediate computation)
    if (isGrowthQuestion && !plan.comparison) {
        plan.comparison = { type: 'previous_period', mode: 'trend', grain };
    } else if (plan.comparison && (plan as any)._grainOverride) {
        plan.comparison.grain = grain;
    }

    if (isGrowthRanking) {
        // GROWTH RANKING: time dimension exists for computation,
        // but the FINAL output is a ranking (1 row per entity)
        plan.intent = 'ranking';
        (plan as any)._growthRanking = true;
        console.log(`[Intent Planner] ENFORCE: Growth RANKING detected — intent set to "ranking" with _growthRanking=true`);
    } else if (plan.intent !== 'trend_comparison') {
        // GROWTH TREND: normal time-series output
        console.log(`[Intent Planner] ENFORCE: Upgrading intent "${plan.intent}" → "trend_comparison" for growth query`);
        plan.intent = 'trend_comparison';
    }
}

/**
 * Validate that all field references in the plan exist in the semantic model.
 * If a field is a synonym, attempt to resolve it to the actual field name.
 */
function validateFieldReferences(plan: AnalysisPlan, model: SemanticModel): void {
    const fieldNames = new Set(model.fields.map(f => f.name.toLowerCase()));
    const compositeIds = new Set(model.compositeMetrics.map(m => m.id.toLowerCase()));

    // Pre-filter: remove any malformed entries with missing field names
    plan.dimensions = plan.dimensions.filter(d => d && typeof d.field === 'string' && d.field.trim());
    plan.metrics = plan.metrics.filter(m => m && typeof m.field === 'string' && m.field.trim());
    plan.filters = plan.filters.filter(f => f && typeof f.field === 'string' && f.field.trim());

    // Build a synonym → field name lookup
    const synonymLookup = new Map<string, string>();
    for (const f of model.fields) {
        for (const syn of f.synonyms) {
            synonymLookup.set(syn.toLowerCase(), f.name);
        }
        synonymLookup.set(f.displayLabel.toLowerCase(), f.name);
    }
    for (const m of model.compositeMetrics) {
        for (const syn of m.synonyms) {
            synonymLookup.set(syn.toLowerCase(), m.id);
        }
    }

    // Helper: fuzzy-find the best matching field by substring
    const fuzzyResolveMetric = (fieldName: string): string | null => {
        const lower = fieldName.toLowerCase().replace(/_/g, ' ');
        // Try partial matches against field names and labels
        for (const f of model.fields) {
            if (f.role === 'metric') {
                const nameLower = f.name.toLowerCase();
                const labelLower = f.displayLabel.toLowerCase();
                // e.g., 'total_orders' contains 'order' → match 'order_id'
                if (lower.includes(nameLower.replace(/_id$/, '')) || nameLower.includes(lower.replace(/total_|count_|num_/g, ''))) {
                    return f.name;
                }
                if (lower.includes(labelLower) || labelLower.includes(lower.replace(/total |count |num /g, ''))) {
                    return f.name;
                }
            }
        }
        // Fallback: for count-like terms (total_orders, num_customers), find the ID field
        // by looking for columns whose name contains the root noun
        const rootNoun = lower.replace(/total_|count_|num_|number_of_/g, '').replace(/s$/, '');
        for (const f of model.fields) {
            const fn = f.name.toLowerCase();
            if (fn.includes(rootNoun) && (fn.endsWith('_id') || f.semanticType === 'identifier' || f.role === 'metric')) {
                return f.name;
            }
        }
        return null;
    };

    // Resolve dimensions
    for (const dim of plan.dimensions) {
        if (!fieldNames.has(dim.field.toLowerCase())) {
            const resolved = synonymLookup.get(dim.field.toLowerCase());
            if (resolved) {
                dim.field = resolved;
            } else {
                console.warn(`[Intent Planner] Unknown dimension field: ${dim.field}`);
            }
        }
    }

    // Resolve metrics — with fuzzy fallback for fabricated field names
    for (const met of plan.metrics) {
        const lower = met.field.toLowerCase();
        if (!fieldNames.has(lower) && !compositeIds.has(lower)) {
            // Try exact synonym match first
            const resolved = synonymLookup.get(lower);
            if (resolved) {
                met.field = resolved;
                if (compositeIds.has(resolved.toLowerCase())) {
                    met.compositeId = resolved;
                    met.agg = 'none' as any;
                }
            } else {
                // Fuzzy fallback: try to find a matching field
                const fuzzy = fuzzyResolveMetric(met.field);
                if (fuzzy) {
                    console.log(`[Intent Planner] RESOLVED: fabricated field "${met.field}" → real field "${fuzzy}"`);
                    met.field = fuzzy;
                    // If the fabricated name contains 'total_' + count-noun, force count agg
                    if (/^(total|num|number)_/.test(lower) && (fuzzy.endsWith('_id') || model.fields.find(f => f.name === fuzzy)?.defaultAgg === 'count_distinct')) {
                        met.agg = 'count' as any;
                        console.log(`[Intent Planner] OVERRIDE: "${fuzzy}" agg → count (inferred from "${met.field}")`);
                    }
                } else {
                    console.warn(`[Intent Planner] Unknown metric field: ${met.field} — no fuzzy match found`);
                }
            }
        }
    }

    // Resolve filters
    for (const f of plan.filters) {
        if (!fieldNames.has(f.field.toLowerCase())) {
            const resolved = synonymLookup.get(f.field.toLowerCase());
            if (resolved) f.field = resolved;
        }
    }
}

