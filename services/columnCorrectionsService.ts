/**
 * Remembered column classifications — a shared, self-improving map of
 * columnName → role. When a user corrects a column's classification it is
 * persisted here and auto-applied to future uploads containing a column with
 * the same name, so the app gets smarter about a given schema over time.
 *
 * A synchronous in-memory cache (loaded once on login) lets the ETL apply
 * remembered corrections without an async hop at processing time.
 */

import { ColumnType } from '../types';

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';

/** name(lowercased) → role. Loaded on login; kept in sync on save. */
let cache: Record<string, string> = {};

function authHeaders(): Record<string, string> {
    const token = localStorage.getItem('qi_token') || '';
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Fetch the global corrections map and prime the cache. Fail-open. */
export async function fetchColumnCorrections(): Promise<Record<string, string>> {
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

/** Persist corrections (columnName → role) and update the cache. */
export async function saveColumnCorrections(corrections: Record<string, ColumnType>): Promise<boolean> {
    const clean: Record<string, string> = {};
    for (const [name, role] of Object.entries(corrections)) {
        if (name && role) clean[name.toLowerCase().trim()] = role;
    }
    if (Object.keys(clean).length === 0) return false;
    // Optimistically update the cache so it applies immediately this session.
    cache = { ...cache, ...clean };
    try {
        const res = await fetch(`${API_BASE}/column-corrections`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ corrections: clean }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Synchronous cache access. */
export function getCachedCorrections(): Record<string, string> {
    return cache;
}

/**
 * Given a set of column names, return an ETL columnTypeOverrides map for any
 * that have a remembered classification. Case-insensitive on column name.
 */
export function rememberedOverridesFor(columnNames: string[]): Record<string, ColumnType> {
    const out: Record<string, ColumnType> = {};
    for (const name of columnNames) {
        const role = cache[name.toLowerCase().trim()];
        if (role) out[name] = role as ColumnType;
    }
    return out;
}
