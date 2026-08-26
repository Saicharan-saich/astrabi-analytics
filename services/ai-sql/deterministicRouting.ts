import type { AnalysisPlan, SemanticModel } from './types';

/**
 * Scalar period totals have a closed, deterministic SQL shape: one aggregate
 * for the current window and one for the previous window. Sending this shape
 * through free-form SQL generation can only weaken it by introducing an
 * unrequested detail grain (for example order_id).
 */
export function canCompileTotalPeriodComparisonLocally(
    plan: AnalysisPlan,
    model: SemanticModel,
    derivedMetricApplied = false,
): boolean {
    if (derivedMetricApplied
        || plan.intent !== 'total_comparison'
        || plan.comparison?.mode !== 'total'
        || plan.dimensions.length !== 0
        || plan.metrics.length === 0) {
        return false;
    }

    return plan.filters.some(filter => {
        const field = model.fields.find(candidate =>
            candidate.name.toLowerCase() === filter.field.toLowerCase()
        );
        return field?.semanticType === 'date'
            && filter.op === 'between'
            && Array.isArray(filter.value)
            && filter.value.length === 2;
    });
}
