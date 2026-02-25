
export enum ColumnType {
  DIMENSION = 'DIMENSION',
  METRIC = 'METRIC',
  DATE = 'DATE',
  ID = 'ID',
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
}

export interface TimeContext {
  minDate: string; // ISO Date string YYYY-MM-DD
  maxDate: string; // ISO Date string YYYY-MM-DD
  defaultAnchorDate: string; // ISO Date string YYYY-MM-DD — max of the anchor column
  anchorDateColumn: string; // Which date column drives the time anchor (e.g. "order_date")
  dateColumnMaxDates: Record<string, string>; // Per-column max dates: { "order_date": "2018-12-31", "ship_date": "2019-01-05" }
}

export interface Dataset {
  id: string;
  name: string;
  rows: Record<string, any>[];
  columns: ColumnDefinition[];
  totalRows: number;
  etlLogs: ETLLog[];
  timeContext?: TimeContext;
  sourceSchema?: SourceSchema;
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
  COUNT_DISTINCT = 'COUNT_DISTINCT'
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
  showLabels: boolean;
  showDataLabels: boolean;
  tableCalculations: ('none' | 'percent_of_total' | 'rank_asc' | 'rank_desc' | 'running_total' | 'moving_avg' | 'pct_diff_from_prev' | 'diff_from_prev' | 'percentile')[];
  movingAvgWindow?: number; // Dynamic window size for moving average (default: 3)
  decimals?: number; // 0, 1, 2, or undefined (auto)
  dateFormat?: 'raw' | 'yyyy-mm-dd' | 'mm/dd/yyyy' | 'month_name_year' | 'month_short_year' | 'month_number' | 'month_name_only';
  axisBold?: boolean;
  axisColor?: string; // Hex color for axis tick labels
  mapLabelContent?: 'value' | 'name' | 'both';
  showAxis?: boolean; // Default to false (hidden) — legacy combined toggle
  showXAxis?: boolean; // Individual X-axis toggle (overrides showAxis when set)
  showYAxis?: boolean; // Individual Y-axis toggle (overrides showAxis when set)
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

export interface AlertConfig {
  enabled: boolean;
  threshold: number;
  operator: '>' | '<';
  color: string;
}

export interface DateFilter {
  column: string; // Date column name (e.g., 'order_date')
  timeGrain: 'year' | 'quarter' | 'month' | 'week' | 'day';
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
  comparison?: 'none' | 'previous_period';
  chartStyle?: 'vertical' | 'horizontal' | 'stacked' | 'normalized'; // Style variations for Bar/Area/Line

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
  sql: string; // Generated SQL query
  config: QueryConfig;
  error?: string; // If mapping failed
  kpi?: number | string; // Optional override for the main KPI number
  vis?: ChartConfig['type']; // Recommended visualization
  growth?: { diff: number; pct: number }; // Metadata for toggle
  validation?: {
    pre: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
    sql: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
    post: { status: 'valid' | 'warning' | 'error'; summary: string; checks: { name: string; status: 'pass' | 'warn' | 'fail'; message: string }[] };
  };
}

export interface DashboardItem {
  id: string;
  title: string;
  result: AnalysisResult;
  width: 'full' | 'half';
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
  DASHBOARD = 'DASHBOARD',
  BUILDER = 'BUILDER',
  WORKBENCH = 'WORKBENCH',
  DATA = 'DATA',
  ETL = 'ETL',
  SCHEMA = 'SCHEMA',
  CONNECTORS = 'CONNECTORS',
  NLQ = 'NLQ',
  CUSTOM_QUESTIONS = 'CUSTOM_QUESTIONS'
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
}
