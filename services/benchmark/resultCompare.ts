/**
 * Execution / denotation accuracy comparison for the text-to-SQL benchmark.
 * ─────────────────────────────────────────────────────────────────────────
 * Spider scores "execution accuracy": run the predicted SQL and the gold SQL,
 * then compare the RESULT SETS — not the SQL strings. We do the same, but with
 * one relaxation that fits a system whose column *names* differ from the gold's
 * (the pipeline aliases metrics like `age_avg`): we compare the multiset of
 * row *values*, treating the values within a row as an unordered tuple so that
 * column ordering/naming differences don't cause false misses.
 *
 * Row order only matters when the gold query has an ORDER BY (orderMatters);
 * otherwise results are compared as a multiset, exactly like Spider.
 *
 * This module is pure (no DuckDB, no DOM) so it is unit-testable in Node.
 */

/** Pipeline-added analytical columns that are NOT part of the answer. */
const HELPER_KEYS = new Set([
    'growth_pct', 'growth_abs', 'previous_value', 'running_total', 'moving_avg',
    'day_name', 'period', '__index__',
]);

export interface CompareOptions {
    orderMatters?: boolean;
    /** Floating tolerance for numeric equality (default 1e-4 relative/absolute). */
    tolerance?: number;
}

export interface CompareResult {
    match: boolean;
    reason: string;
    expectedRows: number;
    actualRows: number;
}

function isBlank(v: any): boolean {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Canonicalise a single cell to a comparable token. */
export function normalizeCell(v: any, tolerance = 1e-4): string {
    if (isBlank(v)) return '∅';
    if (typeof v === 'bigint') v = Number(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    // Numeric (including numeric strings like "62000" or "$1,200")
    const asNum = typeof v === 'number' ? v : Number(String(v).replace(/[$,]/g, ''));
    if (typeof v !== 'object' && !Number.isNaN(asNum) && String(v).trim() !== '') {
        // Round to the tolerance grid so 4.0000001 === 4.
        const digits = Math.max(0, Math.round(-Math.log10(tolerance)));
        const rounded = Number(asNum.toFixed(digits));
        // Normalise -0 and integer-valued floats ("4" === "4.0").
        return String(rounded === 0 ? 0 : rounded);
    }
    return String(v).trim().toLowerCase();
}

/** Keys of a row excluding pipeline helper columns. */
function answerKeys(row: Record<string, any>): string[] {
    return Object.keys(row).filter(k => !HELPER_KEYS.has(k.toLowerCase()));
}

/** A row → sorted multiset of its normalized values (column-order agnostic). */
function rowSignature(row: Record<string, any>, tolerance: number): string {
    return answerKeys(row)
        .map(k => normalizeCell(row[k], tolerance))
        .sort()
        .join('§');
}

/** Flatten every non-helper value in a result into one normalized multiset. */
function valueBag(rows: Record<string, any>[], tolerance: number): Map<string, number> {
    const bag = new Map<string, number>();
    for (const row of rows) {
        for (const k of answerKeys(row)) {
            const tok = normalizeCell(row[k], tolerance);
            bag.set(tok, (bag.get(tok) || 0) + 1);
        }
    }
    return bag;
}

function bagsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
}

function multisetEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const count = new Map<string, number>();
    for (const x of a) count.set(x, (count.get(x) || 0) + 1);
    for (const y of b) {
        const c = count.get(y);
        if (!c) return false;
        count.set(y, c - 1);
    }
    return true;
}

/**
 * Compare a predicted result set against the gold result set.
 * Returns match + a human-readable reason.
 */
export function compareResults(
    expected: Record<string, any>[],
    actual: Record<string, any>[],
    opts: CompareOptions = {},
): CompareResult {
    const tol = opts.tolerance ?? 1e-4;
    const base = { expectedRows: expected.length, actualRows: actual.length };

    // Empty gold: match iff actual is also empty.
    if (expected.length === 0) {
        return actual.length === 0
            ? { match: true, reason: 'Both result sets are empty', ...base }
            : { match: false, reason: `Gold is empty but system returned ${actual.length} row(s)`, ...base };
    }

    // Scalar gold (1×1) — the most common analytical answer. Match if that single
    // value appears among the system's first-row values (the pipeline may attach
    // an extra label column to a KPI).
    const goldIsScalar = expected.length === 1 && answerKeys(expected[0]).length === 1;
    if (goldIsScalar) {
        const target = normalizeCell(expected[0][answerKeys(expected[0])[0]], tol);
        const hit = actual.some(r => answerKeys(r).some(k => normalizeCell(r[k], tol) === target));
        return hit
            ? { match: true, reason: `Scalar answer ${target} found`, ...base }
            : { match: false, reason: `Scalar answer ${target} not found in system output`, ...base };
    }

    const expSigs = expected.map(r => rowSignature(r, tol));
    const actSigs = actual.map(r => rowSignature(r, tol));

    if (opts.orderMatters) {
        const ordered = expSigs.length === actSigs.length && expSigs.every((s, i) => s === actSigs[i]);
        if (ordered) return { match: true, reason: 'Ordered rows match', ...base };
        // Fall through: an unordered value match still means the *content* is right
        // even if the system didn't honor ORDER BY — report it as a soft miss.
        if (multisetEqual(expSigs, actSigs)) {
            return { match: false, reason: 'Right rows but wrong order (ORDER BY not honored)', ...base };
        }
    } else if (multisetEqual(expSigs, actSigs)) {
        return { match: true, reason: 'Row multiset matches', ...base };
    }

    // Last-resort denotation check: same bag of values overall (handles the
    // pipeline returning the same numbers reshaped into a different row/col grid).
    if (bagsEqual(valueBag(expected, tol), valueBag(actual, tol))) {
        return { match: true, reason: 'Value multiset matches (reshaped)', ...base };
    }

    return {
        match: false,
        reason: `Result mismatch (gold ${expected.length} row(s), system ${actual.length} row(s))`,
        ...base,
    };
}
