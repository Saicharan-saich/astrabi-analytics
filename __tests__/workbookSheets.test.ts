/**
 * How a workbook's sheets are read before they are linked: one table split
 * across sheets is put back together; summaries, notes and copies are kept
 * for reference only; plans and overlapping versions are never added to the
 * actuals.
 */
import { describe, it, expect } from 'vitest';
import { planWorkbookSheets, recordSheets } from '../services/workbookSheets';
import { normalizeRelatedTables } from '../services/relationalNormalization';
import { buildRelationalCatalog, defaultSubjectTable } from '../services/relationalCatalog';
import { describeSourceTables } from '../services/ai-sql/leanPipeline';
import { summariseDataReady } from '../services/dataReadySummary';
import { queryTablesOf } from '../utils/duckColumnType';

let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const sales = (month: number, n: number) => Array.from({ length: n }, (_, i) => ({
    Date: new Date(Date.UTC(2026, month, 1 + (i % 27))), Product: ['Tee', 'Mug', 'Tote'][i % 3], Qty: 1 + (i % 3),
    Revenue: Math.round(rnd() * 5000) / 100, Store: i % 2 ? 'North' : 'South',
}));
const plan = (sheets: Record<string, any[]>) => planWorkbookSheets(Object.entries(sheets).map(([name, rows]) => ({ name, rows })));

describe('one table split across sheets', () => {
    it('puts monthly sheets back together, with the sheet each row came from', () => {
        const p = plan({ Jan: sales(0, 60), Feb: sales(1, 55), Mar: sales(2, 70) });
        expect(p.tables).toHaveLength(1);
        expect(p.tables[0].rows).toHaveLength(185);
        expect(p.tables[0].columns?.[0]).toBe('sheet');
        expect(new Set(p.tables[0].rows.map(r => r.sheet))).toEqual(new Set(['Jan', 'Feb', 'Mar']));
        expect(p.combined).toEqual([{ name: 'Jan + Feb + Mar', from: ['Jan', 'Feb', 'Mar'] }]);
    });

    it('matches headers written differently and names the table by what the sheets share', () => {
        const a = sales(0, 20), b = sales(1, 20).map(r => ({ date: r.Date, product: r.Product, QTY: r.Qty, ' Revenue ': r.Revenue, store: r.Store }));
        const p = plan({ 'Sales 2025': a, 'Sales 2026': b });
        expect(p.tables).toHaveLength(1);
        expect(p.tables[0].name).toBe('Sales');
        expect(p.tables[0].rows.slice(20).every(r => typeof r.Revenue === 'number' && typeof r.Qty === 'number')).toBe(true);
    });

    it('never adds a budget or target to the actuals', () => {
        const p = plan({ Budget: sales(0, 40), Actual: sales(0, 45) });
        expect(p.tables).toHaveLength(2);
        expect(p.logs[0].step).toBe('Plan Sheets Kept Apart');
    });

    it('uses an exact copy once, and keeps overlapping versions apart', () => {
        const base = sales(0, 50);
        const copy = plan({ Sales: base, 'Sales (2)': base.map(r => ({ ...r })) });
        expect(recordSheets(copy.tables).map(t => t.name)).toEqual(['Sales']);
        expect(copy.leftOut).toEqual([{ name: 'Sales (2)', role: 'copy' }]);
        const versions = plan({ 'Orders Oct': base, 'Orders Oct v2': [...base.slice(0, 40).map(r => ({ ...r })), ...sales(1, 10)] });
        expect(recordSheets(versions.tables)).toHaveLength(2);
        expect(versions.logs.map(l => l.step)).toContain('Sheets Kept Apart');
    });
});

describe('sheets that are not records', () => {
    const summary = [{ Category: 'A', Sales: 300 }, { Category: 'B', Sales: 400 }, { Category: 'Grand Total', Sales: 700 }];
    const notes = [{ 'How to use this workbook': 'Enter each sale on the Sales sheet please.' }, { 'How to use this workbook': 'Prices include VAT at twenty percent.' }];

    it('keeps a summary and written notes for reference, beside a sheet of records', () => {
        const p = plan({ Summary: summary, Sales: sales(0, 120), Notes: notes });
        expect(p.leftOut).toEqual([{ name: 'Summary', role: 'report' }, { name: 'Notes', role: 'notes' }]);
        expect(recordSheets(p.tables).map(t => t.name)).toEqual(['Sales']);
    });

    it('never treats the only sheet as a summary', () => {
        expect(plan({ Totals: summary }).leftOut).toEqual([]);
    });

    it('does not link a summary, open it, or offer it to AI SQL', () => {
        const orders = Array.from({ length: 30 }, (_, i) => ({ 'Order ID': 1000 + i, 'Order Date': new Date(Date.UTC(2026, 0, 1 + i)), Customer: `C${i % 7}`, Shipping: 3.95 }));
        const lines = Array.from({ length: 70 }, (_, i) => ({ 'Order ID': 1000 + (i % 30), SKU: `SKU-${i % 5}`, Qty: 1 + (i % 2), 'Line Total': 10 + (i % 5) }));
        const products = Array.from({ length: 5 }, (_, i) => ({ SKU: `SKU-${i}`, Name: `P${i}`, Category: i % 2 ? 'A' : 'B' }));
        const p = plan({ Orders: orders, Lines: lines, Products: products, Summary: summary });
        const tables = normalizeRelatedTables(p.tables, 'shop.xlsx').tables;
        const catalog = buildRelationalCatalog(tables);
        expect(catalog.subjects.find(s => s.table === 'Summary')?.kind).toBe('report');
        expect(catalog.schema.joinEdges.some(e => e.leftTable === 'Summary' || e.rightTable === 'Summary')).toBe(false);
        expect(defaultSubjectTable(tables, catalog)).toBe('Lines');
        const dataset: any = { id: 'x', name: 'shop.xlsx', rows: [], columns: [], sourceTables: tables, relationalCatalog: catalog, subjectTable: 'Lines', etlLogs: p.logs };
        expect(queryTablesOf(dataset)!.map(t => t.name)).toEqual(['Orders', 'Lines', 'Products']);
        expect(describeSourceTables(dataset)).toMatch(/Not loaded \(not records\): "Summary" \(a summary made from the records\)/);
        expect(summariseDataReady(dataset).setAside).toEqual(['Summary (a summary made from the records)']);
    });
});
