/**
 * classificationFeedback.ts — User Override Feedback Cache
 *
 * Persists user corrections to localStorage with scoped keys.
 * Supports:
 *   - Frequency + recency weighted confidence
 *   - Seed patterns for cold start
 *   - Seed bias degradation when runtime disagrees
 *   - Physics ceiling on feedback (prevents bad overrides from propagating)
 *
 * PRIORITY: Hard Physics > User Feedback > Deterministic > AI
 */

import { SemanticType, FieldRole } from './types';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface FeedbackEntry {
    semanticType: SemanticType;
    role: FieldRole;
    /** Number of times this override has been submitted */
    frequency: number;
    /** Timestamp of the most recent override */
    lastUpdated: number;
    /** Whether this came from a seed pattern vs real user override */
    source: 'user' | 'seed';
}

export interface FeedbackLookupResult {
    entry: FeedbackEntry;
    /** Weighted confidence based on frequency, recency, and consistency */
    feedbackConf: number;
}

// ═══════════════════════════════════════════════════════════════════
// SEED PATTERNS — Known classifications for cold start
// ═══════════════════════════════════════════════════════════════════

const SEED_PATTERNS: { namePattern: RegExp; semanticType: SemanticType; role: FieldRole }[] = [
    // Ordinal / Likert scales
    { namePattern: /satisfaction/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /rating/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /score(?!_id)/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /nps/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /engagement(?:_(?:level|score|rating))?$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /performance(?:_(?:rating|score|level))?$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /experience(?:_(?:level|score|rating))?$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /priority/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /severity/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /quality(?:_(?:score|rating|level))?$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /grade/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /tier/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /stars?$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /level$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /work_life_balance/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /environment_satisfaction/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /job_involvement/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /relationship_satisfaction/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /education$/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /stock_option_level/i, semanticType: 'ordinal', role: 'dimension' },
    { namePattern: /job_level/i, semanticType: 'ordinal', role: 'dimension' },
];

const STORAGE_KEY = 'QuickInsight_classification_feedback';
const SEED_DISAGREEMENT_KEY = 'QuickInsight_seed_disagreements';
const MAX_ENTRIES = 500;

// Decay constants
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a scoped feedback key from column profile.
 * Bucketed to survive minor data changes.
 */
function buildFeedbackKey(
    columnName: string,
    domain: string,
    uniqueRatioBucket: string,
    rangeSpanBucket: string,
): string {
    return `${columnName.toLowerCase()}::${domain.toLowerCase()}::${uniqueRatioBucket}::${rangeSpanBucket}`;
}

/** Bucket a numeric value into a coarse range string */
function bucket(value: number, breakpoints: number[]): string {
    for (let i = 0; i < breakpoints.length; i++) {
        if (value <= breakpoints[i]) return `<=${breakpoints[i]}`;
    }
    return `>${breakpoints[breakpoints.length - 1]}`;
}

export function bucketUniqueRatio(ratio: number): string {
    return bucket(ratio, [0.01, 0.05, 0.1, 0.3, 0.5, 0.8, 0.95]);
}

export function bucketRangeSpan(span: number | undefined): string {
    if (span === undefined) return 'none';
    return bucket(span, [5, 10, 50, 200, 1000, 10000]);
}

/**
 * Look up feedback for a column.
 * First checks user overrides, then seed patterns.
 */
export function lookupFeedback(
    columnName: string,
    domain: string,
    uniqueRatio: number,
    rangeSpan: number | undefined,
): FeedbackLookupResult | null {
    const key = buildFeedbackKey(
        columnName,
        domain,
        bucketUniqueRatio(uniqueRatio),
        bucketRangeSpan(rangeSpan),
    );

    // 1. Check user overrides first
    const store = loadStore();
    const entry = store[key];
    if (entry) {
        const feedbackConf = computeFeedbackConfidence(entry);
        if (feedbackConf > 0.1) {
            return { entry, feedbackConf };
        }
    }

    // 2. Check seed patterns (with degradation)
    const seedDisagreements = loadSeedDisagreements();
    for (const seed of SEED_PATTERNS) {
        if (seed.namePattern.test(columnName)) {
            const disagreementCount = seedDisagreements[columnName.toLowerCase()] || 0;
            // Reduce seed confidence as disagreements accumulate
            const seedConf = Math.max(0.1, 0.7 - (disagreementCount * 0.15));
            return {
                entry: {
                    semanticType: seed.semanticType,
                    role: seed.role,
                    frequency: 1,
                    lastUpdated: Date.now(),
                    source: 'seed',
                },
                feedbackConf: seedConf,
            };
        }
    }

    return null;
}

/**
 * Store a user override.
 */
export function storeUserOverride(
    columnName: string,
    domain: string,
    uniqueRatio: number,
    rangeSpan: number | undefined,
    semanticType: SemanticType,
    role: FieldRole,
): void {
    const key = buildFeedbackKey(
        columnName,
        domain,
        bucketUniqueRatio(uniqueRatio),
        bucketRangeSpan(rangeSpan),
    );

    const store = loadStore();
    const existing = store[key];

    if (existing && existing.semanticType === semanticType && existing.role === role) {
        // Same override again — increase frequency
        existing.frequency++;
        existing.lastUpdated = Date.now();
    } else {
        // New or different override
        store[key] = {
            semanticType,
            role,
            frequency: 1,
            lastUpdated: Date.now(),
            source: 'user',
        };
    }

    // Cap entries
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
        // Remove oldest entries
        const sorted = keys.sort((a, b) => store[a].lastUpdated - store[b].lastUpdated);
        for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) {
            delete store[sorted[i]];
        }
    }

    saveStore(store);
    console.log(`[Feedback] Stored override: "${columnName}" → ${semanticType} (${role})`);
}

/**
 * Record that a seed pattern disagreed with runtime classification.
 * Used for seed bias degradation.
 */
export function recordSeedDisagreement(columnName: string): void {
    const disagreements = loadSeedDisagreements();
    const key = columnName.toLowerCase();
    disagreements[key] = (disagreements[key] || 0) + 1;
    try {
        localStorage.setItem(SEED_DISAGREEMENT_KEY, JSON.stringify(disagreements));
    } catch { /* storage full */ }
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════

function computeFeedbackConfidence(entry: FeedbackEntry): number {
    // Frequency weight: more overrides = higher confidence
    const frequencyScore = Math.min(1, entry.frequency / 5); // max out at 5 overrides

    // Recency weight: exponential decay
    const ageMs = Date.now() - entry.lastUpdated;
    const recencyScore = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

    // Source weight: user overrides are stronger than seeds
    const sourceWeight = entry.source === 'user' ? 1.0 : 0.6;

    return Math.min(0.95, frequencyScore * 0.5 + recencyScore * 0.3 + sourceWeight * 0.2);
}

function loadStore(): Record<string, FeedbackEntry> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function saveStore(store: Record<string, FeedbackEntry>): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch { /* storage full */ }
}

function loadSeedDisagreements(): Record<string, number> {
    try {
        const raw = localStorage.getItem(SEED_DISAGREEMENT_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}
