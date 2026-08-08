/**
 * planRanker.ts — Weighted Plan Scoring Engine
 *
 * Scores and ranks candidate plans using 7 weighted signals:
 *   1. Explicit wording match (30%)
 *   2. Semantic model primary KPI (25%)
 *   3. Metric dictionary relevance (15%)
 *   4. Dataset coverage (10%)
 *   5. Domain profile alignment (10%)
 *   6. Historical user choices (5%)
 *   7. Question Builder compatibility (5%)
 *
 * Returns the ranked plans with a recommendation:
 *   - Clear winner → auto-select
 *   - Close race → ask user
 */

import { CandidatePlan } from './candidatePlanGenerator';
import { SemanticModel } from './types';
import { DatasetStatistics } from './localStatisticsResolver';
import { getMetricDictionary } from './metricDictionary';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface RankedPlan extends CandidatePlan {
    /** Final weighted score (0-1) */
    finalScore: number;
    /** Breakdown of scoring signals */
    scoreBreakdown: ScoreBreakdown;
    /** Whether this is the recommended plan */
    isRecommended: boolean;
}

export interface ScoreBreakdown {
    wordingMatch: number;
    primaryKpiBonus: number;
    dictionaryRelevance: number;
    dataCoverage: number;
    domainAlignment: number;
    historicalPreference: number;
    builderCompatibility: number;
}

export interface PlanRankingResult {
    rankedPlans: RankedPlan[];
    recommendation: 'auto_select' | 'ask_user';
    /** Gap between #1 and #2 */
    confidenceGap: number;
    /** Why this recommendation was made */
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════
// WEIGHTS
// ═══════════════════════════════════════════════════════════════════

const WEIGHTS = {
    wordingMatch: 0.30,
    primaryKpiBonus: 0.25,
    dictionaryRelevance: 0.15,
    dataCoverage: 0.10,
    domainAlignment: 0.10,
    historicalPreference: 0.05,
    builderCompatibility: 0.05,
};

/** Minimum gap between #1 and #2 to auto-select */
const AUTO_SELECT_THRESHOLD = 0.12;

// ═══════════════════════════════════════════════════════════════════
// HISTORICAL PREFERENCES (in-memory for now)
// ═══════════════════════════════════════════════════════════════════

const userPreferences = new Map<string, number>();

/** Record a user's metric choice for future scoring */
export function recordUserPreference(metricName: string): void {
    const count = userPreferences.get(metricName) || 0;
    userPreferences.set(metricName, count + 1);
}

// ═══════════════════════════════════════════════════════════════════
// RANKING ENGINE
// ═══════════════════════════════════════════════════════════════════

/**
 * Score and rank candidate plans using weighted signals.
 */
export function rankPlans(
    candidates: CandidatePlan[],
    question: string,
    semanticModel: SemanticModel,
    stats: DatasetStatistics,
    domain?: string
): PlanRankingResult {
    const dictionary = getMetricDictionary();
    const lower = question.toLowerCase();

    const rankedPlans: RankedPlan[] = candidates.map(plan => {
        const metricName = plan.partialPlan.metrics?.[0]?.field || '';
        const breakdown: ScoreBreakdown = {
            wordingMatch: 0,
            primaryKpiBonus: 0,
            dictionaryRelevance: 0,
            dataCoverage: 0,
            domainAlignment: 0,
            historicalPreference: 0,
            builderCompatibility: 0,
        };

        // ─── 1. Wording Match (30%) ──────────────────────────────
        const field = semanticModel.fields.find(f => f.name === metricName);
        if (field) {
            const matchTerms = [
                field.name.toLowerCase(),
                field.displayLabel?.toLowerCase(),
                ...field.synonyms.map(s => s.toLowerCase()),
            ].filter(Boolean) as string[];

            const hasMatch = matchTerms.some(t => lower.includes(t));
            breakdown.wordingMatch = hasMatch ? 1.0 : 0.3;
        } else {
            breakdown.wordingMatch = 0.2;
        }

        // ─── 2. Primary KPI Bonus (25%) ──────────────────────────
        const metricFields = semanticModel.fields.filter(f => f.role === 'metric');
        if (metricFields.length > 0 && metricFields[0].name === metricName) {
            breakdown.primaryKpiBonus = 1.0; // This is the primary metric
        } else {
            const metricIndex = metricFields.findIndex(f => f.name === metricName);
            breakdown.primaryKpiBonus = metricIndex >= 0 ? Math.max(0.2, 1 - metricIndex * 0.2) : 0.1;
        }

        // ─── 3. Dictionary Relevance (15%) ───────────────────────
        const dictEntry = dictionary.matchColumn(metricName);
        if (dictEntry) {
            // Check if the dictionary domain matches
            const domainMatch = domain
                ? dictEntry.domains.some(d => d.toLowerCase().includes(domain.toLowerCase()))
                : true;
            breakdown.dictionaryRelevance = domainMatch ? 0.9 : 0.5;
        } else {
            breakdown.dictionaryRelevance = 0.3;
        }

        // ─── 4. Data Coverage (10%) ──────────────────────────────
        if (stats.metrics[metricName]) {
            const nullRate = stats.metrics[metricName].nullRate;
            breakdown.dataCoverage = 1.0 - nullRate; // Higher coverage = better
        } else {
            breakdown.dataCoverage = 0.5; // Unknown
        }

        // ─── 5. Domain Alignment (10%) ───────────────────────────
        if (domain && dictEntry) {
            breakdown.domainAlignment = dictEntry.domains.some(d =>
                d.toLowerCase().includes(domain.toLowerCase())
            ) ? 1.0 : 0.3;
        } else {
            breakdown.domainAlignment = 0.5;
        }

        // ─── 6. Historical Preference (5%) ───────────────────────
        const prefCount = userPreferences.get(metricName) || 0;
        const maxPref = Math.max(...Array.from(userPreferences.values()), 1);
        breakdown.historicalPreference = maxPref > 0 ? prefCount / maxPref : 0.5;

        // ─── 7. Builder Compatibility (5%) ───────────────────────
        // Plans that could be expressed in the Question Builder are preferred
        const hasValidDim = (plan.partialPlan.dimensions?.length || 0) <= 2;
        const hasValidMetric = (plan.partialPlan.metrics?.length || 0) === 1;
        breakdown.builderCompatibility = (hasValidDim && hasValidMetric) ? 1.0 : 0.5;

        // ─── Weighted Final Score ────────────────────────────────
        const finalScore =
            breakdown.wordingMatch * WEIGHTS.wordingMatch +
            breakdown.primaryKpiBonus * WEIGHTS.primaryKpiBonus +
            breakdown.dictionaryRelevance * WEIGHTS.dictionaryRelevance +
            breakdown.dataCoverage * WEIGHTS.dataCoverage +
            breakdown.domainAlignment * WEIGHTS.domainAlignment +
            breakdown.historicalPreference * WEIGHTS.historicalPreference +
            breakdown.builderCompatibility * WEIGHTS.builderCompatibility;

        return {
            ...plan,
            finalScore,
            scoreBreakdown: breakdown,
            isRecommended: false,
        };
    });

    // Sort by final score
    rankedPlans.sort((a, b) => b.finalScore - a.finalScore);

    // Mark the top plan as recommended
    if (rankedPlans.length > 0) {
        rankedPlans[0].isRecommended = true;
    }

    // Determine recommendation
    const confidenceGap = rankedPlans.length >= 2
        ? rankedPlans[0].finalScore - rankedPlans[1].finalScore
        : 1.0;

    const recommendation: 'auto_select' | 'ask_user' =
        confidenceGap >= AUTO_SELECT_THRESHOLD ? 'auto_select' : 'ask_user';

    const reason = recommendation === 'auto_select'
        ? `"${rankedPlans[0].interpretation}" scored ${(rankedPlans[0].finalScore * 100).toFixed(0)}% vs runner-up at ${((rankedPlans[1]?.finalScore || 0) * 100).toFixed(0)}% (gap: ${(confidenceGap * 100).toFixed(0)}%)`
        : `Top plans are close: "${rankedPlans[0]?.interpretation}" (${(rankedPlans[0]?.finalScore * 100).toFixed(0)}%) vs "${rankedPlans[1]?.interpretation}" (${((rankedPlans[1]?.finalScore || 0) * 100).toFixed(0)}%) — asking user`;

    return {
        rankedPlans,
        recommendation,
        confidenceGap,
        reason,
    };
}
