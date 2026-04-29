// ═══════════════════════════════════════════════════════════════════
// sqlCompiler — Compiles a QueryPlan AST into valid SQL (DuckDB/Postgres)
// This is NOT a string templater. It walks the AST and emits
// syntactically correct SQL guaranteed to match the JS engine output.
// ═══════════════════════════════════════════════════════════════════

import {
    QueryPlan, Expression, Metric, Dimension, RowFilter, RangeFilter, DateFilter,
    GroupFilter, OrderBy, AggregationType, dimensionId
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
        default: return `SUM(${expr})`;
    }
}

// ── DIMENSION COMPILER ───────────────────────────────────────────

function compileDimensionSelect(dim: Dimension): string {
    if (dim.type === 'column') {
        return safeId(dim.column);
    }
    // Time bucket: emit DATE_TRUNC with format normalization
    const grain = dim.grain;
    const src = safeId(dim.sourceColumn);
    const alias = safeId(dim.alias);

    // Use TO_CHAR to ensure string format matches JS output
    switch (grain) {
        case 'year':
            return `EXTRACT(YEAR FROM ${src})::TEXT AS ${alias}`;
        case 'quarter':
            return `(EXTRACT(YEAR FROM ${src})::TEXT || '-Q' || EXTRACT(QUARTER FROM ${src})::TEXT) AS ${alias}`;
        case 'month':
            return `TO_CHAR(${src}, 'YYYY-MM') AS ${alias}`;
        case 'week':
            return `(EXTRACT(YEAR FROM ${src})::TEXT || '-W' || LPAD(EXTRACT(WEEK FROM ${src})::TEXT, 2, '0')) AS ${alias}`;
        case 'day':
            return `TO_CHAR(${src}, 'YYYY-MM-DD') AS ${alias}`;
        default:
            return `${src} AS ${alias}`;
    }
}

function compileDimensionGroupBy(dim: Dimension): string {
    if (dim.type === 'column') {
        return safeId(dim.column);
    }
    // GROUP BY uses the expression, NOT the alias (SQL standard)
    const src = safeId(dim.sourceColumn);
    switch (dim.grain) {
        case 'year':
            return `EXTRACT(YEAR FROM ${src})`;
        case 'quarter':
            return `EXTRACT(YEAR FROM ${src}), EXTRACT(QUARTER FROM ${src})`;
        case 'month':
            return `TO_CHAR(${src}, 'YYYY-MM')`;
        case 'week':
            return `EXTRACT(YEAR FROM ${src}), EXTRACT(WEEK FROM ${src})`;
        case 'day':
            return `TO_CHAR(${src}, 'YYYY-MM-DD')`;
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
    if (f.start && f.end) {
        return `${col} BETWEEN ${safeDate(f.start)} AND ${safeDate(f.end)}`;
    }
    if (f.start) {
        return `${col} >= ${safeDate(f.start)}`;
    }
    if (f.end) {
        return `${col} <= ${safeDate(f.end)}`;
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
        case 'year':
            return `EXTRACT(YEAR FROM ${col})::TEXT IN (${vals})`;
        case 'quarter':
            return `(EXTRACT(YEAR FROM ${col})::TEXT || '-Q' || EXTRACT(QUARTER FROM ${col})::TEXT) IN (${vals})`;
        case 'month':
            return `TO_CHAR(${col}, 'YYYY-MM') IN (${vals})`;
        case 'week':
            return `(EXTRACT(YEAR FROM ${col})::TEXT || '-W' || LPAD(EXTRACT(WEEK FROM ${col})::TEXT, 2, '0')) IN (${vals})`;
        case 'day':
            return `TO_CHAR(${col}, 'YYYY-MM-DD') IN (${vals})`;
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
    parts.push(`FROM ${safeId(plan.source)}`);

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
