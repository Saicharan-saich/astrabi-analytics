import type { AnalysisPlan, SemanticModel } from './types';

export interface NoDataExplanationInput {
    sql: string;
    plan: AnalysisPlan;
    semanticModel: SemanticModel;
    resolvedTime?: { description?: string };
    unmatchedLiterals?: string[];
    privacyMode: 'strict' | 'enhanced';
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Date coverage is useful only when a WHERE/HAVING predicate actually uses time. */
export function sqlUsesTemporalPredicate(sql: string, semanticModel: SemanticModel): boolean {
    const predicateSections = Array.from(sql.matchAll(/\b(?:where|having)\b([\s\S]*?)(?=\b(?:group\s+by|having|order\s+by|limit|union|intersect|except)\b|$)/gi))
        .map(match => match[1])
        .join(' ');
    if (!predicateSections) return false;

    if (/\b(?:date|timestamp)\s*'\d{4}-\d{2}-\d{2}|\b(?:date_trunc|date_diff|datediff|extract|strftime)\s*\(|\bcast\s*\([^)]*\bas\s+(?:date|timestamp)\b/i.test(predicateSections)) {
        return true;
    }

    const dateFields = semanticModel.fields
        .filter(field => field.semanticType === 'date' || /date|time|month|year|quarter|week/i.test(field.name))
        .map(field => field.name);
    return dateFields.some(field => {
        const fieldPattern = '(?:^|[^A-Za-z0-9_])(?:[A-Za-z_][\\w$]*\\.)?["`]?'
            + escapeRegex(field)
            + '["`]?(?:$|[^A-Za-z0-9_])';
        return new RegExp(fieldPattern, 'i').test(predicateSections);
    });
}

function hasExactZeroAggregateThreshold(sql: string): boolean {
    return /\bhaving\b[\s\S]*?\b(?:sum|avg|min|max|count)\s*\([^)]*\)\s*=\s*0(?:\.0+)?\b/i.test(sql);
}

export function buildNoDataExplanation(input: NoDataExplanationInput): string {
    const { sql, plan, semanticModel, resolvedTime, privacyMode } = input;
    const unmatchedLiterals = input.unmatchedLiterals || [];
    if (unmatchedLiterals.length > 0) {
        const valueNote = `These value(s) weren't found in your data: ${unmatchedLiterals.map(value => `"${value}"`).join(', ')}. Check the spelling, or they may be stored in a different column${privacyMode === 'strict' ? ' — or switch to "Better answers" mode so the AI can see your real values' : ''}.`;
        return `No matching data found. ${valueNote}`;
    }

    const planUsesTime = plan.filters.some(filter => {
        const field = semanticModel.fields.find(candidate => candidate.name.toLowerCase() === filter.field.toLowerCase());
        return field?.semanticType === 'date';
    });
    const usesTime = Boolean(resolvedTime?.description) || planUsesTime || sqlUsesTemporalPredicate(sql, semanticModel);
    if (usesTime) {
        const periodDescription = resolvedTime?.description
            ? ` for ${resolvedTime.description}`
            : ' for the requested time conditions';
        const timeContext = semanticModel.timeContext;
        const rangeNote = timeContext
            ? ` The dataset contains data from ${timeContext.minDate} to ${timeContext.maxDate}.`
            : '';
        return `No data found${periodDescription}.${rangeNote} Try broadening the date range or reviewing the time filters.`;
    }

    if (hasExactZeroAggregateThreshold(sql)) {
        return 'The query ran successfully, but no groups had an aggregate exactly equal to zero. If you meant non-positive results, ask for “zero or negative” or “did not produce a positive outcome”.';
    }

    if (/\b(?:where|having)\b/i.test(sql)) {
        return 'The query ran successfully, but no rows or groups matched the requested conditions. Try reviewing the filters or threshold.';
    }

    return 'The query ran successfully but returned no rows.';
}
