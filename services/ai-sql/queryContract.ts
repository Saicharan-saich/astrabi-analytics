/**
 * Query Contract — executable faithfulness requirements for AI-generated SQL.
 *
 * This is the shared deterministic contract between intent planning and SQL
 * generation. It deliberately resolves only high-confidence facts from the
 * question and schema: requested entity/grain, required tables, aggregation,
 * ranking, comparison and negative-existence semantics. The LLM may still
 * choose the best SQL shape, but it may not silently change those facts.
 */
import type { AnalysisPlan, SemanticModel } from './types';
import { planJoins, type JoinLink, type JoinTable } from './joinEngine';
import { inferQueryShape, type SelectionMode } from './queryShape';

export interface QuerySchemaContext {
    tables: JoinTable[];
    links: JoinLink[];
}

export interface QueryEntityContract {
    table: string;
    field: string;
    /** Confidence is intentionally coarse. Only high-confidence resolutions
     * are enforced; weaker candidates stay as model context, never hard gates. */
    confidence: 'high' | 'medium';
}

export interface QueryContract {
    requirements: string[];
    /** Result shape requested by the wording, independent of the draft plan. */
    expectedCardinality: 'scalar' | 'grouped' | 'detail';
    requiresGrouping: boolean;
    requiresFiscalCalendar: boolean;
    requiresRanking: boolean;
    selectionMode: SelectionMode;
    prohibitsImplicitLimit: boolean;
    requiresDistinctProjection: boolean;
    /** Physical fields the outer SELECT must expose, resolved independently
     * from the draft plan so a bad plan cannot replace names with a count. */
    requiredOutputFields: QueryEntityContract[];
    /** Single-answer questions expose only explicitly requested physical fields;
     * helper dimensions may still be used in joins, grouping and ordering. */
    strictOutputProjection: boolean;
    forbiddenOutputFields: string[];
    /** The outer SELECT returns source entities/attributes. Aggregates may still
     * appear in a subquery or HAVING predicate when the filter requires them. */
    requiresRowProjection: boolean;
    /** Conservative, locally-computable row expectation. It is emitted only
     * when metadata can establish the answer population without seeing values. */
    resultRowExpectation?: {
        exact?: number;
        minimum?: number;
        maximum?: number;
        basis: 'scalar' | 'source_rows' | 'distinct_groups' | 'explicit_limit';
    };
    /** Row-level listing ordered by a raw field; aggregation/grouping is forbidden. */
    orderedProjection?: {
        fields: string[];
        orderBy: string;
        direction: 'asc' | 'desc';
        unbounded: boolean;
    };
    /** Numeric limit explicitly requested by a top/bottom ranking question. */
    rankingLimit?: number;
    rankingDirection?: 'asc' | 'desc';
    requiresComparison: boolean;
    /** Exact schema field requested for the grouping, when confidently resolved. */
    requiredDimension?: string;
    /** Human-readable entity the question asks the result to return. */
    outputEntity?: QueryEntityContract;
    /** Physical tables explicitly implicated by the question/plan. */
    requiredTables: string[];
    /** Join path, including bridge tables, derived from the relationship graph. */
    relationshipPath: Array<{
        fromTable: string;
        fromColumn: string;
        toTable: string;
        toColumn: string;
        fansOut: boolean;
    }>;
    existenceMode: 'none' | 'anti';
    /** Positive relationships default to matched records; LEFT JOIN is used
     * only when the wording explicitly asks to retain unmatched entities. */
    relationshipMode: 'none' | 'inner' | 'left' | 'anti';
    expectedAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
    threshold?: {
        operator: '>=' | '>' | '<=' | '<' | '=';
        value: number;
        requiresHaving: boolean;
    };
    /** Whether a requested ratio is based on entities/rows or an additive measure. */
    ratio?: {
        kind: 'percentage' | 'ratio';
        basis: 'row_count' | 'measure';
        subject?: string;
    };
    /** Explicit relative-average language fixes where aggregation must occur. */
    relativeComparison?: {
        scope: 'row_to_global_average' | 'group_aggregate_to_group_average';
    };
}

export interface SQLFaithfulnessIssue {
    code:
        | 'missing_grouping'
        | 'unexpected_grouping'
        | 'unexpected_aggregation'
        | 'missing_requested_output'
        | 'missing_distinct_projection'
        | 'unexpected_limit'
        | 'missing_ordering_field'
        | 'missing_requested_dimension'
        | 'missing_output_entity'
        | 'missing_required_table'
        | 'missing_relationship_path'
        | 'wrong_join_semantics'
        | 'missing_existence_logic'
        | 'missing_aggregation'
        | 'wrong_ratio_basis'
        | 'wrong_comparison_scope'
        | 'missing_comparator'
        | 'missing_fiscal_calendar'
        | 'missing_ranking'
        | 'wrong_ranking_direction'
        | 'missing_comparison'
        | 'unexpected_result_cardinality';
    severity: 'error' | 'warn';
    message: string;
}

const BREAKDOWN_CUE = /\b(by|per|for each|for every|breakdown by|split by|grouped by)\s+[a-z]/i;
const COMPARISON_CUE = /\b(vs\.?|versus|compared to|comparison|month[- ]over[- ]month|year[- ]over[- ]year|mom|yoy|qoq|wow)\b/i;
const FISCAL_CUE = /\bfiscal\s+(?:year|quarter|calendar)\b/i;
const ANTI_EXISTENCE_CUE = /\b(?:without|never|not\s+a\s+single|with\s+no|(?:do|does|did)\s+not\s+have|(?:has|have|had)\s+no|zero\s+(?:related\s+)?\w+)\b/i;

const STOP_WORDS = new Set([
    'a', 'an', 'all', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'each',
    'for', 'from', 'have', 'has', 'in', 'is', 'it', 'of', 'on', 'or', 'per',
    'show', 'the', 'their', 'them', 'there', 'to', 'what', 'which', 'who', 'with',
]);

function singular(token: string): string {
    const t = token.toLowerCase();
    if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
    if (t.endsWith('ses') && t.length > 4) return t.slice(0, -2);
    if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
    return t;
}

/** Small domain-neutral vocabulary bridges common schema nouns. */
function conceptVariants(token: string): Set<string> {
    const base = singular(token);
    const variants = new Set([base]);
    const pairs: Record<string, string[]> = {
        maker: ['manufacturer', 'producer'],
        manufacturer: ['maker', 'producer'],
        person: ['people'],
        people: ['person'],
        employee: ['staff', 'worker'],
        staff: ['employee', 'worker'],
        client: ['customer'],
        customer: ['client', 'buyer'],
        item: ['product'],
        product: ['item'],
    };
    for (const value of pairs[base] || []) variants.add(value);
    return variants;
}

function words(value: string): string[] {
    return value
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map(singular)
        .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function conceptMatches(schemaToken: string, questionTokens: Set<string>): boolean {
    return [...conceptVariants(schemaToken)].some(token => questionTokens.has(token));
}

function targetClause(question: string): string {
    const normalized = question.toLowerCase().replace(/[?!.]+$/g, '');
    const lead = normalized
        .replace(/^\s*(?:what\s+(?:are|is)\s+the\s+)?/, '')
        .replace(/^\s*(?:which|who|list|find|show|return|give me)\s+/, '')
        .replace(/^\s*(?:the\s+)?names?\s+of\s+(?:the\s+)?/, '');
    return lead.split(/\b(?:who|that|which|whose|where|with|without|having|have|has|had|and\s+how|ordered|sorted|ranked|by)\b/i)[0];
}

function descriptiveColumn(name: string): boolean {
    return /(?:^|_)(?:name|title|label|description)$/i.test(name)
        || /(?:Name|Title|Label|Description)$/.test(name);
}

function identifierColumn(name: string, isPK?: boolean): boolean {
    return !!isPK || /(?:^|_)(?:id|key|code)$/i.test(name) || /(?:Id|ID|Key|Code)$/.test(name);
}

function schemaContextFromModel(model?: SemanticModel): QuerySchemaContext | undefined {
    if (!model) return undefined;
    return {
        tables: [{
            name: 'data',
            rowCount: model.rowCount,
            columns: model.fields.map(field => ({
                name: field.name,
                isPK: field.semanticType === 'identifier' && field.distinctCount >= model.rowCount * 0.98,
            })),
        }],
        links: [],
    };
}

function requestedAnswerClause(question: string): string {
    // If the user finishes with an explicit "list/show/return ..." instruction,
    // that final clause is the clearest statement of the requested output.
    const explicit = [...question.matchAll(/\b(?:list|show|return|display|give(?:\s+me)?)\s+(?:the\s+)?/gi)].pop();
    const source = explicit?.index !== undefined
        ? question.slice(explicit.index + explicit[0].length)
        : question.replace(/^\s*(?:please\s+)?(?:what\s+(?:are|is)|which|who|find|tell\s+me)\s+(?:the\s+)?/i, '');
    const structural = source.split(/\b(?:whose|where|who|that|with|have|has|had|having|named|ordered|sorted|ranked|in\s+(?:ascending|descending)\s+order|for\s+all|for\s+each|for\s+every|and\s+how\s+many)\b/i)[0].trim();
    // In "Which <entity> ... the most/least <measure>?", everything after the
    // superlative describes ranking, not extra output columns.
    return /^\s*(?:which|what)\b/i.test(question)
        ? structural.split(/\b(?:the\s+)?(?:most|fewest|least|highest|lowest|largest|smallest|maximum|minimum|best|worst)\b/i)[0].trim()
        : structural;
}

/** Resolve outer result fields directly from question wording and schema. */
function resolveRequestedOutputFields(
    question: string,
    plan: AnalysisPlan,
    schema: QuerySchemaContext | undefined,
    model?: SemanticModel,
): QueryEntityContract[] {
    if (!schema?.tables.length) return [];
    const clause = requestedAnswerClause(question);
    const clauseTokens = new Set(words(clause));
    const planFields = new Set([
        ...(plan.projectionFields || []),
        ...plan.dimensions.map(dimension => dimension.field),
    ].map(field => field.toLowerCase()));
    const duplicateFieldCounts = new Map<string, number>();
    for (const table of schema.tables) {
        for (const column of table.columns) {
            const key = column.name.toLowerCase();
            duplicateFieldCounts.set(key, (duplicateFieldCounts.get(key) || 0) + 1);
        }
    }
    const answerTables = new Set(schema.tables
        .filter(table => words(table.name).some(token => conceptMatches(token, clauseTokens)))
        .map(table => table.name));

    const candidates: Array<QueryEntityContract & { score: number }> = [];
    for (const table of schema.tables) {
        const tableTokens = words(table.name);
        // Output ownership is resolved from the answer clause, not from filter
        // or relationship nouns elsewhere in the question. This prevents a
        // duplicated column such as Name from being required from every joined
        // table merely because those tables participate in the query.
        const tableMentioned = tableTokens.some(token => conceptMatches(token, clauseTokens));
        if (answerTables.size > 0 && !answerTables.has(table.name)) continue;
        for (const column of table.columns) {
            const semanticField = model?.fields.find(field => field.name.toLowerCase() === column.name.toLowerCase());
            const aliases = [column.name, semanticField?.displayLabel, ...(semanticField?.synonyms || [])]
                .filter((value): value is string => !!value);
            let bestCoverage = 0;
            for (const alias of aliases) {
                const aliasTokens = words(alias);
                if (!aliasTokens.length) continue;
                const overlap = aliasTokens.filter(token => conceptMatches(token, clauseTokens)).length;
                bestCoverage = Math.max(bestCoverage, overlap / aliasTokens.length);
            }
            if (bestCoverage === 0) continue;
            let score = bestCoverage * 75;
            if (tableMentioned) score += 20;
            const duplicateCount = duplicateFieldCounts.get(column.name.toLowerCase()) || 0;
            if (duplicateCount === 1) score += 15;
            else if (!tableMentioned) score -= 25;
            if (planFields.has(column.name.toLowerCase())) score += 5;
            if (score < 65) continue;
            candidates.push({
                table: table.name,
                field: column.name,
                confidence: score >= 80 ? 'high' : 'medium',
                score,
            });
        }
    }

    candidates.sort((a, b) => b.score - a.score || a.table.localeCompare(b.table) || a.field.localeCompare(b.field));
    const selected: QueryEntityContract[] = [];
    const seenConcepts = new Set<string>();
    for (const candidate of candidates) {
        const concept = words(candidate.field).join('_');
        if (seenConcepts.has(concept)) continue;
        seenConcepts.add(concept);
        const { score: _score, ...field } = candidate;
        selected.push(field);
        if (selected.length >= 6) break;
    }
    return selected;
}

/** Resolve the human-readable entity named in the result request. */
function resolveOutputEntity(
    question: string,
    plan: AnalysisPlan,
    schema?: QuerySchemaContext,
): QueryEntityContract | undefined {
    if (!schema?.tables.length) return undefined;
    const allQuestionTokens = new Set(words(question));
    const targetTokens = new Set(words(targetClause(question)));
    const planDimensions = new Set(plan.dimensions.map(d => d.field.toLowerCase()));
    const candidates: Array<QueryEntityContract & { score: number }> = [];

    for (const table of schema.tables) {
        const tableTokens = words(table.name);
        const tableInTarget = tableTokens.some(token => conceptMatches(token, targetTokens));
        const tableInQuestion = tableTokens.some(token => conceptMatches(token, allQuestionTokens));
        for (const column of table.columns) {
            const columnTokens = words(column.name);
            const semanticTokens = columnTokens.filter(token => !['id', 'key', 'code', 'name', 'title', 'label', 'description'].includes(token));
            const columnInTarget = semanticTokens.some(token => conceptMatches(token, targetTokens));
            const columnInQuestion = semanticTokens.some(token => conceptMatches(token, allQuestionTokens));
            const isDescriptive = descriptiveColumn(column.name);
            const isIdentifier = identifierColumn(column.name, column.isPK);

            let score = 0;
            if (tableInTarget) score += 7;
            else if (tableInQuestion) score += 3;
            if (columnInTarget) score += 6;
            else if (columnInQuestion) score += 2;
            if (isDescriptive) score += 4;
            if (isIdentifier) score -= 5;
            if (planDimensions.has(column.name.toLowerCase())) score += 4;
            if (columnTokens.length === 1 && ['name', 'title', 'label', 'description'].includes(columnTokens[0]) && tableInTarget) score += 3;

            if (score >= 6) {
                candidates.push({
                    table: table.name,
                    field: column.name,
                    confidence: score >= 10 ? 'high' : 'medium',
                    score,
                });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score
        || Number(descriptiveColumn(b.field)) - Number(descriptiveColumn(a.field))
        || a.field.localeCompare(b.field));
    if (!candidates.length) return undefined;
    const { score: _score, ...entity } = candidates[0];
    return entity;
}

function resolveRequestedDimension(question: string, model?: SemanticModel): string | undefined {
    if (!model) return undefined;
    const normalized = question.toLowerCase();
    if (FISCAL_CUE.test(normalized)) {
        return model.fields.find(f => f.semanticType === 'date' && f.role === 'dimension')?.name
            || model.timeContext?.primaryDateColumn;
    }

    const phrase = question.match(/\b(?:for\s+each|for\s+every|per|by|each|every)\s+([^?.,;]+)/i)?.[1] || question;
    const phraseTokens = new Set(words(phrase));
    const questionTokens = new Set(words(question));
    let best: { field: string; score: number } | undefined;
    for (const field of model.fields.filter(f => f.role === 'dimension')) {
        const names = [field.name, field.displayLabel, ...(field.synonyms || [])];
        for (const name of names) {
            const nameTokens = words(name);
            if (!nameTokens.length) continue;
            const phraseOverlap = nameTokens.filter(token => conceptMatches(token, phraseTokens)).length;
            const questionOverlap = nameTokens.filter(token => conceptMatches(token, questionTokens)).length;
            const exactPhrase = phraseOverlap === nameTokens.length && phraseTokens.size === nameTokens.length;
            const score = exactPhrase ? 100
                : (phraseOverlap / nameTokens.length) * 60 + (questionOverlap / nameTokens.length) * 30;
            if (score < 45) continue;
            if (!best || score > best.score) best = { field: field.name, score };
        }
    }
    return best?.field;
}

function resolveOrderedProjection(
    question: string,
    plan: AnalysisPlan,
    model: SemanticModel | undefined,
    outputEntity: QueryEntityContract | undefined,
): QueryContract['orderedProjection'] {
    const shape = inferQueryShape(question);
    if (!shape.orderedProjection && plan.intent !== 'projection') return undefined;
    const phrase = shape.orderFieldPhrase;
    const phraseTokens = new Set(words(phrase || ''));
    let orderBy = plan.sort[0]?.field;
    if (model && phraseTokens.size) {
        let best: { field: string; score: number } | undefined;
        for (const field of model.fields) {
            const fieldTokens = words(field.name);
            const overlap = fieldTokens.filter(token => conceptMatches(token, phraseTokens)).length;
            const score = fieldTokens.length ? overlap / fieldTokens.length : 0;
            if (score > 0.6 && (!best || score > best.score)) best = { field: field.name, score };
        }
        orderBy = best?.field || orderBy;
    }
    if (!orderBy) return undefined;
    const fields = [...new Set([
        ...(plan.projectionFields || []),
        ...(outputEntity?.confidence === 'high' ? [outputEntity.field] : []),
    ])];
    if (!fields.length) return undefined;
    return {
        fields,
        orderBy,
        direction: shape.orderDirection || plan.sort[0]?.dir || 'asc',
        unbounded: shape.prohibitsImplicitLimit,
    };
}

function resolveExpectedAggregation(question: string, plan: AnalysisPlan): QueryContract['expectedAggregation'] {
    if (/\b(how many|number of|count(?: of)?|count the)\b/i.test(question)) return 'count';
    if (/\b(average|avg|mean)\b/i.test(question)) return 'avg';
    if (/\b(total|sum(?: of)?)\b/i.test(question)) return 'sum';
    if (/\b(minimum|min value)\b/i.test(question)) return 'min';
    if (/\b(maximum|max value)\b/i.test(question)) return 'max';
    if (/\b(?:last|latest|most recent)\s+(?:date|time|timestamp)\b/i.test(question)) return 'max';
    if (/\b(?:first|earliest)\s+(?:date|time|timestamp)\b/i.test(question)) return 'min';
    // Do not turn the local plan's guess into a hard requirement. The contract
    // exists to constrain explicit user intent, not to amplify planner errors.
    return undefined;
}

function resolveThreshold(question: string): Omit<NonNullable<QueryContract['threshold']>, 'requiresHaving'> | undefined {
    const patterns: Array<{ re: RegExp; operator: '>=' | '>' | '<=' | '<' | '=' }> = [
        { re: /\b(?:at\s+least|no\s+fewer\s+than|minimum\s+of)\s+(-?\d+(?:\.\d+)?)/i, operator: '>=' },
        { re: /\b(?:more\s+than|greater\s+than|over)\s+(-?\d+(?:\.\d+)?)/i, operator: '>' },
        { re: /\b(?:at\s+most|no\s+more\s+than|maximum\s+of)\s+(-?\d+(?:\.\d+)?)/i, operator: '<=' },
        { re: /\b(?:fewer\s+than|less\s+than|under)\s+(-?\d+(?:\.\d+)?)/i, operator: '<' },
        { re: /\b(?:exactly|equal\s+to)\s+(-?\d+(?:\.\d+)?)/i, operator: '=' },
    ];
    for (const { re, operator } of patterns) {
        const match = question.match(re);
        if (match) return { operator, value: Number(match[1]) };
    }
    return undefined;
}

function thresholdUsesAggregate(question: string): boolean {
    const comparator = /\b(?:at\s+least|more\s+than|greater\s+than|over|at\s+most|fewer\s+than|less\s+than|under|exactly|equal\s+to)\b/i.exec(question);
    if (!comparator) return false;
    // Only the phrase immediately governing the comparison decides WHERE vs
    // HAVING. An aggregate elsewhere must not move a raw-field predicate into
    // HAVING (for example "count pets whose age is over 20").
    const nearby = question.slice(Math.max(0, comparator.index - 80), comparator.index);
    return /\b(?:total|sum|average|avg|mean|count|number\s+of|minimum|maximum|min|max)\b[^?.,;]{0,60}$/i.test(nearby);
}

function resolveRatio(
    question: string,
    model?: SemanticModel,
): QueryContract['ratio'] {
    const cue = question.match(/\b(percentage|percent|proportion|ratio|share)\b/i);
    if (!cue) return undefined;
    const normalized = question.toLowerCase().replace(/_/g, ' ');
    const metricNames = (model?.fields || [])
        .filter(field => field.role === 'metric')
        .flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])])
        .map(value => value.toLowerCase().replace(/_/g, ' ').trim())
        .filter(value => value.length >= 3);
    const dimensionNames = (model?.fields || [])
        .filter(field => field.role === 'dimension' || field.semanticType === 'identifier')
        .flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])])
        .map(value => value.toLowerCase().replace(/_/g, ' ').trim())
        .filter(value => value.length >= 3);
    const explicitMetric = metricNames.find(name => normalized.includes(name))
        || normalized.match(/\b(?:cost|amount|sales|revenue|profit|spend|budget|price|income|weight|quantity|value)\b/)?.[0];
    const explicitEntity = dimensionNames.find(name => normalized.includes(name))
        || normalized.match(/\b(?:accounts?|patients?|members?|people|persons?|customers?|students?|employees?|teachers?|superheroes?|orders?|transactions?|events?|records?|rows?)\b/)?.[0];

    // If both occur, the noun immediately governed by "percentage/share of"
    // decides the denominator: "percentage of accounts" is a row count even
    // when an amount column also appears elsewhere in the question.
    const governedSubject = normalized.match(/\b(?:percentage|percent|proportion|share)\s+of\s+(?:the\s+)?([a-z][a-z0-9 _-]{1,40}?)(?=\s+(?:that|which|who|with|where|among|in|for|is|are|was|were)\b|[?.!,]|$)/)?.[1]?.trim();
    const governedLooksMetric = !!governedSubject && metricNames.some(name => governedSubject.includes(name))
        || !!governedSubject && /\b(?:cost|amount|sales|revenue|profit|spend|budget|price|income|value)\b/.test(governedSubject);
    const governedLooksEntity = !!governedSubject && dimensionNames.some(name => governedSubject.includes(name))
        || !!governedSubject && /\b(?:accounts?|patients?|members?|customers?|students?|employees?|teachers?|superheroes?|orders?|transactions?|events?|records?|rows?)\b/.test(governedSubject);
    const basis = governedLooksEntity ? 'row_count'
        : governedLooksMetric ? 'measure'
        : explicitEntity && !explicitMetric ? 'row_count'
        : explicitMetric && !explicitEntity ? 'measure'
        : undefined;
    if (!basis) return undefined;
    return {
        kind: /ratio/i.test(cue[1]) ? 'ratio' : 'percentage',
        basis,
        subject: governedSubject || explicitEntity || explicitMetric,
    };
}

function resolveRelativeComparison(question: string): QueryContract['relativeComparison'] {
    if (!/\b(?:above|below|more|greater|higher|less|lower|fewer)\s+than\s+(?:the\s+)?(?:overall\s+)?average\b/i.test(question)) {
        return undefined;
    }
    const aggregateEntityCue = /\b(?:total|sum|combined|aggregate|per\s+\w+|for\s+each\s+\w+)\b/i.test(question);
    return {
        scope: aggregateEntityCue ? 'group_aggregate_to_group_average' : 'row_to_global_average',
    };
}

function resolveRequiredTables(
    question: string,
    plan: AnalysisPlan,
    schema: QuerySchemaContext | undefined,
    outputEntity: QueryEntityContract | undefined,
    requiredOutputFields: QueryEntityContract[] = [],
): string[] {
    if (!schema || schema.tables.length <= 1) return [];
    const qTokens = new Set(words(question));
    const planFields = new Set([
        ...plan.dimensions.map(d => d.field.toLowerCase()),
        ...plan.metrics.map(m => m.field.toLowerCase()),
        ...plan.filters.map(f => f.field.toLowerCase()),
    ]);
    const required = new Set<string>();
    if (outputEntity) required.add(outputEntity.table);
    for (const field of requiredOutputFields) required.add(field.table);

    for (const table of schema.tables) {
        const tableMentioned = words(table.name).some(token => conceptMatches(token, qTokens));
        const fieldMentioned = table.columns.some(column => {
            if (planFields.has(column.name.toLowerCase())) return true;
            const semantic = words(column.name).filter(token => !['id', 'key', 'code', 'name', 'title', 'label', 'description'].includes(token));
            return semantic.length > 0 && semantic.some(token => conceptMatches(token, qTokens));
        });
        if (tableMentioned || fieldMentioned) required.add(table.name);
    }
    return [...required];
}

/** Build a concise, privacy-safe contract from question, plan and schema graph. */
export function buildQueryContract(
    question: string,
    plan: AnalysisPlan,
    verification: Array<{ code?: string; message?: string }> = [],
    model?: SemanticModel,
    schemaContext?: QuerySchemaContext,
): QueryContract {
    const requirements: string[] = [];
    const schema = schemaContext || schemaContextFromModel(model);
    const requestedOutputFields = resolveRequestedOutputFields(question, plan, schema, model);
    const inferredOutputEntity = resolveOutputEntity(question, plan, schema);
    const outputEntity = inferredOutputEntity
        || requestedOutputFields.find(field => descriptiveColumn(field.field))
        || requestedOutputFields[0];
    const queryShape = inferQueryShape(question);
    const orderedProjection = resolveOrderedProjection(question, plan, model, outputEntity);
    const existenceMode = ANTI_EXISTENCE_CUE.test(question) ? 'anti' : 'none';
    const requiresFiscalCalendar = FISCAL_CUE.test(question);
    const breakdownQuestion = question.replace(
        /\bby\s+(?:the\s+)?(?:youngest|oldest|earliest|latest|newest|highest|lowest|best|worst)\s+\w+/gi,
        '',
    );
    const answerClause = requestedAnswerClause(question);
    const answerAggregation = resolveExpectedAggregation(answerClause, plan);
    const asksCountAlongsideEntity = /\band\s+how\s+many\b/i.test(question);
    const requiresRowProjection = requestedOutputFields.some(field => field.confidence === 'high')
        && !answerAggregation
        && !asksCountAlongsideEntity
        && queryShape.operation !== 'ranking';
    const planRequiresEntityAggregation = !requiresRowProjection && !!outputEntity
        && plan.metrics.some(metric => ['sum', 'avg', 'count', 'count_distinct'].includes(metric.agg))
        && !['single_metric', 'distribution'].includes(plan.intent);
    const explicitGroupingCue = queryShape.operation === 'grouped_aggregate'
        || BREAKDOWN_CUE.test(breakdownQuestion)
        || /\b(?:in|for)\s+each\b/i.test(question)
        || (asksCountAlongsideEntity && !!outputEntity);
    const explicitScalarAggregationCue = /\b(?:how many|number of|count(?: of)?|what is (?:the )?(?:average|mean|total|sum|minimum|maximum)|what are (?:the )?(?:minimum and maximum|maximum and minimum))\b/i.test(question);
    const requiresGrouping = !requiresRowProjection && !orderedProjection && (!explicitScalarAggregationCue || explicitGroupingCue)
        && (requiresFiscalCalendar
            || BREAKDOWN_CUE.test(breakdownQuestion)
            || verification.some(issue => issue.code === 'missing_dimension')
            || (existenceMode === 'none' && planRequiresEntityAggregation));
    const requiresRanking = !orderedProjection && queryShape.operation === 'ranking';
    const rankingLimit = requiresRanking
        ? queryShape.explicitLimit || (queryShape.selection === 'single' ? 1 : undefined)
        : undefined;
    const rankingDirection = requiresRanking
        ? queryShape.orderDirection
            || (/\b(bottom|lowest|least|worst|smallest|fewest|minimum|youngest|earliest)\b/i.test(question) ? 'asc' : 'desc')
        : undefined;
    const requiresComparison = COMPARISON_CUE.test(question) || Boolean(plan.comparison);
    const requiredDimension = requiresGrouping
        ? resolveRequestedDimension(question, model) || (outputEntity?.confidence === 'high' ? outputEntity.field : undefined)
        : undefined;
    let expectedAggregation = orderedProjection || requiresRowProjection ? undefined : resolveExpectedAggregation(question, plan);
    const expectedCardinality: QueryContract['expectedCardinality'] = orderedProjection || requiresRowProjection ? 'detail'
        : requiresGrouping ? 'grouped'
        : expectedAggregation && explicitScalarAggregationCue ? 'scalar'
        : 'detail';
    const requiredTables = resolveRequiredTables(question, plan, schema, outputEntity, requestedOutputFields);
    const resolvedThreshold = resolveThreshold(question);
    const threshold = resolvedThreshold
        ? {
            ...resolvedThreshold,
            requiresHaving: thresholdUsesAggregate(question),
        }
        : undefined;
    // "countries with at least 3 manufacturers" is a related-entity count even
    // though it never says "count". This inference is safe only when the output
    // entity and a distinct related table have both been schema-grounded.
    if (!expectedAggregation && threshold && outputEntity && requiredTables.some(table => table !== outputEntity.table)) {
        expectedAggregation = 'count';
        threshold.requiresHaving = true;
    }
    // A superlative over a related table is a count-of-related-records ranking
    // unless the question names another explicit aggregation. This is derived
    // from the relationship graph, not from a benchmark/domain vocabulary.
    if (!expectedAggregation && requiresRanking && outputEntity
        && requiredTables.some(table => table !== outputEntity.table)
        && /\b(?:most|fewest|least)\b/i.test(question)) {
        expectedAggregation = 'count';
    }
    const strictOutputProjection = queryShape.selection === 'single'
        && requestedOutputFields.some(field => field.confidence === 'high');
    const requestedPhysicalFields = new Set(requestedOutputFields.map(field => field.field.toLowerCase()));
    const forbiddenOutputFields = strictOutputProjection && schema
        ? [...new Set(schema.tables
            .flatMap(table => table.columns.map(column => column.name))
            .filter(field => !requestedPhysicalFields.has(field.toLowerCase())))]
        : [];
    const ratio = resolveRatio(question, model);
    const relativeComparison = resolveRelativeComparison(question);
    const joinPlan = schema && requiredTables.length > 1
        ? planJoins(requiredTables, schema.tables, schema.links, outputEntity && existenceMode === 'anti' ? { baseTable: outputEntity.table } : undefined)
        : undefined;
    const relationshipPath = (joinPlan?.steps || []).map(step => ({
        fromTable: step.toTable,
        fromColumn: step.fromColumn,
        toTable: step.table,
        toColumn: step.toColumn,
        fansOut: step.fansOut,
    }));
    const explicitlyInclusive = /\b(?:all|every)\s+\w+[\s\S]{0,50}\b(?:including|even if|whether or not|with or without)\b|\bincluding\s+(?:those|ones|entities|records)\s+with\s+(?:no|zero)\b/i.test(question);
    const relationshipMode: QueryContract['relationshipMode'] = existenceMode === 'anti'
        ? 'anti'
        : relationshipPath.length ? (explicitlyInclusive ? 'left' : 'inner')
        : 'none';
    const requiresDistinctProjection = queryShape.distinctRequested
        && !expectedAggregation
        && !requiresGrouping;
    const canUsePrimaryTableStatistics = !!model
        && (schema?.tables.length || 0) === 1
        && relationshipMode === 'none'
        && plan.filters.length === 0
        && !requiresComparison
        && !threshold;
    let resultRowExpectation: QueryContract['resultRowExpectation'];
    if (expectedCardinality === 'scalar') {
        resultRowExpectation = { exact: 1, basis: 'scalar' };
    } else if (queryShape.selection === 'single') {
        resultRowExpectation = { exact: 1, basis: 'explicit_limit' };
    } else if (queryShape.selection === 'top_n' && queryShape.explicitLimit) {
        const dimension = requiredDimension
            ? model?.fields.find(field => field.name.toLowerCase() === requiredDimension.toLowerCase())
            : undefined;
        resultRowExpectation = canUsePrimaryTableStatistics && dimension
            ? { exact: Math.min(queryShape.explicitLimit, dimension.distinctCount), basis: 'explicit_limit' }
            : { maximum: queryShape.explicitLimit, basis: 'explicit_limit' };
    } else if (canUsePrimaryTableStatistics && orderedProjection && !queryShape.distinctRequested && model!.rowCount > 0) {
        resultRowExpectation = { exact: model!.rowCount, basis: 'source_rows' };
    } else if (canUsePrimaryTableStatistics && queryShape.selection === 'all_groups' && requiredDimension) {
        const dimension = model!.fields.find(field => field.name.toLowerCase() === requiredDimension.toLowerCase());
        if (dimension && dimension.distinctCount > 0) {
            // distinctCount is derived locally and may be sampled for very large
            // files, so it is a lower bound rather than an exact assertion.
            resultRowExpectation = { minimum: dimension.distinctCount, basis: 'distinct_groups' };
        }
    }

    if (outputEntity?.confidence === 'high') requirements.push(`Return ${outputEntity.table}.${outputEntity.field} as the visible answer entity.`);
    if (requestedOutputFields.length) requirements.push(`The outer SELECT must expose the requested answer field(s): ${requestedOutputFields.map(field => `${field.table}.${field.field}`).join(', ')}.`);
    if (requiresRowProjection) requirements.push('Preserve row/entity projection in the outer SELECT. Do not replace requested fields with COUNT, SUM, AVG, LIST, ARRAY_AGG, STRING_AGG, or ANY_VALUE; aggregates may appear only inside a predicate/subquery when required by the filter.');
    if (strictOutputProjection) requirements.push('Return only the explicitly requested answer fields in the outer SELECT. Helper fields may be used in joins, grouping, predicates, and ORDER BY but must not leak into the displayed result.');
    if (orderedProjection) requirements.push(`Return row-level fields ${orderedProjection.fields.join(', ')} ordered by ${orderedProjection.orderBy} ${orderedProjection.direction.toUpperCase()}; do not aggregate, group, or truncate the result.`);
    if (expectedCardinality === 'scalar') requirements.push('Return one aggregate result row; filters do not become grouping dimensions unless the question explicitly says by/per/for each.');
    if (requiresGrouping) requirements.push('Return the requested entity/breakdown grain, not a scalar or higher-level grouping.');
    if (requiredDimension) requirements.push(`Group at the requested grain "${requiredDimension}".`);
    if (requiredTables.length > 1) requirements.push(`Use the required physical tables: ${requiredTables.join(', ')}.`);
    if (relationshipPath.length) requirements.push(`Follow the declared relationship path: ${relationshipPath.map(step => `${step.fromTable}.${step.fromColumn} = ${step.toTable}.${step.toColumn}`).join(' -> ')}.`);
    if (relationshipMode === 'inner') requirements.push('Use matched-record (INNER JOIN) semantics; do not add unmatched zero-count entities with LEFT JOIN.');
    if (relationshipMode === 'left') requirements.push('Preserve unmatched output entities with LEFT JOIN semantics because the question explicitly asks for them.');
    if (existenceMode === 'anti') requirements.push('Preserve the full output-entity population and express absence with NOT EXISTS, LEFT JOIN ... IS NULL, NOT IN, or EXCEPT.');
    if (expectedAggregation) requirements.push(`Use ${expectedAggregation.toUpperCase()} semantics for the requested measure.`);
    if (threshold) requirements.push(`${threshold.requiresHaving ? 'Apply the aggregate threshold in HAVING' : 'Apply the threshold'}: ${threshold.operator} ${threshold.value}.`);
    if (ratio?.basis === 'row_count') requirements.push('Calculate the requested ratio from row/entity counts, not from summed monetary or quantity values.');
    if (ratio?.basis === 'measure') requirements.push('Calculate the requested ratio from the additive measure named in the question, not from row counts.');
    if (relativeComparison?.scope === 'row_to_global_average') requirements.push('Compare each underlying row value with the global row-level average before projecting the requested entity; do not average or sum by entity first.');
    if (relativeComparison?.scope === 'group_aggregate_to_group_average') requirements.push('Aggregate at the requested entity grain first, then compare each entity aggregate with the average across entity aggregates.');
    if (requiresFiscalCalendar) requirements.push('Use the requested fiscal calendar definition, including its stated start month.');
    if (requiresRanking) requirements.push(`Rank ${rankingDirection === 'asc' ? 'ascending' : 'descending'}${rankingLimit ? ` and return ${rankingLimit}` : ''}.`);
    if (requiresComparison) requirements.push('Return both requested comparison periods with clearly labelled result columns or rows.');
    if (requiresDistinctProjection) requirements.push('Return every distinct requested value using SELECT DISTINCT; do not arbitrarily truncate the unique result set.');
    if (resultRowExpectation?.exact !== undefined) requirements.push(`Return exactly ${resultRowExpectation.exact} result row(s); this cardinality is established from the requested shape and local metadata.`);
    else if (resultRowExpectation?.minimum !== undefined) requirements.push(`Return at least ${resultRowExpectation.minimum} result row(s); the local schema reports that many requested groups.`);
    else if (resultRowExpectation?.maximum !== undefined) requirements.push(`Return no more than ${resultRowExpectation.maximum} result row(s), matching the explicit requested limit.`);

    return {
        requirements,
        expectedCardinality,
        requiresGrouping,
        requiresFiscalCalendar,
        requiresRanking,
        selectionMode: queryShape.selection,
        prohibitsImplicitLimit: queryShape.prohibitsImplicitLimit,
        requiresDistinctProjection,
        requiredOutputFields: requestedOutputFields,
        strictOutputProjection,
        forbiddenOutputFields,
        requiresRowProjection,
        resultRowExpectation,
        orderedProjection,
        rankingLimit,
        rankingDirection,
        requiresComparison,
        requiredDimension,
        outputEntity,
        requiredTables,
        relationshipPath,
        existenceMode,
        relationshipMode,
        expectedAggregation,
        threshold,
        ratio,
        relativeComparison,
    };
}

function identifierPattern(identifier: string): RegExp {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:["\`]${escaped}["\`]|\\b${escaped}\\b)`, 'i');
}

/** Extract outermost SELECT lists without treating CTE/subquery aggregates as
 * outer result calculations. This is a lexical scanner, not a SQL rewriter. */
function topLevelSelectClauses(sql: string): string[] {
    const clauses: string[] = [];
    let depth = 0;
    let quote: "'" | '"' | '`' | null = null;
    let selectStart = -1;
    const keywordAt = (index: number, keyword: string): boolean => {
        if (sql.slice(index, index + keyword.length).toLowerCase() !== keyword) return false;
        const before = index > 0 ? sql[index - 1] : '';
        const after = sql[index + keyword.length] || '';
        return !/[a-z0-9_]/i.test(before) && !/[a-z0-9_]/i.test(after);
    };

    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        if (quote) {
            if (char === quote) {
                if (sql[index + 1] === quote) index += 1;
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            continue;
        }
        if (char === '(') {
            depth += 1;
            continue;
        }
        if (char === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) continue;
        if (selectStart < 0 && keywordAt(index, 'select')) {
            selectStart = index + 'select'.length;
            index += 'select'.length - 1;
            continue;
        }
        if (selectStart >= 0 && keywordAt(index, 'from')) {
            clauses.push(sql.slice(selectStart, index).trim());
            selectStart = -1;
            index += 'from'.length - 1;
        }
    }
    if (selectStart >= 0) clauses.push(sql.slice(selectStart).trim());
    return clauses;
}

/** Compact form used in model prompts; contains metadata/intent only. */
export function formatQueryContractForPrompt(contract: QueryContract): string {
    return JSON.stringify({
        outputEntity: contract.outputEntity,
        expectedCardinality: contract.expectedCardinality,
        selectionMode: contract.selectionMode,
        prohibitsImplicitLimit: contract.prohibitsImplicitLimit,
        requiresDistinctProjection: contract.requiresDistinctProjection,
        requiredOutputFields: contract.requiredOutputFields,
        strictOutputProjection: contract.strictOutputProjection,
        requiresRowProjection: contract.requiresRowProjection,
        resultRowExpectation: contract.resultRowExpectation,
        resultGrain: contract.requiredDimension,
        requiredTables: contract.requiredTables,
        relationshipPath: contract.relationshipPath,
        existenceMode: contract.existenceMode,
        relationshipMode: contract.relationshipMode,
        aggregation: contract.expectedAggregation,
        threshold: contract.threshold,
        ratio: contract.ratio,
        relativeComparison: contract.relativeComparison,
        orderedProjection: contract.orderedProjection,
        ranking: contract.requiresRanking ? { direction: contract.rankingDirection, limit: contract.rankingLimit } : undefined,
        comparison: contract.requiresComparison,
        requirements: contract.requirements,
    }, null, 2);
}

/** Verify that generated SQL preserves every high-confidence contract fact. */
export function validateSQLAgainstContract(sql: string, contract: QueryContract): SQLFaithfulnessIssue[] {
    const issues: SQLFaithfulnessIssue[] = [];
    const normalized = sql.toLowerCase();
    const outerSelects = topLevelSelectClauses(sql);
    const outerProjection = outerSelects.join('\n');
    const outerAggregatePattern = /\b(?:sum|avg|count|min|max|median|list|array_agg|string_agg|any_value)\s*\(/i;
    const groupByClauses = [...sql.matchAll(/\bgroup\s+by\s+([\s\S]*?)(?=\bhaving\b|\border\s+by\b|\blimit\b|\bunion\b|$)/gi)]
        .map(match => match[1]);

    if (contract.prohibitsImplicitLimit && /\blimit\s+\d+\b/i.test(sql)) {
        issues.push({
            code: 'unexpected_limit',
            severity: 'error',
            message: `The question requests ${contract.selectionMode === 'all_groups' ? 'all groups' : 'all matching rows'}, but the SQL truncates the answer with LIMIT.`,
        });
    }

    if (contract.requiresDistinctProjection && !/\bselect\s+distinct\b/i.test(sql)) {
        issues.push({
            code: 'missing_distinct_projection',
            severity: 'error',
            message: 'The question requests unique values, but the SQL projection does not use SELECT DISTINCT.',
        });
    }

    if (contract.orderedProjection) {
        if (outerAggregatePattern.test(outerProjection)) {
            issues.push({ code: 'unexpected_aggregation', severity: 'error', message: 'This is a row-level listing, but the SQL introduces an aggregate calculation.' });
        }
        if (/\bgroup\s+by\b/i.test(sql) && !/\bhaving\b/i.test(sql)) {
            issues.push({ code: 'unexpected_grouping', severity: 'error', message: 'This is a row-level listing, but the SQL groups and collapses records.' });
        }
        const orderField = identifierPattern(contract.orderedProjection.orderBy);
        const orderClause = sql.match(/\border\s+by\s+([\s\S]*?)(?=\blimit\b|$)/i)?.[1] || '';
        if (!orderField.test(orderClause)
            || !new RegExp(`\\b${contract.orderedProjection.direction}\\b`, 'i').test(orderClause)) {
            issues.push({
                code: 'missing_ordering_field',
                severity: 'error',
                message: `The result must be ordered by ${contract.orderedProjection.orderBy} ${contract.orderedProjection.direction.toUpperCase()}.`,
            });
        }
        for (const field of contract.orderedProjection.fields) {
            if (!identifierPattern(field).test(sql)) {
                issues.push({ code: 'missing_output_entity', severity: 'error', message: `The row-level result must include "${field}".` });
            }
        }
    }

    for (const field of contract.requiredOutputFields.filter(item => item.confidence === 'high')) {
        if (!outerSelects.some(clause => identifierPattern(field.field).test(clause))) {
            issues.push({
                code: 'missing_requested_output',
                severity: 'error',
                message: `The outer result must expose the requested field ${field.table}.${field.field}.`,
            });
        }
    }
    if (contract.strictOutputProjection) {
        for (const field of contract.forbiddenOutputFields) {
            if (outerSelects.some(clause => identifierPattern(field).test(clause))) {
                issues.push({
                    code: 'missing_requested_output',
                    severity: 'error',
                    message: `The outer result includes unrequested detail field "${field}"; keep it only in joins, predicates, grouping, or ordering.`,
                });
            }
        }
    }
    if (contract.requiresRowProjection) {
        if (outerAggregatePattern.test(outerProjection)) {
            issues.push({
                code: 'unexpected_aggregation',
                severity: 'error',
                message: 'The requested answer is a row/entity projection, but the outer SELECT replaces it with an aggregate or collection.',
            });
        }
        if (/\bgroup\s+by\b/i.test(sql) && !/\bhaving\b/i.test(sql)) {
            issues.push({
                code: 'unexpected_grouping',
                severity: 'error',
                message: 'The requested answer is a row/entity projection, but GROUP BY collapses the result without an aggregate predicate.',
            });
        }
    }

    if (contract.requiresGrouping && !/\bgroup\s+by\b/.test(normalized)) {
        issues.push({ code: 'missing_grouping', severity: 'error', message: 'The question requires an entity/breakdown grain, but the generated SQL has no GROUP BY.' });
    }
    if (contract.expectedCardinality === 'scalar' && /\bgroup\s+by\b/.test(normalized)) {
        issues.push({
            code: 'unexpected_grouping',
            severity: 'error',
            message: 'The question requests one aggregate result row, but the SQL splits it into grouped rows.',
        });
    }
    if (contract.requiredDimension) {
        const fieldPresent = identifierPattern(contract.requiredDimension).test(sql);
        const groupedAtField = groupByClauses.some(clause =>
            identifierPattern(contract.requiredDimension!).test(clause)
            // GROUP BY ordinals are valid when the requested field is selected.
            || /(?:^|,)\s*\d+\s*(?:,|$)/.test(clause)
        );
        if (!fieldPresent || (contract.requiresGrouping && groupByClauses.length > 0 && !groupedAtField)) {
            issues.push({ code: 'missing_requested_dimension', severity: 'error', message: `The SQL does not group at the requested grain "${contract.requiredDimension}".` });
        }
    }
    if (contract.outputEntity?.confidence === 'high' && !identifierPattern(contract.outputEntity.field).test(sql)) {
        issues.push({ code: 'missing_output_entity', severity: 'error', message: `The result must identify ${contract.outputEntity.table}.${contract.outputEntity.field}, but that field is absent.` });
    }
    for (const table of contract.requiredTables) {
        if (!identifierPattern(table).test(sql)) {
            issues.push({ code: 'missing_required_table', severity: 'error', message: `Required table "${table}" is absent from the SQL.` });
        }
    }
    for (const step of contract.relationshipPath) {
        const hasFrom = identifierPattern(step.fromColumn).test(sql);
        const hasTo = identifierPattern(step.toColumn).test(sql);
        if (!hasFrom || !hasTo) {
            issues.push({
                code: 'missing_relationship_path',
                severity: 'error',
                message: `The declared relationship ${step.fromTable}.${step.fromColumn} = ${step.toTable}.${step.toColumn} is not represented.`,
            });
        }
    }
    if (contract.relationshipMode === 'inner' && /\bleft\s+(?:outer\s+)?join\b/i.test(sql)) {
        issues.push({
            code: 'wrong_join_semantics',
            severity: 'error',
            message: 'The question requests matched related records, but LEFT JOIN adds unmatched entities to the answer.',
        });
    }
    if (contract.relationshipMode === 'left' && !/\bleft\s+(?:outer\s+)?join\b/i.test(sql)) {
        issues.push({
            code: 'wrong_join_semantics',
            severity: 'error',
            message: 'The question explicitly includes unmatched entities, but the SQL does not preserve them with LEFT JOIN semantics.',
        });
    }
    if (contract.existenceMode === 'anti'
        && !/(?:\bnot\s+exists\b|\bnot\s+in\s*\(|\bexcept\b|\bleft\s+(?:outer\s+)?join\b[\s\S]*\bis\s+null\b)/i.test(sql)) {
        issues.push({ code: 'missing_existence_logic', severity: 'error', message: 'The question asks for absent related records, but the SQL has no anti-join/set-difference operation.' });
    }
    if (contract.expectedAggregation) {
        const aggregate = contract.expectedAggregation === 'count' ? 'count' : contract.expectedAggregation;
        if (!new RegExp(`\\b${aggregate}\\s*\\(`, 'i').test(sql)) {
            issues.push({ code: 'missing_aggregation', severity: 'error', message: `The question requires ${aggregate.toUpperCase()} semantics, but the SQL does not use it.` });
        }
    }
    if (contract.threshold) {
        const operator = contract.threshold.operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const value = String(contract.threshold.value).replace('.', '\\.');
        const hasComparator = new RegExp(`${operator}\\s*${value}(?:\\D|$)`).test(sql);
        const hasHaving = !contract.threshold.requiresHaving || /\bhaving\b/i.test(sql);
        if (!hasComparator || !hasHaving) {
            issues.push({
                code: 'missing_comparator',
                severity: 'error',
                message: `The SQL must ${contract.threshold.requiresHaving ? 'use HAVING to ' : ''}enforce ${contract.threshold.operator} ${contract.threshold.value}.`,
            });
        }
    }
    if (contract.ratio?.basis === 'row_count') {
        const hasCountBasis = /\bcount\s*\(/i.test(sql)
            || /\bsum\s*\(\s*case\b[\s\S]*?\bthen\s+1\b/i.test(sql)
            // DuckDB can sum a boolean predicate directly. Keep this branch
            // separate from CASE expressions: a monetary
            // SUM(CASE WHEN ... THEN amount) is not an entity count merely
            // because the WHEN clause contains an equality predicate.
            || /\bsum\s*\(\s*(?!case\b)\(?\s*[^()]*?(?:=|<>|!=|\bis\s+)[^()]*\)?\s*\)/i.test(sql);
        if (!hasCountBasis) {
            issues.push({
                code: 'wrong_ratio_basis',
                severity: 'error',
                message: 'The question asks for a ratio of entities/rows, but the SQL does not use count-based numerator and denominator semantics.',
            });
        }
    }
    if (contract.relativeComparison?.scope === 'row_to_global_average') {
        const hasGlobalAverage = /\bavg\s*\([^)]*\)[\s\S]*\bfrom\b/i.test(sql)
            && /\(\s*select[\s\S]*\bavg\s*\(/i.test(sql);
        if (!hasGlobalAverage || /\bgroup\s+by\b/i.test(sql)) {
            issues.push({
                code: 'wrong_comparison_scope',
                severity: 'error',
                message: 'The question requires a row-level value compared with the global average; the SQL must not aggregate by entity before that comparison.',
            });
        }
    }
    if (contract.relativeComparison?.scope === 'group_aggregate_to_group_average') {
        const hasGroupedReference = /\bgroup\s+by\b/i.test(sql)
            && /\bavg\s*\(/i.test(sql)
            && /\bselect\b[\s\S]*\bselect\b/i.test(sql);
        if (!hasGroupedReference) {
            issues.push({
                code: 'wrong_comparison_scope',
                severity: 'error',
                message: 'The question requires entity aggregates compared with the average across entity aggregates.',
            });
        }
    }
    if (contract.requiresFiscalCalendar
        && !/(?:fiscal|date_trunc\s*\(\s*'quarter'|quarter\s*\()/.test(normalized)) {
        issues.push({ code: 'missing_fiscal_calendar', severity: 'error', message: 'The question requires a fiscal-quarter calculation, but the SQL does not define one.' });
    }
    if (contract.requiresRanking && !/\border\s+by\b/.test(normalized)) {
        issues.push({ code: 'missing_ranking', severity: 'error', message: 'The question requires a ranking, but the SQL has no ORDER BY.' });
    }
    if (contract.rankingLimit !== undefined
        && !new RegExp('\\blimit\\s+' + contract.rankingLimit + '\\b').test(normalized)) {
        issues.push({ code: 'missing_ranking', severity: 'error', message: `The question requires LIMIT ${contract.rankingLimit}.` });
    }
    if (contract.requiresRanking && contract.rankingDirection
        && /\border\s+by\b/.test(normalized)
        && !new RegExp(`\\border\\s+by[\\s\\S]*?\\b${contract.rankingDirection}\\b`, 'i').test(sql)) {
        issues.push({ code: 'wrong_ranking_direction', severity: 'error', message: `The ranking must sort ${contract.rankingDirection.toUpperCase()}.` });
    }
    if (contract.requiresComparison
        && !/(?:\bunion\s+all\b|\bcurrent\b|\bprevious\b|\bprior\b|\bcomparison\b|(?:this|last)[_ -]?(?:day|week|month|quarter|year))/i.test(normalized)) {
        issues.push({ code: 'missing_comparison', severity: 'error', message: 'The question requires a period comparison, but the SQL does not represent both periods.' });
    }

    return issues;
}

/**
 * Validate the shape of locally executed rows against facts established before
 * SQL generation. This never compares values and never sends rows to a model.
 */
export function validateResultAgainstContract(
    rows: Array<Record<string, unknown>>,
    contract: QueryContract,
): SQLFaithfulnessIssue[] {
    const expectation = contract.resultRowExpectation;
    if (!expectation) return [];
    const count = rows.length;
    const violatesExact = expectation.exact !== undefined && count !== expectation.exact;
    const violatesMinimum = expectation.minimum !== undefined && count < expectation.minimum;
    const violatesMaximum = expectation.maximum !== undefined && count > expectation.maximum;
    if (!violatesExact && !violatesMinimum && !violatesMaximum) return [];

    const expected = expectation.exact !== undefined
        ? `exactly ${expectation.exact}`
        : expectation.minimum !== undefined
            ? `at least ${expectation.minimum}`
            : `no more than ${expectation.maximum}`;
    return [{
        code: 'unexpected_result_cardinality',
        severity: 'error',
        message: `The executed query returned ${count} row(s), but the requested answer shape requires ${expected} (${expectation.basis}).`,
    }];
}
