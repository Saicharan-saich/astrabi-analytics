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

import type { Dataset } from '../../types';
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

export interface LeanRunOptions {
    /** Re-run the same question at a different date grouping. */
    grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    onProgress?: (step: string) => void;
    /**
     * Never stop to ask (drill-downs, regenerate, summary stories): take the
     * most likely reading and say which one in the explanation.
     */
    autoChoose?: boolean;
}

/** What the model returns. Exported for tests. */
export type LeanModelReply =
    | { action: 'clarify'; question: string; options: ClarificationOption[] }
    | { action: 'answer'; title?: string; sql: string; dimensions?: string[]; measures?: string[]; explanation?: string };

// ── Prompt ───────────────────────────────────────────────────────────

export const LEAN_SYSTEM_PROMPT = `You are QuickInsight's data analyst. You see only a description of the user's data: column names, types, roles and short notes. You never see rows. Your job is to answer the user's question by writing ONE DuckDB SQL query that will run on their computer.

STEP 1 — Decide whether to ask a follow-up.
Ask (action "clarify") when ANY of these is true:
- The question uses a subjective or open word — best, worst, top, performing, successful, popular, doing well, good, bad, important, biggest, insights, trends, interesting — and does NOT say how to measure it, and the data has two or more measures it could reasonably mean (for example revenue, units sold, profit, number of orders, average price).
- The question mentions something that is not in the data, or that matches several different columns.
- The question has nothing specific to analyse ("show me insights", "what's interesting?", "analyse this").
Do NOT ask when the question names its measure ("top products by revenue", "average price by make", "how many orders per month") or when only one measure could sensibly be meant.
For a follow-up give 2 to 4 options. Each option must be a complete, specific question you would answer without asking again, naming the exact measure and grouping from the data, e.g. "Top 10 products by total revenue". Put the most likely option first. Keep the follow-up question short and friendly.

STEP 2 — Otherwise answer (action "answer").
- Exactly one read-only SELECT (or WITH ... SELECT) in DuckDB syntax. Double-quote every column and table name.
- Output columns: grouping columns first, then measures. Give measures plain snake_case names such as total_revenue, average_price, order_count.
- Totals use SUM, averages AVG, counts COUNT(*) or COUNT(DISTINCT ...). Round money and averages to 2 decimals with ROUND(x, 2).
- Rankings ("top", "best", "highest"): ORDER BY the measure DESC with LIMIT 10 unless the user gave a number. For "which is the best X", still return the top 10 so the answer can be compared; the first row is the answer.
- Changes over time: group by DATE_TRUNC('month', CAST(date_column AS DATE)) (or the grain asked for) AS period, ORDER BY period. Numeric year columns are compared as numbers.
- Relative dates ("this year", "last month", "recent") are measured from the latest date in the data, never from today: use (SELECT MAX(CAST(date_column AS DATE)) FROM "data") in the query. Never use CURRENT_DATE or NOW().
- You do not know the values stored in text columns. Match text the user typed case-insensitively, e.g. LOWER("region") = LOWER('london'), or ILIKE '%term%' for partial names.
- Listing records: return only the useful columns with LIMIT 200.
- Never return more than 500 rows.

Return ONLY one JSON object, no prose:
{"action":"answer","title":"short plain-English chart title","sql":"SELECT ...","dimensions":["grouping output column"],"measures":["measure output column"],"explanation":"one sentence: what was calculated, including any assumption"}
or
{"action":"clarify","question":"short follow-up","options":[{"label":"Total revenue","question":"Top 10 products by total revenue"}]}`;

// ── Helpers (exported for tests) ─────────────────────────────────────

/** Parse and check the model's JSON reply. */
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
    if (raw.action === 'clarify') {
        const options: ClarificationOption[] = (Array.isArray(raw.options) ? raw.options : [])
            .map((option: any) => ({
                label: String(option?.label || option?.question || '').trim().slice(0, 60),
                question: String(option?.question || option?.label || '').trim().slice(0, 300),
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
        title: typeof raw.title === 'string' ? raw.title.trim().slice(0, 140) : undefined,
        dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.map(String) : undefined,
        measures: Array.isArray(raw.measures) ? raw.measures.map(String) : undefined,
        explanation: typeof raw.explanation === 'string' ? raw.explanation.trim().slice(0, 400) : undefined,
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
    const measures = hintedMeasures.length ? hintedMeasures : columns.filter(column => isNumeric(column) && !TIME_NAME.test(column));
    const dimensions = hintedDims.length ? hintedDims : columns.filter(column => !measures.includes(column));

    const planDimensions: PlanDimension[] = dimensions.map(field => {
        if (!isTime(field)) return { field };
        const grain = /quarter/i.test(field) ? 'quarter' : /year/i.test(field) && !/month/i.test(field) ? 'year' : /week/i.test(field) ? 'week' : /day|date/i.test(field) ? 'day' : 'month';
        return { field, timeGrain: grain };
    });
    const planMetrics: PlanMetric[] = measures.map(field => ({
        field,
        agg: /^(avg|average|mean)_|_(avg|average|mean)$/i.test(field) ? 'avg'
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
const formatNumber = (value: number) => {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
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
export function buildInsights(rows: Record<string, any>[], profile: ResultProfile, plan: AnalysisPlan): string[] {
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
        if (Number.isFinite(first) && first !== 0 && Number.isFinite(last)) {
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

// ── The pipeline ─────────────────────────────────────────────────────

const sqlName = (name: string) => `"${name.replace(/"/g, '""')}"`;

function columnType(field: SemanticField, storedAsNumber?: boolean): string {
    if (storedAsNumber && field.physicalType !== 'date') return field.semanticType === 'date' || /year|month|quarter|week/i.test(field.name) ? 'INTEGER (a year or period number)' : 'NUMBER';
    if (field.physicalType === 'number') return field.semanticType === 'date' ? 'INTEGER (a year or period number)' : 'NUMBER';
    if (field.physicalType === 'date') return "TEXT date 'YYYY-MM-DD' — use CAST(col AS DATE) for date maths";
    if (field.physicalType === 'boolean') return 'BOOLEAN';
    return 'TEXT';
}

function columnRole(field: SemanticField): string {
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
): string {
    const lines = ['Table "data" columns:'];
    for (const field of model.fields) {
        lines.push(`- ${sqlName(field.name)}: ${columnType(field, numericColumns.has(field.name))}; ${columnRole(field)}`);
    }
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

function describeData(dataset: Dataset) {
    const { model } = resolveAISQLSemanticModel(dataset);
    const join = discoverJoinContext(dataset.relatedTables, dataset.sourceSchema);
    // How each column is stored in the browser (a type, never a value).
    const sample = dataset.rows.slice(0, 50);
    const numericColumns = new Set(model.fields.map(field => field.name).filter(name =>
        sample.some(row => row[name] !== null && row[name] !== undefined && row[name] !== '')
        && sample.every(row => row[name] === null || row[name] === undefined || row[name] === '' || typeof row[name] === 'number')));
    return { model, schema: describeColumnsOnly(model, join, numericColumns) };
}

export async function runLeanAISQL(question: string, dataset: Dataset, options: LeanRunOptions = {}): Promise<AISQLPipelineResult> {
    const started = performance.now();
    const asked = `${question}${options.grain ? `\n(Group dates by ${options.grain}.)` : ''}${options.autoChoose ? '\n(Do not ask a follow-up. Choose the most likely measure and name it in the explanation.)' : ''}`;
    options.onProgress?.('Reading your columns');
    const { model, schema } = describeData(dataset);

    // ── 1. One AI call: ask, or write the query ──
    options.onProgress?.('Writing the query');
    const reply = await fetchWithFallback([
        { role: 'system', content: LEAN_SYSTEM_PROMPT },
        { role: 'user', content: `DATA DESCRIPTION\n${schema}\n\nQUESTION\n${asked}` },
    ], { model: PLANNER_MODEL, temperature: 0, max_tokens: 1600, timeout: 45_000 });
    let tokens = Number(reply.data?.usage?.total_tokens) || 0;
    const parsed = parseLeanReply(reply.data?.choices?.[0]?.message?.content || '');

    if (parsed.action === 'clarify') {
        // Automatic runs take the most likely choice instead of stopping.
        if (options.autoChoose && parsed.options[0] && parsed.options[0].question !== question) {
            return runLeanAISQL(parsed.options[0].question, dataset, { ...options, autoChoose: false });
        }
        throw new AISQLClarificationError(parsed.question, parsed.options);
    }

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
        const repaired = await fetchWithFallback([
            { role: 'system', content: `${LEAN_SYSTEM_PROMPT}\n\nThe query below failed in DuckDB. Return the same JSON shape with a corrected "sql". Keep the meaning of the question.` },
            { role: 'user', content: `DATA DESCRIPTION\n${schema}\n\nQUESTION\n${asked}\n\nFAILED SQL\n${sql}\n\nDUCKDB ERROR (values removed)\n${scrubErrorForModel(execution.error)}` },
        ], { model: PLANNER_MODEL, temperature: 0, max_tokens: 1600, timeout: 45_000 });
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

    // ── 3. Chart and insights, all local ──
    options.onProgress?.('Choosing the chart');
    const rows = (execution.data || []).slice(0, 500);
    const plan = planFromResult(question, rows, { dimensions: parsed.dimensions, measures: parsed.measures });
    const profile = profileResult(rows, plan, model);
    const chart: ChartRecommendation = recommendChart(profile, plan, model);
    const reshaped = reshapeData(rows, profile, chart, plan);
    const narrativeBase = rows.length ? buildResultNarrative({ question, data: reshaped.data, profile, chart: reshaped.chart, plan, model, sourceRows: dataset.rows }) : null;
    const insights = buildInsights(rows, profile, plan);
    const narrative: ResultNarrative | undefined = narrativeBase
        ? { ...narrativeBase, headline: parsed.title || narrativeBase.headline, insights }
        : undefined;

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
        executionTimeMs: Math.round(performance.now() - started),
        repairAttempts,
        narrative,
        tokenUsage: { prompt: 0, completion: 0, total: tokens },
        provenance: {
            strategy: 'llm-plan',
            model: reply.model,
            summary: 'The AI saw only your question and your column names and types; the query it wrote ran on your data in the browser.',
            dataAccess: 'metadata_only',
        },
    };
}
