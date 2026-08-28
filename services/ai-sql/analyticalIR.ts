/**
 * Canonical Analytical IR
 *
 * This is the immutable analytical meaning shared by planning, SQL generation,
 * validation and result checks. Engines may contribute evidence before the IR
 * is frozen; they must not independently change projection, grain, population
 * or operation semantics afterwards.
 */
import type { AnalysisPlan, PlanFilter, SemanticField, SemanticModel } from './types';
import type { QueryContract } from './queryContract';
import type { CanonicalQueryIntent } from './canonicalIntent';

export type IRConfidence = 'high' | 'medium' | 'low';

export interface IREvidence {
    source: 'question' | 'schema' | 'statistics' | 'relationship' | 'time' | 'contract' | 'planner';
    fact: string;
    confidence: IRConfidence;
    reason: string;
}

export interface IRFieldRef {
    field: string;
    table?: string;
    role: 'entity' | 'dimension' | 'measure' | 'identifier' | 'date' | 'calculation';
    visibility: 'visible' | 'helper';
    confidence: IRConfidence;
    unit?: SemanticField['unit'];
    additivity?: SemanticField['additivity'];
    nativeGrain?: string;
}

export interface IRPredicate {
    field: string;
    table?: string;
    operator: PlanFilter['op'];
    value: unknown;
    scope: 'where' | 'having';
    confidence: IRConfidence;
}

export interface IRPopulation {
    id: string;
    role: 'base' | 'filtered' | 'numerator' | 'denominator' | 'reference';
    entity?: IRFieldRef;
    tables: string[];
    filters: IRPredicate[];
    description: string;
}

export type AnalyticalOperator =
    | { id: string; kind: 'join'; path: QueryContract['relationshipPath']; mode: QueryContract['relationshipMode']; dependsOn: string[] }
    | { id: string; kind: 'filter'; populationId: string; predicates: IRPredicate[]; dependsOn: string[] }
    | { id: string; kind: 'set'; operation: 'intersection' | 'difference'; entity?: IRFieldRef; dependsOn: string[] }
    | { id: string; kind: 'group'; grain: IRFieldRef[]; dependsOn: string[] }
    | { id: string; kind: 'aggregate'; measures: Array<IRFieldRef & { aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max'; alias: string }>; dependsOn: string[] }
    | { id: string; kind: 'derive'; calculations: Array<{ id: string; label: string; alias: string; formula: string; dependsOnFields: string[]; visibility: 'visible' | 'helper'; unit?: SemanticField['unit'] }>; dependsOn: string[] }
    | { id: string; kind: 'relative_compare'; scope: NonNullable<QueryContract['relativeComparison']>['scope']; referencePopulationId: string; comparator: '>' | '>=' | '<' | '<='; multiplier: number; measure?: IRFieldRef; dependsOn: string[] }
    | { id: string; kind: 'ratio'; basis: 'row_count' | 'measure'; numeratorPopulationId: string; denominatorPopulationId: string; scale: number; dependsOn: string[] }
    | { id: string; kind: 'compare_periods'; mode: 'total' | 'trend'; grain?: string; dependsOn: string[] }
    | { id: string; kind: 'window'; operation: CanonicalQueryIntent['analyticOperations'][number]; dependsOn: string[] }
    | { id: string; kind: 'rank'; target?: IRFieldRef; aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max'; mode?: 'row_value' | 'group_aggregate' | 'frequency'; direction: 'asc' | 'desc'; limit?: number; dependsOn: string[] }
    | { id: string; kind: 'sort'; field?: IRFieldRef; direction: 'asc' | 'desc'; dependsOn: string[] }
    | { id: string; kind: 'limit'; count: number; dependsOn: string[] }
    | { id: string; kind: 'distinct'; fields: IRFieldRef[]; dependsOn: string[] }
    | { id: string; kind: 'project'; fields: IRFieldRef[]; dependsOn: string[] };

export interface AnalyticalIR {
    version: 1;
    question: string;
    answer: {
        kind: CanonicalQueryIntent['answerKind'];
        cardinality: QueryContract['expectedCardinality'];
        entity?: IRFieldRef;
        grain: IRFieldRef[];
        fields: IRFieldRef[];
        distinct: boolean;
    };
    populations: IRPopulation[];
    operators: AnalyticalOperator[];
    relationships: {
        tables: string[];
        mode: QueryContract['relationshipMode'];
        path: QueryContract['relationshipPath'];
        fanoutRisk: boolean;
    };
    time: {
        anchorDate?: string;
        primaryDateField?: string;
        expressions: Array<{
            id: string;
            kind: 'absolute_range' | 'current_period' | 'previous_period' | 'same_period_last_year' | 'rolling_window';
            field: string;
            grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
            start?: string;
            end?: string;
            offset?: number;
        }>;
    };
    constraints: CanonicalQueryIntent['constraints'];
    evidence: IREvidence[];
    confidence: {
        overall: number;
        unresolved: string[];
    };
}

export interface IRVerificationIssue {
    code: string;
    severity: 'error' | 'warn';
    message: string;
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
    return values.filter((value, index, all) =>
        all.findIndex(other => key(other).toLowerCase() === key(value).toLowerCase()) === index
    );
}

function fieldByName(model: SemanticModel, field: string): SemanticField | undefined {
    return model.fields.find(candidate => candidate.name.toLowerCase() === field.toLowerCase());
}

function fieldRef(
    model: SemanticModel,
    field: string,
    role: IRFieldRef['role'],
    visibility: IRFieldRef['visibility'],
    confidence: IRConfidence = 'high',
    table?: string,
): IRFieldRef {
    const semantic = fieldByName(model, field);
    return {
        field,
        table: table || semantic?.ownerTable,
        role,
        visibility,
        confidence,
        unit: semantic?.unit,
        additivity: semantic?.additivity,
        nativeGrain: semantic?.nativeGrain,
    };
}

function predicateFromContract(predicate: NonNullable<QueryContract['requiredPredicates']>[number]): IRPredicate {
    return {
        field: predicate.field,
        table: predicate.table,
        operator: predicate.operator,
        value: predicate.value,
        scope: predicate.scope,
        confidence: predicate.confidence,
    };
}

function aggregateIsExplicitlyVisible(
    question: string,
    cardinality: QueryContract['expectedCardinality'],
    contract: QueryContract,
): boolean {
    if (cardinality === 'scalar') return true;
    // Aggregate predicates qualify entities but do not automatically become
    // display columns. Ordinary grouped/ranked measures are visible unless the
    // question is purely a qualification such as “which X have AVG(Y) >= 70?”.
    if (!contract.threshold && !contract.relativeComparison) return true;
    return /\b(?:and\s+(?:the\s+)?(?:number|count|average|avg|total|sum|maximum|max|minimum|min|percentage|percent|amount|value)|how\s+many)\b/i.test(question)
        || /\b(?:what\s+(?:is|are)|show|give|display|return|calculate)\b[\s\S]{0,50}\b(?:number|count|average|avg|total|sum|maximum|max|minimum|min|percentage|percent|amount|value)\b/i.test(question);
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return value;
}

/** Build and freeze the single analytical meaning consumed by downstream engines. */
export function buildAnalyticalIR(
    question: string,
    plan: AnalysisPlan,
    model: SemanticModel,
    contract: QueryContract,
    canonical: CanonicalQueryIntent,
): AnalyticalIR {
    const evidence: IREvidence[] = [];
    const outputFields = unique(canonical.visibleFields.map(field => {
        const semantic = fieldByName(model, field);
        const isIdentifier = semantic?.keyRole && semantic.keyRole !== 'none';
        return fieldRef(model, field, isIdentifier ? 'identifier' : 'entity', 'visible');
    }), item => `${item.table || ''}.${item.field}`);
    const grain = unique(canonical.grainFields.map(field => fieldRef(model, field, 'dimension', 'helper')), item => `${item.table || ''}.${item.field}`);
    const entity = contract.outputEntity
        ? fieldRef(model, contract.outputEntity.field, 'entity', 'visible', contract.outputEntity.confidence, contract.outputEntity.table)
        : outputFields[0];

    for (const field of outputFields) {
        evidence.push({ source: 'question', fact: `output:${field.table || 'data'}.${field.field}`, confidence: field.confidence, reason: 'Resolved from the requested answer phrase.' });
    }
    for (const field of grain) {
        evidence.push({ source: 'contract', fact: `grain:${field.table || 'data'}.${field.field}`, confidence: field.confidence, reason: 'Established by grouping/result-grain evidence.' });
    }

    const predicates = (contract.requiredPredicates || []).map(predicateFromContract);
    const wherePredicates = predicates.filter(predicate => predicate.scope === 'where');
    const havingPredicates = predicates.filter(predicate => predicate.scope === 'having');
    const tables = canonical.relationship.tables.length ? canonical.relationship.tables : ['data'];
    const timeExpressions: AnalyticalIR['time']['expressions'] = [];
    for (const predicate of predicates) {
        const semantic = fieldByName(model, predicate.field);
        if ((semantic?.semanticType === 'date' || model.timeContext?.primaryDateColumn.toLowerCase() === predicate.field.toLowerCase())
            && predicate.operator === 'between'
            && Array.isArray(predicate.value)
            && predicate.value.length >= 2) {
            timeExpressions.push({
                id: `time_range_${timeExpressions.length}`,
                kind: 'absolute_range',
                field: predicate.field,
                start: String(predicate.value[0]),
                end: String(predicate.value[1]),
            });
        }
    }
    if (plan.comparison) {
        const field = model.timeContext?.primaryDateColumn || plan.dimensions.find(dimension => dimension.timeGrain)?.field;
        if (field) {
            timeExpressions.push({
                id: 'time_current_period',
                kind: 'current_period',
                field,
                grain: plan.comparison.grain,
            });
            timeExpressions.push({
                id: 'time_comparison_period',
                kind: plan.comparison.type === 'same_period_last_year' ? 'same_period_last_year' : 'previous_period',
                field,
                grain: plan.comparison.grain,
                offset: plan.comparison.offset || 1,
            });
        }
    }
    const basePopulation: IRPopulation = {
        id: 'population_base',
        role: 'base',
        entity,
        tables,
        filters: [],
        description: `All eligible rows from ${tables.join(', ')}`,
    };
    const populations: IRPopulation[] = [basePopulation];
    let activePopulationId = basePopulation.id;
    if (wherePredicates.length) {
        populations.push({
            id: 'population_filtered',
            role: 'filtered',
            entity,
            tables,
            filters: wherePredicates,
            description: 'Rows satisfying the question-level filters.',
        });
        activePopulationId = 'population_filtered';
    }

    if (contract.ratio) {
        populations.push({
            id: 'population_denominator',
            role: 'denominator',
            entity,
            tables,
            filters: wherePredicates,
            description: 'The complete eligible population used as the ratio denominator.',
        });
        populations.push({
            id: 'population_numerator',
            role: 'numerator',
            entity,
            tables,
            filters: predicates,
            description: 'The denominator population plus the measured condition.',
        });
    }

    if (contract.relativeComparison) {
        const referenceFilters = contract.relativeComparison.inheritedFilters.map(filter => ({
            field: filter.field,
            operator: filter.op,
            value: filter.value,
            scope: 'where' as const,
            confidence: 'high' as const,
        }));
        populations.push({
            id: 'population_reference',
            role: 'reference',
            entity,
            tables,
            filters: contract.relativeComparison.referencePopulation === 'global' ? [] : referenceFilters,
            description: `Reference population: ${contract.relativeComparison.referencePopulation}.`,
        });
    }

    const operators: AnalyticalOperator[] = [];
    let prior: string[] = [];
    const append = (operator: AnalyticalOperator) => {
        operators.push(operator);
        prior = [operator.id];
    };

    if (canonical.relationship.path.length) {
        append({ id: 'op_join', kind: 'join', path: canonical.relationship.path, mode: canonical.relationship.mode, dependsOn: prior });
    }
    if (wherePredicates.length) append({ id: 'op_filter', kind: 'filter', populationId: activePopulationId, predicates: wherePredicates, dependsOn: prior });
    if (canonical.relationship.setOperation === 'intersection') append({ id: 'op_set', kind: 'set', operation: 'intersection', entity, dependsOn: prior });
    if (canonical.relationship.existence === 'anti') append({ id: 'op_set', kind: 'set', operation: 'difference', entity, dependsOn: prior });
    if (canonical.grainFields.length) append({ id: 'op_group', kind: 'group', grain, dependsOn: prior });

    const showAggregates = aggregateIsExplicitlyVisible(question, canonical.cardinality, contract);
    const aggregateMeasures = canonical.measures.map((measure, index) => {
        const sourceField = measure.field || plan.metrics[index]?.field || plan.metrics[0]?.field || '*';
        const alias = sourceField === '*'
            ? `${measure.aggregation}_rows`
            : `${measure.aggregation}_${sourceField.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
        return {
            ...fieldRef(model, sourceField, 'measure', showAggregates ? 'visible' : 'helper', measure.confidence),
            aggregation: measure.aggregation,
            alias,
        };
    });
    if (aggregateMeasures.length) append({ id: 'op_aggregate', kind: 'aggregate', measures: aggregateMeasures, dependsOn: prior });
    const computedMeasures = canonical.computedMeasures.map(metric => ({
        id: metric.id,
        label: metric.label,
        alias: metric.id,
        formula: metric.formula,
        dependsOnFields: [...metric.dependsOn],
        visibility: 'visible' as const,
        unit: metric.semanticType === 'percentage' ? 'percentage' as const : undefined,
    }));
    if (computedMeasures.length) append({ id: 'op_derive', kind: 'derive', calculations: computedMeasures, dependsOn: prior });
    if (havingPredicates.length) append({ id: 'op_having', kind: 'filter', populationId: activePopulationId, predicates: havingPredicates, dependsOn: prior });

    if (contract.relativeComparison) {
        append({
            id: 'op_relative_compare',
            kind: 'relative_compare',
            scope: contract.relativeComparison.scope,
            referencePopulationId: 'population_reference',
            comparator: contract.relativeComparison.comparator,
            multiplier: contract.relativeComparison.multiplier,
            measure: contract.relativeComparison.measureField
                ? fieldRef(model, contract.relativeComparison.measureField, 'measure', 'helper')
                : undefined,
            dependsOn: prior,
        });
    }
    if (contract.ratio) append({ id: 'op_ratio', kind: 'ratio', basis: contract.ratio.basis, numeratorPopulationId: 'population_numerator', denominatorPopulationId: 'population_denominator', scale: contract.ratio.kind === 'percentage' ? 100 : 1, dependsOn: prior });
    if (plan.comparison) append({ id: 'op_compare_periods', kind: 'compare_periods', mode: plan.comparison.mode, grain: plan.comparison.grain, dependsOn: prior });
    for (const [index, operation] of canonical.analyticOperations.entries()) append({ id: `op_window_${index}`, kind: 'window', operation, dependsOn: prior });
    if (canonical.order && canonical.answerKind === 'ranked_result') {
        append({
            id: 'op_rank',
            kind: 'rank',
            target: canonical.order.field ? fieldRef(model, canonical.order.field, canonical.order.mode === 'row_value' ? 'dimension' : 'measure', 'helper') : undefined,
            aggregation: canonical.order.aggregation,
            mode: canonical.order.mode,
            direction: canonical.order.direction,
            limit: canonical.order.limit,
            dependsOn: prior,
        });
    } else if (canonical.order) {
        append({ id: 'op_sort', kind: 'sort', field: canonical.order.field ? fieldRef(model, canonical.order.field, 'dimension', 'helper') : undefined, direction: canonical.order.direction, dependsOn: prior });
    }
    if (canonical.order?.limit !== undefined) append({ id: 'op_limit', kind: 'limit', count: canonical.order.limit, dependsOn: prior });
    if (canonical.constraints.distinctProjection) append({ id: 'op_distinct', kind: 'distinct', fields: outputFields, dependsOn: prior });

    const finalFields = unique([
        ...outputFields,
        ...(['grouped_aggregate', 'ranked_result'].includes(canonical.answerKind)
            ? grain.map(field => ({ ...field, visibility: 'visible' as const }))
            : []),
        ...aggregateMeasures.filter(measure => measure.visibility === 'visible').map(measure => ({ ...measure, field: measure.alias, role: 'calculation' as const })),
        ...computedMeasures.filter(measure => measure.visibility === 'visible').map(measure => fieldRef(model, measure.alias, 'calculation', 'visible')),
        ...canonical.analyticOperations.map(operation => fieldRef(model, operation.outputAlias, 'calculation', 'visible')),
    ], item => `${item.table || ''}.${item.field}`);
    append({ id: 'op_project', kind: 'project', fields: finalFields, dependsOn: prior });

    const unresolved: string[] = [];
    if (!finalFields.length && canonical.cardinality !== 'scalar') unresolved.push('No requested output field could be grounded.');
    if (canonical.measures.some(measure => !measure.field && measure.aggregation !== 'count')) unresolved.push('An aggregate measure is not grounded to a physical field.');
    if (plan.ambiguous && plan.clarificationQuestion) unresolved.push(plan.clarificationQuestion);

    const confidencePenalty = unresolved.length * 0.2
        + canonical.relationship.path.filter(step => step.fansOut).length * 0.05
        + canonical.measures.filter(measure => measure.confidence === 'medium').length * 0.05;
    const ir: AnalyticalIR = {
        version: 1,
        question,
        answer: {
            kind: canonical.answerKind,
            cardinality: canonical.cardinality,
            entity,
            grain,
            fields: finalFields,
            distinct: canonical.constraints.distinctProjection,
        },
        populations,
        operators,
        relationships: {
            tables,
            mode: canonical.relationship.mode,
            path: canonical.relationship.path.map(step => ({ ...step })),
            fanoutRisk: canonical.relationship.path.some(step => step.fansOut),
        },
        time: {
            anchorDate: model.timeContext?.anchorDate,
            primaryDateField: model.timeContext?.primaryDateColumn,
            expressions: timeExpressions,
        },
        constraints: { ...canonical.constraints },
        evidence,
        confidence: {
            overall: Math.max(0, Math.min(1, 1 - confidencePenalty)),
            unresolved,
        },
    };
    return deepFreeze(ir);
}

/** Structural proof obligations derived from the frozen IR. */
export function verifyAnalyticalIR(ir: AnalyticalIR): IRVerificationIssue[] {
    const issues: IRVerificationIssue[] = [];
    const aggregates = ir.operators.filter((operator): operator is Extract<AnalyticalOperator, { kind: 'aggregate' }> => operator.kind === 'aggregate');
    const groups = ir.operators.filter((operator): operator is Extract<AnalyticalOperator, { kind: 'group' }> => operator.kind === 'group');
    const ratio = ir.operators.find((operator): operator is Extract<AnalyticalOperator, { kind: 'ratio' }> => operator.kind === 'ratio');
    const ranking = ir.operators.find((operator): operator is Extract<AnalyticalOperator, { kind: 'rank' }> => operator.kind === 'rank');

    if (ir.answer.kind === 'detail_projection' && aggregates.length) {
        issues.push({ code: 'projection_contains_aggregate', severity: 'error', message: 'A row/entity projection cannot be replaced by an aggregate answer.' });
    }
    if (ir.answer.cardinality === 'scalar' && groups.length && !ir.operators.some(operator => operator.kind === 'compare_periods')) {
        issues.push({ code: 'scalar_has_group_grain', severity: 'error', message: 'A scalar answer cannot be split into unrelated grouped rows.' });
    }
    if (['grouped_aggregate', 'ranked_result'].includes(ir.answer.kind) && !ir.answer.grain.length) {
        issues.push({ code: 'missing_group_grain', severity: 'error', message: 'The requested grouped/ranked answer has no grounded result grain.' });
    }
    if (ir.constraints.prohibitImplicitLimit && ir.operators.some(operator => operator.kind === 'limit')) {
        issues.push({ code: 'implicit_limit', severity: 'error', message: 'An unbounded listing must not be silently reduced by LIMIT.' });
    }
    if (ranking && ranking.mode !== 'row_value' && !aggregates.length) {
        issues.push({ code: 'ranking_without_measure', severity: 'error', message: 'Grouped/frequency ranking requires an aggregate ranking expression.' });
    }
    if (ranking?.limit !== undefined && ranking.limit < 1) {
        issues.push({ code: 'invalid_limit', severity: 'error', message: 'Ranking limit must be a positive integer.' });
    }
    if (ratio) {
        const numerator = ir.populations.find(population => population.id === ratio.numeratorPopulationId);
        const denominator = ir.populations.find(population => population.id === ratio.denominatorPopulationId);
        if (!numerator || !denominator) {
            issues.push({ code: 'missing_ratio_population', severity: 'error', message: 'Ratio numerator and denominator populations must both be explicit.' });
        } else {
            const denominatorKeys = new Set(denominator.filters.map(filter => `${filter.table || ''}.${filter.field}:${filter.operator}:${String(filter.value)}`));
            const lost = denominator.filters.filter(filter => !numerator.filters.some(candidate =>
                `${candidate.table || ''}.${candidate.field}:${candidate.operator}:${String(candidate.value)}` === `${filter.table || ''}.${filter.field}:${filter.operator}:${String(filter.value)}`
            ));
            if (lost.length || denominatorKeys.size > numerator.filters.length) {
                issues.push({ code: 'denominator_not_preserved', severity: 'error', message: 'The numerator must preserve every filter that defines the denominator population.' });
            }
        }
    }
    if (ir.operators.some(operator => operator.kind === 'compare_periods')
        && ir.time.expressions.filter(expression => ['current_period', 'previous_period', 'same_period_last_year'].includes(expression.kind)).length < 2) {
        issues.push({ code: 'incomplete_period_algebra', severity: 'error', message: 'A period comparison requires explicit current and comparison-period expressions.' });
    }
    if (ir.relationships.fanoutRisk && aggregates.some(operator => operator.measures.some(measure => measure.additivity === 'additive'))) {
        issues.push({ code: 'join_fanout_risk', severity: 'warn', message: 'An additive measure crosses a fan-out join; pre-aggregate at its native grain before joining.' });
    }
    for (const aggregate of aggregates) {
        for (const measure of aggregate.measures) {
            if (measure.aggregation === 'sum' && measure.additivity === 'non_additive') {
                issues.push({ code: 'non_additive_sum', severity: 'error', message: `SUM(${measure.field}) is not analytically valid because the field is non-additive.` });
            }
        }
    }
    if (ir.confidence.unresolved.length) {
        issues.push({ code: 'unresolved_interpretation', severity: 'warn', message: ir.confidence.unresolved.join(' ') });
    }
    return issues;
}

/** Metadata-only prompt representation. It contains no dataset row values. */
export function formatAnalyticalIRForPrompt(ir: AnalyticalIR): string {
    return JSON.stringify({
        version: ir.version,
        answer: ir.answer,
        populations: ir.populations,
        operators: ir.operators,
        relationships: ir.relationships,
        time: ir.time,
        constraints: ir.constraints,
        confidence: ir.confidence,
    }, null, 2);
}
