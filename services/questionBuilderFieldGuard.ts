import type { Dataset } from '../types';

export interface ResolvedBuilderFields {
    metric: string;
    dimension: string;
    secondaryMetrics: string[];
    secondaryDimensions: string[];
}

const TIME_DIMENSIONS = new Set(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);

/**
 * Resolve builder fields against the physical uploaded schema. AI SQL result
 * presentation aliases such as Metric and Value must never become source
 * columns in a Question Builder query.
 */
export function resolvePhysicalBuilderFields(
    dataset: Dataset,
    fields: {
        metric: unknown;
        dimension?: unknown;
        secondaryMetrics?: unknown[];
        secondaryDimensions?: unknown[];
    },
): ResolvedBuilderFields | null {
    const physicalColumns = new Map(dataset.columns.map(column => [column.name.toLowerCase(), column.name]));
    const resolveColumn = (value: unknown): string | undefined => {
        if (typeof value !== 'string' || !value.trim()) return undefined;
        return physicalColumns.get(value.trim().toLowerCase());
    };

    const metric = resolveColumn(fields.metric);
    if (!metric) return null;

    const requestedDimension = typeof fields.dimension === 'string' ? fields.dimension.trim() : '';
    const dimension = TIME_DIMENSIONS.has(requestedDimension.toLowerCase())
        ? requestedDimension.toLowerCase()
        : resolveColumn(requestedDimension);
    if (requestedDimension && !dimension) return null;

    return {
        metric,
        dimension: dimension || '',
        secondaryMetrics: (fields.secondaryMetrics || [])
            .map(resolveColumn)
            .filter((field): field is string => Boolean(field)),
        secondaryDimensions: (fields.secondaryDimensions || [])
            .map(resolveColumn)
            .filter((field): field is string => Boolean(field)),
    };
}
