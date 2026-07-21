/**
 * Shared SQL primitives — the single source of truth for the low-level SQL both
 * deterministic engines emit (the QueryPlan compiler and the AI SQL correction
 * engine). Centralising these prevents the "fixed in one engine but not the
 * other" class of bug — e.g. the VARCHAR-date BETWEEN crash that lived in the
 * correction engine's date predicate but not the compiler's.
 */

/** Escape single quotes for a SQL string literal. */
export function escapeSqlString(v: string): string {
    return String(v).replace(/'/g, "''");
}

/**
 * Inclusive, day-granularity date-range predicate. Casts the column to DATE so a
 * text-loaded date column (the common CSV case) compares cleanly against DATE
 * literals, and the end day is fully included.
 *
 * @param quotedCol an already-quoted identifier, e.g. `"order_date"`
 */
export function dateRangePredicate(quotedCol: string, start?: string, end?: string): string {
    const lit = (s: string) => `DATE '${escapeSqlString(s)}'`;
    const col = `CAST(${quotedCol} AS DATE)`;
    if (start && end) return `${col} BETWEEN ${lit(start)} AND ${lit(end)}`;
    if (start) return `${col} >= ${lit(start)}`;
    if (end) return `${col} <= ${lit(end)}`;
    return '1=1';
}

/** Numeric cast that tolerates numeric columns loaded as text (CSV). */
export function numericCast(quotedCol: string): string {
    return `TRY_CAST(${quotedCol} AS DOUBLE)`;
}
