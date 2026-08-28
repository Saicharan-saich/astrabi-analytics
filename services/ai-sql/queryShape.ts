/**
 * Schema-independent query-shape inference.
 *
 * This module deliberately knows nothing about benchmark IDs, domains, tables,
 * or column names. It extracts only grammatical constraints that every SQL
 * query has: operation, selection cardinality, ordering, grouping and limits.
 */

import { detectRequestedLimit } from './questionNumbers';

export type SelectionMode = 'all_rows' | 'all_groups' | 'single' | 'top_n' | 'unspecified';
export type QueryOperation = 'projection' | 'grouped_aggregate' | 'scalar_aggregate' | 'ranking' | 'unknown';

export interface QueryShape {
    operation: QueryOperation;
    selection: SelectionMode;
    explicitAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
    /** Every aggregate operation explicitly requested by the user. The
     * singular field above remains as a backwards-compatible primary value. */
    explicitAggregations: Array<'sum' | 'avg' | 'count' | 'min' | 'max'>;
    groupingCue: boolean;
    orderDirection?: 'asc' | 'desc';
    orderFieldPhrase?: string;
    explicitLimit?: number;
    /** True when LIMIT would silently discard requested rows/groups. */
    prohibitsImplicitLimit: boolean;
    /** True when wording asks for raw fields rather than aggregate measures. */
    orderedProjection: boolean;
    /** Explicit request to de-duplicate a projection. */
    distinctRequested: boolean;
    /** Count-of-related-members threshold inferred from grammar such as
     * "grades with 4 or more students". */
    implicitGroupedCount: boolean;
    /** Frequency ranking inferred from wording such as "most common value" or
     * "the type that the most records belong to". */
    implicitFrequencyRanking: boolean;
}

function explicitAggregations(question: string): QueryShape['explicitAggregations'] {
    const matches: Array<{ index: number; aggregation: QueryShape['explicitAggregations'][number] }> = [];
    const patterns: Array<[RegExp, QueryShape['explicitAggregations'][number]]> = [
        [/\b(?:how many|number of|count(?: of)?|count the)\b/gi, 'count'],
        [/\b(?:average|avg|mean)\b/gi, 'avg'],
        [/\b(?:total|sum(?: of)?)\b/gi, 'sum'],
        [/\b(?:minimum|min(?:imum)?(?:\s+(?:value|amount|number|measure|count|date|time|age|price|cost|sales|revenue|profit|weight|height|length|duration|tickets?))?)\b/gi, 'min'],
        [/\b(?:maximum|max(?:imum)?(?:\s+(?:value|amount|number|measure|count|date|time|age|price|cost|sales|revenue|profit|weight|height|length|duration|tickets?))?)\b/gi, 'max'],
    ];
    for (const [pattern, aggregation] of patterns) {
        for (const match of question.matchAll(pattern)) matches.push({ index: match.index || 0, aggregation });
    }
    matches.sort((a, b) => a.index - b.index);
    return matches.map(match => match.aggregation)
        .filter((aggregation, index, all) => all.indexOf(aggregation) === index);
}

function directionFromRange(start: string, end: string): 'asc' | 'desc' | undefined {
    const low = new Set(['youngest', 'lowest', 'least', 'smallest', 'earliest', 'oldest-date']);
    const high = new Set(['oldest', 'highest', 'most', 'largest', 'latest', 'newest']);
    const a = start.toLowerCase().replace(/\s+/g, '-');
    const b = end.toLowerCase().replace(/\s+/g, '-');
    if (high.has(a) && low.has(b)) return 'desc';
    if (low.has(a) && high.has(b)) return 'asc';
    return undefined;
}

function ordering(question: string): Pick<QueryShape, 'orderDirection' | 'orderFieldPhrase'> {
    const range = question.match(
        /\b(?:ordered|sorted)\s+by\s+(.+?)\s+from\s+(?:the\s+)?(youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\s+to\s+(?:the\s+)?(youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\b/i,
    );
    if (range) {
        return { orderFieldPhrase: range[1].trim(), orderDirection: directionFromRange(range[2], range[3]) };
    }

    const directional = question.match(/\b(ascending|descending)\s+order\s+(?:of|by)\s+([^?.,;]+)/i);
    if (directional) {
        return { orderFieldPhrase: directional[2].trim(), orderDirection: /^desc/i.test(directional[1]) ? 'desc' : 'asc' };
    }

    const orderedBy = question.match(/\b(?:ordered|sorted)\s+by\s+(.+?)(?:\s+(ascending|descending|asc|desc)\b|[?.,;]|$)/i);
    if (orderedBy) {
        return {
            orderFieldPhrase: orderedBy[1].trim(),
            orderDirection: /desc/i.test(orderedBy[2] || '') ? 'desc' : 'asc',
        };
    }

    return {};
}

function hasExplicitSingleWinner(question: string): boolean {
    if (/\b(?:the\s+)?(?:youngest|oldest|highest|lowest|largest|smallest|best|worst|latest|earliest|newest)\s+[a-z]/i.test(question)) return true;
    if (/\b(?:which|what)\s+.+?\b(?:has|have|had|is|was|generated|produced|sold)\b.+?\b(?:most|least|highest|lowest|largest|smallest|maximum|minimum|best|worst)\b/i.test(question)) return true;
    // General predicate form: "Which continent speaks the most languages?",
    // "Which team completed the fewest tasks?". The superlative determines
    // cardinality; the intervening verb is domain-specific and must stay open.
    if (/\b(?:which|what)\s+.+?\s+[a-z][a-z0-9_-]*\s+(?:the\s+)?(?:most|fewest|least)\s+[a-z][a-z0-9_-]*\b/i.test(question)) return true;
    // Grammatical rule rather than a vocabulary list: a singular noun phrase
    // followed by "with the <superlative>" requests one winner. Plural/group
    // wording is handled by the grouping and all-result rules below.
    if (/\b(?:the\s+)?[a-z][a-z0-9_-]*\s+with\s+(?:the\s+)?(?:most|least|highest|lowest|largest|smallest|maximum|minimum|best|worst)\b/i.test(question)) return true;
    return false;
}

/** Comparative reference aggregates constrain a filter; they do not describe
 * the outer result shape ("rows above the average", "more than the minimum"). */
function withoutComparativeReferences(question: string): string {
    return question
        .replace(/\b(?:more|greater|higher|less|lower|fewer)\s+than\s+(?:the\s+)?(?:average|mean|minimum|maximum|lowest|highest)\b[^?.,;]*/gi, '')
        .replace(/\b(?:above|below)\s+(?:the\s+)?(?:average|mean|minimum|maximum)\b[^?.,;]*/gi, '');
}

/** "Number" is an aggregation only when it denotes cardinality. Common
 * identifier phrases such as contact number and order number are attributes
 * to project/filter, not COUNT instructions. */
function withoutIdentifierNumberPhrases(question: string): string {
    return question.replace(
        /\b(?:contact|phone|telephone|mobile|cell|account|order|serial|model|part|ticket|card|flight|race|id)\s+number\b/gi,
        ' identifier ',
    );
}

function hasComparativeReference(question: string): boolean {
    return /\b(?:more|greater|higher|less|lower|fewer)\s+than\s+(?:the\s+)?(?:average|mean|minimum|maximum|lowest|highest)\b|\b(?:above|below)\s+(?:the\s+)?(?:average|mean|minimum|maximum)\b/i.test(question);
}

export function inferQueryShape(question: string): QueryShape {
    const shapeText = withoutIdentifierNumberPhrases(withoutComparativeReferences(question));
    const comparativeReference = hasComparativeReference(question);
    // "Which grades have 4 or more students?" is a grouped count even though
    // the user never says the word "count". Keep this grammar-based: a
    // result-entity phrase followed by have/has/with, an explicit numeric
    // threshold, and a related-member noun. This also covers equivalent
    // phrasings such as "teams with at least 5 players" without naming any
    // domain, table, field, or benchmark case.
    const thresholdedGroupCount = /\b(?:which|what|show|list|find)\b[\s\S]*?\b(?:have|has|with)\s+(?:(?:at\s+least|at\s+most|more\s+than|fewer\s+than|less\s+than)\s+-?\d+(?:\.\d+)?|-?\d+(?:\.\d+)?\s+or\s+(?:more|fewer|less))\s+[a-z]/i.test(question);
    // "Which industries have average score at least 70?" asks for one row per
    // entity even though the grouping is expressed through a qualifying
    // aggregate rather than "by/per each" wording.
    const aggregateQualifiedGroups = /^\s*(?:please\s+)?(?:which|what|show|list|find|return|give(?:\s+me)?)\b[\s\S]*?\b(?:have|has|with|whose)\b[\s\S]{0,100}\b(?:at\s+least|at\s+most|more\s+than|greater\s+than|fewer\s+than|less\s+than|over|under)\s+-?\d+(?:\.\d+)?/i.test(question);
    // Frequency winners are count rankings even when the count is implicit.
    // Cover both direct wording ("most common citizenship") and inverse
    // relative clauses ("the type that the most records belong to"). The
    // action-prefix guard keeps an all-row ranking such as "Rank every ..."
    // from being collapsed to one winner merely because it mentions common.
    const frequencyWinner = /^\s*(?:please\s+)?(?:which|what|find|return|give(?:\s+me)?|show)\b[\s\S]*?(?:\b(?:most|least)\s+(?:common(?:ly)?|frequent(?:ly)?|popular)\b|\bwith\s+(?:the\s+)?(?:most|fewest|least|greatest|smallest)\s+number\s+of\b|\b(?:that|which|who)\s+(?:[a-z][a-z0-9_-]*\s+){0,4}?(?:the\s+)?(?:most|fewest|least)\s+[a-z])/i.test(question);
    const requestedAggregations = explicitAggregations(shapeText);
    if ((thresholdedGroupCount || frequencyWinner) && !requestedAggregations.includes('count')) {
        requestedAggregations.push('count');
    }
    const aggregation = requestedAggregations[0];
    // "Rank industries by record count" and "citizenships ranked by maximum
    // net worth" request every group in ranked order. Ranking is independent
    // from truncation: LIMIT is legal only when the user asks for a winner/N.
    const explicitAllGroupRanking = !!aggregation
        && /\b(?:rank|ranked|ranking|order|ordered|sort|sorted)\b[\s\S]{0,100}\bby\b/i.test(question)
        && !detectRequestedLimit(question);
    const groupingText = question.replace(/\b(?:ordered|sorted|ranked)\s+by\b/gi, '');
    const groupingCue = thresholdedGroupCount || aggregateQualifiedGroups || frequencyWinner || explicitAllGroupRanking
        || /\b(?:by|per|for\s+each|for\s+every|each|every)\b/i.test(groupingText)
        || /\bof\s+(?:singers?|records?|items?|entities?)\s+of\s+each\b/i.test(question);
    const order = ordering(question);
    const requestedLimit = detectRequestedLimit(question);
    // Natural questions commonly put N before the entity: "Which 3 regions
    // have the lowest sales?". Without this grammar, the later superlative was
    // misread as a single winner and silently became LIMIT 1.
    const leadingNIsRanking = requestedLimit?.placement === 'leading_count'
        && /\b(?:most|fewest|least|highest|lowest|largest|smallest|maximum|minimum|best|worst|top|bottom)\b/i.test(question);
    const explicitLimit = requestedLimit?.placement === 'rank_prefix' || leadingNIsRanking
        ? requestedLimit?.limit
        : undefined;
    const directionalRange = /\bfrom\s+(?:the\s+)?(?:youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\s+to\s+(?:the\s+)?(?:youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\b/i.test(question);
    const rankingText = shapeText
        .replace(/\b(?:at|no)\s+(?:least|most)\b/gi, '')
        // "highest first" describes sort direction for a full ranking; it is
        // not the noun phrase "the highest <entity>" and must not imply LIMIT 1.
        .replace(/\b(?:highest|lowest|largest|smallest|oldest|youngest|latest|earliest)\s+first\b/gi, '');
    const singleWinner = !directionalRange && (frequencyWinner || hasExplicitSingleWinner(rankingText));
    const allCue = /\b(?:all|every|each|different|distinct)\b|\bwhich\s+ones\b/i.test(question);
    const distinctRequested = /\b(?:different|distinct|unique)\b/i.test(question);
    const orderedProjection = !!order.orderFieldPhrase && !aggregation && !explicitLimit && !singleWinner;

    let selection: SelectionMode = 'unspecified';
    if (explicitLimit) selection = 'top_n';
    else if (singleWinner) selection = 'single';
    else if (aggregation && groupingCue) selection = 'all_groups';
    else if (orderedProjection || allCue || comparativeReference) selection = groupingCue && aggregation ? 'all_groups' : 'all_rows';

    let operation: QueryOperation = 'unknown';
    if (orderedProjection || (comparativeReference && !aggregation)) operation = 'projection';
    else if (explicitLimit || singleWinner) operation = 'ranking';
    else if (explicitAllGroupRanking) operation = 'ranking';
    else if (aggregation && groupingCue) operation = 'grouped_aggregate';
    else if (aggregation) operation = 'scalar_aggregate';

    return {
        operation,
        selection,
        explicitAggregation: aggregation,
        explicitAggregations: requestedAggregations,
        groupingCue,
        orderDirection: order.orderDirection,
        orderFieldPhrase: order.orderFieldPhrase,
        explicitLimit,
        prohibitsImplicitLimit: selection === 'all_rows' || selection === 'all_groups',
        orderedProjection,
        distinctRequested,
        implicitGroupedCount: thresholdedGroupCount,
        implicitFrequencyRanking: frequencyWinner,
    };
}
