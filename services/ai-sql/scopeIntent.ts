import type { Dataset } from '../../types';

export interface BroadScopeDetection {
    needsClarification: boolean;
    reason?: string;
}

const BROAD_OUTPUT_WORDS = /\b(?:summary|summarise|summarize|overview|analysis|analyse|analyze|insights?|report)\b/i;
const EXHAUSTIVE_WORDS = /\b(?:all|full|complete|entire|every|everything|each and every)\b/i;
const DATASET_WORDS = /\b(?:data|dataset|file|workbook|spreadsheet|table|rows?|records?|data\s*points?)\b/i;
const UNSCOPED_PHRASES = /\b(?:tell me everything|show me everything|what is in (?:this|the) (?:data|dataset|file|workbook)|explore (?:this|the) (?:data|dataset)|analyse (?:this|the) (?:data|dataset)|analyze (?:this|the) (?:data|dataset))\b/i;

// Signals that materially constrain the requested answer. Their presence means
// a broad word such as "all" is probably intentional rather than ambiguous.
const ANALYTICAL_SCOPE = /\b(?:by|per|for each|where|with|without|between|before|after|during|in fy\s*\d|in \d{4}|top\s+\d+|bottom\s+\d+|versus|\bvs\b|compared?\s+(?:with|to)|trend|growth|share|percent(?:age)?|average|total|sum|count|minimum|maximum|highest|lowest)\b/i;

/**
 * Detect requests whose output cannot be represented honestly as one query.
 * This deliberately targets only high-confidence dataset-wide wording; normal
 * requests such as "show all orders in 2025" continue to the analytics engine.
 */
export function detectBroadScopeQuestion(question: string): BroadScopeDetection {
    const normalized = question.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return { needsClarification: false };

    const unscopedPhrase = UNSCOPED_PHRASES.test(normalized);
    const exhaustiveSummary = EXHAUSTIVE_WORDS.test(normalized)
        && DATASET_WORDS.test(normalized)
        && BROAD_OUTPUT_WORDS.test(normalized);

    if (!(unscopedPhrase || exhaustiveSummary)) return { needsClarification: false };
    if (ANALYTICAL_SCOPE.test(normalized)) return { needsClarification: false };

    return {
        needsClarification: true,
        reason: 'A complete dataset summary can mean a dataset overview, every record, or a focused business analysis. Those produce different answers.',
    };
}

function humanize(name: string): string {
    return name
        .replace(/\s*→\s*/g, ' ')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, char => char.toUpperCase());
}

/** Build a concrete, dataset-aware example without inspecting or sharing rows. */
export function buildFocusedQuestionSuggestion(dataset: Dataset): string {
    const model = dataset.aiSqlSemanticModel;
    const metric = model?.fields.find(field => field.role === 'metric')
        || model?.fields.find(field => /amount|value|sales|revenue|profit|cost|count|quantity/i.test(field.name));
    const dimension = model?.fields.find(field => field.role === 'dimension'
        && field.semanticType !== 'identifier'
        && !/url|notes?|description/i.test(field.name));

    if (metric && dimension) {
        return `Show total ${humanize(metric.displayLabel || metric.name)} by ${humanize(dimension.displayLabel || dimension.name)}`;
    }
    if (metric) return `Show the total ${humanize(metric.displayLabel || metric.name)}`;

    const fallbackDimension = dataset.columns.find(column => !/id|key|url|notes?/i.test(column.name));
    return fallbackDimension
        ? `Show the different ${humanize(fallbackDimension.name)} values`
        : 'Count the records in this dataset';
}
