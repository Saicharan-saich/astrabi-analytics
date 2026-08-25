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
    /** Result fields that must identify one row per requested group. This is
     * checked after local execution so a grouped filter cannot accidentally
     * project the matching source rows and repeat each qualifying group. */
    uniqueResultFields: string[];
    /** Exact physical fields allowed to define the GROUP BY grain when the
     * question establishes that grain confidently. Extra raw grouping fields
     * split an otherwise correct answer into a finer, unrequested result. */
    allowedGroupingFields: string[];
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
    /** All aggregate operations explicitly required by the question. Keeping
     * this as a list prevents a multi-measure request (for example AVG and MAX)
     * from being collapsed into whichever keyword was matched first. */
    expectedAggregations?: Array<'sum' | 'avg' | 'count' | 'min' | 'max'>;
    /** Schema-grounded measure fields paired with their requested operations.
     * A missing field intentionally means COUNT(*)/relationship count rather
     * than a guessed physical column. */
    expectedMeasures?: Array<{
        field?: string;
        aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max';
        confidence: 'high' | 'medium';
    }>;
    /** Backwards-compatible primary aggregation used by older consumers. */
    expectedAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
    /** Ordinary predicates that must survive planning and SQL generation.
     * These are kept separate from relative-average rules because a hard
     * question commonly combines joins, row filters, grouped thresholds and
     * ranking in one request. */
    requiredPredicates?: Array<{
        field: string;
        operator: AnalysisPlan['filters'][number]['op'];
        value: unknown;
        scope: 'where' | 'having';
        confidence: 'high' | 'medium';
    }>;
    /** The expression that determines ranking. Direction and LIMIT alone are
     * insufficient: ORDER BY the wrong field is syntactically valid but answers
     * a different question. */
    rankingTarget?: {
        mode: 'row_value' | 'group_aggregate' | 'frequency';
        field?: string;
        aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
        confidence: 'high' | 'medium';
    };
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
        scope: 'row_to_global_average' | 'row_to_filtered_average' | 'group_aggregate_to_group_average';
        /** Population used to calculate the reference aggregate. Cohort filters
         * are inherited unless the question explicitly asks for an overall or
         * global benchmark. */
        referencePopulation: 'global' | 'filtered_cohort' | 'group_aggregates';
        /** Strict boundary implied by the wording ("higher than" is >, while
         * "at least ... higher" is >=). */
        comparator: '>' | '>=' | '<' | '<=';
        /** Relative threshold multiplier: 20% higher => 1.2, 20% lower => 0.8. */
        multiplier: number;
        /** Physical measure whose value/aggregate is compared with the
         * reference population. */
        measureField?: string;
        /** Pre-comparison predicates that define the reference cohort. The
         * relative comparison predicate itself is deliberately excluded. */
        inheritedFilters: Array<Pick<AnalysisPlan['filters'][number], 'field' | 'op' | 'value'>>;
    };
}

export interface SQLFaithfulnessIssue {
    code:
        | 'missing_grouping'
        | 'unexpected_grouping'
        | 'unexpected_grouping_field'
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
        | 'missing_filter'
        | 'wrong_ranking_target'
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

function inflectionVariants(token: string): Set<string> {
    const value = token.toLowerCase();
    const variants = new Set([value]);
    if (value.endsWith('ies') && value.length > 4) variants.add(`${value.slice(0, -3)}y`);
    if (value.endsWith('sses') && value.length > 5) variants.add(value.slice(0, -2));
    if (value.endsWith('es') && value.length > 4) variants.add(value.slice(0, -2));
    if (value.endsWith('s') && !value.endsWith('ss') && value.length > 3) variants.add(value.slice(0, -1));
    return variants;
}

/** Small domain-neutral vocabulary bridges common schema nouns. */
function conceptVariants(token: string): Set<string> {
    const inflections = inflectionVariants(token);
    const base = [...inflections].sort((a, b) => a.length - b.length)[0];
    const variants = new Set(inflections);
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
        .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function conceptMatches(schemaToken: string, questionTokens: Set<string>): boolean {
    const schemaVariants = conceptVariants(schemaToken);
    return [...questionTokens].some(questionToken =>
        [...conceptVariants(questionToken)].some(token => schemaVariants.has(token))
    );
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

    const candidates: Array<QueryEntityContract & { score: number; directMatch: boolean }> = [];
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
            const directAliases = [column.name, semanticField?.displayLabel]
                .filter((value): value is string => !!value);
            const synonymAliases = (semanticField?.synonyms || [])
                .filter((value): value is string => !!value);
            const coverage = (aliases: string[]) => {
                let best = 0;
                for (const alias of aliases) {
                    const aliasTokens = words(alias);
                    if (!aliasTokens.length) continue;
                    const overlap = aliasTokens.filter(token => conceptMatches(token, clauseTokens)).length;
                    best = Math.max(best, overlap / aliasTokens.length);
                }
                return best;
            };
            const directCoverage = coverage(directAliases);
            const synonymCoverage = coverage(synonymAliases);
            const bestCoverage = Math.max(directCoverage, synonymCoverage);
            if (bestCoverage === 0) continue;
            let score = bestCoverage * 75;
            if (directCoverage > 0) score += 10;
            if (tableMentioned) score += 20;
            const duplicateCount = duplicateFieldCounts.get(column.name.toLowerCase()) || 0;
            if (duplicateCount === 1) score += 15;
            else if (!tableMentioned) score -= 25;
            if (planFields.has(column.name.toLowerCase())) score += 5;
            if (score < 65) continue;
            candidates.push({
                table: table.name,
                field: column.name,
                // A synonym-only overlap is useful grounding evidence but is
                // not authoritative output evidence when another physical
                // field may literally match the same word (sales vs sales_rep).
                confidence: score >= 80 && (directCoverage >= 0.75 || planFields.has(column.name.toLowerCase())) ? 'high' : 'medium',
                score,
                directMatch: directCoverage > 0,
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
        const { score: _score, directMatch: _directMatch, ...field } = candidate;
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
    // Role inference is advisory here. A low-cardinality text column can be
    // misclassified, but exact wording such as "type of pet" must still beat a
    // weak shared noun such as "pet" in "pet_age". Identifiers are penalised,
    // but remain available when the user explicitly asks for an ID/code grain.
    for (const field of model.fields) {
        const names = [field.name, field.displayLabel, ...(field.synonyms || [])];
        for (const name of names) {
            const nameTokens = words(name);
            if (!nameTokens.length) continue;
            // Single-token generic identifiers like "id", "key", "code" match
            // too many questions. Only accept them on an exact phrase match.
            const isGenericSingleToken = nameTokens.length === 1
                && ['id', 'key', 'code', 'type', 'status', 'name', 'date'].includes(nameTokens[0]);
            const phraseOverlap = nameTokens.filter(token => conceptMatches(token, phraseTokens)).length;
            const questionOverlap = nameTokens.filter(token => conceptMatches(token, questionTokens)).length;
            const exactPhrase = phraseOverlap === nameTokens.length && phraseTokens.size === nameTokens.length;
            if (isGenericSingleToken && !exactPhrase) continue;
            const phraseCoverage = phraseOverlap / nameTokens.length;
            const phrasePrecision = phraseTokens.size ? phraseOverlap / phraseTokens.size : 0;
            const rolePreference = field.role === 'dimension' ? 12 : -8;
            const identifierPenalty = field.semanticType === 'identifier' ? -25 : 0;
            const score = exactPhrase ? 120 + rolePreference + identifierPenalty
                : phraseCoverage * 60 + phrasePrecision * 35
                    + (questionOverlap / nameTokens.length) * 10 + rolePreference + identifierPenalty;
            // A single incidental noun shared with a compound column is not a
            // safe grouping contract. If no strong field exists, leave the
            // dimension unresolved rather than rejecting valid model SQL.
            if (score < 62) continue;
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
    if (/\b(how many|(?<!\bid )(?<!\bserial )(?<!\bphone )(?<!\baccount )(?<!\border )(?<!\brace )(?<!\bflight )(?<!\bticket )(?<!\bcard )(?<!\bmodel )(?<!\bpart )number of|count(?: of)?|count the)\b/i.test(question)) return 'count';
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

function resolveExpectedAggregations(question: string, model?: SemanticModel): QueryContract['expectedAggregations'] {
    // Benchmark/domain evidence may define a named business measure with an
    // explicit formula, e.g. "average attendance = DIVIDE(COUNT(event_id),
    // COUNT(DISTINCT event_name))". In that case the label "average" is not an
    // instruction to emit AVG(); the formula is the authoritative operation.
    // Parse formula right-hand sides generically rather than special-casing a
    // dataset or question.
    const evidenceText = question.match(/\bEvidence:\s*([\s\S]+)$/i)?.[1] || '';
    const formulaText = evidenceText
        .split(';')
        .map(part => part.includes('=') ? part.slice(part.indexOf('=') + 1) : '')
        .filter(Boolean)
        .join(' ');
    if (/\b(?:DIVIDE|MULTIPLY|SUBTRACT|ADD)\s*\(/i.test(formulaText)) {
        const formulaAggregations = [...formulaText.matchAll(/\b(AVG|SUM|COUNT|MIN|MAX)\s*\(/gi)]
            .map(match => match[1].toLowerCase() as 'sum' | 'avg' | 'count' | 'min' | 'max');
        if (formulaAggregations.length) return [...new Set(formulaAggregations)];
    }

    // Physical field names are nouns, not operations. Mask schema-grounded
    // metric phrases before parsing operations so a column such as
    // "Ticket_Count" does not invent COUNT when the user asks for its AVG/MAX.
    const aliases = (model?.fields || [])
        .filter(field => field.role === 'metric')
        .flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])])
        .map(alias => alias.replace(/[_-]+/g, ' ').trim())
        .filter(alias => alias.length > 1)
        .sort((a, b) => b.length - a.length);
    let operationText = question.replace(/[_-]+/g, ' ');
    for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        operationText = operationText.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' measure ');
    }
    const shape = inferQueryShape(operationText);
    return shape.explicitAggregations;
}

function resolveExpectedMeasures(
    question: string,
    aggregations: NonNullable<QueryContract['expectedAggregations']>,
    model?: SemanticModel,
): NonNullable<QueryContract['expectedMeasures']> {
    const normalized = question.toLowerCase().replace(/[_-]+/g, ' ');
    let candidates = (model?.fields || [])
        .filter(field => field.role === 'metric')
        .flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])]
            .map(alias => ({
                field: field.name,
                alias: alias.toLowerCase().replace(/[_-]+/g, ' ').trim(),
            })))
        .map(candidate => {
            const escaped = candidate.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return { ...candidate, index: new RegExp(`\\b${escaped}\\b`, 'i').exec(normalized)?.index ?? -1 };
        })
        .filter(candidate => candidate.alias.length > 1 && candidate.index >= 0)
        // Exclude fields appearing in comparison/filter contexts — e.g. "height higher than 200"
        // means Height is a WHERE filter, not an aggregation target.
        .filter(candidate => {
            const afterField = normalized.slice(candidate.index + candidate.alias.length, candidate.index + candidate.alias.length + 40);
            return !/^\s*(?:higher|greater|larger|bigger|more|less|lower|smaller|fewer|above|below|over|under|equal|(?:>|<|=))\b/i.test(afterField);
        })
        .sort((a, b) => a.index - b.index || b.alias.length - a.alias.length)
        .filter((candidate, index, all) => all.findIndex(other => other.field.toLowerCase() === candidate.field.toLowerCase()) === index);

    if (candidates.length === 0) {
        const questionTokens = new Set(words(question));
        candidates = (model?.fields || [])
            .filter(field => field.role === 'metric')
            .map(field => {
                const aliases = [field.name, field.displayLabel, ...(field.synonyms || [])];
                const best = aliases.map(alias => {
                    const aliasTokens = words(alias);
                    const overlap = aliasTokens.filter(token => questionTokens.has(token)).length;
                    return {
                        alias,
                        score: aliasTokens.length ? overlap / aliasTokens.length : 0,
                        overlap,
                        index: Math.min(...aliasTokens
                            .map(token => normalized.indexOf(token))
                            .filter(index => index >= 0)),
                    };
                }).sort((a, b) => b.score - a.score || b.overlap - a.overlap)[0];
                return {
                    field: field.name,
                    alias: best?.alias || field.name,
                    index: Number.isFinite(best?.index) ? best.index : Number.MAX_SAFE_INTEGER,
                    score: best?.score || 0,
                    overlap: best?.overlap || 0,
                };
            })
            .filter(candidate => candidate.overlap > 0 && candidate.score >= 0.6)
            .sort((a, b) => a.index - b.index || b.score - a.score);
    }

    return aggregations.map((aggregation, index) => {
        // Plain COUNT describes entity cardinality unless distinct/counting a
        // specific measure is explicit. Avoid converting "how many products"
        // into COUNT(number_products) merely because a similarly named column
        // exists.
        if (aggregation === 'count') return { aggregation, confidence: 'high' as const };
        const candidate = candidates.length === 1 ? candidates[0] : candidates[index];
        return candidate
            ? { field: candidate.field, aggregation, confidence: 'high' as const }
            : { aggregation, confidence: 'medium' as const };
    });
}

function resolveThreshold(question: string): Omit<NonNullable<QueryContract['threshold']>, 'requiresHaving'> | undefined {
    const patterns: Array<{ re: RegExp; operator: '>=' | '>' | '<=' | '<' | '=' }> = [
        { re: /\b(-?\d+(?:\.\d+)?)\s+or\s+more\b/i, operator: '>=' },
        { re: /\b(-?\d+(?:\.\d+)?)\s+or\s+(?:fewer|less)\b/i, operator: '<=' },
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
    const symbolic = question.match(/(?:^|\s)(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)/);
    if (symbolic) return {
        operator: symbolic[1] as '>=' | '>' | '<=' | '<' | '=',
        value: Number(symbolic[2]),
    };
    return undefined;
}

function thresholdUsesAggregate(question: string): boolean {
    const comparator = /\b(?:at\s+least|more\s+than|greater\s+than|over|at\s+most|fewer\s+than|less\s+than|under|exactly|equal\s+to)\b/i.exec(question);
    if (!comparator) return false;
    // Only the phrase immediately governing the comparison decides WHERE vs
    // HAVING. An aggregate elsewhere must not move a raw-field predicate into
    // HAVING (for example "count pets whose age is over 20").
    const nearby = question.slice(Math.max(0, comparator.index - 80), comparator.index);
    const after = question.slice(comparator.index + comparator[0].length, comparator.index + comparator[0].length + 100);
    return /\b(?:total|sum|average|avg|mean|count|number\s+of|minimum|maximum|min|max)\b[^?.,;]{0,60}$/i.test(nearby)
        || /\b(?:on\s+average|on\s+mean)\b/i.test(after);
}

/** Aggregate formulas supplied as benchmark/business evidence describe a
 * grouped predicate even when the natural wording asks only for entity labels.
 * The aggregate belongs in HAVING/a subquery; it does not become a displayed
 * output field. */
function hasAggregatePredicateEvidence(question: string): boolean {
    const evidence = question.match(/\bEvidence:\s*([\s\S]+)$/i)?.[1] || '';
    return /\b(?:AVG|SUM|COUNT|MIN|MAX|DIVIDE|MULTIPLY|SUBTRACT|ADD)\s*\(/i.test(evidence)
        && /(?:>=|<=|>|<|=)\s*-?\d+(?:\.\d+)?/i.test(evidence);
}

function aggregateOperationsFromEvidence(question: string): QueryContract['expectedAggregations'] {
    const evidence = question.match(/\bEvidence:\s*([\s\S]+)$/i)?.[1] || '';
    const operations = [...evidence.matchAll(/\b(AVG|SUM|COUNT|MIN|MAX)\s*\(/gi)]
        .map(match => match[1].toLowerCase() as NonNullable<QueryContract['expectedAggregation']>);
    return [...new Set(operations)];
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

function resolveRelativeComparison(
    question: string,
    plan: AnalysisPlan,
    model?: SemanticModel,
): QueryContract['relativeComparison'] {
    if (!/\b(?:(?:above|below)\s+(?:the\s+)?(?:overall\s+)?average|(?:more|greater|higher|less|lower|fewer)\s+than\s+(?:the\s+)?(?:overall\s+)?average)\b/i.test(question)) {
        return undefined;
    }
    const aggregateEntityCue = /\b(?:total|sum|combined|aggregate|per\s+\w+|for\s+each\s+\w+)\b/i.test(question);
    const explicitGlobal = /\b(?:overall|global|whole[-\s]+dataset|entire[-\s]+dataset|all[-\s]+records?)\s+(?:row[-\s]+level\s+)?average\b/i.test(question);
    const inheritedFilters = plan.filters
        .filter(filter => !filter.isHaving && !['above_avg', 'below_avg'].includes(filter.op))
        .map(filter => ({ field: filter.field, op: filter.op, value: filter.value }));
    const percentage = question.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:higher|more|greater|above|lower|less|below)\s+than\s+(?:the\s+)?(?:overall\s+)?average\b/i);
    const percentValue = percentage ? Number(percentage[1]) : 0;
    const lowerDirection = /\b(?:below\s+(?:the\s+)?(?:overall\s+)?average|(?:less|lower|fewer)\s+than\s+(?:the\s+)?(?:overall\s+)?average)\b/i.test(question)
        || /\b\d+(?:\.\d+)?\s*%\s*(?:lower|less|below)\s+than\s+(?:the\s+)?(?:overall\s+)?average\b/i.test(question);
    const atLeast = /\b(?:at\s+least|no\s+less\s+than)\b[\s\S]{0,40}\b(?:higher|more|greater|above|lower|less|below)\b/i.test(question);
    const atMost = /\b(?:at\s+most|no\s+more\s+than)\b[\s\S]{0,40}\b(?:higher|more|greater|above|lower|less|below)\b/i.test(question);
    const referencePopulation = aggregateEntityCue
        ? 'group_aggregates'
        : !explicitGlobal && inheritedFilters.length > 0
            ? 'filtered_cohort'
            : 'global';
    const relativeFilter = plan.filters.find(filter => ['above_avg', 'below_avg'].includes(filter.op));
    const normalizedQuestion = question.toLowerCase().replace(/[_-]+/g, ' ');
    const mentionedMeasure = (model?.fields || [])
        .filter(field => field.role === 'metric')
        .flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])]
            .map(alias => ({
                field: field.name,
                alias: alias.toLowerCase().replace(/[_-]+/g, ' ').trim(),
            })))
        .filter(candidate => candidate.alias.length > 1 && normalizedQuestion.includes(candidate.alias))
        .sort((a, b) => b.alias.length - a.alias.length)[0]?.field;
    const planMeasure = plan.metrics.find(metric => {
        const phrase = metric.field.toLowerCase().replace(/[_-]+/g, ' ');
        return phrase.length > 1 && normalizedQuestion.includes(phrase);
    })?.field;
    const measureField = relativeFilter?.field || mentionedMeasure || planMeasure;
    return {
        scope: aggregateEntityCue
            ? 'group_aggregate_to_group_average'
            : referencePopulation === 'filtered_cohort'
                ? 'row_to_filtered_average'
                : 'row_to_global_average',
        referencePopulation,
        comparator: lowerDirection
            ? atMost ? '>=' : atLeast ? '<=' : '<'
            : atMost ? '<=' : atLeast ? '>=' : '>',
        multiplier: percentValue > 0
            ? lowerDirection ? 1 - percentValue / 100 : 1 + percentValue / 100
            : 1,
        measureField: measureField && measureField !== '*' ? measureField : undefined,
        inheritedFilters: referencePopulation === 'filtered_cohort' ? inheritedFilters : [],
    };
}

function resolveRequiredPredicates(
    plan: AnalysisPlan,
    model?: SemanticModel,
): QueryContract['requiredPredicates'] {
    const knownFields = new Set((model?.fields || []).map(field => field.name.toLowerCase()));
    return (plan.filters || [])
        .filter(filter => !['above_avg', 'below_avg'].includes(filter.op))
        .filter(filter => filter.field && filter.field !== '*')
        .map(filter => ({
            field: filter.field,
            operator: filter.op,
            value: filter.value,
            scope: filter.isHaving ? 'having' as const : 'where' as const,
            // Only schema-grounded predicates become blocking constraints. An
            // unknown planner field remains useful context for model repair but
            // cannot turn otherwise valid SQL into an application error.
            confidence: (!model || knownFields.has(filter.field.toLowerCase()))
                ? 'high' as const
                : 'medium' as const,
        }));
}

function resolveRankingTarget(
    question: string,
    plan: AnalysisPlan,
    queryShape: ReturnType<typeof inferQueryShape>,
    expectedMeasures: NonNullable<QueryContract['expectedMeasures']>,
    requiresGrouping: boolean,
): QueryContract['rankingTarget'] {
    if (queryShape.operation !== 'ranking') return undefined;
    if (queryShape.implicitFrequencyRanking
        || (expectedMeasures[0]?.aggregation === 'count' && !expectedMeasures[0]?.field)) {
        return { mode: 'frequency', aggregation: 'count', confidence: 'high' };
    }

    const explicitMeasure = expectedMeasures.find(measure => measure.confidence === 'high' && measure.field);
    if (explicitMeasure?.field) {
        return {
            mode: requiresGrouping ? 'group_aggregate' : 'row_value',
            field: explicitMeasure.field,
            aggregation: requiresGrouping ? explicitMeasure.aggregation : undefined,
            confidence: 'high',
        };
    }

    const sortField = plan.sort?.[0]?.field;
    const metric = sortField
        ? plan.metrics.find(item => item.field.toLowerCase() === sortField.toLowerCase())
        : plan.metrics[0];
    const field = sortField || metric?.field;
    if (!field || field === '*') return undefined;
    const fieldTokens = words(field);
    const questionTokens = new Set(words(question));
    const explicitlyNamed = fieldTokens.length > 0
        && fieldTokens.every(token => [...conceptVariants(token)].some(variant => questionTokens.has(variant)));
    return {
        mode: requiresGrouping && metric ? 'group_aggregate' : 'row_value',
        field,
        aggregation: requiresGrouping && metric && metric.agg !== 'count_distinct' && metric.agg !== 'median'
            ? metric.agg
            : undefined,
        confidence: explicitlyNamed ? 'high' : 'medium',
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

    const owners = new Map<string, string[]>();
    for (const table of schema.tables) {
        for (const column of table.columns) {
            const key = column.name.toLowerCase();
            owners.set(key, [...(owners.get(key) || []), table.name]);
        }
    }

    for (const table of schema.tables) {
        const tableMentioned = words(table.name).some(token => conceptMatches(token, qTokens));
        const fieldMentioned = table.columns.some(column => {
            const columnOwners = owners.get(column.name.toLowerCase()) || [];
            // A plan field that exists in several tables is not evidence that
            // every one of those tables is required. Force a join only when
            // ownership is unique or the table itself is named in the question.
            if (planFields.has(column.name.toLowerCase())
                && (columnOwners.length === 1 || tableMentioned)) return true;
            const semantic = words(column.name).filter(token => !['id', 'key', 'code', 'name', 'title', 'label', 'description'].includes(token));
            return semantic.length > 0 && semantic.some(token => conceptMatches(token, qTokens));
        });
        if (tableMentioned || fieldMentioned) required.add(table.name);
    }
    return [...required];
}

/**
 * A list/which/show request for named attributes is set-valued unless the user
 * explicitly asks for underlying records/rows. This is grammatical rather
 * than domain-specific: it works for event names, countries, template codes,
 * products, or any future schema without maintaining a noun dictionary.
 */
function requestsSetProjection(
    question: string,
    requestedOutputFields: QueryEntityContract[],
    requiresRowProjection: boolean,
    model?: SemanticModel,
    relationshipCanDuplicate = false,
): boolean {
    if (!requiresRowProjection || !requestedOutputFields.some(field => field.confidence === 'high')) return false;
    if (!/^\s*(?:please\s+)?(?:which|what\s+are|list|find|return|show|give(?:\s+me)?)\b/i.test(question)) return false;
    if (/\b(?:all|every|each)\s+(?:record|row|entry|transaction|observation)s?\b|\braw\s+(?:records?|rows?)\b/i.test(question)) return false;
    const repeatedInSource = requestedOutputFields.some(output => {
        const semantic = model?.fields.find(field => field.name.toLowerCase() === output.field.toLowerCase());
        return !!semantic && semantic.distinctCount > 0 && semantic.distinctCount < (model?.rowCount || 0);
    });
    return relationshipCanDuplicate || repeatedInSource;
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
    let requestedOutputFields = resolveRequestedOutputFields(question, plan, schema, model);
    const inferredOutputEntity = resolveOutputEntity(question, plan, schema);
    let outputEntity = inferredOutputEntity
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
    const aggregatePredicateCue = thresholdUsesAggregate(question) || hasAggregatePredicateEvidence(question);
    const requestsEntityRows = /^\s*(?:please\s+)?(?:list|show|which|find|return|give(?:\s+me)?)\b/i.test(question);
    // Aggregate inputs are not automatically visible answer fields. This is
    // especially important for scalar questions: a synonym match such as
    // "sales" -> sales_rep must never force extra dimensions into SELECT.
    if (queryShape.operation === 'scalar_aggregate'
        && !asksCountAlongsideEntity
        && !(requestsEntityRows && aggregatePredicateCue)) {
        requestedOutputFields = [];
        outputEntity = undefined;
    } else if (['grouped_aggregate', 'ranking'].includes(queryShape.operation)) {
        requestedOutputFields = requestedOutputFields.filter(candidate => {
            const semantic = model?.fields.find(field => field.name.toLowerCase() === candidate.field.toLowerCase());
            return semantic?.role !== 'metric';
        });
        if (outputEntity && model?.fields.find(field =>
            field.name.toLowerCase() === outputEntity!.field.toLowerCase() && field.role === 'metric'
        )) outputEntity = requestedOutputFields[0];
    }
    const requiresRowProjection = requestedOutputFields.some(field => field.confidence === 'high')
        && !answerAggregation
        && !asksCountAlongsideEntity
        && !aggregatePredicateCue
        && queryShape.operation !== 'ranking'
        && queryShape.operation !== 'grouped_aggregate';
    const planRequiresEntityAggregation = !requiresRowProjection && !!outputEntity
        && plan.metrics.some(metric => ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median'].includes(metric.agg))
        && !['single_metric', 'distribution'].includes(plan.intent);
    const explicitGroupingCue = queryShape.operation === 'grouped_aggregate'
        || queryShape.implicitFrequencyRanking
        || (aggregatePredicateCue && !!outputEntity)
        || BREAKDOWN_CUE.test(breakdownQuestion)
        || /\b(?:in|for)\s+each\b/i.test(question)
        || (asksCountAlongsideEntity && !!outputEntity);
    // A local planner may represent a row-level superlative as MIN/MAX plus
    // LIMIT 1 (for example, "the song by the youngest singer"). That aggregate
    // is only an ordering aid; it must not turn the requested row projection
    // into GROUP BY. Explicit aggregate wording ("highest total sales") and
    // genuine frequency/group cues still retain grouped semantics.
    const rowLevelSuperlative = queryShape.operation === 'ranking'
        && queryShape.selection === 'single'
        && !answerAggregation
        && queryShape.explicitAggregations.length === 0
        && !explicitGroupingCue;
    const explicitScalarAggregationCue = /\b(?:how many|(?<!\bid )(?<!\bserial )(?<!\bphone )(?<!\baccount )(?<!\border )(?<!\brace )(?<!\bflight )(?<!\bticket )(?<!\bcard )(?<!\bmodel )(?<!\bpart )number of|count(?: of)?|what is (?:the )?(?:average|mean|total|sum|minimum|maximum)|what are (?:the )?(?:minimum and maximum|maximum and minimum))\b/i.test(question);
    const requiresGrouping = !requiresRowProjection && !orderedProjection && (!explicitScalarAggregationCue || explicitGroupingCue)
        && (queryShape.implicitFrequencyRanking
            || (queryShape.groupingCue && queryShape.explicitAggregations.length > 0)
            || requiresFiscalCalendar
            || BREAKDOWN_CUE.test(breakdownQuestion)
            || verification.some(issue => issue.code === 'missing_dimension')
            || (existenceMode === 'none' && planRequiresEntityAggregation && !rowLevelSuperlative));
    const requiresRanking = !orderedProjection && queryShape.operation === 'ranking';
    const rankingLimit = requiresRanking
        ? queryShape.explicitLimit || (queryShape.selection === 'single' ? 1 : undefined)
        : undefined;
    const rankingDirection = requiresRanking
        ? queryShape.orderDirection
            || (/\b(bottom|lowest|least|worst|smallest|fewest|minimum|youngest|earliest)\b/i.test(question) ? 'asc' : 'desc')
        : undefined;
    const requiresComparison = COMPARISON_CUE.test(question) || Boolean(plan.comparison);
    const outputEntityIsDimension = !!outputEntity && model?.fields.some(field =>
        field.name.toLowerCase() === outputEntity!.field.toLowerCase() && field.role === 'dimension'
    );
    const resolvedRequestedDimension = requiresGrouping
        ? requiresRanking && outputEntity?.confidence === 'high' && outputEntityIsDimension
            // In "which product has the highest total sales", product is the
            // answer grain and sales is the ranking measure. A whole-question
            // field scan must not accidentally group by the measure.
            ? outputEntity.field
            : resolveRequestedDimension(question, model)
        : undefined;
    // For grouped answers, the explicitly resolved grouping noun is also the
    // visible entity. This prevents an incidental draft dimension from becoming
    // a hard contract requirement (for example pet_age instead of PetType).
    if (resolvedRequestedDimension && schema) {
        const owner = schema.tables.find(table => table.columns.some(column =>
            column.name.toLowerCase() === resolvedRequestedDimension.toLowerCase()
        ));
        if (owner) outputEntity = { table: owner.name, field: resolvedRequestedDimension, confidence: 'high' };
    } else if (requiresGrouping && outputEntity?.confidence === 'high' && !descriptiveColumn(outputEntity.field)) {
        // A non-descriptive fallback inferred partly from the draft plan is not
        // strong enough to reject model SQL. Preserve it as context only.
        outputEntity = { ...outputEntity, confidence: 'medium' };
    }
    const requiredDimension = resolvedRequestedDimension
        || (requiresGrouping && outputEntity?.confidence === 'high' ? outputEntity.field : undefined);
    if (requiresGrouping && requiredDimension) {
        const groupingPhrase = question.match(/\b(?:for\s+each|for\s+every|per|by|each|every)\s+([^?.;]+)/i)?.[1] || '';
        const explicitlyCompoundGrain = /\s+(?:and|plus)\s+|,/.test(groupingPhrase);
        if (!explicitlyCompoundGrain) {
            // Once the grouping noun is resolved confidently, incidental
            // synonym matches must not widen the displayed answer schema. For
            // example, "customer segment" resolves to customer_segment, not
            // both customer_segment and customer_name merely because both
            // share the token "customer".
            requestedOutputFields = requestedOutputFields.filter(field =>
                field.field.toLowerCase() === requiredDimension.toLowerCase()
            );
        }
    }
    const evidenceAggregations = aggregateOperationsFromEvidence(question);
    let expectedAggregations = orderedProjection || requiresRowProjection
        ? []
        : evidenceAggregations.length > 0
            ? evidenceAggregations
            : resolveExpectedAggregations(question, model);
    let expectedAggregation = expectedAggregations[0]
        || (orderedProjection || requiresRowProjection
            ? undefined
            : resolveExpectedAggregation(question, plan) || queryShape.explicitAggregation);
    const expectedCardinality: QueryContract['expectedCardinality'] = orderedProjection || requiresRowProjection ? 'detail'
        : requiresGrouping ? 'grouped'
        : expectedAggregation && explicitScalarAggregationCue ? 'scalar'
        : 'detail';
    const requiredTables = resolveRequiredTables(question, plan, schema, outputEntity, requestedOutputFields);
    const resolvedThreshold = resolveThreshold(question);
    const threshold = resolvedThreshold
        ? {
            ...resolvedThreshold,
            requiresHaving: queryShape.implicitGroupedCount || thresholdUsesAggregate(question),
        }
        : undefined;
    // "countries with at least 3 manufacturers" is a related-entity count even
    // though it never says "count". This inference is safe only when the output
    // entity and a distinct related table have both been schema-grounded.
    if (!expectedAggregation && threshold && outputEntity && requiredTables.some(table => table !== outputEntity.table)) {
        expectedAggregation = 'count';
        expectedAggregations = ['count'];
        threshold.requiresHaving = true;
    }
    // A superlative over a related table is a count-of-related-records ranking
    // unless the question names another explicit aggregation. This is derived
    // from the relationship graph, not from a benchmark/domain vocabulary.
    if (!expectedAggregation && requiresRanking && outputEntity
        && requiredTables.some(table => table !== outputEntity.table)
        && /\b(?:most|fewest|least)\b/i.test(question)) {
        expectedAggregation = 'count';
        expectedAggregations = ['count'];
    }
    if (expectedAggregation && expectedAggregations.length === 0) expectedAggregations = [expectedAggregation];
    const expectedMeasures = resolveExpectedMeasures(question, expectedAggregations, model);
    const requiredPredicates = resolveRequiredPredicates(plan, model);
    const rankingTarget = resolveRankingTarget(
        question,
        plan,
        queryShape,
        expectedMeasures,
        requiresGrouping,
    );
    // Output fields are independent from helper fields. A requested entity
    // filtered by an aggregate ("which industries have average score >= 70")
    // should expose the industry, while AVG(score) may remain solely in HAVING.
    const strictOutputProjection = requestedOutputFields.some(field => field.confidence === 'high')
        && (queryShape.selection === 'single' || requiresRowProjection || aggregatePredicateCue);
    const requestedPhysicalFields = new Set(requestedOutputFields.map(field => field.field.toLowerCase()));
    const forbiddenOutputFields = strictOutputProjection && schema
        ? [...new Set(schema.tables
            .flatMap(table => table.columns.map(column => column.name))
            .filter(field => !requestedPhysicalFields.has(field.toLowerCase())))]
        : [];
    const ratio = resolveRatio(question, model);
    const relativeComparison = resolveRelativeComparison(question, plan, model);
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
    const requiresDistinctProjection = !expectedAggregation
        && !requiresGrouping
        && (queryShape.distinctRequested
            || requestsSetProjection(
                question,
                requestedOutputFields,
                requiresRowProjection,
                model,
                relationshipPath.some(step => step.fansOut),
            ));
    const allowedGroupingFields = requiresGrouping && requiredDimension
        ? [requiredDimension]
        : [];
    const uniqueResultFields = requiresGrouping && requiredDimension
        ? [requiredDimension]
        : requiresDistinctProjection
            ? requestedOutputFields.filter(field => field.confidence === 'high').map(field => field.field)
            : [];
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
    if (expectedAggregations.length) {
        requirements.push(`Use every explicitly requested aggregate operation: ${expectedAggregations.map(aggregation => aggregation.toUpperCase()).join(' and ')}. Do not silently drop one measure.`);
    }
    for (const predicate of requiredPredicates.filter(item => item.confidence === 'high')) {
        requirements.push(`Preserve the ${predicate.scope.toUpperCase()} predicate on "${predicate.field}" with operator ${predicate.operator}; filtering fields do not automatically become visible output fields or grouping dimensions.`);
    }
    if (threshold) requirements.push(`${threshold.requiresHaving ? 'Apply the aggregate threshold in HAVING' : 'Apply the threshold'}: ${threshold.operator} ${threshold.value}.`);
    if (ratio?.basis === 'row_count') requirements.push('Calculate the requested ratio from row/entity counts, not from summed monetary or quantity values.');
    if (ratio?.basis === 'measure') requirements.push('Calculate the requested ratio from the additive measure named in the question, not from row counts.');
    if (relativeComparison?.scope === 'row_to_global_average') requirements.push(`Compare each underlying ${relativeComparison.measureField ? `"${relativeComparison.measureField}" ` : ''}row value with the explicitly requested global row-level average before projecting the requested entity; do not average or sum by entity first.`);
    if (relativeComparison?.scope === 'row_to_filtered_average') requirements.push(`Calculate the reference average${relativeComparison.measureField ? ` of "${relativeComparison.measureField}"` : ''} over the same filtered cohort (${relativeComparison.inheritedFilters.map(filter => filter.field).join(', ')}), then apply ${relativeComparison.comparator} average × ${relativeComparison.multiplier}. Outer WHERE predicates do not automatically apply inside a subquery; repeat them or derive both calculations from one filtered cohort CTE.`);
    if (relativeComparison?.scope === 'group_aggregate_to_group_average') requirements.push(`Aggregate${relativeComparison.measureField ? ` "${relativeComparison.measureField}"` : ''} at the requested entity grain first, then compare each entity aggregate with the average across entity aggregates.`);
    if (relativeComparison && relativeComparison.scope !== 'row_to_filtered_average') requirements.push(`Apply the relative-average boundary exactly as ${relativeComparison.comparator} average × ${relativeComparison.multiplier}.`);
    if (requiresFiscalCalendar) requirements.push('Use the requested fiscal calendar definition, including its stated start month.');
    if (requiresRanking) requirements.push(`Rank ${rankingDirection === 'asc' ? 'ascending' : 'descending'}${rankingLimit ? ` and return ${rankingLimit}` : ''}.`);
    if (rankingTarget?.confidence === 'high') {
        requirements.push(`Rank by ${rankingTarget.mode === 'frequency' ? 'COUNT(*) frequency' : `${rankingTarget.aggregation ? `${rankingTarget.aggregation.toUpperCase()} of ` : ''}"${rankingTarget.field}"`}; do not sort by an unrelated helper field.`);
    }
    if (requiresComparison) requirements.push('Return both requested comparison periods with clearly labelled result columns or rows.');
    if (requiresDistinctProjection) requirements.push('Return every distinct requested value using SELECT DISTINCT; do not arbitrarily truncate the unique result set.');
    if (uniqueResultFields.length) requirements.push(`Return one row per qualifying group (${uniqueResultFields.join(', ')}); never filter the original detail rows in a way that repeats a qualifying group.`);
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
        uniqueResultFields,
        allowedGroupingFields,
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
        expectedAggregations,
        expectedMeasures,
        expectedAggregation,
        requiredPredicates,
        rankingTarget,
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

interface ParenthesizedSQLScope {
    text: string;
    start: number;
    end: number;
}

/** Extract balanced parenthesized SELECT scopes while respecting SQL quotes. */
function parenthesizedSelectScopes(sql: string): ParenthesizedSQLScope[] {
    const scopes: ParenthesizedSQLScope[] = [];
    const stack: number[] = [];
    let quote: "'" | '"' | '`' | null = null;
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
        if (char === '(') stack.push(index);
        else if (char === ')' && stack.length) {
            const start = stack.pop()!;
            const text = sql.slice(start + 1, index);
            if (/^\s*select\b/i.test(text)) scopes.push({ text, start, end: index });
        }
    }
    return scopes;
}

function cteBodies(sql: string): Map<string, string> {
    const bodies = new Map<string, string>();
    const scopes = parenthesizedSelectScopes(sql);
    for (const match of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)) {
        const open = (match.index || 0) + match[0].lastIndexOf('(');
        const scope = scopes.find(item => item.start === open);
        if (scope) bodies.set(match[1].toLowerCase(), scope.text);
    }
    return bodies;
}

function scopeContainsReferenceFilters(
    scope: string,
    filters: NonNullable<QueryContract['relativeComparison']>['inheritedFilters'],
): boolean {
    return filters.every(filter => identifierPattern(filter.field).test(scope));
}

function filteredAverageUsesReferencePopulation(
    sql: string,
    comparison: NonNullable<QueryContract['relativeComparison']>,
): boolean {
    const averageScopes = parenthesizedSelectScopes(sql).filter(scope => {
        if (!/\bavg\s*\(/i.test(scope.text)) return false;
        if (!comparison.measureField) return true;
        const averageCalls = scope.text.match(/\bavg\s*\([^)]*\)/gi) || [];
        return averageCalls.some(call => identifierPattern(comparison.measureField!).test(call));
    });
    const ctes = cteBodies(sql);
    return averageScopes.some(scope => {
        if (scopeContainsReferenceFilters(scope.text, comparison.inheritedFilters)) return true;
        const source = scope.text.match(/\bfrom\s+["`]?([a-z_][a-z0-9_]*)["`]?/i)?.[1]?.toLowerCase();
        const sourceBody = source ? ctes.get(source) : undefined;
        return !!sourceBody && scopeContainsReferenceFilters(sourceBody, comparison.inheritedFilters);
    });
}

function referenceAverageUsesMeasure(
    sql: string,
    comparison: NonNullable<QueryContract['relativeComparison']>,
): boolean {
    if (!comparison.measureField) return true;
    const calls = sql.match(/\bavg\s*\([^)]*\)/gi) || [];
    return calls.some(call => identifierPattern(comparison.measureField!).test(call));
}

function groupedReferenceUsesMeasure(
    sql: string,
    comparison: NonNullable<QueryContract['relativeComparison']>,
): boolean {
    if (!comparison.measureField) return true;
    const aggregateCalls = sql.match(/\b(?:sum|avg|count|min|max)\s*\([^)]*\)/gi) || [];
    return aggregateCalls.some(call => identifierPattern(comparison.measureField!).test(call));
}

function hasExactRelativeComparator(sql: string, comparator: NonNullable<QueryContract['relativeComparison']>['comparator']): boolean {
    const operators: string[] = sql.match(/(?:>=|<=|>|<)/g) || [];
    return operators.includes(comparator);
}

function hasRelativeMultiplier(sql: string, multiplier: number): boolean {
    if (Math.abs(multiplier - 1) < 1e-9) return true;
    const literal = String(Number(multiplier.toFixed(8))).replace('.', '\\.');
    if (new RegExp(`(?:^|[^0-9.])${literal}(?:[^0-9.]|$)`).test(sql)) return true;
    const percentage = Math.abs(multiplier - 1) * 100;
    const percentLiteral = String(Number(percentage.toFixed(8))).replace('.', '\\.');
    return new RegExp(`${percentLiteral}\\s*\\/\\s*100`).test(sql);
}

function sqlLiteralPresent(sql: string, value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.every(item => sqlLiteralPresent(sql, item));
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>)
        .every(item => sqlLiteralPresent(sql, item));
    if (typeof value === 'number') {
        const literal = String(value).replace('.', '\\.');
        return new RegExp(`(?:^|[^0-9.])${literal}(?:[^0-9.]|$)`).test(sql);
    }
    const normalized = String(value).trim();
    if (!normalized) return true;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "'{2}");
    return new RegExp(escaped, 'i').test(sql);
}

function predicateOperatorPresent(
    sql: string,
    predicate: NonNullable<QueryContract['requiredPredicates']>[number],
): boolean {
    const field = identifierPattern(predicate.field).source;
    const gap = '[\\s\\S]{0,140}?';
    const op = predicate.operator;
    if (/^this_/.test(op)) {
        return new RegExp(`${field}${gap}(?:between|>=|>|=)`, 'i').test(sql);
    }
    if (op === 'between') {
        const nativeBetween = new RegExp(`${field}${gap}\\bbetween\\b`, 'i').test(sql);
        const lowerBound = new RegExp(`${field}${gap}(?:>=|>)`, 'i').test(sql);
        const upperBound = new RegExp(`${field}${gap}(?:<=|<)`, 'i').test(sql);
        return nativeBetween || (lowerBound && upperBound);
    }
    const operatorPattern = op === '=' ? '(?<![<>!])=(?!=)|\\bis\\b'
        : op === '!=' ? '<>|!=|\\bis\\s+not\\b'
            : op === 'in' ? '\\bin\\s*\\('
                : op === 'not_in' ? '\\bnot\\s+in\\s*\\('
                    : op === 'like' ? '\\blike\\b'
                            : op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${field}${gap}(?:${operatorPattern})`, 'i').test(sql);
}

function aggregateRankingExpressionPresent(
    sql: string,
    target: NonNullable<QueryContract['rankingTarget']>,
): boolean {
    const orderClause = sql.match(/\border\s+by\s+([\s\S]*?)(?=\blimit\b|$)/i)?.[1] || '';
    if (!orderClause) return false;
    const aggregation = target.aggregation || (target.mode === 'frequency' ? 'count' : undefined);
    const fieldPattern = target.field ? identifierPattern(target.field).source : '[^)]*';
    if (!aggregation) return !!target.field && identifierPattern(target.field).test(orderClause);
    const aggregateExpression = new RegExp(`\\b${aggregation}\\s*\\(${fieldPattern}\\)`, 'i');
    if (aggregateExpression.test(orderClause)) return true;
    if (target.mode === 'frequency' && /\bcount\s*\(\s*(?:\*|1|[^)]*)\)/i.test(orderClause)) return true;

    // ORDER BY aliases are faithful only when the outer SELECT defines that
    // alias from the required aggregate/field pair.
    const projection = topLevelSelectClauses(sql).join(', ');
    const aggregateInProjection = target.mode === 'frequency'
        ? /\bcount\s*\(\s*(?:\*|1|[^)]*)\)/i
        : new RegExp(`\\b${aggregation}\\s*\\(${fieldPattern}\\)`, 'i');
    for (const match of projection.matchAll(/([\s\S]*?)\s+(?:as\s+)?["`]?([a-z_][a-z0-9_]*)["`]?(?=\s*,|$)/gi)) {
        if (aggregateInProjection.test(match[1]) && identifierPattern(match[2]).test(orderClause)) return true;
    }
    return false;
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
        uniqueResultFields: contract.uniqueResultFields,
        allowedGroupingFields: contract.allowedGroupingFields,
        resultGrain: contract.requiredDimension,
        requiredTables: contract.requiredTables,
        relationshipPath: contract.relationshipPath,
        existenceMode: contract.existenceMode,
        relationshipMode: contract.relationshipMode,
        aggregations: contract.expectedAggregations || (contract.expectedAggregation ? [contract.expectedAggregation] : []),
        measures: contract.expectedMeasures || [],
        aggregation: contract.expectedAggregation,
        predicates: contract.requiredPredicates || [],
        threshold: contract.threshold,
        ratio: contract.ratio,
        relativeComparison: contract.relativeComparison,
        orderedProjection: contract.orderedProjection,
        ranking: contract.requiresRanking ? {
            direction: contract.rankingDirection,
            limit: contract.rankingLimit,
            target: contract.rankingTarget,
        } : undefined,
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
    if (contract.requiresGrouping && contract.allowedGroupingFields.length && groupByClauses.length) {
        const allowed = new Set(contract.allowedGroupingFields.map(field => field.toLowerCase()));
        const groupedIdentifiers = new Set<string>();
        for (const clause of groupByClauses) {
            for (const item of clause.split(',')) {
                const expression = item.trim();
                // Ordinals and computed time-grain expressions are already
                // governed through the required-dimension check below.
                if (/^\d+$/.test(expression) || /\b(?:date_trunc|extract|strftime)\s*\(/i.test(expression)) continue;
                const match = expression.match(/(?:^|\.)["`]?([a-z_][a-z0-9_]*)["`]?\s*$/i);
                if (match) groupedIdentifiers.add(match[1].toLowerCase());
            }
        }
        const unexpected = [...groupedIdentifiers].filter(field => !allowed.has(field));
        if (unexpected.length) {
            issues.push({
                code: 'unexpected_grouping_field',
                severity: 'error',
                message: `GROUP BY contains unrequested grain field(s): ${unexpected.join(', ')}. The requested grain is ${contract.allowedGroupingFields.join(', ')}.`,
            });
        }
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
    if (contract.outputEntity?.confidence === 'high'
        && !identifierPattern(contract.outputEntity.field).test(sql)
        // When the question is a grouped aggregate or scalar aggregate,
        // the outputEntity may be a false positive from partial name matching
        // (e.g. "pet" in "pet_age" when asking about average weight per pet type).
        // Only enforce outputEntity for detail/row-projection queries.
        && contract.expectedCardinality === 'detail'
        && !contract.expectedAggregation) {
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
    for (const expected of (contract.expectedAggregations?.length || 0) > 0
        ? contract.expectedAggregations!
        : contract.expectedAggregation ? [contract.expectedAggregation] : []) {
        const aggregate = expected === 'count' ? 'count' : expected;
        if (!new RegExp(`\\b${aggregate}\\s*\\(`, 'i').test(sql)) {
            issues.push({ code: 'missing_aggregation', severity: 'error', message: `The question requires ${aggregate.toUpperCase()} semantics, but the SQL does not use it.` });
        }
    }
    for (const measure of (contract.expectedMeasures || []).filter(item => item.confidence === 'high' && item.field)) {
        const aggregateCalls = sql.match(new RegExp(`\\b${measure.aggregation}\\s*\\((?:[^()]|\\([^()]*\\))*\\)`, 'gi')) || [];
        if (!aggregateCalls.some(call => identifierPattern(measure.field!).test(call))) {
            issues.push({
                code: 'missing_aggregation',
                severity: 'error',
                message: `The question requires ${measure.aggregation.toUpperCase()} over "${measure.field}", but that measure-operation pair is absent.`,
            });
        }
    }
    for (const predicate of (contract.requiredPredicates || []).filter(item => item.confidence === 'high')) {
        const hasScope = predicate.scope === 'having'
            ? /\bhaving\b/i.test(sql)
            : /\bwhere\b/i.test(sql);
        const hasOperator = predicateOperatorPresent(sql, predicate);
        const hasLiteral = sqlLiteralPresent(sql, predicate.value);
        if (!hasScope || !hasOperator || !hasLiteral) {
            issues.push({
                code: 'missing_filter',
                severity: 'error',
                message: `The SQL must preserve the ${predicate.scope.toUpperCase()} condition ${predicate.field} ${predicate.operator} ${JSON.stringify(predicate.value)}.`,
            });
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
        if (!hasGlobalAverage || !referenceAverageUsesMeasure(sql, contract.relativeComparison) || /\bgroup\s+by\b/i.test(sql)) {
            issues.push({
                code: 'wrong_comparison_scope',
                severity: 'error',
                message: 'The question requires a row-level value compared with the global average; the SQL must not aggregate by entity before that comparison.',
            });
        }
    }
    if (contract.relativeComparison?.scope === 'row_to_filtered_average') {
        if (!filteredAverageUsesReferencePopulation(sql, contract.relativeComparison)) {
            issues.push({
                code: 'wrong_comparison_scope',
                severity: 'error',
                message: `The reference average must inherit the target cohort predicates (${contract.relativeComparison.inheritedFilters.map(filter => filter.field).join(', ')}); outer WHERE predicates do not apply inside the average subquery.`,
            });
        }
    }
    if (contract.relativeComparison?.scope === 'group_aggregate_to_group_average') {
        const hasGroupedReference = /\bgroup\s+by\b/i.test(sql)
            && /\bavg\s*\(/i.test(sql)
            && /\bselect\b[\s\S]*\bselect\b/i.test(sql);
        if (!hasGroupedReference || !groupedReferenceUsesMeasure(sql, contract.relativeComparison)) {
            issues.push({
                code: 'wrong_comparison_scope',
                severity: 'error',
                message: 'The question requires entity aggregates compared with the average across entity aggregates.',
            });
        }
    }
    if (contract.relativeComparison) {
        if (!hasExactRelativeComparator(sql, contract.relativeComparison.comparator)) {
            issues.push({
                code: 'missing_comparator',
                severity: 'error',
                message: `The relative-average comparison must use the exact ${contract.relativeComparison.comparator} boundary required by the wording.`,
            });
        }
        if (!hasRelativeMultiplier(sql, contract.relativeComparison.multiplier)) {
            issues.push({
                code: 'missing_comparator',
                severity: 'error',
                message: `The relative-average threshold must apply multiplier ${contract.relativeComparison.multiplier}.`,
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
    if (contract.requiresRanking && contract.rankingTarget?.confidence === 'high'
        && !aggregateRankingExpressionPresent(sql, contract.rankingTarget)) {
        const target = contract.rankingTarget;
        issues.push({
            code: 'wrong_ranking_target',
            severity: 'error',
            message: `The ranking must be determined by ${target.mode === 'frequency' ? 'COUNT(*) frequency' : `${target.aggregation ? `${target.aggregation.toUpperCase()} over ` : ''}"${target.field}"`}, not an unrelated expression.`,
        });
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
    if (rows.length > 1 && contract.uniqueResultFields.length) {
        const normalizedKeys = new Map<string, string>();
        for (const key of Object.keys(rows[0] || {})) normalizedKeys.set(key.toLowerCase(), key);
        const physicalKeys = contract.uniqueResultFields
            .map(field => normalizedKeys.get(field.toLowerCase()))
            .filter((field): field is string => Boolean(field));
        if (physicalKeys.length === contract.uniqueResultFields.length) {
            const seen = new Set<string>();
            for (const row of rows) {
                const tuple = JSON.stringify(physicalKeys.map(field => row[field]));
                if (seen.has(tuple)) {
                    return [{
                        code: 'unexpected_result_cardinality',
                        severity: 'error',
                        message: `The executed query repeats the requested group grain (${contract.uniqueResultFields.join(', ')}). Return exactly one row per qualifying group instead of the matching detail rows.`,
                    }];
                }
                seen.add(tuple);
            }
        }
    }
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
