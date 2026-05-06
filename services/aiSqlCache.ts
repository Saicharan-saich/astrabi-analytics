/**
 * AI SQL Query Cache — IndexedDB-backed cache for AI-generated SQL queries.
 *
 * Caches the result of runAISQLPipeline() so that repeated or similar
 * questions skip the Gemini API call entirely, providing instant results
 * and saving API token costs.
 *
 * Cache key = normalised question hash + dataset schema hash.
 * If the dataset schema changes (new/removed columns), the cache auto-invalidates.
 *
 * Storage: IndexedDB (local, private). Cloud-ready — swap to backend API later.
 */

import type { AISQLPipelineResult, AnalysisPlan, ChartRecommendation, ConfidenceScore, ResultProfile, ValidationResult } from './ai-sql/types';
import type { Dataset } from '../types';

// ─── Types ───────────────────────────────────────────────────────

export interface CacheEntry {
    /** Normalised question (lowercase, filler words stripped) */
    normalizedQuestion: string;
    /** Original user question */
    originalQuestion: string;
    /** Hash of dataset column names — invalidates if schema changes */
    schemaHash: string;
    /** The cached pipeline result (without rawData to save space) */
    sql: string;
    plan: AnalysisPlan;
    chartType: string;
    chart: ChartRecommendation;
    explanation: string;
    columnsUsed: string[];
    confidence: ConfidenceScore;
    profile: ResultProfile;
    validation: ValidationResult;
    /** Timestamps */
    createdAt: number;
    lastUsedAt: number;
    hitCount: number;
}

// ─── Constants ───────────────────────────────────────────────────

const DB_NAME = 'QuickInsight-ai-cache';
const DB_VERSION = 1;
const STORE_NAME = 'queries';
const MAX_ENTRIES = 500;
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Filler words to strip during normalisation
const FILLER_WORDS = new Set([
    'show', 'me', 'the', 'please', 'can', 'you', 'what', 'is', 'are',
    'give', 'get', 'find', 'display', 'list', 'tell', 'i', 'want',
    'need', 'would', 'like', 'to', 'see', 'a', 'an', 'of', 'for',
    'from', 'in', 'on', 'with', 'and', 'or', 'do', 'does', 'how',
    'much', 'many', 'all', 'my', 'our', 'their', 'this', 'that',
]);

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Normalise a question: lowercase, strip filler words, sort remaining tokens.
 * "Show me total revenue by region" → "by region revenue total"
 */
export function normalizeQuestion(question: string): string {
    const tokens = question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // strip punctuation
        .split(/\s+/)
        .filter(t => t.length > 0 && !FILLER_WORDS.has(t));
    return tokens.sort().join(' ');
}

/**
 * Compute a schema hash from dataset column names.
 * Changes if columns are added/removed/renamed.
 */
export function computeSchemaHash(dataset: Dataset): string {
    const names = (dataset.columns || []).map(c => c.name).sort();
    // Simple hash: join and create a short digest
    let hash = 0;
    const str = names.join('|');
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return `schema_${Math.abs(hash).toString(36)}`;
}

/**
 * Build the cache key from normalised question + schema hash.
 */
function buildCacheKey(normalizedQ: string, schemaHash: string, grain?: string): string {
    const grainSuffix = grain ? `::grain_${grain}` : '';
    return `${schemaHash}::${normalizedQ}${grainSuffix}`;
}

// ─── IndexedDB Helpers ──────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                store.createIndex('lastUsedAt', 'lastUsedAt');
                store.createIndex('createdAt', 'createdAt');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Look up a cached AI SQL result.
 * Returns the CacheEntry if found and not expired, or null.
 */
export async function getCachedResult(
    question: string,
    dataset: Dataset,
    grain?: string
): Promise<CacheEntry | null> {
    try {
        const db = await openDB();
        const norm = normalizeQuestion(question);
        const hash = computeSchemaHash(dataset);
        const key = buildCacheKey(norm, hash, grain);

        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(key);

            req.onsuccess = () => {
                const entry = req.result;
                if (!entry) return resolve(null);

                // Check TTL
                if (Date.now() - entry.createdAt > TTL_MS) {
                    store.delete(key); // expired
                    return resolve(null);
                }

                // Update hit count and lastUsedAt
                entry.hitCount += 1;
                entry.lastUsedAt = Date.now();
                store.put(entry);

                resolve(entry as CacheEntry);
            };
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

/**
 * Store a successful AI SQL pipeline result in the cache.
 */
export async function setCachedResult(
    question: string,
    dataset: Dataset,
    result: AISQLPipelineResult,
    grain?: string
): Promise<void> {
    try {
        const db = await openDB();
        const norm = normalizeQuestion(question);
        const hash = computeSchemaHash(dataset);
        const key = buildCacheKey(norm, hash, grain);

        const entry = {
            key,
            normalizedQuestion: norm,
            originalQuestion: question,
            schemaHash: hash,
            sql: result.sql,
            plan: result.plan,
            chartType: result.chart.chartType,
            chart: result.chart,
            explanation: result.explanation,
            columnsUsed: result.columnsUsed,
            confidence: result.confidence,
            profile: result.profile,
            validation: result.validation,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            hitCount: 0,
        };

        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(entry);
            tx.oncomplete = () => resolve();
        });

        // Evict old entries if over limit
        await evictOldEntries(db);
    } catch (err) {
        console.warn('[AI Cache] Failed to store result:', err);
    }
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(): Promise<{
    entries: number;
    totalHits: number;
    oldestEntry: number | null;
}> {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const countReq = store.count();
            const allReq = store.getAll();

            tx.oncomplete = () => {
                const entries = countReq.result;
                const all = allReq.result || [];
                const totalHits = all.reduce((sum: number, e: any) => sum + (e.hitCount || 0), 0);
                const oldestEntry = all.length > 0 ? Math.min(...all.map((e: any) => e.createdAt)) : null;
                resolve({ entries, totalHits, oldestEntry });
            };
        });
    } catch {
        return { entries: 0, totalHits: 0, oldestEntry: null };
    }
}

/**
 * Clear the entire cache.
 */
export async function clearAISQLCache(): Promise<void> {
    try {
        const db = await openDB();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve();
        });
    } catch (err) {
        console.warn('[AI Cache] Failed to clear cache:', err);
    }
}

/**
 * Evict the oldest entries when the cache exceeds MAX_ENTRIES.
 */
async function evictOldEntries(db: IDBDatabase): Promise<void> {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const countReq = store.count();

        countReq.onsuccess = () => {
            const count = countReq.result;
            if (count <= MAX_ENTRIES) return resolve();

            // Delete oldest entries
            const toDelete = count - MAX_ENTRIES;
            const index = store.index('lastUsedAt');
            const cursor = index.openCursor();
            let deleted = 0;

            cursor.onsuccess = () => {
                const c = cursor.result;
                if (c && deleted < toDelete) {
                    store.delete(c.primaryKey);
                    deleted++;
                    c.continue();
                } else {
                    resolve();
                }
            };
        };
        tx.oncomplete = () => resolve();
    });
}
