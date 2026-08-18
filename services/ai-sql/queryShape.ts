/**
 * Schema-independent query-shape inference.
 *
 * This module deliberately knows nothing about benchmark IDs, domains, tables,
 * or column names. It extracts only grammatical constraints that every SQL
 * query has: operation, selection cardinality, ordering, grouping and limits.
 */

export type SelectionMode = 'all_rows' | 'all_groups' | 'single' | 'top_n' | 'unspecified';
export type QueryOperation = 'projection' | 'grouped_aggregate' | 'scalar_aggregate' | 'ranking' | 'unknown';

export interface QueryShape {
    operation: QueryOperation;
    selection: SelectionMode;
    explicitAggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max';
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
}

function explicitAggregation(question: string): QueryShape['explicitAggregation'] {
    if (/\b(?:how many|number of|count(?: of)?|count the)\b/i.test(question)) return 'count';
    if (/\b(?:average|avg|mean)\b/i.test(question)) return 'avg';
    if (/\b(?:total|sum(?: of)?)\b/i.test(question)) return 'sum';
    if (/\b(?:minimum|min(?:imum)?\s+(?:value|amount|number|measure))\b/i.test(question)) return 'min';
    if (/\b(?:maximum|max(?:imum)?\s+(?:value|amount|number|measure))\b/i.test(question)) return 'max';
    return undefined;
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

function hasComparativeReference(question: string): boolean {
    return /\b(?:more|greater|higher|less|lower|fewer)\s+than\s+(?:the\s+)?(?:average|mean|minimum|maximum|lowest|highest)\b|\b(?:above|below)\s+(?:the\s+)?(?:average|mean|minimum|maximum)\b/i.test(question);
}

export function inferQueryShape(question: string): QueryShape {
    const shapeText = withoutComparativeReferences(question);
    const comparativeReference = hasComparativeReference(question);
    const aggregation = explicitAggregation(shapeText);
    const groupingText = question.replace(/\b(?:ordered|sorted|ranked)\s+by\b/gi, '');
    const groupingCue = /\b(?:by|per|for\s+each|for\s+every|each|every)\b/i.test(groupingText)
        || /\bof\s+(?:singers?|records?|items?|entities?)\s+of\s+each\b/i.test(question);
    const order = ordering(question);
    const topN = question.match(/\b(top|bottom|first|last)\s+(\d+)\b/i);
    const explicitLimit = topN ? Number(topN[2]) : undefined;
    const directionalRange = /\bfrom\s+(?:the\s+)?(?:youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\s+to\s+(?:the\s+)?(?:youngest|oldest|lowest|highest|least|most|smallest|largest|earliest|latest|newest)\b/i.test(question);
    const rankingText = shapeText.replace(/\b(?:at|no)\s+(?:least|most)\b/gi, '');
    const singleWinner = !directionalRange && hasExplicitSingleWinner(rankingText);
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
    else if (aggregation && groupingCue) operation = 'grouped_aggregate';
    else if (aggregation) operation = 'scalar_aggregate';

    return {
        operation,
        selection,
        explicitAggregation: aggregation,
        groupingCue,
        orderDirection: order.orderDirection,
        orderFieldPhrase: order.orderFieldPhrase,
        explicitLimit,
        prohibitsImplicitLimit: selection === 'all_rows' || selection === 'all_groups',
        orderedProjection,
        distinctRequested,
    };
}
