/**
 * Governed plan-to-SQL engine.
 * ─────────────────────────────────────────────────────────────────────
 * The local semantic engines first create a typed AnalysisPlan. The selected
 * GPT-5.6 model then reasons over that plan plus a metadata-only schema to write
 * SQL, which is safety-gated and executed only in local DuckDB.
 *
 * Privacy is unchanged: no dataset rows leave the browser. The model receives
 * the user's question, the governed plan, schema metadata, and only
 * user-approved safe category domains when Enhanced privacy is enabled.
 */
import { fetchWithFallback, selectAISQLModel, SOL_MODEL } from './modelConfig';
import { validateReadOnlySQL } from './sqlSafety';
import type { AnalysisPlan, SemanticModel } from './types';
import { buildQueryContract, validateSQLAgainstContract } from './queryContract';

const SYSTEM_PROMPT = `You are an expert analyst who writes SQL for DuckDB.
Given a database schema and a question, output a SINGLE read-only SQL SELECT that answers it.
Rules:
- DuckDB dialect. Double-quote identifiers that contain spaces or special characters (e.g. "Free Meal Count (K-12)").
- Use the EXACT table and column names from the schema. Do not invent columns.
- Read the "Column notes": respect additivity (SUM only additive measures; a column marked "per-unit/rate" must use AVG, never SUM), and never GROUP BY or aggregate a column marked "row identifier".
- When money/revenue/total is asked for, use the additive currency measure, not a per-unit price.
- DATE COLUMNS ARE STORED AS TEXT (VARCHAR). You MUST wrap them in CAST(col AS DATE) before ANY date function or comparison — DATE_TRUNC, EXTRACT, strftime, date_diff, ordering by month, or BETWEEN. Example: DATE_TRUNC('month', CAST(order_date AS DATE)), and CAST(order_date AS DATE) BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'. Writing DATE_TRUNC('month', order_date) directly WILL fail.
- JOIN across tables when needed, following the listed foreign keys.
- The user's explicit question and the verified schema are the source of truth. The local Analysis Plan is a governed draft: preserve valid resolved metrics, filters, comparison semantics, sorting, and limits, but repair any omission or misclassification called out by Planner Verification.
- Never return a generic scalar total merely because the draft plan has no dimension. If the user asks "by", "over time", a fiscal calendar, a comparison, ranking, or another explicit analytical shape, implement that shape using the available schema.
- For a total period comparison, return two labelled aggregate rows, 'Current' and 'Previous'. For a trend comparison, retain the period label and the requested time grain.
- If the question includes a "Dataset reporting anchor", that anchor is the reporting clock. Resolve relative periods using explicit DATE literals from it; NEVER use CURRENT_DATE, CURRENT_TIMESTAMP, NOW(), or other wall-clock functions.
- Return ONLY the SQL — no prose, no explanation, no markdown fences.`;

export interface DirectSQLResult {
    sql: string;
    tokens: number;
    model?: string;
    error?: string;
    /** True when the SQL failed an explicit question-to-SQL contract and must not fall back to a generic answer. */
    blocked?: boolean;
}

/** Pull the SQL out of the model's reply (strip code fences / trailing prose). */
export function extractSQL(content: string): string {
    let s = (content || '').trim();
    const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    return s.replace(/;+\s*$/, '').trim();
}

/**
 * Generate SQL from a question, the metadata-only schema, and (when supplied)
 * the local governed plan. Returns the SQL and exact token cost; sets `error`
 * (and leaves sql for display) if the model's output fails the read-only safety gate.
 */
export async function generateDirectSQL(
    question: string,
    schemaText: string,
    analysisPlan?: AnalysisPlan,
    plannerVerification?: Array<{ code?: string; severity?: string; message?: string }>,
    semanticModel?: SemanticModel,
): Promise<DirectSQLResult> {
    const planContext = analysisPlan
        ? `\n\nLocal Analysis Plan (governed draft):\n${JSON.stringify(analysisPlan, null, 2)}`
        : '';
    const verificationContext = plannerVerification?.length
        ? `\n\nPlanner Verification (repair these gaps when the question and schema support it):\n${JSON.stringify(plannerVerification, null, 2)}`
        : '';
    const contract = analysisPlan
        ? buildQueryContract(question, analysisPlan, plannerVerification || [], semanticModel)
        : null;
    const contractContext = contract?.requirements.length
        ? `\n\nExecutable Query Contract:\n${contract.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
        : '';
    const userContext = `Schema:\n${schemaText}${planContext}${verificationContext}${contractContext}\n\nQuestion: ${question}\n\nSQL:`;
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContext },
    ];
    const model = selectAISQLModel(question, 'sql');
    console.log(`[AI SQL] Direct SQL model route: ${model}`);
    const { data, model: modelUsed } = await fetchWithFallback(messages as any, { temperature: 0, max_tokens: 2400, model });
    let content = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    let tokens = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || 0;
    let sql = extractSQL(content);
    let modelUsedForSQL = modelUsed;

    // Contract failure is a semantic failure, not a valid answer with lower
    // confidence. Ask Sol to review and repair the candidate before execution.
    let contractIssues = contract ? validateSQLAgainstContract(sql, contract) : [];
    if (contractIssues.length > 0) {
        console.warn('[AI SQL] Candidate violated query contract:', contractIssues.map(i => i.code).join(', '));
        const reviewPrompt = `${SYSTEM_PROMPT}\n\nYou are reviewing a candidate SQL query. Rewrite it so it meets every Executable Query Contract requirement. Do not return the original query if it drops a required analytical shape.`;
        const reviewMessages = [
            { role: 'system', content: reviewPrompt },
            { role: 'user', content: `${userContext}\n\nCandidate SQL to repair:\n${sql}\n\nContract failures:\n${contractIssues.map(i => `- ${i.message}`).join('\n')}\n\nCorrected SQL:` },
        ];
        const reviewed = await fetchWithFallback(reviewMessages as any, { temperature: 0, max_tokens: 2400, model: SOL_MODEL });
        content = reviewed.data.choices?.[0]?.message?.content || '';
        const reviewUsage = reviewed.data.usage || {};
        tokens += reviewUsage.total_tokens || ((reviewUsage.prompt_tokens || 0) + (reviewUsage.completion_tokens || 0)) || 0;
        sql = extractSQL(content);
        modelUsedForSQL = reviewed.model;
        contractIssues = contract ? validateSQLAgainstContract(sql, contract) : [];
        if (contractIssues.length > 0) {
            return {
                sql,
                tokens,
                model: modelUsedForSQL,
                error: `Faithfulness review rejected SQL: ${contractIssues.map(i => i.message).join(' ')}`,
                blocked: true,
            };
        }
    }

    // A fallback must never silently swap the dataset-relative reporting clock
    // for the user's machine/server clock. The caller passes an anchor whenever
    // one exists; reject a query that ignores it so it cannot return misleading
    // zeroes for a historical dataset.
    const hasDatasetAnchor = /Dataset reporting anchor:/i.test(question);
    if (hasDatasetAnchor && /\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|NOW)\b\s*(?:\(\s*\))?/i.test(sql)) {
        return {
            sql,
            tokens,
            model: modelUsedForSQL,
            error: 'Wall-clock SQL rejected: use the dataset reporting anchor with explicit DATE literals',
        };
    }

    const safe = validateReadOnlySQL(sql);
    if (!safe.ok) return { sql, tokens, model: modelUsedForSQL, error: `Unsafe SQL rejected: ${safe.reason}` };
    return { sql: safe.sql, tokens, model: modelUsedForSQL };
}
