/**
 * Remembered column classifications — a self-improving map of corrections that
 * is SCOPED BY DATASET SIGNATURE. When a user corrects a column's classification
 * it is persisted under a fingerprint of that dataset's column-name set, and
 * auto-applied only to future uploads with the *same* schema. This makes the app
 * smarter about a given dataset over time without a correction to "region" in one
 * dataset silently rewriting a same-named column in an unrelated dataset.
 *
 * A synchronous in-memory cache (loaded once on login) lets the ETL apply
 * remembered corrections without an async hop at processing time.
 */

import { ColumnType } from '../types';

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';

/** signature → { columnNameLower → role }. Loaded on login; kept in sync on save. */
let cache: Record<string, Record<string, string>> = {};

function authHeaders(): Record<string, string> {
    const token = localStorage.getItem('qi_token') || '';
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * Stable, order-independent fingerprint of a dataset's column-name set. Same
 * columns (in any order, any case) → same signature; different schemas → different
 * signatures. A short base-36 hash, safe to use as a JSON key and validated
 * server-side against /^[a-z0-9]{1,64}$/.
 */
export function datasetSignature(columnNames: string[]): string {
    const canonical = columnNames
        .map(n => String(n).toLowerCase().trim())
        .filter(Boolean)
        .sort()
        .join('|');
    // FNV-1a 32-bit hash → base36. Deterministic and collision-resistant enough
    // for scoping (not security-sensitive).
    let h = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i++) {
        h ^= canonical.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Mix in length to further reduce collisions; keep it alnum-lowercase.
    return (h >>> 0).toString(36) + canonical.length.toString(36);
}

/** Fetch the signature-scoped corrections map and prime the cache. Fail-open. */
export async function fetchColumnCorrections(): Promise<Record<string, Record<string, string>>> {
    try {
        const res = await fetch(`${API_BASE}/settings/column-corrections`, { headers: authHeaders() });
        if (!res.ok) return cache;
        const data = await res.json();
        cache = data?.corrections && typeof data.corrections === 'object' ? data.corrections : {};
        return cache;
    } catch {
        return cache;
    }
}

/**
 * Persist corrections for a specific dataset signature and update the cache.
 * `corrections` is columnName → role for the dataset identified by `signature`.
 */
export async function saveColumnCorrections(signature: string, corrections: Record<string, ColumnType>): Promise<boolean> {
    const clean: Record<string, string> = {};
    for (const [name, role] of Object.entries(corrections)) {
        if (name && role) clean[name.toLowerCase().trim()] = role;
    }
    if (!signature || Object.keys(clean).length === 0) return false;
    // Optimistically update the cache so it applies immediately this session.
    cache = { ...cache, [signature]: { ...(cache[signature] || {}), ...clean } };
    try {
        const res = await fetch(`${API_BASE}/column-corrections`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ signature, corrections: clean }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Synchronous cache access (all signatures). */
export function getCachedCorrections(): Record<string, Record<string, string>> {
    return cache;
}

/**
 * Given a dataset's column names, return an ETL columnTypeOverrides map for any
 * columns that have a remembered classification FOR THAT DATASET'S SIGNATURE.
 * Case-insensitive on column name; isolated per schema.
 */
export function rememberedOverridesFor(columnNames: string[]): Record<string, ColumnType> {
    const out: Record<string, ColumnType> = {};
    const bucket = cache[datasetSignature(columnNames)];
    if (!bucket) return out;
    for (const name of columnNames) {
        const role = bucket[name.toLowerCase().trim()];
        if (role) out[name] = role as ColumnType;
    }
    return out;
}
