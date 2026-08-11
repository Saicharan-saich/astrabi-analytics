/**
 * ambiguityDetector.ts — Typed Ambiguity Classification
 *
 * Detects and classifies what is UNCLEAR in a natural language question.
 * Instead of a generic `ambiguous: true`, produces typed ambiguity objects
 * with candidates, confidence scores, and materiality levels.
 *
 * 12 ambiguity types: metric, threshold, time, aggregation, entity_grain,
 * ranking, comparison, category_value, join_grain, analytical_meaning,
 * evidence_gap, temporal_anchor.
 */

import { SemanticModel, SemanticField } from './types';
import { getPolicyRegistry, SemanticPolicy } from './semanticPolicyRegistry';
import { getMetricDictionary } from './metricDictionary';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type AmbiguityType =
    | 'metric'
    | 'threshold'
    | 'time'
    | 'aggregation'
    | 'entity_grain'
    | 'ranking'
    | 'comparison'
    | 'category_value'
    | 'join_grain'
    | 'analytical_meaning'
    | 'evidence_gap'
    | 'temporal_anchor'
    | 'scope';

export interface AmbiguityCandidate {
    id: string;
    label: string;
    description: string;
    confidence: number;
    field?: string;
    value?: string | number;
}

export interface DetectedAmbiguity {
    id: string;
    type: AmbiguityType;
    phrase: string;
    candidates: AmbiguityCandidate[];
    selected: AmbiguityCandidate | null;
    confidence: number;
    materiality: 'low' | 'medium' | 'high';
    resolvedBy: 'local_statistics' | 'semantic_policy' | 'metric_dictionary' | 'user' | 'unresolved';
}

export interface AmbiguityDetectionResult {
    ambiguities: DetectedAmbiguity[];
    hasHighMateriality: boolean;
    autoResolvableCount: number;
    totalCount: number;
}

// ═══════════════════════════════════════════════════════════════════
// DETECTION PATTERNS
// ═══════════════════════════════════════════════════════════════════

const THRESHOLD_PATTERNS = /\b(high|low|strong|weak|good|bad|poor|above|below|exceeding|under|very high|extremely|exceptional|outstanding|unusual|outlier|anomal|spike|negative|loss|losing)\b/i;
const RANKING_PATTERNS = /\b(top|bottom|best|worst|leading|highest|lowest|most|least|fewest|biggest|smallest)\b/i;
const TIME_VAGUE_PATTERNS = /\b(recent|recently|latest|current|currently|now|right now|last period|previous|prior)\b/i;
const COMPARISON_PATTERNS = /\b(growth|growing|increase|change|trend|compared|versus|vs|over time|momentum)\b/i;
const MEANING_PATTERNS = /\b(performance|performing|results|doing|going|efficiency|effective|productive|success|best|health)\b/i;
const EVIDENCE_PATTERNS = /\b(why|cause|reason|explain|because|impact|effect|correlation|relationship|predict)\b/i;
const COUNT_NO_LIMIT = /\b(top|bottom|best|worst|leading|highest|lowest)\b/i;

let _nextId = 0;
function nextAmbiguityId(): string {
    return `amb_${++_nextId}`;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN DETECTOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect all ambiguities in a question given the semantic model.
 */
export function detectAmbiguities(
    question: string,
    semanticModel: SemanticModel,
    domain?: string
): AmbiguityDetectionResult {
    const ambiguities: DetectedAmbiguity[] = [];
    const lower = question.toLowerCase();
    const registry = getPolicyRegistry(domain);
    const dictionary = getMetricDictionary();

    // ─── 1. Threshold Ambiguity ──────────────────────────────────
    const thresholdMatch = lower.match(THRESHOLD_PATTERNS);
    // "below 2000" is explicit, not ambiguous. Only semantic adjectives and
    // relative thresholds without a supplied literal should enter resolution.
    const hasExplicitThreshold = /\b(?:above|below|over|under|exceeding|greater\s+than|less\s+than|higher\s+than|lower\s+than|at\s+least|at\s+most)\s*(?:[$£€]\s*)?-?\d[\d,]*(?:\.\d+)?\b/i.test(lower);
    if (thresholdMatch && !hasExplicitThreshold) {
        const phrase = thresholdMatch[0];
        const policyMatch = registry.matchPhrase(phrase);

        if (policyMatch) {
            ambiguities.push({
                id: nextAmbiguityId(),
                type: 'threshold',
                phrase,
                candidates: policyMatch.policy.alternatives.map(alt => ({
                    id: alt.id,
                    label: alt.label,
                    description: alt.interpretation,
                    confidence: policyMatch.policy.confidence,
                })),
                selected: {
                    id: policyMatch.policy.alternatives[0]?.id || 'default',
                    label: policyMatch.policy.defaultInterpretation,
                    description: policyMatch.policy.defaultInterpretation,
                    confidence: policyMatch.policy.confidence,
                },
                confidence: policyMatch.policy.confidence,
                materiality: policyMatch.policy.confidence > 0.85 ? 'low' : 'medium',
                resolvedBy: 'semantic_policy',
            });
        }
    }

    // ─── 2. Ranking Ambiguity (Top N without number) ─────────────
    const rankMatch = lower.match(COUNT_NO_LIMIT);
    const hasExplicitNumber = /\b(top|bottom)\s+\d+/i.test(lower);
    if (rankMatch && !hasExplicitNumber) {
        const policy = registry.get('top_entities') || registry.get('bottom_entities');
        if (policy) {
            ambiguities.push({
                id: nextAmbiguityId(),
                type: 'ranking',
                phrase: rankMatch[0],
                candidates: (policy.alternatives || []).map(alt => ({
                    id: alt.id,
                    label: alt.label,
                    description: alt.interpretation,
                    confidence: 0.90,
                    value: alt.fixedValue,
                })),
                selected: {
                    id: 'top_10',
                    label: 'Top 10',
                    description: 'Show top 10 results',
                    confidence: 0.90,
                    value: 10,
                },
                confidence: 0.90,
                materiality: 'low', // Safe default exists
                resolvedBy: 'semantic_policy',
            });
        }
    }

    // ─── 3. Time Ambiguity ───────────────────────────────────────
    const timeMatch = lower.match(TIME_VAGUE_PATTERNS);
    if (timeMatch) {
        const policy = registry.get('recent') || registry.get('last_period');
        if (policy) {
            ambiguities.push({
                id: nextAmbiguityId(),
                type: 'time',
                phrase: timeMatch[0],
                candidates: (policy.alternatives || []).map(alt => ({
                    id: alt.id,
                    label: alt.label,
                    description: alt.interpretation,
                    confidence: policy.confidence,
                })),
                selected: {
                    id: 'last_30',
                    label: policy.defaultInterpretation,
                    description: policy.defaultInterpretation,
                    confidence: policy.confidence,
                },
                confidence: policy.confidence,
                materiality: 'medium',
                resolvedBy: 'semantic_policy',
            });
        }
    }

    // ─── 4. Analytical Meaning Ambiguity ─────────────────────────
    const meaningMatch = lower.match(MEANING_PATTERNS);
    if (meaningMatch) {
        const concept = dictionary.matchConcept(meaningMatch[0]);
        if (concept && concept.metricBundle.length > 1) {
            const metricFields = semanticModel.fields.filter(f => f.role === 'metric');
            const matchingMetrics = concept.metricBundle
                .map(mId => {
                    const dictEntry = dictionary.getMetric(mId);
                    if (!dictEntry) return null;
                    // Check if this metric exists in the dataset
                    const found = metricFields.find(f =>
                        dictEntry.columnPatterns.some(p =>
                            f.name.toLowerCase().includes(p.toLowerCase())
                        )
                    );
                    return found ? { dictEntry, field: found } : null;
                })
                .filter(Boolean) as { dictEntry: any; field: SemanticField }[];

            if (matchingMetrics.length > 1) {
                ambiguities.push({
                    id: nextAmbiguityId(),
                    type: 'analytical_meaning',
                    phrase: meaningMatch[0],
                    candidates: matchingMetrics.map((m, i) => ({
                        id: m.dictEntry.id,
                        label: m.dictEntry.displayName,
                        description: m.dictEntry.description,
                        confidence: 1 - (i * 0.15), // Priority order reduces confidence
                        field: m.field.name,
                    })),
                    selected: matchingMetrics.length > 0 ? {
                        id: matchingMetrics[0].dictEntry.id,
                        label: matchingMetrics[0].dictEntry.displayName,
                        description: `Using ${matchingMetrics[0].dictEntry.displayName} as the primary metric`,
                        confidence: 0.75,
                        field: matchingMetrics[0].field.name,
                    } : null,
                    confidence: 0.65,
                    materiality: matchingMetrics.length > 2 ? 'high' : 'medium',
                    resolvedBy: 'metric_dictionary',
                });
            }
        }
    }

    // ─── 5. Metric Ambiguity (vague metric reference) ────────────
    const metricConcepts = ['best', 'performance', 'results', 'doing'];
    const hasVagueMetric = metricConcepts.some(c => lower.includes(c));
    const hasExplicitMetric = semanticModel.fields
        .filter(f => f.role === 'metric')
        .some(f => lower.includes(f.name.toLowerCase()) || f.synonyms.some(s => lower.includes(s.toLowerCase())));

    if (hasVagueMetric && !hasExplicitMetric) {
        const metricFields = semanticModel.fields.filter(f => f.role === 'metric');
        if (metricFields.length > 1) {
            // Check if already covered by analytical_meaning
            const alreadyCovered = ambiguities.some(a => a.type === 'analytical_meaning');
            if (!alreadyCovered) {
                ambiguities.push({
                    id: nextAmbiguityId(),
                    type: 'metric',
                    phrase: metricConcepts.find(c => lower.includes(c)) || 'metric',
                    candidates: metricFields.slice(0, 5).map((f, i) => ({
                        id: f.name,
                        label: f.displayLabel || f.name,
                        description: `Use ${f.displayLabel || f.name} (${f.defaultAgg})`,
                        confidence: i === 0 ? 0.80 : 0.80 - (i * 0.12),
                        field: f.name,
                    })),
                    selected: metricFields.length > 0 ? {
                        id: metricFields[0].name,
                        label: metricFields[0].displayLabel || metricFields[0].name,
                        description: `Default: ${metricFields[0].displayLabel || metricFields[0].name}`,
                        confidence: 0.70,
                        field: metricFields[0].name,
                    } : null,
                    confidence: 0.60,
                    materiality: 'high',
                    resolvedBy: 'unresolved',
                });
            }
        }
    }

    // ─── 6. Comparison Ambiguity ─────────────────────────────────
    const compMatch = lower.match(COMPARISON_PATTERNS);
    if (compMatch) {
        const policy = registry.get('growth');
        if (policy) {
            ambiguities.push({
                id: nextAmbiguityId(),
                type: 'comparison',
                phrase: compMatch[0],
                candidates: (policy.alternatives || []).map(alt => ({
                    id: alt.id,
                    label: alt.label,
                    description: alt.interpretation,
                    confidence: policy.confidence,
                })),
                selected: {
                    id: 'pop',
                    label: 'Period over period',
                    description: policy.defaultInterpretation,
                    confidence: policy.confidence,
                },
                confidence: policy.confidence,
                materiality: 'medium',
                resolvedBy: 'semantic_policy',
            });
        }
    }

    // ─── 7. Evidence Gap Detection ───────────────────────────────
    const evidenceMatch = lower.match(EVIDENCE_PATTERNS);
    if (evidenceMatch) {
        ambiguities.push({
            id: nextAmbiguityId(),
            type: 'evidence_gap',
            phrase: evidenceMatch[0],
            candidates: [
                { id: 'descriptive', label: 'Show related data', description: 'Display relevant metrics and breakdowns', confidence: 0.70 },
                { id: 'correlation', label: 'Show correlations', description: 'Find statistical correlations between metrics', confidence: 0.50 },
            ],
            selected: {
                id: 'descriptive',
                label: 'Show related data',
                description: 'Causal analysis requires statistical modeling — showing descriptive breakdown instead',
                confidence: 0.60,
            },
            confidence: 0.50,
            materiality: 'high',
            resolvedBy: 'semantic_policy',
        });
    }

    // ─── Compute Summary ─────────────────────────────────────────
    const hasHighMateriality = ambiguities.some(a => a.materiality === 'high');
    const autoResolvableCount = ambiguities.filter(a => a.selected !== null && a.materiality !== 'high').length;

    return {
        ambiguities,
        hasHighMateriality,
        autoResolvableCount,
        totalCount: ambiguities.length,
    };
}
