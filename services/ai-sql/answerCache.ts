/**
 * Verified answer reuse for AI SQL.
 * ─────────────────────────────────────────────────────────────────────
 * Asking the same question of the same dataset used to repeat the whole
 * planner → SQL → reviewer chain. This cache stores the FINAL read-only SQL
 * (and its Query Specification) after a run completed successfully, keyed by
 * a hash of everything the model would have been shown.
 *
 * Why this is safe:
 *  - The key covers the exact question wording (including the dataset
 *    reporting anchor and any UI filters), the full schema/metadata text,
 *    the deterministic contract and analytical evidence, the privacy mode
 *    and the engine configuration. If any of those differ, it is a miss.
 *    There is no word stripping or reordering, so "sales this month" and
 *    "sales month" can never share an answer.
 *  - A hit never reuses result rows. The pipeline still executes the SQL in
 *    local DuckDB against the current data and runs every validator.
 *  - An entry is consumed when read and written back only after the run
 *    succeeds again, so a reused query that stops working is not retried.
 *  - Benchmark runs and explicit refreshes bypass reads.
 *
 * Storage is this browser only (localStorage, bounded), never the server.
 * Entries hold SQL and the query specification — no dataset rows.
 */

export const ANSWER_CACHE_VERSION = 1;
const STORAGE_KEY = 'qi_ai_sql_answer_cache_v1';
const MAX_ENTRIES = 150;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedAnswer {
    sql: string;
    querySpec?: unknown;
    model?: string;
    createdAt: number;
}

type Store = Map<string, CachedAnswer>;
let memory: Store | null = null;

/** 53-bit string hash (cyrb53); collision risk is negligible at this scale. */
export function hashAnswerKey(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Build the cache key from every input that shapes the model's answer.
 * Parts are length-prefixed so adjacent values cannot run together.
 */
export function buildAnswerCacheKey(parts: Array<string | undefined>): string {
    const joined = [`v${ANSWER_CACHE_VERSION}`, ...parts.map(part => part ?? '')]
        .map(part => `${part.length}:${part}`)
        .join('|');
    return hashAnswerKey(joined);
}

function storage(): Storage | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
}

function load(): Store {
    if (memory) return memory;
    memory = new Map();
    const ls = storage();
    if (!ls) return memory;
    try {
        const raw = ls.getItem(STORAGE_KEY);
        const entries: Array<[string, CachedAnswer]> = raw ? JSON.parse(raw) : [];
        const now = Date.now();
        for (const [key, value] of entries) {
            if (value && typeof value.sql === 'string' && now - value.createdAt < TTL_MS) {
                memory.set(key, value);
            }
        }
    } catch {
        // A corrupt or blocked store simply starts empty.
    }
    return memory;
}

function persist(store: Store): void {
    const ls = storage();
    if (!ls) return;
    try {
        ls.setItem(STORAGE_KEY, JSON.stringify([...store.entries()]));
    } catch {
        // Quota or privacy-mode failures leave the in-memory cache working.
    }
}

/** Read and consume an entry. It is written back only if the run succeeds. */
export function takeCachedAnswer(key: string): CachedAnswer | null {
    const store = load();
    const entry = store.get(key);
    if (!entry) return null;
    store.delete(key);
    if (Date.now() - entry.createdAt >= TTL_MS) {
        persist(store);
        return null;
    }
    persist(store);
    return entry;
}

/** Store the final SQL of a successful run (most recent entries kept). */
export function rememberAnswer(key: string, answer: Omit<CachedAnswer, 'createdAt'>): void {
    if (!answer.sql) return;
    const store = load();
    store.delete(key);
    store.set(key, { ...answer, createdAt: Date.now() });
    while (store.size > MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
    }
    persist(store);
}

export function clearAnswerCache(): void {
    memory = new Map();
    const ls = storage();
    try {
        ls?.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

/** Test hook: drop the in-memory view so the next read reloads storage. */
export function resetAnswerCacheMemoryForTests(): void {
    memory = null;
}
