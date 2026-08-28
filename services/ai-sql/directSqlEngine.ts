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
import {
    formatAnalyticalIRForPrompt,
    verifyAnalyticalIR,
    type AnalyticalIR,
    type AnalyticalOperator,
} from './analyticalIR';
import { compileAnalyticalIRToSQL } from './analyticalSqlAst';

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
- Obey the physical type printed in the schema for temporal fields. Cast a VARCHAR full-date column before DATE_TRUNC / EXTRACT / date_diff or DATE-literal comparison. Compare numeric calendar fields such as Year directly as numbers and NEVER CAST a NUMBER to DATE. Use native DATE values directly when the schema reports DATE.
- JOIN across tables when needed, following the listed foreign keys.
- Respect table ownership and join grain. A field is read from the physical table that owns it; a same-named field in another table is not interchangeable. When a one-to-many join would duplicate a measure from the one-side, pre-aggregate at the required grain before joining (or aggregate only the owning table) rather than summing duplicated values.
- For counts of related records, count the related table's stable key or rows after the declared join. For counts of parent entities, use COUNT(DISTINCT parent_key) when the join fans out.
- Treat absence and exclusion as set logic. Questions such as "entities with no related records" require NOT EXISTS, LEFT JOIN ... IS NULL, or EXCEPT against the related table; never simulate absence by grouping only the primary table and writing HAVING COUNT(...) = 0.
- Treat "both population A and population B", "in both", and "common to" as set intersection. Use INTERSECT, two correlated EXISTS predicates, or equivalent conditional aggregation, and emit each requested entity once.
- Preserve the requested output entity and grain. Do not return a continent when country names were requested, or collapse several requested rows into one group.
- For grouped membership thresholds such as "grades with 4 or more students", return exactly one row per qualifying group. Use GROUP BY ... HAVING (or select once from an already-grouped CTE); never use the grouped result merely to filter and re-project the original detail rows.
- Lock the OUTER SELECT to the fields and calculations the user explicitly asks to see. An aggregate used only to define a filter (for example, products above average sales) belongs in a subquery/CTE predicate and does not turn the outer result into COUNT, SUM, or AVG.
- For a single-winner question, return one row at the requested entity grain. Do not return the winning entity's underlying detail rows, and do not expose helper fields used only to calculate the winner.
- ORDER BY the exact criterion requested by the user. Direction and LIMIT do not make a ranking correct when the sort expression is an unrelated metric. A grouped ranking sorts by its group aggregate; a row-level superlative sorts by the raw requested attribute; a frequency winner sorts by COUNT(*).
- Treat "most/least common", "most/least frequent", and inverse wording such as "the type that the most records belong to" as frequency rankings: group by the requested answer field, rank by COUNT(*) in the correct direction, and return the requested winner. The count may remain an ORDER BY helper when the user asks only for the winning field.
- Never replace requested names, labels, dates, or other row attributes with COUNT, SUM, LIST, ARRAY_AGG, STRING_AGG, or ANY_VALUE. Use collection aggregates only when the user explicitly requests a single packed list.
- Do not infer an aggregation from a physical column name containing words such as number, count, total, or amount. Aggregation comes from the question's requested operation.
- Prefer the simplest SQL only among candidates that are equally faithful. When the query contract requires a running total, moving average, period growth, partitioned/explicit rank, percent of total, or analytical buckets, preserve that operation with the required CTE/window structure; never remove it merely to simplify the SQL.
- Implement required tableCalculations in SQL, not as an unstated presentation step. Use the declared outputAlias. For windows, aggregate to the requested base grain in a CTE/subquery first when necessary, then apply OVER with the declared PARTITION BY, ORDER BY and frame. Running totals use ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW; N-period moving averages use ROWS BETWEEN N-1 PRECEDING AND CURRENT ROW; period growth uses LAG; within-group top-N uses a partitioned ranking window.
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
        tableCalculations?: Array<{
            type: string;
            expression?: string;
            partitionBy?: string[];
            orderBy?: string[];
            windowSize?: number;
            buckets?: number;
            outputAlias?: string;
            required?: boolean;
        }>;
        ratio?: {
            kind: 'percentage' | 'ratio';
            basis: 'row_count' | 'measure';
            numerator: { description: string; expression?: string; filters?: Array<{ field: string; operator: string; value: unknown }> };
            denominator: { description: string; expression?: string; filters?: Array<{ field: string; operator: string; value: unknown }> };
            scale?: number;
        };
    };
    expectedResult: { grain: string; columns: string[]; explanation?: string };
    assumptions: string[];
    clarification?: string;
}

const SPEC_PROMPT = `You are the planning stage of a privacy-first analytics system.
Translate the question into a JSON Query Specification. You receive only a database schema and metadata, never data rows.
Capture all requested analytical operations dynamically: measures/aggregations, filters, GROUP BY, HAVING, sorting, limits, joins, date logic, and window or table calculations. A requested advanced calculation is part of the answer contract, not optional presentation metadata: record its partition, chronological order, frame/window size and stable output alias. Use only exact physical schema fields and table names. When an entity is the answer, choose its human-readable descriptive field for expectedResult (not an opaque ID) whenever the schema provides one; IDs can be an optional secondary reference.
Keep every predicate in the specification at its correct scope. Row predicates belong in filters/WHERE; aggregate predicates belong in having/HAVING. A field needed only for filtering, joining, or ordering must not be added to expectedResult or GROUP BY unless the question asks to display or group by it.
For rankings, record the exact ranking expression and result cardinality. Distinguish a raw-field row ranking, a grouped aggregate ranking, and a frequency ranking; never infer LIMIT 1 when the wording requests every group.
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
- Every percentage/ratio MUST populate operations.ratio with separate numerator and denominator definitions. Filters that define the denominator cohort belong in both populations; the condition being measured belongs only in the numerator. Do not put the numerator-only condition in the outer WHERE because that changes the denominator.
- Only include in expectedResult.columns the fields the question explicitly requests. Do not add extra columns (event_name, budget_id, etc.) unless asked.

Across multiple tables, identify which table owns every output, filter and measure. Follow only declared relationship edges, and plan pre-aggregation whenever joining would otherwise multiply the measure's native grain.
Return valid JSON only with: goal, operations, expectedResult, assumptions, clarification.
If the schema genuinely cannot answer the question (no relevant table or column exists), set clarification instead of inventing a field.`;

function extractJSONObject(content: string): DynamicQuerySpec | null {
    const raw = (content || '').replace(/\`\`\`json|\`\`\`/gi, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]) as DynamicQuerySpec; } catch { return null; }
}

function uniqueStrings(values: unknown[]): string[] {
    const strings = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return strings.filter((value, index, all) =>
        all.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index
    );
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

    if (canonical.answerKind === 'detail_projection' || canonical.answerKind === 'set_result') {
        spec.operations.measures = [];
        spec.operations.groupBy = [];
    } else {
        const existingMeasures = spec.operations.measures || [];
        spec.operations.measures = canonical.measures.map(measure => {
            const aggregation = measure.aggregation;
            const existing = existingMeasures.find(measure =>
                typeof measure.aggregation === 'string' && measure.aggregation.toLowerCase() === aggregation
            )
                || existingMeasures[0];
            if (existing) return { ...existing, field: measure.field || existing.field, aggregation };
            if (measure.field) return { field: measure.field, aggregation };
            return aggregation === 'count'
                ? { aggregation, expression: 'COUNT(*)' }
                : { aggregation };
        });
        spec.operations.measures.push(...canonical.computedMeasures.map(metric => ({
            field: metric.id,
            aggregation: 'formula',
            expression: metric.formula,
        })));

        if (canonical.grainFields.length) {
            const existingGroups = spec.operations.groupBy || [];
            spec.operations.groupBy = canonical.grainFields.map(field =>
                existingGroups.find(group =>
                    typeof group.field === 'string' && group.field.toLowerCase() === field.toLowerCase()
                ) || { field }
            );
        } else if (canonical.cardinality === 'scalar') {
            spec.operations.groupBy = [];
        }
    }

    if (canonical.constraints.prohibitImplicitLimit) delete spec.operations.limit;
    if (canonical.order?.limit !== undefined) spec.operations.limit = canonical.order.limit;
    if (canonical.predicates.length) {
        const existingFilters = spec.operations.filters || [];
        for (const predicate of canonical.predicates.filter(item => item.confidence === 'high' && item.scope === 'where')) {
            const existing = existingFilters.find(filter =>
                typeof filter.field === 'string' && filter.field.toLowerCase() === predicate.field.toLowerCase()
            );
            const canonicalFilter = {
                ...(existing || {}),
                field: predicate.field,
                operator: predicate.operator,
                value: predicate.value,
            };
            const index = existing ? existingFilters.indexOf(existing) : -1;
            if (index >= 0) existingFilters[index] = canonicalFilter;
            else existingFilters.push(canonicalFilter);
        }
        spec.operations.filters = existingFilters;
        const existingHaving = spec.operations.having || [];
        for (const predicate of canonical.predicates.filter(item => item.confidence === 'high' && item.scope === 'having')) {
            const alreadyPresent = existingHaving.some(item =>
                typeof item.expression === 'string'
                && item.expression.toLowerCase().includes(predicate.field.toLowerCase())
            );
            if (!alreadyPresent) {
                existingHaving.push({
                    expression: `${predicate.field} ${predicate.operator} ${JSON.stringify(predicate.value)}`,
                });
            }
        }
        spec.operations.having = existingHaving;
    }
    if (canonical.ratio) {
        const existingRatio = spec.operations.ratio;
        spec.operations.ratio = {
            kind: canonical.ratio.kind,
            basis: canonical.ratio.basis,
            numerator: existingRatio?.numerator || {
                description: canonical.ratio.basis === 'row_count'
                    ? 'count the qualifying subset only'
                    : 'sum the qualifying measure only',
            },
            denominator: existingRatio?.denominator || {
                description: canonical.ratio.basis === 'row_count'
                    ? 'count the complete requested reference population'
                    : 'sum the complete requested reference population',
            },
            scale: canonical.ratio.kind === 'percentage' ? 100 : existingRatio?.scale,
        };
    }

    if (canonical.analyticOperations.length) {
        // The canonical contract owns explicitly requested advanced analytics.
        // A planner may enrich expressions, but it may not silently omit the
        // calculation or change its partition/order/window semantics.
        spec.operations.tableCalculations = canonical.analyticOperations.map(operation => ({
            type: operation.kind,
            partitionBy: [...operation.partitionBy],
            orderBy: operation.orderBy ? [operation.orderBy] : [],
            windowSize: operation.windowSize,
            buckets: operation.buckets,
            outputAlias: operation.outputAlias,
            required: true,
        }));
    }
    if (canonical.relationship.path.length) {
        spec.operations.joins = canonical.relationship.path.map(step => ({
            leftTable: step.fromTable,
            rightTable: step.toTable,
            condition: `"${step.fromTable}"."${step.fromColumn}" = "${step.toTable}"."${step.toColumn}"`,
            purpose: step.fansOut
                ? 'Declared relationship; preserve measure grain before crossing this fan-out edge'
                : 'Declared relationship required by the canonical query intent',
        }));
    }
    if (canonical.order) {
        const current = spec.operations.orderBy?.[0];
        const rankedMeasure = canonical.measures[0];
        const canonicalExpression = canonical.order.mode === 'frequency'
            ? 'COUNT(*)'
            : canonical.order.aggregation && canonical.order.field
                ? `${canonical.order.aggregation.toUpperCase()}(${canonical.order.field})`
                : canonical.order.field
                    ? canonical.order.field
                    : rankedMeasure
                        ? rankedMeasure.aggregation === 'count' && !rankedMeasure.field
                            ? 'COUNT(*)'
                            : `${rankedMeasure.aggregation.toUpperCase()}(${rankedMeasure.field || 'requested measure'})`
                        : undefined;
        spec.operations.orderBy = [{
            expression: canonicalExpression || canonical.order.field || current?.expression
                || (canonical.aggregations[0]
                    ? `${canonical.aggregations[0].toUpperCase()}(...)`
                    : canonical.grainFields[0] || 'requested ranking measure'),
            direction: canonical.order.direction,
        }];
    }

    // The model draft is not allowed to widen the answer schema. Previously we
    // unioned its columns back in after canonical reconciliation, which is how
    // raw measures and unrelated attributes leaked into SELECT/GROUP BY (for
    // example grouping by satisfaction_score while also averaging it).
    const visibleGrain = uniqueStrings([...canonical.visibleFields, ...canonical.grainFields]);
    const visibleMeasures = canonical.answerKind === 'detail_projection'
        ? []
        : canonical.measures.map(measure => measure.field
            ? `${measure.aggregation.toUpperCase()}(${measure.field})`
            : `${measure.aggregation.toUpperCase()}(*)`);
    const visibleComputed = canonical.computedMeasures.map(metric => metric.id);
    spec.expectedResult.columns = canonical.constraints.strictOutputProjection
        ? [...visibleGrain]
        : uniqueStrings([...visibleGrain, ...visibleMeasures, ...visibleComputed]);
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
    /** Non-security semantic mismatches retained for confidence/audit purposes. */
    contractWarnings?: string[];
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

export interface SQLCandidateDecision {
    sql: string;
    source: 'draft' | 'review';
    contractErrors: number;
    contractWarnings: number;
    complexity: number;
}

/**
 * Make the frozen Analytical IR authoritative over the model-authored query
 * specification. Expressions may be enriched by the model, but answer fields,
 * grain, populations, joins, ranking and limits cannot drift.
 */
export function reconcileQuerySpecWithAnalyticalIR(
    draft: DynamicQuerySpec,
    ir: AnalyticalIR,
): DynamicQuerySpec {
    const spec: DynamicQuerySpec = JSON.parse(JSON.stringify(draft));
    spec.operations ||= {};
    spec.expectedResult ||= { grain: '', columns: [] };
    spec.assumptions ||= [];

    const find = <K extends AnalyticalOperator['kind']>(kind: K) =>
        ir.operators.filter((operator): operator is Extract<AnalyticalOperator, { kind: K }> => operator.kind === kind);
    const aggregates = find('aggregate').flatMap(operator => operator.measures);
    const calculations = find('derive').flatMap(operator => operator.calculations);
    const groups = find('group')[0]?.grain || [];
    const filters = find('filter').flatMap(operator => operator.predicates);
    const rank = find('rank')[0];
    const limit = find('limit')[0];
    const ratio = find('ratio')[0];
    const joins = find('join')[0];
    const windows = find('window');

    if (ir.answer.kind === 'detail_projection' || ir.answer.kind === 'set_result') {
        spec.operations.measures = [];
        spec.operations.groupBy = [];
    } else {
        const existingMeasures = spec.operations.measures || [];
        spec.operations.measures = aggregates.map(measure => {
            const existing = existingMeasures.find(candidate =>
                candidate.field?.toLowerCase() === measure.field.toLowerCase()
                && candidate.aggregation?.toLowerCase() === measure.aggregation
            ) || existingMeasures.find(candidate => candidate.aggregation?.toLowerCase() === measure.aggregation);
            if (measure.field === '*') return { ...(existing || {}), aggregation: 'count', expression: 'COUNT(*)' };
            return { ...(existing || {}), field: measure.field, aggregation: measure.aggregation };
        });
        spec.operations.measures.push(...calculations.map(calculation => ({
            field: calculation.id,
            aggregation: 'formula',
            expression: calculation.formula,
        })));
        spec.operations.groupBy = groups.map(group => ({ field: group.field }));
    }

    spec.operations.filters = filters
        .filter(predicate => predicate.scope === 'where')
        .map(predicate => ({ field: predicate.field, operator: predicate.operator, value: predicate.value }));
    spec.operations.having = filters
        .filter(predicate => predicate.scope === 'having')
        .map(predicate => ({ expression: `${predicate.field} ${predicate.operator} ${JSON.stringify(predicate.value)}` }));

    if (joins) {
        spec.operations.joins = joins.path.map(step => ({
            leftTable: step.fromTable,
            rightTable: step.toTable,
            condition: `"${step.fromTable}"."${step.fromColumn}" = "${step.toTable}"."${step.toColumn}"`,
            purpose: step.fansOut
                ? 'Pre-aggregate the owning measure before this fan-out relationship.'
                : 'Relationship required by the frozen analytical IR.',
        }));
    }
    if (rank) {
        const expression = rank.mode === 'frequency'
            ? 'COUNT(*)'
            : rank.aggregation && rank.target
                ? `${rank.aggregation.toUpperCase()}(${rank.target.field})`
                : rank.target?.field || 'requested ranking expression';
        spec.operations.orderBy = [{ expression, direction: rank.direction }];
    }
    if (limit) spec.operations.limit = limit.count;
    else if (ir.constraints.prohibitImplicitLimit) delete spec.operations.limit;
    if (ratio) {
        const numerator = ir.populations.find(population => population.id === ratio.numeratorPopulationId);
        const denominator = ir.populations.find(population => population.id === ratio.denominatorPopulationId);
        spec.operations.ratio = {
            kind: ratio.scale === 100 ? 'percentage' : 'ratio',
            basis: ratio.basis,
            numerator: {
                description: numerator?.description || 'qualifying population',
                filters: numerator?.filters.map(filter => ({ field: filter.field, operator: filter.operator, value: filter.value })),
            },
            denominator: {
                description: denominator?.description || 'reference population',
                filters: denominator?.filters.map(filter => ({ field: filter.field, operator: filter.operator, value: filter.value })),
            },
            scale: ratio.scale,
        };
    }
    if (windows.length) {
        spec.operations.tableCalculations = windows.map(({ operation }) => ({
            type: operation.kind,
            partitionBy: [...operation.partitionBy],
            orderBy: operation.orderBy ? [operation.orderBy] : [],
            windowSize: operation.windowSize,
            buckets: operation.buckets,
            outputAlias: operation.outputAlias,
            required: true,
        }));
    }

    spec.expectedResult.columns = ir.answer.fields
        .filter(field => field.visibility === 'visible')
        .map(field => field.field);
    spec.expectedResult.grain = ir.answer.cardinality === 'scalar'
        ? 'one scalar result row'
        : ir.answer.grain.length
            ? `one row per ${ir.answer.grain.map(field => field.field).join(' + ')}`
            : 'one row per matching entity';
    if (ir.confidence.unresolved.length === 0) spec.clarification = undefined;
    spec.assumptions = [
        ...spec.assumptions,
        `Frozen Analytical IR v${ir.version} governs this query.`,
        `Result kind: ${ir.answer.kind}; cardinality: ${ir.answer.cardinality}.`,
    ];
    return spec;
}

function splitSqlList(value: string): string[] {
    const items: string[] = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            if (char === quote && value[index - 1] !== '\\') quote = '';
            continue;
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === ',' && depth === 0) {
            items.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    items.push(value.slice(start).trim());
    return items.filter(Boolean);
}

function bareSqlIdentifier(value: string): string | undefined {
    const withoutAlias = value.replace(/\s+(?:as\s+)?["`]?[A-Za-z_][\w$]*["`]?\s*$/i, '').trim();
    if (!/^(?:["`]?[A-Za-z_][\w$]*["`]?\.)?["`]?[A-Za-z_][\w$]*["`]?$/.test(withoutAlias)) return undefined;
    return withoutAlias.replace(/["`]/g, '').split('.').pop()?.toLowerCase();
}

/**
 * Apply only contract-preserving, syntax-local corrections that do not require
 * data values or business vocabulary. Complex CTE/subquery/set SQL is left to
 * the model reviewer. This catches the recurring wrong-grain shape where an
 * aggregate input is also emitted raw and added to GROUP BY.
 */
export function normalizeSimpleSQLToContract(sql: string, contract?: QueryContract): string {
    if (!contract || (contract.analyticOperations?.length || 0) > 0 || /^\s*with\b/i.test(sql) || (sql.match(/\bselect\b/gi) || []).length !== 1) return sql;
    let normalized = sql.trim();

    if (contract.prohibitsImplicitLimit) {
        normalized = normalized.replace(/\s+limit\s+\d+\s*;?\s*$/i, '').trim();
    }
    if (contract.requiresDistinctProjection && /^\s*select\s+(?!distinct\b)/i.test(normalized)) {
        normalized = normalized.replace(/^\s*select\s+/i, 'SELECT DISTINCT ');
    }
    if (!contract.requiresGrouping) return normalized;

    const match = normalized.match(/^\s*select\s+([\s\S]*?)\s+from\s+([\s\S]*?)\s+group\s+by\s+([\s\S]*?)(?=\s+having\b|\s+order\s+by\b|\s+limit\b|$)/i);
    if (!match) return normalized;
    const aggregateArguments = new Set<string>();
    for (const aggregate of match[1].matchAll(/\b(?:sum|avg|min|max|median)\s*\(\s*(?:["`]?[A-Za-z_][\w$]*["`]?\.)?["`]?([A-Za-z_][\w$]*)["`]?\s*\)/gi)) {
        aggregateArguments.add(aggregate[1].toLowerCase());
    }
    if (!aggregateArguments.size && !(contract.allowedGroupingFields || []).length) return normalized;

    const originalGroups = splitSqlList(match[3]);
    const allowedGrouping = new Set((contract.allowedGroupingFields || []).map(field => field.toLowerCase()));
    const removedGrouping = new Set<string>();
    const groups = originalGroups.filter(item => {
        const identifier = bareSqlIdentifier(item);
        const removeAggregateInput = !!identifier && aggregateArguments.has(identifier);
        const removeUnexpectedGrain = !!identifier && allowedGrouping.size > 0 && !allowedGrouping.has(identifier);
        if (identifier && (removeAggregateInput || removeUnexpectedGrain)) removedGrouping.add(identifier);
        return !removeAggregateInput && !removeUnexpectedGrain;
    });
    if (!groups.length || groups.length === originalGroups.length) return normalized;

    const selected = splitSqlList(match[1]).filter(item => {
        const identifier = bareSqlIdentifier(item);
        return !identifier || (!aggregateArguments.has(identifier) && !removedGrouping.has(identifier));
    });
    if (!selected.length) return normalized;

    const groupStart = (match.index || 0) + match[0].toLowerCase().lastIndexOf('group by');
    const groupBodyStart = normalized.indexOf(match[3], groupStart + 'group by'.length);
    if (groupBodyStart < 0) return normalized;
    const groupBodyEnd = groupBodyStart + match[3].length;
    normalized = `${normalized.slice(0, groupBodyStart)}${groups.join(', ')}${normalized.slice(groupBodyEnd)}`;

    const selectKeywordEnd = normalized.search(/\bselect\b/i) + 'select'.length;
    const selectBodyStart = normalized.indexOf(match[1], selectKeywordEnd);
    if (selectBodyStart < 0) return normalized;
    const selectBodyEnd = selectBodyStart + match[1].length;
    normalized = `${normalized.slice(0, selectBodyStart)}${selected.join(', ')}${normalized.slice(selectBodyEnd)}`;
    return normalized.trim();
}

function sqlStructuralComplexity(sql: string, contract?: QueryContract): number {
    const count = (pattern: RegExp) => (sql.match(pattern) || []).length;
    const advanced = contract?.analyticOperations || [];
    const requiredWindow = advanced.some(operation => operation.implementation === 'window');
    const requiredAdvancedStructure = advanced.length > 0;
    // Required analytical structure is not complexity debt. It is penalised
    // only when the question/contract does not call for it.
    return count(/\bwith\b/gi) * (requiredAdvancedStructure ? 0 : 3)
        + count(/\bjoin\b/gi) * 2
        + count(/\bover\s*\(/gi) * (requiredWindow ? 0 : 3)
        + count(/\bselect\b/gi)
        + count(/\bunion\b/gi) * 2
        + count(/\bgroup\s+by\b/gi);
}

/**
 * A reviewer is advisory, not automatically authoritative. Select the SQL
 * candidate that best satisfies the deterministic contract, then prefer the
 * simpler faithful expression. This prevents a later model from replacing a
 * correct projection/ranking with a more elaborate but less faithful query.
 */
export function chooseBestSQLCandidate(
    draftSQL: string,
    reviewedSQL: string,
    queryContract?: QueryContract,
): SQLCandidateDecision {
    const evaluate = (sql: string, source: SQLCandidateDecision['source']): SQLCandidateDecision & { safe: boolean } => {
        const safety = validateReadOnlySQL(sql);
        const issues = safety.ok && queryContract ? validateSQLAgainstContract(safety.sql, queryContract) : [];
        return {
            sql: safety.ok ? safety.sql : sql,
            source,
            safe: safety.ok,
            contractErrors: safety.ok ? issues.filter(issue => issue.severity === 'error').length : Number.MAX_SAFE_INTEGER,
            contractWarnings: safety.ok ? issues.filter(issue => issue.severity === 'warn').length : Number.MAX_SAFE_INTEGER,
            complexity: safety.ok ? sqlStructuralComplexity(safety.sql, queryContract) : Number.MAX_SAFE_INTEGER,
        };
    };
    const draft = evaluate(draftSQL, 'draft');
    const review = evaluate(reviewedSQL, 'review');
    const rank = (candidate: typeof draft) => [
        candidate.safe ? 0 : 1,
        candidate.contractErrors,
        candidate.contractWarnings,
        candidate.complexity,
    ];
    const draftRank = rank(draft);
    const reviewRank = rank(review);
    for (let index = 0; index < draftRank.length; index += 1) {
        if (draftRank[index] < reviewRank[index]) return draft;
        if (reviewRank[index] < draftRank[index]) return review;
    }
    // Equal evidence: retain the independent review.
    return review;
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
            // Query contracts are semantic evidence, not a security boundary.
            // A read-only repair must remain executable so local result checks
            // (and benchmark gold comparison) can judge it on the answer it
            // actually produced instead of misclassifying it as infrastructure
            // failure.
            console.warn('[AI SQL] Semantic repair retained with advisory contract issues:', contractIssues.map(issue => issue.message));
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
    analyticalIR?: AnalyticalIR,
): Promise<DirectSQLResult> {
    // Once a frozen IR exists, do not also show the model a mutable legacy
    // plan. Even when labelled advisory, two overlapping representations invite
    // the planner to cherry-pick conflicting grain, projection, or limits.
    const planContext = analysisPlan && !analyticalIR
        ? `\n\nUntrusted local semantic hints (advisory only):\n${JSON.stringify(analysisPlan, null, 2)}\nDo not copy a metric, dimension, filter, grouping, or limit from these hints unless it is grounded by the user's question and physical schema. The deterministic query contract and the user's requested output take precedence over every conflicting hint.`
        : '';
    const verificationContext = plannerVerification?.length
        ? `\n\nLocal diagnostics to consider:\n${JSON.stringify(plannerVerification, null, 2)}`
        : '';
    const presentationContext = buildEntityPresentationContext(semanticModel);
    const contractContext = queryContract
        ? `\n\nDeterministic Query Contract (mandatory; do not weaken or replace it):\n${formatQueryContractForPrompt(queryContract)}`
        : '';
    const analyticalIRContext = analyticalIR
        ? `\n\nFrozen Canonical Analytical IR (authoritative; compile these operators and populations exactly):\n${formatAnalyticalIRForPrompt(analyticalIR)}`
        : '';

    // Terra interprets the question into a typed, open-ended analytical plan.
    // This is deliberately not a collection of keyword rules: the specification
    // can represent aggregations, filters, joins, windows, table calculations,
    // and any schema-grounded analytical shape.
    const planner = await fetchWithFallback([
        { role: 'system', content: SPEC_PROMPT },
        { role: 'user', content: `Schema:\n${schemaText}${presentationContext}${planContext}${verificationContext}${contractContext}${analyticalIRContext}\n\nQuestion: ${question}` },
    ] as any, { temperature: 0, max_tokens: 2200, model: PLANNER_MODEL, requestPurpose });
    const specContent = planner.data.choices?.[0]?.message?.content || '';
    const draftSpec = extractJSONObject(specContent);
    const plannerUsage = planner.data.usage || {};
    let tokens = plannerUsage.total_tokens || ((plannerUsage.prompt_tokens || 0) + (plannerUsage.completion_tokens || 0)) || 0;
    if (!draftSpec) return { sql: '', tokens, model: planner.model, error: 'AI planner returned an invalid query specification', blocked: true };
    const canonicalIntent = queryContract ? buildCanonicalQueryIntent(queryContract) : undefined;
    const canonicalSpec = canonicalIntent
        ? reconcileQuerySpecWithCanonicalIntent(draftSpec, canonicalIntent)
        : draftSpec;
    const spec = analyticalIR
        ? reconcileQuerySpecWithAnalyticalIR(canonicalSpec, analyticalIR)
        : canonicalSpec;
    if (spec.clarification) {
        return { sql: '', tokens, model: planner.model, error: spec.clarification, blocked: true, querySpec: spec, canonicalIntent };
    }

    const userContext = `Schema:\n${schemaText}${presentationContext}${contractContext}${analyticalIRContext}\n\nDynamic Query Specification:\n${JSON.stringify(spec, null, 2)}\n\nQuestion: ${question}\n\nSQL:`;
    const drafted = await fetchWithFallback([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContext },
    ] as any, { temperature: 0, max_tokens: 2400, model: LUNA_MODEL, requestPurpose });
    const draftSQL = extractSQL(drafted.data.choices?.[0]?.message?.content || '');
    const draftUsage = drafted.data.usage || {};
    tokens += draftUsage.total_tokens || ((draftUsage.prompt_tokens || 0) + (draftUsage.completion_tokens || 0)) || 0;

    // Sol independently checks every request against the question, schema and
    // structured plan, then returns the final executable SQL.
    const reviewed = await fetchWithFallback([
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nAct as an independent reviewer. Keep the candidate unchanged when it already satisfies the question, schema, and deterministic contract. Correct only concrete violations. Before returning SQL, audit: (1) outer SELECT contains only requested answer fields/calculations, (2) GROUP BY is exactly the requested grain, (3) ranking expression, direction, cardinality and tie behaviour match the wording, (4) aggregate predicates are in HAVING/subqueries without leaking helper metrics into the answer, (5) ratio numerator and denominator use the correct populations, (6) joins follow the declared ownership path, (7) list/set answers cannot repeat because of join fan-out, and (8) every required tableCalculation is implemented with its declared partition, order, frame and output alias. Never add collection aggregates, summary columns, grouping, CTEs, windows, or limits that the question and contract do not require; never remove a required CTE/window/table calculation merely to make SQL shorter. Return only final SQL.` },
        { role: 'user', content: `${userContext}\n\nCandidate SQL:\n${draftSQL}\n\nFinal reviewed SQL:` },
    ] as any, { temperature: 0, max_tokens: 2400, model: SOL_MODEL, requestPurpose });
    const reviewedSQL = extractSQL(reviewed.data.choices?.[0]?.message?.content || '');
    const reviewUsage = reviewed.data.usage || {};
    tokens += reviewUsage.total_tokens || ((reviewUsage.prompt_tokens || 0) + (reviewUsage.completion_tokens || 0)) || 0;
    let modelUsedForSQL = `${planner.model} → ${drafted.model} → ${reviewed.model}`;
    const candidateDecision = chooseBestSQLCandidate(draftSQL, reviewedSQL, queryContract);
    let sql = normalizeSimpleSQLToContract(candidateDecision.sql, queryContract);
    if (sql !== candidateDecision.sql) {
        console.log('[AI SQL] Deterministic contract normalizer removed an aggregate input from the raw SELECT/GROUP BY grain or removed an unrequested LIMIT.');
    }
    if (candidateDecision.source === 'draft') {
        console.log(`[AI SQL] Retained the draft SQL because the reviewer candidate was less faithful or more complex (${candidateDecision.contractErrors} contract error(s), complexity ${candidateDecision.complexity}).`);
    }
    if (analyticalIR) {
        const structuralCandidate = compileAnalyticalIRToSQL(analyticalIR);
        const structuralIRIssues = verifyAnalyticalIR(analyticalIR).filter(issue => issue.severity === 'error');
        if (structuralCandidate.supported && structuralCandidate.sql && structuralIRIssues.length === 0) {
            const modelIssues = queryContract
                ? validateSQLAgainstContract(sql, queryContract).filter(issue => issue.severity === 'error')
                : [];
            const structuralIssues = queryContract
                ? validateSQLAgainstContract(structuralCandidate.sql, queryContract).filter(issue => issue.severity === 'error')
                : [];
            if (structuralIssues.length === 0) {
                sql = structuralCandidate.sql;
                modelUsedForSQL = `${modelUsedForSQL} → IR-AST recovery`;
                console.warn(`[AI SQL] Selected the contract-valid frozen IR AST as the authoritative executable form (${modelIssues.length} model contract error(s)).`);
            }
        }
    }
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
    let contractWarnings: string[] = [];
    if (queryContract) {
        let contractIssues = validateSQLAgainstContract(safe.sql, queryContract)
            .filter(issue => issue.severity === 'error');
        if (contractIssues.length) {
            // A contract should help the system recover, not merely turn a
            // detectable omission into a user-facing failure. Give the reviewer
            // one focused, metadata-only correction. If that optional repair is
            // unavailable, preserve the already-generated read-only SQL.
            try {
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
                    const repairDecision = chooseBestSQLCandidate(safe.sql, repairedSafe.sql, queryContract);
                    if (repairDecision.source === 'review') {
                        sql = repairDecision.sql;
                        safe = validateReadOnlySQL(repairDecision.sql);
                        modelUsedForSQL = `${modelUsedForSQL} → ${contractRepair.model}`;
                        console.log('[AI SQL] Query contract repair retained the stronger read-only SQL candidate.');
                    }
                    contractIssues = validateSQLAgainstContract(safe.sql, queryContract)
                        .filter(issue => issue.severity === 'error');
                }
            } catch (repairError: any) {
                console.warn('[AI SQL] Optional contract repair unavailable; retaining the original read-only SQL:', repairError?.message || repairError);
            }

            if (contractIssues.length) {
                contractWarnings = contractIssues.map(issue => issue.message);
                console.warn('[AI SQL] Read-only SQL will execute with advisory contract issues:', contractWarnings);
            }
        }
    }
    return { sql: safe.sql, tokens, model: modelUsedForSQL, querySpec: spec, canonicalIntent, contractWarnings };
}
