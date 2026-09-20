import { describe, expect, it } from 'vitest';
import { ColumnType } from '../types';
import { runETLPipeline } from '../services/etlPipeline';
import { normalizeRelatedTables } from '../services/relationalNormalization';
import { buildRelationalCatalog, materializeSubject } from '../services/relationalCatalog';

describe('authoritative datatype normalization', () => {
    it('records physical conversion evidence separately from analytical role', () => {
        const result = runETLPipeline([
            { sale_id: '001', amount_gbp: '£1,200.50', sale_date: '2025-01-02' },
            { sale_id: '002', amount_gbp: '£300.25', sale_date: '2025-02-03' },
        ], 'sales.xlsx');

        const amount = result.columns.find(column => column.name === 'amount_gbp')!;
        expect(amount.type).toBe(ColumnType.METRIC);
        expect(amount.originalType).toBe('string');
        expect(amount.physicalType).toBe('number');
        expect(amount.conversion?.normalizedType).toBe('number');
        expect(amount.conversion?.parseSuccessRate).toBe(1);
        expect(amount.conversion?.convertedCount).toBe(2);
        expect(result.rows.map(row => row.amount_gbp)).toEqual([1200.5, 300.25]);
    });

    it('normalizes every sheet before relationship discovery and materialization', () => {
        const raw = [
            {
                name: 'Fact_Sales',
                rows: [
                    { sale_id: '1', category_id: '10', amount: '£1,200.50' },
                    { sale_id: '2', category_id: '20', amount: '£300.25' },
                ],
            },
            {
                name: 'Dim_Category',
                rows: [
                    { category_id: '10', category_name: 'Hardware' },
                    { category_id: '20', category_name: 'Services' },
                ],
            },
        ];

        const normalized = normalizeRelatedTables(raw, 'relational.xlsx');
        const fact = normalized.tables.find(table => table.name === 'Fact_Sales')!;
        expect(fact.rows.map(row => row.amount)).toEqual([1200.5, 300.25]);
        expect(fact.columnDefinitions?.find(column => column.name === 'amount')?.physicalType).toBe('number');

        const catalog = buildRelationalCatalog(normalized.tables);
        const amountSchema = catalog.schema.tables
            .find(table => table.name === 'Fact_Sales')!
            .columns.find(column => column.name === 'amount')!;
        expect(amountSchema.dataType).toBe('numeric');
        expect(amountSchema.sourceDataType).toBe('string');
        expect(amountSchema.normalizedDataType).toBe('number');
        expect(amountSchema.parseSuccessRate).toBe(1);

        const subject = materializeSubject(normalized.tables, catalog, 'Fact_Sales');
        expect(subject.rows.map(row => row.amount)).toEqual([1200.5, 300.25]);
    });

    it('physically recasts a column when its analytical role is overridden', () => {
        const result = runETLPipeline(
            [{ custom_value: '10.5' }, { custom_value: '20.25' }],
            'override.csv',
            { custom_value: ColumnType.METRIC },
        );
        expect(result.rows.map(row => row.custom_value)).toEqual([10.5, 20.25]);
        expect(result.columns[0].type).toBe(ColumnType.METRIC);
        expect(result.columns[0].physicalType).toBe('number');
    });
});
