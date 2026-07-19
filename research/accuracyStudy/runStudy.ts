/**
 * runStudy.ts — orchestrates the head-to-head and tallies the result table.
 *
 * Two arms, same questions, same oracle, same grader:
 *   • HYBRID  — question's plan → the deterministic correctSQL engine → DuckDB.
 *   • NAIVE   — an LLM is asked to write SQL directly from the question + schema,
 *               then that SQL runs on the same DuckDB. (Requires an API key; when
 *               absent, the naive arm is reported as "not run", never fabricated.)
 *
 * The output is the paper's core table: for each system, how many answers were
 * correct, how many were SILENT ERRORS (wrong but plausible), and how much raw
 * data was exposed to the LLM.
 */
import { QUESTIONS, QuestionCase, OrderRow } from './bank';
import { grade, Grade, SilentErrorClass } from './taxonomy';

export type ExecFn = (sql: string) => any[];
export interface ArmResult {
    id: string; question: string; sql: string;
    answer: unknown; grade: Grade;
}

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));

/** Pull the graded answer out of a result set: scalar (first numeric cell) or a
 *  label→value map when the question was a breakdown. */
export function extractAnswer(rows: any[], grouped: boolean): unknown {
    if (!rows || rows.length === 0) return grouped ? {} : NaN;
    if (!grouped) {
        const first = rows[0];
        const numericKey = Object.keys(first).find(k => Number.isFinite(num(first[k])));
        return numericKey ? num(first[numericKey]) : NaN;
    }
    const out: Record<string, number> = {};
    for (const r of rows) {
        const keys = Object.keys(r);
        const labelKey = keys.find(k => !Number.isFinite(num(r[k]))) ?? keys[0];
        const valKey = keys.find(k => k !== labelKey && Number.isFinite(num(r[k]))) ?? keys[1];
        out[String(r[labelKey])] = num(r[valKey]);
    }
    return out;
}

const isGrouped = (q: QuestionCase) => (q.plan.dimensions?.length ?? 0) > 0;

/** Run the hybrid arm: build each question's SQL with the deterministic engine
 *  and execute it. `compile` maps a plan → SQL (wired by the caller to correctSQL
 *  + normalizeSQLForDuckDB so this module stays free of app-internal imports). */
export function runHybridArm(
    rows: OrderRow[], compile: (plan: any) => string, exec: ExecFn,
): ArmResult[] {
    return QUESTIONS.map(q => {
        let sql = '', answer: unknown = NaN, failed = false;
        try {
            sql = compile(q.plan);
            answer = extractAnswer(exec(sql), isGrouped(q));
        } catch (e: any) { failed = true; sql = sql || `/* compile/exec error: ${e?.message} */`; }
        return { id: q.id, question: q.question, sql, answer, grade: grade({ sql, answer, failed }, q.groundTruth(rows), q.req) };
    });
}

/** Run the naive arm: ask an LLM for SQL, execute it, grade it. */
export async function runNaiveArm(
    rows: OrderRow[], askLLM: (question: string, schema: string[]) => Promise<string>, exec: ExecFn,
): Promise<ArmResult[]> {
    const out: ArmResult[] = [];
    for (const q of QUESTIONS) {
        let sql = '', answer: unknown = NaN, failed = false;
        try {
            sql = await askLLM(q.question, q.req.schema);
            answer = extractAnswer(exec(sql), isGrouped(q));
        } catch (e: any) { failed = true; sql = sql || `/* ${e?.message} */`; }
        out.push({ id: q.id, question: q.question, sql, answer, grade: grade({ sql, answer, failed }, q.groundTruth(rows), q.req) });
    }
    return out;
}

export interface Tally {
    total: number; correct: number; wrongValue: number; queryFailed: number;
    silentErrors: number; byClass: Partial<Record<SilentErrorClass, number>>;
}

export function tally(results: ArmResult[]): Tally {
    const t: Tally = { total: results.length, correct: 0, wrongValue: 0, queryFailed: 0, silentErrors: 0, byClass: {} };
    for (const r of results) {
        if (r.grade.verdict === 'correct') t.correct++;
        else if (r.grade.verdict === 'wrong_value') t.wrongValue++;
        else if (r.grade.verdict === 'query_failed') t.queryFailed++;
        else if (r.grade.verdict === 'silent_error') {
            t.silentErrors++;
            const c = r.grade.errorClass!; t.byClass[c] = (t.byClass[c] || 0) + 1;
        }
    }
    return t;
}

/** Render the comparison as a Markdown report for the paper. */
export function formatReport(hybrid: Tally, naive?: Tally): string {
    const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(0)}%`;
    const row = (label: string, t: Tally, dataExposed: string) =>
        `| ${label} | ${t.correct}/${t.total} (${pct(t.correct, t.total)}) | ${t.silentErrors} | ${t.wrongValue} | ${t.queryFailed} | ${dataExposed} |`;
    const lines = [
        '| System | Correct | Silent errors | Other wrong | Query failed | Raw data sent to LLM |',
        '|---|---|---|---|---|---|',
        row('Hybrid (plan → deterministic SQL)', hybrid, '0 rows — metadata only'),
    ];
    if (naive) lines.push(row('Naive (LLM writes SQL directly)', naive, 'schema only*'));
    else lines.push('| Naive (LLM writes SQL directly) | — not run (no API key) — |||||');
    let out = lines.join('\n');
    if (hybrid.silentErrors > 0) out += `\n\nHybrid silent errors by class: ${JSON.stringify(hybrid.byClass)}`;
    if (naive && naive.silentErrors > 0) out += `\nNaive silent errors by class: ${JSON.stringify(naive.byClass)}`;
    return out;
}
