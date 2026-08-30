import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import {
    getAISQLSemanticRevision,
    resolveAISQLSemanticModel,
} from '../services/ai-sql/semanticLayer';

function dataset(overrides: Partial<Dataset> = {}): Dataset {
    return {
        id: 'sales-1',
        name: 'sales.csv',
        rows: [
            { city: 'London', amount: 10, order_date: '2026-01-01' },
            { city: 'Leeds', amount: 20, order_date: '2026-01-02' },
            { city: 'London', amount: 30, order_date: '2026-01-03' },
        ],
        columns: [
            { name: 'city', type: ColumnType.DIMENSION, originalType: 'string' },
            { name: 'amount', type: ColumnType.METRIC, originalType: 'number' },
            { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
        ],
        totalRows: 3,
        etlLogs: [],
        version: 1,
        timeContext: {
            minDate: '2026-01-01',
            maxDate: '2026-01-03',
            defaultAnchorDate: '2026-01-03',
            anchorDateColumn: 'order_date',
            dateColumnMaxDates: { order_date: '2026-01-03' },
        },
        ...overrides,
    };
}

describe('revisioned AI SQL semantic snapshots', () => {
    it('builds once and reuses the attached upload-time snapshot', () => {
        const source = dataset();

        const first = resolveAISQLSemanticModel(source);
        const second = resolveAISQLSemanticModel(source);

        expect(first.reused).toBe(false);
        expect(second.reused).toBe(true);
        expect(second.model).toBe(first.model);
        expect(source.aiSqlSemanticRevision).toBe(first.revision);
        expect(first.model.revision).toBe(first.revision);
    });

    it('reuses a snapshot after IndexedDB-style serialization', () => {
        const source = dataset();
        const first = resolveAISQLSemanticModel(source);
        const restored = JSON.parse(JSON.stringify(source)) as Dataset;

        const second = resolveAISQLSemanticModel(restored);

        expect(second.reused).toBe(true);
        expect(second.revision).toBe(first.revision);
    });

    it('invalidates the snapshot when the cleaned dataset version changes', () => {
        const source = dataset();
        const first = resolveAISQLSemanticModel(source);
        source.version = 2;

        const second = resolveAISQLSemanticModel(source);

        expect(second.reused).toBe(false);
        expect(second.revision).not.toBe(first.revision);
        expect(second.model).not.toBe(first.model);
    });

    it('invalidates the snapshot when schema metadata changes', () => {
        const source = dataset();
        const before = getAISQLSemanticRevision(source);
        source.columns[1] = {
            ...source.columns[1],
            type: ColumnType.DIMENSION,
        };

        expect(getAISQLSemanticRevision(source)).not.toBe(before);
    });
});
