import type { ResultProfile } from './types';

/**
 * Dimension-only answers (names, categories, dates, identifiers, or other
 * labels without a numeric measure) cannot be represented honestly on a
 * quantitative chart. Prefer the dedicated answer-list surface instead.
 *
 * The result profile is authoritative when available. The row inspection is a
 * defensive fallback for restored/cached results created before profiles were
 * persisted with AI SQL answers.
 */
export function isDimensionOnlyResult(
    profile: ResultProfile | null | undefined,
    rows: Record<string, unknown>[] | null | undefined,
): boolean {
    if (!rows?.length) return false;

    if (profile) {
        return profile.metricCount === 0 && profile.dimensionCount > 0;
    }

    const columns = Object.keys(rows[0] || {});
    if (columns.length === 0) return false;

    return columns.every(column => !rows.some(row => {
        const value = row[column];
        return typeof value === 'number' && Number.isFinite(value);
    }));
}
