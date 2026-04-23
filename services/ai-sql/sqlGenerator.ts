/**
 * SQL Generator — Step B of the two-step LLM pipeline
 *
 * Generates SQL deterministically from a structured AnalysisPlan.
 * The LLM is only used as a fallback for complex filter expressions.
 * Most SQL is generated purely by code from the plan.
 */

import { SemanticModel, AnalysisPlan, ValidationResult } from './types';
import { serializeSemanticModel } from './semanticLayer';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';
const MODEL = 'qwen/qwen3-coder';
const TIMEOUT_MS = 20000;

/**
 * Generate SQL from a structured AnalysisPlan.
 * First tries deterministic code-based generation.
 * Falls back to LLM for complex queries that code can't handle.
 */
export async function generateSQLFromPlan(
    plan: AnalysisPlan,
    model: SemanticModel
): Promise<{ sql: string; explanation: string; method: 'deterministic' | 'llm' }> {

    // Try deterministic generation first
    const deterministicResult = tryDeterministicSQL(plan, model);
    if (deterministicResult) {
        console.log('[SQL Generator] Used deterministic generation');
        return { ...deterministicResult, method: 'deterministic' };
    }

    // Fall back to LLM-assisted SQL generation
    console.log('[SQL Generator] Falling back to LLM-assisted generation');
    return await llmGenerateSQL(plan, model);
}

/**
 * Try to generate SQL purely from code (no LLM).
 * Returns null if the plan is too complex for deterministic generation.
 */
function tryDeterministicSQL(
    plan: AnalysisPlan,
    model: SemanticModel
): { sql: string; explanation: string } | null {

    // We can handle most standard queries deterministically
    try {
        // ─── Handle compound averages (e.g., "average daily sales") ───
        // These need a subquery: SELECT AVG(daily_total) FROM (SELECT date, SUM(X) ... GROUP BY date)
        const hasCompoundAgg = plan.metrics.some((m: any) => m.compoundAgg);
        if (hasCompoundAgg) {
            return generateCompoundAverageSQL(plan, model);
        }

        const parts: string[] = [];

        // --- SELECT clause ---
        const selectParts: string[] = [];
        const groupByParts: string[] = [];

        // Dimensions
        for (const dim of plan.dimensions) {
            if (dim.timeGrain && dim.timeGrain !== 'day') {
                // Apply time grain transformation
                const grainExpr = applyTimeGrain(dim.field, dim.timeGrain);
                selectParts.push(`${grainExpr} AS ${dim.field}_${dim.timeGrain}`);
                groupByParts.push(grainExpr);
            } else {
                selectParts.push(dim.field);
                groupByParts.push(dim.field);
            }
        }

        // Metrics
        for (const met of plan.metrics) {
            // Check if it's a composite metric
            if (met.compositeId) {
                const composite = model.compositeMetrics.find(m => m.id === met.compositeId);
                if (composite) {
                    selectParts.push(`${composite.formula} AS ${composite.id}`);
                    continue;
                }
            }

            // Standard metric with aggregation
            const aggFn = met.agg.toUpperCase().replace('COUNT_DISTINCT', 'COUNT(DISTINCT');
            if (met.agg === 'count_distinct') {
                selectParts.push(`COUNT(DISTINCT ${met.field}) AS ${met.field}_count`);
            } else if (met.agg === 'count') {
                selectParts.push(`COUNT(${met.field}) AS ${met.field}_count`);
            } else {
                selectParts.push(`${aggFn}(${met.field}) AS ${met.field}_${met.agg}`);
            }
        }

        if (selectParts.length === 0) return null;

        parts.push(`SELECT ${selectParts.join(', ')}`);
        parts.push('FROM data');

        // --- WHERE clause ---
        const whereParts = buildWhereClause(plan, model);
        if (whereParts.length > 0) {
            parts.push(`WHERE ${whereParts.join(' AND ')}`);
        }

        // --- GROUP BY clause ---
        if (groupByParts.length > 0) {
            parts.push(`GROUP BY ${groupByParts.join(', ')}`);
        }

        // --- ORDER BY clause ---
        if (plan.sort.length > 0) {
            const orderParts = plan.sort.map(s => {
                // Map field to the correct alias
                const dimMatch = plan.dimensions.find(d => d.field === s.field);
                if (dimMatch && dimMatch.timeGrain && dimMatch.timeGrain !== 'day') {
                    return `${dimMatch.field}_${dimMatch.timeGrain} ${s.dir.toUpperCase()}`;
                }
                return `${s.field} ${s.dir.toUpperCase()}`;
            });
            parts.push(`ORDER BY ${orderParts.join(', ')}`);
        } else if (plan.intent === 'ranking') {
            // Default: order by first metric desc
            if (plan.metrics.length > 0) {
                const firstMet = plan.metrics[0];
                const alias = firstMet.compositeId || `${firstMet.field}_${firstMet.agg}`;
                parts.push(`ORDER BY ${alias} DESC`);
            }
        } else if (plan.dimensions.some(d => d.timeGrain)) {
            // Default: order by time dimension asc
            const timeDim = plan.dimensions.find(d => d.timeGrain);
            if (timeDim) {
                const alias = timeDim.timeGrain !== 'day' ? `${timeDim.field}_${timeDim.timeGrain}` : timeDim.field;
                parts.push(`ORDER BY ${alias} ASC`);
            }
        }

        // --- LIMIT clause ---
        if (plan.limit) {
            parts.push(`LIMIT ${plan.limit}`);
        } else if (plan.intent === 'ranking' && !plan.limit) {
            parts.push('LIMIT 10'); // Default top-10 for ranking
        }

        const sql = parts.join('\n');

        // Handle comparison queries by generating two queries and UNION
        if (plan.comparison) {
            return generateComparisonSQL(plan, model, sql);
        }

        // Build explanation
        const explanation = buildExplanation(plan, model);

        return { sql, explanation };

    } catch (err) {
        console.warn('[SQL Generator] Deterministic generation failed:', err);
        return null;
    }
}

/**
 * Generate SQL for compound averages like "average daily sales".
 * Uses a subquery: SELECT AVG(daily_total) FROM (SELECT date, SUM(sales) as daily_total FROM data GROUP BY date)
 */
function generateCompoundAverageSQL(
    plan: AnalysisPlan,
    model: SemanticModel
): { sql: string; explanation: string } {
    // Find the date dimension (used for the inner GROUP BY)
    const dateDim = plan.dimensions.find(d => {
        const field = model.fields.find(f => f.name.toLowerCase() === d.field.toLowerCase());
        return field?.semanticType === 'date';
    });

    const dateField = dateDim?.field || model.fields.find(f => f.semanticType === 'date')?.name || 'order_date';
    const grain = dateDim?.timeGrain || 'day';

    // Build the WHERE clause for filters
    const whereParts = buildWhereClause(plan, model);
    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    // Build inner SELECT: SUM each metric grouped by the grain
    const innerSelects: string[] = [];
    const outerSelects: string[] = [];

    // Inner query groups by date grain
    if (grain === 'day') {
        innerSelects.push(dateField);
    } else {
        const grainExpr = applyTimeGrain(dateField, grain);
        innerSelects.push(`${grainExpr} AS grain_period`);
    }

    for (const met of plan.metrics) {
        if (met.compositeId) continue;
        const alias = `${met.field}_daily_total`;
        innerSelects.push(`SUM(${met.field}) AS ${alias}`);
        outerSelects.push(`AVG(${alias}) AS ${met.field}_avg`);
    }

    const groupByCol = grain === 'day' ? dateField : 'grain_period';

    const sql = `SELECT ${outerSelects.join(', ')}
FROM (
  SELECT ${innerSelects.join(', ')}
  FROM data
  ${whereClause}
  GROUP BY ${grain === 'day' ? dateField : applyTimeGrain(dateField, grain)}
) sub`;

    const grainLabel = grain === 'day' ? 'daily' : grain === 'week' ? 'weekly' : grain === 'month' ? 'monthly' : grain;
    const explanation = `Calculating average ${grainLabel} ${plan.metrics.map(m => m.field).join(', ')} — first sums by ${grain}, then averages across all ${grain}s`;

    return { sql, explanation };
}

/**
 * Apply time grain transformation to a date column
 */
function applyTimeGrain(field: string, grain: string): string {
    switch (grain) {
        case 'year': return `YEAR(${field})`;
        case 'quarter': return `CONCAT(YEAR(${field}), '-Q', QUARTER(${field}))`;
        case 'month': return `FORMAT_MONTH(${field})`;
        case 'week': return `CONCAT(YEAR(${field}), '-W', LPAD(WEEK(${field}), 2, '0'))`;
        default: return field;
    }
}

/**
 * Build WHERE clause from plan filters
 */
function buildWhereClause(plan: AnalysisPlan, model: SemanticModel): string[] {
    const parts: string[] = [];

    for (const filter of plan.filters) {
        switch (filter.op) {
            case '=':
                parts.push(typeof filter.value === 'string'
                    ? `${filter.field} = '${filter.value}'`
                    : `${filter.field} = ${filter.value}`);
                break;
            case '!=':
                parts.push(typeof filter.value === 'string'
                    ? `${filter.field} != '${filter.value}'`
                    : `${filter.field} != ${filter.value}`);
                break;
            case '>': case '<': case '>=': case '<=':
                parts.push(typeof filter.value === 'string'
                    ? `${filter.field} ${filter.op} '${filter.value}'`
                    : `${filter.field} ${filter.op} ${filter.value}`);
                break;
            case 'between':
                if (Array.isArray(filter.value) && filter.value.length === 2) {
                    parts.push(`${filter.field} BETWEEN '${filter.value[0]}' AND '${filter.value[1]}'`);
                }
                break;
            case 'in':
                if (Array.isArray(filter.value)) {
                    const vals = filter.value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
                    parts.push(`${filter.field} IN (${vals})`);
                }
                break;
            case 'not_in':
                if (Array.isArray(filter.value)) {
                    const vals = filter.value.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ');
                    parts.push(`${filter.field} NOT IN (${vals})`);
                }
                break;
            case 'like':
                parts.push(`${filter.field} LIKE '${filter.value}'`);
                break;
        }
    }

    return parts;
}

/**
 * Generate comparison SQL by creating two sub-queries
 * and combining their results for side-by-side comparison
 */
function generateComparisonSQL(
    plan: AnalysisPlan,
    model: SemanticModel,
    baseSQL: string
): { sql: string; explanation: string } {

    if (plan.comparison?.mode === 'total') {
        // Total comparison: two separate aggregations in a single query using CASE
        const metricExprs = plan.metrics.map(m => {
            const agg = m.agg.toUpperCase();
            return [
                `${agg}(CASE WHEN current_period THEN ${m.field} ELSE 0 END) AS current_${m.field}`,
                `${agg}(CASE WHEN NOT current_period THEN ${m.field} ELSE 0 END) AS previous_${m.field}`,
            ];
        }).flat();

        // For total comparison, we need a simpler approach: execute two separate queries
        // and let the reshaper combine them. Just return the base query with a note.
        return {
            sql: baseSQL,
            explanation: buildExplanation(plan, model) + ' (Comparison will be computed by executing current and previous period queries separately.)',
        };
    }

    // Trend comparison: the base query is for current period only;
    // The pipeline will handle executing the previous period query separately
    return {
        sql: baseSQL,
        explanation: buildExplanation(plan, model) + ' (Previous period data will be overlaid for trend comparison.)',
    };
}

/**
 * Build a human-readable, natural-language explanation of the plan
 */
function buildExplanation(plan: AnalysisPlan, model: SemanticModel): string {
    // Get metric display names
    const metricNames = plan.metrics.map(m => {
        const field = model.fields.find(f => f.name === m.field);
        return field?.displayLabel || m.field;
    });

    // Get dimension display names
    const dimNames = plan.dimensions.map(d => {
        const field = model.fields.find(f => f.name === d.field);
        return field?.displayLabel || d.field;
    });

    // Build aggregation labels
    const aggLabel = (m: typeof plan.metrics[0]) => {
        switch (m.agg) {
            case 'sum': return 'total';
            case 'avg': return 'average';
            case 'count': return 'count of';
            case 'count_distinct': return 'distinct count of';
            case 'min': return 'minimum';
            case 'max': return 'maximum';
            default: return '';
        }
    };

    let sentence = '';

    // Single metric, no dimensions → direct KPI answer
    if (plan.intent === 'single_metric' && dimNames.length === 0) {
        const m = plan.metrics[0];
        sentence = `Calculating the ${aggLabel(m)} ${metricNames[0]}`;
    }
    // Trend
    else if (plan.intent === 'trend' || plan.intent === 'trend_comparison') {
        const timeGrain = plan.dimensions.find(d => d.timeGrain)?.timeGrain || 'time';
        sentence = `Showing ${metricNames.join(' and ')} trend over ${timeGrain}`;
    }
    // Ranking
    else if (plan.intent === 'ranking') {
        const limit = plan.limit || 10;
        sentence = `Showing the top ${limit} ${dimNames[0] || 'items'} ranked by ${metricNames[0]}`;
    }
    // Share of total
    else if (plan.intent === 'share_of_total') {
        sentence = `Showing each ${dimNames[0] || 'category'}'s share of total ${metricNames[0]}`;
    }
    // Comparison
    else if (plan.intent === 'total_comparison') {
        sentence = `Comparing ${metricNames[0]} across periods`;
    }
    // Breakdown (most common)
    else if (dimNames.length > 0) {
        const m = plan.metrics[0];
        sentence = `Showing ${aggLabel(m)} ${metricNames.join(', ')} by ${dimNames.join(' and ')}`;
    }
    // Fallback
    else {
        sentence = `Calculating ${metricNames.join(', ')}`;
    }

    // Add filter context
    if (plan.filters.length > 0) {
        const filterDescs = plan.filters.map(f => {
            const field = model.fields.find(fld => fld.name === f.field);
            const label = field?.displayLabel || f.field;
            if (f.op === 'in' && Array.isArray(f.value)) return `${label} is ${f.value.join(', ')}`;
            if (f.op === 'between' && Array.isArray(f.value) && f.value.length === 2) return `${label} from ${f.value[0]} to ${f.value[1]}`;
            return `filtered by ${label}`;
        });
        sentence += `, where ${filterDescs.join(' and ')}`;
    }

    // Add comparison note
    if (plan.comparison) {
        sentence += ` — compared with ${plan.comparison.type.replace(/_/g, ' ')}`;
    }

    return sentence + '.';
}


/**
 * LLM-assisted SQL generation (fallback for complex queries)
 */
async function llmGenerateSQL(
    plan: AnalysisPlan,
    model: SemanticModel
): Promise<{ sql: string; explanation: string; method: 'llm' }> {

    const serialized = serializeSemanticModel(model);

    const prompt = `You are a SQL expert. Generate a single SQL query for the following structured plan.

SEMANTIC MODEL:
${serialized}

ANALYSIS PLAN:
${JSON.stringify(plan, null, 2)}

RULES:
1. Use table name "data".
2. Use exact column names from the semantic model.
3. For composite metrics, use the formula from the Composite Metrics section.
4. NEVER use STRFTIME or EXTRACT. Use YEAR(), MONTH(), QUARTER() functions.
5. Use ISO date format (YYYY-MM-DD) for date comparisons.
6. Always alias calculated columns with meaningful names.
7. Every dimension must appear in GROUP BY.

Respond with ONLY a JSON object:
{
  "sql": "SELECT ...",
  "explanation": "Brief explanation"
}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: `Generate SQL for: "${plan.originalQuestion}"` }
                ],
                temperature: 0.1,
                max_tokens: 2000,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`API error (${response.status})`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        const cleaned = content?.replace(/```json\s*|```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned || '{}');

        return {
            sql: parsed.sql || '',
            explanation: parsed.explanation || buildExplanation(plan, model),
            method: 'llm',
        };

    } catch (err: any) {
        clearTimeout(timeout);
        throw new Error(`LLM SQL generation failed: ${err.message}`);
    }
}

/**
 * Repair loop: attempt to fix a failed SQL query.
 * Max 2 attempts. Returns corrected SQL or throws.
 */
export async function repairSQL(
    originalSQL: string,
    error: string,
    plan: AnalysisPlan,
    model: SemanticModel,
    attempt: number = 1
): Promise<{ sql: string; explanation: string }> {
    if (attempt > 2) {
        throw new Error(`SQL repair failed after 2 attempts. Last error: ${error}`);
    }

    console.log(`[SQL Repair] Attempt ${attempt} for error: ${error}`);

    const serialized = serializeSemanticModel(model);

    const prompt = `The following SQL query failed with an error. Fix it.

SEMANTIC MODEL:
${serialized}

ORIGINAL PLAN:
${JSON.stringify(plan, null, 2)}

FAILED SQL:
${originalSQL}

ERROR:
${error}

RULES:
- Use table name "data".
- Use ONLY column names from the semantic model.
- Do not use STRFTIME or EXTRACT. Use YEAR(), MONTH(), QUARTER().
- Fix ONLY the error. Do not change other parts of the query.

Respond with ONLY a JSON object:
{ "sql": "CORRECTED SELECT ...", "explanation": "What was fixed" }`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': window.location.origin,
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: 'Fix the SQL error' }
                ],
                temperature: 0,
                max_tokens: 2000,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) throw new Error(`API error (${response.status})`);

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        const cleaned = content?.replace(/```json\s*|```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned || '{}');

        return {
            sql: parsed.sql || originalSQL,
            explanation: parsed.explanation || 'Repaired SQL',
        };

    } catch (err: any) {
        clearTimeout(timeout);
        throw new Error(`SQL repair attempt ${attempt} failed: ${err.message}`);
    }
}
