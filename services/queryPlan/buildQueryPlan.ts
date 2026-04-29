// ═══════════════════════════════════════════════════════════════════
// buildQueryPlan — Converts UI query config → canonical QueryPlan AST
// Time filter resolution happens HERE, once, so both engines share
// the same resolved date boundaries.
// ═══════════════════════════════════════════════════════════════════

import {
    QueryPlan, Metric, Dimension, Filters, RowFilter, RangeFilter, DateFilter,
    GroupFilter, OrderBy, AggregationType, TimeGrain, Expression
} from './types';
import { DateRange } from '../dateHelpers';

/** The raw config object produced by QuestionBuilder's handleRun / evaluateLocally */
export interface UIQueryConfig {
    metric: string;
    aggregation?: string;
    dimension?: string;
    timeFilter?: string;
    filters?: Record<string, string[]>;
    measureFilters?: Array<{ column: string; operator: string; value: number }>;
    dateFilters?: Array<{ column: string; timeGrain: string; values: string[] }>;
    sort?: string;
    limit?: number;
    secondaryMetrics?: string[];
    secondaryMetricAggregations?: Record<string, string>;
    secondaryDimensions?: string[];
}

// ── AGGREGATION NORMALIZER ───────────────────────────────────────
const VALID_AGGS = new Set<AggregationType>(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_ALL', 'COUNT_DISTINCT']);

function normalizeAgg(raw: string | undefined): AggregationType {
    const upper = (raw || 'SUM').toUpperCase() as AggregationType;
    return VALID_AGGS.has(upper) ? upper : 'SUM';
}

// ── TIME GRAINS ──────────────────────────────────────────────────
const TIME_GRAINS: TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

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
// Resolves symbolic time filters (e.g. "this_month") into concrete
// date start/end strings. This happens ONCE in the plan builder.

function resolveTimeFilter(
    timeFilter: string,
    dates: DateRange,
    dateColumn: string
): RangeFilter | null {
    if (!timeFilter || timeFilter === 'all_time') return null;

    const today = new Date(`${dates.today}T00:00:00Z`);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    let start: string | undefined;
    let end: string | undefined = dates.today;

    if (timeFilter === 'today') {
        start = dates.today;
        end = dates.today;
    } else if (timeFilter === 'yesterday') {
        start = dates.yesterday;
        end = dates.yesterday;
    } else if (timeFilter === 'this_week') {
        start = dates.monday;
    } else if (timeFilter === 'this_month') {
        start = dates.this_month_start;
    } else if (timeFilter === 'this_quarter') {
        const qMonth = Math.floor(today.getUTCMonth() / 3) * 3;
        const d = new Date(Date.UTC(today.getUTCFullYear(), qMonth, 1));
        start = fmt(d);
    } else if (timeFilter === 'this_year') {
        start = dates.year_start;
    } else if (timeFilter === 'last_year') {
        start = dates.last_year_start;
        end = fmt(new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31)));
    } else if (timeFilter === 'last_7_days') {
        start = dates.last_7_days;
    } else if (timeFilter === 'last_30_days') {
        start = dates.last_30_days;
    } else if (timeFilter === 'last_90_days') {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - 90);
        start = fmt(d);
    } else {
        // Dynamic: last_N_unit (e.g. last_5_days, last_2_weeks, last_3_months, last_1_cyears)
        const match = timeFilter.match(/^last_(\d+)_(c?[a-z]+)$/);
        if (match) {
            const n = Math.min(parseInt(match[1], 10), 3650);
            const unit = match[2];
            if (unit === 'cyears') {
                const asOfYear = today.getUTCFullYear();
                start = fmt(new Date(Date.UTC(asOfYear - n, 0, 1)));
                end = fmt(new Date(Date.UTC(asOfYear - 1, 11, 31)));
            } else {
                const target = new Date(today);
                if (unit === 'days') target.setUTCDate(today.getUTCDate() - n);
                else if (unit === 'weeks') target.setUTCDate(today.getUTCDate() - n * 7);
                else if (unit === 'months') target.setUTCMonth(today.getUTCMonth() - n);
                else if (unit === 'years') target.setUTCFullYear(today.getUTCFullYear() - n);
                start = fmt(target);
            }
        }
    }

    if (!start) return null;
    return { column: dateColumn, start, end };
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
    };
}
