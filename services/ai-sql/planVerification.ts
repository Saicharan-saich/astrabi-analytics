/**
 * Plan Verification — the faithfulness gate.
 * ─────────────────────────────────────────────────────────────────────
 * The knobs faithfully compile whatever plan they are handed, so a bad plan
 * (dropped filter, wrong metric, missing ranking) produces a confident WRONG
 * answer. This module runs deterministic invariant checks that compare the
 * question's surface intent against the plan and surfaces mismatches — turning
 * "silent wrong answer" into "flagged / low-confidence answer".
 *
 * These are high-precision heuristics: they only fire when the question clearly
 * asks for something the plan clearly lacks. The strongest check (a grounded
 * value present in the question but missing from the filters) is an ERROR; the
 * softer intent checks are WARNINGS.
 */

import type { AnalysisPlan, SemanticModel } from './types';
import type { ValueCatalog } from './valueGrounding';

export interface VerificationIssue {
    severity: 'error' | 'warn';
    code: string;
    message: string;
}

export interface VerificationResult {
    /** True when there are no ERROR-level issues. */
    ok: boolean;
    issues: VerificationIssue[];
}

const COUNT_CUE = /\b(how many|number of|count of|count the|no\. of)\b/i;
const AVG_CUE = /\b(average|avg|mean)\b/i;
const SUPERLATIVE_CUE = /\b(top|highest|most|largest|biggest|greatest|leading|best|lowest|least|smallest|fewest|worst|bottom|maximum|minimum|rank)\b/i;
const BREAKDOWN_CUE = /\b(by|per|for each|for every|breakdown by|split by|grouped by)\s+[a-z]/i;
const MONEY_CUE = /\b(revenue|sales|income|earnings|turnover|billed|billing|spend|spending)\b/i;

const NEGATION_CUES = ['not ', "n't ", 'never ', 'without ', 'excluding ', 'exclude ', 'except ', 'other than '];

function metricAggs(plan: AnalysisPlan): Set<string> {
    return new Set(plan.metrics.map(m => String(m.agg)));
}

/** Whether the plan already constrains a field by a value (either polarity). */
function planHasValue(plan: AnalysisPlan, field: string, value: string): boolean {
    const v = value.toLowerCase();
    return plan.filters.some(f => {
        if (f.field.toLowerCase() !== field.toLowerCase()) return false;
        const fv = Array.isArray(f.value) ? f.value.map(x => String(x).toLowerCase()) : [String(f.value).toLowerCase()];
        return fv.includes(v);
    });
}

export function verifyPlan(
    question: string,
    plan: AnalysisPlan,
    model: SemanticModel,
    catalog?: ValueCatalog,
): VerificationResult {
    const issues: VerificationIssue[] = [];
    const q = ` ${question.toLowerCase()} `;
    const aggs = metricAggs(plan);

    // ── 1. Count question → a count metric ───────────────────────
    if (COUNT_CUE.test(q) && !aggs.has('count') && !aggs.has('count_distinct') && !plan.metrics.some(m => m.field === '*')) {
        issues.push({ severity: 'warn', code: 'missing_count', message: 'The question asks "how many / number of", but the plan does not use a COUNT.' });
    }

    // ── 2. Average question → an AVG metric ──────────────────────
    if (AVG_CUE.test(q) && !aggs.has('avg') && !plan.metrics.some(m => m.compositeId || m.derivedMetricId)) {
        issues.push({ severity: 'warn', code: 'missing_avg', message: 'The question asks for an average, but the plan does not use AVG.' });
    }

    // ── 3. Superlative → a ranking (sort or limit) ───────────────
    if (SUPERLATIVE_CUE.test(q)
        && plan.sort.length === 0 && !plan.limit
        && !['ranking', 'aggregate_filter', 'growth_analysis'].includes(plan.intent)) {
        issues.push({ severity: 'warn', code: 'missing_ranking', message: 'The question asks for a top/bottom/most/least, but the plan has no sort or limit.' });
    }

    // ── 4. Breakdown cue → a dimension ───────────────────────────
    if (BREAKDOWN_CUE.test(q) && plan.dimensions.length === 0
        && !['single_metric', 'aggregate_filter'].includes(plan.intent)) {
        issues.push({ severity: 'warn', code: 'missing_dimension', message: 'The question asks for a per/by breakdown, but the plan has no grouping dimension.' });
    }

    // ── 5. Money question but a non-currency metric ──────────────
    if (MONEY_CUE.test(q) && plan.metrics.length > 0 && plan.metrics[0].field !== '*') {
        const mf = model.fields.find(f => f.name.toLowerCase() === plan.metrics[0].field.toLowerCase());
        const currencyExists = model.fields.some(f => f.role === 'metric' && f.semanticType === 'currency');
        if (mf && mf.semanticType !== 'currency' && currencyExists) {
            issues.push({ severity: 'warn', code: 'possible_wrong_metric', message: `The question mentions money, but the plan aggregates "${mf.name}" (not a currency column).` });
        }
    }

    // ── 6. Grounded value present but not filtered (ERROR) ───────
    // The strongest check: a distinctive dimension value named in the question
    // that the plan does not filter on → a dropped filter → wrong answer.
    if (catalog) {
        for (const [key, entries] of catalog.index) {
            if (entries.length !== 1) continue; // ambiguous — skip
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
            const m = re.exec(q);
            if (!m) continue;
            const at = m.index + m[1].length;
            const window = q.slice(Math.max(0, at - 18), at);
            const negated = NEGATION_CUES.some(c => window.includes(c));
            const { field, value } = entries[0];
            // A value used as a group-by dimension does not need a filter.
            const isDimension = plan.dimensions.some(d => d.field.toLowerCase() === field.toLowerCase());
            if (!planHasValue(plan, field, value) && !isDimension) {
                issues.push({
                    severity: 'error',
                    code: 'dropped_filter',
                    message: `The question mentions "${value}" (${field})${negated ? ' as an exclusion' : ''}, but the plan does not filter on it.`,
                });
            }
        }
    }

    return { ok: !issues.some(i => i.severity === 'error'), issues };
}
