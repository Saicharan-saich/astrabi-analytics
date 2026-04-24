/**
 * arbitrationEngine.ts — Continuous Delta Arbitration Engine
 *
 * Final decision layer that resolves the semantic type and role for each column
 * using continuous delta arbitration across all signal sources.
 *
 * PRIORITY HIERARCHY (absolute):
 *   Hard Physics Constraints > User Feedback > Deterministic Engine > AI
 *
 * FEATURES:
 *   - Continuous delta (no binary cliffs)
 *   - Physics ceiling on feedback (prevents bad overrides)
 *   - UNKNOWN/needs_review fallback state
 *   - Smart telemetry sampling for observability
 */

import { SemanticType, FieldRole, FieldClassificationSignals } from './types';
import { ConstraintResult } from './constraintGates';
import { AIClassificationResult } from './aiArbitrator';
import { FeedbackLookupResult, recordSeedDisagreement } from './classificationFeedback';

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Delta threshold: AI must exceed deterministic by this margin to win.
 * Slightly asymmetric toward deterministic to prevent over-trusting AI.
 * This value should be calibrated over time using telemetry logs.
 */
const DELTA_THRESHOLD = 0.2;

/**
 * Minimum confidence for ANY source to make a classification.
 * Below this → mark as 'needs_review' / UNKNOWN.
 */
const ABSTAIN_THRESHOLD = 0.5;

// ═══════════════════════════════════════════════════════════════════
// ARBITRATION OUTPUT
// ═══════════════════════════════════════════════════════════════════

export interface ArbitrationResult {
    semanticType: SemanticType;
    role: FieldRole;
    signals: FieldClassificationSignals;
    /** Whether this column needs human review */
    needsReview: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// TELEMETRY — Smart sampling for observability
// ═══════════════════════════════════════════════════════════════════

export interface ClassificationDecision {
    columnName: string;
    detConf: number;
    derivedAiConf: number | null;
    feedbackConf: number | null;
    finalType: SemanticType;
    finalRole: FieldRole;
    finalSource: 'deterministic' | 'ai' | 'user_override' | 'seed';
    wasDisagreement: boolean;
    needsReview: boolean;
    timestamp: number;
}

const TELEMETRY_KEY = 'QuickInsight_classification_telemetry';
const MAX_TELEMETRY_ENTRIES = 500;

/** Log a classification decision with smart sampling */
function logDecision(decision: ClassificationDecision): void {
    // Always log: disagreements, overrides, unknowns, needs_review
    const alwaysLog = decision.wasDisagreement ||
        decision.finalSource === 'user_override' ||
        decision.needsReview ||
        decision.finalType === 'unknown';

    // Random blind-spot sampling: 2% of high-confidence routine decisions
    const isRoutineHighConf = !alwaysLog && decision.detConf > 0.8;
    const blindSpotSample = isRoutineHighConf && Math.random() < 0.02;

    // Sample 5% of other routine decisions
    const routineSample = !alwaysLog && !blindSpotSample && Math.random() < 0.05;

    if (!alwaysLog && !blindSpotSample && !routineSample) return;

    try {
        const raw = localStorage.getItem(TELEMETRY_KEY);
        const log: ClassificationDecision[] = raw ? JSON.parse(raw) : [];
        log.unshift(decision);
        if (log.length > MAX_TELEMETRY_ENTRIES) log.length = MAX_TELEMETRY_ENTRIES;
        localStorage.setItem(TELEMETRY_KEY, JSON.stringify(log));
    } catch { /* storage full */ }
}

/** Retrieve classification telemetry log */
export function getClassificationTelemetry(): ClassificationDecision[] {
    try {
        const raw = localStorage.getItem(TELEMETRY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ARBITRATION FUNCTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Run the continuous delta arbitration for a single column.
 *
 * @param columnName - Column name for logging
 * @param constraint - Output from the constraint gates (hard physics)
 * @param aiResult - AI classification result (null if AI was unavailable)
 * @param feedback - User feedback lookup result (null if no feedback exists)
 */
export function arbitrate(
    columnName: string,
    constraint: ConstraintResult,
    aiResult: AIClassificationResult | null,
    feedback: FeedbackLookupResult | null,
): ArbitrationResult {
    const detConf = constraint.detConf;
    const detType = constraint.bestGuess.semanticType;
    const detRole = constraint.bestGuess.role;
    const allowedTypes = constraint.allowedTypes;

    let finalType: SemanticType = detType;
    let finalRole: FieldRole = detRole;
    let finalSource: 'deterministic' | 'ai' | 'user_override' | 'seed' = 'deterministic';
    let wasDisagreement = false;
    let needsReview = false;

    // ── LAYER 1: Check User Feedback (if physics allows) ─────────
    if (feedback) {
        const fbType = feedback.entry.semanticType;
        const fbRole = feedback.entry.role;

        // Physics ceiling: feedback MUST be within allowed types
        if (allowedTypes.includes(fbType)) {
            // Feedback wins if it has meaningful confidence
            if (feedback.feedbackConf > 0.3) {
                finalType = fbType;
                finalRole = fbRole;
                finalSource = feedback.entry.source === 'user' ? 'user_override' : 'seed';

                if (fbType !== detType) {
                    wasDisagreement = true;
                    console.log(`[Arbitration] "${columnName}": ${finalSource} override (${fbType}) beats deterministic (${detType}), feedbackConf=${feedback.feedbackConf.toFixed(2)}`);
                }
            }
        } else {
            // Physics ceiling activated — feedback contradicts hard constraints
            console.log(`[Arbitration] "${columnName}": Physics ceiling — feedback (${fbType}) rejected, not in allowed types [${allowedTypes.join(', ')}]`);

            // Record seed disagreement for bias degradation
            if (feedback.entry.source === 'seed') {
                recordSeedDisagreement(columnName);
            }
        }
    }

    // ── LAYER 2: AI Arbitration (if no feedback override occurred) ─
    if (finalSource === 'deterministic' && aiResult && aiResult.derivedAiConf > 0) {
        const aiType = aiResult.aiSuggestedType;
        const aiRole = aiResult.aiSuggestedRole;
        const aiConf = aiResult.derivedAiConf;

        // Physics gate: AI type must be in allowed types
        if (allowedTypes.includes(aiType)) {
            const delta = aiConf - detConf;

            if (delta > DELTA_THRESHOLD) {
                // AI wins — continuous delta exceeded threshold
                finalType = aiType;
                finalRole = aiRole;
                finalSource = 'ai';
                wasDisagreement = aiType !== detType;

                console.log(`[Arbitration] "${columnName}": AI wins (${aiType}, conf=${aiConf.toFixed(2)}) over deterministic (${detType}, conf=${detConf.toFixed(2)}), delta=${delta.toFixed(2)}`);
            } else if (aiType !== detType) {
                wasDisagreement = true;
                console.log(`[Arbitration] "${columnName}": Deterministic wins (${detType}, conf=${detConf.toFixed(2)}) — AI delta ${delta.toFixed(2)} < threshold ${DELTA_THRESHOLD}`);
            }
        } else {
            console.log(`[Arbitration] "${columnName}": AI suggestion (${aiType}) vetoed — not in allowed types`);
        }
    }

    // ── LAYER 3: Abstain/Needs Review Check ──────────────────────
    const maxConf = Math.max(
        detConf,
        aiResult?.derivedAiConf ?? 0,
        feedback?.feedbackConf ?? 0,
    );
    if (maxConf < ABSTAIN_THRESHOLD && finalType !== 'boolean' && finalType !== 'date') {
        needsReview = true;
        console.log(`[Arbitration] "${columnName}": LOW CONFIDENCE (max=${maxConf.toFixed(2)}) → needs review`);
    }

    // ── Build classification signals ─────────────────────────────
    const signals: FieldClassificationSignals = {
        detConf,
        aiConf: aiResult?.derivedAiConf ?? null,
        finalSource,
        reason: buildReason(finalSource, constraint, aiResult, feedback),
        signals: constraint.signals,
        allowedTypes,
    };

    // ── Log telemetry ────────────────────────────────────────────
    logDecision({
        columnName,
        detConf,
        derivedAiConf: aiResult?.derivedAiConf ?? null,
        feedbackConf: feedback?.feedbackConf ?? null,
        finalType,
        finalRole,
        finalSource,
        wasDisagreement,
        needsReview,
        timestamp: Date.now(),
    });

    return { semanticType: finalType, role: finalRole, signals, needsReview };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function buildReason(
    source: string,
    constraint: ConstraintResult,
    aiResult: AIClassificationResult | null,
    feedback: FeedbackLookupResult | null,
): string {
    switch (source) {
        case 'user_override':
            return `User override (${feedback!.entry.frequency} time(s), conf=${feedback!.feedbackConf.toFixed(2)})`;
        case 'seed':
            return `Seed pattern match (conf=${feedback!.feedbackConf.toFixed(2)})`;
        case 'ai':
            return aiResult?.aiReason || 'AI classification accepted';
        case 'deterministic':
        default:
            return constraint.reason;
    }
}
