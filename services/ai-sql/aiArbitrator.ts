/**
 * aiArbitrator.ts — AI Cross-Verification Layer
 *
 * Sends a batched, privacy-safe payload to the LLM for semantic classification
 * cross-verification. Called ONCE per dataset (not per column).
 *
 * KEY DESIGN:
 *   - Uses DERIVED confidence (never trusts raw AI scores)
 *   - Caches results with versioned, normalized hashing
 *   - Domain alignment uses similarity scoring (not binary)
 *   - Strict JSON schema validation on output
 *
 * NEVER receives raw data — only statistical profiles.
 */

import { SemanticType, FieldRole } from './types';
import { ConstraintResult } from './constraintGates';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface AIClassificationRequest {
    columnName: string;
    constraintResult: ConstraintResult;
}

export interface AIClassificationResult {
    columnName: string;
    aiSuggestedType: SemanticType;
    aiSuggestedRole: FieldRole;
    derivedAiConf: number;
    aiReason: string;
}

// Versioning for cache busting on prompt/scoring changes
const PROMPT_VERSION = 1;
const SCORING_VERSION = 1;

// ═══════════════════════════════════════════════════════════════════
// DOMAIN SIMILARITY — Granular domain alignment scoring
// ═══════════════════════════════════════════════════════════════════

const DOMAIN_SIMILARITY: Record<string, Record<string, number>> = {
    'HR': { 'HR': 1.0, 'Operations': 0.6, 'Education': 0.5, 'Finance': 0.3, 'Sales': 0.2 },
    'Sales': { 'Sales': 1.0, 'Retail': 0.9, 'Marketing': 0.7, 'Finance': 0.5, 'Inventory': 0.6 },
    'Finance': { 'Finance': 1.0, 'Sales': 0.5, 'Insurance': 0.6, 'Real_Estate': 0.4 },
    'Healthcare': { 'Healthcare': 1.0, 'Insurance': 0.5, 'HR': 0.3 },
    'Marketing': { 'Marketing': 1.0, 'Sales': 0.7, 'SaaS': 0.6, 'Retail': 0.5 },
    'Retail': { 'Retail': 1.0, 'Sales': 0.9, 'Inventory': 0.7, 'Marketing': 0.5 },
};

function domainSimilarity(systemDomain: string, aiDomain: string): number {
    if (systemDomain === aiDomain) return 1.0;
    const sameGroup = DOMAIN_SIMILARITY[systemDomain];
    if (sameGroup && sameGroup[aiDomain] !== undefined) return sameGroup[aiDomain];
    // Unknown pair — moderate penalty
    return 0.4;
}

// ═══════════════════════════════════════════════════════════════════
// CACHE — Versioned, bucketed hash for stability
// ═══════════════════════════════════════════════════════════════════

const CACHE_KEY = 'QuickInsight_ai_arbitration_cache';
const MAX_CACHE_ENTRIES = 50;

interface CacheEntry {
    results: AIClassificationResult[];
    timestamp: number;
}

function buildCacheHash(
    columns: AIClassificationRequest[],
    domain: string,
): string {
    // Bucketed column signatures for cache stability
    const sig = columns.map(c => {
        const s = c.constraintResult.signals;
        return `${c.columnName}|${s.uniqueValues}|${s.rangeSpan ?? 'n'}|${s.isInteger ?? 'n'}|${s.uniqueRatio}`;
    }).join(';;');
    return `v${PROMPT_VERSION}.${SCORING_VERSION}::${domain}::${sig}`;
}

function getCachedClassification(hash: string): AIClassificationResult[] | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cache: Record<string, CacheEntry> = JSON.parse(raw);
        const entry = cache[hash];
        if (entry) return entry.results;
    } catch { /* corrupt storage */ }
    return null;
}

function setCachedClassification(hash: string, results: AIClassificationResult[]): void {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        const cache: Record<string, CacheEntry> = raw ? JSON.parse(raw) : {};
        cache[hash] = { results, timestamp: Date.now() };

        // Cap cache size
        const keys = Object.keys(cache);
        if (keys.length > MAX_CACHE_ENTRIES) {
            const sorted = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
            for (let i = 0; i < sorted.length - MAX_CACHE_ENTRIES; i++) {
                delete cache[sorted[i]];
            }
        }

        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* storage full */ }
}

// ═══════════════════════════════════════════════════════════════════
// LLM CALL — Batched, single request per dataset
// ═══════════════════════════════════════════════════════════════════

const API_ENDPOINT = `${import.meta.env.VITE_API_URL || 'http://localhost:5002/api'}/ai/classify-columns`;

function buildClassificationPrompt(
    columns: AIClassificationRequest[],
    datasetName: string,
    domain: string,
    domainConfidence: number,
): string {
    const domainHint = domainConfidence > 0.6
        ? `This dataset belongs to the "${domain}" domain.`
        : `This dataset MIGHT belong to "${domain}", but derive the true domain from the column names.`;

    const columnDescriptions = columns.map(c => {
        const s = c.constraintResult.signals;
        return [
            `  "${c.columnName}":`,
            `    unique_values: ${s.uniqueValues}`,
            `    range: ${s.rangeSpan !== undefined ? `span=${s.rangeSpan}` : 'N/A'}`,
            `    integer: ${s.isInteger ?? 'unknown'}`,
            `    unique_ratio: ${s.uniqueRatio}`,
            `    engine_guess: ${c.constraintResult.bestGuess.semanticType} (${c.constraintResult.bestGuess.role})`,
            `    allowed_types: [${c.constraintResult.allowedTypes.join(', ')}]`,
        ].join('\n');
    }).join('\n\n');

    return `You are a Data Architect classifying columns for the dataset "${datasetName}".
${domainHint}

For each column below, determine the correct semantic_type and role (metric or dimension).
CRITICAL: You MUST choose semantic_type from the column's allowed_types list. Any type NOT in allowed_types will be rejected.

Statistical Profiles:
${columnDescriptions}

RESPOND WITH ONLY VALID JSON (no markdown fences):
{
  "detected_domain": "string",
  "columns": {
    "column_name": {
      "semantic_type": "one of allowed_types",
      "role": "metric or dimension",
      "reason": "1-sentence explanation"
    }
  }
}`;
}

/**
 * Run AI cross-verification for a batch of columns.
 * Returns null if AI is unavailable — the system falls back to deterministic.
 */
export async function runAIArbitration(
    columns: AIClassificationRequest[],
    datasetName: string,
    domain: string,
    domainConfidence: number,
): Promise<AIClassificationResult[] | null> {
    if (columns.length === 0) return [];

    // 1. Check cache
    const cacheHash = buildCacheHash(columns, domain);
    const cached = getCachedClassification(cacheHash);
    if (cached) {
        console.log(`[AI Arbitrator] ⚡ Cache hit — ${cached.length} columns from cache`);
        return cached;
    }

    // 2. Build prompt and call LLM
    const prompt = buildClassificationPrompt(columns, datasetName, domain, domainConfidence);

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[AI Arbitrator] API returned ${response.status} — using deterministic only`);
            return null;
        }

        const raw = await response.json();
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

        if (!parsed || !parsed.columns) {
            console.warn('[AI Arbitrator] Invalid response structure');
            return null;
        }

        // 3. Derive validated AI confidence (NEVER trust raw scores)
        const aiDomain = parsed.detected_domain || domain;
        const domainAlign = domainSimilarity(domain, aiDomain);

        const results: AIClassificationResult[] = [];

        for (const col of columns) {
            const aiCol = parsed.columns[col.columnName];
            if (!aiCol) {
                results.push({
                    columnName: col.columnName,
                    aiSuggestedType: col.constraintResult.bestGuess.semanticType,
                    aiSuggestedRole: col.constraintResult.bestGuess.role,
                    derivedAiConf: 0,
                    aiReason: 'AI did not classify this column',
                });
                continue;
            }

            // Schema validity: did AI return a valid type?
            const schemaValidity = (['currency', 'percentage', 'count', 'quantity', 'ratio', 'date',
                'geography', 'category', 'ordinal', 'identifier', 'boolean', 'text'] as SemanticType[])
                .includes(aiCol.semantic_type as SemanticType) ? 1.0 : 0.0;

            // Constraint alignment: is AI's type in the allowed list?
            const constraintAlignment = col.constraintResult.allowedTypes.includes(aiCol.semantic_type as SemanticType)
                ? 1.0 : 0.0;

            // Statistical alignment: does AI's reasoning match the data shape?
            let statisticalAlignment = 0.7; // Default moderate
            const signals = col.constraintResult.signals;
            if (aiCol.semantic_type === 'identifier' && signals.uniqueValues < 50) {
                statisticalAlignment = 0.0; // Anti-ID physics violation
            }
            if (aiCol.semantic_type === 'ordinal' && signals.isInteger && (signals.rangeSpan ?? 100) <= 10) {
                statisticalAlignment = 1.0; // Stats support ordinal
            }
            if (aiCol.role === 'metric' && signals.uniqueRatio < 0.05) {
                statisticalAlignment *= 0.5; // Very low cardinality metric is suspicious
            }

            // Final derived confidence — geometric-like minimum ensures all checks pass
            const derivedAiConf = Math.round(
                Math.min(schemaValidity, constraintAlignment, statisticalAlignment) * domainAlign * 100
            ) / 100;

            results.push({
                columnName: col.columnName,
                aiSuggestedType: constraintAlignment > 0 ? aiCol.semantic_type as SemanticType : col.constraintResult.bestGuess.semanticType,
                aiSuggestedRole: (aiCol.role === 'metric' || aiCol.role === 'dimension') ? aiCol.role : col.constraintResult.bestGuess.role,
                derivedAiConf,
                aiReason: aiCol.reason || '',
            });
        }

        // 4. Cache results
        setCachedClassification(cacheHash, results);
        console.log(`[AI Arbitrator] ✅ Classified ${results.length} columns (domain alignment: ${domainAlign})`);

        return results;

    } catch (err: any) {
        if (err.name === 'AbortError') {
            console.warn('[AI Arbitrator] LLM call timed out — using deterministic only');
        } else {
            console.warn('[AI Arbitrator] LLM unavailable — using deterministic only');
        }
        return null;
    }
}
