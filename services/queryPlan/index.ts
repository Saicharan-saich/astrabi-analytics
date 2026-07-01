// ═══════════════════════════════════════════════════════════════════
// QueryPlan Engine — Barrel Export
// ═══════════════════════════════════════════════════════════════════

export type {
    QueryPlan, Expression, Metric, Dimension, RowFilter, RangeFilter,
    GroupFilter, Filters, OrderBy, AggregationType, TimeGrain,
    ResultColumn, ResultSchema,
    EnrichedQuery, ComparisonConfig, TableCalculation
} from './types';

export { dimensionId, deriveResultSchema } from './types';
export { buildQueryPlan } from './buildQueryPlan';
export type { UIQueryConfig } from './buildQueryPlan';
export { validatePlan } from './validatePlan';
export type { ValidationResult } from './validatePlan';
export { compileSQL, compileEnrichedSQL } from './sqlCompiler';
export { executeQueryPlan } from './executeQueryPlan';
export type { ExecutionResult } from './executeQueryPlan';
