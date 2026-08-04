/**
 * Enterprise AI SQL Architecture — Core Types
 * 
 * All interfaces for the semantic layer, intent planner, result profiler,
 * chart recommender, confidence scorer, and audit logger.
 */

// ─── Semantic Layer ──────────────────────────────────────────────

export type SemanticType =
    | 'currency'
    | 'percentage'
    | 'count'
    | 'quantity'
    | 'ratio'
    | 'date'
    | 'geography'
    | 'category'
    | 'ordinal'
    | 'identifier'
    | 'boolean'
    | 'text'
    | 'unknown';

export type FieldRole = 'metric' | 'dimension';

/**
 * Structured classification signals — explainability layer for the arbitration engine.
 * Surfaces the reasoning behind each field's type/role decision.
 */
export interface FieldClassificationSignals {
    /** Deterministic engine confidence (0–1) */
    detConf: number;
    /** Derived AI confidence after validation (0–1), null if AI was not consulted */
    aiConf: number | null;
    /** Which source won the arbitration */
    finalSource: 'deterministic' | 'ai' | 'user_override' | 'seed';
    /** Human-readable reason for the classification */
    reason: string;
    /** Raw statistical signals used in the decision */
    signals: {
        rangeSpan?: number;
        uniqueValues: number;
        isInteger?: boolean;
        namePatternMatch?: string;
        uniqueRatio?: number;
    };
    /** Constraint-filtered allowed types (physics layer output) */
    allowedTypes: SemanticType[];
}

export interface SemanticField {
    /** Physical column name in the dataset */
    name: string;
    /** Detected physical type (number, string, date) */
    physicalType: 'number' | 'string' | 'date' | 'boolean';
    /** Inferred semantic type */
    semanticType: SemanticType;
    /** Whether this field is a metric or dimension */
    role: FieldRole;
    /** Default aggregation for this field */
    defaultAgg: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'none';
    /** Supported time grains (only for date fields) */
    timeGrainSupport: ('day' | 'week' | 'month' | 'quarter' | 'year')[];
    /** Synonyms the user might use to refer to this field */
    synonyms: string[];
    /** Privacy-safe structural descriptors (shapes/patterns — NEVER raw values) */
    valueDescriptors: string[];
    /** Number of distinct values (cardinality) */
    distinctCount: number;
    /** Whether this field contains nulls */
    hasNulls: boolean;
    /** Whether date values include time components (HH:MM) — avoids needing raw samples */
    hasTimeComponent?: boolean;
    /** Value range for numeric fields */
    range?: { min: number; max: number };
    /** Human-friendly display label */
    displayLabel: string;
    /** Format hint for rendering */
    formatHint?: 'currency_usd' | 'currency_eur' | 'percent' | 'decimal' | 'integer' | 'date' | 'text';
    /** Classification signals — explainability & arbitration audit trail */
    classificationSignals?: FieldClassificationSignals;
}

export interface MetricDefinition {
    /** Unique identifier */
    id: string;
    /** Display name */
    label: string;
    /** SQL formula expression */
    formula: string;
    /** The columns this metric depends on */
    dependsOn: string[];
    /** Semantic type of the result */
    semanticType: SemanticType;
    /** Aggregation is already built into the formula */
    preAggregated: boolean;
    /** User-facing description */
    description: string;
    /** Synonyms */
    synonyms: string[];
}

/**
 * Derived Metric — represents a two-stage aggregation.
 * Example: avg_daily_sales = AVG( SUM(sales) GROUP BY order_date )
 *
 * This is how real BI tools (Tableau, Looker, Cube, dbt) handle
 * compound metric definitions like "average daily sales".
 */
export interface DerivedMetricDefinition {
    /** Unique identifier, e.g. 'avg_daily_sales' */
    id: string;
    /** Human-readable label, e.g. 'Average Daily Sales' */
    label: string;
    /** Always 'derived' to distinguish from composite metrics */
    type: 'derived';
    /** Stage 1: the base aggregation applied per group */
    baseMetric: {
        field: string;
        agg: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max';
    };
    /** The dimension used to group in Stage 1 */
    groupBy: {
        field: string;
        grain: 'day' | 'week' | 'month' | 'quarter' | 'year';
    };
    /** Stage 2: the final aggregation applied to the grouped results */
    finalAgg: 'avg' | 'sum' | 'min' | 'max' | 'count';
    /** Semantic type of the result */
    semanticType: SemanticType;
    /** User-facing description */
    description: string;
    /** Synonyms the user might use */
    synonyms: string[];
}

export interface SemanticModel {
    /** All fields in the dataset */
    fields: SemanticField[];
    /** Auto-detected and user-defined composite metrics */
    compositeMetrics: MetricDefinition[];
    /** Auto-generated derived metrics (two-stage aggregations) */
    derivedMetrics: DerivedMetricDefinition[];
    /** Dataset name */
    datasetName: string;
    /** Total row count */
    rowCount: number;
    /** Time context */
    timeContext?: {
        anchorDate: string;
        minDate: string;
        maxDate: string;
        primaryDateColumn: string;
    };
    /** Join graph (for multi-table datasets) */
    joinGraph?: {
        edges: { left: string; right: string; leftCol: string; rightCol: string; type: 'fk' | 'name_match' }[];
    };
    /** Declared grain of the dataset */
    grain: string;
}

// ─── Intent Planner ──────────────────────────────────────────────

export interface PlanDimension {
    field: string;
    timeGrain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface PlanMetric {
    field: string;
    agg: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max';
    /** For composite metrics — use the formula instead */
    compositeId?: string;
    /** For derived metrics (two-stage aggregation) — use the definition */
    derivedMetricId?: string;
}

export interface PlanFilter {
    field: string;
    op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'not_in' | 'between' | 'like'
    | 'this_month' | 'this_week' | 'this_year' | 'this_quarter' | 'this_day'
    | 'above_avg' | 'below_avg';
    value: any;
    /** Reference to composite metric ID for KPI-based filtering */
    compositeRef?: string;
    /** Whether this filter is a HAVING condition (post-aggregate) */
    isHaving?: boolean;
}

export interface PlanSort {
    field: string;
    dir: 'asc' | 'desc';
}

export type AnalysisIntent =
    | 'single_metric'      // "What is total sales?"
    | 'derived_metric'     // "Average daily sales" (two-stage aggregation)
    | 'breakdown'          // "Sales by category"
    | 'trend'              // "Sales over time"
    | 'trend_comparison'   // "Sales this month vs last month over time"
    | 'total_comparison'   // "Total sales this month vs last month"
    | 'ranking'            // "Top 10 products by sales"
    | 'share_of_total'     // "Percent of sales by region"
    | 'correlation'        // "Sales vs profit by category"
    | 'distribution'       // "Distribution of order values"
    | 'aggregate_filter'   // "Products with above-average sales"
    | 'growth_analysis';   // "Which products are driving revenue growth?"

export interface AnalysisPlan {
    /** Detected intent */
    intent: AnalysisIntent;
    /** Dimensions for the X-axis / GROUP BY */
    dimensions: PlanDimension[];
    /** Metrics to calculate */
    metrics: PlanMetric[];
    /** Filter conditions */
    filters: PlanFilter[];
    /** Comparison type (if any) */
    comparison?: {
        type: 'previous_period' | 'same_period_last_year' | 'custom';
        mode: 'trend' | 'total';
        offset?: number;
        grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    };
    /** Sorting */
    sort: PlanSort[];
    /** Row limit */
    limit: number | null;
    /** Whether the plan is ambiguous and needs clarification */
    ambiguous: boolean;
    /** Clarification question (when ambiguous) */
    clarificationQuestion?: string;
    /** Declared grain of the result */
    resultGrain: string;
    /** The original user question */
    originalQuestion: string;
}

// ─── SQL Validation ──────────────────────────────────────────────

export interface ValidationCheck {
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    checks: ValidationCheck[];
    correctedSQL?: string;
}

// ─── Result Profiling ────────────────────────────────────────────

export interface ResultProfile {
    rowCount: number;
    columnCount: number;
    metricCount: number;
    dimensionCount: number;
    /** Names of dimension columns in the result */
    dimensionColumns: string[];
    /** Names of metric columns in the result */
    metricColumns: string[];
    /** Number of unique values per dimension */
    dimensionCardinality: Record<string, number>;
    /** Whether the primary dimension is a time dimension */
    hasTimeDimension: boolean;
    /** The name of the time dimension column (if any) */
    timeDimensionColumn?: string;
    /** Scale mismatch ratio between metrics (e.g., 1000x) */
    metricsScaleMismatch: number;
    /** Semantic types of the metric columns */
    metricSemanticTypes: Record<string, SemanticType>;
    /** Whether the data is already pivoted (wide format) */
    isPivoted: boolean;
    /** Whether it's a single scalar result */
    isSingleValue: boolean;
}

// ─── Chart Recommendation ────────────────────────────────────────

export type RecommendedChart =
    | 'kpiCard'
    | 'line'
    | 'bar'
    | 'horizontalBar'
    | 'groupedBar'
    | 'stackedBar'
    | 'area'
    | 'dualAxisCombo'
    | 'multiLine'
    | 'donut'
    | 'heatmap'
    | 'table';

export interface ChartRecommendation {
    /** Primary chart type */
    chartType: RecommendedChart;
    /** X-axis key */
    xKey: string;
    /** Primary Y-axis key */
    yKey: string;
    /** Secondary Y keys (for dual-axis or multi-metric) */
    secondaryYKeys?: string[];
    /** Whether to use dual Y-axis */
    useDualAxis: boolean;
    /** Left axis config */
    leftAxisFormat?: 'currency_usd' | 'percent' | 'compact' | 'raw';
    /** Right axis config */
    rightAxisFormat?: 'currency_usd' | 'percent' | 'compact' | 'raw';
    /** Human-readable explanation of why this chart was chosen */
    reason: string;
    /** Should we apply Top-N + "Other" grouping? */
    topN?: number;
    /** Growth badge data (for comparison queries) */
    growth?: { diff: number; pct: number; label: string };
}

// ─── Confidence Scoring ──────────────────────────────────────────

export interface ConfidenceScore {
    /** 0–100 score */
    score: number;
    /** High / Medium / Low */
    level: 'high' | 'medium' | 'low';
    /** Breakdown of factors */
    factors: {
        semanticMatch: number;   // 0–30
        filterClarity: number;   // 0–20
        aggregationCertainty: number; // 0–20
        planComplexity: number;  // 0–15
        repairAttempts: number;  // 0–15
    };
    /** Human-readable reasons for the score */
    reasons: string[];
}

// ─── Audit Logging ───────────────────────────────────────────────

export interface AuditEntry {
    id: string;
    timestamp: number;
    userId?: string;
    question: string;
    plan: AnalysisPlan;
    sql: string;
    executionTimeMs: number;
    rowCount: number;
    confidence: ConfidenceScore;
    chartType: RecommendedChart;
    repairAttempts: number;
    error?: string;
    resultGrain: string;
}

// ─── Pipeline Result ─────────────────────────────────────────────

export interface TrustCheck {
    /** Business-language label */
    label: string;
    /** Check status */
    status: 'pass' | 'warn' | 'fail';
    /** Optional expanded detail (still business language) */
    detail?: string;
}

export interface TrustVerification {
    /** Overall trust status */
    status: 'verified' | 'needs_review' | 'validation_issue';
    /** Confidence level in business language */
    confidence: 'high' | 'medium' | 'low';
    /** Business-language verification checks */
    checks: TrustCheck[];
    /** Plain-English result explanation */
    explainResult: string;
    /** Summary sentence */
    summary: string;
}

// ─── Pipeline Trace (Transparency Report) ────────────────────────

export interface PipelineStepTrace {
    /** Step number in the pipeline */
    stepNumber: number;
    /** Human-readable step name */
    name: string;
    /** Engine identifier */
    engine: string;
    /** Emoji icon for visual display */
    icon: string;
    /** Milliseconds offset from pipeline start */
    startMs: number;
    /** Duration of this step in milliseconds */
    durationMs: number;
    /** Step outcome */
    status: 'pass' | 'warn' | 'skip' | 'fail';
    /** One-line human-readable summary */
    summary: string;
    /** Structured details for expandable view */
    details: Record<string, any>;
}

export interface PipelineTrace {
    /** Original user question */
    question: string;
    /** Total pipeline duration in milliseconds */
    totalDurationMs: number;
    /** Ordered list of step traces */
    steps: PipelineStepTrace[];
}

export interface AIQueryProvenance {
    /** Whether a deterministic compiler answered the question or an LLM fallback was needed. */
    strategy: 'deterministic' | 'llm-sql-fallback' | 'llm-plan';
    /** OpenRouter model used only when an LLM was needed. */
    model?: string;
    /** Plain-language explanation suitable for non-technical users. */
    summary: string;
    /** Explicit privacy statement for this request. */
    dataAccess: 'metadata_only' | 'approved_safe_values';
}

export interface AISQLPipelineResult {
    /** The structured analysis plan */
    plan: AnalysisPlan;
    /** Generated SQL */
    sql: string;
    /** Which engine generated `sql`: the local typed Question Builder
     *  compiler, the privacy-governed direct-SQL LLM fallback, or the
     *  deterministic correction engine. */
    engine?: 'question-builder' | 'llm-sql' | 'correction-engine' | 'llm';
    /** Validation checks */
    validation: ValidationResult;
    /** Raw query result data */
    rawData: Record<string, any>[];
    /** Chart-ready (reshaped) data */
    chartData: Record<string, any>[];
    /** Result profile */
    profile: ResultProfile;
    /** Chart recommendation */
    chart: ChartRecommendation;
    /** Confidence score */
    confidence: ConfidenceScore;
    /** AI explanation of the query */
    explanation: string;
    /** Columns used */
    columnsUsed: string[];
    /** Execution time in ms */
    executionTimeMs: number;
    /** Repair attempts used */
    repairAttempts: number;
    /** Trust & Verification Layer */
    trust?: TrustVerification;
    /** Pipeline transparency trace — step-by-step engine telemetry */
    trace?: PipelineTrace;
    /** How this answer was produced, including any LLM fallback. */
    provenance?: AIQueryProvenance;
    /** Exact LLM token cost for this question. Metadata and user-approved safe
     * values may be sent only when an LLM fallback is needed; rows remain local. */
    tokenUsage?: { prompt: number; completion: number; total: number };
}

