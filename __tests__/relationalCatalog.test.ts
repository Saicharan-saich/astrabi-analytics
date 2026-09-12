import { describe, it, expect } from 'vitest';
import { buildRelationalCatalog, materializeSubject, validateRelationship, createSubjectDataset } from '../services/relationalCatalog';
import { detectCandidateKeys, discoverRelationships } from '../services/ai-sql/relationshipDiscovery';
import { autoJoinDatasets } from '../services/analysisEngine';
import * as XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { executeQueryPlan } from '../services/queryPlan/executeQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';

const tables = [
    { name: 'Dim_Geography', rows: [{ geo_id: 'G1', name: 'India' }, { geo_id: 'G2', name: 'UK' }] },
    { name: 'Dim_Period', rows: [{ period_id: 'P1', label: '2025' }] },
    { name: 'Fact_Trade', rows: [
        { trade_id: 'T1', period_id: 'P1', reporter_geo_id: 'G1', partner_geo_id: 'G2', value: 10 },
        { trade_id: 'T2', period_id: 'P1', reporter_geo_id: 'G1', partner_geo_id: 'G2', value: 20 },
    ] },
];

describe('relational catalog', () => {
    it('preserves empty source schemas', () => {
        const sources = [{ name: 'empty', rows: [], columns: ['id', 'name'] }];
        const catalog = buildRelationalCatalog(sources);
        expect(catalog.schema.tables[0].columns.map(c => c.name)).toEqual(['id', 'name']);
        expect(materializeSubject(sources, catalog, 'empty', true).columns.map(c => c.name)).toEqual(['id', 'name']);
    });
    it('carries a time context using the actual role field and serializes Excel dates', () => {
        const sources = [
            { name: 'Dim_Period', rows: [{ period_id: 'P1', end_date: new Date('2025-12-31T00:00:00Z') }] },
            { name: 'Fact_Trade', rows: [{ trade_id: 'T1', period_id: 'P1', value: 1 }] },
        ];
        const view = materializeSubject(sources, buildRelationalCatalog(sources), 'Fact_Trade');
        expect(view.timeContext?.anchorDateColumn).toBe('period_id → Dim_Period.end_date');
        expect(view.timeContext?.maxDate).toBe('2025-12-31');
        expect(view.rows[0]['period_id → Dim_Period.end_date']).toBe('2025-12-31T00:00:00.000Z');
    });
    it('feeds the existing Builder executor and SQL compiler without losing role fields', () => {
        const view = materializeSubject(tables, buildRelationalCatalog(tables), 'Fact_Trade');
        const field = 'partner_geo_id → Dim_Geography.name';
        const plan = buildQueryPlan({ metric: 'value', aggregation: 'SUM', dimension: field }, '', getDates('2025-12-31'), 'data');
        const result = executeQueryPlan(plan, view.rows);
        expect(result.data).toEqual([{ [field]: 'UK', sum_value: 30 }]);
        expect(compileSQL(plan)).toContain(`"${field}"`);
    });
    it('supports composite lookup keys without multiplying base rows', () => {
        const sources = [
            { name: 'lookup', rows: [{ country: 'IN', code: 'A', label: 'India A' }, { country: 'UK', code: 'A', label: 'UK A' }] },
            { name: 'Fact_Events', rows: [{ event_id: 1, country: 'IN', code: 'A', value: 5 }, { event_id: 2, country: 'UK', code: 'A', value: 6 }] },
        ];
        const catalog = buildRelationalCatalog(sources);
        const edge = { leftTable: 'Fact_Events', rightTable: 'lookup', leftColumn: 'country', rightColumn: 'country', leftColumns: ['country', 'code'], rightColumns: ['country', 'code'], type: 'fk' as const };
        expect(validateRelationship(sources, edge).unmatched).toBe(0);
        catalog.schema.joinEdges = [edge];
        const view = materializeSubject(sources, catalog, 'Fact_Events');
        expect(view.rows.map(r => r['country + code → lookup.label'])).toEqual(['India A', 'UK A']);
    });
    it('keeps raw tables out of the active SQL context and versions subject identity', () => {
        const parent = { id: 'upload', name: 'book', rows: [], columns: [], totalRows: 0, etlLogs: [], sourceTables: tables, version: 1 };
        const first = createSubjectDataset(parent, 'Fact_Trade');
        const second = createSubjectDataset({ ...parent, version: 2 }, 'Fact_Trade');
        expect(first.id).not.toBe(second.id);
        expect(first.relatedTables).toBeUndefined();
        expect(first.sourceTables).toEqual(tables);
        expect(first.fieldLineage).toEqual(second.fieldLineage);
    });
    it('keeps live connection details when selecting another subject', () => {
        const liveConnection = { connectionId: 'test', tables: tables.map(t => t.name), joinEdges: [], dbType: 'postgres' } as any;
        const parent = { id: 'live', name: 'live', rows: [], columns: [], totalRows: 0, etlLogs: [],
            sourceTables: tables, connectionMode: 'live' as const, liveConnection };
        const subject = createSubjectDataset(parent, 'Dim_Period', true);
        expect(subject.connectionMode).toBe('live');
        expect(subject.liveConnection).toBe(liveConnection);
    });
    it.skipIf(!process.env.QUICKINSIGHT_WORKBOOK)('validates all 19 India workbook relationships and five fact subjects', () => {
        const book = XLSX.read(readFileSync(process.env.QUICKINSIGHT_WORKBOOK!), { type: 'buffer', cellDates: true });
        const sources = book.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json<Record<string, any>>(book.Sheets[name]) }));
        const catalog = buildRelationalCatalog(sources);
        expect(catalog.schema.tables).toHaveLength(11);
        expect(catalog.schema.joinEdges).toHaveLength(19);
        expect(catalog.subjects.filter(s => s.kind === 'fact')).toHaveLength(5);
        for (const source of sources.filter(t => t.name.startsWith('Fact_'))) {
            const view = materializeSubject(sources, catalog, source.name);
            expect(view.rows).toHaveLength(source.rows.length);
            expect(view.rows.reduce((sum, r) => sum + r.value_usd_bn, 0)).toBe(source.rows.reduce((sum, r) => sum + r.value_usd_bn, 0));
        }
    });
    it('accepts constant FKs into small dimensions and preserves role aliases and totals', () => {
        const catalog = buildRelationalCatalog(tables);
        expect(catalog.schema.joinEdges).toHaveLength(3);
        const view = materializeSubject(tables, catalog, 'Fact_Trade');
        expect(view.rows).toHaveLength(2);
        expect(view.rows.reduce((sum, row) => sum + row.value, 0)).toBe(30);
        expect(view.rows[0]['reporter_geo_id → Dim_Geography.name']).toBe('India');
        expect(view.rows[0]['partner_geo_id → Dim_Geography.name']).toBe('UK');
        expect(view.rows[0]['period_id → Dim_Period.label']).toBe('2025');
        expect(catalog.schema.tables.find(t => t.name === 'Fact_Trade')!.columns.filter(c => c.isPK).map(c => c.name)).toEqual(['trade_id']);
    });
    it('does not call unique measures and labels identifiers', () => {
        expect(detectCandidateKeys({ name: 'data', rows: [{ value: 1, period_label: 'A' }, { value: 2, period_label: 'B' }] }).some(c => c.isKey)).toBe(false);
    });
    it('does not use a generic target id as evidence for an unrelated reference', () => {
        const result = discoverRelationships([
            { name: 'Orders', rows: [{ customer_id: 1 }, { customer_id: 2 }] },
            { name: 'Warehouses', rows: [{ id: 1 }, { id: 2 }] },
        ]);
        expect(result.relationships).toHaveLength(0);
    });
    it('does not promote a unique foreign key to the fact primary key', () => {
        const sources = [
            { name: 'Dim_Period', rows: [{ period_id: 'P1' }, { period_id: 'P2' }] },
            { name: 'Fact_Trade', rows: [{ period_id: 'P1', trade_id: 'T1', value: 10 }, { period_id: 'P2', trade_id: 'T2', value: 20 }] },
        ];
        const catalog = buildRelationalCatalog(sources);
        expect(catalog.schema.tables.find(t => t.name === 'Fact_Trade')!.columns.filter(c => c.isPK).map(c => c.name)).toEqual(['trade_id']);
    });
    it('checks duplicate keys beyond the old sample boundary', () => {
        const rows = Array.from({ length: 20001 }, (_, i) => ({ id: i }));
        rows.push({ id: 20000 });
        expect(detectCandidateKeys({ name: 'large', rows })[0].isKey).toBe(false);
    });
    it('does not choose an arbitrary target on tied evidence', () => {
        const result = discoverRelationships([
            { name: 'a', rows: [{ customer_id: 'C1' }, { customer_id: 'C2' }] },
            { name: 'b', rows: [{ customer_id: 'C1' }, { customer_id: 'C2' }] },
            { name: 'orders', rows: [{ customer_id: 'C1' }, { customer_id: 'C1' }] },
        ]);
        expect(result.relationships.filter(r => r.fromTable === 'orders')).toEqual([]);
        expect(result.rejected.some(r => r.reason.includes('ambiguous'))).toBe(true);
    });
    it('revalidates a target before materialization', () => {
        const catalog = buildRelationalCatalog(tables);
        const changed = tables.map(t => ({ ...t, rows: [...t.rows] }));
        changed[0].rows.push(changed[0].rows[0]);
        expect(() => materializeSubject(changed, catalog, 'Fact_Trade')).toThrow(/Duplicate lookup/);
    });
    it('keeps standalone data exact, including repeated rows', () => {
        const sources = [{ name: 'events', rows: [{ x: 'a' }, { x: 'a' }] }];
        expect(materializeSubject(sources, buildRelationalCatalog(sources), 'events', true).rows).toEqual(sources[0].rows);
    });
    it('does not fall back to name matching after an empty accepted join plan', () => {
        const result = autoJoinDatasets({ a: [{ id: 1, value: 4 }, { id: 2, value: 5 }], b: [{ id: 1, extra: 'x' }] }, []);
        expect(result.mergedRows.every(r => !('extra' in r))).toBe(true);
    });
});
