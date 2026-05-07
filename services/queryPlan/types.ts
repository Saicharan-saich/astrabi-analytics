// ═══════════════════════════════════════════════════════════════════
// QueryPlan AST — Single Source of Truth for Analytics Queries
// Both the JS execution engine and SQL compiler read from this plan.
// ═══════════════════════════════════════════════════════════════════

// ── EXPRESSIONS ──────────────────────────────────────────────────
// Row-level expressions. NEVER contain aggregations.

export type Expression =
    | { type: 'column'; column: string; returnType?: 'number' | 'string' | 'date' }
    | { type: 'literal'; value: number | string | boolean; returnType?: 'number' | 'string' | 'date' }
    | { type: 'binary_op'; op: 'add' | 'subtract' | 'multiply' | 'divide'; left: Expression; right: Expression }
    | { type: 'function'; name: string; args: Expression[] };  // v2: DATEDIFF etc.

// ── AGGREGATION ──────────────────────────────────────────────────

export type AggregationType =
    | 'SUM'
    | 'AVG'
    | 'MIN'
    | 'MAX'
    | 'COUNT'           // COUNT(column) — skips nulls
    | 'COUNT_ALL'       // COUNT(*) — includes nulls
    | 'COUNT_DISTINCT'; // COUNT(DISTINCT column)

// ── METRICS ──────────────────────────────────────────────────────
// Each metric has a unique id, a display alias (used in SQL AS and JS keys),
// and an expression + aggregation.

export interface Metric {
    id: string;
    alias: string;            // REQUIRED — used in SQL `AS alias` and JS output keys
    expression: Expression;
    aggregation: AggregationType;
}

// ── DIMENSIONS ───────────────────────────────────────────────────

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type Dimension =
    | { type: 'column'; column: string }
    | {
        type: 'time_bucket';
        sourceColumn: string;
        grain: TimeGrain;
        alias: string;         // REQUIRED — output key in both SQL and JS (e.g. "admission_month")
    };

/** Get the output key for a dimension (column name or alias) */
export function dimensionId(dim: Dimension): string {
    return dim.type === 'column' ? dim.column : dim.alias;
}

// ── FILTERS ──────────────────────────────────────────────────────
// Separated into row-level (WHERE), range (BETWEEN), date (grain-aware),
// and group-level (HAVING).

export interface RowFilter {
    column: string;
    op: '=' | '>' | '<' | '>=' | '<=' | '!=' | 'IN' | 'NOT_IN';
    value: string | number | boolean | string[] | number[];
}

export interface RangeFilter {
    column: string;
    start?: string;   // If only start → >=
    end?: string;      // If only end → <=
    // Both present → BETWEEN (inclusive)
    _isTimeFilter?: boolean;  // Set by buildQueryPlan when this range came from a time filter resolution
}

/** Date-hierarchy filter: compares row dates formatted at the given grain.
 *  JS: format date to grain, then check if IN values.
 *  SQL: EXTRACT(YEAR FROM col) IN (...) or TO_CHAR(col, 'YYYY-MM') IN (...) */
export interface DateFilter {
    column: string;
    timeGrain: TimeGrain;
    values: string[];    // Grain-formatted: ['2018'], ['2020-Q1'], ['2019-06'] etc.
}

export interface GroupFilter {
    metricId: string;  // Must reference an existing metric's id
    op: '>' | '<' | '>=' | '<=' | '=';
    value: number;
}

export interface Filters {
    row: RowFilter[];
    range: RangeFilter[];
    date: DateFilter[];    // Grain-aware date hierarchy filters
    group: GroupFilter[];
}

// ── ORDER BY ─────────────────────────────────────────────────────

export type OrderBy =
    | { type: 'metric'; metricId: string; direction: 'ASC' | 'DESC' }
    | { type: 'dimension'; dimensionId: string; direction: 'ASC' | 'DESC' };

// ── RESULT SCHEMA ────────────────────────────────────────────────
// Enforces that SQL aliases and JS output keys are identical.

export interface ResultColumn {
    id: string;              // The alias/key used in output
    role: 'dimension' | 'metric';
}

export interface ResultSchema {
    columns: ResultColumn[];
}

/** Derive the result schema from a QueryPlan — guarantees both engines use the same shape. */
export function deriveResultSchema(plan: QueryPlan): ResultSchema {
    const columns: ResultColumn[] = [];
    for (const dim of plan.dimensions) {
        columns.push({ id: dimensionId(dim), role: 'dimension' });
    }
    for (const metric of plan.metrics) {
        columns.push({ id: metric.alias, role: 'metric' });
    }
    return { columns };
}

// ── QUERY PLAN ───────────────────────────────────────────────────

export interface QueryPlan {
    source: string;          // Table/dataset name
    dimensions: Dimension[];
    metrics: Metric[];
    filters: Filters;
    orderBy: OrderBy[];
    limit?: number;
    // Execution hints (not part of SQL, used by JS engine)
    _dateColumnKey?: string;         // Resolved date column for time bucketing
    _emptyBucketMode?: 'include' | 'exclude'; // time → include, categorical → exclude
}

// ── ENRICHED QUERY (Feature Layer) ──────────────────────────────
// Wraps the base QueryPlan with comparison + table calculation config.
// The enriched SQL compiler reads this to generate CTEs + window functions.

export interface ComparisonConfig {
    type: 'previous_period' | 'same_period_last_year' | 'same_period_last_n';
    offset?: number;        // For last_n: how many periods back
    grain?: string;         // For last_n: the grain of the offset
    dateRange?: { start: string; end: string };  // Resolved time filter bounds
}

export type TableCalculation =
    | 'running_total'
    | 'pct_of_total'
    | 'moving_avg'
    | 'pct_change'
    | 'rank'
    | 'difference';

export interface EnrichedQuery {
    basePlan: QueryPlan;
    comparison?: ComparisonConfig;
    calculations?: TableCalculation[];
    movingAvgWindow?: number;         // Default: 3
}
