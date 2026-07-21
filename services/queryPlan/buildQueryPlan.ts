// ═══════════════════════════════════════════════════════════════════
// buildQueryPlan — Converts UI query config → canonical QueryPlan AST
// Time filter resolution happens HERE, once, so both engines share
// the same resolved date boundaries.
// ═══════════════════════════════════════════════════════════════════

import {
    QueryPlan, Metric, Dimension, Filters, RowFilter, RangeFilter, DateFilter,
    GroupFilter, OrderBy, AggregationType, TimeGrain, Expression, AggregateComparisonFilter
} from './types';
import { DateRange } from '../dateHelpers';

/** The raw config object produced by QuestionBuilder's handleRun / evaluateLocally */
export interface UIQueryConfig {
    metric: string;
    aggregation?: string;
    dimension?: string;
    timeFilter?: string;
    filters?: Record<string, string[]>;
    /** Exclusion filters — column → values to exclude (NOT IN). */
    excludeFilters?: Record<string, string[]>;
    measureFilters?: Array<{ column: string; operator: string; value: number }>;
    dateFilters?: Array<{ column: string; timeGrain: string; values: string[] }>;
    /** Row-level "vs aggregate" filters (e.g. above-average). */
    aggregateFilters?: AggregateComparisonFilter[];
    /** Text-contains filters (LIKE / NOT LIKE). */
    likeFilters?: Array<{ column: string; pattern: string; negate?: boolean }>;
    /** Numeric distribution / histogram over a column. */
    distribution?: { column: string; bins: number };
    /** Grouped above/below-average HAVING (compare each group to the group average). */
    groupAvgHaving?: { op: '>' | '<' | '>=' | '<='; metricIndex: number };
    /** Row-level numeric comparisons (WHERE col > value) — pre-aggregation. */
    numericFilters?: Array<{ column: string; op: '>' | '<' | '>=' | '<=' | '=' | '!='; value: number }>;
    /** Row-level numeric ranges (WHERE col BETWEEN min AND max). */
    numericRanges?: Array<{ column: string; min: number; max: number }>;
    sort?: string;
    limit?: number;
    secondaryMetrics?: string[];
    secondaryMetricAggregations?: Record<string, string>;
    secondaryDimensions?: string[];
}

// ── AGGREGATION NORMALIZER ───────────────────────────────────────
const VALID_AGGS = new Set<AggregationType>(['SUM', 'AVG', 'MEDIAN', 'MIN', 'MAX', 'COUNT', 'COUNT_ALL', 'COUNT_DISTINCT', 'NONE']);

function normalizeAgg(raw: string | undefined): AggregationType {
    const upper = (raw || 'SUM').toUpperCase() as AggregationType;
    return VALID_AGGS.has(upper) ? upper : 'SUM';
}

// ── TIME GRAINS ──────────────────────────────────────────────────
const TIME_GRAINS: TimeGrain[] = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];

function isTimeGrain(s: string): s is TimeGrain {
    return TIME_GRAINS.includes(s as TimeGrain);
}

// ── ALIAS GENERATOR ──────────────────────────────────────────────
// Creates a SQL-safe alias from column + aggregation
function metricAlias(column: string, agg: AggregationType): string {
    const cleanCol = column.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    return `${agg.toLowerCase()}_${cleanCol}`;
}

function timeBucketAlias(grain: TimeGrain): string {
    return `time_${grain}`;
}

// ── TIME FILTER RESOLVER ─────────────────────────────────────────
// Delegates to the centralized resolveTimeRange() — single source of truth.

import { resolveTimeRange } from '../resolveTimeRange';

function resolveTimeFilter(
    timeFilter: string,
    dates: DateRange,
    dateColumn: string
): RangeFilter | null {
    const range = resolveTimeRange(timeFilter, dates);
    if (!range) return null;
    return { column: dateColumn, start: range.start, end: range.end, _isTimeFilter: true };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: buildQueryPlan
// ═══════════════════════════════════════════════════════════════════

export function buildQueryPlan(
    query: UIQueryConfig,
    dateColumnKey: string,
    dates: DateRange,
    datasetName: string
): QueryPlan {
    // ── METRICS ──────────────────────────────────────────────────
    const metrics: Metric[] = [];
    const primaryAgg = normalizeAgg(query.aggregation);
    const primaryExpr: Expression = { type: 'column', column: query.metric };

    metrics.push({
        id: 'primary',
        alias: metricAlias(query.metric, primaryAgg),
        expression: primaryExpr,
        aggregation: primaryAgg,
    });

    // Secondary metrics
    if (query.secondaryMetrics) {
        for (const sm of query.secondaryMetrics) {
            const secAgg = normalizeAgg(query.secondaryMetricAggregations?.[sm]);
            metrics.push({
                id: `sec_${sm}`,
                alias: metricAlias(sm, secAgg),
                expression: { type: 'column', column: sm },
                aggregation: secAgg,
            });
        }
    }

    // ── DIMENSIONS ───────────────────────────────────────────────
    const dimensions: Dimension[] = [];
    const dimCol = query.dimension || '';

    if (dimCol) {
        if (isTimeGrain(dimCol)) {
            dimensions.push({
                type: 'time_bucket',
                sourceColumn: dateColumnKey,
                grain: dimCol,
                alias: timeBucketAlias(dimCol),
            });
        } else {
            dimensions.push({ type: 'column', column: dimCol });
        }
    }

    // Secondary dimensions
    if (query.secondaryDimensions) {
        for (const sd of query.secondaryDimensions) {
            dimensions.push({ type: 'column', column: sd });
        }
    }

    // ── FILTERS ──────────────────────────────────────────────────
    const rowFilters: RowFilter[] = [];
    const rangeFilters: RangeFilter[] = [];
    const dateFilters: DateFilter[] = [];
    const groupFilters: GroupFilter[] = [];

    // 1. Time filter → resolved range
    const timeRange = resolveTimeFilter(query.timeFilter || '', dates, dateColumnKey);
    if (timeRange) {
        rangeFilters.push(timeRange);
    }

    // 2. Dimension filters (IN)
    if (query.filters) {
        for (const [col, vals] of Object.entries(query.filters)) {
            if (vals.length > 0) {
                rowFilters.push({ column: col, op: 'IN', value: vals });
            }
        }
    }

    // 2b. Exclusion filters (NOT IN)
    if (query.excludeFilters) {
        for (const [col, vals] of Object.entries(query.excludeFilters)) {
            if (vals.length > 0) {
                rowFilters.push({ column: col, op: 'NOT_IN', value: vals });
            }
        }
    }

    // 2c. Row-level numeric comparisons and ranges (pre-aggregation WHERE)
    if (query.numericFilters) {
        for (const nf of query.numericFilters) {
            rowFilters.push({ column: nf.column, op: nf.op as RowFilter['op'], value: nf.value });
        }
    }
    if (query.numericRanges) {
        for (const nr of query.numericRanges) {
            rowFilters.push({ column: nr.column, op: '>=', value: nr.min });
            rowFilters.push({ column: nr.column, op: '<=', value: nr.max });
        }
    }

    // 3. Measure filters → GROUP (HAVING) — this is the critical semantic fix
    if (query.measureFilters) {
        for (const mf of query.measureFilters) {
            groupFilters.push({
                metricId: 'primary',  // Currently measure filters reference the primary metric
                op: mf.operator as GroupFilter['op'],
                value: mf.value,
            });
        }
    }

    // 4. Date filters (hierarchy + range)
    if (query.dateFilters) {
        for (const df of query.dateFilters) {
            if (df.values.length === 1 && df.values[0].includes('__')) {
                // Range mode: "start__end"
                const [rangeStart, rangeEnd] = df.values[0].split('__');
                rangeFilters.push({ column: df.column, start: rangeStart, end: rangeEnd });
            } else if (df.values.length > 0) {
                // Hierarchy mode: grain-formatted values (e.g. '2018', '2020-Q1')
                dateFilters.push({
                    column: df.column,
                    timeGrain: (df.timeGrain || 'year') as TimeGrain,
                    values: df.values
                });
            }
        }
    }

    const filters: Filters = { row: rowFilters, range: rangeFilters, date: dateFilters, group: groupFilters };

    // ── ORDER BY ─────────────────────────────────────────────────
    const orderBy: OrderBy[] = [];
    const sortMode = query.sort || 'desc';
    const isTimeDim = dimCol && isTimeGrain(dimCol);

    if (sortMode === 'oldest' || sortMode === 'newest') {
        // Sort by dimension
        if (dimensions.length > 0) {
            const dimId = dimensions[0].type === 'column'
                ? dimensions[0].column
                : dimensions[0].alias;
            orderBy.push({
                type: 'dimension',
                dimensionId: dimId,
                direction: sortMode === 'oldest' ? 'ASC' : 'DESC',
            });
        }
    } else {
        // Sort by primary metric
        orderBy.push({
            type: 'metric',
            metricId: 'primary',
            direction: sortMode === 'asc' ? 'ASC' : 'DESC',
        });
    }

    // ── LIMIT ────────────────────────────────────────────────────
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 10000) : undefined;

    // ── PLAN ─────────────────────────────────────────────────────
    return {
        source: datasetName || 'dataset',
        dimensions,
        metrics,
        filters,
        orderBy,
        limit,
        _dateColumnKey: dateColumnKey,
        _emptyBucketMode: isTimeDim ? 'include' : 'exclude',
        _aggregateFilters: query.aggregateFilters && query.aggregateFilters.length > 0 ? query.aggregateFilters : undefined,
        _likeFilters: query.likeFilters && query.likeFilters.length > 0 ? query.likeFilters : undefined,
        _distribution: query.distribution,
        _groupAvgHaving: query.groupAvgHaving,
    };
}
