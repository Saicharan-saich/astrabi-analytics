
export enum ColumnType {
  DIMENSION = 'DIMENSION',
  METRIC = 'METRIC',
  DATE = 'DATE',
  ID = 'ID',
  BOOLEAN = 'BOOLEAN',
  UNKNOWN = 'UNKNOWN'
}

export interface ColumnDefinition {
  name: string;
  type: ColumnType;
  originalType: string;
}

export interface ETLLog {
  step: string;
  stepNumber?: number;
  details: string;
  status: 'applied' | 'skipped' | 'info';
  timestamp: number;
  rowsBefore?: number;
  rowsAfter?: number;
  affectedColumns?: string[];
  affectedRows?: number;
  /** Sample rows that were removed (for duplicate/empty row removal) */
  removedRowSamples?: Record<string, any>[];
  /** Before/after value samples for column transforms */
  transformSamples?: { column: string; before: any; after: any }[];
}

export interface TimeContext {
  minDate: string; // ISO Date string YYYY-MM-DD
  maxDate: string; // ISO Date string YYYY-MM-DD
  defaultAnchorDate: string; // ISO Date string YYYY-MM-DD — max of the anchor column
  anchorDateColumn: string; // Which date column drives the time anchor (e.g. "order_date")
  dateColumnMaxDates: Record<string, string>; // Per-column max dates: { "order_date": "2018-12-31", "ship_date": "2019-01-05" }
}

export interface DimDateRow {
  date_key: string;       // YYYY-MM-DD
  year: number;
  quarter: number;
  quarter_label: string;  // "Q4 2017"
  month: number;
  month_name: string;     // "December"
  month_short: string;    // "Dec"
  week_of_year: number;
  day_of_month: number;
  day_of_week: number;    // Mon=1 .. Sun=7 (ISO)
  day_name: string;       // "Monday"
  is_weekend: boolean;
  fiscal_year: number;    // April start
  fiscal_quarter: number;
}

// ─── Connection Mode Types ───────────────────────────────────────
export type ConnectionMode = 'import' | 'live';

export interface LiveConnectionInfo {
  connectionId: string;      // Backend connection ID (kept alive for live mode)
  dbType: 'mssql' | 'pg';   // Database engine type
  tables: string[];          // Selected source tables
  joinEdges: any[];          // Join edges for multi-table merging
  // Non-sensitive metadata for reconnection (password is NEVER stored)
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  ssl?: boolean;
}

// ─── AI Semantic Profiling Types ─────────────────────────────────
export interface ColumnSemantic {
  role: ColumnType;
  aggregation: 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MIN' | 'MAX' | 'NONE';
  format: 'currency_usd' | 'currency_eur' | 'percent' | 'raw' | 'count' | 'date_iso';
  humanLabel: string;
  description: string;
  semanticRole?: string;         // Canonical role: "primary_metric", "primary_dimension", "primary_date", etc.
  isHidden: boolean;             // Auto-hide junk/system columns
}

export interface MaskedColumnProfile {
  name: string;
  inferredType: 'string' | 'number' | 'date' | 'boolean';
  nullRate: number;              // 0.02 = 2% null
  distinctCount: number;
  totalRows: number;
  numericStats?: { min: number; max: number; mean: number; median: number };
  dateRange?: { min: string; max: string };
  patternHint?: string;          // "email", "uuid", "phone", "ssn_format", "currency", "date_iso", "url", etc.
  topPatterns?: string[];        // ["3-letter code", "Full sentence", etc.]
  currencyDetected?: boolean;
  percentageDetected?: boolean;
}

export interface DatasetDomainProfile {
  domain: string;                // "Sales", "HR", "Finance", "Healthcare", etc.
  subDomain?: string;            // "E-Commerce", "Payroll", "SaaS", etc.
  summary: string;               // "This dataset contains employee payroll records..."
  confidence: number;            // 0-1 confidence score
  grain?: string;                // What each row represents: "Order", "Employee", "Transaction", etc.
  themeColor?: string;           // Domain-specific accent color
  columnSemantics: Record<string, ColumnSemantic>;
  suggestedQuestionCategories?: string[];
  detectedAt: number;            // Timestamp
}

export interface Dataset {
  id: string;
  name: string;
  rows: Record<string, any>[];
  rawRows?: Record<string, any>[];
  columns: ColumnDefinition[];
  totalRows: number;
  etlLogs: ETLLog[];
  timeContext?: TimeContext;
  dimDate?: DimDateRow[];
  sourceSchema?: SourceSchema;
  /**
   * The original tables, kept UNJOINED, when the source had more than one
   * (multi-sheet workbook or a multi-table connector). `rows` above is the
   * flattened join that the rest of the app works from; these let AI SQL query
   * the real tables instead, so a one-to-many join cannot inflate a total.
   */
  relatedTables?: RelatedTable[];
  domainProfile?: DatasetDomainProfile;  // AI-generated domain context
  // ── Connection Mode ──
  connectionMode?: ConnectionMode;       // 'import' (default/snapshot) or 'live' (real-time)
  liveConnection?: LiveConnectionInfo;   // Only present when connectionMode === 'live'
  // ── System Correction Directive additions ──
  semanticModel?: import('./services/semanticModel').SemanticModel; // Deterministic semantic model (MANDATORY for analysis)
  version?: number;            // Incremented on every re-upload or re-ETL
  createdAt?: number;          // Timestamp of dataset creation
  refreshSchedule?: RefreshSchedule;     // Auto-refresh configuration for live connections
}

/** Dataset-level refresh scheduler configuration */
export interface RefreshSchedule {
  enabled: boolean;
  intervalMs: number;              // Refresh interval in ms (min 300000 = 5min)
  lastRefreshAt?: number;          // Unix timestamp of last successful refresh
  consecutiveFailures?: number;    // Pause scheduler after 3 consecutive failures
}

/** One of the original, unjoined source tables. */
export interface RelatedTable {
  name: string;
  rows: Record<string, any>[];
}

export interface SourceSchema {
  tables: SourceTableInfo[];
  joinEdges: SourceJoinEdge[];
  joinLogs: string[];
}

export interface SourceTableInfo {
  name: string;
  rows: number;
  columns: SourceColumnInfo[];
}

export interface SourceColumnInfo {
  name: string;
  dataType: string;
  isPK: boolean;
  isNullable: boolean;
}

export interface SourceJoinEdge {
  leftTable: string;
  rightTable: string;
  leftColumn: string;
  rightColumn: string;
  type: 'fk' | 'name_match';
}

export enum AggregationType {
  SUM = 'SUM',
  AVG = 'AVG',
  COUNT = 'COUNT',
  MAX = 'MAX',
  MIN = 'MIN',
  COUNT_DISTINCT = 'COUNT_DISTINCT',
  NONE = 'NONE'
}

export enum TimeGrain {
  RAW = 'Raw Date',
  YEAR = 'Year',
  QUARTER = 'Quarter',
  MONTH = 'Month',
  WEEK = 'Week',
  DAY = 'Day'
}

export enum AnalysisType {
  STANDARD = 'Standard',
  RUNNING_TOTAL = 'Running Total',
  PERCENT_TOTAL = '% of Total',
  RANK = 'Rank',
  DIFFERENCE = 'Difference From Previous',
  PERCENT_DIFFERENCE = '% Difference From Previous'
}

export type FormattingConfig = {
  colorMode: 'vibrant' | 'electric' | 'neon' | 'sunset' | 'ocean' | 'blueSequential' | 'greenSequential' | 'purpleSequential' | 'orangeSequential' | 'tealSequential';
  numberFormat: 'auto' | 'raw' | 'currency_usd' | 'currency_eur' | 'percent' | 'compact';
  fontSize: 'sm' | 'md' | 'lg';
  headerSize: 'sm' | 'md' | 'lg' | 'xl';
  headerBold: boolean;
  headerColor?: string; // Hex color for chart title text
  showLabels: boolean;
  showDataLabels: boolean;
  dataLabelMode?: 'off' | 'primary' | 'all'; // off=hidden, primary=main metric only, all=every dataset
  dataLabelSize?: 'xs' | 'sm' | 'md' | 'lg'; // Independent data label font size
  dataLabelBold?: boolean; // Bold data labels (default: true for backward compat)
  dataLabelColor?: string; // Hex color for data labels (default: '#334155')
  tableCalculations: import('./utils/tableCalculations').TableCalculation[];
  movingAvgWindow?: number; // Dynamic window size for moving average (default: 3)
  decimals?: number; // 0, 1, 2, or undefined (auto)
  dateFormat?: 'raw' | 'yyyy-mm-dd' | 'mm/dd/yyyy' | 'month_name_year' | 'month_short_year' | 'month_number' | 'month_name_only';
  axisBold?: boolean;
  axisColor?: string; // Hex color for axis tick labels
  axisLabelSize?: 'xs' | 'sm' | 'md' | 'lg'; // Independent axis tick label font size
  mapLabelContent?: 'value' | 'name' | 'both';
  showAxis?: boolean; // Default to false (hidden) — legacy combined toggle
  showXAxis?: boolean; // Individual X-axis toggle (overrides showAxis when set)
  showYAxis?: boolean; // Individual Y-axis toggle (overrides showAxis when set)
  yAxisFormat?: 'compact' | 'full' | 'short_currency'; // Y-axis tick format: compact ($2.5K), full ($2,500.00), short_currency ($2.5K)
  showGridLines?: boolean; // Toggle grid lines visibility (default: auto based on chart type)
  /** Internal: marks that stored formatting has had the one-off legibility upgrade applied. */
  _legibilityUpgraded?: boolean;
};

export interface ChartConfig {
  color: string;
  colorMode: 'single' | 'sequential' | 'discrete';
  showLabels: boolean;
  showGrid: boolean;
  type: 'bar' | 'horizontalBar' | 'stackedBar' | 'groupedBar' | 'line' | 'curvedLine' | 'steppedLine' | 'area' | 'stackedArea' | 'pie' | 'doughnut' | 'polarArea' | 'radar' | 'scatter' | 'bubble' | 'treemap' | 'waterfall' | 'funnel' | 'lollipop' | 'gauge' | 'kpiCard' | 'map' | 'table' | 'kpi' | 'combo';
  fontSize?: 'sm' | 'md' | 'lg';
  conditionalFormatting?: boolean; // For pos/neg spotlighting

  // New Formatting Options
  xAxisFormat: 'raw' | 'year' | 'month_year' | 'month_name' | 'date_short' | 'day_name';
  yAxisFormat: 'raw' | 'number' | 'currency' | 'compact';
  decimals: number;
}

/** @deprecated Use AlertRule for the new monitoring system */
export interface AlertConfig {
  enabled: boolean;
  threshold: number;
  operator: '>' | '<';
  color: string;
}

// ─── Monitoring Alert System Types ──────────────────────────────
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertStatus = 'active' | 'snoozed' | 'resolved' | 'disabled';

export type AlertTimeRange =
  | { type: 'today' }
  | { type: 'yesterday' }
  | { type: 'last_n_days'; value: number }
  | { type: 'this_month' }
  | { type: 'this_quarter' }
  | { type: 'this_year' }
  | { type: 'all_time' };

export type AlertCondition =
  | { type: 'threshold'; operator: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
  | { type: 'trend'; direction: 'increases' | 'decreases'; changePercent: number;
      comparisonPeriod: 'previous_day' | 'previous_week' | 'previous_month' | 'previous_quarter' };

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  severity: AlertSeverity;
  status: AlertStatus;
  // What to monitor (QueryPlan-compatible)
  datasetId: string;
  datasetName: string;
  metric: string;
  aggregation: 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MIN' | 'MAX';
  // Dimension scope (optional filters)
  filters?: { column: string; operator: string; value: string }[];
  // Time range
  timeRange: AlertTimeRange;
  // Condition
  condition: AlertCondition;
  // Metadata
  createdAt: number;
  updatedAt: number;
  lastEvaluatedAt?: number;
  lastTriggeredAt?: number;
  lastValue?: number;
  snoozedUntil?: number;
  // UI
  icon?: string;
  color?: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  triggeredAt: number;
  currentValue: number;
  previousValue?: number;
  thresholdValue?: number;
  changePercent?: number;
  message: string;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

export interface DateFilter {
  column: string; // Date column name (e.g., 'order_date')
  timeGrain: 'minute' | 'hour' | 'year' | 'quarter' | 'month' | 'week' | 'day';
  values: string[]; // Selected values (e.g., ['2023', '2024'] or ['2023-Q1', '2023-Q2'])
}

export interface QueryConfig {
  metric: string;
  dimension: string;
  aggregation: AggregationType;
  timeGrain: TimeGrain;
  analysisType: AnalysisType;
  limit?: number; // Top N
  sort?: 'desc' | 'asc' | 'oldest' | 'newest';

  // Persisted UI State
  chartType?: 'bar' | 'line' | 'pie' | 'doughnut' | 'polarArea' | 'radar' | 'treemap' | 'scatter' | 'bubble' | 'area' | 'combo' | 'map' | 'kpi' | 'table';
  questionLabel?: string;
  filters?: Record<string, string[]>; // Map of Dimension -> Valid Values
  measureFilters?: Array<{ column: string; operator: string; value: number }>; // Numeric filters
  dateFilters?: DateFilter[]; // Hierarchical date filters
  alert?: AlertConfig;
  chart?: ChartConfig;
  asOfDate?: string; // ISO Date YYYY-MM-DD - Universal Time Anchor
  includeZeroValues?: boolean; // For finding "unsold" items
  comparison?: 'none' | 'previous_period' | 'same_period_last_year' | 'same_period_last_n';
  comparisonMode?: 'total' | 'trend'; // total = side-by-side bars, trend = dual-line overlay
  comparisonGrain?: 'day' | 'week' | 'month' | 'quarter' | 'year'; // grain for trend mode
  comparisonOffset?: number; // For same_period_last_n: how many grains back (default 1)
  chartStyle?: 'vertical' | 'horizontal' | 'stacked' | 'normalized'; // Style variations for Bar/Area/Line
  secondaryMetrics?: string[]; // Additional metrics to overlay (e.g., profit alongside revenue)
  axisMode?: 'auto' | 'single' | 'dual' | 'blended'; // How to handle Y axes for multi-metric
  secondaryMetricVisuals?: Record<string, string>; // Per-metric visual type: { 'quantity': 'bar', 'discount': 'area' }
  secondaryMetricAggregations?: Record<string, string>; // Per-metric aggregation: { 'quantity': 'SUM', 'discount': 'AVG' }
  secondaryDimensions?: string[]; // Additional grouping dimensions (e.g., ['region', 'category'])
  tableCalculations?: string[]; // Table calculations to apply post-aggregation (e.g., pct_change, diff_from_prev)

  // Deterministic Engine
  questionId?: string;
  semanticRoles?: Record<string, string>;
  timeFilter?: string;
}

export interface AnalysisResult {
  data: any[];
  xKey: string;
  yKey: string;
  yLabel: string;
  insight: string;
  sql: string; // Generated SQL query (base — no table calculations)
  calculatedSql?: string; // Enriched SQL with table calculations (CTE + window functions)
  config: QueryConfig;
  error?: string; // If mapping failed
  kpi?: number | string; // Optional override for the main KPI number
  vis?: ChartConfig['type']; // Recommended visualization
  formatting?: FormattingConfig; // Per-item formatting (preserved when pinning)
  growth?: { diff: number; pct: number }; // Metadata for toggle
  secondaryYKeys?: string[]; // Additional metric keys in data rows (e.g., ['profit', 'quantity'])
  axisMode?: 'single' | 'dual' | 'blended'; // Recommended axis mode for multi-metric
  validation?: {
    pre: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
    sql: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
    post: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
  };
  queryConfig?: any; // Fix #8: Original query config for dashboard re-evaluation
  // ── System Correction Directive additions ──
  confidence?: number;         // 0-1 confidence score (reduced for inferred joins, high nulls, etc.)
  warnings?: string[];         // Human-readable warnings ("Join inferred", "Aggregation defaulted", etc.)
  explainability?: {           // Traceable computation explanation
    metric: string;            // e.g., "revenue"
    aggregation: string;       // e.g., "SUM"
    sourceColumn: string;      // e.g., "total_sales"
    dimension: string;         // e.g., "region"
    filtersApplied: string[];  // e.g., ["year = 2024", "region IN ('North', 'South')"]
    rowsProcessed: number;     // How many rows were aggregated
  };
}

export interface DashboardItem {
  id: string;
  title: string;
  result: AnalysisResult;
  width: 'full' | 'half';
  pinnedAt?: number; // Fix #8: Timestamp of last pin/refresh
  datasetId?: string;   // ID of dataset this card was pinned from
  datasetName?: string; // Human-readable dataset name for badges
  // ── System Correction Directive additions ──
  datasetVersion?: number; // Version of dataset when this item was pinned (mismatch → stale warning)
  /** When true this card ignores all dashboard-level global filters */
  ignoreGlobalFilter?: boolean;
}

export interface DashboardDefinition {
  id: string;
  name: string;
  items: DashboardItem[];
  layout: any[] | null;
  filters: any[];
  createdAt: number;
  /** True when produced by the opt-in "Build my dashboard" action. Lets a rebuild
   *  find and replace the previous auto-Overview instead of stacking a duplicate. */
  autoGenerated?: boolean;
  /** The dataset this auto-Overview was built from (for idempotent rebuilds). */
  sourceDatasetId?: string;
}

export interface Connector {
  id: string;
  name: string;
  icon: string;
  status: 'connected' | 'disconnected' | 'configuring';
}

export type QuestionGrain = 'order' | 'item' | 'customer' | 'any' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export type EvalType = 'ranking' | 'comparison' | 'trend' | 'kpi' | 'percentOfTotal' | 'movingAvg' | 'runningTotal' | 'custom';

export interface QuestionTemplate {
  id: string;
  category: string;
  question: string;
  // Registry fields
  req: string[];
  grain: QuestionGrain;
  sql: string;
  vis: ChartConfig['type'];
  // Optional: explicit evaluation type for custom questions
  evalType?: EvalType;
  // Is this a custom (user-created) question?
  isCustom?: boolean;
  // Domain tag — "Sales", "HR", "Finance", "Healthcare", etc. (undefined = universal/Sales)
  domain?: string;
  // Domain-aware aggregation — tells the engine HOW to aggregate the metric column
  // e.g., rates/percentages should use AVG, counts should use COUNT_DISTINCT, amounts should use SUM
  defaultAgg?: 'SUM' | 'AVG' | 'COUNT' | 'COUNT_DISTINCT' | 'MIN' | 'MAX';
  // Display format hint — tells the renderer how to format the result number
  numberFormat?: 'currency' | 'percent' | 'raw' | 'count' | 'score' | 'ratio';
  // Parameterized SQL template with semantic placeholders ({entity_id}, {dept}, {salary}, etc.)
  // Resolved at runtime by sqlTemplateResolver.ts
  sqlTemplate?: string;
}

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  uniqueCount: number;
  nullCount: number;
  topValues: { value: string, count: number }[];
  min?: number;
  max?: number;
  avg?: number;
}

// --- NEW SEMANTIC TYPES ---
export type SchemaType = 'flat' | 'shopify_like' | 'woocommerce_hpos';

export interface CanonicalMapping {
  schemaType: SchemaType;
  fields: Record<string, string>; // role (e.g. 'revenue') -> column name (e.g. 'total_sales')
  missingFields: string[];
}

export interface QuestionBuilderState {
  metric: string;     // e.g. "revenue"
  dimension: string;  // e.g. "product_name"
  timeGrain: string;  // e.g. "month"
  msg: string;        // Constructed sentence
}

export enum Tab {
  UPLOAD = 'UPLOAD',
  COLUMN_MAPPING = 'COLUMN_MAPPING',
  DASHBOARD = 'DASHBOARD',
  BUILDER = 'BUILDER',
  WORKBENCH = 'WORKBENCH',
  DATA = 'DATA',
  ETL = 'ETL',
  DATA_STUDIO = 'DATA_STUDIO',
  SCHEMA = 'SCHEMA',
  CONNECTORS = 'CONNECTORS',
  NLQ = 'NLQ',
  AI_SQL = 'AI_SQL',
  CUSTOM_QUESTIONS = 'CUSTOM_QUESTIONS',
  DATASET_SUMMARY = 'DATASET_SUMMARY',
  SMART_QUESTIONS = 'SMART_QUESTIONS',
  ALERTS = 'ALERTS',
  VISUAL_PREVIEW = 'VISUAL_PREVIEW',
  DERIVED_COLUMNS = 'DERIVED_COLUMNS',
  USER_INSIGHTS = 'USER_INSIGHTS',
  QUICK_INSIGHTS = 'QUICK_INSIGHTS',
  PARAMETERS = 'PARAMETERS',
  LEGAL = 'LEGAL',
  GAME = 'GAME'
}

// ─── Authentication & RBAC ───────────────────────────────────────
export enum UserRole {
  ADMIN = 'ADMIN',
  CONTRIBUTOR = 'CONTRIBUTOR',
  VIEWER = 'VIEWER'
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string; // simple hash for frontend-only auth
  createdAt: number;
  avatar?: string; // initials-based avatar color
  aiSqlUsage?: {
    count: number;           // Number of AI SQL queries used in current 24h window
    windowStart: number;     // Unix timestamp of when the 24h window started
  };
}
