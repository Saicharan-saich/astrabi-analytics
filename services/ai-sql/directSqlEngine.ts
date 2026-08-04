/**
 * Direct SQL-semantics engine (the second, general path).
 * ─────────────────────────────────────────────────────────────────────
 * Instead of mapping a question onto the analytical plan schema, this asks the
 * LLM to write SQL directly from the METADATA-ONLY schema (no rows). It handles
 * the long tail the plan engine can't express — arbitrary joins, subqueries,
 * set operations — at the cost of the plan engine's determinism and governed
 * metrics. Every query is safety-gated (read-only) before it runs.
 *
 * Privacy is unchanged: only the schema (names + types + FKs) reaches the model.
 */
import { fetchWithFallback, selectAISQLModel } from './modelConfig';
import { validateReadOnlySQL } from './sqlSafety';

const SYSTEM_PROMPT = `You are an expert analyst who writes SQL for DuckDB.
Given a database schema and a question, output a SINGLE read-only SQL SELECT that answers it.
Rules:
- DuckDB dialect. Double-quote identifiers that contain spaces or special characters (e.g. "Free Meal Count (K-12)").
- Use the EXACT table and column names from the schema. Do not invent columns.
- Read the "Column notes": respect additivity (SUM only additive measures; a column marked "per-unit/rate" must use AVG, never SUM), and never GROUP BY or aggregate a column marked "row identifier".
- When money/revenue/total is asked for, use the additive currency measure, not a per-unit price.
- DATE COLUMNS ARE STORED AS TEXT (VARCHAR). You MUST wrap them in CAST(col AS DATE) before ANY date function or comparison — DATE_TRUNC, EXTRACT, strftime, date_diff, ordering by month, or BETWEEN. Example: DATE_TRUNC('month', CAST(order_date AS DATE)), and CAST(order_date AS DATE) BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'. Writing DATE_TRUNC('month', order_date) directly WILL fail.
- JOIN across tables when needed, following the listed foreign keys.
- If the question includes a "Dataset reporting anchor", that anchor is the reporting clock. Resolve relative periods using explicit DATE literals from it; NEVER use CURRENT_DATE, CURRENT_TIMESTAMP, NOW(), or other wall-clock functions.
- Return ONLY the SQL — no prose, no explanation, no markdown fences.`;

export interface DirectSQLResult { sql: string; tokens: number; model?: string; error?: string; }

/** Pull the SQL out of the model's reply (strip code fences / trailing prose). */
export function extractSQL(content: string): string {
    let s = (content || '').trim();
    const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    return s.replace(/;+\s*$/, '').trim();
}

/**
 * Generate SQL for a question against the given schema text. Returns the SQL and
 * exact token cost; sets `error` (and leaves sql for display) if the model's
 * output fails the read-only safety gate.
 */
export async function generateDirectSQL(question: string, schemaText: string): Promise<DirectSQLResult> {
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Schema:\n${schemaText}\n\nQuestion: ${question}\n\nSQL:` },
    ];
    const model = selectAISQLModel(question, 'sql');
    console.log(`[AI SQL] Direct SQL model route: ${model}`);
    const { data, model: modelUsed } = await fetchWithFallback(messages as any, { temperature: 0, max_tokens: 2000, model });
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    const tokens = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || 0;

    const sql = extractSQL(content);

    // A fallback must never silently swap the dataset-relative reporting clock
    // for the user's machine/server clock. The caller passes an anchor whenever
    // one exists; reject a query that ignores it so it cannot return misleading
    // zeroes for a historical dataset.
    const hasDatasetAnchor = /Dataset reporting anchor:/i.test(question);
    if (hasDatasetAnchor && /\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|NOW)\b\s*(?:\(\s*\))?/i.test(sql)) {
        return {
            sql,
            tokens,
            model: modelUsed,
            error: 'Wall-clock SQL rejected: use the dataset reporting anchor with explicit DATE literals',
        };
    }

    const safe = validateReadOnlySQL(sql);
    if (!safe.ok) return { sql, tokens, model: modelUsed, error: `Unsafe SQL rejected: ${safe.reason}` };
    return { sql: safe.sql, tokens, model: modelUsed };
}
