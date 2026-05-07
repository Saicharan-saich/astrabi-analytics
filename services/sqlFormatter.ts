/**
 * SQL Formatter — Post-Processing Layer for Human-Readable SQL
 *
 * Transforms single-line or poorly formatted SQL into clean,
 * indented, standard-form SQL for the user-facing SQL tab.
 *
 * Rules:
 * 1. Major clauses (SELECT, FROM, WHERE, etc.) on their own line
 * 2. Select-list items indented 2 spaces, one per line
 * 3. Aliases aligned
 * 4. AND/OR conditions indented under WHERE
 * 5. CTE blocks properly indented
 * 6. Max line length advisory (soft wrap at 100 chars)
 * 7. Trailing semicolon
 */

// Keywords that always start a new line (major clauses)
const MAJOR_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY',
    'HAVING', 'LIMIT', 'OFFSET', 'UNION ALL', 'UNION',
    'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
    'CROSS JOIN', 'JOIN', 'ON', 'WITH',
];

// Sort by length descending so "GROUP BY" matches before "GROUP"
const SORTED_KEYWORDS = [...MAJOR_KEYWORDS].sort((a, b) => b.length - a.length);

/**
 * Format SQL for human readability.
 *
 * @param sql - Raw SQL string (may be single-line)
 * @returns Formatted, indented SQL string
 */
export function formatSQL(sql: string): string {
    if (!sql || typeof sql !== 'string') return sql;

    // Normalize whitespace
    let formatted = sql.trim().replace(/\s+/g, ' ');

    // ── Step 1: Handle CTEs (WITH ... AS (...)) ──────────────────
    // Match WITH cte_name AS ( ... ) patterns
    const cteMatch = formatted.match(/^WITH\s+/i);
    if (cteMatch) {
        formatted = formatCTEQuery(formatted);
    } else {
        formatted = formatSimpleQuery(formatted);
    }

    // ── Step 2: Clean up ─────────────────────────────────────────
    // Remove multiple blank lines
    formatted = formatted.replace(/\n{3,}/g, '\n\n');

    // Ensure trailing semicolon
    formatted = formatted.trimEnd();
    if (!formatted.endsWith(';')) {
        formatted += ';';
    }

    return formatted;
}

/**
 * Format a simple (non-CTE) SQL query.
 */
function formatSimpleQuery(sql: string): string {
    let result = sql;

    // Insert newlines before major keywords (case-insensitive)
    for (const kw of SORTED_KEYWORDS) {
        const regex = new RegExp(`\\s+${escapeRegex(kw)}\\s+`, 'gi');
        result = result.replace(regex, `\n${kw} `);
    }

    // Split into lines and process
    const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
    const formatted: string[] = [];

    for (const line of lines) {
        const upperLine = line.toUpperCase().trim();

        if (upperLine.startsWith('SELECT')) {
            formatted.push('SELECT');
            // Extract everything after SELECT
            const selectBody = line.replace(/^SELECT\s+(DISTINCT\s+)?/i, '');
            const distinct = /^SELECT\s+DISTINCT/i.test(line) ? 'DISTINCT ' : '';
            if (distinct) formatted[formatted.length - 1] = 'SELECT DISTINCT';

            // Split select items by comma (but not commas inside parentheses)
            const items = splitByComma(selectBody);
            items.forEach((item, i) => {
                const suffix = i < items.length - 1 ? ',' : '';
                formatted.push(`  ${item.trim()}${suffix}`);
            });
        } else if (upperLine.startsWith('WHERE')) {
            formatted.push('WHERE');
            const whereBody = line.replace(/^WHERE\s+/i, '');
            // Split by AND/OR
            const conditions = splitConditions(whereBody);
            conditions.forEach((cond, i) => {
                formatted.push(`  ${cond.trim()}`);
            });
        } else if (upperLine.startsWith('ORDER BY')) {
            const orderBody = line.replace(/^ORDER BY\s+/i, '');
            formatted.push(`ORDER BY ${orderBody}`);
        } else if (upperLine.startsWith('GROUP BY')) {
            const groupBody = line.replace(/^GROUP BY\s+/i, '');
            formatted.push(`GROUP BY ${groupBody}`);
        } else {
            formatted.push(line);
        }
    }

    return formatted.join('\n');
}

/**
 * Format a CTE (WITH ... AS) query.
 */
function formatCTEQuery(sql: string): string {
    // Find all CTE blocks: WITH name AS (...)
    // Then the final SELECT
    const parts: string[] = [];

    // Split by the final SELECT that's not inside parentheses
    let depth = 0;
    let finalSelectIdx = -1;

    for (let i = 0; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        if (sql[i] === ')') depth--;
        if (depth === 0 && sql.substring(i, i + 7).toUpperCase() === 'SELECT ') {
            // Check this isn't the first SELECT (which would be inside WITH)
            const before = sql.substring(0, i).trim();
            if (!before.match(/AS\s*\(\s*$/i) && before.length > 10) {
                finalSelectIdx = i;
                break;
            }
        }
    }

    if (finalSelectIdx === -1) {
        // Couldn't parse CTEs, fallback to simple formatting
        return formatSimpleQuery(sql);
    }

    const ctePart = sql.substring(0, finalSelectIdx).trim();
    const selectPart = sql.substring(finalSelectIdx).trim();

    // Format CTE header
    // Simple approach: preserve WITH ... AS (...) blocks with indentation
    const cteFormatted = ctePart
        .replace(/\bWITH\s+/i, 'WITH ')
        .replace(/\bAS\s*\(/gi, 'AS (\n  ')
        .replace(/\)\s*,?\s*$/gm, '\n)')
        .replace(/\)\s*,\s*/g, '),\n\n');

    parts.push(cteFormatted);
    parts.push('');
    parts.push(formatSimpleQuery(selectPart));

    return parts.join('\n');
}

/**
 * Split a comma-separated list, respecting parentheses depth.
 */
function splitByComma(str: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let current = '';

    for (const ch of str) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            items.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) items.push(current);
    return items;
}

/**
 * Split WHERE conditions by AND/OR, respecting parentheses.
 */
function splitConditions(where: string): string[] {
    const conditions: string[] = [];
    let depth = 0;
    let current = '';

    const words = where.split(/\s+/);
    for (const word of words) {
        for (const ch of word) {
            if (ch === '(') depth++;
            if (ch === ')') depth--;
        }

        if (depth === 0 && (word.toUpperCase() === 'AND' || word.toUpperCase() === 'OR')) {
            if (current.trim()) conditions.push(current.trim());
            current = word + ' ';
        } else {
            current += word + ' ';
        }
    }
    if (current.trim()) conditions.push(current.trim());
    return conditions;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compute a readability score for SQL (0-10).
 * Used by confidenceScorer to reward well-structured SQL.
 */
export function scoreSQLReadability(sql: string): { score: number; reasons: string[] } {
    if (!sql) return { score: 0, reasons: ['No SQL provided'] };

    let score = 0;
    const reasons: string[] = [];

    const lines = sql.split('\n');
    const lineCount = lines.length;

    // Multi-line SQL (+3)
    if (lineCount > 3) {
        score += 3;
    } else {
        reasons.push('SQL is too compact (single or few lines)');
    }

    // Has aliases (+3)
    const hasAliases = /\bAS\s+\w+/i.test(sql);
    if (hasAliases) {
        score += 3;
    } else {
        reasons.push('Missing column aliases (AS)');
    }

    // Uses CTE (+2)
    if (/\bWITH\s+\w+\s+AS\s*\(/i.test(sql)) {
        score += 2;
        reasons.push('Uses CTE (WITH) for structured query');
    }

    // No line exceeds 120 chars (+2)
    const longLines = lines.filter(l => l.length > 120).length;
    if (longLines === 0) {
        score += 2;
    } else {
        reasons.push(`${longLines} line(s) exceed 120 characters`);
    }

    return { score: Math.min(10, score), reasons };
}
