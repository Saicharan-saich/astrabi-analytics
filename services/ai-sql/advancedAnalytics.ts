import type { AnalysisPlan } from './types';

/**
 * Advanced analytical operations that must survive question planning, model
 * drafting, deterministic review and SQL selection. These are deliberately
 * derived only from explicit wording: ordinary top-N and grouped aggregates do
 * not become window queries merely because a more elaborate SQL shape exists.
 */
export type AdvancedAnalyticKind =
    | 'running_total'
    | 'moving_average'
    | 'period_growth'
    | 'partitioned_rank'
    | 'explicit_rank'
    | 'percent_of_total'
    | 'cumulative_percent'
    | 'ntile';

export interface AdvancedAnalyticOperation {
    kind: AdvancedAnalyticKind;
    required: true;
    implementation: 'window' | 'cte_or_window';
    measureField?: string;
    orderBy?: string;
    partitionBy: string[];
    windowSize?: number;
    buckets?: number;
    outputAlias: string;
}

function unique(values: Array<string | undefined>): string[] {
    return values
        .filter((value): value is string => Boolean(value))
        .filter((value, index, all) => all.findIndex(other => other.toLowerCase() === value.toLowerCase()) === index);
}

function windowSizeFromQuestion(question: string): number | undefined {
    const match = question.match(/\b(\d+)\s*[- ]?\s*(?:period|day|week|month|quarter|year)s?\s+(?:moving|rolling)\b/i)
        || question.match(/\b(?:moving|rolling)\s+(\d+)\s*[- ]?\s*(?:period|day|week|month|quarter|year)s?\b/i);
    return match ? Math.max(1, Number(match[1])) : undefined;
}

function bucketCountFromQuestion(question: string): number | undefined {
    if (/\bquartile/i.test(question)) return 4;
    if (/\bdecile/i.test(question)) return 10;
    const match = question.match(/\b(?:ntile|tile|bucket)s?\s+(?:of\s+)?(\d+)\b/i);
    return match ? Math.max(2, Number(match[1])) : undefined;
}

export function detectAdvancedAnalyticOperations(
    question: string,
    plan: AnalysisPlan,
): AdvancedAnalyticOperation[] {
    const operations: AdvancedAnalyticOperation[] = [];
    const timeDimension = plan.dimensions.find(dimension => dimension.timeGrain);
    const orderBy = timeDimension?.field;
    const partitionBy = unique(plan.dimensions
        .filter(dimension => dimension !== timeDimension)
        .map(dimension => dimension.field));
    const measureField = plan.metrics[0]?.field;
    const add = (operation: AdvancedAnalyticOperation) => {
        if (!operations.some(existing => existing.kind === operation.kind)) operations.push(operation);
    };

    const requestsCumulativePercent = /\bcumulative\b[\s\S]{0,40}\b(?:percent(?:age)?|share|contribution)\b/i.test(question)
        || /\b(?:percent(?:age)?|share|contribution)\b[\s\S]{0,40}\bcumulative\b/i.test(question);

    if (!requestsCumulativePercent && /\b(?:running\s+total|cumulative\s+(?:sum|total|sales|revenue|profit|amount|quantity)|year[- ]to[- ]date\s+cumulative)\b/i.test(question)) {
        add({ kind: 'running_total', required: true, implementation: 'window', measureField, orderBy, partitionBy, outputAlias: 'running_total' });
    }

    if (/\b(?:moving|rolling)\s+(?:average|avg|mean)|\b(?:moving|rolling)\b[\s\S]{0,30}\b(?:average|avg|mean)\b/i.test(question)) {
        add({
            kind: 'moving_average',
            required: true,
            implementation: 'window',
            measureField,
            orderBy,
            partitionBy,
            windowSize: windowSizeFromQuestion(question) || 3,
            outputAlias: 'moving_avg',
        });
    }

    const explicitPeriodGrowth = /\b(?:month[- ]over[- ]month|quarter[- ]over[- ]quarter|year[- ]over[- ]year|week[- ]over[- ]week|day[- ]over[- ]day|mom|qoq|yoy|wow|dod)\b/i.test(question)
        || /\b(?:change|growth|difference|increase|decrease)\s+(?:from|versus|vs\.?)\s+(?:the\s+)?previous\s+(?:period|day|week|month|quarter|year)\b/i.test(question)
        || (Boolean(plan.comparison) && /\b(?:compare|comparison|compared|versus|vs\.?)\b/i.test(question));
    if (explicitPeriodGrowth || (plan.comparison?.mode === 'trend' && /\b(?:growth|change|difference|increase|decrease|percent)\b/i.test(question))) {
        add({ kind: 'period_growth', required: true, implementation: 'window', measureField, orderBy, partitionBy, outputAlias: 'growth_pct' });
    }

    const partitionedRanking = /\b(?:top|bottom)\s+\d+[\s\S]{0,80}\b(?:per|within|for)\s+(?:each|every)\b/i.test(question)
        || /\b(?:rank|ranking|ranked)\b[\s\S]{0,80}\b(?:within|per)\s+(?:each|every)\b/i.test(question);
    if (partitionedRanking) {
        const rankPartitions = timeDimension
            ? partitionBy
            : unique(plan.dimensions.slice(0, -1).map(dimension => dimension.field));
        add({ kind: 'partitioned_rank', required: true, implementation: 'window', measureField, orderBy: plan.sort[0]?.field || measureField, partitionBy: rankPartitions, outputAlias: 'row_rank' });
    } else if (/\b(?:show|include|display|return|calculate|assign|give)\s+(?:me\s+)?(?:the\s+)?(?:rank|ranking|rank position)\b/i.test(question)
        || /\b(?:what|which)\s+(?:is|are)\b[\s\S]{0,60}\b(?:rank|ranking|rank position)\b/i.test(question)
        || /(?:^|,|\band\s+)\s*(?:the\s+)?(?:rank|ranking|rank position)(?=\s*(?:,|\band\b|[?.]|$))/i.test(question)) {
        add({ kind: 'explicit_rank', required: true, implementation: 'window', measureField, orderBy: plan.sort[0]?.field || measureField, partitionBy: [], outputAlias: 'row_rank' });
    }

    if (plan.intent === 'share_of_total'
        || /\b(?:percent(?:age)?|share|contribution)\s+of\s+(?:the\s+)?(?:grand\s+)?total\b/i.test(question)) {
        add({ kind: 'percent_of_total', required: true, implementation: 'cte_or_window', measureField, orderBy, partitionBy, outputAlias: 'pct_of_total' });
    }

    if (requestsCumulativePercent) {
        add({
            kind: 'cumulative_percent',
            required: true,
            implementation: 'cte_or_window',
            measureField,
            orderBy: plan.sort[0]?.field || measureField,
            partitionBy,
            outputAlias: 'cumulative_pct',
        });
    }

    const buckets = bucketCountFromQuestion(question);
    if (buckets) {
        add({ kind: 'ntile', required: true, implementation: 'window', measureField, orderBy: plan.sort[0]?.field || measureField, partitionBy, buckets, outputAlias: buckets === 4 ? 'quartile' : buckets === 10 ? 'decile' : 'tile' });
    }

    return operations;
}

export function sqlImplementsAdvancedOperation(sql: string, operation: AdvancedAnalyticOperation): boolean {
    const hasWindow = /\bover\s*\(/i.test(sql);
    switch (operation.kind) {
        case 'running_total':
            return /\bsum\s*\([\s\S]*?\)\s*over\s*\(/i.test(sql)
                && /\brows\s+(?:between\s+)?unbounded\s+preceding\b/i.test(sql);
        case 'moving_average':
            return /\bavg\s*\([\s\S]*?\)\s*over\s*\(/i.test(sql)
                && /\brows\s+between\s+\d+\s+preceding\s+and\s+current\s+row\b/i.test(sql);
        case 'period_growth':
            return /\b(?:lag|lead)\s*\(/i.test(sql) && hasWindow;
        case 'partitioned_rank':
            return /\b(?:rank|dense_rank|row_number)\s*\(\s*\)\s*over\s*\(/i.test(sql)
                && /\bpartition\s+by\b/i.test(sql);
        case 'explicit_rank':
            return /\b(?:rank|dense_rank|row_number)\s*\(\s*\)\s*over\s*\(/i.test(sql);
        case 'percent_of_total': {
            const hasWindowDenominator = /\bsum\s*\([\s\S]*?\)\s*over\s*\(/i.test(sql);
            const hasSeparatePopulation = /^\s*with\b/i.test(sql) || (sql.match(/\bselect\b/gi) || []).length > 1;
            return hasWindowDenominator || hasSeparatePopulation;
        }
        case 'cumulative_percent': {
            const hasCumulativeNumerator = /\bsum\s*\([\s\S]*?\)\s*over\s*\([\s\S]*?\b(?:rows\s+(?:between\s+)?unbounded\s+preceding|order\s+by)\b/i.test(sql);
            const hasGrandTotalDenominator = /\bsum\s*\([\s\S]*?\)\s*over\s*\(\s*\)/i.test(sql);
            return hasCumulativeNumerator && hasGrandTotalDenominator;
        }
        case 'ntile':
            return /\bntile\s*\(/i.test(sql) && hasWindow;
        default:
            return false;
    }
}

export function advancedOperationRequirement(operation: AdvancedAnalyticOperation): string {
    switch (operation.kind) {
        case 'running_total':
            return `Calculate a cumulative running total${operation.orderBy ? ` ordered by "${operation.orderBy}"` : ''} using a window frame through the current row.`;
        case 'moving_average':
            return `Calculate the requested ${operation.windowSize || 3}-period moving average${operation.orderBy ? ` ordered by "${operation.orderBy}"` : ''} with an explicit ROWS window frame.`;
        case 'period_growth':
            return `Calculate period-over-period change with LAG/LEAD over the requested chronological grain${operation.partitionBy.length ? ` partitioned by ${operation.partitionBy.join(', ')}` : ''}.`;
        case 'partitioned_rank':
            return `Use a ranking window partitioned by ${operation.partitionBy.join(', ') || 'the requested parent grain'} so the requested top/bottom rows are selected independently within each group.`;
        case 'explicit_rank':
            return 'Expose the requested rank using RANK, DENSE_RANK, or ROW_NUMBER as appropriate for the requested tie semantics.';
        case 'percent_of_total':
            return 'Calculate each requested group contribution against an unfiltered grand-total denominator using a window total or an equivalent CTE/subquery.';
        case 'cumulative_percent':
            return `Calculate cumulative percentage of the requested measure in the requested order${operation.orderBy ? ` (${operation.orderBy})` : ''}: cumulative grouped measure divided by the grand total, multiplied by 100.`;
        case 'ntile':
            return `Assign the requested ${operation.buckets || ''} analytical buckets with NTILE.`;
        default:
            return 'Preserve the requested advanced analytical calculation.';
    }
}
