import type { Dataset } from '../types';

function numericValue(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number'
        ? value
        : Number(String(value).replace(/[$€£¥,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Repair the original Profit Margin % template, which combined unit_price
 * with line-level cost_amount and stored a misleading percentage in IndexedDB.
 * Only materialised columns bearing that legacy template label are migrated.
 */
export function repairLegacyProfitMarginDataset(dataset: Dataset): Dataset {
    const margin = dataset.columns.find(column =>
        column.name.toLowerCase() === 'profit_margin_pct'
        && (column as any).semanticRole === 'derived_metric'
        && /profit margin/i.test(String((column as any).label || ''))
        && !column.derivedFormulaVersion
    );
    if (!margin) return dataset;

    const names = new Map(dataset.columns.map(column => [column.name.toLowerCase(), column.name]));
    const profit = names.get('profit');
    const revenue = ['sales_amount', 'revenue', 'sales', 'total_sales', 'revenue_amount']
        .map(name => names.get(name)).find(Boolean);
    if (!profit || !revenue) return dataset;

    const rows = dataset.rows.map(row => {
        const numerator = numericValue(row[profit]);
        const denominator = numericValue(row[revenue]);
        return {
            ...row,
            [margin.name]: numerator !== null && denominator !== null && denominator !== 0
                ? numerator / denominator * 100
                : null,
        };
    });
    const columns = dataset.columns.map(column => column === margin ? {
        ...column,
        derivedTemplateId: 'profit_margin_pct',
        derivedFormulaVersion: 2,
        derivedInputColumns: { profit, revenue },
    } : column);
    const semanticModel = dataset.semanticModel ? {
        ...dataset.semanticModel,
        measures: dataset.semanticModel.measures.map(measure =>
            measure.column.toLowerCase() === margin.name.toLowerCase() ? {
                ...measure,
                aggregation: 'AVG' as typeof measure.aggregation,
                behavior: 'non_additive' as const,
                format: 'percent' as const,
                requiresWeighting: true,
                weightColumn: revenue,
            } : measure
        ),
    } : undefined;
    return {
        ...dataset,
        rows,
        columns,
        ...(semanticModel ? { semanticModel } : {}),
        version: (dataset.version || 1) + 1,
    };
}
