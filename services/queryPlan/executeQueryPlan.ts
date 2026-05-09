// ═══════════════════════════════════════════════════════════════════
// executeQueryPlan — JS execution engine that interprets a QueryPlan AST
//
// Follows SQL execution order:
//   1. WHERE   — row filters + range filters
//   2. GROUP BY — bucket rows by dimensions (including time grain)
//   3. AGGREGATE — compute metrics per group (COUNT skips nulls)
//   4. HAVING  — apply group filters on aggregated values
//   5. ORDER BY — sort by metric alias or dimension
//   6. LIMIT   — slice results
//
// Output keys use metric.alias and dimensionId() — guaranteed to match
// the SQL compiler's aliases for ResultSchema parity.
// ═══════════════════════════════════════════════════════════════════

import {
    QueryPlan, Expression, Metric, Dimension, RowFilter, RangeFilter, DateFilter,
    GroupFilter, OrderBy, AggregationType, dimensionId, deriveResultSchema
} from './types';
import { pad, getISOWeek } from '../dateHelpers';
import type { DimDateRow } from '../../types';

// ── HELPERS ──────────────────────────────────────────────────────

/** Parse a numeric value from a cell, stripping currency symbols */
function parseNum(raw: any): number {
    if (raw === null || raw === undefined || raw === '') return NaN;
    if (typeof raw === 'number') return raw;
    return Number(String(raw).replace(/[$,]/g, '')) || 0;
}

/** Resolve the actual column key from a row (case-insensitive) */
function resolveColumnKey(row: Record<string, any>, column: string): string {
    if (column in row) return column;
    const lower = column.toLowerCase().replace(/[_\s]+/g, '');
    const keys = Object.keys(row);
    const match = keys.find(k => k.toLowerCase().replace(/[_\s]+/g, '') === lower);
    return match || column;
}

/** Extract a date/datetime string from a row. Preserves time portion if present. */
function extractDateStr(row: Record<string, any>, dateCol: string): string {
    const raw = row[dateCol];
    if (!raw || raw === 'null' || raw === 'undefined') return '1970-01-01T00:00:00';
    const s = String(raw);
    // Already ISO format with time
    if (s.match(/^\d{4}-\d{2}-\d{2}[T ]/)) return s;
    // Date-only ISO format
    if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s + 'T00:00:00';
    // MM/DD/YYYY
    if (s.includes('/')) {
        const parts = s.split('/');
        if (parts.length === 3) {
            const [mm, dd, yyyy] = parts;
            return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00`;
        }
    }
    // Try Date constructor
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().replace('Z', '');
    return '1970-01-01T00:00:00';
}

/** Format a date/datetime string into a time bucket key (matches SQL compiler output) */
function formatTimeBucket(dateStr: string, grain: string): string {
    // Parse full datetime — support 'YYYY-MM-DD', 'YYYY-MM-DDThh:mm:ss', 'YYYY-MM-DD hh:mm:ss'
    const cleaned = dateStr.replace('T', ' ').replace('Z', '');
    const datePart = cleaned.substring(0, 10);
    const timePart = cleaned.length > 10 ? cleaned.substring(11) : '00:00:00';
    const dp = datePart.split('-').map(Number);
    const tp = timePart.split(':').map(Number);
    const d = new Date(dp[0], dp[1] - 1, dp[2] || 1, tp[0] || 0, tp[1] || 0, tp[2] || 0);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const dy = d.getDate();
    const h = d.getHours();
    const mi = d.getMinutes();

    switch (grain) {
        case 'minute': {
            const hr12 = h % 12 || 12;
            const ampm = h < 12 ? 'AM' : 'PM';
            return `${hr12}:${pad(mi)} ${ampm}`;
        }
        case 'hour': {
            const hr12 = h % 12 || 12;
            const ampm = h < 12 ? 'AM' : 'PM';
            return `${hr12} ${ampm}`;
        }
        case 'day': return `${y}-${pad(m)}-${pad(dy)}`;
        case 'week': {
            const week = getISOWeek(d);
            return `${y}-W${pad(week)}`;
        }
        case 'month': return `${y}-${pad(m)}`;
        case 'quarter': return `${y}-Q${Math.ceil(m / 3)}`;
        case 'year': return `${y}`;
        default: return dateStr;
    }
}

/** Evaluate a row-level expression against a data row */
function evaluateExpression(expr: Expression, row: Record<string, any>): any {
    switch (expr.type) {
        case 'column': {
            const key = resolveColumnKey(row, expr.column);
            return row[key];
        }
        case 'literal':
            return expr.value;
        case 'binary_op': {
            const left = Number(evaluateExpression(expr.left, row)) || 0;
            const right = Number(evaluateExpression(expr.right, row)) || 0;
            switch (expr.op) {
                case 'add': return left + right;
                case 'subtract': return left - right;
                case 'multiply': return left * right;
                case 'divide': return right !== 0 ? left / right : 0;
            }
            return 0;
        }
        case 'function':
            // v2: implement DATEDIFF etc.
            return 0;
        default:
            return 0;
    }
}

// ── GROUP STATS ACCUMULATOR ──────────────────────────────────────

interface MetricStats {
    sum: number;
    count: number;       // Non-null count
    countAll: number;     // Total count including nulls
    min: number;
    max: number;
    distinct: Set<string>;
}

function emptyStats(): MetricStats {
    return { sum: 0, count: 0, countAll: 0, min: Infinity, max: -Infinity, distinct: new Set() };
}

function accumulateStats(stats: MetricStats, rawValue: any): void {
    stats.countAll += 1;
    const isNull = rawValue === null || rawValue === undefined || rawValue === '';
    if (isNull) return; // COUNT skips nulls (SQL semantics)

    const v = parseNum(rawValue);
    const numV = isNaN(v) ? 0 : v;

    stats.count += 1;
    stats.sum += numV;
    stats.min = Math.min(stats.min, numV);
    stats.max = Math.max(stats.max, numV);
    stats.distinct.add(String(rawValue));
}

function resolveAggregation(stats: MetricStats, agg: AggregationType): number {
    switch (agg) {
        case 'SUM': return stats.sum;
        case 'AVG': return stats.count > 0 ? stats.sum / stats.count : 0;
        case 'COUNT': return stats.count;
        case 'COUNT_ALL': return stats.countAll;
        case 'COUNT_DISTINCT': return stats.distinct.size;
        case 'MIN': return stats.min === Infinity ? 0 : stats.min;
        case 'MAX': return stats.max === -Infinity ? 0 : stats.max;
        default: return stats.sum;
    }
}

// ── FILTER APPLICATORS ───────────────────────────────────────────

function applyRowFilter(row: Record<string, any>, f: RowFilter): boolean {
    const key = resolveColumnKey(row, f.column);
    const cellVal = row[key];

    if (f.op === 'IN' || f.op === 'NOT_IN') {
        const allowed = Array.isArray(f.value) ? f.value : [f.value];
        const cellStr = String(cellVal || '').toLowerCase().trim();
        const match = allowed.some(v => cellStr === String(v).toLowerCase().trim());
        return f.op === 'IN' ? match : !match;
    }

    const numCell = parseNum(cellVal);
    const numFilter = typeof f.value === 'number' ? f.value : parseNum(f.value);

    switch (f.op) {
        case '=': return String(cellVal) === String(f.value);
        case '!=': return String(cellVal) !== String(f.value);
        case '>': return numCell > numFilter;
        case '<': return numCell < numFilter;
        case '>=': return numCell >= numFilter;
        case '<=': return numCell <= numFilter;
        default: return true;
    }
}

function applyRangeFilter(row: Record<string, any>, f: RangeFilter, dateColKey: string): boolean {
    // Use the filter column if specified, otherwise fall back to date column
    const key = resolveColumnKey(row, f.column || dateColKey);
    const fullDateStr = extractDateStr(row, key);
    // Range boundaries are date-only (YYYY-MM-DD), so compare only the date portion
    const dateStr = fullDateStr.substring(0, 10);

    if (f.start && f.end) return dateStr >= f.start && dateStr <= f.end;
    if (f.start) return dateStr >= f.start;
    if (f.end) return dateStr <= f.end;
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: executeQueryPlan
// ═══════════════════════════════════════════════════════════════════

export interface ExecutionResult {
    data: Record<string, any>[];
    xKey: string;
    yKey: string;
    secondaryYKeys?: string[];
}

export function executeQueryPlan(
    plan: QueryPlan,
    rows: Record<string, any>[],
    dimDate?: DimDateRow[]
): ExecutionResult {
    const dateColKey = plan._dateColumnKey || '';
    const schema = deriveResultSchema(plan);

    // Resolve actual date column key from first row
    let effectiveDateCol = dateColKey;
    if (rows.length > 0 && dateColKey) {
        effectiveDateCol = resolveColumnKey(rows[0], dateColKey);
    }

    // ── STEP 1: WHERE — Apply row filters + range filters ────────
    let filtered = rows;

    // Row filters (dimension IN, scalar comparisons)
    if (plan.filters.row.length > 0) {
        filtered = filtered.filter(r =>
            plan.filters.row.every(f => applyRowFilter(r, f))
        );
    }

    // Range filters (time ranges, date ranges)
    if (plan.filters.range.length > 0) {
        filtered = filtered.filter(r =>
            plan.filters.range.every(f => applyRangeFilter(r, f, effectiveDateCol))
        );
    }

    // Date filters (grain-aware: format date to grain then check IN)
    if (plan.filters.date.length > 0) {
        filtered = filtered.filter(r => {
            return plan.filters.date.every(df => {
                const key = resolveColumnKey(r, df.column || effectiveDateCol);
                const dateStr = extractDateStr(r, key);
                if (dateStr.startsWith('1970-01-01')) return false;
                const formatted = formatTimeBucket(dateStr, df.timeGrain);
                return df.values.some(v => formatted.toLowerCase() === v.toLowerCase());
            });
        });
    }

    console.log(`[QueryPlan Engine] After WHERE: ${filtered.length} rows (from ${rows.length})`);

    // ── STEP 2: GROUP BY — Bucket rows by dimensions ─────────────
    const groups = new Map<string, { metricStats: MetricStats[]; dimValues: Record<string, string> }>();

    // Pre-populate time bucket groups from dim date spine (empty buckets)
    // Skip for sub-day grains (hour/minute) — dimDate only has daily entries
    const hasTimeBucket = plan.dimensions.some(d => d.type === 'time_bucket');
    const timeBucketGrain = hasTimeBucket
        ? (plan.dimensions.find(d => d.type === 'time_bucket') as Extract<Dimension, { type: 'time_bucket' }>).grain
        : null;
    const isSubDayGrain = timeBucketGrain === 'hour' || timeBucketGrain === 'minute';
    if (hasTimeBucket && !isSubDayGrain && plan._emptyBucketMode === 'include' && dimDate && dimDate.length > 0) {
        const timeDim = plan.dimensions.find(d => d.type === 'time_bucket') as Extract<Dimension, { type: 'time_bucket' }>;
        const grain = timeDim.grain;
        const dimAlias = timeDim.alias;

        // Find the time range filter to constrain buckets
        const timeRange = plan.filters.range.find(f => {
            const col = f.column.toLowerCase().replace(/[_\s]+/g, '');
            const dateCol = effectiveDateCol.toLowerCase().replace(/[_\s]+/g, '');
            return col === dateCol;
        });
        const rangeStart = timeRange?.start || '1970-01-01';
        const rangeEnd = timeRange?.end || '9999-12-31';

        for (const dr of dimDate) {
            if (dr.date_key < rangeStart || dr.date_key > rangeEnd) continue;

            // Also respect date filters (hierarchy filters like year=2016)
            // so we don't create empty buckets outside the filtered scope
            if (plan.filters.date.length > 0) {
                const passesDateFilters = plan.filters.date.every(df => {
                    const formatted = formatTimeBucket(dr.date_key, df.timeGrain);
                    return df.values.some(v => formatted.toLowerCase() === v.toLowerCase());
                });
                if (!passesDateFilters) continue;
            }

            const bucketKey = formatTimeBucket(dr.date_key, grain);
            if (!groups.has(bucketKey)) {
                const dimValues: Record<string, string> = { [dimAlias]: bucketKey };
                const metricStats = plan.metrics.map(() => emptyStats());
                groups.set(bucketKey, { metricStats, dimValues });
            }
        }
        console.log(`[QueryPlan Engine] Pre-populated ${groups.size} ${grain} buckets from dim date spine`);
    }

    // Group filtered rows
    for (const row of filtered) {
        // Build group key from all dimensions
        const dimValues: Record<string, string> = {};
        const keyParts: string[] = [];

        for (const dim of plan.dimensions) {
            let val: string;
            if (dim.type === 'time_bucket') {
                const dateStr = extractDateStr(row, effectiveDateCol);
                val = formatTimeBucket(dateStr, dim.grain);
                dimValues[dim.alias] = val;
            } else {
                const key = resolveColumnKey(row, dim.column);
                val = String(row[key] || 'Unknown');
                dimValues[dim.column] = val;
            }
            keyParts.push(val);
        }

        // No dimensions → single "Total" group
        const groupKey = keyParts.length > 0 ? keyParts.join('|') : '__total__';

        // Get or create group
        let group = groups.get(groupKey);
        if (!group) {
            group = {
                metricStats: plan.metrics.map(() => emptyStats()),
                dimValues: plan.dimensions.length === 0 ? {} : dimValues,
            };
            groups.set(groupKey, group);
        }

        // ── STEP 3: AGGREGATE — Accumulate metric values ─────────
        for (let i = 0; i < plan.metrics.length; i++) {
            const metric = plan.metrics[i];
            const rawValue = evaluateExpression(metric.expression, row);
            accumulateStats(group.metricStats[i], rawValue);
        }
    }

    console.log(`[QueryPlan Engine] After GROUP BY: ${groups.size} groups`);

    // ── STEP 3b: Resolve aggregated values ───────────────────────
    let data: Record<string, any>[] = [];

    for (const [, group] of groups) {
        const row: Record<string, any> = {};

        // Dimension columns (using alias/column name as key)
        for (const dim of plan.dimensions) {
            const id = dimensionId(dim);
            row[id] = group.dimValues[id] || '';
        }

        // Metric columns (using alias as key)
        for (let i = 0; i < plan.metrics.length; i++) {
            const metric = plan.metrics[i];
            row[metric.alias] = resolveAggregation(group.metricStats[i], metric.aggregation);
        }

        data.push(row);
    }

    // ── STEP 4: HAVING — Apply group filters ─────────────────────
    if (plan.filters.group.length > 0) {
        data = data.filter(row => {
            return plan.filters.group.every(gf => {
                const metric = plan.metrics.find(m => m.id === gf.metricId);
                if (!metric) return true;
                const val = Number(row[metric.alias]) || 0;
                switch (gf.op) {
                    case '>': return val > gf.value;
                    case '<': return val < gf.value;
                    case '>=': return val >= gf.value;
                    case '<=': return val <= gf.value;
                    case '=': return val === gf.value;
                    default: return true;
                }
            });
        });
        console.log(`[QueryPlan Engine] After HAVING: ${data.length} groups`);
    }

    // ── STEP 5: ORDER BY — Sort (BEFORE limit) ───────────────────
    if (plan.orderBy.length > 0) {
        data.sort((a, b) => {
            for (const ob of plan.orderBy) {
                let valA: any, valB: any;
                if (ob.type === 'metric') {
                    const metric = plan.metrics.find(m => m.id === ob.metricId);
                    if (metric) {
                        valA = Number(a[metric.alias]) || 0;
                        valB = Number(b[metric.alias]) || 0;
                    }
                } else {
                    const dim = plan.dimensions.find(d => dimensionId(d) === ob.dimensionId);
                    if (dim) {
                        const id = dimensionId(dim);
                        valA = a[id] || '';
                        valB = b[id] || '';
                    }
                }

                if (valA === undefined || valB === undefined) continue;

                let cmp: number;
                if (typeof valA === 'number' && typeof valB === 'number') {
                    cmp = valA - valB;
                } else {
                    cmp = String(valA).localeCompare(String(valB));
                }

                if (cmp !== 0) {
                    return ob.direction === 'ASC' ? cmp : -cmp;
                }
            }
            return 0;
        });
    }

    // ── STEP 6: LIMIT — Slice (AFTER sort) ───────────────────────
    if (plan.limit && plan.limit > 0) {
        data = data.slice(0, plan.limit);
    }

    // ── RESULT ───────────────────────────────────────────────────
    // xKey = first dimension's output ID (or 'metric' for scalar)
    // yKey = first metric's alias
    const xKey = plan.dimensions.length > 0 ? dimensionId(plan.dimensions[0]) : 'metric';
    const yKey = plan.metrics.length > 0 ? plan.metrics[0].alias : '';

    // Secondary metric keys
    const secondaryYKeys = plan.metrics.length > 1
        ? plan.metrics.slice(1).map(m => m.alias)
        : undefined;

    return { data, xKey, yKey, secondaryYKeys };
}
