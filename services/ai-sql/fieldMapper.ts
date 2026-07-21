/**
 * Field Mapper — Maps natural language question words to semantic model fields.
 *
 * Uses synonym matching, keyword extraction, and contextual hints
 * to identify which fields are dimensions, metrics, and filters
 * WITHOUT relying on the LLM.
 *
 * This is the bridge between the Question Classifier and the Plan Builder.
 */

import { SemanticModel, SemanticField } from './types';

export interface MappedFields {
    dimensions: SemanticField[];
    metrics: SemanticField[];
    filterHints: FilterHint[];
    confidence: number;  // 0-1, how confident we are in the mapping
}

export interface FilterHint {
    field: SemanticField;
    op: string;
    value: any;
}

// ── Common metric keywords ──────────────────────────────────────

const METRIC_KEYWORDS = new Set([
    'sales', 'revenue', 'profit', 'income', 'earnings', 'cost', 'price',
    'amount', 'total', 'quantity', 'qty', 'units', 'discount', 'shipping',
    'salary', 'wage', 'bonus', 'payment', 'value', 'margin', 'rate',
    'score', 'rating', 'count', 'number',
]);

// ── Common dimension keywords ───────────────────────────────────

const DIMENSION_KEYWORDS = new Set([
    'category', 'region', 'segment', 'product', 'customer', 'department',
    'state', 'city', 'country', 'type', 'group', 'status', 'channel',
    'brand', 'store', 'location', 'team', 'manager', 'gender', 'age',
    'name', 'ship mode', 'ship_mode',
]);

/**
 * Extract meaningful words from a question, ignoring stop words.
 */
function extractKeywords(question: string): string[] {
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
        'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
        'before', 'after', 'above', 'below', 'between', 'under', 'and', 'but',
        'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
        'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
        'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
        'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'this',
        'that', 'these', 'those', 'then', 'there', 'here', 'my', 'your', 'our',
        'me', 'us', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'them',
        'show', 'give', 'tell', 'display', 'get', 'find', 'list', 'see',
        'much', 'many', 'total', 'average', 'per', 'generated', 'highest',
        'lowest', 'top', 'bottom', 'best', 'worst', 'most', 'least',
    ]);

    return question
        .toLowerCase()
        .replace(/[?!.,;:'"()]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopWords.has(w));
}

/**
 * Score how well a field matches a keyword.
 * Returns 0-1 score. Higher = better match.
 */
function scoreFieldMatch(field: SemanticField, keyword: string): number {
    const kw = keyword.toLowerCase();
    const fieldName = field.name.toLowerCase().replace(/_/g, ' ');
    const fieldNameNoSpace = field.name.toLowerCase().replace(/_/g, '');

    // Exact match on name
    if (fieldName === kw || fieldNameNoSpace === kw) return 1.0;

    // Exact match on display label
    if (field.displayLabel.toLowerCase() === kw) return 0.95;

    // Synonym match
    if (field.synonyms.some(s => s.toLowerCase() === kw)) return 0.9;

    // Field name contains keyword
    if (fieldName.includes(kw) || kw.includes(fieldName)) return 0.7;

    // Synonym contains keyword
    if (field.synonyms.some(s => s.toLowerCase().includes(kw) || kw.includes(s.toLowerCase()))) return 0.6;

    // Partial word match (e.g., "profit" matches "profit_margin")
    const fieldWords = fieldName.split(' ');
    if (fieldWords.some(w => w === kw)) return 0.8;

    return 0;
}

/**
 * Map question words to semantic model fields.
 * Returns dimensions, metrics, and filter hints.
 */
export function mapFieldsFromQuestion(question: string, model: SemanticModel): MappedFields {
    const keywords = extractKeywords(question);
    const dimensions: SemanticField[] = [];
    const metrics: SemanticField[] = [];
    const filterHints: FilterHint[] = [];
    const usedFields = new Set<string>();

    // ── Pass 1: Direct field matching ──
    for (const kw of keywords) {
        let bestField: SemanticField | null = null;
        let bestScore = 0;

        for (const field of model.fields) {
            const score = scoreFieldMatch(field, kw);
            if (score > bestScore && score >= 0.6) {
                bestScore = score;
                bestField = field;
            }
        }

        if (bestField && !usedFields.has(bestField.name)) {
            usedFields.add(bestField.name);
            if (bestField.role === 'metric') {
                metrics.push(bestField);
            } else if (bestField.role === 'dimension') {
                dimensions.push(bestField);
            }
        }
    }

    // ── Pass 2: If no metrics found, use smart defaults ──
    if (metrics.length === 0) {
        const q = question.toLowerCase();
        // Money words → a revenue/amount question. Prefer a currency metric so
        // "total revenue" maps to total_price, not whatever sum-metric (e.g.
        // quantity) happens to come first in column order.
        const wantsMoney = /\b(revenue|sales|income|earnings|turnover|billing|billed|amount|spend|spending|profit|price|cost)\b/.test(q);
        const currencyMetric = model.fields.find(f => f.role === 'metric' && f.semanticType === 'currency');
        const sumMetric = model.fields.find(f =>
            f.role === 'metric' && f.defaultAgg === 'sum' && f.semanticType !== 'identifier');

        const defaultMeasure = (wantsMoney && currencyMetric)
            ? currencyMetric
            : (currencyMetric || sumMetric);

        if (defaultMeasure) {
            metrics.push(defaultMeasure);
        }
    }

    // ── Pass 3: If no dimensions found for breakdown/ranking, try keyword hints ──
    if (dimensions.length === 0) {
        for (const kw of keywords) {
            if (DIMENSION_KEYWORDS.has(kw)) {
                const dimField = model.fields.find(f =>
                    f.role === 'dimension' &&
                    (f.name.toLowerCase().includes(kw) ||
                     f.synonyms.some(s => s.toLowerCase().includes(kw)))
                );
                if (dimField && !usedFields.has(dimField.name)) {
                    dimensions.push(dimField);
                    usedFields.add(dimField.name);
                }
            }
        }
    }

    // ── Confidence calculation ──
    const totalMapped = dimensions.length + metrics.length;
    const confidence = totalMapped === 0 ? 0 :
        Math.min(1, totalMapped * 0.3 + (metrics.length > 0 ? 0.2 : 0) + (dimensions.length > 0 ? 0.2 : 0));

    console.log(`[Field Mapper] Mapped ${dimensions.length} dimensions, ${metrics.length} metrics from "${question.substring(0, 50)}..."`);

    return { dimensions, metrics, filterHints, confidence };
}

/**
 * Detect the primary metric field name from question text.
 * Used as a fallback when field mapping fails.
 */
export function detectMetricFromQuestion(question: string, model: SemanticModel): SemanticField | null {
    const q = question.toLowerCase();

    // Priority 1: Explicit metric keywords in the question
    for (const field of model.fields) {
        if (field.role !== 'metric') continue;

        const nameLower = field.name.toLowerCase();
        if (q.includes(nameLower) || q.includes(nameLower.replace(/_/g, ' '))) {
            return field;
        }

        // Check synonyms
        for (const syn of field.synonyms) {
            if (q.includes(syn.toLowerCase())) {
                return field;
            }
        }
    }

    // Priority 2: Default to the primary currency/revenue field
    return model.fields.find(f => f.role === 'metric' && f.semanticType === 'currency')
        || model.fields.find(f => f.role === 'metric' && f.defaultAgg === 'sum')
        || model.fields.find(f => f.role === 'metric')
        || null;
}
