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

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';
export const MODEL = 'openai/gpt-4o';
const TIMEOUT_MS = 20000;

/**
 * Build the system prompt for the intent planner.
 */
function buildPlannerPrompt(model: SemanticModel): string {
    const serialized = serializeSemanticModel(model);

    return `You are an expert analytics planner. Given a user question about their data, you produce a STRUCTURED ANALYSIS PLAN as JSON. You do NOT write SQL.

SEMANTIC MODEL:
${serialized}

YOUR JOB:
1. Understand what the user is asking.
2. Map their words to the exact field names in the semantic model above.
3. MOST IMPORTANT — Choose the correct aggregation:
   a. If the user says "average", "avg", "mean" → agg MUST be "avg"
   b. If the user says "total", "sum", "overall" → agg MUST be "sum"
   c. If the user says "count", "how many", "number of" → agg MUST be "count" or "count_distinct"
   d. ONLY if the user says "max of X" or "min of X" as a scalar function → agg MUST be "max" or "min"
   e. ONLY if none of the above keywords appear, use the field's default_agg from the semantic model.

   RANKING vs AGGREGATION — CRITICAL DISTINCTION:
   - "Which day had the LOWEST sales?" → This is a RANKING, NOT a MIN aggregation.
     The correct plan: intent="ranking", agg="sum" (use the default agg for the metric), sort=[{dir:"asc"}], limit=1.
     This produces: SELECT date, SUM(sales) GROUP BY date ORDER BY SUM(sales) ASC LIMIT 1
   - "Which product has the HIGHEST revenue?" → This is also a RANKING.
     The correct plan: intent="ranking", agg="sum", sort=[{dir:"desc"}], limit=1.
   - "What is the MAX sales?" → This IS a MIN/MAX aggregation (no dimension breakdown).
     The correct plan: intent="single_metric", agg="max".
   - Rule: If the sentence structure is "which/what [dimension] had/has the lowest/highest [metric]",
     it is ALWAYS a ranking with the default aggregation, sorted ASC (lowest) or DESC (highest).
4. COMPOUND AVERAGE DETECTION:
   - "average daily X" means: first sum X by day, then avg those daily totals.
     → Set "compoundAgg": "avg_per_day" in the metric. Use dimensions: [{ "field": date_col, "timeGrain": "day" }], metric: { "agg": "avg", "compoundAgg": "avg_per_day" }
   - "average weekly X" → compoundAgg: "avg_per_week", timeGrain: "week"
   - "average monthly X" → compoundAgg: "avg_per_month", timeGrain: "month"
   - For compound averages the SQL should be a subquery: SELECT AVG(daily_total) FROM (SELECT date, SUM(X) as daily_total FROM data GROUP BY date) sub
5. Detect the intent (see valid intents below).
6. If the user asks to compare periods (e.g., "this month vs last month"), set the comparison object.
7. If the question is ambiguous, set "ambiguous": true and provide a "clarificationQuestion".

VALID INTENTS:
- "single_metric" — user wants a single number (e.g., "what is total sales?", "average daily sales")
- "breakdown" — user wants a dimension breakdown (e.g., "sales by category")
- "trend" — user wants data over time (e.g., "monthly sales for 2023")
- "trend_comparison" — user wants a time trend comparing two periods
- "total_comparison" — user wants totals for two periods side by side
- "ranking" — user wants top/bottom N
- "share_of_total" — user wants percentages
- "correlation" — user wants to see two metrics together
- "distribution" — user wants a histogram-like view

COMPARISON RULES:
- comparison.type: "previous_period", "same_period_last_year", or "custom"
- comparison.mode: "trend" or "total"
- comparison.grain: day, week, month, quarter, year

FILTER RULES:
- "this week", "this month", "this year" etc. → filter using the primary date column.
- Use the reference date from Time Context as "today".
- For "this month", filter where the date column's month/year matches today's month/year.

OUTPUT FORMAT:
Respond with ONLY a valid JSON object (no markdown, no code fences):
{
  "intent": "single_metric",
  "dimensions": [],
  "metrics": [
    { "field": "exact_column_name", "agg": "avg", "compoundAgg": "avg_per_day" }
  ],
  "filters": [
    { "field": "exact_column_name", "op": "between", "value": ["2023-01-01", "2023-12-31"] }
  ],
  "comparison": null,
  "sort": [],
  "limit": null,
  "ambiguous": false,
  "clarificationQuestion": null,
  "resultGrain": "one row (scalar)"
}

CRITICAL RULES:
- Use ONLY field names that exist in the semantic model above.
- The aggregation MUST match what the user explicitly asked for. "average" ALWAYS means "avg", NEVER "sum". This is non-negotiable.
- For "average daily/weekly/monthly X", set compoundAgg to indicate it needs a subquery with GROUP BY date then AVG.
- For composite metrics, use the compositeId: { "field": "gross_margin_pct", "agg": "none", "compositeId": "gross_margin_pct" }
- If the user mentions a synonym (e.g., "revenue"), map it to the actual field name.
- Always set resultGrain to describe what each row represents.`;
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
function detectExplicitAggregation(question: string): 'avg' | 'sum' | 'count' | 'count_distinct' | 'max' | 'min' | null {
    const q = question.toLowerCase();

    // Order matters: check specific patterns first
    if (/\b(average|avg|mean)\b/.test(q)) return 'avg';

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
        if (/\b(max|maximum)\b/.test(q)) return 'max';
        if (/\b(min|minimum)\b/.test(q)) return 'min';
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
function detectRankingDirection(question: string): 'asc' | 'desc' | null {
    const q = question.toLowerCase();
    if (/\b(lowest|least|worst|bottom|smallest|fewest|minimum)\b/.test(q)) return 'asc';
    if (/\b(highest|most|best|top|largest|biggest|greatest|maximum)\b/.test(q)) return 'desc';
    return null;
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
 * Post-process the plan to enforce aggregation correctness.
 * This is the CODE-LEVEL OVERRIDE that runs AFTER the LLM.
 * Even if the LLM returns "sum" when the user said "average",
 * this function forcefully corrects it.
 */
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

    // Already a comparison — nothing to do
    if (plan.comparison || plan.intent === 'total_comparison' || plan.intent === 'trend_comparison') return;

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

    const systemPrompt = buildPlannerPrompt(model);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: question }
                ],
                temperature: 0.0,  // Zero temperature for maximum determinism
                max_tokens: 1500,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`API error (${response.status}): ${errorBody}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        if (!content) {
            throw new Error('Empty response from intent planner');
        }

        // Parse the JSON response
        const cleaned = content.replace(/```json\s*|```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned);

        // Validate required fields
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

        // ── STEP 1: Validate field names against the semantic model ──
        validateFieldReferences(plan, model);

        // ── STEP 2: CODE-LEVEL SAFEGUARDS ──
        // Even if the LLM ignores the user's explicit instructions,
        // these functions forcefully correct the plan metadata.
        enforceAggregation(plan, question, model);
        enforceTimeContext(plan, question, model);
        enforceComparison(plan, question, model); // Fix: detect comparison patterns

        // ── STEP 3: SEMANTIC VALIDATION ──
        // Catch nonsensical queries: AVG(customer_id), COUNT(revenue), revenue by revenue
        validateSemantics(plan, model);

        // ── STEP 4: SMART DEFAULTS ──
        // If the plan is ambiguous due to missing metrics, auto-fill with
        // intelligent defaults (e.g., revenue for compare/growth/performance)
        applySmartDefaults(plan, question, model);

        // ── STEP 5: ENFORCE TIME DIMENSION FOR GROWTH/COMPARISON ──
        // Even if the LLM sets ambiguous=false and picks the right metric,
        // it often forgets the time dimension needed for growth calculations.
        // This step ALWAYS runs and injects the time grain if missing.
        // Grain override MUST be set BEFORE this step runs.
        if (grainOverride) {
            (plan as any)._grainOverride = grainOverride;
        }
        enforceGrowthTimeDimension(plan, question, model);

        // ── STEP 6: STRIP LIMIT/ORDER FOR GROWTH RANKING ──
        // Growth ranking needs ALL data for correct growth computation.
        // LIMIT and ORDER BY are applied post-collapse, not in SQL.
        if ((plan as any)._growthRanking) {
            plan.limit = null;
            plan.sort = [];
            console.log('[Intent Planner] Growth ranking: stripped LIMIT and ORDER BY (applied post-collapse)');
        }

        console.log('[Intent Planner] Generated plan:', JSON.stringify(plan, null, 2));
        return plan;

    } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            throw new Error('Intent planner timed out after ' + TIMEOUT_MS + 'ms');
        }
        throw err;
    }
}

/**
 * Validate the intent string
 */
function validateIntent(intent: string): AnalysisIntent {
    const validIntents: AnalysisIntent[] = [
        'single_metric', 'breakdown', 'trend', 'trend_comparison',
        'total_comparison', 'ranking', 'share_of_total', 'correlation', 'distribution'
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

