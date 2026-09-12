import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/analysisEngine', () => ({
    parseCSV: vi.fn(), parseExcelMultiSheet: vi.fn(),
    // Deliberately destructive legacy ETL: relational output must preserve data.
    runAutomatedETL: () => ({ rows: [], columns: [], logs: [] }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('relational import worker', () => {
    it('preserves source multiplicity and all sheets through the worker boundary', async () => {
        const postMessage = vi.fn();
        const worker: any = { postMessage };
        vi.stubGlobal('self', worker);
        await import('../workers/etl.worker');
        const fact = [{ period_id: 'P1', value: 4 }, { period_id: 'P1', value: 4 }];
        await worker.onmessage({ data: { type: 'PROCESS_FILE', isConnector: true, rawData: { Dim_Period: [{ period_id: 'P1', label: '2025' }], Fact_Trade: fact } } });
        const message = postMessage.mock.calls[0][0];
        expect(message.type).toBe('SUCCESS');
        expect(message.result.rows).toHaveLength(2);
        expect(message.result.subjectTable).toBe('Fact_Trade');
        expect(message.result.relatedTables).toHaveLength(2);
        expect(message.result.columns.map((c: any) => c.name)).toContain('period_id → Dim_Period.label');
    });
    it('fails a duplicate declared lookup instead of overwriting records', async () => {
        const postMessage = vi.fn();
        const worker: any = { postMessage };
        vi.stubGlobal('self', worker);
        await import('../workers/etl.worker');
        await worker.onmessage({ data: {
            type: 'PROCESS_FILE', isConnector: true,
            rawData: { Fact_Trade: [{ period_id: 'P1', value: 1 }], Dim_Period: [{ period_id: 'P1' }, { period_id: 'P1' }] },
            joinEdges: [{ leftTable: 'Fact_Trade', leftColumn: 'period_id', rightTable: 'Dim_Period', rightColumn: 'period_id', type: 'fk' }],
        } });
        expect(postMessage.mock.calls[0][0]).toMatchObject({ type: 'ERROR', error: expect.stringContaining('Duplicate lookup key') });
    });
    it('keeps declared database column metadata alongside all fetched columns', async () => {
        const postMessage = vi.fn();
        const worker: any = { postMessage };
        vi.stubGlobal('self', worker);
        await import('../workers/etl.worker');
        await worker.onmessage({ data: {
            type: 'PROCESS_FILE', isConnector: true,
            rawData: { Fact_Trade: [{ trade_id: 'T1', period_id: 'P1', value: 10 }], Dim_Period: [{ period_id: 'P1', label: '2025' }] },
            sourceSchema: { tables: [{ name: 'Fact_Trade', columns: [{ name: 'trade_id', dataType: 'uuid', isPK: true, isNullable: false }] }],
                joinEdges: [{ leftTable: 'Fact_Trade', leftColumn: 'period_id', rightTable: 'Dim_Period', rightColumn: 'period_id', type: 'fk' }] },
        } });
        const result = postMessage.mock.calls[0][0].result;
        expect(result.sourceSchema.tables.find((t: any) => t.name === 'Fact_Trade').columns).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'trade_id', dataType: 'uuid', isPK: true }),
            expect.objectContaining({ name: 'value' }),
        ]));
    });
});
