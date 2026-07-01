// sqlExecutor.ts — Execute AI-generated SQL directly against dataset rows using alasql
import alasql from 'alasql';
import { generateDimDate } from './dimDateGenerator';

export interface SQLExecutionResult {
    data: any[];
    columns: string[];
    error?: string;
}

// Register custom SQL functions that AI models commonly use but alasql doesn't support natively
const registerCustomFunctions = () => {
    // STRFTIME — SQLite date formatting function
    alasql.fn.STRFTIME = (format: string, dateVal: any) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        if (format === '%Y') return String(d.getFullYear());
        if (format === '%m') return String(d.getMonth() + 1).padStart(2, '0');
        if (format === '%d') return String(d.getDate()).padStart(2, '0');
        if (format === '%Y-%m') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (format === '%Y-%m-%d') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return String(dateVal);
    };

    // DATE — extract date part and apply optional SQLite modifiers
    alasql.fn.DATE = (dateVal: any, ...modifiers: any[]) => {
        if (!dateVal) return null;
        let d: Date;
        if (String(dateVal).toLowerCase() === 'now') {
            d = new Date();
        } else {
            d = new Date(dateVal);
        }
        if (isNaN(d.getTime())) return null;

        // Apply SQLite-style modifiers like '-6 days', '+1 month', '-1 year'
        for (const mod of modifiers) {
            if (!mod) continue;
            const m = String(mod).match(/^([+-]?\d+)\s+(day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds)$/i);
            if (m) {
                const n = parseInt(m[1], 10);
                const unit = m[2].toLowerCase().replace(/s$/, '');
                if (unit === 'day') d.setDate(d.getDate() + n);
                else if (unit === 'month') d.setMonth(d.getMonth() + n);
                else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
                else if (unit === 'hour') d.setHours(d.getHours() + n);
                else if (unit === 'minute') d.setMinutes(d.getMinutes() + n);
                else if (unit === 'second') d.setSeconds(d.getSeconds() + n);
            }
        }

        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // SUBSTR / SUBSTRING — SQLite/PostgreSQL substring function (1-indexed)
    alasql.fn.SUBSTR = (val: any, start: number, length?: number) => {
        if (val === null || val === undefined) return null;
        const str = String(val);
        const startIdx = start > 0 ? start - 1 : Math.max(0, str.length + start);
        if (length !== undefined && length !== null) {
            return str.substring(startIdx, startIdx + length);
        }
        return str.substring(startIdx);
    };

    // LEFT — extract N characters from the left
    alasql.fn.LEFT = (val: any, n: number) => {
        if (val === null || val === undefined) return null;
        return String(val).substring(0, n);
    };

    // RIGHT — extract N characters from the right
    alasql.fn.RIGHT = (val: any, n: number) => {
        if (val === null || val === undefined) return null;
        const str = String(val);
        return str.substring(Math.max(0, str.length - n));
    };

    // REPLACE — string replace function
    alasql.fn.REPLACE = (val: any, search: string, replacement: string) => {
        if (val === null || val === undefined) return null;
        return String(val).split(search).join(replacement);
    };

    // COALESCE — return first non-null value
    alasql.fn.COALESCE = (...args: any[]) => {
        for (const arg of args) {
            if (arg !== null && arg !== undefined) return arg;
        }
        return null;
    };

    // IFNULL — SQLite null replacement
    alasql.fn.IFNULL = (val: any, fallback: any) => {
        return (val === null || val === undefined) ? fallback : val;
    };

    // NULLIF — returns NULL if the two arguments are equal, otherwise returns first arg
    alasql.fn.NULLIF = (a: any, b: any) => {
        return a === b ? null : a;
    };

    // ROUND — round to decimal places
    alasql.fn.ROUND = (val: any, decimals?: number) => {
        if (val === null || val === undefined) return null;
        const n = Number(val);
        if (isNaN(n)) return null;
        const d = decimals ?? 0;
        return Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
    };

    // TO_INT — force-convert to integer (handles strings, dates, floats)
    alasql.fn.TO_INT = (val: any) => {
        if (val === null || val === undefined) return null;
        const n = parseInt(String(val), 10);
        return isNaN(n) ? null : n;
    };

    // TO_FLOAT — force-convert to float
    alasql.fn.TO_FLOAT = (val: any) => {
        if (val === null || val === undefined) return null;
        const n = parseFloat(String(val));
        return isNaN(n) ? null : n;
    };

    // YEAR — extract year from a date value (handles Date objects, date strings, ISO strings)
    alasql.fn.YEAR = (val: any) => {
        if (val === null || val === undefined) return null;
        // If it's already a number (e.g., a year like 2017), return it
        if (typeof val === 'number' && val > 1900 && val < 2200) return val;
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d.getFullYear();
        // Try parsing as string "YYYY-..." 
        const match = String(val).match(/(\d{4})/);
        return match ? parseInt(match[1], 10) : null;
    };

    // MONTH — extract month from date
    alasql.fn.MONTH = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        return !isNaN(d.getTime()) ? d.getMonth() + 1 : null;
    };

    // DAY — extract day from date
    alasql.fn.DAY = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        return !isNaN(d.getTime()) ? d.getDate() : null;
    };

    // EXTRACT — SQL standard date part extraction (EXTRACT(YEAR FROM col))
    // Note: alasql handles YEAR(), MONTH() natively but not EXTRACT syntax

    // DATETIME — SQLite-style date/time function with optional modifiers
    // Handles: DATETIME('2023-06-20'), DATETIME('2023-06-20', '-6 days'), DATETIME('now', '-1 month')
    alasql.fn.DATETIME = (dateVal: any, ...modifiers: any[]) => {
        if (!dateVal) return null;
        let d: Date;
        if (String(dateVal).toLowerCase() === 'now') {
            d = new Date();
        } else {
            d = new Date(dateVal);
        }
        if (isNaN(d.getTime())) return null;

        // Apply SQLite-style modifiers like '-6 days', '+1 month', '-1 year'
        for (const mod of modifiers) {
            if (!mod) continue;
            const m = String(mod).match(/^([+-]?\d+)\s+(day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds)$/i);
            if (m) {
                const n = parseInt(m[1], 10);
                const unit = m[2].toLowerCase().replace(/s$/, '');
                if (unit === 'day') d.setDate(d.getDate() + n);
                else if (unit === 'month') d.setMonth(d.getMonth() + n);
                else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
                else if (unit === 'hour') d.setHours(d.getHours() + n);
                else if (unit === 'minute') d.setMinutes(d.getMinutes() + n);
                else if (unit === 'second') d.setSeconds(d.getSeconds() + n);
            }
        }

        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // DATE_SUB — MySQL-style date subtraction: DATE_SUB('2023-06-20', INTERVAL 7 DAY)
    alasql.fn.DATE_SUB = (dateVal: any, interval: any) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        const n = typeof interval === 'number' ? interval : parseInt(String(interval), 10);
        if (isNaN(n)) return String(dateVal);
        d.setDate(d.getDate() - n);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // DATE_ADD — MySQL-style date addition
    alasql.fn.DATE_ADD = (dateVal: any, interval: any) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        const n = typeof interval === 'number' ? interval : parseInt(String(interval), 10);
        if (isNaN(n)) return String(dateVal);
        d.setDate(d.getDate() + n);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // JULIANDAY — SQLite Julian day number (used for date diff: JULIANDAY(a) - JULIANDAY(b))
    alasql.fn.JULIANDAY = (dateVal: any) => {
        if (!dateVal) return null;
        const d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        // Julian day approximation: days since epoch / 86400000 + offset
        return Math.floor(d.getTime() / 86400000) + 2440587.5;
    };

    // DATEDIFF — number of days between two dates
    alasql.fn.DATEDIFF = (a: any, b: any) => {
        if (!a || !b) return null;
        const da = new Date(a);
        const db = new Date(b);
        if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
        return Math.round((da.getTime() - db.getTime()) / 86400000);
    };

    // TENURE_YEARS — computes years between hire_date and as_of_date as a single function.
    // Workaround: alasql parser can't handle AVG(DATEDIFF(...)) (nested custom function inside aggregate),
    // so we combine the operation into one function: AVG(TENURE_YEARS(col, 'date')) works fine.
    alasql.fn.TENURE_YEARS = (hireDate: any, asOfDate: any) => {
        if (!hireDate || !asOfDate) return null;
        const dh = new Date(hireDate);
        const da = new Date(asOfDate);
        if (isNaN(dh.getTime()) || isNaN(da.getTime())) return null;
        return Math.round((da.getTime() - dh.getTime()) / 86400000) / 365.0;
    };

    // CURRENT_DATE — returns today's date as YYYY-MM-DD

    alasql.fn.CURRENT_DATE = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // LPAD — left-pad a value with a character to a target length
    alasql.fn.LPAD = (val: any, length: number, padChar?: string) => {
        if (val === null || val === undefined) return null;
        return String(val).padStart(length, padChar || ' ');
    };

    // RPAD — right-pad a value
    alasql.fn.RPAD = (val: any, length: number, padChar?: string) => {
        if (val === null || val === undefined) return null;
        return String(val).padEnd(length, padChar || ' ');
    };

    // FORMAT_MONTH — returns YYYY-MM string from a date value (reliable month formatting)
    alasql.fn.FORMAT_MONTH = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    // QUARTER — extract quarter (1-4) from date
    alasql.fn.QUARTER = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        return Math.ceil((d.getMonth() + 1) / 3);
    };

    // DAYOFWEEK — day of the week (1=Sunday...7=Saturday)
    alasql.fn.DAYOFWEEK = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        return !isNaN(d.getTime()) ? d.getDay() + 1 : null;
    };

    // DAYNAME — name of the day
    alasql.fn.DAYNAME = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    };

    // HOUR — extract hour (0-23) from datetime
    alasql.fn.HOUR = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        return !isNaN(d.getTime()) ? d.getHours() : null;
    };

    // MINUTE — extract minute (0-59) from datetime
    alasql.fn.MINUTE = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        return !isNaN(d.getTime()) ? d.getMinutes() : null;
    };

    // WEEK — ISO week number (1-53)
    alasql.fn.WEEK = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        const oneJan = new Date(d.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((d.getTime() - oneJan.getTime()) / 86400000) + 1;
        return Math.ceil(dayOfYear / 7);
    };

    // MONTHNAME — name of the month
    alasql.fn.MONTHNAME = (val: any) => {
        if (val === null || val === undefined) return null;
        const d = new Date(val);
        if (isNaN(d.getTime())) return null;
        return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
    };

    // NOW — returns current datetime as ISO string
    alasql.fn.NOW = () => new Date().toISOString();

    // LOWER / UPPER — string case functions
    alasql.fn.LOWER = (val: any) => val == null ? null : String(val).toLowerCase();
    alasql.fn.UPPER = (val: any) => val == null ? null : String(val).toUpperCase();

    // TRIM — remove whitespace
    alasql.fn.TRIM = (val: any) => val == null ? null : String(val).trim();

    // LENGTH / LEN — string length
    alasql.fn.LENGTH = (val: any) => val == null ? null : String(val).length;
    alasql.fn.LEN = alasql.fn.LENGTH;

    // ABS — absolute value
    alasql.fn.ABS = (val: any) => val == null ? null : Math.abs(Number(val));

    // CEIL / FLOOR
    alasql.fn.CEIL = (val: any) => val == null ? null : Math.ceil(Number(val));
    alasql.fn.CEILING = alasql.fn.CEIL;
    alasql.fn.FLOOR = (val: any) => val == null ? null : Math.floor(Number(val));

    // IIF — inline if (SQL Server style)
    alasql.fn.IIF = (cond: any, trueVal: any, falseVal: any) => cond ? trueVal : falseVal;
};

/**
 * Normalize AI-generated SQL to be compatible with alasql.
 * Converts SQLite/PostgreSQL-specific syntax to alasql equivalents.
 */
const normalizeSQL = (sql: string): string => {
    let normalized = sql;

    // 0. Pre-process: resolve static DATETIME('literal', 'modifier') into plain date strings
    // This handles the most common AI pattern: DATETIME('2023-06-20', '-6 days')
    normalized = normalizeDatetimeExpressions(normalized);

    // 1. Normalize table names: "orders" → data (unquoted)
    normalized = normalized.replace(/FROM\s+["']?orders["']?/gi, 'FROM data');
    normalized = normalized.replace(/FROM\s+["']?data["']?/gi, 'FROM data');

    // 2. Remove double-quotes around column names (alasql prefers unquoted or backticks)
    // But keep single-quoted string values intact
    normalized = normalized.replace(/"(\w+)"/g, '[$1]');

    // 3. Handle CAST(SUBSTR(date_col,1,4) AS INTEGER) → YEAR(date_col)
    // This is the most common AI-generated pattern for extracting year from date columns
    normalized = normalizeYearExtraction(normalized);

    // 4. Handle remaining CAST — convert to TO_INT / TO_FLOAT
    normalized = normalizeCAST(normalized);

    // 5. Convert || string concatenation to + (alasql doesn't support || for strings)
    normalized = normalized.replace(/\|\|/g, '+');

    // 6. Handle EXTRACT(YEAR FROM col) → YEAR(col)
    normalized = normalized.replace(/EXTRACT\s*\(\s*(YEAR|MONTH|DAY)\s+FROM\s+(\w+)\s*\)/gi,
        (_, part, col) => `${part.toUpperCase()}(${col})`
    );

    // 7. Handle DATE_SUB(col, INTERVAL N DAY) → convert to alasql-compatible form
    normalized = normalized.replace(/DATE_SUB\s*\(\s*([^,]+?)\s*,\s*INTERVAL\s+(\d+)\s+(DAY|MONTH|YEAR)\s*\)/gi,
        (_, dateExpr, n, unit) => `DATE_SUB(${dateExpr}, ${n})`
    );

    // 8. Handle DATE_ADD(col, INTERVAL N DAY)
    normalized = normalized.replace(/DATE_ADD\s*\(\s*([^,]+?)\s*,\s*INTERVAL\s+(\d+)\s+(DAY|MONTH|YEAR)\s*\)/gi,
        (_, dateExpr, n, unit) => `DATE_ADD(${dateExpr}, ${n})`
    );

    // 9. Handle CURDATE() / CURRENT_DATE → CURRENT_DATE()
    normalized = normalized.replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE()');
    normalized = normalized.replace(/\bCURRENT_DATE\b(?!\s*\()/gi, 'CURRENT_DATE()');

    // 10. Rewrite CONCAT(YEAR(col), '-', LPAD(MONTH(col), 2, '0')) → FORMAT_MONTH(col)
    // This pattern is the #1 cause of "LPAD is not a function" errors in AI SQL
    normalized = normalized.replace(
        /CONCAT\s*\(\s*YEAR\s*\(([^)]+)\)\s*,\s*'-'\s*,\s*LPAD\s*\(\s*MONTH\s*\(\1\)\s*,\s*2\s*,\s*'0'\s*\)\s*\)/gi,
        'FORMAT_MONTH($1)'
    );

    // 11. Handle NOW() → CURRENT_DATE()
    normalized = normalized.replace(/\bNOW\s*\(\s*\)/gi, 'NOW()');

    return normalized;
};

/**
 * Pre-process SQLite DATETIME('literal', 'modifier') expressions.
 * Resolves them to plain date strings at normalization time so alasql
 * doesn't need to handle them at runtime (most reliable approach).
 *
 * Examples:
 *   DATETIME('2023-06-20', '-6 days')  → '2023-06-14'
 *   DATETIME('now', '-1 month')        → '2023-05-20'
 *   DATETIME('2023-01-01', '+1 year')  → '2024-01-01'
 */
const normalizeDatetimeExpressions = (sql: string): string => {
    // Match DATETIME('date_literal', 'modifier') or DATE('date_literal', 'modifier') with optional second modifier
    return sql.replace(
        /(?:DATETIME|DATE)\s*\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?(?:\s*,\s*'([^']+)')?\s*\)/gi,
        (match, dateStr, mod1, mod2) => {
            try {
                let d: Date;
                if (dateStr.toLowerCase() === 'now') {
                    d = new Date();
                } else {
                    d = new Date(dateStr + 'T00:00:00');
                }
                if (isNaN(d.getTime())) return match; // Can't parse, leave as-is

                // Apply modifiers
                const applyMod = (date: Date, mod: string) => {
                    const m = mod.match(/^([+-]?\d+)\s+(day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds)$/i);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        const unit = m[2].toLowerCase().replace(/s$/, '');
                        if (unit === 'day') date.setDate(date.getDate() + n);
                        else if (unit === 'month') date.setMonth(date.getMonth() + n);
                        else if (unit === 'year') date.setFullYear(date.getFullYear() + n);
                    }
                };

                if (mod1) applyMod(d, mod1);
                if (mod2) applyMod(d, mod2);

                const result = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return `'${result}'`;
            } catch {
                return match; // On error, leave as-is for runtime handling
            }
        }
    );
};

/**
 * Detect and replace CAST(SUBSTR(date_col, 1, 4) AS INTEGER) → YEAR(date_col)
 * Also handles: SUBSTR(date_col, 1, 4) when used for year extraction
 * And: CAST(SUBSTR(date_col, 6, 2) AS INTEGER) → MONTH(date_col) 
 */
const normalizeYearExtraction = (sql: string): string => {
    let result = sql;

    // Pattern: CAST(SUBSTR(col, 1, 4) AS INTEGER) → YEAR(col)
    // This is the most common AI-generated year extraction
    result = result.replace(
        /CAST\s*\(\s*SUBSTR\s*\(\s*(\w+)\s*,\s*1\s*,\s*4\s*\)\s*AS\s+(?:INTEGER|INT)\s*\)/gi,
        'YEAR($1)'
    );

    // Pattern: CAST(SUBSTR(col, 6, 2) AS INTEGER) → MONTH(col)
    result = result.replace(
        /CAST\s*\(\s*SUBSTR\s*\(\s*(\w+)\s*,\s*6\s*,\s*2\s*\)\s*AS\s+(?:INTEGER|INT)\s*\)/gi,
        'MONTH($1)'
    );

    // Pattern: CAST(SUBSTR(col, 9, 2) AS INTEGER) → DAY(col)
    result = result.replace(
        /CAST\s*\(\s*SUBSTR\s*\(\s*(\w+)\s*,\s*9\s*,\s*2\s*\)\s*AS\s+(?:INTEGER|INT)\s*\)/gi,
        'DAY($1)'
    );

    // Pattern: standalone SUBSTR(col, 1, 4) = 'YYYY' or = YYYY → YEAR(col) = YYYY
    result = result.replace(
        /SUBSTR\s*\(\s*(\w+)\s*,\s*1\s*,\s*4\s*\)\s*=\s*['"]?(\d{4})['"]?/gi,
        'YEAR($1) = $2'
    );

    return result;
};

/**
 * Handle remaining CAST(expr AS TYPE) normalization for alasql.
 * Uses TO_INT/TO_FLOAT custom functions instead of ROUND.
 */
const normalizeCAST = (sql: string): string => {
    let result = sql;
    let safety = 0;
    while (result.match(/CAST\s*\(/i) && safety < 20) {
        safety++;
        result = result.replace(/CAST\s*\((.+?)\s+AS\s+(INTEGER|INT|REAL|FLOAT|DOUBLE|NUMERIC|TEXT|VARCHAR|STRING|CHAR|BOOLEAN|DATE)\s*\)/i,
            (_, expr, type) => {
                const t = type.toUpperCase();
                if (t === 'INTEGER' || t === 'INT') {
                    return `TO_INT(${expr})`;
                }
                if (t === 'REAL' || t === 'FLOAT' || t === 'DOUBLE' || t === 'NUMERIC') {
                    return `TO_FLOAT(${expr})`;
                }
                // For TEXT/STRING/DATE types, just strip the CAST
                return expr;
            }
        );
    }
    return result;
};

/**
 * Execute an SQL query directly against an array of data rows.
 * The rows are loaded into a temporary alasql table called "data".
 * The AI prompt tells the model to use "data" as the table name.
 *
 * Optionally, if timeContext is provided, a continuous dim_date table is also
 * registered so queries can JOIN fact data with calendar attributes.
 */
export const executeSQL = (
    rows: any[],
    sql: string,
    timeContext?: { minDate: string; maxDate: string; primaryDateColumn?: string }
): SQLExecutionResult => {
    try {
        // Register custom functions
        registerCustomFunctions();

        // Normalize the SQL for alasql compatibility
        const normalizedSQL = normalizeSQL(sql);

        // Create a temporary in-memory table and insert the rows
        alasql('DROP TABLE IF EXISTS data');
        alasql('CREATE TABLE data');
        alasql.tables['data'].data = [...rows];

        // Register dim_date table when timeContext is available
        // This enables time intelligence JOINs: JOIN dim_date d ON fact.date_col = d.date_key
        alasql('DROP TABLE IF EXISTS dim_date');
        if (timeContext?.minDate && timeContext?.maxDate) {
            const dimRows = generateDimDate(timeContext.minDate, timeContext.maxDate);
            if (dimRows.length > 0) {
                alasql('CREATE TABLE dim_date');
                alasql.tables['dim_date'].data = dimRows;
                console.log(`[SQL Executor] dim_date registered: ${dimRows.length} rows (${timeContext.minDate} → ${timeContext.maxDate})`);
            }
        }

        console.log('[SQL Executor] Original SQL:', sql);
        console.log('[SQL Executor] Normalized SQL:', normalizedSQL);

        // Execute the query
        const result = alasql(normalizedSQL) as any[];

        // Extract column names from the first result row
        const columns = result.length > 0 ? Object.keys(result[0]) : [];

        console.log('[SQL Executor] Result rows:', result.length, 'columns:', columns);

        return { data: result, columns };
    } catch (error: any) {
        console.error('[SQL Executor] Error:', error.message, '| Original SQL:', sql);
        return { data: [], columns: [], error: error.message };
    }
};
