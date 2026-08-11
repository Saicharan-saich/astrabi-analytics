/**
 * ambiguityResolver.ts — Orchestrated Resolution Engine
 *
 * Takes detected ambiguities and resolves them using a priority chain:
 *   1. Local Statistics (DuckDB evidence)
 *   2. Semantic Policy Registry (domain defaults)
 *   3. Metric Dictionary (knowledge base lookup)
 *   4. Materiality Gate (auto-resolve or ask user)
 *
 * Only escalates to user when competing interpretations are
 * genuinely consequential (materiality = 'high' AND Δ score < threshold).
 */

import { DetectedAmbiguity, AmbiguityCandidate, AmbiguityDetectionResult } from './ambiguityDetector';
import { DatasetStatistics, computeThreshold } from './localStatisticsResolver';
import { getPolicyRegistry } from './semanticPolicyRegistry';
import { getMetricDictionary } from './metricDictionary';
import { AnalysisPlan, SemanticField, SemanticModel } from './types';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ResolvedAmbiguity extends DetectedAmbiguity {
    /** The final resolved interpretation */
    resolution: AmbiguityCandidate;
    /** Why this resolution was chosen */
    resolutionReason: string;
    /** Whether the user should be asked to confirm */
    needsUserConfirmation: boolean;
    /** Computed threshold value (if applicable) */
    computedThreshold?: number;
}

export interface AmbiguityResolutionResult {
    resolved: ResolvedAmbiguity[];
    unresolved: DetectedAmbiguity[];
    needsUserInput: boolean;
    autoResolvedCount: number;
    /** Human-readable summary of all assumptions */
    assumptionSummary: string;
}

// ═══════════════════════════════════════════════════════════════════
// MATERIALITY GATE
// ═══════════════════════════════════════════════════════════════════

/** Threshold: if the gap between top-2 candidates is below this, ask the user */
const MATERIALITY_THRESHOLD = 0.15;

function shouldAskUser(ambiguity: DetectedAmbiguity): boolean {
    if (ambiguity.materiality !== 'high') return false;
    if (!ambiguity.selected) return true;

    // If there's a clear winner (high confidence), auto-resolve
    if (ambiguity.selected.confidence >= 0.85) return false;

    // If candidates are close in score, ask the user
    const sortedCandidates = [...ambiguity.candidates].sort((a, b) => b.confidence - a.confidence);
    if (sortedCandidates.length >= 2) {
        const gap = sortedCandidates[0].confidence - sortedCandidates[1].confidence;
        if (gap < MATERIALITY_THRESHOLD) return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════════
// RESOLUTION ENGINE
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve all detected ambiguities using the priority chain:
 * Local Stats → Policy → Dictionary → Materiality Gate
 */
export async function resolveAmbiguities(
    detection: AmbiguityDetectionResult,
    semanticModel: SemanticModel,
    stats: DatasetStatistics,
    domain?: string,
    question: string = '',
    plan?: AnalysisPlan
): Promise<AmbiguityResolutionResult> {
    const resolved: ResolvedAmbiguity[] = [];
    const unresolved: DetectedAmbiguity[] = [];
    const registry = getPolicyRegistry(domain);
    const dictionary = getMetricDictionary();

    for (const ambiguity of detection.ambiguities) {
        let resolution: AmbiguityCandidate | null = null;
        let reason = '';
        let computedThreshold: number | undefined;

        // ─── Priority 1: Local Statistics ────────────────────────
        if (ambiguity.type === 'threshold' && stats) {
            // Bind each threshold phrase to the metric it qualifies. Choosing the
            // first semantic metric made multi-metric requests such as "high
            // sales but low profit" apply both thresholds to sales.
            const metricField = resolveMetricForAmbiguity(
                ambiguity,
                question,
                semanticModel,
                plan?.metrics.map(metric => metric.field) || []
            );
            if (metricField && stats.metrics[metricField.name]) {
                const metricStats = stats.metrics[metricField.name];

                // Resolve "high" → above average using actual data
                if (ambiguity.phrase.match(/high|strong|good|above/i)) {
                    computedThreshold = metricStats.mean;
                    resolution = {
                        id: 'above_avg_computed',
                        label: `Above average (${formatNumber(metricStats.mean)})`,
                        description: `Values above the dataset average of ${formatNumber(metricStats.mean)}`,
                        confidence: 0.88,
                        field: metricField.name,
                        value: metricStats.mean,
                    };
                    reason = `Resolved ${metricField.displayLabel || metricField.name} using dataset statistics: mean = ${formatNumber(metricStats.mean)}, median = ${formatNumber(metricStats.median)}`;
                }

                // Resolve "low" → below average using actual data
                if (ambiguity.phrase.match(/low|weak|poor|below|under/i)) {
                    computedThreshold = metricStats.mean;
                    resolution = {
                        id: 'below_avg_computed',
                        label: `Below average (${formatNumber(metricStats.mean)})`,
                        description: `Values below the dataset average of ${formatNumber(metricStats.mean)}`,
                        confidence: 0.88,
                        field: metricField.name,
                        value: metricStats.mean,
                    };
                    reason = `Resolved ${metricField.displayLabel || metricField.name} using dataset statistics: mean = ${formatNumber(metricStats.mean)}`;
                }

                // Resolve "unusual/outlier" → 2σ using actual data
                if (ambiguity.phrase.match(/unusual|outlier|anomal|spike/i)) {
                    const threshold2sigma = metricStats.mean + 2 * metricStats.stddev;
                    computedThreshold = threshold2sigma;
                    resolution = {
                        id: '2sigma_computed',
                        label: `Outlier (> ${formatNumber(threshold2sigma)})`,
                        description: `Values more than 2 standard deviations from the mean`,
                        confidence: 0.82,
                        field: metricField.name,
                        value: threshold2sigma,
                    };
                    reason = `Resolved ${metricField.displayLabel || metricField.name} using 2σ: mean=${formatNumber(metricStats.mean)}, σ=${formatNumber(metricStats.stddev)}`;
                }
            }
        }

        // ─── Priority 2: Semantic Policy ─────────────────────────
        if (!resolution && ambiguity.selected) {
            resolution = ambiguity.selected;
            reason = `Default semantic policy for "${ambiguity.phrase}"`;
        }

        // ─── Priority 3: Metric Dictionary ───────────────────────
        if (!resolution && ambiguity.type === 'metric') {
            const concept = dictionary.matchConcept(ambiguity.phrase);
            if (concept) {
                const primaryMetricId = concept.priorityOrder[0];
                const primaryEntry = dictionary.getMetric(primaryMetricId);
                if (primaryEntry) {
                    resolution = {
                        id: primaryMetricId,
                        label: primaryEntry.displayName,
                        description: `Dictionary default: ${primaryEntry.description}`,
                        confidence: 0.75,
                    };
                    reason = `Metric dictionary: "${ambiguity.phrase}" → ${primaryEntry.displayName}`;
                }
            }
        }

        // ─── Priority 4: Best candidate fallback ─────────────────
        if (!resolution && ambiguity.candidates.length > 0) {
            resolution = ambiguity.candidates.sort((a, b) => b.confidence - a.confidence)[0];
            reason = `Best available candidate (confidence: ${resolution.confidence})`;
        }

        // ─── Materiality Gate ────────────────────────────────────
        if (resolution) {
            const needsUser = shouldAskUser(ambiguity);

            resolved.push({
                ...ambiguity,
                resolution,
                resolutionReason: reason,
                needsUserConfirmation: needsUser,
                computedThreshold,
                resolvedBy: computedThreshold ? 'local_statistics' : ambiguity.resolvedBy,
            });
        } else {
            unresolved.push(ambiguity);
        }
    }

    // ─── Build Summary ───────────────────────────────────────────
    const autoResolved = resolved.filter(r => !r.needsUserConfirmation);
    const assumptionParts = autoResolved.map(r =>
        `Interpreted "${r.phrase}" as ${r.resolution.label}`
    );

    return {
        resolved,
        unresolved,
        needsUserInput: resolved.some(r => r.needsUserConfirmation) || unresolved.length > 0,
        autoResolvedCount: autoResolved.length,
        assumptionSummary: assumptionParts.length > 0
            ? assumptionParts.join('. ') + '.'
            : 'No ambiguity detected.',
    };
}

// ═══════════════════════════════════════════════════════════════════
// AUTHORITATIVE PLAN APPLICATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Apply evidence-backed resolutions to the executable plan before SQL is
 * generated. Only transformations with deterministic semantics are applied;
 * interpretive alternatives still go through the materiality gate.
 */
export function applyResolvedAmbiguitiesToPlan(
    plan: AnalysisPlan,
    resolution: AmbiguityResolutionResult
): AnalysisPlan {
    const nextPlan: AnalysisPlan = {
        ...plan,
        metrics: plan.metrics.map(metric => ({ ...metric })),
        dimensions: plan.dimensions.map(dimension => ({ ...dimension })),
        filters: plan.filters.map(filter => ({ ...filter })),
        sort: plan.sort.map(sort => ({ ...sort })),
    };

    for (const ambiguity of resolution.resolved) {
        if (
            ambiguity.type !== 'threshold' ||
            ambiguity.needsUserConfirmation ||
            ambiguity.computedThreshold === undefined ||
            !ambiguity.resolution.field
        ) continue;

        const field = ambiguity.resolution.field;
        const isUpper = /high|strong|good|above|outlier|unusual|anomal|spike/i.test(ambiguity.phrase);
        const isLower = /low|weak|poor|below|under|negative/i.test(ambiguity.phrase);
        if (!isUpper && !isLower) continue;

        const op: '>' | '<' = isUpper ? '>' : '<';
        const relativeIndex = nextPlan.filters.findIndex(filter =>
            filter.field.toLowerCase() === field.toLowerCase() &&
            (filter.op === 'above_avg' || filter.op === 'below_avg')
        );
        const alreadyApplied = nextPlan.filters.some(filter =>
            filter.field.toLowerCase() === field.toLowerCase() &&
            filter.op === op &&
            Number(filter.value) === ambiguity.computedThreshold
        );
        if (alreadyApplied) continue;

        const evidenceFilter = {
            field,
            op,
            value: ambiguity.computedThreshold,
            isHaving: nextPlan.dimensions.length > 0,
            includeNonPositive: isLower && /negative|non[- ]?positive/i.test(plan.originalQuestion),
        } as const;

        if (relativeIndex >= 0) nextPlan.filters[relativeIndex] = evidenceFilter;
        else nextPlan.filters.push(evidenceFilter);
    }

    if (!resolution.needsUserInput) {
        nextPlan.ambiguous = false;
        nextPlan.clarificationQuestion = undefined;
    }
    return nextPlan;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function resolveMetricForAmbiguity(
    ambiguity: DetectedAmbiguity,
    question: string,
    semanticModel: SemanticModel,
    preferredMetricNames: string[]
): SemanticField | undefined {
    const metrics = semanticModel.fields.filter(field =>
        field.role === 'metric' && field.physicalType === 'number'
    );
    if (metrics.length === 0) return undefined;

    const explicitCandidateField = ambiguity.candidates
        .map(candidate => candidate.field)
        .find((field): field is string => Boolean(field));
    if (explicitCandidateField) {
        const explicit = metrics.find(field => field.name === explicitCandidateField);
        if (explicit) return explicit;
    }

    const lowerQuestion = question.toLowerCase();
    const phraseIndex = Math.max(0, lowerQuestion.indexOf(ambiguity.phrase.toLowerCase()));
    const preferred = new Set(preferredMetricNames.map(name => name.toLowerCase()));

    const scored = metrics.map(field => {
        const terms = [field.name, field.displayLabel, ...field.synonyms]
            .filter(Boolean)
            .map(term => String(term).toLowerCase());
        let score = preferred.has(field.name.toLowerCase()) ? 20 : 0;

        for (const term of terms) {
            const positions: number[] = [];
            let from = 0;
            while (from < lowerQuestion.length) {
                const position = lowerQuestion.indexOf(term, from);
                if (position < 0) break;
                positions.push(position);
                from = position + Math.max(1, term.length);
            }
            for (const position of positions) {
                const distance = Math.abs(position - phraseIndex);
                score = Math.max(score, 100 - Math.min(80, distance));
            }
        }
        return { field, score };
    }).sort((a, b) => b.score - a.score);

    // If the question names no metric, retain the governed plan's primary
    // metric, then the semantic model's default. Do not invent a new field.
    return scored[0].score > 20
        ? scored[0].field
        : metrics.find(field => preferred.has(field.name.toLowerCase())) || metrics[0];
}

function formatNumber(n: number): string {
    if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
    if (Number.isInteger(n)) return n.toString();
    return n.toFixed(2);
}
