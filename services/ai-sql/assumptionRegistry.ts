/**
 * assumptionRegistry.ts — Assumption Tracking & Disclosure
 *
 * Tracks every assumption QuickInsight makes when resolving ambiguity.
 * Provides a non-blocking UI model: show assumptions inline,
 * allow users to change interpretations post-hoc, and re-run queries.
 *
 * Assumptions are:
 *   - Displayed as interactive chips in the results view
 *   - Changeable without re-typing the question
 *   - Persisted per question for the session
 */

import { ResolvedAmbiguity } from './ambiguityResolver';
import { RankedPlan } from './planRanker';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface Assumption {
    id: string;
    /** Links to the original ambiguity */
    ambiguityId: string;
    /** Ambiguity type for categorization */
    type: string;
    /** The phrase from the question that triggered this */
    phrase: string;
    /** Current interpretation (human-readable) */
    interpretation: string;
    /** Available alternatives the user can choose */
    alternatives: AssumptionAlternative[];
    /** Confidence in the current interpretation (0-1) */
    confidence: number;
    /** Whether this was auto-resolved or user-chosen */
    autoResolved: boolean;
    /** Whether the user has overridden this */
    userOverridden: boolean;
    /** Display category for UI grouping */
    category: 'metric' | 'filter' | 'time' | 'ranking' | 'aggregation' | 'other';
    /** Computed threshold value if applicable */
    computedValue?: number | string;
}

export interface AssumptionAlternative {
    id: string;
    label: string;
    description: string;
}

export interface AssumptionSet {
    questionId: string;
    question: string;
    assumptions: Assumption[];
    /** Human-readable summary for display */
    summary: string;
    /** Total confidence across all assumptions */
    overallConfidence: number;
    /** Whether any assumption needs user confirmation */
    hasUnconfirmed: boolean;
    createdAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════

const assumptionStore = new Map<string, AssumptionSet>();
let _nextId = 0;

function nextAssumptionId(): string {
    return `asmp_${++_nextId}`;
}

/**
 * Build an AssumptionSet from resolved ambiguities and the selected plan.
 */
export function buildAssumptions(
    question: string,
    resolved: ResolvedAmbiguity[],
    selectedPlan?: RankedPlan
): AssumptionSet {
    const questionId = `q_${Date.now()}`;
    const assumptions: Assumption[] = [];

    // Convert resolved ambiguities to assumptions
    for (const amb of resolved) {
        const category = mapTypeToCategory(amb.type);

        assumptions.push({
            id: nextAssumptionId(),
            ambiguityId: amb.id,
            type: amb.type,
            phrase: amb.phrase,
            interpretation: amb.resolution.label,
            alternatives: amb.candidates
                .filter(c => c.id !== amb.resolution.id)
                .map(c => ({
                    id: c.id,
                    label: c.label,
                    description: c.description,
                })),
            confidence: amb.resolution.confidence,
            autoResolved: !amb.needsUserConfirmation,
            userOverridden: false,
            category,
            computedValue: amb.computedThreshold,
        });
    }

    // Add plan-level assumptions
    if (selectedPlan) {
        for (const planAsmp of selectedPlan.assumptions) {
            // Avoid duplicating ambiguity-based assumptions
            if (assumptions.some(a => a.ambiguityId === planAsmp.ambiguityId)) continue;

            assumptions.push({
                id: nextAssumptionId(),
                ambiguityId: planAsmp.ambiguityId,
                type: planAsmp.type,
                phrase: planAsmp.phrase,
                interpretation: planAsmp.resolved,
                alternatives: [],
                confidence: planAsmp.confidence,
                autoResolved: true,
                userOverridden: false,
                category: mapTypeToCategory(planAsmp.type),
            });
        }
    }

    // Build summary
    const summaryParts = assumptions.map(a =>
        `"${a.phrase}" → ${a.interpretation}`
    );
    const summary = summaryParts.length > 0
        ? `Interpreted: ${summaryParts.join('; ')}.`
        : 'No assumptions made — question was unambiguous.';

    // Overall confidence
    const overallConfidence = assumptions.length > 0
        ? assumptions.reduce((sum, a) => sum + a.confidence, 0) / assumptions.length
        : 1.0;

    const set: AssumptionSet = {
        questionId,
        question,
        assumptions,
        summary,
        overallConfidence,
        hasUnconfirmed: assumptions.some(a => !a.autoResolved),
        createdAt: Date.now(),
    };

    // Store for later retrieval
    assumptionStore.set(questionId, set);

    return set;
}

/**
 * Update a specific assumption with a user's choice.
 * Returns the updated set (for re-running the query).
 */
export function updateAssumption(
    questionId: string,
    assumptionId: string,
    newAlternativeId: string
): AssumptionSet | null {
    const set = assumptionStore.get(questionId);
    if (!set) return null;

    const assumption = set.assumptions.find(a => a.id === assumptionId);
    if (!assumption) return null;

    const alternative = assumption.alternatives.find(a => a.id === newAlternativeId);
    if (!alternative) return null;

    // Move current interpretation to alternatives
    assumption.alternatives.push({
        id: 'previous',
        label: assumption.interpretation,
        description: `Previous: ${assumption.interpretation}`,
    });

    // Apply new choice
    assumption.interpretation = alternative.label;
    assumption.userOverridden = true;
    assumption.autoResolved = false;
    assumption.confidence = 1.0; // User-chosen = full confidence

    // Remove the chosen alternative
    assumption.alternatives = assumption.alternatives.filter(a => a.id !== newAlternativeId);

    // Rebuild summary
    const summaryParts = set.assumptions.map(a => `"${a.phrase}" → ${a.interpretation}`);
    set.summary = `Interpreted: ${summaryParts.join('; ')}.`;
    set.overallConfidence = set.assumptions.reduce((sum, a) => sum + a.confidence, 0) / set.assumptions.length;

    return set;
}

/**
 * Get the assumption set for a question.
 */
export function getAssumptions(questionId: string): AssumptionSet | null {
    return assumptionStore.get(questionId) || null;
}

/**
 * Get all stored assumption sets (for history/debugging).
 */
export function getAllAssumptions(): AssumptionSet[] {
    return Array.from(assumptionStore.values());
}

/** Clear all stored assumptions */
export function clearAssumptions(): void {
    assumptionStore.clear();
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function mapTypeToCategory(type: string): Assumption['category'] {
    switch (type) {
        case 'metric':
        case 'analytical_meaning':
            return 'metric';
        case 'threshold':
        case 'category_value':
        case 'scope':
            return 'filter';
        case 'time':
        case 'temporal_anchor':
            return 'time';
        case 'ranking':
            return 'ranking';
        case 'aggregation':
        case 'entity_grain':
        case 'join_grain':
            return 'aggregation';
        default:
            return 'other';
    }
}
