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
import { fetchWithFallback, PLANNER_MODEL } from './modelConfig';
import { validateReadOnlySQL } from './sqlSafety';

const SYSTEM_PROMPT = `You are an expert analyst who writes SQL for DuckDB.
Given a database schema and a question, output a SINGLE read-only SQL SELECT that answers it.
Rules:
- DuckDB dialect. Double-quote identifiers that contain spaces or special characters (e.g. "Free Meal Count (K-12)").
- Use the EXACT table and column names from the schema. Do not invent columns.
- Read the "Column notes": respect additivity (SUM only additive measures; a column marked "per-unit/rate" must use AVG, never SUM), and never GROUP BY or aggregate a column marked "row identifier".
- When money/revenue/total is asked for, use the additive currency measure, not a per-unit price.
- For date filters, use the listed date column and cast to DATE when comparing (e.g. CAST(col AS DATE) BETWEEN DATE '2025-01-01' AND DATE '2025-12-31').
- JOIN across tables when needed, following the listed foreign keys.
- Return ONLY the SQL — no prose, no explanation, no markdown fences.`;

export interface DirectSQLResult { sql: string; tokens: number; error?: string; }

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
    const { data } = await fetchWithFallback(messages as any, { temperature: 0, max_tokens: 2000, model: PLANNER_MODEL });
    const content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    const tokens = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || 0;

    const sql = extractSQL(content);
    const safe = validateReadOnlySQL(sql);
    if (!safe.ok) return { sql, tokens, error: `Unsafe SQL rejected: ${safe.reason}` };
    return { sql: safe.sql, tokens };
}
