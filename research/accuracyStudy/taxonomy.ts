/**
 * taxonomy.ts — the measuring instrument for Study 1.
 *
 * Standard text-to-SQL benchmarks score a query "correct" if its result rows
 * match a gold query. That metric is BLIND to a whole class of failures that
 * matter enormously for a non-technical user: answers that are the WRONG NUMBER
 * but look completely plausible. We call these SILENT ERRORS and give them a
 * taxonomy so they can be counted, not just felt.
 *
 * A silent error is: a wrong answer produced by a meaning-level mistake that a
 * user staring at a single number could not detect.
 *
 * This module is pure and deterministic — it is the grader, independent of which
 * system produced the candidate answer, so the same instrument scores both arms.
 */

export type SilentErrorClass =
    | 'dropped_filter'          // a filter stated in the question is absent → counts/sums everything
    | 'non_additive_sum'       // SUM over a ratio / percentage / rate (meaningless total)
    | 'aggregated_identifier'  // SUM/AVG over an ID column (a nonsense number)
    | 'wrong_aggregation'      // used the wrong aggregate (e.g. SUM where AVG was asked)
    | 'ignored_grouping'       // missing GROUP BY → one blended number instead of a breakdown
    | 'hallucinated_field';    // referenced a column that does not exist in the schema

export type Verdict = 'correct' | 'wrong_value' | 'silent_error' | 'query_failed';

export interface Grade {
    verdict: Verdict;
    errorClass?: SilentErrorClass;
    detail: string;
}

/** Ground-truth spec a correct answer to a question must satisfy. */
export interface AnswerRequirements {
    /** Valid columns in the dataset (for hallucination detection). */
    schema: string[];
    /** Columns whose values a WHERE clause MUST reference (the question's filters). */
    requiredFilterCols?: string[];
    /** The metric column and the aggregate the question demands. */
    metricCol?: string;
    requiredAgg?: 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max';
    /** Columns that must NOT be summed (ratios, percentages, ordinals). */
    nonAdditiveCols?: string[];
    /** Columns that are identifiers and must never be summed/averaged. */
    idCols?: string[];
    /** Dimension columns the question asks to break down by. */
    requiredGroupByCols?: string[];
}

const has = (sql: string, re: RegExp) => re.test(sql);
const aggRe = (agg: string, col: string) =>
    new RegExp(`\\b${agg}\\s*\\(\\s*(distinct\\s+)?"?${escapeRe(col)}"?`, 'i');
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Inspect a candidate SQL string for the semantic mistakes in our taxonomy.
 * Returns the first class detected (ordered by how badly it corrupts the answer),
 * or null if the SQL looks semantically sound. Best-effort static analysis — it
 * is intentionally conservative so it under-counts rather than over-counts.
 */
export function detectSilentErrorClass(sql: string, req: AnswerRequirements): SilentErrorClass | null {
    const s = sql.toLowerCase();

    // 1. Hallucinated field — a quoted identifier not present in the schema.
    //    Result-column ALIASES ("... AS \"revenue_sum\"") are not fields, so strip
    //    them before scanning, or a valid aliased query is mislabeled.
    const noAliases = s.replace(/\bas\s+"[^"]+"/g, ' ');
    const quoted = [...noAliases.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const schemaLower = new Set(req.schema.map(c => c.toLowerCase()));
    for (const id of quoted) {
        if (!schemaLower.has(id) && id !== 'data') return 'hallucinated_field';
    }

    // 2. Dropped filter — a required filter column never appears in the SQL at all.
    for (const col of req.requiredFilterCols || []) {
        if (!s.includes(col.toLowerCase())) return 'dropped_filter';
        // present but no WHERE clause → the filter was not applied
        if (!s.includes('where')) return 'dropped_filter';
    }

    // 3. Non-additive SUM — summing a ratio/percentage/rate column.
    for (const col of req.nonAdditiveCols || []) {
        if (has(s, aggRe('sum', col))) return 'non_additive_sum';
    }

    // 4. Aggregated identifier — SUM/AVG over an ID column.
    for (const col of req.idCols || []) {
        if (has(s, aggRe('sum', col)) || has(s, aggRe('avg', col))) return 'aggregated_identifier';
    }

    // 5. Wrong aggregation — the metric is aggregated with the wrong function.
    if (req.metricCol && req.requiredAgg && req.requiredAgg !== 'count') {
        const used = (['sum', 'avg', 'min', 'max'] as const).find(a => has(s, aggRe(a, req.metricCol!)));
        if (used && used !== req.requiredAgg) return 'wrong_aggregation';
    }

    // 6. Ignored grouping — a breakdown question that produced no GROUP BY.
    if ((req.requiredGroupByCols || []).length > 0) {
        if (!s.includes('group by')) return 'ignored_grouping';
        for (const col of req.requiredGroupByCols!) {
            if (!s.includes(col.toLowerCase())) return 'ignored_grouping';
        }
    }

    return null;
}

const TOL = 1e-6;
const numClose = (a: number, b: number) => Math.abs(a - b) <= TOL * Math.max(1, Math.abs(b));

/** Compare a candidate answer to ground truth. Scalars compare numerically;
 *  grouped answers compare as label→value maps. */
export function answersMatch(candidate: unknown, truth: unknown): boolean {
    if (typeof truth === 'number') {
        return typeof candidate === 'number' && numClose(candidate, truth);
    }
    // grouped: Record<string, number>
    const t = truth as Record<string, number>;
    const c = candidate as Record<string, number>;
    if (!c || typeof c !== 'object') return false;
    const tk = Object.keys(t), ck = Object.keys(c);
    if (tk.length !== ck.length) return false;
    return tk.every(k => k in c && numClose(c[k], t[k]));
}

/**
 * Grade one candidate. Correctness is decided first (a right answer is never an
 * "error", however it was produced); a wrong answer is then attributed to a
 * silent-error class when a taxonomy pattern explains it, else counted as a
 * generic wrong value.
 */
export function grade(
    candidate: { sql: string; answer: unknown; failed?: boolean },
    truth: unknown,
    req: AnswerRequirements,
): Grade {
    if (candidate.failed) return { verdict: 'query_failed', detail: 'The query errored and returned no answer.' };
    if (answersMatch(candidate.answer, truth)) return { verdict: 'correct', detail: 'Answer matches ground truth.' };
    const cls = detectSilentErrorClass(candidate.sql, req);
    if (cls) return { verdict: 'silent_error', errorClass: cls, detail: `Wrong answer attributable to: ${cls}.` };
    return { verdict: 'wrong_value', detail: 'Wrong answer with no recognized silent-error pattern.' };
}
