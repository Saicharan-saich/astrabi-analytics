/**
 * nativeAggregator.ts — Deterministic Native Aggregation Engine
 *
 * Replaces alasql for standard queries with pure JS aggregation functions.
 * Follows strict execution order: FILTER → GROUP → AGGREGATE → POST_PROCESS
 *
 * RULES:
 *   - Only predefined aggregation functions allowed
 *   - No dynamic SQL execution
 *   - Every operation is deterministic and explainable
 *   - System MUST FAIL on unknown aggregation types
 *
 * alasql is retained ONLY for the AI SQL Chat path (user-facing SQL execution).
 */

import { AggregationType } from '../types';
import type { SemanticMeasure } from './semanticModel';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface AggregateConfig {
    /** Column to aggregate */
    metricColumn: string;
    /** Aggregation function */
    aggregation: AggregationType;
    /** Column to group by (null = grand total) */
    dimensionColumn: string | null;
    /** Filters to apply before aggregation */
    filters?: FilterSpec[];
    /** Sort order for results */
    sort?: 'asc' | 'desc' | 'none';
    /** Limit number of results */
    limit?: number;
}

export interface FilterSpec {
    column: string;
    operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'IN' | 'NOT_IN';
    value: any;
}

export interface AggregateResult {
    data: Record<string, any>[];
    rowsProcessed: number;
    rowsFiltered: number;
    groupCount: number;
}

// ═══════════════════════════════════════════════════════════════════
// FILTER
// ═══════════════════════════════════════════════════════════════════

/**
 * Apply deterministic filters to rows.
 */
export function filterRows(
    rows: Record<string, any>[],
    filters: FilterSpec[]
): Record<string, any>[] {
    if (!filters || filters.length === 0) return rows;

    return rows.filter(row => {
        return filters.every(f => {
            const val = row[f.column];

            switch (f.operator) {
                case '=': return String(val).toLowerCase() === String(f.value).toLowerCase();
                case '!=': return String(val).toLowerCase() !== String(f.value).toLowerCase();
                case '>': return Number(val) > Number(f.value);
                case '<': return Number(val) < Number(f.value);
                case '>=': return Number(val) >= Number(f.value);
                case '<=': return Number(val) <= Number(f.value);
                case 'IN': {
                    const arr = Array.isArray(f.value) ? f.value : [f.value];
                    const lower = arr.map((v: any) => String(v).toLowerCase());
                    return lower.includes(String(val).toLowerCase());
                }
                case 'NOT_IN': {
                    const arr = Array.isArray(f.value) ? f.value : [f.value];
                    const lower = arr.map((v: any) => String(v).toLowerCase());
                    return !lower.includes(String(val).toLowerCase());
                }
                default:
                    throw new Error(`[NativeAggregator] Unknown filter operator: "${f.operator}"`);
            }
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
// GROUP BY
// ═══════════════════════════════════════════════════════════════════

/**
 * Group rows by a dimension column.
 * Returns a Map of dimension value → array of rows.
 */
export function groupBy(
    rows: Record<string, any>[],
    dimensionColumn: string | null
): Map<string, Record<string, any>[]> {
    const groups = new Map<string, Record<string, any>[]>();

    if (!dimensionColumn) {
        // Grand total — single group containing all rows
        groups.set('__TOTAL__', rows);
        return groups;
    }

    for (const row of rows) {
        const key = row[dimensionColumn] !== null && row[dimensionColumn] !== undefined
            ? String(row[dimensionColumn])
            : '(null)';

        const existing = groups.get(key);
        if (existing) {
            existing.push(row);
        } else {
            groups.set(key, [row]);
        }
    }

    return groups;
}

// ═══════════════════════════════════════════════════════════════════
// AGGREGATE
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute an aggregation over an array of numeric values.
 * THROWS on unknown aggregation type — no fallback.
 */
export function computeAggregation(
    values: number[],
    aggregation: AggregationType
): number {
    // Filter out nulls and NaNs
    const clean = values.filter(v => v !== null && v !== undefined && !isNaN(v));

    if (clean.length === 0) return 0;

    switch (aggregation) {
        case AggregationType.SUM:
            return clean.reduce((sum, v) => sum + v, 0);

        case AggregationType.AVG:
            return clean.reduce((sum, v) => sum + v, 0) / clean.length;

        case AggregationType.COUNT:
            return clean.length;

        case AggregationType.COUNT_DISTINCT:
            return new Set(clean.map(String)).size;

        case AggregationType.MIN:
            return Math.min(...clean);

        case AggregationType.MAX:
            return Math.max(...clean);

        default:
            throw new Error(`[NativeAggregator] Unknown aggregation type: "${aggregation}". System cannot proceed.`);
    }
}

/**
 * Count distinct string values (for COUNT_DISTINCT on non-numeric columns).
 */
export function countDistinct(values: any[]): number {
    const clean = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    return new Set(clean.map(v => String(v).toLowerCase())).size;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PIPELINE: FILTER → GROUP → AGGREGATE → SORT → LIMIT
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute a deterministic aggregation pipeline.
 *
 * Strict execution order:
 *   1. FILTER — apply all filters
 *   2. GROUP — group by dimension
 *   3. AGGREGATE — compute aggregation per group
 *   4. SORT — order results
 *   5. LIMIT — cap result count
 *
 * Returns data + metadata for explainability.
 */
export function executeAggregation(
    rows: Record<string, any>[],
    config: AggregateConfig
): AggregateResult {
    const totalRows = rows.length;

    // ── Step 1: FILTER ──
    const filteredRows = filterRows(rows, config.filters || []);
    const rowsFiltered = totalRows - filteredRows.length;

    // ── Step 2: GROUP ──
    const groups = groupBy(filteredRows, config.dimensionColumn);

    // ── Step 3: AGGREGATE ──
    const data: Record<string, any>[] = [];

    for (const [key, groupRows] of groups) {
        const metricValues = groupRows
            .map(r => r[config.metricColumn])
            .map(v => {
                if (typeof v === 'number') return v;
                if (typeof v === 'string') {
                    const parsed = parseFloat(v.replace(/[,$€£¥₹]/g, ''));
                    return isNaN(parsed) ? null : parsed;
                }
                return null;
            })
            .filter((v): v is number => v !== null);

        let value: number;

        if (config.aggregation === AggregationType.COUNT_DISTINCT) {
            // COUNT_DISTINCT works on raw values, not just numbers
            value = countDistinct(groupRows.map(r => r[config.metricColumn]));
        } else {
            value = computeAggregation(metricValues, config.aggregation);
        }

        const row: Record<string, any> = {};
        if (config.dimensionColumn) {
            row[config.dimensionColumn] = key;
        }
        row[config.metricColumn] = value;
        data.push(row);
    }

    // ── Step 4: SORT ──
    if (config.sort && config.sort !== 'none') {
        data.sort((a, b) => {
            const va = a[config.metricColumn] ?? 0;
            const vb = b[config.metricColumn] ?? 0;
            return config.sort === 'asc' ? va - vb : vb - va;
        });
    }

    // ── Step 5: LIMIT ──
    const limited = config.limit ? data.slice(0, config.limit) : data;

    return {
        data: limited,
        rowsProcessed: filteredRows.length,
        rowsFiltered,
        groupCount: groups.size,
    };
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-METRIC AGGREGATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Aggregate multiple measures over the same dimension in a single pass.
 * Used for combo charts with primary + secondary metrics.
 */
export function executeMultiMetricAggregation(
    rows: Record<string, any>[],
    measures: { column: string; aggregation: AggregationType }[],
    dimensionColumn: string | null,
    filters?: FilterSpec[],
    sort?: 'asc' | 'desc' | 'none',
    sortByColumn?: string,
    limit?: number
): AggregateResult {
    // ── Step 1: FILTER ──
    const filteredRows = filterRows(rows, filters || []);

    // ── Step 2: GROUP ──
    const groups = groupBy(filteredRows, dimensionColumn);

    // ── Step 3: AGGREGATE all measures per group ──
    const data: Record<string, any>[] = [];

    for (const [key, groupRows] of groups) {
        const row: Record<string, any> = {};
        if (dimensionColumn) {
            row[dimensionColumn] = key;
        }

        for (const measure of measures) {
            if (measure.aggregation === AggregationType.COUNT_DISTINCT) {
                row[measure.column] = countDistinct(groupRows.map(r => r[measure.column]));
            } else {
                const values = groupRows
                    .map(r => r[measure.column])
                    .map(v => typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v.replace(/[,$€£¥₹]/g, '')) : null))
                    .filter((v): v is number => v !== null && !isNaN(v));
                row[measure.column] = computeAggregation(values, measure.aggregation);
            }
        }

        data.push(row);
    }

    // ── Step 4: SORT ──
    const sortCol = sortByColumn || measures[0]?.column;
    if (sort && sort !== 'none' && sortCol) {
        data.sort((a, b) => {
            const va = a[sortCol] ?? 0;
            const vb = b[sortCol] ?? 0;
            return sort === 'asc' ? va - vb : vb - va;
        });
    }

    // ── Step 5: LIMIT ──
    const limited = limit ? data.slice(0, limit) : data;

    return {
        data: limited,
        rowsProcessed: filteredRows.length,
        rowsFiltered: rows.length - filteredRows.length,
        groupCount: groups.size,
    };
}
