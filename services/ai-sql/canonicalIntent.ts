/**
 * Canonical Query Intent
 *
 * The semantic planner, three-model SQL route, deterministic compiler and
 * validators must not each invent their own answer shape. This module turns
 * the high-confidence QueryContract into the single executable intent shared
 * by those stages, while retaining the original AnalysisPlan as compatibility
 * input for filters, time logic and metric field grounding.
 */
import type { AnalysisPlan, AnalysisIntent, PlanMetric } from './types';
import type { QueryContract } from './queryContract';

export type CanonicalAnswerKind =
    | 'detail_projection'
    | 'scalar_aggregate'
    | 'grouped_aggregate'
    | 'ranked_result'
    | 'comparison'
    | 'set_result';

export interface CanonicalQueryIntent {
    version: 1;
    answerKind: CanonicalAnswerKind;
    cardinality: QueryContract['expectedCardinality'];
    visibleFields: string[];
    grainFields: string[];
    aggregations: Array<'sum' | 'avg' | 'count' | 'min' | 'max'>;
    measures: Array<{
        field?: string;
        aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max';
        confidence: 'high' | 'medium';
    }>;
    predicates: QueryContract['requiredPredicates'];
    ratio: QueryContract['ratio'];
    selection: QueryContract['selectionMode'];
    order?: {
        field?: string;
        aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
        mode?: 'row_value' | 'group_aggregate' | 'frequency';
        direction: 'asc' | 'desc';
        limit?: number;
    };
    relationship: {
        tables: string[];
        mode: QueryContract['relationshipMode'];
        existence: QueryContract['existenceMode'];
        path: QueryContract['relationshipPath'];
    };
    constraints: {
        prohibitImplicitLimit: boolean;
        distinctProjection: boolean;
        strictOutputProjection: boolean;
    };
}

export interface CanonicalReconciliation {
    plan: AnalysisPlan;
    changes: string[];
}

function unique(values: string[]): string[] {
    return values.filter((value, index, all) => value && all.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
}

export function buildCanonicalQueryIntent(contract: QueryContract): CanonicalQueryIntent {
    const measureFields = new Set((contract.expectedMeasures || [])
        .map(measure => measure.field?.toLowerCase())
        .filter((field): field is string => Boolean(field)));
    const answerKind: CanonicalAnswerKind = contract.requiresComparison
        ? 'comparison'
        : contract.existenceMode === 'anti'
            ? 'set_result'
            : contract.requiresRanking
                ? 'ranked_result'
                // Scalar and grouped aggregates MUST be checked before projection.
                // The old ordering let requiresRowProjection override legitimate
                // aggregate intents (aggregate_filter, single_metric, breakdown),
                // stripping GROUP BY, HAVING, and SUM/AVG from the plan.
                : contract.expectedCardinality === 'scalar' && !contract.requiresRowProjection
                    ? 'scalar_aggregate'
                    : contract.requiresGrouping
                        ? 'grouped_aggregate'
                        : contract.requiresRowProjection || contract.orderedProjection
                            ? 'detail_projection'
                            : 'detail_projection';

    return {
        version: 1,
        answerKind,
        cardinality: contract.expectedCardinality,
        visibleFields: unique(contract.requiredOutputFields
            .filter(field => field.confidence === 'high')
            .map(field => field.field)),
        grainFields: unique([
            ...(contract.requiredDimension ? [contract.requiredDimension] : []),
            ...contract.uniqueResultFields,
            ...(contract.requiresGrouping
                ? contract.requiredOutputFields
                    .filter(field => field.confidence === 'high' && !measureFields.has(field.field.toLowerCase()))
                    .map(field => field.field)
                : []),
        ]),
        aggregations: [...(contract.expectedAggregations || (contract.expectedAggregation ? [contract.expectedAggregation] : []))],
        measures: [...(contract.expectedMeasures || (contract.expectedAggregation
            ? [{ aggregation: contract.expectedAggregation, confidence: 'medium' as const }]
            : []))],
        predicates: (contract.requiredPredicates || []).map(predicate => ({ ...predicate })),
        ratio: contract.ratio ? { ...contract.ratio } : undefined,
        selection: contract.selectionMode,
        order: contract.requiresRanking
            ? {
                field: contract.rankingTarget?.field,
                aggregation: contract.rankingTarget?.aggregation,
                mode: contract.rankingTarget?.mode,
                direction: contract.rankingDirection || 'desc',
                limit: contract.rankingLimit,
            }
            : contract.orderedProjection
                ? {
                    field: contract.orderedProjection.orderBy,
                    direction: contract.orderedProjection.direction,
                }
                : undefined,
        relationship: {
            tables: [...contract.requiredTables],
            mode: contract.relationshipMode,
            existence: contract.existenceMode,
            path: contract.relationshipPath.map(step => ({ ...step })),
        },
        constraints: {
            prohibitImplicitLimit: contract.prohibitsImplicitLimit,
            distinctProjection: contract.requiresDistinctProjection,
            strictOutputProjection: contract.strictOutputProjection,
        },
    };
}

function reconcileMetrics(plan: AnalysisPlan, canonical: CanonicalQueryIntent): PlanMetric[] {
    if (canonical.answerKind === 'detail_projection' || canonical.aggregations.length === 0) return [];
    if (plan.metrics.length === 0) {
        return canonical.measures
            .filter((measure): measure is typeof measure & { field: string } => Boolean(measure.field))
            .map(measure => ({ field: measure.field, agg: measure.aggregation }));
    }

    // Preserve schema-grounded metric fields. Only the operation is canonical.
    // If the question explicitly requests several operations over one measure,
    // duplicate that grounded measure rather than silently dropping an output.
    return canonical.measures.map((measure, index) => {
        const aggregation = measure.aggregation;
        const exact = plan.metrics.find(metric => metric.agg === aggregation);
        const source = exact || plan.metrics[Math.min(index, plan.metrics.length - 1)] || plan.metrics[0];
        return { ...source, field: measure.field || source.field, agg: aggregation };
    });
}

/**
 * Reconcile only structural facts that the question contract established with
 * high confidence. Filters, comparisons, time grains and physical metric field
 * choices remain untouched unless their structural operation conflicts.
 */
export function reconcilePlanWithCanonicalIntent(
    draft: AnalysisPlan,
    canonical: CanonicalQueryIntent,
): CanonicalReconciliation {
    const plan: AnalysisPlan = {
        ...draft,
        dimensions: draft.dimensions.map(dimension => ({ ...dimension })),
        metrics: draft.metrics.map(metric => ({ ...metric })),
        filters: draft.filters.map(filter => ({ ...filter })),
        sort: draft.sort.map(sort => ({ ...sort })),
        projectionFields: draft.projectionFields ? [...draft.projectionFields] : undefined,
    };
    const changes: string[] = [];

    // conditional_percentage is always a scalar answer — never downgrade it.
    if (plan.intent === 'conditional_percentage') {
        plan.dimensions = [];
        plan.resultGrain = 'one scalar result row';
        return { plan, changes };
    }

    if (canonical.answerKind === 'detail_projection') {
        if (plan.intent !== 'projection') changes.push(`intent ${plan.intent} -> projection`);
        plan.intent = 'projection';
        if (plan.metrics.length) changes.push('removed aggregate metrics from row projection');
        plan.metrics = [];
        if (canonical.visibleFields.length) {
            const fields = unique([...canonical.visibleFields, ...(plan.projectionFields || [])]);
            plan.projectionFields = fields;
            plan.dimensions = fields.map(field => ({ field }));
        }
        if (canonical.constraints.prohibitImplicitLimit && plan.limit !== null) {
            plan.limit = null;
            changes.push('removed implicit LIMIT from unbounded projection');
        }
        if (canonical.order?.field) {
            plan.sort = [{ field: canonical.order.field, dir: canonical.order.direction }];
        }
        plan.resultGrain = 'one row per matching source record';
        return { plan, changes };
    }

    if (canonical.cardinality === 'scalar' && !plan.comparison) {
        if (plan.dimensions.length) changes.push('removed grouping dimensions from scalar answer');
        plan.dimensions = [];
        plan.intent = 'single_metric';
        plan.resultGrain = 'one scalar result row';
    } else if (canonical.grainFields.length) {
        const existingDimensions = plan.dimensions;
        const reconciledDimensions = canonical.grainFields.map(field =>
            existingDimensions.find(dimension => dimension.field.toLowerCase() === field.toLowerCase()) || { field }
        );
        const oldGrain = existingDimensions.map(dimension => dimension.field.toLowerCase()).sort().join('|');
        const newGrain = reconciledDimensions.map(dimension => dimension.field.toLowerCase()).sort().join('|');
        if (oldGrain !== newGrain) changes.push(`aligned grouping grain to ${canonical.grainFields.join(', ')}`);
        plan.dimensions = reconciledDimensions;
        if (canonical.answerKind === 'ranked_result') plan.intent = 'ranking';
        else if (plan.intent === 'single_metric' || plan.intent === 'projection') plan.intent = 'breakdown';
        plan.resultGrain = `one row per ${canonical.grainFields.join(' + ')}`;
    }

    const metrics = reconcileMetrics(plan, canonical);
    if (metrics.length && JSON.stringify(metrics) !== JSON.stringify(plan.metrics)) {
        changes.push(`aligned aggregate operations to ${canonical.aggregations.join(', ')}`);
        plan.metrics = metrics;
    }

    if (canonical.constraints.prohibitImplicitLimit && plan.limit !== null) {
        plan.limit = null;
        changes.push('removed implicit LIMIT from all-results request');
    }
    if (canonical.order) {
        if (canonical.order.limit !== undefined && plan.limit !== canonical.order.limit) {
            plan.limit = canonical.order.limit;
            changes.push(`aligned ranking limit to ${canonical.order.limit}`);
        }
        const sortField = canonical.order.field || plan.metrics[0]?.field || canonical.grainFields[0] || plan.sort[0]?.field;
        if (sortField) {
            plan.sort = [{ field: sortField, dir: canonical.order.direction }];
            changes.push(`aligned ranking direction to ${canonical.order.direction}`);
        }
    }

    return { plan, changes };
}

export function canonicalIntentToAnalysisIntent(canonical: CanonicalQueryIntent): AnalysisIntent {
    if (canonical.answerKind === 'detail_projection' || canonical.answerKind === 'set_result') return 'projection';
    if (canonical.answerKind === 'ranked_result') return 'ranking';
    if (canonical.answerKind === 'comparison') return 'total_comparison';
    if (canonical.answerKind === 'grouped_aggregate') return 'breakdown';
    return 'single_metric';
}
