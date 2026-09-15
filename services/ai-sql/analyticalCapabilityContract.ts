/**
 * Analytical Capability Contract
 *
 * A deterministic, dataset-specific type system for analytics. It records what
 * each field may safely do and validates a proposed analysis before SQL runs.
 * The contract contains metadata and structural evidence only—never row values.
 */
import type { AnalysisPlan, SemanticField, SemanticModel } from './types';
import type { AnalyticalIR } from './analyticalIR';

export type CapabilityAggregation = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'median' | 'none';
export type CapabilityStatus = 'safe' | 'review' | 'blocked';
export type CapabilityCheckStatus = 'pass' | 'warn' | 'fail';

export interface CapabilityFieldRule {
    field: string;
    table?: string;
    role: SemanticField['role'];
    semanticType: SemanticField['semanticType'];
    keyRole: NonNullable<SemanticField['keyRole']>;
    additivity: NonNullable<SemanticField['additivity']>;
    unit: NonNullable<SemanticField['unit']>;
    nativeGrain?: string;
    allowedAggregations: CapabilityAggregation[];
    allowedTimeGrains: SemanticField['timeGrainSupport'];
    confidence: number;
    evidence: string[];
}

export interface CapabilityRelationshipRule {
    leftTable: string;
    leftField: string;
    rightTable: string;
    rightField: string;
    cardinality: NonNullable<NonNullable<SemanticModel['joinGraph']>['edges'][number]['cardinality']>;
    confidence: number;
    risk: CapabilityStatus;
    evidence: string;
}

export interface AnalyticalCapabilityContract {
    version: 1;
    contractId: string;
    datasetName: string;
    datasetRevision?: string;
    grain: {
        label: string;
        confidence: 'high' | 'medium' | 'low';
        evidence: string[];
    };
    fields: CapabilityFieldRule[];
    relationships: CapabilityRelationshipRule[];
    privacy: {
        containsRowValues: false;
        description: string;
    };
}

export interface CapabilityCheck {
    id: string;
    category: 'field' | 'aggregation' | 'grain' | 'relationship' | 'time';
    status: CapabilityCheckStatus;
    title: string;
    detail: string;
    evidence?: string[];
}

export interface CapabilityValidation {
    status: CapabilityStatus;
    summary: string;
    checks: CapabilityCheck[];
}

function stableHash(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizedKey(value: string): string {
    return value.trim().replace(/["`]/g, '').toLowerCase();
}

function confidenceForField(field: SemanticField): number {
    const signals = field.classificationSignals;
    if (signals) {
        const values = [signals.detConf, signals.aiConf].filter((value): value is number => typeof value === 'number');
        if (values.length) return Math.max(0, Math.min(1, values.reduce((sum, value) => sum + value, 0) / values.length));
    }
    if (field.keyRole && field.keyRole !== 'none') return 0.9;
    if (field.semanticType !== 'unknown' && field.additivity) return 0.82;
    if (field.semanticType !== 'unknown') return 0.72;
    return 0.5;
}

function fieldAdditivity(field: SemanticField): NonNullable<SemanticField['additivity']> {
    if (field.additivity) return field.additivity;
    if (field.role !== 'metric') return field.physicalType === 'number' ? 'non_additive' : 'not_applicable';
    if (field.semanticType === 'percentage' || field.semanticType === 'ratio') return 'non_additive';
    if (field.semanticType === 'currency' || field.semanticType === 'count' || field.semanticType === 'quantity') return 'additive';
    return 'non_additive';
}

function fieldUnit(field: SemanticField): NonNullable<SemanticField['unit']> {
    if (field.unit) return field.unit;
    if (field.semanticType === 'currency') return 'currency';
    if (field.semanticType === 'percentage') return 'percentage';
    if (field.semanticType === 'ratio') return 'ratio';
    if (field.semanticType === 'date') return 'date';
    if (field.semanticType === 'identifier') return 'identifier';
    if (field.semanticType === 'quantity' || field.semanticType === 'count') return 'quantity';
    if (field.physicalType === 'boolean') return 'boolean';
    if (field.physicalType === 'string') return 'text';
    return 'unknown';
}

export function allowedAggregationsForField(field: SemanticField): CapabilityAggregation[] {
    const keyRole = field.keyRole || (field.semanticType === 'identifier' ? 'identifier' : 'none');
    if (keyRole !== 'none' || field.semanticType === 'identifier') return ['count', 'count_distinct', 'none'];
    if (field.semanticType === 'date' || field.physicalType !== 'number') {
        return ['count', 'count_distinct', 'none'];
    }
    const additivity = fieldAdditivity(field);
    if (additivity === 'non_additive') return ['avg', 'min', 'max', 'median', 'count', 'count_distinct', 'none'];
    if (additivity === 'semi_additive') return ['sum', 'avg', 'min', 'max', 'median', 'count', 'count_distinct', 'none'];
    return ['sum', 'avg', 'min', 'max', 'median', 'count', 'count_distinct', 'none'];
}

export function buildAnalyticalCapabilityContract(model: SemanticModel): AnalyticalCapabilityContract {
    const fields = model.fields.map<CapabilityFieldRule>(field => {
        const keyRole = field.keyRole || (field.semanticType === 'identifier' ? 'identifier' : 'none');
        const additivity = fieldAdditivity(field);
        const evidence = [
            `${field.role} · ${field.semanticType}`,
            `default aggregation: ${field.defaultAgg}`,
        ];
        if (keyRole !== 'none') evidence.push(`key role: ${keyRole}`);
        if (field.nativeGrain) evidence.push(`native grain: ${field.nativeGrain}`);
        if (field.classificationSignals?.reason) evidence.push(field.classificationSignals.reason);
        return {
            field: field.name,
            table: field.ownerTable,
            role: field.role,
            semanticType: field.semanticType,
            keyRole,
            additivity,
            unit: fieldUnit(field),
            nativeGrain: field.nativeGrain,
            allowedAggregations: allowedAggregationsForField(field),
            allowedTimeGrains: field.timeGrainSupport || [],
            confidence: confidenceForField(field),
            evidence,
        };
    });

    const relationships = (model.joinGraph?.edges || []).map<CapabilityRelationshipRule>(edge => {
        const cardinality = edge.cardinality || 'unknown';
        const confidence = typeof edge.confidence === 'number' ? edge.confidence : edge.type === 'fk' ? 0.85 : 0.65;
        const risk: CapabilityStatus = cardinality === 'many_to_many'
            ? 'blocked'
            : cardinality === 'unknown' || confidence < 0.8
                ? 'review'
                : 'safe';
        return {
            leftTable: edge.left,
            leftField: edge.leftCol,
            rightTable: edge.right,
            rightField: edge.rightCol,
            cardinality,
            confidence,
            risk,
            evidence: `${edge.type === 'fk' ? 'Key/value relationship' : 'Name/value candidate'}; ${cardinality}; ${Math.round(confidence * 100)}% confidence.`,
        };
    });

    const grainLabel = model.grain?.trim() || 'Unknown row grain';
    const nativeGrains = [...new Set(fields.map(field => field.nativeGrain).filter((value): value is string => Boolean(value)))];
    const grainConfidence: AnalyticalCapabilityContract['grain']['confidence'] = model.grain?.trim()
        ? nativeGrains.length > 0 || fields.some(field => field.keyRole === 'primary_key') ? 'high' : 'medium'
        : 'low';
    const fingerprint = JSON.stringify({
        name: model.datasetName,
        revision: model.revision || '',
        grain: grainLabel,
        fields: fields.map(field => [field.table || '', field.field, field.role, field.semanticType, field.keyRole, field.additivity, field.allowedAggregations]),
        relationships: relationships.map(edge => [edge.leftTable, edge.leftField, edge.rightTable, edge.rightField, edge.cardinality, edge.risk]),
    });

    return {
        version: 1,
        contractId: `acc-v1-${stableHash(fingerprint)}`,
        datasetName: model.datasetName,
        datasetRevision: model.revision,
        grain: {
            label: grainLabel,
            confidence: grainConfidence,
            evidence: nativeGrains.length
                ? [`Native field grains: ${nativeGrains.join(', ')}`]
                : [model.grain?.trim() ? `Dataset grain declared as ${model.grain}.` : 'No dependable row-grain declaration was available.'],
        },
        fields,
        relationships,
        privacy: {
            containsRowValues: false,
            description: 'Generated only from schema, semantic classifications, cardinality and relationship metadata.',
        },
    };
}

function resolveRule(contract: AnalyticalCapabilityContract, fieldName: string): CapabilityFieldRule | undefined {
    const normalized = normalizedKey(fieldName);
    const exact = contract.fields.filter(rule => normalizedKey(rule.field) === normalized);
    if (exact.length === 1) return exact[0];
    const qualifiedParts = normalized.split('.');
    const leaf = qualifiedParts[qualifiedParts.length - 1];
    return contract.fields.find(rule => normalizedKey(rule.field) === leaf);
}

function finalValidation(checks: CapabilityCheck[]): CapabilityValidation {
    const failures = checks.filter(check => check.status === 'fail');
    const warnings = checks.filter(check => check.status === 'warn');
    const status: CapabilityStatus = failures.length ? 'blocked' : warnings.length ? 'review' : 'safe';
    return {
        status,
        summary: failures.length
            ? `Analysis withheld: ${failures.length} capability rule${failures.length === 1 ? '' : 's'} failed.`
            : warnings.length
                ? `Analysis is conditionally supported with ${warnings.length} item${warnings.length === 1 ? '' : 's'} to review.`
                : 'The requested analysis is supported by this dataset contract.',
        checks,
    };
}

/** Validate analytical meaning before SQL generation or execution. */
export function validatePlanAgainstCapabilityContract(
    plan: AnalysisPlan,
    contract: AnalyticalCapabilityContract,
    analyticalIR?: AnalyticalIR,
): CapabilityValidation {
    const checks: CapabilityCheck[] = [];
    const requestedFields = [
        ...plan.dimensions.map(item => item.field),
        ...plan.metrics.filter(item => item.field !== '*' && !item.compositeId && !item.derivedMetricId).map(item => item.field),
        ...(plan.projectionFields || []),
        ...plan.filters.map(item => item.field),
    ];

    for (const fieldName of [...new Set(requestedFields)]) {
        const rule = resolveRule(contract, fieldName);
        checks.push(rule ? {
            id: `field:${fieldName}`,
            category: 'field',
            status: rule.confidence >= 0.7 ? 'pass' : 'warn',
            title: `${fieldName} is recognised`,
            detail: `${rule.role} · ${rule.semanticType} · ${Math.round(rule.confidence * 100)}% semantic confidence.`,
            evidence: rule.evidence,
        } : {
            id: `field:${fieldName}`,
            category: 'field',
            status: 'fail',
            title: `${fieldName} is not governed`,
            detail: 'The field is absent from the dataset capability contract.',
        });
    }

    for (const metric of plan.metrics) {
        if (metric.field === '*' || metric.compositeId || metric.derivedMetricId) continue;
        const rule = resolveRule(contract, metric.field);
        if (!rule) continue;
        const allowed = rule.allowedAggregations.includes(metric.agg);
        checks.push({
            id: `aggregation:${metric.field}:${metric.agg}`,
            category: 'aggregation',
            status: allowed ? 'pass' : 'fail',
            title: `${metric.agg.toUpperCase()}(${metric.field})`,
            detail: allowed
                ? `${metric.agg.toUpperCase()} is valid for a ${rule.additivity.replace('_', '-')} ${rule.semanticType} field.`
                : `${metric.agg.toUpperCase()} is not allowed for this ${rule.keyRole !== 'none' ? 'identifier' : rule.additivity.replace('_', '-')} field. Allowed: ${rule.allowedAggregations.join(', ')}.`,
            evidence: rule.evidence,
        });

        const hasTimeGrouping = plan.dimensions.some(dimension => {
            const dimensionRule = resolveRule(contract, dimension.field);
            return Boolean(dimension.timeGrain || dimensionRule?.semanticType === 'date');
        });
        if (metric.agg === 'sum' && rule.additivity === 'semi_additive' && hasTimeGrouping) {
            checks.push({
                id: `time-additivity:${metric.field}`,
                category: 'time',
                status: 'fail',
                title: `${metric.field} cannot be summed across time`,
                detail: 'This measure is semi-additive; summing snapshots across periods would overstate the result.',
                evidence: rule.evidence,
            });
        }
    }

    for (const dimension of plan.dimensions) {
        if (!dimension.timeGrain) continue;
        const rule = resolveRule(contract, dimension.field);
        const supported = Boolean(rule?.allowedTimeGrains.includes(dimension.timeGrain));
        checks.push({
            id: `time:${dimension.field}:${dimension.timeGrain}`,
            category: 'time',
            status: supported ? 'pass' : 'fail',
            title: `${dimension.timeGrain} grouping on ${dimension.field}`,
            detail: supported
                ? 'The requested time grain is supported.'
                : `The field does not support ${dimension.timeGrain} grouping.`,
        });
    }

    checks.push({
        id: 'grain:dataset',
        category: 'grain',
        status: contract.grain.confidence === 'low' ? 'warn' : 'pass',
        title: `Result grain: ${plan.resultGrain || contract.grain.label}`,
        detail: `Dataset row grain is ${contract.grain.label} (${contract.grain.confidence} confidence).`,
        evidence: contract.grain.evidence,
    });

    if (analyticalIR && analyticalIR.relationships.tables.length > 1) {
        if (analyticalIR.relationships.fanoutRisk) {
            checks.push({
                id: 'relationship:fanout',
                category: 'relationship',
                status: 'fail',
                title: 'Unsafe multi-table fan-out',
                detail: 'The relationship path can multiply base rows and inflate aggregate measures.',
            });
        } else {
            const pathRules = analyticalIR.relationships.path.map(step => contract.relationships.find(rule =>
                (normalizedKey(rule.leftTable) === normalizedKey(step.fromTable) && normalizedKey(rule.rightTable) === normalizedKey(step.toTable))
                || (normalizedKey(rule.rightTable) === normalizedKey(step.fromTable) && normalizedKey(rule.leftTable) === normalizedKey(step.toTable))
            )).filter((rule): rule is CapabilityRelationshipRule => Boolean(rule));
            const blocked = pathRules.some(rule => rule.risk === 'blocked');
            const review = pathRules.length !== analyticalIR.relationships.path.length || pathRules.some(rule => rule.risk === 'review');
            checks.push({
                id: 'relationship:path',
                category: 'relationship',
                status: blocked ? 'fail' : review ? 'warn' : 'pass',
                title: 'Multi-table relationship path',
                detail: blocked
                    ? 'The selected path contains a many-to-many relationship.'
                    : review
                        ? 'The path is usable, but one or more relationship links have incomplete or lower-confidence evidence.'
                        : 'Every relationship link has safe cardinality and strong evidence.',
                evidence: pathRules.map(rule => rule.evidence),
            });
        }
    }

    return finalValidation(checks);
}
