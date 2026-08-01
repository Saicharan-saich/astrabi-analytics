/**
 * Per-column and per-value sharing choices.
 * ─────────────────────────────────────────────────────────────────────
 * The automatic filter decides what is *eligible* to be shared. This module
 * records what the USER has additionally chosen to hold back — a whole column,
 * or individual values inside a column.
 *
 * The rule is one-directional: a user choice can only ever REMOVE something
 * from what gets sent. It can never add a column the automatic filter rejected.
 * `applySelection` is the single place that enforces this.
 */

export interface PrivacySelection {
    /** Columns the user has switched off entirely. */
    excludedColumns: string[];
    /** Individual values the user has switched off, per column. */
    excludedValues: Record<string, string[]>;
}

export const EMPTY_SELECTION: PrivacySelection = { excludedColumns: [], excludedValues: {} };

const KEY_PREFIX = 'qi_ai_privacy_selection:';

/** Choices are per dataset — a different file has different columns. */
function storageKey(datasetKey: string): string {
    return KEY_PREFIX + datasetKey;
}

export function getSelection(datasetKey: string): PrivacySelection {
    try {
        const raw = localStorage.getItem(storageKey(datasetKey));
        if (!raw) return EMPTY_SELECTION;
        const parsed = JSON.parse(raw);
        return {
            excludedColumns: Array.isArray(parsed?.excludedColumns) ? parsed.excludedColumns.map(String) : [],
            excludedValues: parsed?.excludedValues && typeof parsed.excludedValues === 'object'
                ? Object.fromEntries(
                    Object.entries(parsed.excludedValues)
                        .filter(([, v]) => Array.isArray(v))
                        .map(([k, v]) => [k, (v as unknown[]).map(String)]))
                : {},
        };
    } catch {
        return EMPTY_SELECTION;
    }
}

export function setSelection(datasetKey: string, selection: PrivacySelection): void {
    try {
        localStorage.setItem(storageKey(datasetKey), JSON.stringify(selection));
    } catch {
        /* ignore — nothing stored means nothing extra is withheld */
    }
}

export function clearSelection(datasetKey: string): void {
    try {
        localStorage.removeItem(storageKey(datasetKey));
    } catch {
        /* ignore */
    }
}

export type Domains = Map<string, { values: string[]; total: number }>;

/**
 * Remove everything the user switched off. Columns left with no values are
 * dropped entirely rather than sent empty.
 *
 * This only ever subtracts: a column absent from `domains` stays absent, so a
 * stale or hand-edited selection cannot cause anything extra to be sent.
 */
export function applySelection(domains: Domains, selection: PrivacySelection): Domains {
    const excludedColumns = new Set(selection.excludedColumns);
    const out: Domains = new Map();

    for (const [column, domain] of domains) {
        if (excludedColumns.has(column)) continue;

        const excludedValues = new Set(selection.excludedValues[column] ?? []);
        const values = excludedValues.size
            ? domain.values.filter(v => !excludedValues.has(v))
            : domain.values;

        if (values.length === 0) continue;
        out.set(column, { values, total: domain.total });
    }

    return out;
}

/** How many individual values a selection would actually send. */
export function countSharedValues(domains: Domains, selection: PrivacySelection): number {
    let n = 0;
    for (const domain of applySelection(domains, selection).values()) n += domain.values.length;
    return n;
}

export function isColumnExcluded(selection: PrivacySelection, column: string): boolean {
    return selection.excludedColumns.includes(column);
}

export function isValueExcluded(selection: PrivacySelection, column: string, value: string): boolean {
    return (selection.excludedValues[column] ?? []).includes(value);
}

export function toggleColumn(selection: PrivacySelection, column: string): PrivacySelection {
    const excluded = new Set(selection.excludedColumns);
    if (excluded.has(column)) excluded.delete(column); else excluded.add(column);
    return { ...selection, excludedColumns: [...excluded] };
}

export function toggleValue(selection: PrivacySelection, column: string, value: string): PrivacySelection {
    const current = new Set(selection.excludedValues[column] ?? []);
    if (current.has(value)) current.delete(value); else current.add(value);
    const next = { ...selection.excludedValues };
    if (current.size) next[column] = [...current]; else delete next[column];
    return { ...selection, excludedValues: next };
}

/** Switch every eligible column off — "send nothing". */
export function excludeAll(columns: string[]): PrivacySelection {
    return { excludedColumns: [...columns], excludedValues: {} };
}
