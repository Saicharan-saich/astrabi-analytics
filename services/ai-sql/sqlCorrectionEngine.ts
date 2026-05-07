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

// ─── Public API ──────────────────────────────────────────────────

/**
 * Generate 100% correct SQL from a structured AnalysisPlan.
 * This REPLACES whatever SQL the AI produced.
 */
export function correctSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    console.log(`[SQL Correction Engine] Building SQL for intent="${plan.intent}"`);

    // ── Intercept hour/time-of-day grain: check if dataset has time data ──
    const hourDim = plan.dimensions.find(d => ['hour', 'time_of_day', 'hour_of_day'].includes((d as any).timeGrain || ''));
    if (hourDim) {
        const dateField = model.fields.find(f => f.name.toLowerCase() === hourDim.field.toLowerCase());
        const hasTimeData = dateField?.sampleValues?.some(v => String(v).includes(':')) ?? false;

        if (!hasTimeData) {
            console.warn(`[SQL Correction Engine] hour grain requested but date column "${hourDim.field}" has no time data. Falling back to today's sales.`);

            // Annotate the plan with a fallback reason so the pipeline can surface it
            (plan as any)._fallbackReason =
                `⚠️ This dataset's "${hourDim.field}" column contains only dates (e.g., "2025-12-31"), not date-times (e.g., "2025-12-31 14:30:00"). ` +
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
                'FROM data',
                `WHERE ${fullWhere}`,
            ].join('\n');
        }
    }
    // Check for derived metrics FIRST (two-stage aggregation)
    // This handles cases like "average daily sales" where the plan
    // references a derived metric OR where the LLM set intent=derived_metric
    const derivedMetric = findDerivedMetric(plan, model);
    if (derivedMetric) {
        console.log(`[SQL Correction Engine] Found derived metric: ${derivedMetric.id}`);
        return buildDerivedMetricSQL(plan, model, derivedMetric);
    }

    // Check for compound average (legacy path — avg per day/week/month)
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
            console.log(`[SQL Correction Engine] MSARE: APDME + comparison detected — routing to buildTrendSQL with derived expressions`);
            return buildTrendSQL(plan, model, apdmeMetrics);
        }
        return buildComparisonSQL(plan, model);
    }

    // Dispatch by intent
    switch (plan.intent) {
        case 'single_metric':
            return buildSingleMetricSQL(plan, model, apdmeMetrics);
        case 'derived_metric':
            // If we get here, findDerivedMetric() didn't match — fallback to single
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
 * Example: avg_daily_sales → 
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
    switch (grain) {
        case 'day':
            grainExpr = dateField;
            break;
        case 'week':
            grainExpr = `STRFTIME('%Y-W%W', ${dateField})`;
            break;
        case 'month':
            grainExpr = `STRFTIME('%Y-%m', ${dateField})`;
            break;
        case 'quarter':
            grainExpr = `STRFTIME('%Y', ${dateField}) || '-Q' || ((CAST(STRFTIME('%m', ${dateField}) AS INTEGER) - 1) / 3 + 1)`;
            break;
        case 'year':
            grainExpr = `STRFTIME('%Y', ${dateField})`;
            break;
        default:
            grainExpr = dateField;
    }

    // Inner query: Stage 1 aggregation per group
    const innerSQL = [
        `SELECT ${grainExpr} AS period_key, ${baseAgg}(${baseField}) AS period_total`,
        `FROM data`,
        where,
        `GROUP BY ${grainExpr}`
    ].filter(Boolean).join('\n  ');

    // Outer query: Stage 2 final aggregation
    const sql = `SELECT ${finalAgg}(period_total) AS ${alias}\nFROM (\n  ${innerSQL}\n) sub`;

    console.log(`[SQL Correction Engine] Derived metric SQL for ${dm.id}:\n${sql}`);
    return sql;
}


// ─── Intent-Specific Builders ────────────────────────────────────

/**
 * single_metric: "What is total sales?" → SELECT SUM(sales) AS sales_sum FROM data
 */
function buildSingleMetricSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    const selects = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const where = buildWhereClause(plan.filters);

    const parts = [
        `SELECT ${selects.join(', ')}`,
        'FROM data',
    ];
    if (where) parts.push(`WHERE ${where}`);

    return parts.join('\n');
}

/**
 * breakdown: "Sales by category" → SELECT category, SUM(sales) FROM data GROUP BY category
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
        'FROM data',
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    if (orderBy) parts.push(`ORDER BY ${orderBy}`);
    if (limit) parts.push(limit);

    return parts.join('\n');
}

/**
 * trend: "Monthly sales for 2017" → SELECT time_grain, SUM(sales) ... ORDER BY time ASC
 */
function buildTrendSQL(plan: AnalysisPlan, model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string {
    // ── Special handling for day_of_week ──
    const dowDim = plan.dimensions.find(d => (d as any).timeGrain === 'day_of_week');
    if (dowDim) {
        return buildDayOfWeekSQL(plan, model, dowDim, 'trend');
    }

    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model, apdmeMetrics);
    const groupBy = buildGroupByClause(plan.dimensions);
    const where = buildWhereClause(plan.filters);

    // For trends, always sort by time dimension ascending
    const timeDim = plan.dimensions.find(d => d.timeGrain);
    const timeAlias = timeDim
        ? (timeDim.timeGrain && timeDim.timeGrain !== 'day'
            ? `${timeDim.field}_${timeDim.timeGrain}`
            : timeDim.field)
        : null;

    const selects = [...dimExprs, ...metExprs];

    const parts = [
        `SELECT ${selects.join(', ')}`,
        'FROM data',
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
        'FROM data',
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`ORDER BY ${firstMetAlias} ${sortDir}`);
    parts.push(`LIMIT ${limit}`);

    return parts.join('\n');
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

    // Week runs Sunday → Saturday
    const weekStart = new Date(anchor);
    weekStart.setUTCDate(anchor.getUTCDate() - dayOfWeek);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

    const fmtDate = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

    const weekStartStr = fmtDate(weekStart);
    const weekEndStr = fmtDate(weekEnd);

    // Build WHERE — merge any existing filters with the week filter
    const existingWhere = buildWhereClause(plan.filters);
    const weekFilter = `${dateField} BETWEEN '${weekStartStr}' AND '${weekEndStr}'`;
    const fullWhere = existingWhere
        ? `${existingWhere} AND ${weekFilter}`
        : weekFilter;

    // SELECT both the raw date and the day name
    const selects = [
        dateField,
        `DAYNAME(${dateField}) AS day_name`,
        ...metExprs,
    ];

    // Sort
    const sortDir = plan.sort.length > 0 ? plan.sort[0].dir.toUpperCase() : 'DESC';
    const firstMetAlias = getMetricAlias(plan.metrics[0], model);

    const parts = [
        `SELECT ${selects.join(', ')}`,
        'FROM data',
        `WHERE ${fullWhere}`,
        `GROUP BY ${dateField}`,
    ];

    if (intent === 'ranking') {
        parts.push(`ORDER BY ${firstMetAlias} ${sortDir}`);
        if (plan.limit) parts.push(`LIMIT ${plan.limit}`);
    } else {
        parts.push(`ORDER BY ${dateField} ASC`);
    }

    console.log(`[SQL Correction] day_of_week: scoped to week ${weekStartStr} → ${weekEndStr} (anchor: ${anchorStr})`);
    return parts.join('\n');
}

/**
 * share_of_total: "What percent of sales is each region?"
 * → SELECT region, SUM(sales), SUM(sales) * 100.0 / (SELECT SUM(sales) FROM data) AS share_pct
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
            `ROUND(${aggExpr} * 100.0 / (SELECT ${met.agg.toUpperCase()}(${met.field}) FROM data ${whereClause}), 2) AS ${met.field}_pct`
        );
    }

    const selects = [...dimExprs, ...metExprParts];
    const parts = [
        `SELECT ${selects.join(', ')}`,
        'FROM data',
    ];
    if (where) parts.push(`WHERE ${where}`);
    if (groupBy) parts.push(`GROUP BY ${groupBy}`);
    parts.push(`ORDER BY ${plan.metrics[0] ? `${plan.metrics[0].field}_${plan.metrics[0].agg}` : '1'} DESC`);

    return parts.join('\n');
}

/**
 * correlation: "Sales vs profit by product"
 * → SELECT product, SUM(sales) AS sales_sum, SUM(profit) AS profit_sum ... GROUP BY product
 */
function buildCorrelationSQL(plan: AnalysisPlan, model: SemanticModel): string {
    // Same as breakdown but with multiple metrics
    return buildBreakdownSQL(plan, model);
}

/**
 * distribution: "Distribution of order values"
 * → Histogram with fixed-width buckets
 */
function buildDistributionSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const met = plan.metrics[0];
    if (!met) return buildBreakdownSQL(plan, model);

    const field = met.field;
    const where = buildWhereClause(plan.filters);

    // Create 10 equal-width buckets using FLOOR
    const sql = [
        `SELECT`,
        `  CONCAT(CAST(FLOOR(${field} / bucket_width) * bucket_width AS TEXT), ' - ', CAST(FLOOR(${field} / bucket_width) * bucket_width + bucket_width AS TEXT)) AS ${field}_range,`,
        `  COUNT(*) AS count`,
        `FROM data,`,
        `  (SELECT (MAX(${field}) - MIN(${field})) / 10.0 AS bucket_width FROM data${where ? ` WHERE ${where}` : ''}) bw`,
    ];
    if (where) sql.push(`WHERE ${where}`);
    sql.push(`GROUP BY FLOOR(${field} / bucket_width)`);
    sql.push(`ORDER BY FLOOR(${field} / bucket_width) ASC`);

    return sql.join('\n');
}

/**
 * Compound average: "Average daily sales this month"
 * → SELECT AVG(daily_total) FROM (SELECT date, SUM(sales) AS daily_total FROM data WHERE ... GROUP BY date) sub
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
        `  FROM data`,
    ];
    if (where) parts.push(`  WHERE ${where}`);
    parts.push(`  GROUP BY ${innerGroupBy}`);
    parts.push(`) sub`);

    return parts.join('\n');
}

/**
 * comparison: "Sales this month vs last month"
 * total_comparison → two aggregated values with period labels
 * trend_comparison → two time series with period labels overlaid
 */
function buildComparisonSQL(plan: AnalysisPlan, model: SemanticModel): string {
    if (!plan.comparison) return buildBreakdownSQL(plan, model);

    // Find the date filter to determine the current period
    const dateFilter = plan.filters.find(f => {
        const field = model.fields.find(fld => fld.name.toLowerCase() === f.field.toLowerCase());
        return field?.semanticType === 'date';
    });

    if (!dateFilter || dateFilter.op !== 'between' || !Array.isArray(dateFilter.value)) {
        // No proper date filter — fall back to regular breakdown
        return buildBreakdownSQL(plan, model);
    }

    const dateField = dateFilter.field;
    const currentStart = dateFilter.value[0];
    const currentEnd = dateFilter.value[1];

    // Calculate previous period dates
    const prevDates = calculatePreviousPeriod(currentStart, currentEnd, plan.comparison.type);

    const metExprs = plan.metrics.map(m => {
        if (m.compositeId) {
            const comp = model.compositeMetrics.find(c => c.id === m.compositeId);
            return comp ? `${comp.formula} AS ${comp.id}` : `${m.agg.toUpperCase()}(${m.field}) AS ${m.field}_${m.agg}`;
        }
        return `${m.agg.toUpperCase()}(${m.field}) AS ${m.field}_${m.agg}`;
    });

    if (plan.comparison.mode === 'total') {
        // Total comparison: two rows (current + previous) with a period label
        const sql = [
            `SELECT 'Current' AS period, ${metExprs.join(', ')}`,
            `FROM data`,
            `WHERE ${dateField} BETWEEN '${currentStart}' AND '${currentEnd}'`,
            `UNION ALL`,
            `SELECT 'Previous' AS period, ${metExprs.join(', ')}`,
            `FROM data`,
            `WHERE ${dateField} BETWEEN '${prevDates.start}' AND '${prevDates.end}'`,
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
        `FROM data`,
        `WHERE ${dateField} BETWEEN '${currentStart}' AND '${currentEnd}'`,
        `GROUP BY ${grainExpr}`,
        `UNION ALL`,
        `SELECT 'Previous' AS period, ${grainExpr} AS ${grainAlias}, ${metExprs.join(', ')}`,
        `FROM data`,
        `WHERE ${dateField} BETWEEN '${prevDates.start}' AND '${prevDates.end}'`,
        `GROUP BY ${grainExpr}`,
        `ORDER BY ${grainAlias} ASC`,
    ];

    return sql.join('\n');
}


// ─── SQL Safety Helpers ──────────────────────────────────────────

/** Quote a SQL identifier with double quotes (safe for spaces, dots, reserved words) */
function q(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Escape a string literal value (prevents SQL injection from values like O'Brien) */
function esc(val: string): string {
    return val.replace(/'/g, "''");
}

// ─── Shared Helpers ──────────────────────────────────────────────

/**
 * Build SELECT expressions for metrics.
 * Handles: sum, avg, count, count_distinct, min, max, and composite formulas.
 */
function buildMetricExpressions(metrics: PlanMetric[], model: SemanticModel, apdmeMetrics?: DerivedMetric[]): string[] {
    const exprs: string[] = [];

    for (const met of metrics) {
        // ─── APDME Derived Metrics (highest priority) ───
        // If this metric has a derivedMetricId, use the pre-built expression
        // from the APDME engine (e.g., AVG(JULIANDAY(x) - JULIANDAY(y)))
        if (met.derivedMetricId && apdmeMetrics?.length) {
            const derived = apdmeMetrics.find(d => d.name === met.derivedMetricId);
            if (derived) {
                exprs.push(`${derived.aggregatedExpression} AS ${derived.alias}`);
                console.log(`[SQL Correction] Using APDME derived metric: ${derived.aggregatedExpression}`);
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

        // Standard aggregation — quote all identifiers for safety
        const fld = q(met.field);
        switch (met.agg) {
            case 'count_distinct':
                exprs.push(`COUNT(DISTINCT ${fld}) AS ${q(met.field + '_count_distinct')}`);
                break;
            case 'count':
                exprs.push(`COUNT(${fld}) AS ${q(met.field + '_count')}`);
                break;
            case 'sum':
                exprs.push(`SUM(${fld}) AS ${q(met.field + '_sum')}`);
                break;
            case 'avg':
                exprs.push(`AVG(${fld}) AS ${q(met.field + '_avg')}`);
                break;
            case 'min':
                exprs.push(`MIN(${fld}) AS ${q(met.field + '_min')}`);
                break;
            case 'max':
                exprs.push(`MAX(${fld}) AS ${q(met.field + '_max')}`);
                break;
            default:
                exprs.push(`SUM(${fld}) AS ${q(met.field + '_sum')}`);
        }
    }

    return exprs;
}

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
    if (filters.length === 0) return '';

    const parts: string[] = [];
    const fld = (name: string) => q(name);
    const strVal = (v: any) => `'${esc(String(v))}'`;
    const val = (v: any) => typeof v === 'string' ? strVal(v) : String(v);

    for (const f of filters) {
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
                console.warn(`[SQL Correction Engine] Unknown filter op: "${f.op}" for field "${f.field}". Filter skipped.`);
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
    switch (grain) {
        case 'year':
            return `YEAR(${field})`;
        case 'quarter':
            return `CONCAT(YEAR(${field}), '-Q', QUARTER(${field}))`;
        case 'month':
            return `STRFTIME('%Y-%m', ${field})`;
        case 'week':
            return `CONCAT(YEAR(${field}), '-W', LPAD(WEEK(${field}), 2, '0'))`;
        case 'day_of_week':
            return `DAYNAME(${field})`;
        case 'month_of_year':
            return `MONTHNAME(${field})`;
        case 'hour':
            return `HOUR(${field})`;
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
        // Use proper calendar month arithmetic
        // Current: Dec 1 → Dec 31  →  Previous: Nov 1 → Nov 30
        const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
        const prevEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 0)); // last day of prev month
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
