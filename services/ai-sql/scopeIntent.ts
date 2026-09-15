import type { Dataset } from '../../types';

export interface BroadScopeDetection {
    needsClarification: boolean;
    reason?: string;
}

export interface SummaryIntentDetection {
    isSummary: boolean;
}

export interface SummaryStoryQuestion {
    id: string;
    question: string;
    title: string;
    icon: string;
}

const BROAD_OUTPUT_WORDS = /\b(?:summary|summarise|summarize|overview|analysis|analyse|analyze|insights?|report)\b/i;
const EXHAUSTIVE_WORDS = /\b(?:all|full|complete|entire|every|everything|each and every)\b/i;
const DATASET_WORDS = /\b(?:data|dataset|file|workbook|spreadsheet|table|rows?|records?|data\s*points?)\b/i;
const UNSCOPED_PHRASES = /\b(?:tell me everything|show me everything|what is in (?:this|the) (?:data|dataset|file|workbook)|explore (?:this|the) (?:data|dataset)|analyse (?:this|the) (?:data|dataset)|analyze (?:this|the) (?:data|dataset))\b/i;

// Signals that materially constrain the requested answer. Their presence means
// a broad word such as "all" is probably intentional rather than ambiguous.
const ANALYTICAL_SCOPE = /\b(?:by|per|for each|where|with|without|between|before|after|during|in fy\s*\d|in \d{4}|top\s+\d+|bottom\s+\d+|versus|\bvs\b|compared?\s+(?:with|to)|trend|growth|share|percent(?:age)?|average|total|sum|count|minimum|maximum|highest|lowest)\b/i;
const SUMMARY_WORDS = /\b(?:summary|summarise|summarize|overview|report|dashboard|snapshot|key metrics?|big picture|complete picture|overall performance|health check)\b/i;
const BROAD_ANALYSIS_REQUEST = /\b(?:tell me everything|show me everything|explore (?:this|the|my|our) (?:data|dataset|file|workbook)|analy[sz]e (?:this|the|my|our) (?:data|dataset|file|workbook))\b/i;

/** A summary is a valid multi-analysis request, not automatically ambiguity. */
export function detectSummaryRequest(question: string): SummaryIntentDetection {
    const normalized = question.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized || !(SUMMARY_WORDS.test(normalized) || BROAD_ANALYSIS_REQUEST.test(normalized))) {
        return { isSummary: false };
    }

    // Avoid hijacking ordinary projections of physical columns such as
    // "degree_summary_name" after punctuation/underscore normalisation.
    if (/\bsummary\s+(?:id|key|code|name|label|field|column)\b/i.test(normalized)) {
        return { isSummary: false };
    }
    return { isSummary: true };
}

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

    if (detectSummaryRequest(normalized).isSummary) return { needsClarification: false };
    if (!(unscopedPhrase || exhaustiveSummary)) return { needsClarification: false };
    if (ANALYTICAL_SCOPE.test(normalized)) return { needsClarification: false };

    return {
        needsClarification: true,
        reason: 'A complete dataset summary can mean a dataset overview, every record, or a focused business analysis. Those produce different answers.',
    };
}

function normalizedFieldName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fieldIsMentioned(question: string, field: { name: string; displayLabel?: string; synonyms?: string[] }): boolean {
    const haystack = ` ${normalizedFieldName(question)} `;
    const names = [field.name, field.displayLabel || '', ...(field.synonyms || [])]
        .map(normalizedFieldName)
        .filter(name => name.length > 2);
    return names.some(name => haystack.includes(` ${name} `));
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSummaryScope(question: string, consumedTerms: string[] = []): string {
    const normalized = question.replace(/\s+/g, ' ').replace(/[?.!]+$/, '').trim();
    const scopes: string[] = [];
    const qualifier = normalized.match(/\b(where|with|without|between|during|for|in|excluding|except)\b\s+(.+)$/i);
    if (qualifier) {
        const clause = `${qualifier[1]} ${qualifier[2]}`.trim();
        if (!/^(?:in|for) (?:this|the|my|our)?\s*(?:data|dataset|file|workbook|spreadsheet)\b/i.test(clause)) {
            scopes.push(clause);
        }
    }

    const timePatterns = [
        /\b(?:this|current|last|previous|next)\s+(?:day|week|month|quarter|year)\b/i,
        /\bFY\s*\d{4}(?:\s*[-/]\s*\d{2,4})?\b/i,
        /\bQ[1-4]\s*(?:FY\s*)?\d{2,4}\b/i,
        /\b(?:19|20)\d{2}\b/,
    ];
    for (const pattern of timePatterns) {
        const match = normalized.match(pattern)?.[0];
        if (match && !scopes.some(scope => scope.toLowerCase().includes(match.toLowerCase()))) {
            scopes.push(`for ${match}`);
            break;
        }
    }

    // Preserve a leading literal or modifier even when the user writes it in
    // shorthand, for example "India sales summary". Remove only known
    // request boilerplate and fields already represented by the sub-question.
    let residual = normalized;
    if (qualifier) residual = residual.replace(qualifier[0], ' ');
    residual = residual
        .replace(/\b(?:summary|summarise|summarize|overview|report|dashboard|snapshot|key metrics?|big picture|complete picture|overall performance|health check)\b/gi, ' ')
        .replace(/\b(?:give|show|create|build|generate|provide|tell)\s+(?:me|us)\b/gi, ' ')
        .replace(/\b(?:please|full|complete|entire|all|every|data points?|data|dataset|file|workbook|spreadsheet|the|a|an|of|about)\b/gi, ' ');
    for (const term of consumedTerms.filter(Boolean).sort((left, right) => right.length - left.length)) {
        residual = residual.replace(new RegExp(`\\b${escapeRegex(normalizedFieldName(term)).replace(/\s+/g, '\\s+')}\\b`, 'gi'), ' ');
    }
    for (const pattern of timePatterns) residual = residual.replace(new RegExp(pattern.source, 'gi'), ' ');
    residual = residual
        .replace(/[’']s\b/gi, ' ')
        .replace(/\b(?:by|for|in|this|current)\b/gi, ' ')
        .replace(/[^a-z0-9%+.-]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (residual.length > 1 && !scopes.some(scope => normalizedFieldName(scope).includes(normalizedFieldName(residual)))) {
        scopes.unshift(`for ${residual}`);
    }
    return scopes.join(' ');
}

function appendScope(question: string, scope: string): string {
    return scope ? `${question} ${scope}` : question;
}

function metricAggregation(field: { defaultAgg?: string; semanticType?: string; additivity?: string }): 'total' | 'average' | 'count' | 'minimum' | 'maximum' {
    if (field.defaultAgg === 'avg' || field.semanticType === 'percentage' || field.semanticType === 'ratio' || field.additivity === 'non_additive') return 'average';
    if (field.defaultAgg === 'count' || field.defaultAgg === 'count_distinct') return 'count';
    if (field.defaultAgg === 'min') return 'minimum';
    if (field.defaultAgg === 'max') return 'maximum';
    return 'total';
}

/**
 * Turn one summary request into a dataset-aware analytical story. Each item is
 * a normal standalone business question, so the regular SQL validation and
 * chart recommendation pipeline remains the source of truth.
 */
export function buildSummaryStoryQuestions(dataset: Dataset, userQuestion: string): SummaryStoryQuestion[] {
    const fields = dataset.aiSqlSemanticModel?.fields || [];
    const metrics = fields
        .filter(field => field.role === 'metric' && field.semanticType !== 'identifier')
        .sort((left, right) => {
            const mentioned = Number(fieldIsMentioned(userQuestion, right)) - Number(fieldIsMentioned(userQuestion, left));
            if (mentioned) return mentioned;
            const priority = (name: string) => /sales|revenue|amount|value|profit/i.test(name) ? 1 : 0;
            return priority(right.name) - priority(left.name);
        });
    const dimensions = fields
        .filter(field => field.role === 'dimension'
            && field.semanticType !== 'identifier'
            && field.semanticType !== 'date'
            && !/url|notes?|description/i.test(field.name))
        .sort((left, right) => Number(fieldIsMentioned(userQuestion, right)) - Number(fieldIsMentioned(userQuestion, left)));
    const date = fields.find(field => field.semanticType === 'date');
    const explicitlyGrouped = dimensions.find(field => {
        const label = normalizedFieldName(field.displayLabel || field.name);
        return new RegExp(`\\bby\\s+(?:the\\s+)?${label.replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalizedFieldName(userQuestion));
    });
    const primaryMetric = metrics[0];
    const primaryDimension = explicitlyGrouped || dimensions[0];
    const metricLabel = primaryMetric ? humanize(primaryMetric.displayLabel || primaryMetric.name) : '';
    let scope = extractSummaryScope(userQuestion, [
        ...(metrics.filter(field => fieldIsMentioned(userQuestion, field)).flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])])),
        ...(dimensions.filter(field => fieldIsMentioned(userQuestion, field)).flatMap(field => [field.name, field.displayLabel, ...(field.synonyms || [])])),
    ].filter((term): term is string => Boolean(term)));
    if (explicitlyGrouped && scope) {
        const label = normalizedFieldName(explicitlyGrouped.displayLabel || explicitlyGrouped.name)
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s+/g, '\\s+');
        scope = scope.replace(new RegExp(`\\s*\\bby\\s+(?:the\\s+)?${label}\\b`, 'i'), '').trim();
    }
    const primaryAggregation = primaryMetric ? metricAggregation(primaryMetric) : 'total';
    const groupSuffix = explicitlyGrouped ? ` by ${humanize(explicitlyGrouped.displayLabel || explicitlyGrouped.name)}` : '';
    const items: SummaryStoryQuestion[] = [];
    const add = (item: SummaryStoryQuestion) => {
        if (!items.some(existing => normalizedFieldName(existing.question) === normalizedFieldName(item.question))) items.push(item);
    };

    add({
        id: 'records', icon: '📋', title: groupSuffix ? `Record Volume${groupSuffix}` : 'Record Volume',
        question: appendScope(`Count records${groupSuffix}`, scope),
    });

    if (primaryMetric) {
        add({
            id: 'total', icon: '∑', title: groupSuffix ? `${metricLabel}${groupSuffix}` : `Total ${metricLabel}`,
            question: appendScope(`Show ${primaryAggregation} ${metricLabel}${groupSuffix}`, scope),
        });
        if (primaryAggregation === 'total') {
            add({
                id: 'average', icon: 'Ø', title: `Average ${metricLabel}`,
                question: appendScope(`Show average ${metricLabel}${groupSuffix}`, scope),
            });
        }
    }

    const addBreakdown = (dimension: typeof dimensions[number] | undefined, index: number) => {
        if (!primaryMetric || !dimension) return;
        const dimensionLabel = humanize(dimension.displayLabel || dimension.name);
        add({
            id: `breakdown_${index}`, icon: index === 0 ? '📊' : '🧩', title: `${metricLabel} by ${dimensionLabel}`,
            question: appendScope(`Show ${primaryAggregation} ${metricLabel} by ${dimensionLabel}`, scope),
        });
    };

    addBreakdown(dimensions[0], 0);

    // A time-aware summary should not lose its trend merely because several
    // measures or categories are available.
    if (primaryMetric && date) {
        const dateLabel = humanize(date.displayLabel || date.name);
        add({
            id: 'trend', icon: '📈', title: `${metricLabel} Trend`,
            question: appendScope(`Show ${metricLabel} trend by ${dateLabel}`, scope),
        });
    }

    if (metrics[1] && primaryDimension) {
        const secondMetricLabel = humanize(metrics[1].displayLabel || metrics[1].name);
        const secondAggregation = metricAggregation(metrics[1]);
        const dimensionLabel = humanize(primaryDimension.displayLabel || primaryDimension.name);
        add({
            id: 'secondary_metric', icon: '📈', title: `${secondMetricLabel} by ${dimensionLabel}`,
            question: appendScope(`Show ${secondAggregation} ${secondMetricLabel} by ${dimensionLabel}`, scope),
        });
    }

    addBreakdown(dimensions[1], 1);

    return items.slice(0, 6);
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

/**
 * Metadata-only teaching examples tailored to the current dataset. These are
 * suggestions, not a whitelist: they never restrict what the user can type.
 */
export function buildQuestionExamples(dataset: Dataset): string[] {
    const model = dataset.aiSqlSemanticModel;
    const metric = model?.fields.find(field => field.role === 'metric'
        && field.semanticType !== 'identifier');
    const dimensions = model?.fields.filter(field => field.role === 'dimension'
        && field.semanticType !== 'identifier'
        && field.semanticType !== 'date'
        && !/url|notes?|description/i.test(field.name)) || [];
    const date = model?.fields.find(field => field.semanticType === 'date');

    const metricLabel = metric ? humanize(metric.displayLabel || metric.name) : null;
    const firstDimension = dimensions[0] ? humanize(dimensions[0].displayLabel || dimensions[0].name) : null;
    const secondDimension = dimensions[1] ? humanize(dimensions[1].displayLabel || dimensions[1].name) : firstDimension;
    const dateLabel = date ? humanize(date.displayLabel || date.name) : null;
    const suggestions: string[] = [];

    if (metricLabel && firstDimension) {
        suggestions.push(`Show total ${metricLabel} by ${firstDimension}`);
        suggestions.push(`Compare ${metricLabel} by ${firstDimension}`);
        suggestions.push(`Show the top 10 ${secondDimension || firstDimension} by ${metricLabel}`);
    }
    if (metricLabel && dateLabel) suggestions.push(`Show the ${metricLabel} trend by ${dateLabel}`);
    if (metricLabel && secondDimension) suggestions.push(`Show average ${metricLabel} by ${secondDimension}`);
    if (firstDimension) suggestions.push(`Count records by ${firstDimension}`);

    if (!suggestions.length) suggestions.push(buildFocusedQuestionSuggestion(dataset));
    return [...new Set(suggestions)].slice(0, 6);
}
