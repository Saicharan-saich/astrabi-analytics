import { describe, it, expect } from 'vitest';
import { applyTableCalculation, getCalculationDisplayName, getCalculationDescription, applyMultipleCalculations } from '../utils/tableCalculations';

// Helper to create test data
const makeData = (values: number[], xKey = 'category') =>
    values.map((v, i) => ({ [xKey]: `Cat${i + 1}`, value: v }));

describe('Table Calculations', () => {

    describe('percent_of_total', () => {
        it('computes correct percentages', () => {
            const data = makeData([10, 20, 30, 40]);
            const { transformedData } = applyTableCalculation(data, 'value', 'percent_of_total', 'Sales');
            expect(transformedData[0].value).toBeCloseTo(10);
            expect(transformedData[1].value).toBeCloseTo(20);
            expect(transformedData[2].value).toBeCloseTo(30);
            expect(transformedData[3].value).toBeCloseTo(40);
        });

        it('handles all zeros without NaN', () => {
            const data = makeData([0, 0, 0]);
            const { transformedData } = applyTableCalculation(data, 'value', 'percent_of_total', 'Sales');
            transformedData.forEach(row => {
                expect(row.value).toBe(0);
                expect(Number.isNaN(row.value)).toBe(false);
            });
        });
    });

    describe('running_total', () => {
        it('computes cumulative sum', () => {
            const data = makeData([10, 20, 30]);
            const { transformedData } = applyTableCalculation(data, 'value', 'running_total', 'Sales');
            expect(transformedData[0].value).toBe(10);
            expect(transformedData[1].value).toBe(30);
            expect(transformedData[2].value).toBe(60);
        });

        it('handles negative values', () => {
            const data = makeData([10, -5, 20]);
            const { transformedData } = applyTableCalculation(data, 'value', 'running_total', 'Sales');
            expect(transformedData[0].value).toBe(10);
            expect(transformedData[1].value).toBe(5);
            expect(transformedData[2].value).toBe(25);
        });
    });

    describe('rank_desc', () => {
        it('ranks highest first', () => {
            const data = makeData([30, 10, 20]);
            const { transformedData } = applyTableCalculation(data, 'value', 'rank_desc', 'Sales');
            expect(transformedData[0].value).toBe(1); // 30 is highest
            expect(transformedData[1].value).toBe(3); // 10 is lowest
            expect(transformedData[2].value).toBe(2); // 20 is middle
        });
    });

    describe('rank_asc', () => {
        it('ranks lowest first', () => {
            const data = makeData([30, 10, 20]);
            const { transformedData } = applyTableCalculation(data, 'value', 'rank_asc', 'Sales');
            expect(transformedData[0].value).toBe(3); // 30 is highest
            expect(transformedData[1].value).toBe(1); // 10 is lowest
            expect(transformedData[2].value).toBe(2); // 20 is middle
        });
    });

    describe('moving_avg', () => {
        it('computes 3-period moving average', () => {
            const data = makeData([10, 20, 30, 40, 50]);
            const { transformedData } = applyTableCalculation(data, 'value', 'moving_avg', 'Sales', 'raw', undefined, 3);
            expect(transformedData[0].value).toBe(10);        // only 1 value
            expect(transformedData[1].value).toBe(15);        // avg(10, 20)
            expect(transformedData[2].value).toBeCloseTo(20); // avg(10, 20, 30)
            expect(transformedData[3].value).toBeCloseTo(30); // avg(20, 30, 40)
            expect(transformedData[4].value).toBeCloseTo(40); // avg(30, 40, 50)
        });
    });

    describe('diff_from_prev', () => {
        it('computes absolute differences', () => {
            const data = makeData([10, 25, 20]);
            const { transformedData } = applyTableCalculation(data, 'value', 'diff_from_prev', 'Sales');
            expect(transformedData[0].value).toBe(0);  // first row always 0
            expect(transformedData[1].value).toBe(15);
            expect(transformedData[2].value).toBe(-5);
        });
    });

    describe('pct_diff_from_prev', () => {
        it('computes percentage changes', () => {
            const data = makeData([100, 150, 120]);
            const { transformedData } = applyTableCalculation(data, 'value', 'pct_diff_from_prev', 'Sales');
            expect(transformedData[0].value).toBe(0);
            expect(transformedData[1].value).toBeCloseTo(50);  // +50%
            expect(transformedData[2].value).toBeCloseTo(-20); // -20%
        });

        it('handles zero previous value without NaN', () => {
            const data = makeData([0, 10]);
            const { transformedData } = applyTableCalculation(data, 'value', 'pct_diff_from_prev', 'Sales');
            expect(transformedData[1].value).toBe(0); // can't divide by 0
            expect(Number.isNaN(transformedData[1].value)).toBe(false);
        });
    });

    describe('percentile', () => {
        it('assigns percentile ranks', () => {
            const data = makeData([10, 20, 30, 40]);
            const { transformedData } = applyTableCalculation(data, 'value', 'percentile', 'Sales');
            expect(transformedData[0].value).toBeCloseTo(25);
            expect(transformedData[3].value).toBeCloseTo(100);
        });
    });

    describe('edge cases', () => {
        it('returns data unchanged for "none" calculation', () => {
            const data = makeData([1, 2, 3]);
            const { transformedData } = applyTableCalculation(data, 'value', 'none', 'Sales');
            expect(transformedData).toEqual(data);
        });

        it('handles empty data array', () => {
            const { transformedData } = applyTableCalculation([], 'value', 'running_total', 'Sales');
            expect(transformedData).toEqual([]);
        });

        it('handles single row', () => {
            const data = makeData([42]);
            const { transformedData } = applyTableCalculation(data, 'value', 'running_total', 'Sales');
            expect(transformedData[0].value).toBe(42);
        });
    });

    describe('display helpers', () => {
        it('returns display names for all calculation types', () => {
            expect(getCalculationDisplayName('running_total')).toBe('Running Total');
            expect(getCalculationDisplayName('percent_of_total')).toBe('% of Total');
            expect(getCalculationDisplayName('none')).toBe('None (Raw Values)');
        });

        it('returns descriptions for all calculation types', () => {
            expect(getCalculationDescription('running_total')).toContain('cumulative');
        });
    });

    describe('applyMultipleCalculations', () => {
        it('applies multiple calculations with separate output columns', () => {
            const data = makeData([10, 20, 30]);
            const { transformedData, columns } = applyMultipleCalculations(
                data, 'value', ['running_total', 'percent_of_total'], 'Sales'
            );
            expect(columns.length).toBe(2);
            expect(columns[0].key).toBe('calc_running_total');
            expect(columns[1].key).toBe('calc_percent_of_total');
            // Original value key should still exist
            expect(transformedData[0].value).toBe(10);
            // Calculated columns should exist
            expect(transformedData[2].calc_running_total).toBe(60);
        });

        it('filters out "none" calculations', () => {
            const data = makeData([10, 20]);
            const { columns } = applyMultipleCalculations(data, 'value', ['none'], 'Sales');
            expect(columns.length).toBe(0);
        });
    });
});
