/**
 * Lean AI SQL
 * ─────────────────────────────────────────────────────────────────────
 * One clear path from a question to an answer:
 *
 *   1. Describe the dataset: column names, types and roles only. No values,
 *      counts, ranges or dates from the data leave the browser.
 *   2. One AI call reads that description and either
 *        – asks a short follow-up with concrete choices when the question is
 *          vague ("best performing" with several possible measures), or
 *        – writes one read-only DuckDB query.
 *   3. The query runs locally in DuckDB-WASM. A failed query gets one repair
 *      attempt; the error text sent back has every quoted value removed.
 *   4. The result is profiled locally, the chart is chosen by the existing
 *      chart recommender, and plain-English insights are calculated from the
 *      returned numbers in the browser (the AI never sees them).
 */

import { ColumnType, type Dataset } from '../../types';
import { describeDatasetShape, shapeForModel } from '../datasetShape';
import { isBooleanCell } from '../../utils/booleanCell';
import type {
    SemanticModel, SemanticField,
    AISQLPipelineResult, AnalysisIntent, AnalysisPlan, ConfidenceScore, PlanDimension, PlanMetric,
    ResultNarrative, ResultProfile, ChartRecommendation,
} from './types';
import { AISQLPipelineError } from './pipelineError';
import { resolveAISQLSemanticModel } from './semanticLayer';
import { discoverJoinContext } from './joinEngine';
import { fetchWithFallback, PLANNER_MODEL } from './modelConfig';
import { validateReadOnlySQL } from './sqlSafety';
import { executeSQLViaDuckDB } from '../duckdbEngine';
import { profileResult } from './resultProfiler';
import { recommendChart } from './chartRecommender';
import { reshapeData } from './dataReshaper';
import { buildResultNarrative } from './resultNarrative';
import { formatSQL } from '../sqlFormatter';
import { formatContextForPrompt, type ContextTurn } from './chatContext';
import { averageCaution, groupedAverageMessage } from '../../utils/averageCheck';
import { relabelYesNo } from './plainLabels';
import { guardAnswer, valuesArePartsOfWhole } from '../../utils/answerGuard';
import { averagedRatioNote, averageNotesFromValues, averageValuesQuery, fillMonthlyGaps, missingMonthsNote, partialMonthNote, perItemColumns, perItemSumNote, perLineAverageNote, summedBalanceNote } from './numberChecks';

// ── Public types ─────────────────────────────────────────────────────

export interface ClarificationOption {
    /** Short chip text, e.g. "Total revenue". */
    label: string;
    /** The complete question that is asked when the chip is chosen. */
    question: string;
}

/** Thrown when the question needs a choice from the user before answering. */
export class AISQLClarificationError extends AISQLPipelineError {
    readonly options: ClarificationOption[];
    constructor(message: string, options: ClarificationOption[]) {
        super('clarification_required', message);
        this.name = 'AISQLClarificationError';
        this.options = options;
    }
}

/** The AI replied in words: the message was conversation, not a data question. */
export class AISQLChatReplyError extends AISQLPipelineError {
    readonly suggestions: string[];
    readonly tokens: number;
    constructor(message: string, suggestions: string[], tokens = 0) {
        super('conversation_only', message);
        this.name = 'AISQLChatReplyError';
        this.suggestions = suggestions;
        this.tokens = tokens;
    }
}

/** The user asked for an overview of the whole dataset (worked out locally). */
export class AISQLOverviewRequest extends AISQLPipelineError {
    readonly tokens: number;
    constructor(tokens = 0) {
        super('summary_story_required', 'An overview of the whole dataset.');
        this.name = 'AISQLOverviewRequest';
        this.tokens = tokens;
    }
}

export interface LeanRunOptions {
    /** The user chose "analysis": answer with data, never reply in words. */
    requireAnalysis?: boolean;
    /** Re-run the same question at a different date grouping. */
    grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    onProgress?: (step: string) => void;
    /**
     * Never stop to ask (drill-downs, regenerate, summary stories): take the
     * most likely reading and say which one in the explanation.
     */
    autoChoose?: boolean;
    /**
     * Earlier questions in the chat and the SQL that answered them, sent only
     * for a follow-up. Never results, rows or values.
     */
    context?: ContextTurn[];
    /** Admin accuracy runs: audited benchmark budget, never the user's daily allowance. */
    requestPurpose?: 'benchmark';
}

/** What the model returns. Exported for tests. */
export type LeanModelReply =
    | { action: 'clarify'; question: string; options: ClarificationOption[] }
    | { action: 'chat'; message: string; suggestions: string[] }
    | { action: 'overview' }
    | { action: 'answer'; title?: string; sql: string; dimensions?: string[]; measures?: string[]; explanation?: string; question?: string; followUp?: boolean };

// ── Prompt ───────────────────────────────────────────────────────────

export const LEAN_SYSTEM_PROMPT = `You are QuickInsight's data analyst. You see only a description of the user's data: column names, types, roles and short notes. You never see rows. Your job is to answer the user's question by writing ONE DuckDB SQL query that will run on their computer.

STEP 0 — Is it a data question at all?
If the message asks for a summary, overview or description of the whole dataset ("summarise my data", "what's in this file?"), return {"action":"overview"}: the app builds that itself.
If the message is conversation rather than a request for numbers from the data — a greeting or thanks, a question about you or how QuickInsight works, what a word means, why an earlier answer looks the way it does — reply in words (action "chat"): at most 100 friendly words, never stating numbers from the data (you have not seen them), plus up to 3 short example questions built from the real column names.

STEP 1 — Decide whether to ask a follow-up.
Ask (action "clarify") when ANY of these is true:
- The question uses a subjective or open word — best, worst, top, performing, successful, popular, doing well, good, bad, important, biggest, insights, trends, interesting — and does NOT say how to measure it, and the data has two or more measures it could reasonably mean (for example revenue, units sold, profit, number of orders, average price).
- The question mentions something that is not in the data, or that matches several different columns.
- The question has nothing specific to analyse ("show me insights", "what's interesting?", "analyse this").
Do NOT ask when the question names its measure ("top products by revenue", "average price by make", "how many orders per month") or when only one measure could sensibly be meant.
When the DATA SHAPE says there is nothing to add up, the measures are counts, rates of the yes/no columns and averages of the numbers; if it names the result being tracked, a vague question ("what matters most?", "insights") is usually about that rate — offer options that compare it by different columns.
For a follow-up give 2 to 4 options. Each option must be a complete, specific question you would answer without asking again, naming the exact measure and grouping from the data, e.g. "Top 10 products by total revenue". Put the most likely option first. Keep the follow-up question short and friendly.

STEP 2 — Otherwise answer (action "answer").
- Exactly one read-only SELECT (or WITH ... SELECT) in DuckDB syntax. Double-quote every column and table name.
- Output columns: grouping columns first, then measures. Give measures plain snake_case names such as total_revenue, average_price, order_count.
- Totals use SUM, averages AVG, counts COUNT(*) or COUNT(DISTINCT ...). Round money and averages to 2 decimals with ROUND(x, 2).
- Correct numbers (standard BI rules):
  - A rate, margin or percentage over many rows is worked out from totals, e.g. SUM("profit") / NULLIF(SUM("revenue"), 0) * 100, never AVG of a per-row percentage column, unless the user asks for "the average of" that column.
  - "Average per order / customer / store": total divided by distinct count, e.g. SUM("sales") / COUNT(DISTINCT "order_id"), above all when that ID is marked as repeating (several rows per order). AVG over rows is the average per line.
  - Columns marked "per-item figure" (price, age, rating) are averaged, never added up. A total value of items is SUM(price * quantity) when there is a quantity column.
  - Balances, stock levels and headcounts are snapshots: never SUM them across dates; use the value on the latest date, or AVG over the period.
  - Counting customers, products or orders uses COUNT(DISTINCT id); counting rows uses COUNT(*).
  - Share or % of total: divide by the total of ALL rows (SUM(x) OVER ()) computed before any LIMIT, so shares are of the whole, not of the top 10.
  - Change and growth: (new - old) / NULLIF(old, 0) * 100, so a change from 0 is blank, not infinite.
  - Divide with NULLIF(denominator, 0). Blank (NULL) values are left out of averages; never treat them as 0 unless asked.
  - Rates ("no-show rate", "% that churned"): ROUND(100.0 * COUNT_IF(condition) / COUNT(*), 1) named like no_show_rate_pct (0 to 100), with the number of rows beside it (e.g. appointments). BOOLEAN columns are tested directly: WHERE "x", NOT "x", COUNT_IF("x").
  - Never SUM or AVG an identifier, and never SUM a yes/no column as if it were an amount.
- Rankings ("top", "best", "highest"): ORDER BY the measure DESC with LIMIT 10 unless the user gave a number. For "which is the best X", still return the top 10 so the answer can be compared; the first row is the answer.
- Changes over time: group by DATE_TRUNC('month', CAST(date_column AS DATE)) (or the grain asked for) AS period, ORDER BY period. Numeric year columns are compared as numbers.
- Relative dates ("this year", "last month", "recent") are measured from the latest date in the data, never from today: use (SELECT MAX(CAST(date_column AS DATE)) FROM "data") in the query. Never use CURRENT_DATE or NOW().
- You do not know the values stored in text columns. Match text the user typed case-insensitively, e.g. LOWER("region") = LOWER('london'), or ILIKE '%term%' for partial names.
- Highest and lowest (or best and worst, top and bottom) item per group or period, e.g. "month-wise highest and lowest sales for products": return ONE row per group with columns named like period, highest_product, highest_total_sales, lowest_product, lowest_total_sales (use QUALIFY/ROW_NUMBER or ARG_MAX/ARG_MIN). Always include the item's name, not just the number.
- Listing records: return only the useful columns with LIMIT 200.
- Never return more than 500 rows.

Plain words for the person reading (they are not technical):
- "title", "question" and "explanation" use everyday words and write column names as plain words ("weekly sales", never weekly_sales). No SQL, code, "= true" or jargon (query, aggregate, dimension, metric, linear, null).
- "explanation" says in one short sentence what was worked out, e.g. "Added up weekly sales for each store." Never state numbers from the data.
- Yes/no columns are named in words: "holiday weeks vs other weeks", never 1/0 or true/false.
- "Today", "now" or "this week": the data is not live, so use the latest date in the data and say so in the title, e.g. "Sales on the latest day in your data".
- Follow-up options in "clarify" are plain questions a person would ask.

Return ONLY one JSON object, no prose:
{"action":"answer","title":"short plain-English chart title","question":"the full question you answered, written so it makes sense on its own","sql":"SELECT ...","dimensions":["grouping output column"],"measures":["measure output column"],"explanation":"one sentence: what was calculated, including any assumption"}
or
{"action":"clarify","question":"short follow-up","options":[{"label":"Total revenue","question":"Top 10 products by total revenue"}]}
or
{"action":"chat","message":"your reply in words","suggestions":["example question"]}`;

/** Added to the prompt only when earlier turns are sent with a follow-up. */
export const LEAN_CONTEXT_RULES = `

CONVERSATION
You also get EARLIER IN THIS CHAT: the previous questions and the SQL that answered them (no results).
- If the new message builds on them ("now by month", "only 2024", "what about profit?", "show it as a pie", "top 5 only"), start from the most recent SQL and change only what the message asks.
- If the new message is a different topic, ignore the earlier chat completely.
- Always fill "question" with the complete standalone question you answered, and add "follow_up": true if you used the earlier chat, otherwise false.
- If the user says something is missing or wrong in the last answer ("I can't see the product names"), fix the query so the answer includes it.
- Asking a follow-up (action "clarify") follows the same rules as before; do not ask about anything the earlier chat already settles.`;

// ── Helpers (exported for tests) ─────────────────────────────────────

/** Parse and check the model's JSON reply. */
/** Words a person reads: "weekly_sales" → "weekly sales" (SQL and column lists are left alone). */
const unsnake = (text: string) => text.replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, '$1 ');

export function parseLeanReply(content: string): LeanModelReply {
    const text = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let raw: any = null;
    if (start >= 0 && end > start) {
        try { raw = JSON.parse(text.slice(start, end + 1)); } catch { raw = null; }
    }
    if (!raw || typeof raw !== 'object') {
        // A bare SQL reply is still usable.
        const sqlMatch = text.match(/\b(with|select)\b[\s\S]+/i);
        if (sqlMatch) return { action: 'answer', sql: sqlMatch[0].trim() };
        throw new AISQLPipelineError('ai_sql_unavailable', 'The AI reply could not be read. Please try again.');
    }
    if (raw.action === 'overview') return { action: 'overview' };
    if (raw.action === 'chat') {
        const message = String(raw.message || '').trim().slice(0, 1200);
        const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).map((item: unknown) => unsnake(String(item).trim())).filter(Boolean).slice(0, 3);
        if (message) return { action: 'chat', message, suggestions };
    }
    if (raw.action === 'clarify') {
        const options: ClarificationOption[] = (Array.isArray(raw.options) ? raw.options : [])
            .map((option: any) => ({
                label: unsnake(String(option?.label || option?.question || '').trim()).slice(0, 60),
                question: unsnake(String(option?.question || option?.label || '').trim()).slice(0, 300),
            }))
            .filter((option: ClarificationOption) => option.label && option.question)
            .slice(0, 4);
        const question = String(raw.question || '').trim() || 'What would you like to measure?';
        return { action: 'clarify', question, options };
    }
    const sql = String(raw.sql || '').trim();
    if (!sql) throw new AISQLPipelineError('ai_sql_unavailable', 'The AI did not write a query. Please try rephrasing the question.');
    return {
        action: 'answer',
        sql,
        title: typeof raw.title === 'string' ? unsnake(raw.title.trim()).slice(0, 140) : undefined,
        dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.map(String) : undefined,
        measures: Array.isArray(raw.measures) ? raw.measures.map(String) : undefined,
        explanation: typeof raw.explanation === 'string' ? unsnake(raw.explanation.trim()).slice(0, 400) : undefined,
        question: typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim().slice(0, 300) : undefined,
        followUp: typeof raw.follow_up === 'boolean' ? raw.follow_up : typeof raw.followUp === 'boolean' ? raw.followUp : undefined,
    };
}

/**
 * Remove data values from a database error before it is sent for repair:
 * quoted text ('Jane Smith'), long numbers and dates become placeholders.
 * Column names, types and the error kind are kept so the repair still works.
 */
export function scrubErrorForModel(error: string): string {
    return String(error || '')
        .replace(/'(?:[^']|'')*'/g, "'…'")
        .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T][\d:.]+)?\b/g, '<date>')
        .replace(/\b\d{5,}(?:\.\d+)?\b/g, '<number>')
        .slice(0, 600);
}

const TIME_NAME = /(^|_)(date|day|week|month|quarter|year|period|time|timestamp)($|_)/i;
/** A rate or share: averaged, compared in points, never added up. */
const RATE_COLUMN = /(^|_)(rate|pct|percent|percentage|share|ratio|proportion)($|_)/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([ T].*)?$/;

/** Infer the analysis shape from the returned columns (used by the chart picker). */
export function planFromResult(
    question: string,
    rows: Record<string, any>[],
    hints: { dimensions?: string[]; measures?: string[] } = {},
): AnalysisPlan {
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const isNumeric = (column: string) => rows.slice(0, 50).every(row => row[column] === null || row[column] === undefined || typeof row[column] === 'number' || typeof row[column] === 'bigint' || (typeof row[column] === 'string' && row[column].trim() !== '' && Number.isFinite(Number(row[column])) && !ISO_DATE.test(row[column])));
    const isTime = (column: string) => TIME_NAME.test(column) || rows.slice(0, 20).some(row => row[column] instanceof Date || (typeof row[column] === 'string' && ISO_DATE.test(row[column])));

    const hintedDims = (hints.dimensions || []).filter(column => columns.includes(column));
    const hintedMeasures = (hints.measures || []).filter(column => columns.includes(column) && !hintedDims.includes(column));
    // A numeric "year" or "month" column is a grouping, not a measure.
    let measures = hintedMeasures.length ? hintedMeasures : columns.filter(column => isNumeric(column) && !TIME_NAME.test(column));
    // "No-show rate by neighbourhood": the rate leads, the count beside it follows.
    const rate = measures.find(column => RATE_COLUMN.test(column));
    if (rate && measures[0] !== rate && !/\b(how many|count|number of)\b/i.test(question)) measures = [rate, ...measures.filter(column => column !== rate)];
    const dimensions = hintedDims.length ? hintedDims : columns.filter(column => !measures.includes(column));

    const planDimensions: PlanDimension[] = dimensions.map(field => {
        if (!isTime(field)) return { field };
        const grain = /quarter/i.test(field) ? 'quarter' : /year/i.test(field) && !/month/i.test(field) ? 'year' : /week/i.test(field) ? 'week' : /day|date/i.test(field) ? 'day' : 'month';
        return { field, timeGrain: grain };
    });
    const planMetrics: PlanMetric[] = measures.map(field => ({
        field,
        agg: /^(avg|average|mean)_|_(avg|average|mean)$/i.test(field) || RATE_COLUMN.test(field) ? 'avg'
            : /count|number_of|^n_/i.test(field) ? 'count'
                : /^(max|highest)_/i.test(field) ? 'max'
                    : /^(min|lowest)_/i.test(field) ? 'min' : 'sum',
    }));

    const hasTime = planDimensions.some(dimension => dimension.timeGrain);
    const ranking = /\b(top|bottom|best|worst|highest|lowest|most|least|leading|rank)\b/i.test(question);
    const share = /\b(share|percent(age)? of|proportion|split|mix|breakdown)\b/i.test(question);
    let intent: AnalysisIntent;
    if (!planMetrics.length) intent = 'projection';
    else if (!planDimensions.length) intent = 'single_metric';
    else if (hasTime) intent = 'trend';
    else if (ranking) intent = 'ranking';
    else if (share) intent = 'share_of_total';
    else intent = 'breakdown';

    const firstMeasure = planMetrics[0]?.field;
    return {
        intent,
        dimensions: planDimensions,
        metrics: planMetrics,
        filters: [],
        sort: hasTime && planDimensions[0]
            ? [{ field: planDimensions[0].field, dir: 'asc' }]
            : firstMeasure ? [{ field: firstMeasure, dir: 'desc' }] : [],
        limit: null,
        ambiguous: false,
        resultGrain: planDimensions.map(dimension => dimension.field).join(' × ') || 'summary',
        originalQuestion: question,
    };
}

const plainWords = (column: string) => column.replace(/_/g, ' ').trim();
let insightCurrencySymbol = '';
const currencySymbolFor = (code?: string): string => {
    if (!code) return '';
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).formatToParts(0).find(part => part.type === 'currency')?.value || '';
    } catch { return ''; }
};
const formatNumber = (value: number) => {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    const symbol = insightCurrencySymbol;
    if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e4) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}K`;
    return `${sign}${symbol}${Number.isInteger(abs) ? abs.toLocaleString() : abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

const NOT_MONEY = /(count|number|num_|qty|quantity|units|orders|customers|pct|percent|share|ratio|rate|margin|rank)/i;
/**
 * The currency of the answer's main measure, read from the uploaded file's
 * columns that the SQL uses (e.g. SUM("revenue") where revenue is in £).
 * Undefined when the SQL mixes currencies or the measure is not money.
 */
export function resultCurrency(sql: string, measure: string | undefined, columns: Dataset['columns']): string | undefined {
    if (!measure || NOT_MONEY.test(measure)) return undefined;
    const text = sql.toLowerCase();
    // A count of rows is never money, whatever column the query filters on.
    const alias = measure.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`count\\s*\\([^)]*\\)\\s+as\\s+"?${alias}"?(?![a-z0-9_])`).test(text)) return undefined;
    const used = new Set(
        (columns || [])
            .filter(column => column.currency && (text.includes(`"${column.name.toLowerCase()}"`) || new RegExp(`\\b${column.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)))
            .map(column => column.currency as string),
    );
    return used.size === 1 ? [...used][0] : undefined;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2024-01-01" → "Jan 2024" for month periods, "5 Mar 2024" for days. */
export function periodLabel(value: unknown, grain?: string): string {
    const date = value instanceof Date ? value : typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime())) return String(value ?? '');
    const month = MONTHS[date.getUTCMonth()];
    const year = date.getUTCFullYear();
    if (grain === 'year') return String(year);
    if (grain === 'quarter') return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${year}`;
    if (grain === 'day' || grain === 'week' || date.getUTCDate() !== 1) return `${date.getUTCDate()} ${month} ${year}`;
    return `${month} ${year}`;
}
const pct = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

/**
 * A few plain-English insights calculated from the returned rows, in the
 * browser. Each one states a fact that is visible in the result.
 */
export function buildInsights(rows: Record<string, any>[], profile: ResultProfile, plan: AnalysisPlan, currency?: string): string[] {
    insightCurrencySymbol = currencySymbolFor(currency);
    if (!rows.length) return [];
    const metric = profile.metricColumns.find(column => column in rows[0]) || plan.metrics[0]?.field;
    const dimension = profile.dimensionColumns.find(column => column in rows[0]) || plan.dimensions[0]?.field;
    if (!metric) return [];
    const values = rows.map(row => Number(row[metric])).filter(Number.isFinite);
    if (!values.length) return [];
    const label = plainWords(metric);
    const insights: string[] = [];

    if (!dimension || rows.length === 1) return insights;

    const timeGrain = plan.dimensions.find(item => item.field === dimension)?.timeGrain;
    const isTime = Boolean(profile.hasTimeDimension && profile.timeDimensionColumn === dimension) || Boolean(timeGrain);
    if (isTime && rows.length >= 2) {
        const when = (row: Record<string, any>) => periodLabel(row[dimension], /^(quarter|year)$/.test(dimension) ? dimension : timeGrain);
        const first = Number(rows[0][metric]);
        const last = Number(rows[rows.length - 1][metric]);
        if (RATE_COLUMN.test(metric) && Number.isFinite(first) && Number.isFinite(last)) {
            const unit = /(pct|percent)/i.test(metric) ? '%' : '';
            const diff = last - first;
            insights.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} ${diff >= 0 ? 'rose' : 'fell'} from ${first.toLocaleString('en-GB', { maximumFractionDigits: 1 })}${unit} in ${when(rows[0])} to ${last.toLocaleString('en-GB', { maximumFractionDigits: 1 })}${unit} in ${when(rows[rows.length - 1])}${unit ? ` (${Math.abs(diff).toLocaleString('en-GB', { maximumFractionDigits: 1 })} points)` : ''}.`);
        } else if (Number.isFinite(first) && first !== 0 && Number.isFinite(last)) {
            const change = ((last - first) / Math.abs(first)) * 100;
            insights.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} ${change >= 0 ? 'rose' : 'fell'} ${pct(Math.abs(change))} from ${when(rows[0])} to ${when(rows[rows.length - 1])}.`);
        }
        const peak = rows.reduce((best, row) => (Number(row[metric]) > Number(best[metric]) ? row : best), rows[0]);
        const low = rows.reduce((best, row) => (Number(row[metric]) < Number(best[metric]) ? row : best), rows[0]);
        insights.push(`The highest was ${formatNumber(Number(peak[metric]))} in ${when(peak)}; the lowest was ${formatNumber(Number(low[metric]))} in ${when(low)}.`);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        insights.push(`On average ${formatNumber(average)} per period across ${rows.length} periods.`);
        return insights.slice(0, 3);
    }

    const ranked = [...rows].filter(row => Number.isFinite(Number(row[metric]))).sort((a, b) => Number(b[metric]) - Number(a[metric]));
    const total = ranked.reduce((sum, row) => sum + Number(row[metric]), 0);
    const leader = ranked[0];
    const runner = ranked[1];
    const allPositive = ranked.every(row => Number(row[metric]) >= 0);
    if (RATE_COLUMN.test(metric)) {
        // Rates are compared in points and never added up.
        const unit = /(pct|percent)/i.test(metric) ? '%' : '';
        const show = (row: Record<string, any>) => `${Number(row[metric]).toLocaleString('en-GB', { maximumFractionDigits: 1 })}${unit}`;
        const last = ranked[ranked.length - 1];
        if (leader && runner) insights.push(`${leader[dimension]} is highest at ${show(leader)}, ${(Number(leader[metric]) - Number(runner[metric])).toLocaleString('en-GB', { maximumFractionDigits: 1 })} ${unit ? 'points ' : ''}above ${runner[dimension]} (${show(runner)}).`);
        if (last && ranked.length >= 3) insights.push(`${last[dimension]} is lowest at ${show(last)}.`);
        const count = Object.keys(rows[0]).find(column => column !== metric && column !== dimension && /(count|appointments|rows|records|number|n_|total|patients|customers|orders|cases)/i.test(column) && rows.every(row => Number.isFinite(Number(row[column]))));
        if (count && ranked.length >= 3) {
            const small = ranked.filter(row => Number(row[count]) < 30);
            if (small.length) insights.push(`${small.length} of these ${small.length === 1 ? 'is' : 'are'} based on fewer than 30 rows, so ${small.length === 1 ? 'its rate' : 'their rates'} can swing a lot by chance.`);
        }
        return insights.slice(0, 3);
    }
    if (leader && runner && Number(runner[metric]) !== 0) {
        const gap = ((Number(leader[metric]) - Number(runner[metric])) / Math.abs(Number(runner[metric]))) * 100;
        insights.push(gap < 1
            ? `${leader[dimension]} and ${runner[dimension]} are almost level (${formatNumber(Number(leader[metric]))} vs ${formatNumber(Number(runner[metric]))}).`
            : `${leader[dimension]} is ${pct(gap)} ahead of ${runner[dimension]} (${formatNumber(Number(leader[metric]))} vs ${formatNumber(Number(runner[metric]))}).`);
    }
    if (allPositive && total > 0 && ranked.length >= 3 && plan.metrics[0]?.agg !== 'avg') {
        const topThree = ranked.slice(0, 3).reduce((sum, row) => sum + Number(row[metric]), 0);
        insights.push(`The top 3 make up ${pct((topThree / total) * 100)} of the ${label} shown.`);
    }
    if (ranked.length >= 3) {
        const last = ranked[ranked.length - 1];
        const spread = Number(leader[metric]) !== 0 ? (Number(last[metric]) / Number(leader[metric])) * 100 : null;
        insights.push(`${last[dimension]} is lowest at ${formatNumber(Number(last[metric]))}${spread !== null && allPositive ? ` — ${pct(spread)} of the leader` : ''}.`);
    }
    return insights.slice(0, 3);
}

// ── Averages that mislead ────────────────────────────────────────────

/**
 * For a simple average query (AVG of one column, optionally grouped by one
 * column, no WHERE), check the source rows here in the browser and warn when
 * the average hides very uneven values (100, 0, 0, 0 → 25).
 */
export function averageCautionForSql(sql: string, sourceRows: Record<string, any>[], dimensions: string[] = []): string | null {
    const text = sql.replace(/\s+/g, ' ');
    const averages = [...text.matchAll(/\bAVG\s*\(\s*"?([A-Za-z0-9_ ]+?)"?\s*\)/gi)].map(match => match[1]);
    if (averages.length !== 1 || /\bWHERE\b|\bHAVING\b|\bJOIN\b|\bQUALIFY\b/i.test(text) || !sourceRows.length) return null;
    const column = Object.keys(sourceRows[0]).find(name => name.toLowerCase() === averages[0].toLowerCase());
    if (!column) return null;
    const groupBy = text.match(/\bGROUP BY (.+?)(?: ORDER BY| LIMIT|$)/i)?.[1];
    const label = column.replace(/_/g, ' ');
    if (!groupBy) {
        const caution = averageCaution(sourceRows.map(row => row[column]));
        return caution ? caution.message.replace('The average', `The average ${label}`) : null;
    }
    const dimension = dimensions.find(name => Object.prototype.hasOwnProperty.call(sourceRows[0], name));
    if (!dimension || dimensions.length !== 1) return null;
    const groups = new Map<string, unknown[]>();
    for (const row of sourceRows) {
        const key = String(row[dimension] ?? '');
        const list = groups.get(key);
        if (list) list.push(row[column]); else groups.set(key, [row[column]]);
    }
    const flagged = [...groups.entries()].map(([key, values]) => ({ key, caution: averageCaution(values) })).filter(item => item.caution);
    if (!flagged.length) return null;
    return groupedAverageMessage(label, dimension, groups.size, flagged as { key: string; caution: NonNullable<ReturnType<typeof averageCaution>> }[]);
}

// ── Highest / lowest per group ───────────────────────────────────────

const ROLE_WORD = /^(highest|lowest|top|bottom|best|worst|max|min|maximum|minimum|most|least|largest|smallest)$/i;
const roleOf = (text: string): string | null => {
    const first = text.toLowerCase().split(/[_\s-]+/)[0];
    return ROLE_WORD.test(first) ? first : null;
};
const ASKS_FOR_EXTREMES = /\b(highest|lowest|top|bottom|best|worst|max(imum)?|min(imum)?|most|least)\b[\s\S]*\b(and|&|vs|versus)\b[\s\S]*\b(highest|lowest|top|bottom|best|worst|max(imum)?|min(imum)?|most|least)\b|\b(highest|top|best)\b.*\b(each|every|per|wise|by)\b/i;

export interface ExtremesShape {
    /** One row per group: the group, then each role's item and value. */
    rows: Record<string, any>[];
    group: string;
    /** e.g. [{ role: 'highest', item: 'highest_product', value: 'highest_total_sales' }] */
    roles: { role: string; item: string; value: string }[];
    /** What the items are ("product") and what is measured ("total sales"). */
    itemName: string;
    measureName: string;
}

const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const titleWord = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Recognise "the highest and lowest item for each group" answers and return
 * them one row per group, with every item name kept. Handles the wide form
 * (highest_product, highest_sales, …) and the long form (month, product,
 * sales[, type]) that would otherwise be drawn as one zig-zag line with the
 * names thrown away.
 */
export function normaliseExtremes(rows: Record<string, any>[], question: string): ExtremesShape | null {
    if (rows.length < 2) return null;
    const columns = Object.keys(rows[0]);
    const numeric = columns.filter(column => rows.every(row => row[column] === null || row[column] === undefined || isNumber(row[column])) && rows.some(row => isNumber(row[column])));
    const text = columns.filter(column => !numeric.includes(column));

    // Wide form: measures and items that share a role prefix.
    const roles = numeric
        .map(value => ({ value, role: roleOf(value) }))
        .filter((entry): entry is { value: string; role: string } => Boolean(entry.role))
        .map(entry => ({ ...entry, item: text.find(column => roleOf(column) === entry.role) || '' }))
        .filter(entry => entry.item);
    if (roles.length >= 1) {
        const group = text.find(column => !roleOf(column)) || columns.find(column => !roles.some(role => role.item === column || role.value === column));
        if (!group) return null;
        const itemName = roles[0].item.split(/_/).slice(1).join(' ') || 'item';
        const measureName = roles[0].value.split(/_/).slice(1).join(' ') || 'value';
        return { rows, group, roles: roles.map(({ role, item, value }) => ({ role, item, value })), itemName, measureName };
    }

    // Long form: a group column, an item column and one measure, a few rows per group.
    if (numeric.length !== 1 || text.length < 2 || !ASKS_FOR_EXTREMES.test(question)) return null;
    const measure = numeric[0];
    const roleColumn = text.find(column => {
        const values = new Set(rows.map(row => String(row[column] ?? '')));
        return values.size >= 2 && values.size <= 4 && [...values].every(value => Boolean(roleOf(value)));
    });
    const candidates = text.filter(column => column !== roleColumn);
    // The group repeats; the item changes within a group.
    const distinct = (column: string) => new Set(rows.map(row => String(row[column] ?? ''))).size;
    // A date column is the group; otherwise the column that repeats most.
    const group = candidates.find(column => rows.every(row => ISO_DATE.test(String(row[column] ?? ''))))
        || [...candidates].sort((a, b) => distinct(a) - distinct(b))[0];
    const item = candidates.find(column => column !== group);
    if (!group || !item) return null;
    const byGroup = new Map<string, Record<string, any>[]>();
    for (const row of rows) {
        const key = String(row[group] ?? '');
        byGroup.set(key, [...(byGroup.get(key) || []), row]);
    }
    if (byGroup.size < 2 || [...byGroup.values()].some(list => list.length > 4)) return null;

    const roleNames = roleColumn
        ? [...new Set(rows.map(row => String(row[roleColumn]).toLowerCase().split(/[_\s-]+/)[0]))]
        : ['highest', 'lowest'];
    const measureName = measure.replace(/_/g, ' ');
    const itemName = item.replace(/_/g, ' ');
    const roleSpecs = roleNames.map(role => ({ role, item: `${role}_${item}`, value: `${role}_${measure}` }));
    const wide = [...byGroup.entries()].map(([key, list]) => {
        const out: Record<string, any> = { [group]: list[0][group] };
        if (roleColumn) {
            for (const row of list) {
                const role = String(row[roleColumn]).toLowerCase().split(/[_\s-]+/)[0];
                out[`${role}_${item}`] = row[item];
                out[`${role}_${measure}`] = row[measure];
            }
        } else {
            const sorted = [...list].sort((a, b) => Number(b[measure]) - Number(a[measure]));
            out[`highest_${item}`] = sorted[0][item];
            out[`highest_${measure}`] = sorted[0][measure];
            out[`lowest_${item}`] = sorted[sorted.length - 1][item];
            out[`lowest_${measure}`] = sorted[sorted.length - 1][measure];
        }
        return out;
    }).sort((a, b) => String(a[group]).localeCompare(String(b[group])));
    return { rows: wide, group, roles: roleSpecs, itemName, measureName };
}

/** Summary and key points for a highest/lowest-per-group answer. */
export function extremesNarrative(shape: ExtremesShape, currency?: string): { summary: string; insights: string[] } {
    insightCurrencySymbol = currencySymbolFor(currency);
    const isTime = shape.rows.every(row => ISO_DATE.test(String(row[shape.group] ?? '')));
    const when = (row: Record<string, any>) => isTime ? periodLabel(row[shape.group]) : String(row[shape.group]);
    const groupWord = isTime ? 'period' : shape.group.replace(/_/g, ' ');
    const roleList = shape.roles.map(role => role.role).join(' and ');
    const summary = `For each ${groupWord}, the ${shape.itemName} with the ${roleList} ${shape.measureName} — ${shape.rows.length} ${groupWord}${shape.rows.length === 1 ? '' : 's'} in all.`;
    const insights: string[] = [];
    const first = shape.roles[0];
    const last = shape.roles[shape.roles.length - 1];
    const valid = (key: string) => shape.rows.filter(row => isNumber(row[key]));
    const peak = valid(first.value).sort((a, b) => b[first.value] - a[first.value])[0];
    if (peak) insights.push(`${titleWord(first.role)} overall: ${peak[first.item]} with ${formatNumber(peak[first.value])} in ${when(peak)}.`);
    if (last !== first) {
        const trough = valid(last.value).sort((a, b) => a[last.value] - b[last.value])[0];
        if (trough) insights.push(`${titleWord(last.role)} overall: ${trough[last.item]} with ${formatNumber(trough[last.value])} in ${when(trough)}.`);
    }
    for (const role of [first, last].filter((role, index, list) => list.indexOf(role) === index)) {
        const counts = new Map<string, number>();
        for (const row of shape.rows) if (row[role.item] !== null && row[role.item] !== undefined) counts.set(String(row[role.item]), (counts.get(String(row[role.item])) || 0) + 1);
        const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
        if (name && count && count > 1) insights.push(`${name} was the ${role.role} ${shape.itemName} in ${count} of ${shape.rows.length} ${groupWord}s.`);
    }
    return { summary, insights: insights.slice(0, 4) };
}

// ── The pipeline ─────────────────────────────────────────────────────

const sqlName = (name: string) => `"${name.replace(/"/g, '""')}"`;

function columnType(field: SemanticField, storedAsNumber?: boolean): string {
    if (storedAsNumber && field.physicalType !== 'date') return field.semanticType === 'date' || /year|month|quarter|week/i.test(field.name) ? 'INTEGER (a year or period number)' : 'NUMBER';
    if (field.physicalType === 'number') return field.semanticType === 'date' ? 'INTEGER (a year or period number)' : 'NUMBER';
    if (field.physicalType === 'date') return "TEXT date 'YYYY-MM-DD' — use CAST(col AS DATE) for date maths";
    if (field.physicalType === 'boolean') return 'BOOLEAN';
    return 'TEXT';
}

function columnRole(field: SemanticField, perItem = false, repeats = false, extra: ColumnExtras = {}): string {
    const yesNo = extra.yesNo?.get(field.name);
    if (yesNo) return yesNo === 'boolean' ? 'yes/no' : yesNo === 'number' ? 'yes/no as 1/0' : "yes/no as text: test it with LOWER(col) IN ('yes','y','true','t','1')";
    if (extra.ids?.has(field.name) && !(field.keyRole && field.keyRole !== 'none') && field.semanticType !== 'identifier') {
        return repeats ? 'identifier (repeats: several rows share one value)' : 'identifier (unique per row)';
    }
    if (extra.perRowNumbers?.has(field.name) && field.role !== 'metric') return 'number describing each row (like an age or a number of days): average it or group it into ranges, never add it up';
    const base = columnRoleBase(field);
    if (repeats && base.startsWith('identifier')) return 'identifier (repeats: several rows share one value, e.g. the lines of one order)';
    if (base === 'identifier' && extra.ids?.has(field.name)) return 'identifier (unique per row)';
    return perItem && base.startsWith('measure') ? `${base}; a per-item figure: average it, never SUM it` : base;
}

/** What the browser knows about how each column is stored and used (no values). */
interface ColumnExtras {
    ids?: Set<string>;
    perRowNumbers?: Set<string>;
    /** yes/no columns and how they are stored in the database. */
    yesNo?: Map<string, 'boolean' | 'number' | 'text'>;
    /** The DATA SHAPE block (from datasetShape). */
    shape?: string;
}

function columnRoleBase(field: SemanticField): string {
    if (field.keyRole && field.keyRole !== 'none') return field.keyRole === 'primary_key' ? 'identifier (unique per row)' : 'identifier';
    if (field.semanticType === 'identifier') return 'identifier';
    if (field.semanticType === 'date' || field.physicalType === 'date') return 'date';
    if (field.role === 'metric') {
        if (field.semanticType === 'currency') return 'measure (money)';
        if (field.semanticType === 'percentage') return 'measure (percentage)';
        if (field.semanticType === 'ratio') return 'measure (ratio)';
        if (field.semanticType === 'count') return 'measure (count)';
        return 'measure';
    }
    return 'category';
}

/**
 * Metadata only: table and column names, storage types, roles and how
 * tables join. Nothing derived from the values (no ranges, counts, sample
 * values or dates) is included.
 */
export function describeColumnsOnly(
    model: SemanticModel,
    join?: { tables: { name: string; columns: { name: string; isPK?: boolean }[] }[]; links: { leftTable: string; leftColumn: string; rightTable: string; rightColumn: string; cardinality?: string }[] } | null,
    numericColumns: Set<string> = new Set(),
    perItem: Set<string> = new Set(),
    repeatingIds: Set<string> = new Set(),
    extra: ColumnExtras = {},
): string {
    const lines = ['Table "data" columns:'];
    for (const field of model.fields) {
        const yesNo = extra.yesNo?.get(field.name);
        const type = yesNo === 'boolean' ? 'BOOLEAN' : yesNo === 'text' ? 'TEXT' : columnType(field, numericColumns.has(field.name));
        lines.push(`- ${sqlName(field.name)}: ${type}; ${columnRole(field, perItem.has(field.name), repeatingIds.has(field.name), extra)}`);
    }
    if (extra.shape) lines.push('', extra.shape);
    if (join?.tables?.length) {
        lines.push('', 'The data came from several tables. "data" holds the main table. Related tables:');
        for (const table of join.tables) {
            lines.push(`- ${sqlName(table.name)}: ${table.columns.map(column => `${column.name}${column.isPK ? ' [key]' : ''}`).join(', ')}`);
        }
        if (join.links?.length) {
            lines.push('Join on:');
            for (const link of join.links) {
                lines.push(`- ${link.leftTable}.${link.leftColumn} = ${link.rightTable}.${link.rightColumn}${link.cardinality ? ` (${link.cardinality.replace(/_/g, ':')})` : ''}`);
            }
            lines.push('Aggregate before joining one-to-many so totals are not double-counted.');
        }
    }
    return lines.join('\n');
}

/** Stored as a number in the database (the same test the loader uses). */
const storedNumber = (value: unknown) => typeof value === 'number'
    || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) && !/^-?0\d/.test(value.trim()));

export function describeData(dataset: Dataset) {
    const { model } = resolveAISQLSemanticModel(dataset);
    const join = discoverJoinContext(dataset.relatedTables, dataset.sourceSchema);
    // How each column is stored in the browser (a type, never a value).
    const sample = dataset.rows.slice(0, 2000);
    const filled = (name: string) => sample.map(row => row[name]).filter(value => value !== null && value !== undefined && value !== '');
    const numericColumns = new Set(model.fields.map(field => field.name).filter(name => {
        const values = filled(name);
        return values.length > 0 && values.every(storedNumber);
    }));
    // The table's grain (does an ID repeat?) — a fact about its shape, not its values.
    const shape = describeDatasetShape(dataset);
    const etlIds = new Set(dataset.columns.filter(column => column.type === ColumnType.ID).map(column => column.name));
    const idNames = new Set([...etlIds, ...(shape.rowId ? [shape.rowId] : []), ...shape.entityIds]);
    const repeatingIds = new Set(model.fields
        .filter(field => (field.keyRole && field.keyRole !== 'none') || field.semanticType === 'identifier' || idNames.has(field.name))
        .map(field => field.name)
        .filter(name => {
            const sample = dataset.rows.slice(0, 20000).map(row => row[name]).filter(v => v !== null && v !== undefined && v !== '');
            return sample.length > 1 && new Set(sample.map(String)).size < sample.length * 0.95;
        }));
    const yesNo = new Map<string, 'boolean' | 'number' | 'text'>();
    for (const name of shape.yesNo) {
        const values = filled(name);
        yesNo.set(name, values.every(isBooleanCell) ? 'boolean' : values.every(storedNumber) ? 'number' : 'text');
    }
    const yesTest = (name: string) => {
        const how = yesNo.get(name);
        return how === 'number' ? `${sqlName(name)} = 1` : how === 'text' ? `LOWER(${sqlName(name)}) IN ('yes','y','true','t','1')` : sqlName(name);
    };
    const extra: ColumnExtras = { ids: idNames, perRowNumbers: new Set(shape.perRowNumbers), yesNo, shape: shapeForModel(shape, yesTest) };
    return { model, schema: describeColumnsOnly(model, join, numericColumns, perItemColumns(dataset.columns, dataset.name), repeatingIds, extra) };
}

export async function runLeanAISQL(question: string, dataset: Dataset, options: LeanRunOptions = {}): Promise<AISQLPipelineResult> {
    const started = performance.now();
    const asked = `${question}${options.grain ? `\n(Group dates by ${options.grain}.)` : ''}${options.autoChoose ? '\n(Do not ask a follow-up. Choose the most likely measure and name it in the explanation.)' : ''}${options.requireAnalysis ? '\n(The user asked for an analysis of the data: answer with a query, or ask a follow-up if it is vague. Do not reply with action "chat".)' : ''}`;
    const context = options.context?.filter(turn => turn.question && turn.sql) || [];
    options.onProgress?.('Reading your columns');
    const { model, schema } = describeData(dataset);

    // ── 1. One AI call: ask, or write the query ──
    options.onProgress?.(context.length ? 'Building on the last answer' : 'Writing the query');
    const userContent = context.length
        ? `DATA DESCRIPTION\n${schema}\n\nEARLIER IN THIS CHAT\n${formatContextForPrompt(context)}\n\nNEW MESSAGE\n${asked}`
        : `DATA DESCRIPTION\n${schema}\n\nQUESTION\n${asked}`;
    const reply = await fetchWithFallback([
        { role: 'system', content: context.length ? `${LEAN_SYSTEM_PROMPT}${LEAN_CONTEXT_RULES}` : LEAN_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ], { model: PLANNER_MODEL, temperature: 0, max_tokens: 1600, timeout: 45_000, requestPurpose: options.requestPurpose });
    let tokens = Number(reply.data?.usage?.total_tokens) || 0;
    const parsed = parseLeanReply(reply.data?.choices?.[0]?.message?.content || '');

    if (parsed.action === 'overview') {
        if (options.autoChoose) throw new AISQLPipelineError('ai_sql_unavailable', 'Ask about one measure to get a chart.');
        throw new AISQLOverviewRequest(tokens);
    }
    if (parsed.action === 'chat') {
        if (options.autoChoose) throw new AISQLPipelineError('ai_sql_unavailable', 'That is not a question about the data, so there is nothing to chart.');
        throw new AISQLChatReplyError(parsed.message, parsed.suggestions, tokens);
    }
    if (parsed.action === 'clarify') {
        // Automatic runs take the most likely choice instead of stopping.
        if (options.autoChoose && parsed.options[0] && parsed.options[0].question !== question) {
            return runLeanAISQL(parsed.options[0].question, dataset, { ...options, autoChoose: false });
        }
        throw new AISQLClarificationError(parsed.question, parsed.options);
    }
    // The standalone question is what later follow-ups and the repair use.
    const standalone = parsed.question || question;

    // ── 2. Safety gate, then run locally; one repair if it fails ──
    let safety = validateReadOnlySQL(parsed.sql);
    if (!safety.ok) throw new AISQLPipelineError('sql_validation_failed', `The AI wrote a query that is not read-only (${safety.reason}). Please try again.`);
    let sql = safety.sql;
    options.onProgress?.('Running it on your data');
    let execution = await executeSQLViaDuckDB(dataset.rows, sql, model.timeContext as any, dataset.relatedTables);
    let repairAttempts = 0;
    if (execution.error) {
        repairAttempts = 1;
        options.onProgress?.('Fixing the query');
        // The repair gets the standalone question, not the chat: fewer tokens.
        const repaired = await fetchWithFallback([
            { role: 'system', content: `${LEAN_SYSTEM_PROMPT}\n\nThe query below failed in DuckDB. Return the same JSON shape with a corrected "sql". Keep the meaning of the question.` },
            { role: 'user', content: `DATA DESCRIPTION\n${schema}\n\nQUESTION\n${standalone}\n\nFAILED SQL\n${sql}\n\nDUCKDB ERROR (values removed)\n${scrubErrorForModel(execution.error)}` },
        ], { model: PLANNER_MODEL, temperature: 0, max_tokens: 1600, timeout: 45_000, requestPurpose: options.requestPurpose });
        tokens += Number(repaired.data?.usage?.total_tokens) || 0;
        const fixed = parseLeanReply(repaired.data?.choices?.[0]?.message?.content || '');
        if (fixed.action === 'answer') {
            safety = validateReadOnlySQL(fixed.sql);
            if (safety.ok) {
                sql = safety.sql;
                execution = await executeSQLViaDuckDB(dataset.rows, sql, model.timeContext as any, dataset.relatedTables);
                if (!parsed.dimensions && fixed.dimensions) parsed.dimensions = fixed.dimensions;
                if (!parsed.measures && fixed.measures) parsed.measures = fixed.measures;
            }
        }
    }
    if (execution.error) {
        throw new AISQLPipelineError('ai_sql_execution_failed', `The query could not run on your data: ${execution.error}`);
    }

    options.onProgress?.('Checking the numbers');
    const series = completeTimeSeries(sql, execution.data || [], parsed, model.timeContext, dataset);
    const cautions = [...await numberCautions(sql, execution.data || [], parsed.dimensions, dataset, model.timeContext, `${question} ${standalone}`), ...series.notes];
    options.onProgress?.('Choosing the chart');
    const result = buildLeanAnswer({
        question: standalone, sql, rows: series.rows, reply: parsed, model, dataset, started, repairAttempts, tokens, aiModel: reply.model, originalQuestion: question, cautions,
    });
    result.conversation = {
        standaloneQuestion: standalone,
        contextTurns: context.length,
        // The AI's own judgement: it built on the earlier chat only if it says so.
        usedContext: context.length > 0 && parsed.followUp === true,
    };
    return result;
}

export interface LeanAnswerInput {
    question: string;
    sql: string;
    rows: Record<string, any>[];
    reply: { title?: string; dimensions?: string[]; measures?: string[]; explanation?: string };
    model: ReturnType<typeof resolveAISQLSemanticModel>['model'];
    dataset: Dataset;
    started: number;
    repairAttempts: number;
    tokens: number;
    aiModel: string;
    /** The user's own words, when the AI restated the question. */
    originalQuestion?: string;
    /** Warnings from numberCautions (otherwise the quick in-memory check). */
    cautions?: string[];
}

/**
 * A monthly series: add months with no rows (so the line does not skip them)
 * and say when the last month is only partly in the data.
 */
/** The latest date in the data, read from the rows themselves (a stored range can be out of date). */
function latestDate(dataset: Dataset, timeContext: any): string | undefined {
    const anchor = dataset.timeContext?.anchorDateColumn || timeContext?.primaryDateColumn;
    const columns = dataset.columns.filter(item => String(item.type) === 'DATE' && (!anchor || item.name === anchor));
    let max = '';
    for (const column of columns.length ? columns : dataset.columns.filter(item => String(item.type) === 'DATE')) {
        for (const row of dataset.rows) {
            const value = String(row[column.name] ?? '').slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value > max) max = value;
        }
    }
    return max || (dataset.timeContext?.maxDate || timeContext?.maxDate || undefined);
}

function completeTimeSeries(sql: string, rows: Record<string, any>[], reply: { dimensions?: string[]; measures?: string[] }, timeContext: any, dataset?: Dataset): { rows: Record<string, any>[]; notes: string[] } {
    if (!rows.length) return { rows, notes: [] };
    const columns = Object.keys(rows[0]);
    const dims = (reply.dimensions || []).filter(name => columns.includes(name));
    const time = dims.find(name => rows.every(row => /^\d{4}-\d{2}(-01)?([T ].*)?$/.test(String(row[name] ?? ''))));
    if (!time || dims.length !== 1) return { rows, notes: [] };
    const measures = (reply.measures || []).filter(name => columns.includes(name));
    const notes: string[] = [];
    const filled = fillMonthlyGaps(rows, time, measures.length ? measures : columns.filter(name => name !== time && typeof rows[0][name] === 'number'), sql);
    const gap = missingMonthsNote(filled.missing, !/\b(AVG|MEDIAN|MIN|MAX|QUANTILE|STDDEV)\s*\(/i.test(sql));
    if (gap) notes.push(gap);
    const partial = partialMonthNote(filled.rows, time, dataset ? latestDate(dataset, timeContext) : timeContext?.maxDate, sql);
    if (partial) notes.push(partial);
    return { rows: filled.rows, notes };
}

/**
 * Warnings about the answer's numbers, worked out on this computer: the
 * query is run again with its average returned as the values behind it.
 */
async function numberCautions(sql: string, rows: Record<string, any>[], dimensions: string[] | undefined, dataset: Dataset, timeContext: any, question = ''): Promise<string[]> {
    const notes: string[] = [];
    for (const note of [
        averagedRatioNote(sql, dataset.columns),
        perLineAverageNote(sql, question, dataset.rows, dataset.columns),
        summedBalanceNote(sql, dataset.columns),
    ]) if (note) notes.push(note);
    try {
        const listQuery = averageValuesQuery(sql);
        if (listQuery && rows.length) {
            const dims = (dimensions || []).filter(name => Object.prototype.hasOwnProperty.call(rows[0], name));
            const listed = await executeSQLViaDuckDB(dataset.rows, listQuery.sql, timeContext, dataset.relatedTables);
            if (!listed.error && listed.data?.length) notes.push(...averageNotesFromValues(listed.data, rows.slice(0, 500), dims, listQuery.column));
        }
    } catch { /* the answer stands without the extra check */ }
    const sum = perItemSumNote(sql, dataset.columns, dataset.name);
    if (sum) notes.push(sum);
    return notes;
}

/** "hypertension_rate_pct" → "Hypertension", "total_revenue" → "Total revenue". */
function measureName(column: string): string {
    const words = column.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[_\s]+/).filter(Boolean);
    while (words.length > 1 && /^(rate|pct|percent|percentage|share|ratio|proportion)$/i.test(words[words.length - 1])) words.pop();
    const text = words.join(' ').toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "no_show_rate_pct" → "No show rate", "average_age" → "Average age". */
function singleName(column: string): string {
    const text = column.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\s]+(pct|percent|percentage)$/i, '').replace(/[_\s]+/g, ' ').trim().toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A single row holding several measures and no grouping, turned into one row
 * per measure so it reads as a list and charts as bars. When rates sit beside
 * counts or amounts, only the rates are drawn (one % axis) and the rest are
 * said in words ("out of 106,987 appointments").
 */
export function oneRowOfMeasures(rows: Record<string, any>[], hinted?: string[]): { rows: Record<string, any>[]; valueKey: string; summary: string; insights: string[]; single?: boolean } | null {
    if (rows.length !== 1) return null;
    const row = rows[0];
    const numeric = Object.keys(row).filter(key => typeof row[key] === 'number' || (typeof row[key] === 'string' && row[key].trim() !== '' && Number.isFinite(Number(row[key])) && !ISO_DATE.test(row[key])));
    const text = Object.keys(row).filter(key => !numeric.includes(key));
    const measures = (hinted || []).filter(key => numeric.includes(key)).concat(numeric.filter(key => !(hinted || []).includes(key)));
    if (measures.length < 2 || text.length) return null;
    const rates = measures.filter(key => RATE_COLUMN.test(key));
    // "average_age" beside "appointment_count": the count is how many rows it covers.
    const COUNT = /(^|_)(count|counts|rows|records|number_of|n)($|_)/i;
    const notCounts = measures.filter(key => !COUNT.test(key));
    const shown = rates.length >= 1 ? rates : notCounts.length && notCounts.length < measures.length ? notCounts : measures;
    if (shown.length < 2 && !(shown.length === 1 && measures.length > 1)) return null;
    const context = measures.filter(key => !shown.includes(key));
    const isRate = shown === rates && rates.length > 0;
    const valueKey = isRate ? 'share_pct' : 'value';
    const value = (key: string) => Number(row[key]);
    const show = (key: string) => isRate
        ? `${value(key).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
        : value(key).toLocaleString('en-GB', { maximumFractionDigits: 2 });
    const parts = shown.map(key => `${measureName(key).toLowerCase()} ${show(key)}`);
    parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    // Counts read as "out of 658 appointments"; other figures are listed beside the answer.
    const plural = (word: string) => /s$/.test(word) ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
    const countWords = (key: string) => {
        const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[_\s]+/).filter(word => word && !/^(count|counts|number|of|n|total)$/.test(word));
        if (!words.length) return 'rows';
        words[words.length - 1] = plural(words[words.length - 1]);
        return words.join(' ');
    };
    const out = context.filter(key => COUNT.test(key) || /(^|_)(appointments|orders|customers|patients|employees|rows|records|visits|tickets|cases|people)$/i.test(key))
        .map(key => `${value(key).toLocaleString('en-GB', { maximumFractionDigits: 0 })} ${countWords(key)}`);
    const beside = context.filter(key => !out.some(text => text.endsWith(countWords(key))) && !(COUNT.test(key) || /(^|_)(appointments|orders|customers|patients|employees|rows|records|visits|tickets|cases|people)$/i.test(key)))
        .map(key => `${singleName(key).toLowerCase()} ${value(key).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);
    const besideText = beside.length ? ` (${beside.join('; ')})` : '';
    if (shown.length === 1) {
        // One rate and the count behind it: the rate is the answer.
        const [rate] = shown;
        return {
            rows: [{ [rate]: value(rate) }],
            valueKey: rate,
            single: true,
            summary: `${singleName(rate)}: ${show(rate)}${out.length ? ` — ${isRate ? 'out of' : 'across'} ${out.join(' and ')}` : ''}${besideText}.`,
            insights: out.length ? [`Worked out over ${out.join(' and ')}.`] : [],
        };
    }
    return {
        rows: shown.map(key => ({ measure: measureName(key), [valueKey]: value(key) })),
        valueKey,
        summary: `${list}${out.length ? ` — out of ${out.join(' and ')}` : ''}${besideText}.`,
        insights: out.length ? [`Worked out over ${out.join(' and ')}.`] : [],
    };
}

/** Re-exported for tests: the shared rule lives in utils/answerGuard. */
export const partsOfAWhole = valuesArePartsOfWhole;

/** Chart, narrative and insights for an executed query — all local. */
export function buildLeanAnswer(input: LeanAnswerInput): AISQLPipelineResult {
    const { question, sql, reply: parsed, model, dataset, repairAttempts, tokens } = input;
    // SUM/AVG over a filter that matched nothing comes back as one row of blanks: that is "no rows matched".
    if (input.rows.length === 1 && Object.values(input.rows[0]).every(value => value === null || value === undefined)) input = { ...input, rows: [] };
    // Yes/no groupings read as words ("Holiday" / "Not holiday"), never 0 and 1.
    const returned = relabelYesNo(input.rows.slice(0, 500), parsed.dimensions || []).rows;
    // "Highest and lowest X per group": one row per group, item names kept.
    const extremes = normaliseExtremes(returned, `${question} ${input.originalQuestion || ''}`);
    // One row of several measures ("% with hypertension, % with diabetes, …,
    // appointments"): one bar per measure of the same kind; a count beside
    // rates is context, never drawn on the same % axis.
    const unpivoted = extremes ? null : oneRowOfMeasures(returned, parsed.measures);
    const rows = extremes ? extremes.rows : unpivoted ? unpivoted.rows : returned;
    const plan = extremes
        ? planFromResult(question, rows, { dimensions: [extremes.group], measures: extremes.roles.map(role => role.value) })
        : unpivoted
            ? planFromResult(question, rows, { dimensions: unpivoted.single ? [] : ['measure'], measures: [unpivoted.valueKey] })
            : planFromResult(question, rows, { dimensions: parsed.dimensions, measures: parsed.measures });
    const profile = profileResult(rows, plan, model);
    // The measure the plan leads with (a rate before the count beside it) leads the chart and insights too.
    const lead = plan.metrics[0]?.field;
    if (lead && profile.metricColumns.includes(lead) && profile.metricColumns[0] !== lead) {
        profile.metricColumns = [lead, ...profile.metricColumns.filter(column => column !== lead)];
    }
    if (extremes) {
        // The item columns are labels for the points, not groupings.
        const itemColumns = new Set(extremes.roles.map(role => role.item));
        profile.dimensionColumns = profile.dimensionColumns.filter(column => !itemColumns.has(column));
    }
    let chart: ChartRecommendation = recommendChart(profile, plan, model);
    // A pie or donut means "parts of one whole". Rates that overlap (a patient
    // with two conditions) or that don't add up to 100% are not parts: bars.
    if (['donut', 'doughnut', 'pie'].includes(String(chart.chartType)) && !partsOfAWhole(rows, chart.yKey)) {
        chart = { ...chart, chartType: rows.length > 6 ? 'horizontalBar' : 'bar', reason: `${chart.reason || ''} · values are not parts of one whole → bars`.trim() };
    }
    const reshaped = reshapeData(rows, profile, chart, plan);
    const currency = resultCurrency(sql, profile.metricColumns[0] || plan.metrics[0]?.field, dataset.columns);
    if (currency) reshaped.chart = { ...reshaped.chart, currency };
    if (extremes) {
        const isTime = Boolean(profile.hasTimeDimension && profile.timeDimensionColumn === extremes.group);
        const [primary, ...others] = extremes.roles.map(role => role.value);
        reshaped.chart = {
            ...reshaped.chart,
            chartType: isTime || rows.length > 15 ? 'multiLine' : 'bar',
            xKey: extremes.group,
            yKey: primary,
            secondaryYKeys: others,
            useDualAxis: false,
            singleAxis: true,
            pointLabelKeys: Object.fromEntries(extremes.roles.map(role => [role.value, role.item])),
            reason: 'Highest and lowest per group → one line per role, item names in the tooltip and table',
        };
    }
    const narrativeBase = rows.length ? buildResultNarrative({ question: `${question} ${input.originalQuestion || ''}`, data: reshaped.data, profile, chart: reshaped.chart, plan, model, sourceRows: dataset.rows, currency, sql, latestDate: latestDate(dataset, model.timeContext) }) : null;
    const extremesText = extremes ? extremesNarrative(extremes, currency) : null;
    const quick = input.cautions ? null : averageCautionForSql(sql, dataset.rows, plan.dimensions.map(item => item.field));
    const cautions = input.cautions || (quick ? [quick] : []);
    const insights = [...cautions, ...(extremesText ? extremesText.insights : buildInsights(rows, profile, plan, currency))].slice(0, Math.max(4, cautions.length + 2));
    const draftNarrative: ResultNarrative | undefined = narrativeBase
        ? { ...narrativeBase, headline: parsed.title || narrativeBase.headline, insights: unpivoted ? [...cautions, ...unpivoted.insights] : insights, ...(cautions.length ? { cautions } : {}), ...(extremesText ? { summary: extremesText.summary } : {}), ...(unpivoted ? { summary: unpivoted.summary } : {}) }
        : undefined;
    // The words a person reads never carry internal names or NaN (utils/answerGuard).
    const textCheck = draftNarrative ? guardAnswer({ analysis: { data: [], xKey: '', yKey: '' } as any, formatting: {} as any }, draftNarrative) : null;
    const narrative: ResultNarrative | undefined = draftNarrative && textCheck
        ? { ...draftNarrative, headline: textCheck.text.headline || draftNarrative.headline.replace(/_/g, ' '), summary: textCheck.text.summary || `Here ${rows.length === 1 ? 'is the result' : `are the ${rows.length.toLocaleString()} results`}.`, insights: textCheck.text.insights || [] }
        : draftNarrative;

    const explanation = rows.length
        ? parsed.explanation || `Answered with one query on your data (${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}).`
        : 'The query ran but no rows matched. Try a wider date range or fewer filters.';
    const confidence: ConfidenceScore = {
        score: repairAttempts ? 80 : 92,
        level: 'high',
        factors: { semanticMatch: 28, filterClarity: 18, aggregationCertainty: 18, planComplexity: 14, repairAttempts: repairAttempts ? 2 : 15 },
        reasons: [repairAttempts ? 'The first query needed one automatic fix.' : 'The query ran first time.', 'Calculated on your full data in the browser.'],
    };

    return {
        plan,
        sql: formatSQL(sql),
        engine: 'llm-sql',
        validation: { valid: true, checks: [{ name: 'Read-only query', status: 'pass', message: 'Only reads data; nothing can be changed.' }] },
        rawData: rows,
        chartData: reshaped.data,
        profile,
        chart: reshaped.chart,
        confidence,
        explanation,
        columnsUsed: rows.length ? Object.keys(rows[0]) : [],
        executionTimeMs: Math.round(performance.now() - input.started),
        repairAttempts,
        narrative,
        tokenUsage: { prompt: 0, completion: 0, total: tokens },
        provenance: {
            strategy: 'llm-plan',
            model: input.aiModel,
            summary: 'The AI saw only your question and your column names and types; the query it wrote ran on your data in the browser.',
            dataAccess: 'metadata_only',
        },
    };
}

/** What a saved chat answer keeps so it can be shown again without the AI. */
export interface SavedLeanAnswer {
    question: string;
    sql: string;
    title?: string;
    dimensions?: string[];
    measures?: string[];
    explanation?: string;
}

/**
 * Re-run a saved answer's SQL on the current data, with no AI call: used to
 * reopen an answer from an earlier session in full screen.
 */
export async function rerunSavedAnswer(saved: SavedLeanAnswer, dataset: Dataset): Promise<AISQLPipelineResult> {
    const started = performance.now();
    const safety = validateReadOnlySQL(saved.sql);
    if (!safety.ok) throw new AISQLPipelineError('sql_validation_failed', `The saved query is not read-only (${safety.reason}).`);
    const { model } = describeData(dataset);
    const execution = await executeSQLViaDuckDB(dataset.rows, safety.sql, model.timeContext as any, dataset.relatedTables);
    if (execution.error) throw new AISQLPipelineError('ai_sql_execution_failed', `The saved query could not run on the current data: ${execution.error}`);
    const series = completeTimeSeries(safety.sql, execution.data || [], saved, model.timeContext, dataset);
    const cautions = [...await numberCautions(safety.sql, execution.data || [], saved.dimensions, dataset, model.timeContext, saved.question), ...series.notes];
    const result = buildLeanAnswer({
        question: saved.question, sql: safety.sql, rows: series.rows, reply: saved, model, dataset, started, repairAttempts: 0, tokens: 0, aiModel: 'none (re-run locally)', cautions,
    });
    result.conversation = { standaloneQuestion: saved.question, contextTurns: 0, usedContext: false };
    return result;
}
