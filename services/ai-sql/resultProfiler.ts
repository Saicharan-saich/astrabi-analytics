/**
 * Result Profiler — Analyzes the shape of SQL query results
 *
 * Inspects row count, column count, metric/dimension split, cardinality,
 * time dimension detection, and scale mismatch between metrics.
 * This profile drives the deterministic chart recommendation.
 */

import { SemanticModel, AnalysisPlan, ResultProfile, SemanticType } from './types';

/**
 * Profile the result data to understand its shape for chart recommendation.
 */
export function profileResult(
    data: Record<string, any>[],
    plan: AnalysisPlan,
    model: SemanticModel
): ResultProfile {
    if (!data || data.length === 0) {
        return {
            rowCount: 0, columnCount: 0, metricCount: 0, dimensionCount: 0,
            dimensionColumns: [], metricColumns: [],
            dimensionCardinality: {}, hasTimeDimension: false,
            metricsScaleMismatch: 1, metricSemanticTypes: {},
            isPivoted: false, isSingleValue: false,
        };
    }

    const cols = Object.keys(data[0]);
    const fieldMap = new Map(model.fields.map(f => [f.name.toLowerCase(), f]));

    // Classify columns as metric or dimension
    const metricColumns: string[] = [];
    const dimensionColumns: string[] = [];
    const metricSemanticTypes: Record<string, SemanticType> = {};

    for (const col of cols) {
        const firstVal = data[0][col];
        const colLower = col.toLowerCase();

        // Skip computed growth/time-intel columns — these are handled separately by the chart recommender
        if (['previous_value', 'growth_pct', 'growth_abs', 'running_total', 'moving_avg'].includes(colLower)) {
            continue;
        }

        // Try to match to semantic model
        const field = fieldMap.get(colLower)
            || fieldMap.get(colLower.replace(/_sum$|_avg$|_count$|_min$|_max$/, ''));

        if (field) {
            if (field.role === 'metric') {
                metricColumns.push(col);
                metricSemanticTypes[col] = field.semanticType;
            } else {
                dimensionColumns.push(col);
            }
        } else if (typeof firstVal === 'number') {
            metricColumns.push(col);
            // Infer semantic type from column name
            if (colLower.includes('pct') || colLower.includes('percent') || colLower.includes('rate') || colLower.includes('margin')) {
                metricSemanticTypes[col] = 'percentage';
            } else if (colLower.includes('sales') || colLower.includes('revenue') || colLower.includes('cost') || colLower.includes('price') || colLower.includes('profit') || colLower.includes('amount')) {
                metricSemanticTypes[col] = 'currency';
            } else if (colLower.includes('count') || colLower.includes('qty') || colLower.includes('quantity')) {
                metricSemanticTypes[col] = 'count';
            } else {
                metricSemanticTypes[col] = 'quantity';
            }
        } else if (/_(sum|avg|count|min|max|pct|total)$/.test(colLower) || colLower.endsWith('_count_distinct')) {
            // Fallback: column name strongly suggests a metric (aggregated alias)
            // even if the first value is null/string (e.g., SUM on a mistyped column)
            metricColumns.push(col);
            if (colLower.includes('pct') || colLower.includes('margin')) {
                metricSemanticTypes[col] = 'percentage';
            } else {
                metricSemanticTypes[col] = 'currency';
            }
        } else {
            dimensionColumns.push(col);
        }
    }

    // Dimension cardinality
    const dimensionCardinality: Record<string, number> = {};
    for (const dim of dimensionColumns) {
        const unique = new Set(data.map(r => r[dim]));
        dimensionCardinality[dim] = unique.size;
    }

    // Detect time dimension
    let hasTimeDimension = false;
    let timeDimensionColumn: string | undefined;
    for (const dim of dimensionColumns) {
        const dimLower = dim.toLowerCase();
        if (dimLower.includes('date') || dimLower.includes('month') || dimLower.includes('year')
            || dimLower.includes('week') || dimLower.includes('quarter') || dimLower.includes('day')
            || dimLower.includes('period') || dimLower.includes('time')) {
            hasTimeDimension = true;
            timeDimensionColumn = dim;
            break;
        }
        // Also check if the plan declares a time grain on this dimension
        const planDim = plan.dimensions.find(d => d.field.toLowerCase() === dim.toLowerCase().replace(/_\w+$/, ''));
        if (planDim?.timeGrain) {
            hasTimeDimension = true;
            timeDimensionColumn = dim;
            break;
        }
    }

    // Scale mismatch between metrics
    let metricsScaleMismatch = 1;
    if (metricColumns.length >= 2) {
        const scales = metricColumns.map(col => {
            const vals = data.map(r => Math.abs(Number(r[col]) || 0)).filter(v => v > 0);
            return vals.length > 0 ? Math.max(...vals) : 0;
        }).filter(s => s > 0);

        if (scales.length >= 2) {
            metricsScaleMismatch = Math.max(...scales) / Math.min(...scales);
        }
    }

    // Detect pivoted data (single row with multiple metrics, no dimensions)
    const isPivoted = data.length === 1 && metricColumns.length > 1 && dimensionColumns.length === 0;

    // Detect single value
    const isSingleValue = data.length === 1 && cols.length === 1;

    return {
        rowCount: data.length,
        columnCount: cols.length,
        metricCount: metricColumns.length,
        dimensionCount: dimensionColumns.length,
        dimensionColumns,
        metricColumns,
        dimensionCardinality,
        hasTimeDimension,
        timeDimensionColumn,
        metricsScaleMismatch,
        metricSemanticTypes,
        isPivoted,
        isSingleValue,
    };
}
