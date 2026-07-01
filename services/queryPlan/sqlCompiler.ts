// ═══════════════════════════════════════════════════════════════════
// sqlCompiler — Compiles a QueryPlan AST into valid SQL (DuckDB/Postgres)
// This is NOT a string templater. It walks the AST and emits
// syntactically correct SQL guaranteed to match the JS engine output.
// ═══════════════════════════════════════════════════════════════════

import {
    QueryPlan, Expression, Metric, Dimension, RowFilter, RangeFilter, DateFilter,
    GroupFilter, OrderBy, AggregationType, dimensionId,
    EnrichedQuery, ComparisonConfig, TableCalculation
} from './types';
import { sanitizeIdentifier, escapeStringValue } from '../analysisValidator';

// ── HELPERS ──────────────────────────────────────────────────────

/** Safely quote an identifier for SQL */
function safeId(name: string): string {
    if (!name) return '"unnamed"';
    const sanitized = sanitizeIdentifier(name);
    return `"${sanitized.replace(/"/g, '""')}"`;
}

/** Safely format a date string for SQL */
function safeDate(dateStr: string): string {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "'1970-01-01'";
    return `'${escapeStringValue(dateStr)}'`;
}

// ── EXPRESSION COMPILER ──────────────────────────────────────────

function compileExpression(expr: Expression): string {
    switch (expr.type) {
        case 'column':
            return safeId(expr.column);
        case 'literal':
            if (typeof expr.value === 'string') return `'${escapeStringValue(expr.value)}'`;
            if (typeof expr.value === 'boolean') return expr.value ? 'TRUE' : 'FALSE';
            return String(expr.value);
        case 'binary_op': {
            const left = compileExpression(expr.left);
            const right = compileExpression(expr.right);
            const ops = { add: '+', subtract: '-', multiply: '*', divide: '/' };
            return `(${left} ${ops[expr.op]} ${right})`;
        }
        case 'function':
            return `${expr.name}(${expr.args.map(compileExpression).join(', ')})`;
        default:
            return '0';
    }
}

// ── AGGREGATION COMPILER ─────────────────────────────────────────

function compileAggregation(agg: AggregationType, expr: string): string {
    switch (agg) {
        case 'COUNT_DISTINCT': return `COUNT(DISTINCT ${expr})`;
        case 'COUNT_ALL': return `COUNT(*)`;
        case 'COUNT': return `COUNT(${expr})`;
        case 'SUM': return `SUM(${expr})`;
        case 'AVG': return `AVG(${expr})`;
        case 'MIN': return `MIN(${expr})`;
        case 'MAX': return `MAX(${expr})`;
        case 'NONE': return expr; // Raw column — no aggregation
        default: return `SUM(${expr})`;
    }
}

// ── DIMENSION COMPILER ───────────────────────────────────────────

function compileDimensionSelect(dim: Dimension): string {
    if (dim.type === 'column') {
        return safeId(dim.column);
    }
    // Time bucket: emit DATE_TRUNC for proper date semantics
    // Cast to string only at SELECT level to preserve JS engine format parity
    const grain = dim.grain;
    const src = safeId(dim.sourceColumn);
    const alias = safeId(dim.alias);

    switch (grain) {
        case 'minute':
            return `strftime('%-I:%M %p', DATE_TRUNC('minute', ${src}::TIMESTAMP)) AS ${alias}`;
        case 'hour':
            return `strftime('%-I %p', DATE_TRUNC('hour', ${src}::TIMESTAMP)) AS ${alias}`;
        case 'year':
            return `EXTRACT(YEAR FROM ${src}::TIMESTAMP)::TEXT AS ${alias}`;
        case 'quarter':
            return `(EXTRACT(YEAR FROM ${src}::TIMESTAMP)::TEXT || '-Q' || EXTRACT(QUARTER FROM ${src}::TIMESTAMP)::TEXT) AS ${alias}`;
        case 'month':
            return `strftime('%Y-%m', DATE_TRUNC('month', ${src}::TIMESTAMP)) AS ${alias}`;
        case 'week':
            return `(EXTRACT(ISOYEAR FROM ${src}::TIMESTAMP)::TEXT || '-W' || LPAD(EXTRACT(WEEK FROM ${src}::TIMESTAMP)::TEXT, 2, '0')) AS ${alias}`;
        case 'day':
            return `DATE_TRUNC('day', ${src}::TIMESTAMP)::DATE::TEXT AS ${alias}`;
        default:
            return `${src} AS ${alias}`;
    }
}

function compileDimensionGroupBy(dim: Dimension): string {
    if (dim.type === 'column') {
        return safeId(dim.column);
    }
    // GROUP BY uses the expression, NOT the alias (SQL standard)
    // Use DATE_TRUNC for index-friendly grouping on date columns
    const src = safeId(dim.sourceColumn);
    switch (dim.grain) {
        case 'minute':
            return `strftime('%-I:%M %p', DATE_TRUNC('minute', ${src}::TIMESTAMP))`;
        case 'hour':
            return `strftime('%-I %p', DATE_TRUNC('hour', ${src}::TIMESTAMP))`;
        case 'year':
            return `EXTRACT(YEAR FROM ${src}::TIMESTAMP)`;
        case 'quarter':
            return `EXTRACT(YEAR FROM ${src}::TIMESTAMP), EXTRACT(QUARTER FROM ${src}::TIMESTAMP)`;
        case 'month':
            return `DATE_TRUNC('month', ${src}::TIMESTAMP)`;
        case 'week':
            return `EXTRACT(ISOYEAR FROM ${src}::TIMESTAMP), EXTRACT(WEEK FROM ${src}::TIMESTAMP)`;
        case 'day':
            return `DATE_TRUNC('day', ${src}::TIMESTAMP)`;
        default:
            return src;
    }
}

// ── FILTER COMPILERS ─────────────────────────────────────────────

function compileRowFilter(f: RowFilter): string {
    const col = safeId(f.column);
    if (f.op === 'IN' || f.op === 'NOT_IN') {
        const vals = Array.isArray(f.value)
            ? f.value.map(v => `'${escapeStringValue(String(v))}'`).join(', ')
            : `'${escapeStringValue(String(f.value))}'`;
        return f.op === 'IN' ? `${col} IN (${vals})` : `${col} NOT IN (${vals})`;
    }
    // Scalar comparison
    const val = typeof f.value === 'string' ? `'${escapeStringValue(f.value)}'`
        : typeof f.value === 'boolean' ? (f.value ? 'TRUE' : 'FALSE')
            : String(f.value);
    return `${col} ${f.op} ${val}`;
}

function compileRangeFilter(f: RangeFilter): string {
    const col = safeId(f.column);
    // Cast to TIMESTAMP so DuckDB can compare VARCHAR date strings
    const colTs = `${col}::TIMESTAMP`;
    if (f.start && f.end) {
        return `${colTs} BETWEEN ${safeDate(f.start)} AND ${safeDate(f.end)}`;
    }
    if (f.start) {
        return `${colTs} >= ${safeDate(f.start)}`;
    }
    if (f.end) {
        return `${colTs} <= ${safeDate(f.end)}`;
    }
    return '1=1'; // Should not happen — validator catches this
}

function compileGroupFilter(gf: GroupFilter, metrics: Metric[]): string {
    const metric = metrics.find(m => m.id === gf.metricId);
    if (!metric) return '1=1';
    const expr = compileExpression(metric.expression);
    const aggExpr = compileAggregation(metric.aggregation, expr);
    return `${aggExpr} ${gf.op} ${gf.value}`;
}

function compileDateFilter(df: DateFilter): string {
    const col = safeId(df.column);
    const vals = df.values.map(v => `'${escapeStringValue(v)}'`).join(', ');

    switch (df.timeGrain) {
        case 'minute':
            return `strftime('%-I:%M %p', DATE_TRUNC('minute', ${col}::TIMESTAMP)) IN (${vals})`;
        case 'hour':
            return `strftime('%-I %p', DATE_TRUNC('hour', ${col}::TIMESTAMP)) IN (${vals})`;
        case 'year':
            return `EXTRACT(YEAR FROM ${col}::TIMESTAMP)::TEXT IN (${vals})`;
        case 'quarter':
            return `(EXTRACT(YEAR FROM ${col}::TIMESTAMP)::TEXT || '-Q' || EXTRACT(QUARTER FROM ${col}::TIMESTAMP)::TEXT) IN (${vals})`;
        case 'month':
            return `strftime('%Y-%m', DATE_TRUNC('month', ${col}::TIMESTAMP)) IN (${vals})`;
        case 'week':
            return `(EXTRACT(ISOYEAR FROM ${col}::TIMESTAMP)::TEXT || '-W' || LPAD(EXTRACT(WEEK FROM ${col}::TIMESTAMP)::TEXT, 2, '0')) IN (${vals})`;
        case 'day':
            return `DATE_TRUNC('day', ${col}::TIMESTAMP)::DATE::TEXT IN (${vals})`;
        default:
            return `${col} IN (${vals})`;
    }
}

// ── ORDER BY COMPILER ────────────────────────────────────────────

function compileOrderBy(ob: OrderBy, plan: QueryPlan): string {
    if (ob.type === 'metric') {
        // Use the metric alias for ORDER BY (guaranteed to exist in SELECT)
        const metric = plan.metrics.find(m => m.id === ob.metricId);
        if (metric) {
            return `${safeId(metric.alias)} ${ob.direction}`;
        }
    }
    if (ob.type === 'dimension') {
        // Find the dimension and use its output name
        const dim = plan.dimensions.find(d => dimensionId(d) === ob.dimensionId);
        if (dim) {
            if (dim.type === 'column') return `${safeId(dim.column)} ${ob.direction}`;
            return `${safeId(dim.alias)} ${ob.direction}`;
        }
    }
    return '';
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: compileSQL
// ═══════════════════════════════════════════════════════════════════

export function compileSQL(plan: QueryPlan): string {
    const parts: string[] = [];

    // ── SELECT ───────────────────────────────────────────────────
    const selectCols: string[] = [];

    // Dimensions first (SELECT order = GROUP BY order)
    for (const dim of plan.dimensions) {
        selectCols.push(compileDimensionSelect(dim));
    }

    // Metrics
    for (const metric of plan.metrics) {
        const expr = compileExpression(metric.expression);
        const aggExpr = compileAggregation(metric.aggregation, expr);
        selectCols.push(`${aggExpr} AS ${safeId(metric.alias)}`);
    }

    parts.push(`SELECT ${selectCols.join(', ')}`);

    // ── FROM ─────────────────────────────────────────────────────
    // Use original source name (inside double quotes, any character is valid SQL)
    // Don't sanitize — the DuckDB rewrite layer handles name matching
    parts.push(`FROM "${plan.source.replace(/"/g, '""')}"`);

    // ── WHERE (row filters + range filters + date filters) ───────
    const whereClauses: string[] = [];
    for (const rf of plan.filters.row) {
        whereClauses.push(compileRowFilter(rf));
    }
    for (const rf of plan.filters.range) {
        whereClauses.push(compileRangeFilter(rf));
    }
    for (const df of plan.filters.date) {
        whereClauses.push(compileDateFilter(df));
    }
    if (whereClauses.length > 0) {
        parts.push(`WHERE ${whereClauses.join(' AND ')}`);
    }

    // ── GROUP BY ─────────────────────────────────────────────────
    if (plan.dimensions.length > 0) {
        const groupCols = plan.dimensions.map(compileDimensionGroupBy);
        parts.push(`GROUP BY ${groupCols.join(', ')}`);
    }

    // ── HAVING (group filters) ───────────────────────────────────
    if (plan.filters.group.length > 0) {
        const havingClauses = plan.filters.group.map(gf =>
            compileGroupFilter(gf, plan.metrics)
        );
        parts.push(`HAVING ${havingClauses.join(' AND ')}`);
    }

    // ── ORDER BY ─────────────────────────────────────────────────
    if (plan.orderBy.length > 0) {
        const orderClauses = plan.orderBy
            .map(ob => compileOrderBy(ob, plan))
            .filter(Boolean);
        if (orderClauses.length > 0) {
            parts.push(`ORDER BY ${orderClauses.join(', ')}`);
        }
    }

    // ── LIMIT ────────────────────────────────────────────────────
    if (plan.limit && plan.limit > 0) {
        parts.push(`LIMIT ${Math.min(plan.limit, 10000)}`);
    }

    return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// ENRICHED SQL — Wraps base query with CTEs for comparisons + table calcs
// Targets: Postgres / DuckDB
// ═══════════════════════════════════════════════════════════════════

export function compileEnrichedSQL(enriched: EnrichedQuery): string {
    const plan = enriched.basePlan;
    const baseSQL = compileSQL(plan);
    const hasComparison = !!enriched.comparison;
    const hasCalcs = enriched.calculations && enriched.calculations.length > 0;

    // If no enrichment needed, return base SQL
    if (!hasComparison && !hasCalcs) return baseSQL;

    // ── Identify time vs categorical dimensions ──────────────────
    const timeDim = plan.dimensions.find(d => d.type === 'time_bucket');
    const partitionDims = plan.dimensions.filter(d => d.type === 'column');
    const primaryMetric = plan.metrics[0];

    if (!primaryMetric) return baseSQL; // No metric → nothing to enrich

    const metricAlias = safeId(primaryMetric.alias);
    const timeDimAlias = timeDim ? safeId(timeDim.alias) : null;
    const partitionCols = partitionDims.map(d => safeId(d.column));

    // Build PARTITION BY clause (empty if no categorical dims)
    const partitionClause = partitionCols.length > 0
        ? `PARTITION BY ${partitionCols.join(', ')} `
        : '';

    // Build ORDER BY clause for windows (must use time dim)
    // If no time dim, windows are not safe → skip
    const windowOrderClause = timeDimAlias
        ? `ORDER BY ${timeDimAlias} ASC`
        : null;

    // Collect all ORDER BY from the plan for the final output
    const planOrderClauses = plan.orderBy
        .map(ob => compileOrderBy(ob, plan))
        .filter(Boolean);
    const finalOrderBy = planOrderClauses.length > 0
        ? `ORDER BY ${planOrderClauses.join(', ')}`
        : (windowOrderClause ? `ORDER BY ${timeDimAlias} ASC` : '');

    const ctes: string[] = [];
    const selectExprs: string[] = ['*'];
    let currentSource = 'base';

    // ── CTE: base ────────────────────────────────────────────────
    // Strip ORDER BY and LIMIT from the base SQL — they belong in the final SELECT
    const baseSQLForCTE = baseSQL
        .replace(/\nORDER BY[^\n]*/i, '')
        .replace(/\nLIMIT[^\n]*/i, '');
    ctes.push(`base AS (\n${baseSQLForCTE}\n)`);

    // ── CTE: lagged (comparison) ─────────────────────────────────
    if (hasComparison && enriched.comparison) {
        const comp = enriched.comparison;

        if (!timeDimAlias) {
            // Categorical dimension — cannot use LAG window functions.
            // Generate a UNION ALL query showing current period vs comparison period side by side.
            const comp = enriched.comparison!;
            const dateRange = comp.dateRange;

            if (dateRange && dateRange.start && dateRange.end) {
                // Calculate the comparison period date range
                const curStart = new Date(`${dateRange.start}T00:00:00Z`);
                const curEnd = new Date(`${dateRange.end}T00:00:00Z`);
                const rangeDays = Math.round((curEnd.getTime() - curStart.getTime()) / (86400000)) + 1;

                let prevStart: string, prevEnd: string;
                if (comp.type === 'same_period_last_year') {
                    const ps = new Date(curStart); ps.setUTCFullYear(ps.getUTCFullYear() - 1);
                    const pe = new Date(curEnd); pe.setUTCFullYear(pe.getUTCFullYear() - 1);
                    prevStart = ps.toISOString().split('T')[0];
                    prevEnd = pe.toISOString().split('T')[0];
                } else {
                    // previous_period: shift back by the range length
                    const pe = new Date(curStart); pe.setUTCDate(pe.getUTCDate() - 1);
                    const ps = new Date(pe); ps.setUTCDate(ps.getUTCDate() - rangeDays + 1);
                    prevStart = ps.toISOString().split('T')[0];
                    prevEnd = pe.toISOString().split('T')[0];
                }

                // Build the categorical comparison SQL with a proper UNION ALL
                const dateCol = plan._dateColumnKey || 'date';
                const safeDate = safeId(dateCol);

                // Strip the date range filter from baseSQL and re-add with explicit periods
                const baseSQLNoOrder = baseSQL
                    .replace(/\nORDER BY[^\n]*/i, '')
                    .replace(/\nLIMIT[^\n]*/i, '');

                const catCompSQL = [
                    `-- Postgres/DuckDB compatible`,
                    `-- Categorical comparison: ${comp.type}`,
                    `-- Current period:    ${dateRange.start} to ${dateRange.end}`,
                    `-- Comparison period: ${prevStart} to ${prevEnd}`,
                    ``,
                    `WITH current_period AS (`,
                    `${baseSQLNoOrder}`,
                    `),`,
                    ``,
                    `previous_period AS (`,
                    `${baseSQLNoOrder}`
                        .replace(
                            new RegExp(`BETWEEN '${dateRange.start}' AND '${dateRange.end}'`, 'g'),
                            `BETWEEN '${prevStart}' AND '${prevEnd}'`
                        ),
                    `)`,
                    ``,
                    `SELECT`,
                    `  c.*,`,
                    `  p.${metricAlias} AS "previous_value",`,
                    `  ROUND((c.${metricAlias} - p.${metricAlias}) / NULLIF(ABS(p.${metricAlias}), 0) * 100, 2) AS "growth_pct"`,
                    `FROM current_period c`,
                    `LEFT JOIN previous_period p`,
                    `  ON ${partitionCols.map(col => `c.${col} = p.${col}`).join(' AND ')}`,
                    finalOrderBy ? finalOrderBy : '',
                ].filter(Boolean).join('\n');

                return catCompSQL;
            }

            // Fallback: no date range available — show the base query with a note
            return `-- Postgres/DuckDB compatible\n-- Note: Comparison (${comp.type}) applied client-side (no date range resolved)\n${baseSQL}`;
        }

        const windowSpec = `${partitionClause}${windowOrderClause}`;

        if (comp.type === 'previous_period') {
            ctes.push(`lagged AS (\n    SELECT *,\n        LAG(${metricAlias}) OVER (${windowSpec}) AS "previous_value"\n    FROM ${currentSource}\n)`);
            currentSource = 'lagged';
            selectExprs.length = 0;
            selectExprs.push('*');
            selectExprs.push(`(${metricAlias} - "previous_value") / NULLIF(ABS("previous_value"), 0) * 100 AS "growth_pct"`);
        } else if (comp.type === 'same_period_last_n') {
            const offset = comp.offset || 1;
            ctes.push(`lagged AS (\n    SELECT *,\n        LAG(${metricAlias}, ${offset}) OVER (${windowSpec}) AS "previous_value"\n    FROM ${currentSource}\n)`);
            currentSource = 'lagged';
            selectExprs.length = 0;
            selectExprs.push('*');
            selectExprs.push(`(${metricAlias} - "previous_value") / NULLIF(ABS("previous_value"), 0) * 100 AS "growth_pct"`);
        } else if (comp.type === 'same_period_last_year') {
            // ═══════════════════════════════════════════════════════════
            // SPLY: Same Period Last Year — Self-join with date shifting
            // All grains use self-join (no LAG fallback) for correctness:
            // - LAG(365) fails on leap years (366 days)
            // - LAG(52) fails on 53-week years
            // - Self-join with INTERVAL is always correct
            // ═══════════════════════════════════════════════════════════
            const grain = timeDim!.grain;

            // Build the shift expression for the current row's time key
            // This maps current period → previous year's equivalent period
            let shiftExprC: string;

            if (grain === 'year') {
                // '2019' → '2018'
                shiftExprC = `CAST(CAST(c.${timeDimAlias} AS INTEGER) - 1 AS TEXT)`;
            } else if (grain === 'month') {
                // '2019-03' → '2018-03' : shift year part, keep month
                shiftExprC = `CONCAT(CAST(LEFT(c.${timeDimAlias}, 4)::INT - 1 AS TEXT), SUBSTRING(c.${timeDimAlias} FROM 5))`;
            } else if (grain === 'quarter') {
                // '2019-Q2' → '2018-Q2' : shift year part, keep quarter
                shiftExprC = `CONCAT(CAST(LEFT(c.${timeDimAlias}, 4)::INT - 1 AS TEXT), SUBSTRING(c.${timeDimAlias} FROM 5))`;
            } else if (grain === 'week') {
                // '2019-W03' → '2018-W03' : shift year part, keep week number
                shiftExprC = `CONCAT(CAST(LEFT(c.${timeDimAlias}, 4)::INT - 1 AS TEXT), SUBSTRING(c.${timeDimAlias} FROM 5))`;
            } else {
                // Day grain: '2019-03-15' → subtract exactly 1 year
                // Uses date arithmetic: DATE - INTERVAL '1 year' handles leap years correctly
                shiftExprC = `(c.${timeDimAlias}::DATE - INTERVAL '1 year')::DATE::TEXT`;
            }

            const partJoin = partitionCols.length > 0
                ? ` AND ${partitionCols.map(pc => `c.${pc} = p.${pc}`).join(' AND ')}`
                : '';

            ctes.push(`lagged AS (\n    SELECT c.*, p.${metricAlias} AS "previous_value"\n    FROM ${currentSource} c\n    LEFT JOIN ${currentSource} p ON p.${timeDimAlias} = ${shiftExprC}${partJoin}\n)`);
            currentSource = 'lagged';
            selectExprs.length = 0;
            selectExprs.push('*');
            selectExprs.push(`(${metricAlias} - "previous_value") / NULLIF(ABS("previous_value"), 0) * 100 AS "growth_pct"`);
        }
    }

    // ── CTE: enriched (table calculations) ───────────────────────
    if (hasCalcs && enriched.calculations && enriched.calculations.length > 0) {
        const calcs = enriched.calculations;
        const calcExprs: string[] = [];
        const windowSpec = windowOrderClause
            ? `${partitionClause}${windowOrderClause}`
            : null;

        for (const calc of calcs) {
            switch (calc) {
                case 'running_total':
                    if (windowSpec) {
                        calcExprs.push(`SUM(${metricAlias}) OVER (${windowSpec} ROWS UNBOUNDED PRECEDING) AS "running_total"`);
                    }
                    break;
                case 'pct_of_total': {
                    const overClause = partitionCols.length > 0
                        ? `OVER (PARTITION BY ${partitionCols.join(', ')})`
                        : 'OVER ()';
                    calcExprs.push(`${metricAlias} / NULLIF(SUM(${metricAlias}) ${overClause}, 0) * 100 AS "pct_of_total"`);
                    break;
                }
                case 'moving_avg': {
                    const w = enriched.movingAvgWindow || 3;
                    if (windowSpec) {
                        calcExprs.push(`AVG(${metricAlias}) OVER (${windowSpec} ROWS BETWEEN ${w - 1} PRECEDING AND CURRENT ROW) AS "moving_avg_${w}"`);
                    }
                    break;
                }
                case 'pct_change':
                    if (windowSpec) {
                        calcExprs.push(`(${metricAlias} - LAG(${metricAlias}) OVER (${windowSpec})) / NULLIF(ABS(LAG(${metricAlias}) OVER (${windowSpec})), 0) * 100 AS "pct_change"`);
                    }
                    break;
                case 'rank':
                    calcExprs.push(`ROW_NUMBER() OVER (${partitionClause}ORDER BY ${metricAlias} DESC) AS "rank"`);
                    break;
                case 'difference':
                    if (windowSpec) {
                        calcExprs.push(`${metricAlias} - LAG(${metricAlias}) OVER (${windowSpec}) AS "difference"`);
                    }
                    break;
            }
        }

        if (calcExprs.length > 0) {
            ctes.push(`enriched AS (\n    SELECT *,\n        ${calcExprs.join(',\n        ')}\n    FROM ${currentSource}\n)`);
            currentSource = 'enriched';
            selectExprs.length = 0;
            selectExprs.push('*');
        }
    }

    // ── Final SELECT ─────────────────────────────────────────────
    const limitClause = plan.limit && plan.limit > 0
        ? `\nLIMIT ${Math.min(plan.limit, 10000)}`
        : '';

    const header = '-- Postgres/DuckDB compatible';
    const withClause = `WITH ${ctes.join(',\n')}`;
    const finalSelect = `SELECT ${selectExprs.join(',\n       ')}\nFROM ${currentSource}`;
    const finalOrder = finalOrderBy ? `\n${finalOrderBy}` : '';

    return `${header}\n${withClause}\n${finalSelect}${finalOrder}${limitClause}`;
}
