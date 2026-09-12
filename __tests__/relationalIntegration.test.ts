import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubjectDataset } from '../services/relationalCatalog';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { executeQueryPlan } from '../services/queryPlan/executeQueryPlan';
import { getDates } from '../services/dateHelpers';
import { createDuck } from './helpers/duckdbNode';
import { refreshLiveDataset } from '../services/liveRefreshService';
import { SqlGenerator } from '../services/SqlGenerator';

afterEach(() => vi.unstubAllGlobals());

describe('relational application integration', () => {
    it('executes role-qualified fields in DuckDB with the same result as Builder', async () => {
        const sources = [
            { name: 'Dim_Geography', rows: [{ geo_id: '01', country: 'India' }, { geo_id: '1', country: 'UK' }] },
            { name: 'Fact_Trade', rows: [
                { trade_id: 'T1', reporter_geo_id: '01', partner_geo_id: '1', value: 10 },
                { trade_id: 'T2', reporter_geo_id: '1', partner_geo_id: '01', value: 20 },
            ] },
        ];
        const subject = createSubjectDataset({ id: 'test', name: 'test', rows: [], columns: [], totalRows: 0, etlLogs: [], sourceTables: sources }, 'Fact_Trade');
        const field = 'partner_geo_id → Dim_Geography.country';
        const plan = buildQueryPlan({ metric: 'value', aggregation: 'SUM', dimension: field }, '', getDates('2025-12-31'), 'data');
        const duck = await createDuck();
        try {
            duck.loadTable('data', subject.rows);
            const sqlRows = duck.query(compileSQL(plan)).map(r => ({ country: r[field], value: Number(r.sum_value) })).sort((a, b) => a.country.localeCompare(b.country));
            const builderRows = executeQueryPlan(plan, subject.rows).data.map(r => ({ country: r[field], value: Number(r.sum_value) })).sort((a, b) => a.country.localeCompare(b.country));
            expect(sqlRows).toEqual(builderRows);
            expect(sqlRows).toEqual([{ country: 'India', value: 20 }, { country: 'UK', value: 10 }]);
            const legacySQL = new SqlGenerator({ metric: 'value', aggregation: 'SUM', dimension: field, table: 'data', dates: { ...getDates('2025-12-31'), this_week_start: '2025-12-29', last_90_days: '2025-10-02' } }).build();
            expect(legacySQL).toContain(`"${field}"`);
            expect(duck.query(legacySQL)).toHaveLength(2);
            const model = buildSemanticModel(subject);
            expect(model.fields.find(f => f.name === field)?.ownerTable).toBe('Dim_Geography');
            expect(model.fields.find(f => f.name === 'value')?.keyRole).toBe('none');
            expect(model.fields.find(f => f.name === 'partner_geo_id → Dim_Geography.geo_id')?.keyRole).not.toBe('primary_key');
        } finally { duck.close(); }
    }, 30000);

    it('keeps refresh tables separate for the relational worker to validate', async () => {
        const data = { Fact_Trade: [{ geo_id: 'G1', value: 10 }], Dim_Geography: [{ geo_id: 'G1' }, { geo_id: 'G1' }] };
        vi.stubGlobal('localStorage', { getItem: () => null });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, data, executionTimeMs: 5 }) }));
        const result = await refreshLiveDataset({ connectionId: 'test', tables: Object.keys(data), joinEdges: [] } as any, { preserveTables: true });
        expect(result.sourceTables).toEqual(Object.entries(data).map(([name, rows]) => ({ name, rows })));
        expect(result.sourceTables?.[1].rows).toHaveLength(2);
    });
});
