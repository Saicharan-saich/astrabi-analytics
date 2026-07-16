/**
 * Numeric output safety
 * ──────────────────────
 * A defensive net guaranteeing that NaN, Infinity, and -Infinity can never
 * reach the UI, tooltips, tables, exports, or downstream calculations — no
 * matter which engine produced the value or how future edits change the math.
 *
 * The individual engines already guard their divisions (NULLIF / CASE WHEN /
 * isFinite), so this is belt-and-suspenders applied at output boundaries:
 * the DuckDB result reader (SQL data source) and the chart render step.
 */

/** A finite number, else null. Non-number values pass through untouched. */
export function finiteOrNull(v: any): any {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    return v;
}

/**
 * Round to a fixed number of decimals, stripping binary-float precision noise
 * (33.33333333333336 → 33.33). Non-finite input is returned unchanged so it
 * can be caught by finiteOrNull instead.
 */
export function roundTo(n: number, decimals = 2): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) return n;
    const f = Math.pow(10, decimals);
    return Math.round((n + Number.EPSILON) * f) / f;
}

/** Convenience: round a value to 2 decimals (the common percentage/ratio case). */
export const round2 = (n: number): number => roundTo(n, 2);

/** Sanitize every numeric field of a single row: non-finite → null. */
export function sanitizeRow<T extends Record<string, any>>(row: T): T {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const out: any = {};
    for (const k in row) out[k] = finiteOrNull(row[k]);
    return out;
}

/**
 * Sanitize an array of result rows. Object rows have their numeric fields
 * cleaned; primitive numbers are cleaned directly. Returns the input
 * unchanged if it is not an array.
 */
export function sanitizeRows<T = any>(rows: T[]): T[] {
    if (!Array.isArray(rows)) return rows;
    return rows.map(r => (r && typeof r === 'object' && !Array.isArray(r))
        ? (sanitizeRow(r as any) as any)
        : finiteOrNull(r));
}
