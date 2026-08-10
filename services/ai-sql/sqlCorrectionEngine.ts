/**
 * SQL Correction Engine
 *
 * Sits between AI SQL generation and execution. Ignores whatever SQL the AI
 * produced and regenerates 100% correct SQL purely from the AnalysisPlan.
 *
 * Like Power BI's query folding: the plan is the truth, the SQL is derived.
 *
 * Coverage:
 *   - single_metric (scalar, compound avg)
 *   - breakdown (dimension GROUP BY)
 *   - trend (time grain + chronological sort)
 *   - ranking (ORDER BY metric ASC/DESC + LIMIT)
 *   - share_of_total (percentage of grand total)
 *   - correlation (multi-metric breakdown)
 *   - distribution (histogram buckets)
 *   - total_comparison (two periods summed side by side)
 *   - trend_comparison (two periods as overlapping trends)
 *   - composite metrics (governed formulas from metric registry)
 */

import { SemanticModel, AnalysisPlan, PlanMetric, PlanDimension, PlanFilter, DerivedMetricDefinition } from './types';
import type { DerivedMetric } from './derivedMetricEngine';
import { logger } from '../logger';
import { dateRangePredicate } from '../queryPlan/sqlPrimitives';
import { isRowIdentifier } from './modelHelpers';

// â”€â”€â”€ Table Reference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Set dynamically by correctSQL() so all builder functions use the
// actual dataset name instead of hardcoded "data".
let TABLE_REF = '"data"';
// The dataset's ANCHOR date ("today" for this data) — set by correctSQL(). Relative
// time filters ("this year/month/…") resolve against THIS, never real NOW(): using
// the wall-clock date on a 2015-2018 dataset would silently return zero rows.
let ANCHOR_DATE: string | null = null;

function fromTable(): string {
    return `FROM ${TABLE_REF}`;
}

// The LLM plan uses varied spellings for filter operators ("eq", "gt", "in_list",
// …). Map them to the canonical set the builders understand so a filter is NEVER
// silently dropped over a spelling mismatch (e.g. "gender eq Male" → WHERE dropped
// → counts everyone). Applied once at the top of correctSQL().
const FILTER_OP_ALIASES: Record<string, string> = {
    eq: '=', equals: '=', equal: '=', '==': '=', is: '=', matches_exactly: '=',
    neq: '!=', ne: '!=', not_eq: '!=', not_equal: '!=', not_equals: '!=', isnt: '!=', is_not: '!=', '<>': '!=', '!==': '!=',
    gt: '>', greater: '>', greater_than: '>', more_than: '>', after: '>',
    lt: '<', less: '<', less_than: '<', fewer_than: '<', before: '<',
    gte: '>=', ge: '>=', greater_than_or_equal: '>=', greater_or_equal: '>=', at_least: '>=', min: '>=',
    lte: '<=', le: '<=', less_than_or_equal: '<=', less_or_equal: '<=', at_most: '<=', max: '<=',
    in_list: 'in', one_of: 'in', in_set: 'in', includes: 'in', any_of: 'in',
    not_in_list: 'not_in', nin: 'not_in', none_of: 'not_in', excludes: 'not_in',
    contains: 'like', like_pattern: 'like', matches: 'like', starts_with: 'like',
    range: 'between', within: 'between', in_range: 'between',
    current_year: 'this_year', ytd: 'this_year',
    current_month: 'this_month', mtd: 'this_month',
    current_quarter: 'this_quarter', qtd: 'this_quarter',
    above_average: 'above_avg', below_average: 'below_avg', above_mean: 'above_avg', below_mean: 'below_avg',
};
export function normalizeFilterOp(op: any): string {
    if (typeof op !== 'string') return op;
    const k = op.toLowerCase().trim();
    return FILTER_OP_ALIASES[k] ?? k;
}

// Aggregation name aliases — the LLM may say "average"/"total"/"distinct" instead
// of the canonical avg/sum/count_distinct. Without this, "average" would emit an
// invalid AVERAGE(...) or silently default to SUM.
const AGG_ALIASES: Record<string, string> = {
    sum: 'sum', total: 'sum', sum_of: 'sum', add: 'sum', totalsum: 'sum',
    avg: 'avg', average: 'avg', mean: 'avg', avg_of: 'avg', averageof: 'avg',
    count: 'count', cnt: 'count', tally: 'count', how_many: 'count',
    count_distinct: 'count_distinct', distinct: 'count_distinct', distinct_count: 'count_distinct',
    unique: 'count_distinct', count_unique: 'count_distinct', unique_count: 'count_distinct', nunique: 'count_distinct', num_unique: 'count_distinct',
    min: 'min', minimum: 'min', smallest: 'min', lowest: 'min', least: 'min',
    max: 'max', maximum: 'max', largest: 'max', highest: 'max', greatest: 'max', peak: 'max',
};
export function normalizeAgg(agg: any): string {
    if (typeof agg !== 'string') return agg;
    const k = agg.toLowerCase().trim();
    return AGG_ALIASES[k] ?? k;
}

// Sort direction — map ascending/descending word-forms to asc/desc. Without this,
// "descending" reaches ORDER BY as "DESCENDING" and DuckDB throws a parser error.
function normalizeSortDir(dir: any): 'asc' | 'desc' {
    const d = String(dir ?? '').toLowerCase().trim();
    return /^(asc|ascending|up|increasing|rising|oldest|earliest|smallest|lowest|least)$/.test(d) ? 'asc' : 'desc';
}

// Time-grain aliases — "monthly"→"month" etc. Without this, timeGrainExpr's default
// branch returns the RAW date, so a "monthly" trend silently groups by day.
const GRAIN_ALIASES: Record<string, string> = {
    daily: 'day', day: 'day', by_day: 'day', per_day: 'day',
    weekly: 'week', week: 'week', by_week: 'week', per_week: 'week',
    monthly: 'month', month: 'month', by_month: 'month', per_month: 'month',
    quarterly: 'quarter', quarter: 'quarter', by_quarter: 'quarter', per_quarter: 'quarter',
    yearly: 'year', annual: 'year', annually: 'year', year: 'year', by_year: 'year', per_year: 'year',
    hourly: 'hour', hour: 'hour',
    day_of_week: 'day_of_week', dayofweek: 'day_of_week', dow: 'day_of_week', weekday: 'day_of_week',
    month_of_year: 'month_of_year', monthofyear: 'month_of_year',
};
function normalizeGrain(grain: any): any {
    if (typeof grain !== 'string') return grain;
    const k = grain.toLowerCase().trim();
    return GRAIN_ALIASES[k] ?? k;
}

/** Resolve a relative-time filter op to an inclusive [start,end] ISO date range,
 *  anchored to the dataset's date. Returns null when there is no usable anchor. */
function resolveTemporalRange(op: string): { start: string; end: string } | null {
    if (!ANCHOR_DATE) return null;
    const d = new Date(ANCHOR_DATE.slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth(); // 0-11
    const pad = (n: number) => String(n).padStart(2, '0');
    const iso = (dt: Date) => dt.toISOString().slice(0, 10);
    const lastDay = (yr: number, mo0: number) => new Date(Date.UTC(yr, mo0 + 1, 0)).getUTCDate();
    switch (op) {
        case 'this_year': return { start: `${y}-01-01`, end: `${y}-12-31` };
        case 'this_month': return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay(y, m))}` };
        case 'this_quarter': {
            const sm = Math.floor(m / 3) * 3, em = sm + 2;
            return { start: `${y}-${pad(sm + 1)}-01`, end: `${y}-${pad(em + 1)}-${pad(lastDay(y, em))}` };
        }
        case 'this_week': {
            const dow = d.getUTCDay(); // 0=Sun
            const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
            const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
            return { start: iso(mon), end: iso(sun) };
        }
        case 'this_day': return { start: ANCHOR_DATE.slice(0, 10), end: ANCHOR_DATE.slice(0, 10) };
        default: return null;
    }
}

// â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate 100% correct SQL from a structured AnalysisPlan.
 * This REPLACES whatever SQL the AI produced.
 */
export function correctSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // Always use "data" as the table name — DuckDB loads all data into
    // a table called "data", NOT the original file name.
    TABLE_REF = '"data"';
    ANCHOR_DATE = model.timeContext?.anchorDate || model.timeContext?.maxDate || null;
    // Canonicalize the LLM's plan vocabulary up front so every builder sees the
    // spellings it expects: filter ops ("eq"→"="), aggregations ("average"→"avg"),
    // and sort directions ("descending"→"desc"). Otherwise a filter is dropped, a
    // bad SQL function is emitted, or ORDER BY throws a parser error.
    plan = {
        ...plan,
        filters: (plan.filters || []).map(f => ({ ...f, op: normalizeFilterOp(f.op) as PlanFilter['op'] })),
        metrics: (plan.metrics || []).map(m => ({ ...m, agg: normalizeAgg(m.agg) as PlanMetric['agg'] })),
        sort: (plan.sort || []).map(s => ({ ...s, dir: normalizeSortDir(s.dir) })),
        // Drop row-identifier dimensions (order_id): grouping by a unique-per-row
        // column produces one group per row and wrecks aggregate-filter /
        // comparison queries. Keep time-grain dimensions.
        dimensions: (plan.dimensions || [])
            .filter(d => d.timeGrain || !isRowIdentifier(d.field, model))
            .map(d => (d.timeGrain ? { ...d, timeGrain: normalizeGrain(d.timeGrain) } : d)),
    };
    logger.info('[SQL Correction]', `Building SQL for intent="${plan.intent}" table=${TABLE_REF}`);

    // â”€â”€ Intercept hour/time-of-day grain: check if dataset has time data â”€â”€
    const hourDim = plan.dimensions.find(d => ['hour', 'time_of_day', 'hour_of_day'].includes((d as any).timeGrain || ''));
    if (hourDim) {
        const dateField = model.fields.find(f => f.name.toLowerCase() === hourDim.field.toLowerCase());
        const hasTimeData = dateField?.hasTimeComponent ?? false;

        if (!hasTimeData) {
            logger.warn('[SQL Correction]', `hour grain requested but date column "${hourDim.field}" has no time data. Falling back to today's sales.`);

            // Annotate the plan with a fallback reason so the pipeline can surface it
            (plan as any)._fallbackReason =
                `âš ï¸ This dataset's "${hourDim.field}" column contains only dates (e.g., "2025-12-31"), not date-times (e.g., "2025-12-31 14:30:00"). ` +
                `Time-of-day analysis requires timestamps with hours/minutes. ` +
                `Showing today's total sales instead.`;

            // Fall back to: total sales for today (the anchor date)
            const anchorStr = model.timeContext?.anchorDate || model.timeContext?.maxDate || new Date().toISOString().split('T')[0];
            const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
            const where = buildWhereClause(plan.filters);
            const dateFilter = `${hourDim.field} = '${anchorStr}'`;
            const fullWhere = where ? `${where} AND ${dateFilter}` : dateFilter;

            return [
                `SELECT '${anchorStr}' AS date, ${metExprs.join(', ')}`,
                fromTable(),
                `WHERE ${fullWhere}`,
            ].join('\n');
        }
    }
    // Check for derived metrics FIRST (two-stage aggregation)
    // This handles cases like "average daily sales" where the plan
    // references a derived metric OR where the LLM set intent=derived_metric
    const derivedMetric = findDerivedMetric(plan, model);
    if (derivedMetric) {
        logger.info('[SQL Correction]', `Found derived metric: ${derivedMetric.id}`);
        return buildDerivedMetricSQL(plan, model, derivedMetric);
    }

    // Check for compound average (legacy path â€” avg per day/week/month)
    const hasCompound = plan.metrics.some((m: any) => m.compoundAgg);
    if (hasCompound) {
        return buildCompoundAverageSQL(plan, model);
    }

    // Check for comparison
    // MSARE: If APDME derived metrics exist, use buildTrendSQL (which supports derived expressions)
    // instead of buildComparisonSQL (which doesn't). The JS Time Intelligence Engine will
    // compute growth/LAG post-SQL from the time-grouped results.
    if (plan.comparison) {
        if (apdmeMetrics && apdmeMetrics.length > 0) {
            logger.info('[SQL Correction]', `MSARE: APDME + comparison detected â€” routing to buildTrendSQL with derived expressions`);
            return buildTrendSQL(plan, model, apdmeMetrics);
        }
        return buildComparisonSQL(plan, model);
    }

    // Dispatch by intent
    if (plan.intent === 'trend') {
        const lowerQ = (plan.originalQuestion || '').toLowerCase();
        const isRunningTotal = lowerQ.includes('running total') || lowerQ.includes('cumulative');
        const isMovingAvg = lowerQ.includes('moving average') || lowerQ.includes('rolling');
        
        if (isRunningTotal || isMovingAvg) {
            const timeDim = plan.dimensions.find(d => (d as any).timeGrain) || plan.dimensions[0];
            if (timeDim && plan.metrics.length > 0) {
                const timeDimField = (timeDim as any).timeGrain && (timeDim as any).timeGrain !== 'day' 
                    ? `${timeDim.field}_${(timeDim as any).timeGrain}` 
                    : timeDim.field;
                const met = plan.metrics[0];
                const metricAlias = getMetricAlias(met, model, apdmeMetrics);
                
                if (isRunningTotal) {
                    return buildRunningTotalSQL(plan, model, {
                        orderByField: timeDimField,
                        metricAlias: metricAlias
                    });
                } else if (isMovingAvg) {
                    let N = 7;
                    const match = lowerQ.match(/(\d+)-?(?:day|month)?\s+(?:moving|rolling)/);
                    if (match) N = parseInt(match[1]);
                    
                    return buildMovingAverageSQL(plan, model, {
                        orderByField: timeDimField,
                        metricAlias: metricAlias,
                        preceding: N - 1
                    });
                }
            }
        }
    }

    switch (plan.intent) {
        case 'single_metric':
            return buildSingleMetricSQL(plan, model, apdmeMetrics);
        case 'derived_metric':
            // If we get here, findDerivedMetric() didn't match â€” fallback to single
            return buildSingleMetricSQL(plan, model, apdmeMetrics);
        case 'breakdown':
            return buildBreakdownSQL(plan, model, apdmeMetrics);
        case 'trend':
            return buildTrendSQL(plan, model, apdmeMetrics);
        case 'ranking':
            return buildRankingSQL(plan, model, apdmeMetrics);
        case 'share_of_total':
            return buildShareOfTotalSQL(plan, model);
        case 'correlation':
            return buildCorrelationSQL(plan, model);
        case 'distribution':
            return buildDistributionSQL(plan, model);
        case 'trend_comparison':
            return buildComparisonSQL(plan, model);
        case 'total_comparison':
            return buildComparisonSQL(plan, model);
        case 'aggregate_filter':
            return buildAggregateFilterSQL(plan, model, apdmeMetrics);
        case 'growth_analysis':
            return buildGrowthAnalysisSQL(plan, model);
        default:
            // Fallback: treat as breakdown
            return buildBreakdownSQL(plan, model, apdmeMetrics);
    }
}

/**
 * Try to find a matching derived metric from the plan's metric references
 * or by detecting the pattern: AVG aggregation + time dimension.
 */
function findDerivedMetric(plan: AnalysisPlan, model: SemanticModel): DerivedMetricDefinition | null {
    const derivedMetrics = model.derivedMetrics || [];
    if (derivedMetrics.length === 0) return null;

    // 1. Explicit reference via derivedMetricId
    for (const m of plan.metrics) {
        if (m.derivedMetricId) {
            const found = derivedMetrics.find(dm => dm.id === m.derivedMetricId);
            if (found) return found;
        }
    }

    // 2. Detect pattern: intent is derived_metric or (intent=single_metric with avg + time dimension)
    if (plan.intent === 'derived_metric' ||
        (plan.metrics.length === 1 && plan.metrics[0].agg === 'avg' && plan.dimensions.some(d => d.timeGrain))) {
        const metric = plan.metrics[0];
        const timeDim = plan.dimensions.find(d => d.timeGrain);
        if (metric && timeDim) {
            // Try to find a matching derived metric
            const grain = timeDim.timeGrain || 'day';
            const matchId = `avg_${grain === 'day' ? 'daily' : grain === 'week' ? 'weekly' : grain === 'month' ? 'monthly' : grain === 'quarter' ? 'quarterly' : 'yearly'}_${metric.field}`;
            const found = derivedMetrics.find(dm => dm.id === matchId);
            if (found) return found;
        }
    }

    // 3. Check question for derived metric synonyms
    const q = plan.originalQuestion.toLowerCase();
    for (const dm of derivedMetrics) {
        for (const syn of dm.synonyms) {
            if (q.includes(syn.toLowerCase())) return dm;
        }
    }

    return null;
}

/**
 * Build SQL for a derived metric (two-stage aggregation).
 * Example: avg_daily_sales â†’ 
 *   SELECT AVG(daily_total) AS avg_daily_sales
 *   FROM (SELECT order_date, SUM(sales) AS daily_total 
 *         FROM data WHERE ... GROUP BY order_date) sub
 */
function buildDerivedMetricSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    dm: DerivedMetricDefinition
): string {
    const where = buildWhereClause(plan.filters);
    const dateField = dm.groupBy.field;
    const grain = dm.groupBy.grain;
    const baseAgg = dm.baseMetric.agg.toUpperCase();
    const baseField = dm.baseMetric.field;
    const finalAgg = dm.finalAgg.toUpperCase();
    const alias = dm.id;

    // Build the grain expression for GROUP BY
    let grainExpr: string;
    const d = `CAST(${dateField} AS DATE)`;
    switch (grain) {
        case 'day':
            grainExpr = dateField;
            break;
        case 'week':
            grainExpr = `STRFTIME('%Y-W%W', ${d})`;
            break;
        case 'month':
            grainExpr = `STRFTIME('%Y-%m', ${d})`;
            break;
        case 'quarter':
            grainExpr = `STRFTIME('%Y', ${d}) || '-Q' || ((CAST(STRFTIME('%m', ${d}) AS INTEGER) - 1) / 3 + 1)`;
            break;
        case 'year':
            grainExpr = `STRFTIME('%Y', ${d})`;
            break;
        default:
            grainExpr = dateField;
    }

    // Inner query: Stage 1 aggregation per group
    const innerSQL = [
        `SELECT ${grainExpr} AS period_key, ${baseAgg}(${baseField}) AS period_total`,
        fromTable(),
        where,
        `GROUP BY ${grainExpr}`
    ].filter(Boolean).join('\n  ');

    // Outer query: Stage 2 final aggregation
    const sql = `SELECT ${finalAgg}(period_total) AS ${alias}\nFROM (\n  ${innerSQL}\n) sub`;

    logger.debug('[SQL Correction]', `Derived metric SQL for ${dm.id}:\n${sql}`);
    return sql;
}


// â”€â”€â”€ Intent-Specific Builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * single_metric: "What is total sales?" â†’ SELECT SUM(sales) AS sales_sum FROM data
 */
function buildSingleMetricSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    const selects = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const where = buildWhereClause(plan.filters);

    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);

    return parts.join('\n');
}

/**
 * breakdown: "Sales by category" â†’ SELECT category, SUM(sales) FROM data GROUP BY category
 */
function buildBreakdownSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // ── Special handling for day_of_week ──
    const dowDim = plan.dimensions.find(d => (d as any).timeGrain === 'day_of_week');
    if (dowDim) {
        return buildDayOfWeekSQL(plan, model, dowDim, 'breakdown');
    }

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);
    const orderBy = buildOrderByClause(plan);
    const limit = plan.limit ? `LIMIT ${plan.limit}` : '';

    const selects = [...dimExprs, ...metExprs];

    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    if (orderBy) parts.push(`ORDER BY ${orderBy}`);
    if (limit) parts.push(limit);

    return parts.join('\n');
}

/**
 * trend: "Monthly sales for 2017" â†’ SELECT time_grain, SUM(sales) ... ORDER BY time ASC
 */
function buildTrendSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // â”€â”€ Special handling for day_of_week â”€â”€
    const dowDim = plan.dimensions.find(d => (d as any).timeGrain === 'day_of_week');
    if (dowDim) {
        return buildDayOfWeekSQL(plan, model, dowDim, 'trend');
    }

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const timeDim = plan.dimensions.find(d => d.timeGrain);
    const timeAlias = timeDim
        ? (timeDim.timeGrain && timeDim.timeGrain !== 'day'
            ? `${timeDim.field}_${timeDim.timeGrain}`
            : timeDim.field)
        : null;

    const selects = [...dimExprs, ...metExprs];

    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`ORDER BY ${timeAlias || dimExprs[0]} ASC`);

    return parts.join('\n');
}

/**
 * ranking: "Which day had the lowest sales?" → SUM + GROUP BY + ORDER BY ASC + LIMIT 1
 * "Top 10 products by revenue" → SUM + GROUP BY + ORDER BY DESC + LIMIT 10
 */
function buildRankingSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // ── Special handling for day_of_week: scope to current week ──
    const dowDim = plan.dimensions.find(d => (d as any).timeGrain === 'day_of_week');
    if (dowDim) {
        return buildDayOfWeekSQL(plan, model, dowDim, 'ranking');
    }

    // ── Detect "Top N per group" pattern (partitioned ranking) ──
    const isPartitioned = detectPartitionedRanking(plan);
    if (isPartitioned && plan.dimensions.length >= 2) {
        return buildPartitionedRankingSQL(plan, model, apdmeMetrics);
    }

    // ── Standard (global) ranking ──
    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    // Determine sort direction (from plan or default DESC)
    const sortDir = plan.sort.length > 0 ? plan.sort[0].dir.toUpperCase() : 'DESC';
    const limit = plan.limit || 10;

    // Sort by the first metric alias
    const firstMetAlias = getMetricAlias(plan.metrics[0], model);

    const selects = [...dimExprs, ...metExprs];

    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`ORDER BY ${firstMetAlias} ${sortDir}`);
    parts.push(`LIMIT ${limit}`);

    return parts.join('\n');
}

/**
 * Detect if this ranking is asking for "Top N per group" (partitioned).
 */
function detectPartitionedRanking(plan: AnalysisPlan): boolean {
    const grain = (plan.resultGrain || '').toLowerCase();
    const question = (plan.originalQuestion || '').toLowerCase();

    if (/within each|per .+ within|in each|for each/.test(grain)) return true;
    if (/\b(within each|in each|for each|per each)\b/.test(question)) return true;
    if (/\b(top|bottom|best|worst)\s+\d+\b/.test(question) &&
        /\b(within|in each|for each|per|by)\s+(each\s+)?\w+/i.test(question) &&
        plan.dimensions.length >= 2) return true;

    return false;
}

/**
 * Build partitioned ranking with ROW_NUMBER() OVER (PARTITION BY ...).
 */
function buildPartitionedRankingSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    const partitionDim = plan.dimensions[0];
    const allDimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const sortDir = plan.sort.length > 0 ? plan.sort[0].dir.toUpperCase() : 'DESC';
    const limit = plan.limit || 5;

    const metric = plan.metrics[0];
    const metricField = `"${metric.field}"`;
    const aggExpr = metric.agg === 'count_distinct'
        ? `COUNT(DISTINCT ${metricField})`
        : `${metric.agg.toUpperCase()}(${metricField})`;

    const firstMetAlias = getMetricAlias(plan.metrics[0], model);
    const partitionCol = `"${partitionDim.field}"`;

    const innerSelects = [
        ...allDimExprs,
        ...metExprs,
        `ROW_NUMBER() OVER (PARTITION BY ${partitionCol} ORDER BY ${aggExpr} ${sortDir}) AS _rn`
    ];

    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n    ');
    const sql = `SELECT * FROM (\n    ${innerSQL}\n) sub\nWHERE _rn <= ${limit}\nORDER BY ${partitionCol}, ${firstMetAlias} ${sortDir}`;

    logger.info('[SQL Correction]', `Built partitioned ranking: top ${limit} per "${partitionDim.field}"`);
    return sql;
}

/**
 * Build SQL for day-of-week analysis.
 * Scopes to the current week (using model's anchor/max date) and shows
 * both the raw date and the day name in results.
 *
 * Example output:
 *   SELECT sale_date, DAYNAME(sale_date) AS day_name, SUM(sale_amt) AS sale_amt_sum
 *   FROM data
 *   WHERE sale_date BETWEEN '2025-12-28' AND '2026-01-03'
 *   GROUP BY sale_date
 *   ORDER BY sale_amt_sum ASC
 */
function buildDayOfWeekSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    dowDim: PlanDimension,
    intent: 'ranking' | 'breakdown' | 'trend'
): string {
    const dateField = dowDim.field;
    const metExprs = buildMetricExpressions(plan.metrics, model);

    // Compute current week boundaries from anchor date
    const anchorStr = model.timeContext?.anchorDate || model.timeContext?.maxDate || new Date().toISOString().split('T')[0];
    const anchor = new Date(anchorStr + 'T12:00:00Z');
    const dayOfWeek = anchor.getUTCDay(); // 0=Sun, 6=Sat

    // Week runs Sunday â†’ Saturday
    const weekStart = new Date(anchor);
    weekStart.setUTCDate(anchor.getUTCDate() - dayOfWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

    const fmtDate = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    const weekStartStr = fmtDate(weekStart);
    const weekEndStr = fmtDate(weekEnd);

    // Build WHERE â€” merge any existing filters with the week filter
    const existingWhere = buildWhereClause(plan.filters);
    const weekFilter = `${dateField} BETWEEN '${weekStartStr}' AND '${weekEndStr}'`;
    const fullWhere = existingWhere
        ? `${existingWhere} AND ${weekFilter}`
        : weekFilter;

    // SELECT both the raw date and the day name
    const selects = [
        dateField,
        `DAYNAME(CAST(${dateField} AS DATE)) AS day_name`,
        ...metExprs,
    ];

    // Sort
    const sortDir = plan.sort.length > 0 ? plan.sort[0].dir.toUpperCase() : 'DESC';
    const firstMetAlias = getMetricAlias(plan.metrics[0], model);

    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
        `WHERE ${fullWhere}`,
        `GROUP BY ${dateField}`,
    ];

    if (intent === 'ranking') {
        parts.push(`ORDER BY ${firstMetAlias} ${sortDir}`);
        if (plan.limit) parts.push(`LIMIT ${plan.limit}`);
    } else {
        parts.push(`ORDER BY ${dateField} ASC`);
    }

    console.log(`[SQL Correction] day_of_week: scoped to week ${weekStartStr} â†’ ${weekEndStr} (anchor: ${anchorStr})`);
    return parts.join('\n');
}

/**
 * share_of_total: "What percent of sales is each region?"
 * â†’ SELECT region, SUM(sales), SUM(sales) * 100.0 / (SELECT SUM(sales) FROM data) AS share_pct
 */
function buildShareOfTotalSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);
    const whereClause = where ? `WHERE ${where}` : '';

    const metExprParts: string[] = [];
    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const aggExpr = `${met.agg.toUpperCase()}(${met.field})`;
        const alias = `${met.field}_${met.agg}`;
        metExprParts.push(`${aggExpr} AS ${alias}`);
        // Add percentage column
        metExprParts.push(
            `ROUND(${aggExpr} * 100.0 / (SELECT ${met.agg.toUpperCase()}(${met.field}) ${fromTable()} ${whereClause}), 2) AS ${met.field}_pct`
        );
    }

    const selects = [...dimExprs, ...metExprParts];
    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`ORDER BY ${plan.metrics[0] ? `${plan.metrics[0].field}_${plan.metrics[0].agg}` : '1'} DESC`);

    return parts.join('\n');
}

/**
 * correlation: "Sales vs profit by product"
 * â†’ SELECT product, SUM(sales) AS sales_sum, SUM(profit) AS profit_sum ... GROUP BY product
 */
function buildCorrelationSQL(plan: AnalysisPlan, model: SemanticModel): string {
    // Same as breakdown but with multiple metrics
    return buildBreakdownSQL(plan, model);
}

/**
 * distribution: "Distribution of order values"
 * â†’ Histogram with fixed-width buckets
 */
function buildDistributionSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const met = plan.metrics[0];
    if (!met) return buildBreakdownSQL(plan, model);

    const field = `"${met.field}"`;
    const where = buildWhereClause(plan.filters);
    const whereClause = where ? ` WHERE ${where}` : '';

    return [
        `WITH stats AS (SELECT MIN(${field}) as mn, MAX(${field}) as mx, (MAX(${field}) - MIN(${field})) / 10.0 as bucket_width ${fromTable()}${whereClause})`,
        `SELECT`,
        `  CONCAT(CAST(FLOOR(${field} / NULLIF(bucket_width, 0)) * bucket_width AS INT), '-', CAST(FLOOR(${field} / NULLIF(bucket_width, 0)) * bucket_width + bucket_width AS INT)) as "${met.field}_range",`,
        `  COUNT(*) as count`,
        `FROM ${TABLE_REF}, stats${whereClause}`,
        `GROUP BY 1 ORDER BY 1`
    ].join('\n');
}

/**
 * Build SQL for aggregate_filter intent — "products with above-average sales"
 *
 * Generates GROUP BY + HAVING with scoped AVG subqueries.
 * Supports multi-condition HAVING and composite metric references.
 *
 * Example output:
 *   SELECT "product_name", SUM("sales") AS sales_sum,
 *          SUM("profit") / NULLIF(SUM("sales"), 0) * 100 AS net_profit_margin_pct
 *   FROM "data"
 *   WHERE ... (pre-aggregate filters)
 *   GROUP BY "product_name"
 *   HAVING SUM("sales") > (SELECT AVG(grp_total) FROM (
 *              SELECT SUM("sales") AS grp_total FROM "data" WHERE ... GROUP BY "product_name"
 *          ))
 *      AND SUM("profit") / NULLIF(SUM("sales"), 0) * 100 < (SELECT AVG(grp_metric) FROM (
 *              SELECT SUM("profit") / NULLIF(SUM("sales"), 0) * 100 AS grp_metric
 *              FROM "data" WHERE ... GROUP BY "product_name"
 *          ))
 */
/**
 * ROW-LEVEL "above/below the average <attribute>" — a listing, not an aggregate.
 *
 * "Which products have a price above the average product price?" is a row filter:
 *   SELECT product_name FROM data WHERE price > (SELECT AVG(price) FROM data)
 * NOT a GROUP BY … HAVING AVG(price) > … (which the analytical engine defaults to,
 * and which also leaks an extra metric column). This fires only when the compared
 * field is an AVG-comparison attribute (agg 'avg' or no distinct metric) and the
 * user is listing entities — leaving "products whose TOTAL sales are above
 * average" (agg 'sum') on the HAVING path where it belongs.
 */
function tryRowLevelAvgFilterSQL(plan: AnalysisPlan, model: SemanticModel): string | null {
    // A composite HAVING (margin, AOV, …) is a genuine aggregate filter — leave it.
    // The row-level case is distinguished by the AVG aggregation below, not isHaving.
    const aa = plan.filters.find(f => !f.compositeRef && ['above_avg', 'below_avg'].includes(f.op as string));
    if (!aa || plan.dimensions.length === 0) return null;

    // Only when the comparison is against a per-row value's MEAN, not an aggregate.
    const m = plan.metrics.find(mm => mm.field?.toLowerCase() === aa.field.toLowerCase());
    const isRowLevel = m ? m.agg === 'avg' : plan.metrics.length === 0
        || plan.metrics.every(mm => mm.field?.toLowerCase() === aa.field.toLowerCase());
    if (!isRowLevel) return null;

    const dims = buildDimensionExpressions(plan.dimensions).join(', ');
    const cmp = aa.op === 'above_avg' ? '>' : '<';
    const otherWhere = buildWhereClause(plan.filters); // excludes the above/below_avg filter
    const scalar = `${q(aa.field)} ${cmp} (SELECT AVG(${q(aa.field)}) ${fromTable()})`;
    const whereClause = [otherWhere, scalar].filter(Boolean).join(' AND ');

    const parts = [`SELECT ${dims}`, fromTable(), `WHERE ${whereClause}`];
    if (plan.sort.length > 0) {
        // Order by the RAW attribute (a real column), never the aggregate alias the
        // planner may have attached — there is no GROUP BY / metric column here.
        const dir = (plan.sort[0].dir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        parts.push(`ORDER BY ${q(aa.field)} ${dir}`);
    }
    if (plan.limit) parts.push(`LIMIT ${plan.limit}`);
    return parts.join('\n');
}

function buildAggregateFilterSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // Row-level "above/below the average <attribute>" listing takes precedence.
    const rowLevel = tryRowLevelAvgFilterSQL(plan, model);
    if (rowLevel) {
        logger.info('[SQL Correction]', 'Row-level above/below-average filter (projection, no GROUP BY)');
        return rowLevel;
    }

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters); // Only pre-aggregate filters

    // Collect HAVING filters. ONLY the aggregate-vs-average ops belong here —
    // the planner sometimes flags a text filter (contains / does_not_contain) as
    // isHaving, which previously became SUM(text_column) and crashed DuckDB.
    const isNumericField = (name: string): boolean => {
        const f = model.fields.find(fl => fl.name.toLowerCase() === name.toLowerCase());
        if (!f) return false;
        return f.physicalType === 'number'
            || ['currency', 'quantity', 'count', 'ratio', 'percentage'].includes(f.semanticType);
    };
    const havingFilters = plan.filters.filter(f => {
        if (!['above_avg', 'below_avg'].includes(normalizeFilterOp(f.op))) return false;
        // Never aggregate a non-numeric column (unless it's a governed composite).
        return f.compositeRef ? true : isNumericField(f.field);
    });

    if (havingFilters.length === 0) {
        // No HAVING conditions — fall back to regular breakdown
        logger.warn('[SQL Correction]', 'aggregate_filter intent but no HAVING filters found. Falling back to breakdown.');
        return buildBreakdownSQL(plan, model, apdmeMetrics);
    }

    // Build the HAVING clause with scoped AVG subqueries
    const havingParts: string[] = [];

    for (const hf of havingFilters) {
        // Determine the aggregate expression for this filter
        let aggExpr: string;

        if (hf.compositeRef) {
            // Composite metric — use the governed weighted formula
            const composite = model.compositeMetrics.find(m => m.id === hf.compositeRef);
            if (composite) {
                aggExpr = composite.formula;
                logger.info('[SQL Correction]', `HAVING uses composite metric: ${composite.id} → ${composite.formula}`);
            } else {
                logger.warn('[SQL Correction]', `Composite metric "${hf.compositeRef}" not found. Using SUM(${hf.field}).`);
                aggExpr = `SUM(${q(hf.field)})`;
            }
        } else {
            // Standard field — find its default aggregation from the plan metrics
            const planMetric = plan.metrics.find(m => m.field.toLowerCase() === hf.field.toLowerCase());
            const agg = planMetric?.agg || 'sum';
            aggExpr = `${agg.toUpperCase()}(${q(hf.field)})`;
        }

        // Build the scoped AVG subquery
        // Uses the same WHERE filters and GROUP BY as the outer query
        const subqueryWhere = where ? `WHERE ${where}` : '';
        const comparison = hf.op === 'above_avg' ? '>' : '<';

        const subquery = [
            `SELECT AVG(grp_metric) FROM (`,
            `  SELECT ${aggExpr} AS grp_metric`,
            `  ${fromTable()}`,
            subqueryWhere ? `  ${subqueryWhere}` : '',
            groupBy ? `  GROUP BY ${groupBy}` : '',
            `)`,
        ].filter(Boolean).join('\n');

        const averageCondition = `${aggExpr} ${comparison} (${subquery})`;
        const condition = hf.includeNonPositive
            ? `(${averageCondition} OR ${aggExpr} <= 0)`
            : averageCondition;
        havingParts.push(condition);
        logger.info(
            '[SQL Correction]',
            `HAVING condition: ${averageCondition}${hf.includeNonPositive ? ' OR non-positive' : ''}`,
        );
    }

    // Assemble the full query
    const selects = [...dimExprs, ...metExprs];
    const parts = [
        `SELECT ${selects.join(', ')}`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`HAVING ${havingParts.join('\n   AND ')}`);

    // Add ORDER BY
    if (plan.sort.length > 0) {
        const orderBy = buildOrderByClause(plan);
        if (orderBy) parts.push(orderBy);
    } else {
        // Default: order by first metric DESC
        const firstAlias = getMetricAlias(plan.metrics[0], model);
        parts.push(`ORDER BY ${firstAlias} DESC`);
    }

    if (plan.limit) {
        parts.push(`LIMIT ${plan.limit}`);
    }

    return parts.join('\n');
}

/**
 * Build SQL for growth_analysis intent — "Which products are driving revenue growth?"
 *
 * Splits the dataset timeline into two equal halves (or uses explicit date filters),
 * computes per-entity totals for each period, then calculates growth percentage.
 *
 * Example output:
 *   SELECT "product_name",
 *          SUM(CASE WHEN "order_date" >= '2024-07-01' THEN "sales" ELSE 0 END) AS current_period,
 *          SUM(CASE WHEN "order_date" < '2024-07-01' THEN "sales" ELSE 0 END) AS previous_period,
 *          ROUND(CASE WHEN SUM(CASE WHEN "order_date" < '2024-07-01' THEN "sales" ELSE 0 END) > 0
 *              THEN (SUM(CASE WHEN "order_date" >= '2024-07-01' THEN "sales" ELSE 0 END) -
 *                    SUM(CASE WHEN "order_date" < '2024-07-01' THEN "sales" ELSE 0 END)) /
 *                    SUM(CASE WHEN "order_date" < '2024-07-01' THEN "sales" ELSE 0 END) * 100
 *              ELSE NULL END, 2) AS growth_pct
 *   FROM "data"
 *   GROUP BY "product_name"
 *   ORDER BY growth_pct DESC
 */
function buildGrowthAnalysisSQL(plan: AnalysisPlan, model: SemanticModel): string {
    // Find the primary date field
    const dateField = model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
        || model.timeContext?.primaryDateColumn
        || 'order_date';

    // Find the metric field
    const metricField = plan.metrics.length > 0 ? plan.metrics[0].field : 'sales';
    const metricAgg = plan.metrics.length > 0 ? plan.metrics[0].agg : 'sum';
    const aggFn = metricAgg.toUpperCase();

    // Determine the dimension (what entities to compare — products, categories, etc.)
    const dimField = plan.dimensions.length > 0 ? plan.dimensions[0].field : null;

    if (!dimField) {
        // No dimension — fall back to overall growth as single metric
        logger.warn('[SQL Correction]', 'growth_analysis without dimension — falling back to breakdown');
        return buildBreakdownSQL(plan, model);
    }

    // Determine the midpoint for period splitting
    // Strategy: use the dataset's date range midpoint
    const minDate = model.timeContext?.minDate || '2024-01-01';
    const maxDate = model.timeContext?.maxDate || model.timeContext?.anchorDate || new Date().toISOString().split('T')[0];

    // Calculate midpoint
    const minMs = new Date(minDate + 'T00:00:00Z').getTime();
    const maxMs = new Date(maxDate + 'T00:00:00Z').getTime();
    const midMs = minMs + Math.floor((maxMs - minMs) / 2);
    const midDate = new Date(midMs).toISOString().split('T')[0];

    logger.info('[SQL Correction]', `Growth analysis: date range ${minDate} → ${maxDate}, midpoint: ${midDate}`);

    // Check for explicit date filter override
    const dateFilter = plan.filters.find(f =>
        f.field.toLowerCase() === dateField.toLowerCase() && f.op === 'between'
    );

    let currentStart: string, previousEnd: string, splitPoint: string;
    if (dateFilter && Array.isArray(dateFilter.value) && dateFilter.value.length === 2) {
        // Use explicit filter range — split in half
        const fMinMs = new Date(dateFilter.value[0] + 'T00:00:00Z').getTime();
        const fMaxMs = new Date(dateFilter.value[1] + 'T00:00:00Z').getTime();
        const fMidMs = fMinMs + Math.floor((fMaxMs - fMinMs) / 2);
        splitPoint = new Date(fMidMs).toISOString().split('T')[0];
        currentStart = splitPoint;
        previousEnd = splitPoint;
    } else {
        splitPoint = midDate;
        currentStart = splitPoint;
        previousEnd = splitPoint;
    }

    // Build the WHERE clause (excluding date filters since we handle them via CASE)
    const nonDateFilters = plan.filters.filter(f =>
        f.field.toLowerCase() !== dateField.toLowerCase() && !f.isHaving
    );
    const where = buildWhereClause(nonDateFilters);

    // Build CASE WHEN expressions for period splitting
    const qDateField = q(dateField);
    const qMetricField = q(metricField);

    // TRY_CAST so a metric loaded as text (CSV) doesn't break the aggregate.
    const qMetricNum = `TRY_CAST(${qMetricField} AS DOUBLE)`;
    const currentExpr = `${aggFn}(CASE WHEN CAST(${qDateField} AS DATE) >= DATE '${currentStart}' THEN ${qMetricNum} ELSE 0 END)`;
    const previousExpr = `${aggFn}(CASE WHEN CAST(${qDateField} AS DATE) < DATE '${previousEnd}' THEN ${qMetricNum} ELSE 0 END)`;

    const growthExpr = `ROUND(CASE WHEN ${previousExpr} > 0 THEN (${currentExpr} - ${previousExpr}) / ${previousExpr} * 100 ELSE NULL END, 2)`;

    const parts = [
        `SELECT ${q(dimField)},`,
        `  ${currentExpr} AS current_period,`,
        `  ${previousExpr} AS previous_period,`,
        `  ${growthExpr} AS growth_pct`,
        fromTable(),
    ];
    if (where) parts.push(`WHERE ${where}`);
    parts.push(`GROUP BY ${q(dimField)}`);

    // Sort direction — default DESC (highest growth first)
    const sortDir = plan.sort.length > 0 ? plan.sort[0].dir.toUpperCase() : 'DESC';
    parts.push(`ORDER BY growth_pct ${sortDir} NULLS LAST`);

    if (plan.limit) {
        parts.push(`LIMIT ${plan.limit}`);
    }

    return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW FUNCTION UTILITIES
// These helpers generate window-function-enriched SQL for various
// analytical patterns. They can be invoked by any builder function.
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a RANK/DENSE_RANK/ROW_NUMBER window query.
 * Used for: "Rank products by sales", "Top 3 per category"
 *
 * Output:
 *   SELECT *, RANK() OVER (PARTITION BY category ORDER BY SUM(sales) DESC) AS rank
 *   FROM (inner grouped query)
 *   WHERE rank <= N
 */
function buildRankWindowSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    options: {
        rankFn?: 'RANK' | 'DENSE_RANK' | 'ROW_NUMBER';
        partitionBy?: string;
        orderByExpr: string;
        orderDir?: 'ASC' | 'DESC';
        topN?: number;
    }
): string {
    const { rankFn = 'RANK', partitionBy, orderByExpr, orderDir = 'DESC', topN } = options;

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const partitionClause = partitionBy ? `PARTITION BY ${q(partitionBy)} ` : '';
    const windowExpr = `${rankFn}() OVER (${partitionClause}ORDER BY ${orderByExpr} ${orderDir}) AS row_rank`;

    const innerSelects = [...dimExprs, ...metExprs];
    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n');

    if (topN) {
        return [
            `SELECT *, ${windowExpr}`,
            `FROM (${innerSQL}) sub`,
            `WHERE row_rank <= ${topN}`,
            `ORDER BY ${partitionBy ? q(partitionBy) + ', ' : ''}row_rank`,
        ].join('\n');
    }

    return [
        `SELECT *, ${windowExpr}`,
        `FROM (${innerSQL}) sub`,
        `ORDER BY row_rank`,
    ].join('\n');
}

/**
 * Build a running total / running average window query.
 * Used for: "Running total of sales by month", "Cumulative revenue"
 *
 * Output:
 *   SELECT month, sales_sum,
 *          SUM(sales_sum) OVER (ORDER BY month ROWS UNBOUNDED PRECEDING) AS running_total
 *   FROM (inner grouped query)
 */
function buildRunningTotalSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    options: {
        windowFn?: 'SUM' | 'AVG' | 'COUNT';
        orderByField: string;
        metricAlias: string;
        partitionBy?: string;
    }
): string {
    const { windowFn = 'SUM', orderByField, metricAlias, partitionBy } = options;

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const partitionClause = partitionBy ? `PARTITION BY ${q(partitionBy)} ` : '';
    const windowExpr = `${windowFn}(${metricAlias}) OVER (${partitionClause}ORDER BY ${q(orderByField)} ROWS UNBOUNDED PRECEDING) AS running_${windowFn.toLowerCase()}`;

    const innerSelects = [...dimExprs, ...metExprs];
    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n');

    return [
        `SELECT *, ${windowExpr}`,
        `FROM (${innerSQL}) sub`,
        `ORDER BY ${q(orderByField)}`,
    ].join('\n');
}

function buildMovingAverageSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    options: {
        orderByField: string;
        metricAlias: string;
        partitionBy?: string;
        preceding: number;
    }
): string {
    const { orderByField, metricAlias, partitionBy, preceding } = options;

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const partitionClause = partitionBy ? `PARTITION BY ${q(partitionBy)} ` : '';
    const windowExpr = `AVG(${metricAlias}) OVER (${partitionClause}ORDER BY ${q(orderByField)} ROWS BETWEEN ${preceding} PRECEDING AND CURRENT ROW) AS moving_avg`;

    const innerSelects = [...dimExprs, ...metExprs];
    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n');

    return [
        `SELECT *, ${windowExpr}`,
        `FROM (${innerSQL}) sub`,
        `ORDER BY ${q(orderByField)}`,
    ].join('\n');
}

/**
 * Build a LAG/LEAD window query for period-over-period comparison.
 * Used for: "Month-over-month sales change", "Previous month comparison"
 *
 * Output:
 *   SELECT month, sales_sum,
 *          LAG(sales_sum, 1) OVER (ORDER BY month) AS prev_period,
 *          ROUND((sales_sum - LAG(sales_sum, 1) OVER (ORDER BY month)) /
 *                NULLIF(LAG(sales_sum, 1) OVER (ORDER BY month), 0) * 100, 2) AS change_pct
 *   FROM (inner grouped query)
 */
function buildLagLeadSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    options: {
        windowFn?: 'LAG' | 'LEAD';
        offset?: number;
        orderByField: string;
        metricAlias: string;
        partitionBy?: string;
        includeChangePct?: boolean;
    }
): string {
    const { windowFn = 'LAG', offset = 1, orderByField, metricAlias, partitionBy, includeChangePct = true } = options;

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const partitionClause = partitionBy ? `PARTITION BY ${q(partitionBy)} ` : '';
    const lagExpr = `${windowFn}(${metricAlias}, ${offset}) OVER (${partitionClause}ORDER BY ${q(orderByField)})`;

    const windowSelects = [
        `${lagExpr} AS prev_period`,
    ];

    if (includeChangePct) {
        windowSelects.push(
            `ROUND(CASE WHEN ${lagExpr} > 0 THEN (${metricAlias} - ${lagExpr}) / ${lagExpr} * 100 ELSE NULL END, 2) AS change_pct`
        );
    }

    const innerSelects = [...dimExprs, ...metExprs];
    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n');

    return [
        `SELECT *, ${windowSelects.join(', ')}`,
        `FROM (${innerSQL}) sub`,
        `ORDER BY ${q(orderByField)}`,
    ].join('\n');
}

/**
 * Build NTILE window query for percentile/quartile analysis.
 * Used for: "Sales quartiles", "Top 25% of products"
 *
 * Output:
 *   SELECT *, NTILE(4) OVER (ORDER BY sales_sum DESC) AS quartile
 *   FROM (inner grouped query)
 */
function buildNtileSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    options: {
        buckets?: number;
        orderByExpr: string;
        orderDir?: 'ASC' | 'DESC';
        partitionBy?: string;
    }
): string {
    const { buckets = 4, orderByExpr, orderDir = 'DESC', partitionBy } = options;

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    const partitionClause = partitionBy ? `PARTITION BY ${q(partitionBy)} ` : '';
    const ntileExpr = `NTILE(${buckets}) OVER (${partitionClause}ORDER BY ${orderByExpr} ${orderDir}) AS quartile`;

    const innerSelects = [...dimExprs, ...metExprs];
    const innerParts = [
        `SELECT ${innerSelects.join(', ')}`,
        fromTable(),
    ];
    if (where) innerParts.push(`WHERE ${where}`);
    if (groupBy) innerParts.push(`GROUP BY ${groupBy}`);

    const innerSQL = innerParts.join('\n');

    return [
        `SELECT *, ${ntileExpr}`,
        `FROM (${innerSQL}) sub`,
        `ORDER BY quartile, ${orderByExpr} ${orderDir}`,
    ].join('\n');
}

/**
 * Compound average: "Average daily sales this month"
 * â†’ SELECT AVG(daily_total) FROM (SELECT date, SUM(sales) AS daily_total FROM data WHERE ... GROUP BY date) sub
 */
function buildCompoundAverageSQL(plan: AnalysisPlan, model: SemanticModel): string {
    // Find the date dimension
    const dateDim = plan.dimensions.find(d => {
        const f = model.fields.find(fld => fld.name.toLowerCase() === d.field.toLowerCase());
        return f?.semanticType === 'date';
    });

    const dateField = dateDim?.field
        || model.fields.find(f => f.semanticType === 'date')?.name
        || 'order_date';

    const grain = dateDim?.timeGrain || 'day';
    const where = buildWhereClause(plan.filters);

    // Inner query: SUM per grain period
    const innerSelects: string[] = [];
    const outerSelects: string[] = [];

    if (grain === 'day') {
        innerSelects.push(dateField);
    } else {
        innerSelects.push(`${timeGrainExpr(dateField, grain)} AS grain_period`);
    }

    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const alias = `${met.field}_period_total`;
        innerSelects.push(`SUM(${met.field}) AS ${alias}`);
        outerSelects.push(`AVG(${alias}) AS ${met.field}_avg`);
    }

    const innerGroupBy = grain === 'day' ? dateField : timeGrainExpr(dateField, grain);

    const parts = [
        `SELECT ${outerSelects.join(', ')}`,
        `FROM (`,
        `  SELECT ${innerSelects.join(', ')}`,
        `  ${fromTable()}`,
    ];
    if (where) parts.push(`  WHERE ${where}`);
    parts.push(`  GROUP BY ${innerGroupBy}`);
    parts.push(`) sub`);

    return parts.join('\n');
}

/**
 * comparison: "Sales this month vs last month"
 * total_comparison â†’ two aggregated values with period labels
 * trend_comparison â†’ two time series with period labels overlaid
 */
function buildComparisonSQL(plan: AnalysisPlan, model: SemanticModel): string {
    if (!plan.comparison) return buildBreakdownSQL(plan, model);

    // Find the date filter to determine the current period
    const dateFilter = plan.filters.find(f => {
        const field = model.fields.find(fld => fld.name.toLowerCase() === f.field.toLowerCase());
        return field?.semanticType === 'date';
    });

    if (!dateFilter || dateFilter.op !== 'between' || !Array.isArray(dateFilter.value)) {
        // No proper date filter â€” fall back to regular breakdown
        return buildBreakdownSQL(plan, model);
    }

    const dateField = q(dateFilter.field);
    const currentStart = dateFilter.value[0];
    const currentEnd = dateFilter.value[1];

    // Calculate previous period dates
    const prevDates = calculatePreviousPeriod(currentStart, currentEnd, plan.comparison.type);

    // Reuse the hardened metric builder — inherits the additivity guard (no SUM
    // of a rate), TRY_CAST (no "avg(VARCHAR)"), and identifier quoting.
    const metExprs = buildMetricExpressions(plan.metrics, model);

    // Contribution / mix-shift: a categorical dimension + comparison → the
    // per-segment current-vs-previous delta ("what drove the change"). Never on a
    // row-identifier dimension (order_id) — that produces one group per row.
    const catDim = plan.dimensions.find(d => !d.timeGrain && !isRowIdentifier(d.field, model));
    if (catDim) {
        return buildContributionSQL(plan, model, dateField, currentStart, currentEnd, prevDates, catDim.field);
    }

    if (plan.comparison.mode === 'total') {
        // Total comparison: two rows (current + previous) with a period label
        const sql = [
            `SELECT 'Current' AS period, ${metExprs.join(', ')}`,
            fromTable(),
            `WHERE ${dateRangePredicate(dateField, currentStart, currentEnd)}`,
            `UNION ALL`,
            `SELECT 'Previous' AS period, ${metExprs.join(', ')}`,
            fromTable(),
            `WHERE ${dateRangePredicate(dateField, prevDates.start, prevDates.end)}`,
        ];
        return sql.join('\n');
    }

    // Trend comparison: two time series UNIONed with period labels
    const grain = plan.comparison.grain || 'day';
    const timeDim = plan.dimensions.find(d => d.timeGrain);
    const grainField = timeDim?.field || dateField;
    const grainExpr = grain === 'day' ? grainField : timeGrainExpr(grainField, grain);
    const grainAlias = grain === 'day' ? grainField : `${grainField}_${grain}`;

    const sql = [
        `SELECT 'Current' AS period, ${grainExpr} AS ${grainAlias}, ${metExprs.join(', ')}`,
        fromTable(),
        `WHERE ${dateField} BETWEEN DATE '${currentStart}' AND DATE '${currentEnd}'`,
        `GROUP BY ${grainExpr}`,
        `UNION ALL`,
        `SELECT 'Previous' AS period, ${grainExpr} AS ${grainAlias}, ${metExprs.join(', ')}`,
        fromTable(),
        `WHERE ${dateField} BETWEEN DATE '${prevDates.start}' AND DATE '${prevDates.end}'`,
        `GROUP BY ${grainExpr}`,
        `ORDER BY ${grainAlias} ASC`,
    ];

    return sql.join('\n');
}

/** The aggregate expression for one metric, used in the contribution CTEs. */
function contributionAgg(m: PlanMetric): string {
    const col = q(m.field);
    switch (m.agg) {
        case 'count': return m.field === '*' ? 'COUNT(*)' : `COUNT(${col})`;
        case 'count_distinct': return `COUNT(DISTINCT ${col})`;
        case 'avg': return `AVG(TRY_CAST(${col} AS DOUBLE))`;
        case 'min': return `MIN(TRY_CAST(${col} AS DOUBLE))`;
        case 'max': return `MAX(TRY_CAST(${col} AS DOUBLE))`;
        default: return `SUM(TRY_CAST(${col} AS DOUBLE))`;
    }
}

/**
 * Contribution / mix-shift: for a categorical dimension over two periods, the
 * per-segment current value, previous value, and the delta each segment
 * contributed to the total change — ranked. Deterministic; answers "what drove
 * the change in <metric> by <dimension>".
 */
function buildContributionSQL(
    plan: AnalysisPlan, model: SemanticModel, dateField: string,
    curStart: string, curEnd: string, prevDates: { start: string; end: string }, dimFieldName: string,
): string {
    const dimCol = q(dimFieldName);
    const aggExpr = contributionAgg(plan.metrics[0] || { field: '*', agg: 'count' } as PlanMetric);
    const period = (s: string, e: string) =>
        `SELECT ${dimCol} AS __d, ${aggExpr} AS __v ${fromTable()} ` +
        `WHERE ${dateRangePredicate(dateField, s, e)} GROUP BY ${dimCol}`;
    return [
        `WITH cur AS (${period(curStart, curEnd)}),`,
        `     prev AS (${period(prevDates.start, prevDates.end)})`,
        `SELECT COALESCE(cur.__d, prev.__d) AS ${dimCol},`,
        `       COALESCE(cur.__v, 0) AS current_value,`,
        `       COALESCE(prev.__v, 0) AS previous_value,`,
        `       COALESCE(cur.__v, 0) - COALESCE(prev.__v, 0) AS contribution`,
        `FROM cur FULL OUTER JOIN prev ON cur.__d = prev.__d`,
        `ORDER BY contribution DESC`,
    ].join('\n');
}


// â”€â”€â”€ SQL Safety Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Quote a SQL identifier with double quotes (safe for spaces, dots, reserved words) */
function q(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Escape a string literal value (prevents SQL injection from values like O'Brien) */
function esc(val: string): string {
    return val.replace(/'/g, "''");
}

// â”€â”€â”€ Shared Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Build SELECT expressions for metrics.
 * Handles: sum, avg, count, count_distinct, min, max, and composite formulas.
 */
function buildMetricExpressions(metrics: PlanMetric[], model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string[] {
    const exprs: string[] = [];

    for (const met of metrics) {
        // â”€â”€â”€ APDME Derived Metrics (highest priority) â”€â”€â”€
        // If this metric has a derivedMetricId, use the pre-built expression
        // from the APDME engine (e.g., AVG(JULIANDAY(x) - JULIANDAY(y)))
        if (met.derivedMetricId && apdmeMetrics?.length) {
            const derived = apdmeMetrics.find(d => d.name === met.derivedMetricId);
            if (derived) {
                exprs.push(`${derived.aggregatedExpression} AS ${derived.alias}`);
                logger.debug('[SQL Correction]', `Using APDME derived metric: ${derived.aggregatedExpression}`);
                continue;
            }
        }

        // Composite metrics: use the governed formula
        if (met.compositeId) {
            const composite = model.compositeMetrics.find(m => m.id === met.compositeId);
            if (composite) {
                exprs.push(`${composite.formula} AS ${composite.id}`);
                continue;
            }
        }

        // Row count: a "count of <entities>" question counts ROWS, not a column.
        // Emit COUNT(*) (unquoted star) rather than COUNT("*").
        if (met.field === '*') {
            exprs.push(`COUNT(*) AS ${q('count')}`);
            continue;
        }

        // Standard aggregation â€” quote all identifiers for safety
        const fld = q(met.field);

        // ── ADDITIVITY GUARD ──────────────────────────────────────────────
        // SUM of a non-additive measure (a rate, ratio, percentage, or rating)
        // is mathematically meaningless — summing "discount %" across rows gives a
        // nonsense number. The plan (from the LLM or the UI) can ask for it, but we
        // must not execute it: fall back to the measure's safe default (AVG). This
        // is what makes the answer correct even when the intent step gets it wrong.
        let agg = met.agg;
        if (agg === 'sum') {
            const field = model.fields.find(f => f.name.toLowerCase() === met.field.toLowerCase());
            if (field && NON_ADDITIVE_TYPES.has(field.semanticType)) {
                agg = (field.defaultAgg && field.defaultAgg !== 'none' ? field.defaultAgg : 'avg') as PlanMetric['agg'];
                logger.info('[SQL Correction]', `Additivity guard: SUM("${met.field}") → ${agg.toUpperCase()} (non-additive ${field.semanticType}).`);
            }
        }

        // Numeric aggregations use TRY_CAST(... AS DOUBLE): CSV/ordinal columns
        // (e.g. a 1–5 rating stored as text) would otherwise throw
        // "avg(VARCHAR)". TRY_CAST is a no-op on real numbers and yields NULL
        // (ignored by aggregates) on genuinely non-numeric values.
        const numFld = `TRY_CAST(${fld} AS DOUBLE)`;
        const fn = agg === 'count_distinct' ? `COUNT(DISTINCT ${fld})`
            : agg === 'count' ? `COUNT(${fld})`
            : agg === 'avg' ? `AVG(${numFld})`
            : agg === 'min' ? `MIN(${numFld})`
            : agg === 'max' ? `MAX(${numFld})`
            : `SUM(${numFld})`;
        exprs.push(`${fn} AS ${q(met.field + '_' + agg)}`);
    }

    return exprs;
}

// Measure semantic types where SUM is never correct — aggregate with AVG instead.
const NON_ADDITIVE_TYPES = new Set(['percentage', 'ratio', 'ordinal']);

/**
 * Build SELECT expressions for dimensions.
 * Applies time grain transformations (YEAR, MONTH, QUARTER, WEEK).
 */
function buildDimensionExpressions(dimensions: PlanDimension[]): string[] {
    return dimensions.map(dim => {
        if (dim.timeGrain && dim.timeGrain !== 'day') {
            const expr = timeGrainExpr(dim.field, dim.timeGrain);
            return `${expr} AS ${q(dim.field + '_' + dim.timeGrain)}`;
        }
        return q(dim.field);
    });
}

/**
 * Build GROUP BY clause from dimensions.
 * Uses the raw expression (not the alias) for GROUP BY.
 */
function buildGroupByClause(dimensions: PlanDimension[]): string {
    if (dimensions.length === 0) return '';

    const parts = dimensions.map(dim => {
        if (dim.timeGrain && dim.timeGrain !== 'day') {
            return timeGrainExpr(dim.field, dim.timeGrain);
        }
        return q(dim.field);
    });

    return parts.join(', ');
}

/**
 * Build WHERE clause from plan filters.
 * Handles: =, !=, >, <, >=, <=, between, in, not_in, like.
 */
function buildWhereClause(filters: PlanFilter[]): string {
    // Skip HAVING filters — they are handled separately
    const whereFilters = filters.filter(f => !f.isHaving && !['above_avg', 'below_avg'].includes(f.op));
    if (whereFilters.length === 0) return '';

    const parts: string[] = [];
    const fld = (name: string) => q(name);
    const strVal = (v: any) => `'${esc(String(v))}'`;
    const val = (v: any) => typeof v === 'string' ? strVal(v) : String(v);
    const TEMPORAL = new Set(['this_year', 'this_month', 'this_quarter', 'this_week', 'this_day']);

    for (const f of whereFilters) {
        // Relative-time filters resolve to an anchored date range, not NOW().
        if (TEMPORAL.has(f.op)) {
            const r = resolveTemporalRange(f.op);
            if (r) {
                parts.push(dateRangePredicate(fld(f.field), r.start, r.end));
            } else {
                logger.warn('[SQL Correction]', `Temporal filter "${f.op}" on "${f.field}" could not be resolved (no anchor date). Filter skipped.`);
            }
            continue;
        }
        switch (f.op) {
            case '=':
                parts.push(`${fld(f.field)} = ${val(f.value)}`);
                break;
            case '!=':
                parts.push(`${fld(f.field)} != ${val(f.value)}`);
                break;
            case '>': case '<': case '>=': case '<=':
                parts.push(`${fld(f.field)} ${f.op} ${val(f.value)}`);
                break;
            case 'between':
                if (Array.isArray(f.value) && f.value.length === 2) {
                    parts.push(`${fld(f.field)} BETWEEN ${strVal(f.value[0])} AND ${strVal(f.value[1])}`);
                }
                break;
            case 'in':
                if (Array.isArray(f.value)) {
                    const vals = f.value.map(v => val(v)).join(', ');
                    parts.push(`${fld(f.field)} IN (${vals})`);
                }
                break;
            case 'not_in':
                if (Array.isArray(f.value)) {
                    const vals = f.value.map(v => val(v)).join(', ');
                    parts.push(`${fld(f.field)} NOT IN (${vals})`);
                }
                break;
            case 'like':
                parts.push(`${fld(f.field)} LIKE ${strVal(f.value)}`);
                break;
            default:
                logger.warn('[SQL Correction]', `Unknown filter op: "${f.op}" for field "${f.field}". Filter skipped.`);
                break;
        }
    }

    return parts.join(' AND ');
}

/**
 * Build ORDER BY clause from the plan's sort specification.
 */
function buildOrderByClause(plan: AnalysisPlan): string {
    if (plan.sort.length === 0) return '';

    return plan.sort.map(s => {
        // Check if sorting by a dimension with time grain
        const dimMatch = plan.dimensions.find(d => d.field === s.field);
        if (dimMatch && dimMatch.timeGrain && dimMatch.timeGrain !== 'day') {
            return `${q(dimMatch.field + '_' + dimMatch.timeGrain)} ${s.dir.toUpperCase()}`;
        }
        return `${q(s.field)} ${s.dir.toUpperCase()}`;
    }).join(', ');
}

/**
 * Get the column alias for a metric in the SELECT clause.
 */
function getMetricAlias(met: PlanMetric, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    if (met.derivedMetricId && apdmeMetrics?.length) {
        const derived = apdmeMetrics.find(d => d.name === met.derivedMetricId);
        if (derived) return derived.alias;
    }
    if (met.compositeId) {
        return met.compositeId;
    }
    if (met.agg === 'count_distinct') {
        return q(`${met.field}_count_distinct`);
    }
    return q(`${met.field}_${met.agg}`);
}

/**
 * Convert a date field to a time grain expression.
 * Uses DuckDB-compatible functions: YEAR(), QUARTER(), STRFTIME(), etc.
 */
function timeGrainExpr(field: string, grain: string): string {
    // Wrap with CAST to handle VARCHAR date columns in DuckDB
    const d = `CAST(${q(field)} AS DATE)`;
    switch (grain) {
        case 'year':
            return `YEAR(${d})`;
        case 'quarter':
            return `CONCAT(YEAR(${d}), '-Q', QUARTER(${d}))`;
        case 'month':
            return `STRFTIME('%Y-%m', ${d})`;
        case 'week':
            // CAST WEEK() (BIGINT) to VARCHAR — LPAD requires a string first arg.
            return `CONCAT(YEAR(${d}), '-W', LPAD(CAST(WEEK(${d}) AS VARCHAR), 2, '0'))`;
        case 'day_of_week':
            return `DAYNAME(${d})`;
        case 'month_of_year':
            return `MONTHNAME(${d})`;
        case 'hour':
            return `HOUR(CAST(${q(field)} AS TIMESTAMP))`;
        default:
            return field;
    }
}

/**
 * Calculate previous period dates given a current period range.
 * Supports: previous_period, same_period_last_year
 */
function calculatePreviousPeriod(
    startStr: string,
    endStr: string,
    type: 'previous_period' | 'same_period_last_year' | 'custom'
): { start: string; end: string } {
    const start = new Date(startStr + 'T12:00:00Z');
    const end = new Date(endStr + 'T12:00:00Z');

    const fmtDate = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    if (type === 'same_period_last_year') {
        const prevStart = new Date(start);
        prevStart.setUTCFullYear(prevStart.getUTCFullYear() - 1);
        const prevEnd = new Date(end);
        prevEnd.setUTCFullYear(prevEnd.getUTCFullYear() - 1);
        return { start: fmtDate(prevStart), end: fmtDate(prevEnd) };
    }

    // Detect calendar-month-aligned range: starts on 1st, ends on last day of month
    const isMonthAligned = start.getUTCDate() === 1 &&
        end.getUTCDate() === new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();

    if (isMonthAligned) {
        // Shift back by the FULL number of months in the range, not just one.
        // Q1 2024 (3 months) → Q4 2023, H1 2024 (6 months) → H2 2023, a single
        // month → the prior month. Previously this always shifted by one month,
        // so a quarter was compared against just its preceding month.
        const monthsSpan = (end.getUTCFullYear() * 12 + end.getUTCMonth())
            - (start.getUTCFullYear() * 12 + start.getUTCMonth()) + 1;
        const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0)); // last day of month before start
        const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - monthsSpan, 1));
        return { start: fmtDate(prevStart), end: fmtDate(prevEnd) };
    }

    // Detect calendar-quarter-aligned range
    const isQuarterAligned = start.getUTCDate() === 1 && [0, 3, 6, 9].includes(start.getUTCMonth()) &&
        end.getUTCDate() === new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() &&
        (end.getUTCMonth() - start.getUTCMonth() === 2);

    if (isQuarterAligned) {
        const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1));
        const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0));
        return { start: fmtDate(prevStart), end: fmtDate(prevEnd) };
    }

    // Detect calendar-year-aligned range
    const isYearAligned = start.getUTCMonth() === 0 && start.getUTCDate() === 1 &&
        end.getUTCMonth() === 11 && end.getUTCDate() === 31;

    if (isYearAligned) {
        return {
            start: `${start.getUTCFullYear() - 1}-01-01`,
            end: `${start.getUTCFullYear() - 1}-12-31`,
        };
    }

    // Non-aligned: shift back by duration (standard approach)
    const durationMs = end.getTime() - start.getTime();
    const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));

    const prevEnd = new Date(start);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setUTCDate(prevStart.getUTCDate() - durationDays + 1); // +1 so both periods have same count

    return { start: fmtDate(prevStart), end: fmtDate(prevEnd) };
}
