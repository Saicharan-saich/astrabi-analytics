import { describe, expect, it } from 'vitest';
import { inferRowGrain } from '../services/rowGrainInference';
import { ColumnType, type ColumnDefinition } from '../types';

const column = (name: string, type = ColumnType.DIMENSION): ColumnDefinition => ({
    name,
    type,
    originalType: type === ColumnType.METRIC ? 'number' : 'string',
});

describe('row grain inference', () => {
    it('prefers a unique row identifier over repeated foreign keys', () => {
        const rows = [
            { summary_id: 'S1', period_id: 'FY24', value_usd_bn: 10 },
            { summary_id: 'S2', period_id: 'FY24', value_usd_bn: 12 },
            { summary_id: 'S3', period_id: 'FY25', value_usd_bn: 14 },
        ];
        const result = inferRowGrain(rows, [
            column('summary_id', ColumnType.ID),
            column('period_id', ColumnType.ID),
            column('value_usd_bn', ColumnType.METRIC),
        ], 'Fact_Trade_Summary');

        expect(result.label).toBe('Trade Summary');
        expect(result.source).toBe('unique_identifier');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('does not require row values to provide a safe metadata fallback', () => {
        const result = inferRowGrain([], [column('amount', ColumnType.METRIC)], 'Fact_Service_Trade.xlsx', 'Finance');
        expect(result.label).toBe('Service Trade record');
        expect(result.source).toBe('table_name');
    });

    it('uses a neutral domain record when neither an identifier nor useful table name exists', () => {
        const result = inferRowGrain([], [column('amount', ColumnType.METRIC)], 'data.xlsx', 'Finance');
        expect(result.label).toBe('Finance record');
        expect(result.source).toBe('fallback');
    });
});
