/**
 * Query Contract — executable faithfulness requirements for AI-generated SQL.
 *
 * The local planner is useful but fallible. This contract extracts only
 * high-confidence requirements stated explicitly in the user's question, then
 * checks that generated SQL has not silently dropped them.
 */
import type { AnalysisPlan } from './types';
import type { VerificationIssue } from './planVerification';

export interface QueryContract {
    requirements: string[];
    requiresGrouping: boolean;
    requiresFiscalCalendar: boolean;
    requiresRanking: boolean;
    requiresComparison: boolean;
}

export interface SQLFaithfulnessIssue {
    code: 'missing_grouping' | 'missing_fiscal_calendar' | 'missing_ranking' | 'missing_comparison';
    message: string;
}

const BREAKDOWN_CUE = /\b(by|per|for each|for every|breakdown by|split by|grouped by)\s+[a-z]/i;
const RANKING_CUE = /\b(top|bottom|highest|lowest|most|least|best|worst|rank)\b/i;
const COMPARISON_CUE = /\b(vs\.?|versus|compared to|comparison|month[- ]over[- ]month|year[- ]over[- ]year|mom|yoy|qoq|wow)\b/i;
const FISCAL_CUE = /\bfiscal\s+(?:year|quarter|calendar)\b/i;

/** Build a concise, privacy-safe contract from the question and local diagnostics. */
export function buildQueryContract(
    question: string,
    plan: AnalysisPlan,
    verification: Array<Pick<VerificationIssue, 'code' | 'message'>> = [],
): QueryContract {
    const requirements: string[] = [];
    const requiresFiscalCalendar = FISCAL_CUE.test(question);
    const requiresGrouping = requiresFiscalCalendar
        || BREAKDOWN_CUE.test(question)
        || verification.some(issue => issue.code === 'missing_dimension');
    const requiresRanking = RANKING_CUE.test(question)
        || verification.some(issue => issue.code === 'missing_ranking');
    const requiresComparison = COMPARISON_CUE.test(question) || Boolean(plan.comparison);

    if (requiresGrouping) requirements.push('Return the requested breakdown/grouping, not a single scalar total.');
    if (requiresFiscalCalendar) requirements.push('Use the requested fiscal calendar definition, including its stated start month.');
    if (requiresRanking) requirements.push('Return a ranked result with ORDER BY and an appropriate LIMIT when the question specifies one.');
    if (requiresComparison) requirements.push('Return both requested comparison periods with clearly labelled result columns or rows.');

    return { requirements, requiresGrouping, requiresFiscalCalendar, requiresRanking, requiresComparison };
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
    if (contract.requiresComparison
        && !/(?:\bunion\s+all\b|\bcurrent\b|\bprevious\b|\bprior\b|\bcomparison\b)/.test(normalized)) {
        issues.push({
            code: 'missing_comparison',
            message: 'The question requires a period comparison, but the SQL does not represent both periods.',
        });
    }

    return issues;
}
