import { describe, expect, it } from 'vitest';
import { applyTableCalculation } from './tableCalculations';

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
