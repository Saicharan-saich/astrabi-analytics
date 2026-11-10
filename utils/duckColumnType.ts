import { parseLocaleNumber } from '../services/etlHardening';
import { isBooleanCell } from './booleanCell';

/**
 * The DuckDB type for one column, from ALL of its values — not just the first
 * 100. A column can look numeric at the top but hold codes like "00D5" further
 * down (common in real datasets); typing it DOUBLE would make the INSERT fail.
 *
 *   BOOLEAN  every value is true/false (native, or the words), so
 *            WHERE "showed_up" and COUNT_IF("showed_up") work
 *   DOUBLE   every value is a number (codes with leading zeros stay text)
 *   VARCHAR  anything else, dates included (kept as text, like the JS engine)
 */
export function duckColumnType(rows: Record<string, any>[], col: string): 'BOOLEAN' | 'DOUBLE' | 'VARCHAR' {
    let hasDate = false;
    let hasNumber = false;
    let hasString = false;
    let hasBoolean = false;
    let allBoolean = true;
    for (let i = 0; i < rows.length; i++) {
        const val = rows[i][col];
        if (val === null || val === undefined || val === '') continue;
        if (isBooleanCell(val)) { hasBoolean = true; continue; }
        allBoolean = false;
        // A native JS number is unambiguously numeric.
        if (typeof val === 'number') { hasNumber = true; continue; }
        const strVal = String(val);
        // Numeric-looking codes with significant zeros must remain text.
        if (/^[+-]?0\d/.test(strVal.trim())) { hasString = true; break; }
        if (/^\d{4}-\d{2}-\d{2}/.test(strVal) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(strVal)) {
            hasDate = true;
        } else if (parseLocaleNumber(strVal) !== null) {
            // The same locale/currency parser as ETL ("387.00 GBP").
            hasNumber = true;
        } else {
            hasString = true;
            break; // definitively text — no need to scan further
        }
    }
    if (hasBoolean && allBoolean) return 'BOOLEAN';
    if (!hasString && !hasDate && hasNumber && !hasBoolean) return 'DOUBLE';
    return 'VARCHAR';
}

/**
 * One cell as it is stored in DuckDB, for the column's type — the one rule the
 * app's loader and the answer check both follow. Empty text is a blank (NULL),
 * so COUNT(DISTINCT customer_id) and "IS NULL" treat a missing customer as
 * missing, not as a customer called "".
 */
export function duckCellValue(value: unknown, type: 'BOOLEAN' | 'DOUBLE' | 'VARCHAR'): boolean | number | string | null {
    if (value === null || value === undefined) return null;
    if (type === 'BOOLEAN') return isBooleanCell(value) ? String(value).trim().toLowerCase() === 'true' : null;
    if (type === 'DOUBLE') return typeof value === 'number' ? (Number.isFinite(value) ? value : null) : parseLocaleNumber(value as any);
    const text = String(value);
    return text.trim() === '' ? null : text;
}

/** The same cell as a SQL literal for an INSERT. */
export function duckLiteral(value: unknown, type: 'BOOLEAN' | 'DOUBLE' | 'VARCHAR'): string {
    const v = duckCellValue(value, type);
    if (v === null) return 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(v);
    return `'${v.replace(/'/g, "''")}'`;
}

/**
 * The name a source table (a sheet, a store table) has inside DuckDB. The
 * prompt, the loader and the answer check all use this, so the AI writes a
 * name that exists: "Line Items" → line_items. "data" and "dim_date" are taken.
 */
export function duckTableName(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'table';
    const start = /^[0-9]/.test(safe) ? `t_${safe}` : safe;
    return start === 'data' || start === 'dim_date' ? `${start}_table` : start;
}

/** The other tables a dataset can be queried with: all of a workbook's sheets or a store's tables. */
export function queryTablesOf(dataset: { relatedTables?: { name: string; rows: Record<string, any>[] }[]; sourceTables?: { name: string; rows: Record<string, any>[] }[] }) {
    const tables = dataset.relatedTables?.length ? dataset.relatedTables : dataset.sourceTables;
    return tables && tables.length > 1 ? tables : undefined;
}

/** The same tables by their DuckDB name, for the answer check. */
export function tablesByDuckName(dataset: Parameters<typeof queryTablesOf>[0]): Record<string, Record<string, any>[]> | undefined {
    const tables = queryTablesOf(dataset);
    return tables ? Object.fromEntries(tables.map(t => [duckTableName(t.name), t.rows])) : undefined;
}
