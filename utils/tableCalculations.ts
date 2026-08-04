export type TableCalculation =
    | 'none'
    | 'percent_of_total'
    | 'rank_asc'
    | 'rank_desc'
    | 'running_total'
    | 'moving_avg'
    | 'pct_diff_from_prev'
    | 'diff_from_prev'
    | 'percentile'
    | 'std_dev'
    | 'z_score'
    | 'variance'
    | 'linear_forecast';

export interface TableCalculationComparison {
    /**
     * Previous uses the current chart result order. Selected value applies one
     * category's value as the baseline for every visible row.
     */
    mode: 'previous' | 'selected_value';
    referenceValue?: string;
    /** Supplied by the chart so the utility can resolve the selected category. */
    dimensionKey?: string;
}

export interface CalculationResult {
    transformedData: any[];
    yLabel: string;
    suggestedNumberFormat: 'raw' | 'currency_usd' | 'currency_eur' | 'percent' | 'compact';
}

/**
 * Apply a table calculation to transform chart data
 */
export function applyTableCalculation(
    data: any[],
    yKey: string,
    calculation: TableCalculation,
    originalYLabel: string,
    originalNumberFormat: string = 'raw',
    outputKey?: string,
    movingAvgWindow: number = 3,
    comparison?: TableCalculationComparison
): CalculationResult {

    if (!data || data.length === 0 || calculation === 'none') {
        return {
            transformedData: data,
            yLabel: originalYLabel,
            suggestedNumberFormat: originalNumberFormat as any
        };
    }

    let transformedData: any[];
    let yLabel: string;
    let suggestedNumberFormat: 'raw' | 'currency_usd' | 'currency_eur' | 'percent' | 'compact';

    const targetKey = outputKey || yKey;
    const referenceRow = comparison?.mode === 'selected_value' && comparison.dimensionKey && comparison.referenceValue !== undefined
        ? data.find(row => String(row[comparison.dimensionKey!]) === String(comparison.referenceValue))
        : undefined;
    const referenceBaseline = referenceRow ? Number(referenceRow[yKey]) || 0 : undefined;
    const hasSelectedBaseline = referenceBaseline !== undefined;
    const selectedBaselineLabel = comparison?.referenceValue || 'selected value';

    switch (calculation) {
        case 'percent_of_total': {
            const total = data.reduce((sum, row) => sum + (Number(row[yKey]) || 0), 0);
            transformedData = data.map(row => ({
                ...row,
                [targetKey]: total !== 0 ? (Number(row[yKey]) / total) * 100 : 0
            }));
            yLabel = `% of Total (${originalYLabel})`;
            suggestedNumberFormat = 'percent';
            break;
        }

        case 'rank_asc': {
            // Build rank map using original indices to survive object cloning
            const indexed = data.map((row, i) => ({ i, v: Number(row[yKey]) || 0 }));
            indexed.sort((a, b) => a.v - b.v);
            const rankMap = new Map<number, number>();
            indexed.forEach((item, rank) => rankMap.set(item.i, rank + 1));
            transformedData = data.map((row, i) => ({
                ...row,
                [targetKey]: rankMap.get(i) || 0
            }));
            yLabel = `Rank (Ascending) of ${originalYLabel}`;
            suggestedNumberFormat = 'raw';
            break;
        }

        case 'rank_desc': {
            const indexed = data.map((row, i) => ({ i, v: Number(row[yKey]) || 0 }));
            indexed.sort((a, b) => b.v - a.v);
            const rankMap = new Map<number, number>();
            indexed.forEach((item, rank) => rankMap.set(item.i, rank + 1));
            transformedData = data.map((row, i) => ({
                ...row,
                [targetKey]: rankMap.get(i) || 0
            }));
            yLabel = `Rank (Descending) of ${originalYLabel}`;
            suggestedNumberFormat = 'raw';
            break;
        }

        case 'running_total': {
            let cumulative = 0;
            transformedData = data.map(row => {
                cumulative += Number(row[yKey]) || 0;
                return { ...row, [targetKey]: cumulative };
            });
            yLabel = `Running Total of ${originalYLabel}`;
            suggestedNumberFormat = originalNumberFormat as any;
            break;
        }

        case 'moving_avg': {
            const w = Math.max(1, movingAvgWindow); // Ensure at least 1
            transformedData = data.map((row, idx) => {
                const start = Math.max(0, idx - (w - 1));
                const window = data.slice(start, idx + 1);
                const avg = window.reduce((s, r) => s + (Number(r[yKey]) || 0), 0) / window.length;
                return { ...row, [targetKey]: avg };
            });
            yLabel = `${w}-Period Moving Avg of ${originalYLabel}`;
            suggestedNumberFormat = originalNumberFormat as any;
            break;
        }

        case 'pct_diff_from_prev': {
            transformedData = data.map((row, idx) => {
                if (!hasSelectedBaseline && idx === 0) {
                    return { ...row, [targetKey]: 0 };
                }
                const current = Number(row[yKey]) || 0;
                const baseline = hasSelectedBaseline
                    ? referenceBaseline!
                    : Number(data[idx - 1][yKey]) || 0;
                const pctChange = baseline !== 0 ? ((current - baseline) / baseline) * 100 : 0;
                return { ...row, [targetKey]: pctChange };
            });
            yLabel = hasSelectedBaseline
                ? `% Change vs ${selectedBaselineLabel} (${originalYLabel})`
                : `% Change from Previous (${originalYLabel})`;
            suggestedNumberFormat = 'percent';
            break;
        }

        case 'diff_from_prev': {
            transformedData = data.map((row, idx) => {
                if (!hasSelectedBaseline && idx === 0) {
                    return { ...row, [targetKey]: 0 };
                }
                const current = Number(row[yKey]) || 0;
                const baseline = hasSelectedBaseline
                    ? referenceBaseline!
                    : Number(data[idx - 1][yKey]) || 0;
                return { ...row, [targetKey]: current - baseline };
            });
            yLabel = hasSelectedBaseline
                ? `Difference vs ${selectedBaselineLabel} (${originalYLabel})`
                : `Difference from Previous (${originalYLabel})`;
            suggestedNumberFormat = originalNumberFormat as any;
            break;
        }

        case 'percentile': {
            const sorted = data.map(row => Number(row[yKey]) || 0).sort((a, b) => a - b);
            transformedData = data.map(row => {
                const value = Number(row[yKey]) || 0;
                const rank = sorted.filter(v => v <= value).length;
                const percentile = (rank / sorted.length) * 100;
                return { ...row, [targetKey]: percentile };
            });
            yLabel = `Percentile of ${originalYLabel}`;
            suggestedNumberFormat = 'percent';
            break;
        }

        case 'std_dev': {
            const values = data.map(row => Number(row[yKey]) || 0);
            const mean = values.reduce((s, v) => s + v, 0) / values.length;
            const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
            const stdDev = Math.sqrt(variance);
            transformedData = data.map(row => {
                const value = Number(row[yKey]) || 0;
                const deviations = (value - mean) / (stdDev || 1);
                return { ...row, [targetKey]: Number(deviations.toFixed(3)) };
            });
            yLabel = `Std Deviations from Mean (${originalYLabel})`;
            suggestedNumberFormat = 'raw';
            break;
        }

        case 'z_score': {
            const vals = data.map(row => Number(row[yKey]) || 0);
            const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
            const sigma = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length);
            transformedData = data.map(row => {
                const value = Number(row[yKey]) || 0;
                return { ...row, [targetKey]: sigma !== 0 ? Number(((value - mu) / sigma).toFixed(3)) : 0 };
            });
            yLabel = `Z-Score of ${originalYLabel}`;
            suggestedNumberFormat = 'raw';
            break;
        }

        case 'variance': {
            const valsV = data.map(row => Number(row[yKey]) || 0);
            const meanV = valsV.reduce((s, v) => s + v, 0) / valsV.length;
            transformedData = data.map(row => {
                const value = Number(row[yKey]) || 0;
                return { ...row, [targetKey]: Number(((value - meanV) ** 2).toFixed(2)) };
            });
            yLabel = `Variance of ${originalYLabel}`;
            suggestedNumberFormat = 'raw';
            break;
        }

        case 'linear_forecast': {
            // Linear regression: y = mx + b
            const n = data.length;
            const xs = data.map((_, i) => i);
            const ys = data.map(row => Number(row[yKey]) || 0);
            const sumX = xs.reduce((s, x) => s + x, 0);
            const sumY = ys.reduce((s, y) => s + y, 0);
            const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
            const sumXX = xs.reduce((s, x) => s + x * x, 0);
            const m = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);
            const b = (sumY - m * sumX) / n;

            transformedData = data.map((row, i) => ({
                ...row,
                [targetKey]: Number((m * i + b).toFixed(2)),
            }));
            yLabel = `Trend Line (${originalYLabel})`;
            suggestedNumberFormat = originalNumberFormat as any;
            break;
        }

        default:
            transformedData = data;
            yLabel = originalYLabel;
            suggestedNumberFormat = originalNumberFormat as any;
    }

    return {
        transformedData,
        yLabel,
        suggestedNumberFormat
    };
}

/**
 * Get display name for a table calculation
 */
export function getCalculationDisplayName(calculation: TableCalculation): string {
    const names: Record<TableCalculation, string> = {
        'none': 'None (Raw Values)',
        'percent_of_total': '% of Total',
        'rank_asc': 'Rank (Ascending)',
        'rank_desc': 'Rank (Descending)',
        'running_total': 'Running Total',
        'moving_avg': 'Moving Average',
        'pct_diff_from_prev': '% Difference from Previous',
        'diff_from_prev': 'Difference from Previous',
        'percentile': 'Percentile',
        'std_dev': 'Standard Deviation',
        'z_score': 'Z-Score',
        'variance': 'Variance',
        'linear_forecast': 'Trend Line (Forecast)',
    };
    return names[calculation] || 'Unknown';
}

/**
 * Get description for a table calculation
 */
export function getCalculationDescription(calculation: TableCalculation): string {
    const descriptions: Record<TableCalculation, string> = {
        'none': 'Show raw values without transformation',
        'percent_of_total': 'Show each value as % of grand total',
        'rank_asc': 'Show position from lowest to highest',
        'rank_desc': 'Show position from highest to lowest',
        'running_total': 'Show cumulative sum over time',
        'moving_avg': 'Smooth values with N-period average',
        'pct_diff_from_prev': 'Show % change from previous value',
        'diff_from_prev': 'Show absolute change from previous value',
        'percentile': 'Show statistical percentile ranking',
        'std_dev': 'Distance from mean in standard deviations',
        'z_score': 'Normalized distance from mean (µ=0, σ=1)',
        'variance': 'Squared deviation from the mean',
        'linear_forecast': 'Linear regression trend line overlay',
    };
    return descriptions[calculation] || '';
}

/**
 * Column metadata returned by applyMultipleCalculations
 */
export interface CalculatedColumn {
    key: string;           // e.g., 'calc_percent_of_total'
    label: string;         // e.g., '% of Total (Sales)'
    format: string;        // e.g., 'percent'
    calculation: TableCalculation;
}

/**
 * Apply multiple table calculations, each producing a separate output column.
 * The original yKey column is preserved untouched.
 */
export function applyMultipleCalculations(
    data: any[],
    yKey: string,
    calculations: TableCalculation[],
    originalYLabel: string,
    originalNumberFormat: string = 'raw',
    movingAvgWindow: number = 3
): { transformedData: any[]; columns: CalculatedColumn[] } {
    // Filter out 'none'
    const activeCalcs = calculations.filter(c => c !== 'none');

    if (!data || data.length === 0 || activeCalcs.length === 0) {
        return { transformedData: data, columns: [] };
    }

    let mergedData = data.map(row => ({ ...row }));
    const columns: CalculatedColumn[] = [];

    for (const calc of activeCalcs) {
        const outputKey = `calc_${calc}`;
        const { transformedData: calcData, yLabel, suggestedNumberFormat } = applyTableCalculation(
            mergedData,
            yKey,
            calc,
            originalYLabel,
            originalNumberFormat,
            outputKey,
            movingAvgWindow
        );

        // Merge the calculated column into mergedData
        mergedData = calcData;

        columns.push({
            key: outputKey,
            label: yLabel,
            format: suggestedNumberFormat,
            calculation: calc,
        });
    }

    return { transformedData: mergedData, columns };
}
