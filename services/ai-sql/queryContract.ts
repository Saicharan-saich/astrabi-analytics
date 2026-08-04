/**
 * Query Contract — executable faithfulness requirements for AI-generated SQL.
 *
 * The local planner is useful but fallible. This contract extracts only
 * high-confidence requirements stated explicitly in the user's question, then
 * checks that generated SQL has not silently dropped them.
 */
import type { AnalysisPlan, SemanticModel } from './types';

export interface QueryContract {
    requirements: string[];
    requiresGrouping: boolean;
    requiresFiscalCalendar: boolean;
    requiresRanking: boolean;
    /** Numeric limit explicitly requested by a top/bottom ranking question. */
    rankingLimit?: number;
    requiresComparison: boolean;
    /** Exact schema field requested for the grouping, when confidently resolved. */
    requiredDimension?: string;
}

export interface SQLFaithfulnessIssue {
    code: 'missing_grouping' | 'missing_requested_dimension' | 'missing_fiscal_calendar' | 'missing_ranking' | 'missing_comparison';
    message: string;
}

const BREAKDOWN_CUE = /\b(by|per|for each|for every|breakdown by|split by|grouped by)\s+[a-z]/i;
const RANKING_CUE = /\b(top|bottom|highest|lowest|most|least|best|worst|rank)\b/i;
const COMPARISON_CUE = /\b(vs\.?|versus|compared to|comparison|month[- ]over[- ]month|year[- ]over[- ]year|mom|yoy|qoq|wow)\b/i;
const FISCAL_CUE = /\bfiscal\s+(?:year|quarter|calendar)\b/i;

/** Resolve an explicitly named grouping term to one schema dimension. */
function resolveRequestedDimension(question: string, model?: SemanticModel): string | undefined {
    if (!model) return undefined;
    const normalized = question.toLowerCase();
    // A fiscal calendar is always derived from the dataset's canonical date field.
    if (FISCAL_CUE.test(normalized)) {
        return model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
            || model.timeContext?.primaryDateColumn;
    }

    let best: { field: string; score: number } | undefined;
    for (const field of model.fields.filter(f => f.role === 'dimension')) {
        const names = [field.name, field.displayLabel, ...(field.synonyms || [])]
            .map(v => v.toLowerCase().replace(/_/g, ' ').trim())
            .filter(v => v.length >= 3);
        for (const name of names) {
            if (!normalized.includes(name)) continue;
            // Exact field names and display labels are more reliable than generic synonyms.
            const score = name === field.name.toLowerCase().replace(/_/g, ' ') ? 3
                : name === field.displayLabel.toLowerCase() ? 2 : 1;
            if (!best || score > best.score) best = { field: field.name, score };
        }
    }
    return best?.field;
}

/** Build a concise, privacy-safe contract from the question and local diagnostics. */
export function buildQueryContract(
    question: string,
    plan: AnalysisPlan,
    verification: Array<{ code?: string; message?: string }> = [],
    model?: SemanticModel,
): QueryContract {
    const requirements: string[] = [];
    const requiresFiscalCalendar = FISCAL_CUE.test(question);
    const requiresGrouping = requiresFiscalCalendar
        || BREAKDOWN_CUE.test(question)
        || verification.some(issue => issue.code === 'missing_dimension');
    const requiresRanking = RANKING_CUE.test(question)
        || verification.some(issue => issue.code === 'missing_ranking');
    const rankingLimitMatch = question.match(/\b(?:top|bottom)\s+(\d+)\b/i);
    const rankingLimit = rankingLimitMatch ? Number(rankingLimitMatch[1]) : undefined;
    const requiresComparison = COMPARISON_CUE.test(question) || Boolean(plan.comparison);
    const requiredDimension = requiresGrouping ? resolveRequestedDimension(question, model) : undefined;

    if (requiresGrouping) requirements.push('Return the requested breakdown/grouping, not a single scalar total.');
    if (requiredDimension) requirements.push(`Use the requested grouping field "${requiredDimension}".`);
    if (requiresFiscalCalendar) requirements.push('Use the requested fiscal calendar definition, including its stated start month.');
    if (requiresRanking) requirements.push('Return a ranked result with ORDER BY and an appropriate LIMIT when the question specifies one.');
    if (requiresComparison) requirements.push('Return both requested comparison periods with clearly labelled result columns or rows.');

    return { requirements, requiresGrouping, requiresFiscalCalendar, requiresRanking, rankingLimit, requiresComparison, requiredDimension };
}

/** Verify that the generated SQL still contains every explicit contract shape. */
export function validateSQLAgainstContract(sql: string, contract: QueryContract): SQLFaithfulnessIssue[] {
    const issues: SQLFaithfulnessIssue[] = [];
    const normalized = sql.toLowerCase();

    if (contract.requiresGrouping && !/\bgroup\s+by\b/.test(normalized)) {
        issues.push({
            code: 'missing_grouping',
            message: 'The question requires a breakdown, but the generated SQL has no GROUP BY.',
        });
    }
    if (contract.requiredDimension) {
        const field = contract.requiredDimension.toLowerCase();
        if (!normalized.includes(field)) {
            issues.push({
                code: 'missing_requested_dimension',
                message: `The question requires grouping by "${contract.requiredDimension}", but that field is absent from the SQL.`,
            });
        }
    }
    if (contract.requiresFiscalCalendar
        && !/(?:fiscal|date_trunc\s*\(\s*'quarter'|quarter\s*\()/.test(normalized)) {
        issues.push({
            code: 'missing_fiscal_calendar',
            message: 'The question requires a fiscal-quarter calculation, but the SQL does not define one.',
        });
    }
    if (contract.requiresRanking && !/\border\s+by\b/.test(normalized)) {
        issues.push({
            code: 'missing_ranking',
            message: 'The question requires a ranking, but the SQL has no ORDER BY.',
        });
    }
    if (contract.rankingLimit !== undefined
        && !new RegExp('\\blimit\\s+' + contract.rankingLimit + '\\b').test(normalized)) {
        issues.push({
            code: 'missing_ranking',
            message: `The question asks for the top/bottom ${contract.rankingLimit}, but the SQL has no matching LIMIT ${contract.rankingLimit}.`,
        });
    }
    if (contract.requiresComparison
        && !/(?:\bunion\s+all\b|\bcurrent\b|\bprevious\b|\bprior\b|\bcomparison\b|(?:this|last)[_ -]?(?:day|week|month|quarter|year))/i.test(normalized)) {
        issues.push({
            code: 'missing_comparison',
            message: 'The question requires a period comparison, but the SQL does not represent both periods.',
        });
    }

    return issues;
}
