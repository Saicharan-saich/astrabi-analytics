/**
 * constraintGates.ts — Hard Physics Constraint Gates & Deterministic Confidence Scorer
 *
 * CRITICAL SAFETY LAYER: Runs BEFORE any AI arbitration.
 * Generates:
 *   1. allowedTypes[] — constraint-filtered list of possible semantic types
 *   2. detConf — weighted deterministic confidence score (0–1)
 *
 * RULES:
 *   - Physics gates are ABSOLUTE — AI and user feedback cannot override them
 *   - Same input → same output (100% deterministic)
 */

import { SemanticType, FieldRole } from './types';
import { ColumnType } from '../../types';

// ═══════════════════════════════════════════════════════════════════
// COLUMN STATISTICAL PROFILE — Input to the constraint engine
// ═══════════════════════════════════════════════════════════════════

export interface ColumnStatProfile {
    name: string;
    etlType: ColumnType;
    totalRows: number;
    distinctCount: number;
    nullRate: number;          // 0–1
    range?: { min: number; max: number };
    isIntegerLike: boolean;    // all sampled values are whole numbers
    dateParseRate: number;     // 0–1: fraction of values parseable as dates
    /** Whether date values contain time components (HH:MM:SS) — avoids storing raw data */
    hasTimeComponent: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// CONSTRAINT GATE OUTPUT
// ═══════════════════════════════════════════════════════════════════

export interface ConstraintResult {
    /** Allowed semantic types AFTER hard physics gates */
    allowedTypes: SemanticType[];
    /** Deterministic confidence score (0–1) */
    detConf: number;
    /** Preliminary best guess from the deterministic engine */
    bestGuess: { semanticType: SemanticType; role: FieldRole };
    /** Human-readable reason for the classification */
    reason: string;
    /** Statistical signals used in the decision */
    signals: {
        rangeSpan?: number;
        uniqueValues: number;
        isInteger?: boolean;
        namePatternMatch?: string;
        uniqueRatio: number;
    };
}

// ═══════════════════════════════════════════════════════════════════
// NAME PATTERN DICTIONARIES — Replaces greedy regexes with scoped matching
// ═══════════════════════════════════════════════════════════════════

const CURRENCY_NAMES = /(?:^|[_\s])(sales|revenue|price|cost|total_amount|amount|profit|discount|shipping|tax|payment|spend|income|earning|fee|charge|balance|budget|salary|wage|pay|compensation|expense|bonus|commission|payout|premium|interest|deposit|refund|rent|royalty|stipend|funding|debt|credit|debit|turnover)(?:[_\s]|$)/i;
const PERCENTAGE_NAMES = /(?:^|[_\s])(rate|pct|percent|ratio|margin_pct|discount_pct|growth_pct|share|proportion)(?:[_\s]|$)/i;
const COUNT_NAMES = /(?:^|[_\s])(count|num|number_of|total_count|qty|quantity|units|items|orders|transactions)(?:[_\s]|$)/i;
const GEO_NAMES = /(?:^|[_\s])(region|state|city|country|zip|postal|address|geo|territory|area|location)(?:[_\s]|$)/i;
const ID_NAMES = /(?:^|[_\s])?(id|_id|key|code)$/i;

/** Ordinal / Likert / Rating patterns — CRITICAL for preventing ID misclassification */
const ORDINAL_NAMES = /(?:^|[_\s])(rating|score|satisfaction|performance|level|grade|rank|tier|priority|severity|quality|scale|stars?|likert|nps|engagement|experience|evaluation|assessment|competency|proficiency|aptitude|index|stage|phase)(?:[_\s]|$)/i;

/** Strong metric names that should NEVER be reclassified as ordinal/dimension */
const STRONG_METRIC_NAMES = /(?:^|[_\s])(sales|revenue|profit|cost|price|amount|total|income|salary|wage|pay|compensation|expense|fee|charge|payment|spend|earning|bonus|commission|balance|budget|discount|tax|shipping|freight|margin|debt|credit|debit|turnover|premium|interest|deposit|refund|rent|royalty|stipend|funding|payout)(?:[_\s]|$)/i;

// ═══════════════════════════════════════════════════════════════════
// HARD CONSTRAINT GATES — These are the physics of data classification
// ═══════════════════════════════════════════════════════════════════

const ALL_TYPES: SemanticType[] = [
    'currency', 'percentage', 'count', 'quantity', 'ratio',
    'date', 'geography', 'category', 'ordinal', 'identifier',
    'boolean', 'text', 'unknown',
];

/**
 * Run all hard constraint gates on a column profile.
 * Returns the filtered allowedTypes and deterministic confidence.
 *
 * HIERARCHY: Boolean > Date > Anti-ID > Ordinal Protection > Name Patterns
 */
export function runConstraintGates(profile: ColumnStatProfile): ConstraintResult {
    let allowedTypes = [...ALL_TYPES];
    const reasons: string[] = [];
    const name = profile.name.toLowerCase();
    const uniqueRatio = profile.totalRows > 0 ? profile.distinctCount / profile.totalRows : 0;
    const rangeSpan = profile.range ? profile.range.max - profile.range.min : undefined;

    // ── GATE 1: Boolean Lock ────────────────────────────────────
    // If exactly 2 unique values → force BOOLEAN
    if (profile.distinctCount === 2 && profile.totalRows > 10) {
        allowedTypes = ['boolean'];
        reasons.push('Exactly 2 unique values → forced BOOLEAN');
        return buildResult(profile, allowedTypes, 'boolean', 'dimension', 0.98, reasons, rangeSpan, uniqueRatio);
    }

    // ── GATE 2: Date Lock ───────────────────────────────────────
    // If >90% of values parse as dates → force DATE
    if (profile.dateParseRate > 0.9) {
        allowedTypes = ['date'];
        reasons.push(`${(profile.dateParseRate * 100).toFixed(0)}% date parse rate → forced DATE`);
        return buildResult(profile, allowedTypes, 'date', 'dimension', 0.97, reasons, rangeSpan, uniqueRatio);
    }

    // ETL type DATE also forces
    if (profile.etlType === ColumnType.DATE) {
        allowedTypes = ['date'];
        reasons.push('ETL classified as DATE');
        return buildResult(profile, allowedTypes, 'date', 'dimension', 0.95, reasons, rangeSpan, uniqueRatio);
    }

    // ── GATE 3: Anti-ID Gate ────────────────────────────────────
    // If distinct count < 50 → NEVER allow 'identifier'
    if (profile.distinctCount < 50) {
        allowedTypes = allowedTypes.filter(t => t !== 'identifier');
        reasons.push(`Only ${profile.distinctCount} unique values → ID disallowed`);
    }

    // ── GATE 4: Ordinal Protection ──────────────────────────────
    // Integer + low unique count + small range → lock to ordinal/category
    // NOTE: ETL often misclassifies Likert-scale integers (1-5) as ID.
    // We check BOTH ColumnType.METRIC and ColumnType.ID here because
    // the ETL's ID classification is frequently wrong for ordinal columns.
    const isNumericColumn = (
        profile.etlType === ColumnType.METRIC ||
        profile.etlType === ColumnType.ID
    );
    const isOrdinalCandidate = (
        profile.isIntegerLike &&
        profile.distinctCount <= 10 &&
        rangeSpan !== undefined && rangeSpan <= 10 &&
        isNumericColumn
    );

    if (isOrdinalCandidate) {
        // If name also matches ordinal patterns → very high confidence
        if (ORDINAL_NAMES.test(name)) {
            allowedTypes = allowedTypes.filter(t => t === 'ordinal' || t === 'category');
            reasons.push(`Integer range 0–${rangeSpan} + ordinal name pattern → locked to ORDINAL/CATEGORY`);
        } else if (!STRONG_METRIC_NAMES.test(name)) {
            // Still suspicious but name doesn't confirm — restrict but don't lock
            allowedTypes = allowedTypes.filter(t => t !== 'identifier' && t !== 'currency');
            reasons.push(`Integer range 0–${rangeSpan} with low cardinality → ID and currency disallowed`);
        }
    }

    // ── GATE 5: Ordinal-to-Metric Clamp ─────────────────────────
    // If ordinal conditions met, prevent METRIC classification unless very confident
    if (isOrdinalCandidate && ORDINAL_NAMES.test(name)) {
        allowedTypes = allowedTypes.filter(t => t !== 'quantity' && t !== 'count');
        reasons.push('Ordinal name confirmed → metric types (quantity/count) disallowed');
    }

    // Now compute the deterministic best guess + confidence
    return computeDeterministicGuess(profile, allowedTypes, reasons, rangeSpan, uniqueRatio, isOrdinalCandidate);
}

// ═══════════════════════════════════════════════════════════════════
// DETERMINISTIC CONFIDENCE SCORER — Weighted signal scoring
// ═══════════════════════════════════════════════════════════════════

function computeDeterministicGuess(
    profile: ColumnStatProfile,
    allowedTypes: SemanticType[],
    reasons: string[],
    rangeSpan: number | undefined,
    uniqueRatio: number,
    isOrdinalCandidate: boolean
): ConstraintResult {
    const name = profile.name.toLowerCase();

    // ── Score each candidate type ────────────────────────────────
    const scores: { type: SemanticType; role: FieldRole; score: number; reason: string }[] = [];

    // --- Ordinal ---
    if (allowedTypes.includes('ordinal') && isOrdinalCandidate) {
        let s = 0.5;
        if (ORDINAL_NAMES.test(name)) s += 0.4;
        if (profile.distinctCount <= 5) s += 0.05;
        if (profile.isIntegerLike) s += 0.05;
        scores.push({ type: 'ordinal', role: 'dimension', score: Math.min(1, s), reason: `Ordinal: integer range with ${profile.distinctCount} unique values` });
    }

    // --- Currency ---
    if (allowedTypes.includes('currency') && profile.etlType === ColumnType.METRIC && CURRENCY_NAMES.test(name)) {
        let s = 0.7;
        if (rangeSpan !== undefined && rangeSpan > 100) s += 0.15;
        if (uniqueRatio > 0.3) s += 0.1;
        scores.push({ type: 'currency', role: 'metric', score: Math.min(1, s), reason: `Currency name pattern: "${name}"` });
    }

    // --- Percentage ---
    if (allowedTypes.includes('percentage') && profile.etlType === ColumnType.METRIC && PERCENTAGE_NAMES.test(name)) {
        let s = 0.8;
        if (profile.range && profile.range.max <= 100) s += 0.1;
        scores.push({ type: 'percentage', role: 'metric', score: Math.min(1, s), reason: `Percentage name pattern: "${name}"` });
    }

    // --- Count/Quantity ---
    if (allowedTypes.includes('quantity') && profile.etlType === ColumnType.METRIC && COUNT_NAMES.test(name)) {
        let s = 0.7;
        if (profile.isIntegerLike) s += 0.15;
        scores.push({ type: 'quantity', role: 'metric', score: Math.min(1, s), reason: `Count/quantity name pattern: "${name}"` });
    }

    // --- Geography ---
    if (allowedTypes.includes('geography') && GEO_NAMES.test(name)) {
        let s = 0.75;
        if (profile.etlType === ColumnType.DIMENSION) s += 0.15;
        scores.push({ type: 'geography', role: 'dimension', score: Math.min(1, s), reason: `Geography name pattern: "${name}"` });
    }

    // --- Identifier ---
    if (allowedTypes.includes('identifier') && ID_NAMES.test(name) && uniqueRatio > 0.9) {
        let s = 0.6;
        if (uniqueRatio > 0.95) s += 0.2;
        if (profile.etlType === ColumnType.ID) s += 0.15;
        scores.push({ type: 'identifier', role: 'dimension', score: Math.min(1, s), reason: `ID pattern with ${(uniqueRatio * 100).toFixed(0)}% unique ratio` });
    }

    // --- Generic Metric (numeric, no strong name) ---
    if (allowedTypes.includes('quantity') && profile.etlType === ColumnType.METRIC && !ORDINAL_NAMES.test(name) && scores.length === 0) {
        let s = 0.4;
        if (STRONG_METRIC_NAMES.test(name)) s += 0.3;
        if (rangeSpan !== undefined && rangeSpan > 50) s += 0.1;
        if (uniqueRatio > 0.3) s += 0.1;
        scores.push({ type: 'quantity', role: 'metric', score: Math.min(1, s), reason: `Numeric column defaulting to quantity` });
    }

    // --- Category (text dimension) ---
    if (allowedTypes.includes('category') && (profile.etlType === ColumnType.DIMENSION || profile.etlType === ColumnType.BOOLEAN)) {
        let s = 0.6;
        if (profile.distinctCount < profile.totalRows * 0.5) s += 0.2;
        scores.push({ type: 'category', role: 'dimension', score: Math.min(1, s), reason: `Categorical dimension: ${profile.distinctCount} unique values` });
    }

    // --- Ordinal fallback for ETL-misclassified ID columns ---
    // If ETL says ID, but name matches ordinal patterns and stats are ordinal-like,
    // force an ordinal score even if isOrdinalCandidate wasn't set (wider rangeSpan tolerance)
    if (allowedTypes.includes('ordinal') && !isOrdinalCandidate && profile.etlType === ColumnType.ID && ORDINAL_NAMES.test(name)) {
        let s = 0.7;
        if (profile.isIntegerLike) s += 0.1;
        if (profile.distinctCount <= 10) s += 0.1;
        scores.push({ type: 'ordinal', role: 'dimension', score: Math.min(1, s), reason: `ETL-ID with ordinal name pattern: "${name}" — reclassified as ordinal dimension` });
    }

    // --- Category fallback for ID-typed columns with low cardinality ---
    // ETL ID columns that don't match ordinal patterns but have <50 unique values
    // are likely categories, not real identifiers (Anti-ID gate already removed 'identifier')
    if (allowedTypes.includes('category') && profile.etlType === ColumnType.ID && !ID_NAMES.test(name) && scores.length === 0) {
        let s = 0.5;
        if (profile.distinctCount < 20) s += 0.2;
        scores.push({ type: 'category', role: 'dimension', score: Math.min(1, s), reason: `ETL-ID reclassified as category dimension: ${profile.distinctCount} unique values` });
    }

    // --- Text (high cardinality string) ---
    if (allowedTypes.includes('text') && profile.etlType === ColumnType.DIMENSION && uniqueRatio > 0.5) {
        scores.push({ type: 'text', role: 'dimension', score: 0.4, reason: 'High cardinality text field' });
    }

    // ── Pick the winner ──────────────────────────────────────────
    if (scores.length === 0) {
        // Fallback: unknown
        reasons.push('No strong signals matched → UNKNOWN');
        return buildResult(profile, allowedTypes, 'unknown', 'dimension', 0.2, reasons, rangeSpan, uniqueRatio);
    }

    // Sort by score, highest first
    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];
    reasons.push(winner.reason);

    return buildResult(profile, allowedTypes, winner.type, winner.role, winner.score, reasons, rangeSpan, uniqueRatio);
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function buildResult(
    profile: ColumnStatProfile,
    allowedTypes: SemanticType[],
    semanticType: SemanticType,
    role: FieldRole,
    detConf: number,
    reasons: string[],
    rangeSpan: number | undefined,
    uniqueRatio: number,
): ConstraintResult {
    const nameMatch = [
        CURRENCY_NAMES.test(profile.name) ? 'currency' : null,
        PERCENTAGE_NAMES.test(profile.name) ? 'percentage' : null,
        COUNT_NAMES.test(profile.name) ? 'count' : null,
        GEO_NAMES.test(profile.name) ? 'geography' : null,
        ORDINAL_NAMES.test(profile.name) ? 'ordinal' : null,
        ID_NAMES.test(profile.name) ? 'identifier' : null,
    ].filter(Boolean).join(', ') || 'none';

    return {
        allowedTypes,
        detConf: Math.round(detConf * 100) / 100,
        bestGuess: { semanticType, role },
        reason: reasons.join(' | '),
        signals: {
            rangeSpan,
            uniqueValues: profile.distinctCount,
            isInteger: profile.isIntegerLike,
            namePatternMatch: nameMatch,
            uniqueRatio: Math.round(uniqueRatio * 1000) / 1000,
        },
    };
}
