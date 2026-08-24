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
import { fetchWithFallback, LUNA_MODEL, PLANNER_MODEL, SOL_MODEL } from './modelConfig';
import { validateReadOnlySQL } from './sqlSafety';
import type { AnalysisPlan, SemanticModel } from './types';
import {
    formatQueryContractForPrompt,
    validateSQLAgainstContract,
    type QueryContract,
} from './queryContract';
import { buildCanonicalQueryIntent, type CanonicalQueryIntent } from './canonicalIntent';

const SYSTEM_PROMPT = `You are an expert analyst who writes SQL for DuckDB.
Given a database schema and a question, output a SINGLE read-only SQL SELECT that answers it.
Rules:
- DuckDB dialect. Double-quote identifiers that contain spaces or special characters (e.g. "Free Meal Count (K-12)").
- Use the EXACT PHYSICAL table and column names from the schema in SQL. A display label such as "Customer ID" is not a SQL identifier when the schema names the physical column customer_id. Do not invent columns or transform display labels into identifiers.
- When the result identifies people, customers, products, companies, or other entities, select and group by the most human-readable descriptive field available (for example customer_name or product_name). Treat opaque identifiers (such as customer_id) as an optional secondary reference, never as the sole user-facing answer when a name/label field exists.
- When the question asks for a list or categories of an entity (e.g. "what are the budget categories"), use SELECT DISTINCT on only the requested column(s). Do not include unrelated columns.
- Match the output grain to the question. If the question asks for unique values, use SELECT DISTINCT. If it asks for "how many", use COUNT.
- Read the "Column notes": respect additivity (SUM only additive measures; a column marked "per-unit/rate" must use AVG, never SUM), and never GROUP BY or aggregate a column marked "row identifier".
- When money/revenue/total is asked for, use the additive currency measure, not a per-unit price.
- When computing "X% higher/lower than average", apply the percentage as a multiplier: e.g. "20% higher than average" → column > 1.2 * (SELECT AVG(...))
- When the AVG subquery is used with additional WHERE filters, those same filters must appear inside the subquery.
- DATE COLUMNS ARE STORED AS TEXT (VARCHAR). You MUST wrap them in CAST(col AS DATE) before ANY date function or comparison — DATE_TRUNC, EXTRACT, strftime, date_diff, ordering by month, or BETWEEN. Example: DATE_TRUNC('month', CAST(order_date AS DATE)), and CAST(order_date AS DATE) BETWEEN DATE '2025-01-01' AND DATE '2025-12-31'. Writing DATE_TRUNC('month', order_date) directly WILL fail.
- JOIN across tables when needed, following the listed foreign keys.
- Treat absence and exclusion as set logic. Questions such as "entities with no related records" require NOT EXISTS, LEFT JOIN ... IS NULL, or EXCEPT against the related table; never simulate absence by grouping only the primary table and writing HAVING COUNT(...) = 0.
- Preserve the requested output entity and grain. Do not return a continent when country names were requested, or collapse several requested rows into one group.
- For grouped membership thresholds such as "grades with 4 or more students", return exactly one row per qualifying group. Use GROUP BY ... HAVING (or select once from an already-grouped CTE); never use the grouped result merely to filter and re-project the original detail rows.
- Lock the OUTER SELECT to the fields and calculations the user explicitly asks to see. An aggregate used only to define a filter (for example, products above average sales) belongs in a subquery/CTE predicate and does not turn the outer result into COUNT, SUM, or AVG.
- For a single-winner question, return one row at the requested entity grain. Do not return the winning entity's underlying detail rows, and do not expose helper fields used only to calculate the winner.
- Treat "most/least common", "most/least frequent", and inverse wording such as "the type that the most records belong to" as frequency rankings: group by the requested answer field, rank by COUNT(*) in the correct direction, and return the requested winner. The count may remain an ORDER BY helper when the user asks only for the winning field.
- Never replace requested names, labels, dates, or other row attributes with COUNT, SUM, LIST, ARRAY_AGG, STRING_AGG, or ANY_VALUE. Use collection aggregates only when the user explicitly requests a single packed list.
- Do not infer an aggregation from a physical column name containing words such as number, count, total, or amount. Aggregation comes from the question's requested operation.
- Prefer the simplest faithful SQL. Do not add CTEs, windows, grouping, extra output columns, or LIMIT unless they are necessary for the question.
- The user's explicit question and the verified schema are the source of truth. The local Analysis Plan is a governed draft: preserve valid resolved metrics, filters, comparison semantics, sorting, and limits, but repair any omission or misclassification called out by Planner Verification.
- Preserve governed relative thresholds. A plan filter with op "above_avg" or "below_avg" means: aggregate the metric at the requested entity grain first, calculate the average of those entity aggregates in a CTE/subquery, then retain entities above or below that threshold. Never replace it with an invented literal threshold. If includeNonPositive is true, combine the below-average condition with OR aggregate <= 0 so wording such as "low or negative" is preserved exactly.
- Treat the deterministic relativeComparison contract as authoritative. When referencePopulation is "filtered_cohort", calculate AVG over the same pre-comparison cohort predicates used by the outer query; SQL outer WHERE predicates do not flow into a scalar subquery automatically. When it is "global", do not copy cohort filters. Preserve its exact comparator and multiplier (for example, "20% higher than" means > AVG(...) * 1.2, while "at least 20% higher" means >=).
- Never return a generic scalar total merely because the draft plan has no dimension. If the user asks "by", "over time", a fiscal calendar, a comparison, ranking, or another explicit analytical shape, implement that shape using the available schema.
- For a total period comparison, return two labelled aggregate rows, 'Current' and 'Previous'. For a trend comparison, retain the period label and the requested time grain.
- If the question includes a "Dataset reporting anchor", that anchor is the reporting clock. Resolve relative periods using explicit DATE literals from it; NEVER use CURRENT_DATE, CURRENT_TIMESTAMP, NOW(), or other wall-clock functions.
- "List out", "list", "enumerate", "show me the X" means return individual rows — never COUNT. Example: "List out the Id number of races held in 2009" → SELECT raceId FROM races WHERE year = 2009. NOT SELECT COUNT(*).
- "What is the percentage of X that Y" → ALWAYS use conditional aggregation as a single scalar with NO GROUP BY. Example: "what percentage of accounts with amount < 100000 are running?" → SELECT CAST(SUM(status = 'C') AS REAL) * 100.0 / COUNT(*) FROM loan WHERE amount < 100000. NEVER GROUP BY amount or any per-row field.
- Only SELECT the columns the question explicitly asks about. If the question says "what are the budget categories", select ONLY category with SELECT DISTINCT. Do NOT add event_name, budget_id, event_status, or other unrequested columns. Do NOT omit DISTINCT when the question asks for unique values/categories.
- When a subquery computes AVG/SUM and the outer query has WHERE filters, the SAME WHERE filters MUST appear inside the subquery. Example: "patients with thrombosis=2 and ANA='S' having aCL IgM 20% above average" → ... > 1.2 * (SELECT AVG("aCL IgM") FROM Examination WHERE Thrombosis = 2 AND "ANA Pattern" = 'S'). NEVER use the unfiltered table average.
- Return ONLY the SQL — no prose, no explanation, no markdown fences.`;

export interface DynamicQuerySpec {
    goal: string;
    operations: {
        measures?: Array<{ field?: string; aggregation?: string; expression?: string }>;
        groupBy?: Array<{ field: string; grain?: string; expression?: string }>;
        filters?: Array<{ field?: string; operator?: string; value?: unknown; expression?: string }>;
        having?: Array<{ expression: string }>;
        orderBy?: Array<{ expression: string; direction?: 'asc' | 'desc' }>;
        limit?: number;
        joins?: Array<{ leftTable: string; rightTable: string; condition: string; purpose?: string }>;
        tableCalculations?: Array<{ type: string; expression?: string; partitionBy?: string[]; orderBy?: string[] }>;
    };
    expectedResult: { grain: string; columns: string[]; explanation?: string };
    assumptions: string[];
    clarification?: string;
}

const SPEC_PROMPT = `You are the planning stage of a privacy-first analytics system.
Translate the question into a JSON Query Specification. You receive only a database schema and metadata, never data rows.
Capture all requested analytical operations dynamically: measures/aggregations, filters, GROUP BY, HAVING, sorting, limits, joins, date logic, and window or table calculations. Use only exact physical schema fields and table names. When an entity is the answer, choose its human-readable descriptive field for expectedResult (not an opaque ID) whenever the schema provides one; IDs can be an optional secondary reference.
Define expectedResult from the words that describe what the user wants returned, before planning filters. Aggregates used only as comparison thresholds belong in filters/subqueries and must not replace those requested result fields. Never invent COUNT, collection aggregates, GROUP BY, or LIMIT from a column name or from a filter's aggregate.
Relative analytical language is answerable without a user-supplied literal threshold. When the governed plan resolves "high/strong" to above_avg or "low/weak/negative" to below_avg, preserve that decision: compare each entity-level aggregate with the average across entity aggregates, record the rule in assumptions, and do NOT request clarification. Ask only when the required field or entity grain is genuinely unavailable.
For a filtered population compared with an average, explicitly identify the reference population. Unless the wording says overall/global/all records, phrases such as "patients with X ... higher than average" use the same X-filtered cohort for both the outer population and the AVG reference. Preserve strict boundaries: "higher than" is >; "at least ... higher" is >=.
Represent negative existence explicitly as an anti-join/set operation (NOT EXISTS, LEFT JOIN ... IS NULL, or EXCEPT). Preserve the requested entity as expectedResult grain and columns; never substitute a related table or a higher-level grouping.

CRITICAL — do NOT return a clarification for any of these answerable patterns:
- Grouped queries: questions like "for each", "for different", "per", "by", "and the corresponding number" request GROUP BY results with multiple rows. Never say the question requests a scalar when grouping signals are present.
- Aggregate queries on the whole table: COUNT(*), AVG(*), SUM(*) on the table itself are always valid. If the table is named "Highschooler", then COUNT(*) FROM Highschooler counts highschoolers — no extra identifying field is needed.
- Field visibility: the result does NOT need to include every descriptive or identifier field. If the question asks for "average weight per pet type", only PetType and AVG(weight) are needed — do not demand pet_age, pet_id, or any other field.
- Superlative + grouping: "which X has the most Y" can be answered with GROUP BY + ORDER BY + LIMIT 1.
- Column existence: if the question mentions a concept that maps to an existing column (even loosely), use that column. Do not return clarification saying the schema lacks a field when a reasonable mapping exists.

SEMANTIC RULES:
- "List out", "list", "enumerate" means return individual rows in expectedResult. The goal is projection, NOT counting. Do not plan a COUNT measure when the user says "list".
- "What is the percentage of X that Y" → plan a conditional aggregation: SUM(condition) * 100 / COUNT(*), returning one scalar row. Do not GROUP BY individual entity rows.
- Only include in expectedResult.columns the fields the question explicitly requests. Do not add extra columns (event_name, budget_id, etc.) unless asked.

Return valid JSON only with: goal, operations, expectedResult, assumptions, clarification.
If the schema genuinely cannot answer the question (no relevant table or column exists), set clarification instead of inventing a field.`;

function extractJSONObject(content: string): DynamicQuerySpec | null {
    const raw = (content || '').replace(/\`\`\`json|\`\`\`/gi, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]) as DynamicQuerySpec; } catch { return null; }
}

/** Freeze model planning to the locally established answer shape. */
export function reconcileQuerySpecWithCanonicalIntent(
    draft: DynamicQuerySpec,
    canonical: CanonicalQueryIntent,
): DynamicQuerySpec {
    const spec: DynamicQuerySpec = JSON.parse(JSON.stringify(draft));
    spec.operations ||= {};
    spec.expectedResult ||= { grain: '', columns: [] };
    spec.expectedResult.columns ||= [];
    spec.assumptions ||= [];

    if (canonical.answerKind === 'detail_projection') {
        spec.operations.measures = [];
        spec.operations.groupBy = [];
    } else {
        const existingMeasures = spec.operations.measures || [];
        spec.operations.measures = canonical.measures.map(measure => {
            const aggregation = measure.aggregation;
            const existing = existingMeasures.find(measure => measure.aggregation?.toLowerCase() === aggregation)
                || existingMeasures[0];
            if (existing) return { ...existing, field: measure.field || existing.field, aggregation };
            if (measure.field) return { field: measure.field, aggregation };
            return aggregation === 'count'
                ? { aggregation, expression: 'COUNT(*)' }
                : { aggregation };
        });

        if (canonical.grainFields.length) {
            const existingGroups = spec.operations.groupBy || [];
            spec.operations.groupBy = canonical.grainFields.map(field =>
                existingGroups.find(group => group.field?.toLowerCase() === field.toLowerCase()) || { field }
            );
        } else if (canonical.cardinality === 'scalar') {
            spec.operations.groupBy = [];
        }
    }

    if (canonical.constraints.prohibitImplicitLimit) delete spec.operations.limit;
    if (canonical.order?.limit !== undefined) spec.operations.limit = canonical.order.limit;
    if (canonical.order) {
        const current = spec.operations.orderBy?.[0];
        const rankedMeasure = canonical.measures[0];
        const canonicalExpression = rankedMeasure
            ? rankedMeasure.aggregation === 'count' && !rankedMeasure.field
                ? 'COUNT(*)'
                : `${rankedMeasure.aggregation.toUpperCase()}(${rankedMeasure.field || 'requested measure'})`
            : undefined;
        spec.operations.orderBy = [{
            expression: canonical.order.field || canonicalExpression || current?.expression
                || (canonical.aggregations[0]
                    ? `${canonical.aggregations[0].toUpperCase()}(...)`
                    : canonical.grainFields[0] || 'requested ranking measure'),
            direction: canonical.order.direction,
        }];
    }

    if (canonical.visibleFields.length) {
        spec.expectedResult.columns = canonical.constraints.strictOutputProjection
            ? [...canonical.visibleFields]
            : [...new Set([...canonical.visibleFields, ...spec.expectedResult.columns])];
    }
    spec.expectedResult.grain = canonical.cardinality === 'scalar'
        ? 'one scalar result row'
        : canonical.grainFields.length
            ? `one row per ${canonical.grainFields.join(' + ')}`
            : 'one row per matching source record';

    // A schema-grounded intent supersedes a model clarification about shape.
    const groundedMeasure = canonical.measures.some(measure => measure.confidence === 'high' && measure.field);
    if (canonical.visibleFields.length || canonical.grainFields.length || groundedMeasure || canonical.relationship.tables.length) {
        spec.clarification = undefined;
    }
    spec.assumptions = [
        ...spec.assumptions,
        `Canonical answer kind: ${canonical.answerKind}`,
        `Canonical cardinality: ${canonical.cardinality}`,
    ];
    return spec;
}

/**
 * Give every model a schema-derived presentation map. It makes the distinction
 * between an internal identity key and the field a person should actually read
 * explicit without sharing any values or adding a question-specific rule.
 */
export function buildEntityPresentationContext(model?: SemanticModel): string {
    if (!model) return '';
    const fields = model.fields || [];
    const identifiers = fields.filter(field =>
        field.semanticType === 'identifier' || /(?:^|_)id$|identifier|_key$/i.test(field.name)
    );
    const descriptive = fields.filter(field =>
        field.role === 'dimension'
        && field.semanticType !== 'identifier'
        && /(?:^|_)(?:name|label|title|description)$/i.test(field.name)
    );
    const hints = descriptive.slice(0, 20).map(field => {
        const stem = field.name.toLowerCase().replace(/(?:_|-)?(?:name|label|title|description)$/i, '');
        const identifier = identifiers.find(id =>
            id.name.toLowerCase().replace(/(?:_|-)?(?:id|key)$/i, '') === stem
        );
        return identifier
            ? `- ${field.name} is the human-readable display field for ${identifier.name}; use ${field.name} as the visible answer and include ${identifier.name} only when a reference is useful.`
            : `- ${field.name} is a human-readable descriptive field; prefer it over opaque identifiers in visible answers.`;
    });
    return hints.length ? `\n\nHuman-readable presentation fields:\n${hints.join('\n')}` : '';
}

export interface DirectSQLResult {
    sql: string;
    tokens: number;
    model?: string;
    error?: string;
    /** True when the SQL failed an explicit question-to-SQL contract and must not fall back to a generic answer. */
    blocked?: boolean;
    /** Final semantic contract produced before SQL generation. */
    querySpec?: DynamicQuerySpec;
    canonicalIntent?: CanonicalQueryIntent;
}

export interface SemanticSQLRepairResult {
    sql: string;
    tokens: number;
    model?: string;
    explanation: string;
    error?: string;
}

/** Pull the SQL out of the model's reply (strip code fences / trailing prose). */
export function extractSQL(content: string): string {
    let s = (content || '').trim();
    const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    return s.replace(/;+\s*$/, '').trim();
}

/** Focused semantic retry after valid SQL returns an implausible empty result. */
export async function repairSemanticSQL(
    question: string,
    schemaText: string,
    spec: DynamicQuerySpec | undefined,
    originalSQL: string,
    diagnostic: string,
    requestPurpose?: 'benchmark',
    queryContract?: QueryContract,
): Promise<SemanticSQLRepairResult> {
    const repaired = await fetchWithFallback([
        {
            role: 'system',
            content: `${SYSTEM_PROMPT}\n\nYou are performing a result-aware semantic repair. The SQL was syntactically valid, but local execution violated the expected result shape. Re-check table selection, relationship path, entity grain, filter placement, case-sensitive literals, anti-join logic, grouping, and output columns. Do not remove a requested condition merely to manufacture rows. Return only corrected SQL.`,
        },
        {
            role: 'user',
            content: `Schema:\n${schemaText}\n\nQuestion:\n${question}\n\nQuery specification:\n${JSON.stringify(spec || {}, null, 2)}\n\nExecuted SQL:\n${originalSQL}\n\nLocal diagnostic (no row values are shared):\n${diagnostic}\n\nCorrected SQL:`,
        },
    ] as any, { temperature: 0, max_tokens: 2400, model: SOL_MODEL, requestPurpose });

    const sql = extractSQL(repaired.data.choices?.[0]?.message?.content || '');
    const usage = repaired.data.usage || {};
    const tokens = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || 0;
    const safe = validateReadOnlySQL(sql);
    if (!safe.ok) {
        return { sql: originalSQL, tokens, model: repaired.model, explanation: 'Semantic repair was rejected by the read-only SQL gate.', error: safe.reason };
    }
    if (queryContract) {
        const contractIssues = validateSQLAgainstContract(safe.sql, queryContract)
            .filter(issue => issue.severity === 'error');
        if (contractIssues.length) {
            return {
                sql: originalSQL,
                tokens,
                model: repaired.model,
                explanation: 'Semantic repair was rejected because it changed the required answer contract.',
                error: contractIssues.map(issue => issue.message).join(' '),
            };
        }
    }
    return {
        sql: safe.sql,
        tokens,
        model: repaired.model,
        explanation: 'Replanned table selection, filters, and result grain after an empty local result.',
    };
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
    requestPurpose?: 'benchmark',
    queryContract?: QueryContract,
): Promise<DirectSQLResult> {
    const planContext = analysisPlan
        ? `\n\nUntrusted local semantic hints (advisory only):\n${JSON.stringify(analysisPlan, null, 2)}\nDo not copy a metric, dimension, filter, grouping, or limit from these hints unless it is grounded by the user's question and physical schema. The deterministic query contract and the user's requested output take precedence over every conflicting hint.`
        : '';
    const verificationContext = plannerVerification?.length
        ? `\n\nLocal diagnostics to consider:\n${JSON.stringify(plannerVerification, null, 2)}`
        : '';
    const presentationContext = buildEntityPresentationContext(semanticModel);
    const contractContext = queryContract
        ? `\n\nDeterministic Query Contract (mandatory; do not weaken or replace it):\n${formatQueryContractForPrompt(queryContract)}`
        : '';

    // Terra interprets the question into a typed, open-ended analytical plan.
    // This is deliberately not a collection of keyword rules: the specification
    // can represent aggregations, filters, joins, windows, table calculations,
    // and any schema-grounded analytical shape.
    const planner = await fetchWithFallback([
        { role: 'system', content: SPEC_PROMPT },
        { role: 'user', content: `Schema:\n${schemaText}${presentationContext}${planContext}${verificationContext}${contractContext}\n\nQuestion: ${question}` },
    ] as any, { temperature: 0, max_tokens: 2200, model: PLANNER_MODEL, requestPurpose });
    const specContent = planner.data.choices?.[0]?.message?.content || '';
    const draftSpec = extractJSONObject(specContent);
    const plannerUsage = planner.data.usage || {};
    let tokens = plannerUsage.total_tokens || ((plannerUsage.prompt_tokens || 0) + (plannerUsage.completion_tokens || 0)) || 0;
    if (!draftSpec) return { sql: '', tokens, model: planner.model, error: 'AI planner returned an invalid query specification', blocked: true };
    const canonicalIntent = queryContract ? buildCanonicalQueryIntent(queryContract) : undefined;
    const spec = canonicalIntent
        ? reconcileQuerySpecWithCanonicalIntent(draftSpec, canonicalIntent)
        : draftSpec;
    if (spec.clarification) {
        return { sql: '', tokens, model: planner.model, error: spec.clarification, blocked: true, querySpec: spec, canonicalIntent };
    }

    const userContext = `Schema:\n${schemaText}${presentationContext}${contractContext}\n\nDynamic Query Specification:\n${JSON.stringify(spec, null, 2)}\n\nQuestion: ${question}\n\nSQL:`;
    const drafted = await fetchWithFallback([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContext },
    ] as any, { temperature: 0, max_tokens: 2400, model: LUNA_MODEL, requestPurpose });
    let sql = extractSQL(drafted.data.choices?.[0]?.message?.content || '');
    const draftUsage = drafted.data.usage || {};
    tokens += draftUsage.total_tokens || ((draftUsage.prompt_tokens || 0) + (draftUsage.completion_tokens || 0)) || 0;

    // Sol independently checks every request against the question, schema and
    // structured plan, then returns the final executable SQL.
    const reviewed = await fetchWithFallback([
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nAct as an independent reviewer. Keep the candidate unchanged when it already satisfies the question, schema, and deterministic contract. Correct only concrete violations. Never add collection aggregates, summary columns, grouping, CTEs, windows, or limits that the question and contract do not require. Return only final SQL.` },
        { role: 'user', content: `${userContext}\n\nCandidate SQL:\n${sql}\n\nFinal reviewed SQL:` },
    ] as any, { temperature: 0, max_tokens: 2400, model: SOL_MODEL, requestPurpose });
    sql = extractSQL(reviewed.data.choices?.[0]?.message?.content || '');
    const reviewUsage = reviewed.data.usage || {};
    tokens += reviewUsage.total_tokens || ((reviewUsage.prompt_tokens || 0) + (reviewUsage.completion_tokens || 0)) || 0;
    let modelUsedForSQL = `${planner.model} → ${drafted.model} → ${reviewed.model}`;
    console.log(`[AI SQL] Dynamic three-model route: ${modelUsedForSQL}`);

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
            querySpec: spec,
            canonicalIntent,
        };
    }

    let safe = validateReadOnlySQL(sql);
    if (!safe.ok) return { sql, tokens, model: modelUsedForSQL, error: `Unsafe SQL rejected: ${safe.reason}`, querySpec: spec, canonicalIntent };
    if (queryContract) {
        let contractIssues = validateSQLAgainstContract(safe.sql, queryContract)
            .filter(issue => issue.severity === 'error');
        if (contractIssues.length) {
            // A contract should help the system recover, not merely turn a
            // detectable omission into a user-facing failure. Give the reviewer
            // one focused, metadata-only correction before failing closed.
            const contractRepair = await fetchWithFallback([
                {
                    role: 'system',
                    content: `${SYSTEM_PROMPT}\n\nThe previous SQL failed a deterministic query contract. Repair every listed violation while preserving the question, exact schema identifiers, read-only safety, and DuckDB dialect. Do not remove requested filters or change the result grain merely to make the SQL pass. Return only corrected SQL.`,
                },
                {
                    role: 'user',
                    content: `Schema:\n${schemaText}${presentationContext}\n\nQuestion:\n${question}\n\nDynamic Query Specification:\n${JSON.stringify(spec, null, 2)}\n\nDeterministic Query Contract:\n${formatQueryContractForPrompt(queryContract)}\n\nRejected SQL:\n${safe.sql}\n\nContract violations:\n${contractIssues.map(issue => `- ${issue.message}`).join('\n')}\n\nCorrected SQL:`,
                },
            ] as any, { temperature: 0, max_tokens: 2400, model: SOL_MODEL, requestPurpose });
            const repairUsage = contractRepair.data.usage || {};
            tokens += repairUsage.total_tokens
                || ((repairUsage.prompt_tokens || 0) + (repairUsage.completion_tokens || 0))
                || 0;
            const repairedSQL = extractSQL(contractRepair.data.choices?.[0]?.message?.content || '');
            const repairedSafe = validateReadOnlySQL(repairedSQL);
            if (repairedSafe.ok) {
                const remainingIssues = validateSQLAgainstContract(repairedSafe.sql, queryContract)
                    .filter(issue => issue.severity === 'error');
                if (!remainingIssues.length) {
                    sql = repairedSafe.sql;
                    safe = repairedSafe;
                    contractIssues = [];
                    modelUsedForSQL = `${modelUsedForSQL} → ${contractRepair.model}`;
                    console.log('[AI SQL] Query contract repair accepted corrected SQL.');
                } else {
                    contractIssues = remainingIssues;
                }
            }

            if (contractIssues.length) {
                return {
                    sql: safe.sql,
                    tokens,
                    model: modelUsedForSQL,
                    error: `Query contract rejected the SQL after repair: ${contractIssues.map(issue => issue.message).join(' ')}`,
                    blocked: true,
                    querySpec: spec,
                    canonicalIntent,
                };
            }
        }
    }
    return { sql: safe.sql, tokens, model: modelUsedForSQL, querySpec: spec, canonicalIntent };
}
