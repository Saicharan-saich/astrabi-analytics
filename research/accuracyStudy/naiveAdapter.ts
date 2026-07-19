/**
 * naiveAdapter.ts — the "naive" arm: an LLM asked to write SQL directly.
 *
 * This is the baseline the hybrid architecture is compared against. The prompt is
 * deliberately representative of how most "AI analytics" tools work today: hand
 * the model the schema and the question, take whatever SQL it returns, run it.
 *
 * Gated on an API key. With no key, `getNaiveAdapter()` returns null and the
 * study reports the naive arm as "not run" rather than inventing numbers — the
 * measured comparison only ever reflects a real model's real output.
 */

const API_KEY = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY || '';
const MODEL = process.env.NAIVE_STUDY_MODEL || 'anthropic/claude-sonnet-5';

/** A representative "just write the SQL" prompt — no plan, no guards. */
function naivePrompt(question: string, schema: string[]): string {
    return `You are a SQL assistant. The table is called "data" with columns: ${schema.join(', ')}.
Write a single DuckDB SQL query that answers the question. Reply with ONLY the SQL, no explanation.
Question: ${question}`;
}

export type NaiveAdapter = (question: string, schema: string[]) => Promise<string>;

export function getNaiveAdapter(): NaiveAdapter | null {
    if (!API_KEY) return null;
    return async (question, schema) => {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model: MODEL, temperature: 0,
                messages: [{ role: 'user', content: naivePrompt(question, schema) }],
            }),
        });
        const data = await res.json();
        const raw: string = data?.choices?.[0]?.message?.content ?? '';
        // strip markdown fences if present
        return raw.replace(/```sql\s*|```\s*/gi, '').trim();
    };
}
