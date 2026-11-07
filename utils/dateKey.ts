/**
 * A calendar date as "YYYY-MM-DD", read the way the person wrote it.
 *
 * `new Date("1 June 2025").toISOString()` gives "2025-05-31" anywhere east of
 * UTC (all of India, the UK in summer): the date is parsed as local midnight
 * and then printed in UTC. Every sale on the 1st of a month then lands in the
 * previous month. Here a written date keeps its own day:
 *  - "2025-06-01" and "2025-06-01T…" keep their date part as written;
 *  - a Date object or any other written date uses the local calendar day.
 */
const pad = (n: number) => String(n).padStart(2, '0');

export function localDateKey(date: Date): string | null {
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateKeyOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return localDateKey(value);
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(text)) return text.slice(0, 10);
    const parsed = new Date(text);
    return localDateKey(parsed);
}
