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

// ─── Public API ──────────────────────────────────────────────────

/**
 * Generate 100% correct SQL from a structured AnalysisPlan.
 * This REPLACES whatever SQL the AI produced.
 */
export function correctSQL(plan: AnalysisPlan, model: SemanticModel): string {
    console.log(`[SQL Correction Engine] Building SQL for intent="${plan.intent}"`);

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
    if (plan.comparison) {
        return buildComparisonSQL(plan, model);
    }

    // Dispatch by intent
    switch (plan.intent) {
        case 'single_metric':
            return buildSingleMetricSQL(plan, model);
        case 'derived_metric':
            // If we get here, findDerivedMetric() didn't match — fallback to single
            return buildSingleMetricSQL(plan, model);
        case 'breakdown':
            return buildBreakdownSQL(plan, model);
        case 'trend':
            return buildTrendSQL(plan, model);
        case 'ranking':
            return buildRankingSQL(plan, model);
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
            return buildBreakdownSQL(plan, model);
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
function buildSingleMetricSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const selects = buildMetricExpressions(plan.metrics, model);
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
function buildBreakdownSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
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
function buildTrendSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
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
function buildRankingSQL(plan: AnalysisPlan, model: SemanticModel): string {
    const dimExprs = buildDimensionExpressions(plan.dimensions);
    const metExprs = buildMetricExpressions(plan.metrics, model);
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


// ─── Shared Helpers ──────────────────────────────────────────────

/**
 * Build SELECT expressions for metrics.
 * Handles: sum, avg, count, count_distinct, min, max, and composite formulas.
 */
function buildMetricExpressions(metrics: PlanMetric[], model: SemanticModel): string[] {
    const exprs: string[] = [];

    for (const met of metrics) {
        // Composite metrics: use the governed formula
        if (met.compositeId) {
            const composite = model.compositeMetrics.find(m => m.id === met.compositeId);
            if (composite) {
                exprs.push(`${composite.formula} AS ${composite.id}`);
                continue;
            }
        }

        // Standard aggregation
        switch (met.agg) {
            case 'count_distinct':
                exprs.push(`COUNT(DISTINCT ${met.field}) AS ${met.field}_count_distinct`);
                break;
            case 'count':
                exprs.push(`COUNT(${met.field}) AS ${met.field}_count`);
                break;
            case 'sum':
                exprs.push(`SUM(${met.field}) AS ${met.field}_sum`);
                break;
            case 'avg':
                exprs.push(`AVG(${met.field}) AS ${met.field}_avg`);
                break;
            case 'min':
                exprs.push(`MIN(${met.field}) AS ${met.field}_min`);
                break;
            case 'max':
                exprs.push(`MAX(${met.field}) AS ${met.field}_max`);
                break;
            default:
                exprs.push(`SUM(${met.field}) AS ${met.field}_sum`);
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
            return `${expr} AS ${dim.field}_${dim.timeGrain}`;
        }
        return dim.field;
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
        return dim.field;
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

    for (const f of filters) {
        switch (f.op) {
            case '=':
                parts.push(typeof f.value === 'string'
                    ? `${f.field} = '${f.value}'`
                    : `${f.field} = ${f.value}`);
                break;
            case '!=':
                parts.push(typeof f.value === 'string'
                    ? `${f.field} != '${f.value}'`
                    : `${f.field} != ${f.value}`);
                break;
            case '>': case '<': case '>=': case '<=':
                parts.push(typeof f.value === 'string'
                    ? `${f.field} ${f.op} '${f.value}'`
                    : `${f.field} ${f.op} ${f.value}`);
                break;
            case 'between':
                if (Array.isArray(f.value) && f.value.length === 2) {
                    parts.push(`${f.field} BETWEEN '${f.value[0]}' AND '${f.value[1]}'`);
                }
                break;
            case 'in':
                if (Array.isArray(f.value)) {
                    const vals = f.value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
                    parts.push(`${f.field} IN (${vals})`);
                }
                break;
            case 'not_in':
                if (Array.isArray(f.value)) {
                    const vals = f.value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
                    parts.push(`${f.field} NOT IN (${vals})`);
                }
                break;
            case 'like':
                parts.push(`${f.field} LIKE '${f.value}'`);
                break;
            default:
                // Unknown operator — log a warning so this never silently drops a filter
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
            return `${dimMatch.field}_${dimMatch.timeGrain} ${s.dir.toUpperCase()}`;
        }
        return `${s.field} ${s.dir.toUpperCase()}`;
    }).join(', ');
}

/**
 * Get the column alias for a metric in the SELECT clause.
 */
function getMetricAlias(met: PlanMetric, model: SemanticModel): string {
    if (met.compositeId) {
        return met.compositeId;
    }
    if (met.agg === 'count_distinct') {
        return `${met.field}_count_distinct`;
    }
    return `${met.field}_${met.agg}`;
}

/**
 * Convert a date field to a time grain expression.
 * Uses functions available in alasql: YEAR(), MONTH(), QUARTER().
 */
function timeGrainExpr(field: string, grain: string): string {
    switch (grain) {
        case 'year':
            return `YEAR(${field})`;
        case 'quarter':
            return `CONCAT(YEAR(${field}), '-Q', QUARTER(${field}))`;
        case 'month':
            return `CONCAT(YEAR(${field}), '-', LPAD(MONTH(${field}), 2, '0'))`;
        case 'week':
            return `CONCAT(YEAR(${field}), '-W', LPAD(WEEK(${field}), 2, '0'))`;
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
    const start = new Date(startStr);
    const end = new Date(endStr);
    const durationMs = end.getTime() - start.getTime();
    const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));

    if (type === 'same_period_last_year') {
        const prevStart = new Date(start);
        prevStart.setFullYear(prevStart.getFullYear() - 1);
        const prevEnd = new Date(end);
        prevEnd.setFullYear(prevEnd.getFullYear() - 1);
        return {
            start: prevStart.toISOString().split('T')[0],
            end: prevEnd.toISOString().split('T')[0],
        };
    }

    // previous_period: shift back by the same duration
    const prevEnd = new Date(start);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - durationDays);

    return {
        start: prevStart.toISOString().split('T')[0],
        end: prevEnd.toISOString().split('T')[0],
    };
}
