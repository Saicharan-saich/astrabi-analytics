import { describe, expect, it } from 'vitest';
import { applyMultipleCalculations, applyTableCalculation } from './tableCalculations';

const shipModeSales = [
    { ship_mode: 'Standard Class', sales: 60000 },
    { ship_mode: 'Second Class', sales: 20000 },
    { ship_mode: 'First Class', sales: 15000 },
    { ship_mode: 'Same Day', sales: 5000 },
];

describe('analytics comparison baselines', () => {
    it('keeps previous-row comparisons tied to the current result order', () => {
        const result = applyTableCalculation(
            shipModeSales,
            'sales',
            'pct_diff_from_prev',
            'Sales',
            'currency_usd',
        );

        expect(result.transformedData.map(row => row.sales)).toEqual([
            0,
            -66.66666666666666,
            -25,
            -66.66666666666666,
        ]);
        expect(result.yLabel).toBe('% Change from Previous (Sales)');
    });

    it('compares every visible category with a selected baseline category', () => {
        const result = applyTableCalculation(
            shipModeSales,
            'sales',
            'pct_diff_from_prev',
            'Sales',
            'currency_usd',
            undefined,
            3,
            {
                mode: 'selected_value',
                dimensionKey: 'ship_mode',
                referenceValue: 'Standard Class',
            },
        );

        expect(result.transformedData.map(row => row.sales)).toEqual([
            0,
            -66.66666666666666,
            -75,
            -91.66666666666666,
        ]);
        expect(result.yLabel).toBe('% Change vs Standard Class (Sales)');
    });

    it('declares percentage and ranking outputs independently from the sales currency format', () => {
        const percentOfTotal = applyTableCalculation(
            shipModeSales,
            'sales',
            'percent_of_total',
            'Sales',
            'currency_usd',
        );
        const rank = applyTableCalculation(
            shipModeSales,
            'sales',
            'rank_desc',
            'Sales',
            'currency_usd',
        );

        expect(percentOfTotal.suggestedNumberFormat).toBe('percent');
        expect(rank.suggestedNumberFormat).toBe('raw');
    });

    it('uses the same selected baseline for absolute differences', () => {
        const result = applyTableCalculation(
            shipModeSales,
            'sales',
            'diff_from_prev',
            'Sales',
            'currency_usd',
            undefined,
            3,
            {
                mode: 'selected_value',
                dimensionKey: 'ship_mode',
                referenceValue: 'Standard Class',
            },
        );

        expect(result.transformedData.map(row => row.sales)).toEqual([0, -40000, -45000, -55000]);
        expect(result.yLabel).toBe('Difference vs Standard Class (Sales)');
    });

    it('uses the selected baseline in the calculated-table path used by Question Builder', () => {
        const result = applyMultipleCalculations(
            shipModeSales,
            'sales',
            ['diff_from_prev'],
            'Sales',
            'currency_usd',
            3,
            {
                mode: 'selected_value',
                dimensionKey: 'ship_mode',
                referenceValue: 'Standard Class',
            },
        );

        expect(result.columns[0].key).toBe('calc_diff_from_prev');
        expect(result.transformedData.map(row => row.calc_diff_from_prev)).toEqual([0, -40000, -45000, -55000]);
    });

    it('does not produce an infinite percentage when the selected baseline is zero', () => {
        const result = applyTableCalculation(
            [
                { ship_mode: 'Standard Class', sales: 0 },
                { ship_mode: 'Second Class', sales: 20000 },
            ],
            'sales',
            'pct_diff_from_prev',
            'Sales',
            'currency_usd',
            undefined,
            3,
            {
                mode: 'selected_value',
                dimensionKey: 'ship_mode',
                referenceValue: 'Standard Class',
            },
        );

        expect(result.transformedData.map(row => row.sales)).toEqual([0, 0]);
    });
});
