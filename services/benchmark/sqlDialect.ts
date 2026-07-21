/**
 * Minimal SQL dialect translation for executing external GOLD SQL in DuckDB.
 * BIRD and some Spider gold queries use SQLite/MySQL `backtick` identifiers,
 * which DuckDB rejects — convert them to "double-quoted" identifiers. Backticks
 * inside single-quoted string literals are left untouched.
 */
export function toDuckDBDialect(sql: string): string {
    let out = '';
    let inStr = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") { inStr = !inStr; out += ch; continue; }
        if (ch === '`' && !inStr) {
            const end = sql.indexOf('`', i + 1);
            if (end > i) {
                out += '"' + sql.slice(i + 1, end).replace(/"/g, '""') + '"';
                i = end;
                continue;
            }
        }
        out += ch;
    }
    return out;
}
