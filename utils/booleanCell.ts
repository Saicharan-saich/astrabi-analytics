/** A true/false cell: a native boolean or the word true/false. DuckDB stores such a column as BOOLEAN. */
export const isBooleanCell = (value: unknown): boolean => typeof value === 'boolean'
    || (typeof value === 'string' && /^(true|false)$/i.test(value.trim()));
