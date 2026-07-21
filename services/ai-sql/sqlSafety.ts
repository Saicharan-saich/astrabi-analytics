/**
 * Read-only safety gate for LLM-generated SQL.
 * ─────────────────────────────────────────────────────────────────────
 * The plan engine can never emit destructive SQL because it only renders
 * SELECTs. A direct SQL-generation engine CAN (the model could return anything),
 * so every generated query passes this gate before execution: exactly one
 * statement, must be a SELECT/WITH, and no DDL/DML/side-effecting keywords.
 * Execution is against an ephemeral in-browser DuckDB, but defence-in-depth.
 */

const FORBIDDEN = [
    'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'replace',
    'attach', 'detach', 'copy', 'export', 'import', 'install', 'load', 'pragma',
    'grant', 'revoke', 'call', 'vacuum', 'set',
];

export interface SqlSafetyResult { ok: boolean; reason?: string; sql: string; }

/** Strip -- line comments and /* *\/ block comments (outside string literals). */
function stripComments(sql: string): string {
    return sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Remove single-quoted string literals so keywords inside them don't trip us. */
function blankStrings(sql: string): string {
    return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function validateReadOnlySQL(rawSql: string): SqlSafetyResult {
    const sql = (rawSql || '').trim().replace(/;+\s*$/, ''); // drop trailing semicolons
    if (!sql) return { ok: false, reason: 'Empty SQL', sql };

    const cleaned = blankStrings(stripComments(sql)).trim();

    // Exactly one statement (no embedded ';').
    if (cleaned.includes(';')) {
        return { ok: false, reason: 'Multiple statements are not allowed', sql };
    }

    // Must be a query.
    if (!/^\s*(select|with)\b/i.test(cleaned)) {
        return { ok: false, reason: 'Only SELECT / WITH queries are allowed', sql };
    }

    // No side-effecting keywords anywhere (outside strings/comments).
    const lower = cleaned.toLowerCase();
    for (const kw of FORBIDDEN) {
        if (new RegExp(`\\b${kw}\\b`).test(lower)) {
            return { ok: false, reason: `Forbidden keyword: ${kw.toUpperCase()}`, sql };
        }
    }

    return { ok: true, sql };
}
