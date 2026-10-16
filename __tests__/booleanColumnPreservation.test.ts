import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { runETLPipeline } from '../services/etlPipeline';
import { questionBuilderColumns } from '../services/questionBuilderColumns';
import { buildSemanticModel } from '../services/semanticModel';

const raw = [
    { 'Order ID': 'A-1', Returned: 'Yes', Region: 'North', Status: 'Active', 'Sales Amount': 120 },
    { 'Order ID': 'A-2', Returned: 'No', Region: 'South', Status: 'Inactive', 'Sales Amount': 80 },
    { 'Order ID': 'A-3', Returned: 'No', Region: 'North', Status: 'Active', 'Sales Amount': 40 },
];

describe('uploaded boolean flags', () => {
    it('keeps original Yes/No values while classifying the column as boolean', () => {
        const result = runETLPipeline(raw, 'retail.xlsx');
        expect(result.columns.find(column => column.name === 'returned')?.type).toBe(ColumnType.BOOLEAN);
        expect(result.rows.map(row => row.returned)).toEqual(['Yes', 'No', 'No']);
        expect(result.columns.find(column => column.name === 'returned')?.conversion).toMatchObject({
            normalizedType: 'string', convertedCount: 0, invalidCount: 0,
        });
        expect(raw.map(row => row.Returned)).toEqual(['Yes', 'No', 'No']);
    });

    it('does not turn a return flag into values from region or status when its role changes', () => {
        const asDimension = runETLPipeline(raw, 'retail.xlsx', { returned: ColumnType.DIMENSION });
        const backToBoolean = runETLPipeline(raw, 'retail.xlsx', { returned: ColumnType.BOOLEAN });
        expect(asDimension.rows.map(row => row.returned)).toEqual(['Yes', 'No', 'No']);
        expect(backToBoolean.rows.map(row => row.returned)).toEqual(['Yes', 'No', 'No']);
        expect(asDimension.rows.every(row => row.returned !== 'North' && row.returned !== 'Active')).toBe(true);
    });

    it('keeps boolean-coded dimension labels in their source casing', () => {
        const mixedCase = [{ Returned: 'yes' }, { Returned: 'NO' }, { Returned: 'Y' }];
        const asDimension = runETLPipeline(mixedCase, 'retail.xlsx', { returned: ColumnType.DIMENSION });
        expect(asDimension.rows.map(row => row.returned)).toEqual(['yes', 'NO', 'Y']);
    });

    it('preserves native boolean values rather than converting them into strings', () => {
        const result = runETLPipeline([
            { returned: true, sales: 10 }, { returned: false, sales: 20 },
        ], 'native.csv');
        expect(result.columns.find(column => column.name === 'returned')?.type).toBe(ColumnType.BOOLEAN);
        expect(result.rows.map(row => row.returned)).toEqual([true, false]);
    });

    it('exposes every uploaded field, including AI-hidden boolean flags, in the Builder', () => {
        const result = runETLPipeline(raw, 'retail.xlsx');
        const dataset = {
            columns: result.columns,
            rows: result.rows,
            domainProfile: { columnSemantics: { returned: { isHidden: true } } },
        } as unknown as Dataset;
        const options = questionBuilderColumns(dataset);
        expect(options.dimensions).toContain('returned');
        expect(options.countable).toContain('returned');
        expect(options.metrics).toContain('sales_amount');
        expect(buildSemanticModel({ ...dataset, domainProfile: undefined }).dimensions.map(d => d.column)).toContain('returned');
    });
});
