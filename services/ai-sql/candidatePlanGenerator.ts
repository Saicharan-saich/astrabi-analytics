/**
 * candidatePlanGenerator.ts — Multi-Plan Generation
 *
 * For ambiguous questions, generates multiple interpretation plans.
 * Each plan represents a valid, executable analysis with different
 * metric/dimension/filter choices.
 *
 * Example: "Which customers are performing best?"
 * → Plan 1: Customers ranked by total sales
 * → Plan 2: Customers ranked by total profit
 * → Plan 3: Customers ranked by order count
 */

import { SemanticModel, SemanticField, AnalysisPlan } from './types';
import { ResolvedAmbiguity } from './ambiguityResolver';
import { DatasetStatistics } from './localStatisticsResolver';
import { getMetricDictionary } from './metricDictionary';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface CandidatePlan {
    id: string;
    interpretation: string;
    /** Confidence in this interpretation (0-1) */
    score: number;
    /** The assumptions this plan makes */
    assumptions: PlanAssumption[];
    /** A partial AnalysisPlan that can be completed by the planner */
    partialPlan: Partial<AnalysisPlan>;
    /** Which ambiguities this plan resolves */
    resolvedAmbiguityIds: string[];
}

export interface PlanAssumption {
    ambiguityId: string;
    type: string;
    phrase: string;
    resolved: string;
    confidence: number;
}

// ═══════════════════════════════════════════════════════════════════
// PLAN GENERATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate multiple candidate plans for ambiguous questions.
 * Returns 1-5 plans sorted by confidence.
 */
export function generateCandidatePlans(
    question: string,
    semanticModel: SemanticModel,
    resolvedAmbiguities: ResolvedAmbiguity[],
    stats: DatasetStatistics
): CandidatePlan[] {
    const candidates: CandidatePlan[] = [];
    const dictionary = getMetricDictionary();
    const lower = question.toLowerCase();
    let planIndex = 0;

    // Find the primary dimension for entity-based questions
    const entityDim = findEntityDimension(lower, semanticModel);

    // ─── Metric Ambiguity → Generate one plan per candidate metric ─
    const metricAmbiguities = resolvedAmbiguities.filter(a =>
        a.type === 'metric' || a.type === 'analytical_meaning'
    );

    if (metricAmbiguities.length > 0) {
        for (const amb of metricAmbiguities) {
            for (const candidate of amb.candidates.slice(0, 4)) {
                const field = candidate.field
                    ? semanticModel.fields.find(f => f.name === candidate.field)
                    : semanticModel.fields.find(f => f.role === 'metric');

                if (!field) continue;

                const dictEntry = dictionary.matchColumn(field.name);
                const agg = dictEntry?.aggregation.default || field.defaultAgg || 'sum';

                candidates.push({
                    id: `plan_${++planIndex}`,
                    interpretation: entityDim
                        ? `${entityDim.displayLabel || entityDim.name} ranked by ${agg} of ${field.displayLabel || field.name}`
                        : `${agg} of ${field.displayLabel || field.name}`,
                    score: candidate.confidence,
                    assumptions: [{
                        ambiguityId: amb.id,
                        type: amb.type,
                        phrase: amb.phrase,
                        resolved: candidate.label,
                        confidence: candidate.confidence,
                    }],
                    partialPlan: {
                        metrics: [{ field: field.name, agg: agg as any }],
                        dimensions: entityDim ? [{ field: entityDim.name }] : [],
                        intent: entityDim ? 'ranking' : 'single_metric',
                    },
                    resolvedAmbiguityIds: [amb.id],
                });
            }
        }
    }

    // ─── Threshold Ambiguity → Generate plan per threshold level ──
    const thresholdAmbiguities = resolvedAmbiguities.filter(a => a.type === 'threshold');

    if (thresholdAmbiguities.length > 0 && candidates.length === 0) {
        const metricField = semanticModel.fields.find(f => f.role === 'metric');

        for (const amb of thresholdAmbiguities) {
            for (const candidate of amb.candidates.slice(0, 3)) {
                if (!metricField) continue;

                candidates.push({
                    id: `plan_${++planIndex}`,
                    interpretation: `Filter ${metricField.displayLabel || metricField.name} where value is ${candidate.label}`,
                    score: candidate.confidence,
                    assumptions: [{
                        ambiguityId: amb.id,
                        type: 'threshold',
                        phrase: amb.phrase,
                        resolved: candidate.label,
                        confidence: candidate.confidence,
                    }],
                    partialPlan: {
                        metrics: [{ field: metricField.name, agg: metricField.defaultAgg as any }],
                        dimensions: entityDim ? [{ field: entityDim.name }] : [],
                        intent: 'breakdown',
                    },
                    resolvedAmbiguityIds: [amb.id],
                });
            }
        }
    }

    // ─── If no ambiguity-driven plans, create a default plan ─────
    if (candidates.length === 0) {
        const primaryMetric = semanticModel.fields.find(f => f.role === 'metric');
        if (primaryMetric) {
            candidates.push({
                id: `plan_${++planIndex}`,
                interpretation: `Default analysis: ${primaryMetric.defaultAgg} of ${primaryMetric.displayLabel || primaryMetric.name}`,
                score: 0.80,
                assumptions: [],
                partialPlan: {
                    metrics: [{ field: primaryMetric.name, agg: primaryMetric.defaultAgg as any }],
                    dimensions: entityDim ? [{ field: entityDim.name }] : [],
                    intent: entityDim ? 'breakdown' : 'single_metric',
                },
                resolvedAmbiguityIds: [],
            });
        }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Boost plans where the metric has good data coverage
    for (const plan of candidates) {
        const metricName = plan.partialPlan.metrics?.[0]?.field;
        if (metricName && stats.metrics[metricName]) {
            const metricStat = stats.metrics[metricName];
            // Penalize metrics with high null rate
            if (metricStat.nullRate > 0.5) {
                plan.score *= 0.7;
            }
            // Boost metrics with good coverage
            if (metricStat.nullRate < 0.05) {
                plan.score *= 1.05;
            }
        }
    }

    // Re-sort after boosts
    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function findEntityDimension(question: string, model: SemanticModel): SemanticField | null {
    const dims = model.fields.filter(f => f.role === 'dimension' && f.physicalType === 'string');

    // Try to match dimension from the question
    for (const dim of dims) {
        const dimWords = [
            dim.name.toLowerCase(),
            dim.displayLabel?.toLowerCase(),
            ...dim.synonyms.map(s => s.toLowerCase()),
        ].filter(Boolean) as string[];

        if (dimWords.some(w => question.includes(w))) {
            return dim;
        }
    }

    // Look for entity keywords
    const entityKeywords = ['customer', 'product', 'region', 'category', 'employee', 'department', 'patient', 'city', 'state', 'country', 'segment', 'channel'];
    for (const keyword of entityKeywords) {
        if (question.includes(keyword)) {
            const match = dims.find(d =>
                d.name.toLowerCase().includes(keyword) ||
                d.displayLabel?.toLowerCase().includes(keyword) ||
                d.synonyms.some(s => s.toLowerCase().includes(keyword))
            );
            if (match) return match;
        }
    }

    return null;
}
