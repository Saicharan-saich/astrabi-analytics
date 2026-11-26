import { describe, expect, it } from 'vitest';
import { applyValueFixes, describeFix, mergeFixes } from '../services/valueFixes';
import { fixesFromEdits } from '../utils/rowEdits';
import { rowsForLog } from '../utils/itemRows';
import { runETLPipeline } from '../services/etlPipeline';
import { ColumnType, type ColumnDefinition, type ETLLog } from '../types';

const col = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: 'x' });

// 600 orders; Milk is Dairy, but 12 rows file it under Bakery.
function shop() {
    const items = [['Milk', 'Dairy'], ['Cheese', 'Dairy'], ['Bread', 'Bakery'], ['Croissant', 'Bakery'], ['Apples', 'Fruit'], ['Bananas', 'Fruit']];
    const raw = Array.from({ length: 600 }, (_, i) => {
        const [item, category] = items[i % items.length];
        return { 'Order ID': `S${1000 + i}`, 'Order Date': `2026-0${1 + (i % 9)}-1${i % 9}`, 'Menu Item': item, 'Menu Category': category, Store: ['Leeds', 'York'][i % 2], Sales: 5 + (i % 7) };
    });
    let wrong = 0;
    for (let i = 0; i < raw.length && wrong < 12; i++) if (raw[i]['Menu Item'] === 'Milk' && i > 20) { raw[i]['Menu Category'] = 'Bakery'; wrong++; }
    return raw;
}

describe('every row a pairing flag is about, and fixing them', () => {
    it('lists all 12 rows (not examples), editable in the category column', () => {
        const out = runETLPipeline(shop(), 'shop.csv');
        const flag = out.logs.find(l => l.step === 'Inconsistent Mapping Flag')!;
        expect(flag.affectedRows).toBe(12);
        const view = rowsForLog(flag, out.rows)!;
        expect(view.mode === 'rows' && view.source).toBe('data');
        if (view.mode !== 'rows') return;
        expect(view.rows).toHaveLength(12);
        expect(view.rows.every(r => r.menu_item === 'Milk' && r.menu_category === 'Bakery')).toBe(true);
        expect(view.edit).toMatchObject({ column: 'menu_category', by: 'menu_item' });
        expect(view.edit?.usual?.Milk).toBe('Dairy');
    });

    it('finds them again for a file cleaned before rows were recorded', () => {
        const out = runETLPipeline(shop(), 'shop.csv');
        const flag = out.logs.find(l => l.step === 'Inconsistent Mapping Flag')!;
        const old: ETLLog = { ...flag, rowMatch: undefined, sampleRows: flag.sampleRows!.slice(0, 5) };
        const view = rowsForLog(old, out.rows)!;
        expect(view.mode === 'rows' && view.rows.length).toBe(12);
    });

    it('saves a change covering a whole pair as one fix that also fixes next month, and clears the flag', () => {
        const first = runETLPipeline(shop(), 'shop.csv');
        const view = rowsForLog(first.logs.find(l => l.step === 'Inconsistent Mapping Flag')!, first.rows)!;
        if (view.mode !== 'rows') throw new Error('rows expected');
        const edits = new Map(view.rows.map((_, i) => [i, 'Dairy'] as [number, string]));
        const plan = fixesFromEdits(view.rows, edits, { column: 'menu_category', by: 'menu_item', idColumn: 'order_id' });
        expect(plan.fixes).toEqual([{ column: 'menu_category', where: { menu_item: 'Milk', menu_category: 'Bakery' }, to: 'Dairy' }]);
        expect(plan.summary).toMatch(/^Saves as 1 fix for each menu item, so next month’s file is fixed the same way\./);
        expect(describeFix(plan.fixes[0])).toBe("Set 'menu category' to 'Dairy' where 'menu item' is 'Milk' and 'menu category' is 'Bakery'");

        const again = runETLPipeline(shop(), 'shop.csv', undefined, { valueFixes: plan.fixes });
        expect(again.logs.some(l => l.step === 'Inconsistent Mapping Flag')).toBe(false);
        const mine = again.logs.find(l => l.step === 'Your Fixes')!;
        expect(mine).toMatchObject({ status: 'applied', affectedRows: 12, revert: { option: 'valueFixes', value: [] } });
        expect(again.rows.filter(r => r.menu_item === 'Milk').every(r => r.menu_category === 'Dairy')).toBe(true);
        // Nothing else moved; the rows and totals are all still there.
        expect(again.rows).toHaveLength(600);
        expect(again.rows.reduce((s, r) => s + r.sales, 0)).toBe(first.rows.reduce((s, r) => s + r.sales, 0));
    });

    it('saves single-row changes by the ID, or by value when there is no ID', () => {
        const rows = [{ id: 'A', item: 'Milk', cat: 'Bakery' }, { id: 'B', item: 'Milk', cat: 'Bakery' }, { id: 'C', item: 'Bread', cat: 'Dairy' }];
        const some = fixesFromEdits(rows, new Map([[0, 'Dairy']]), { column: 'cat', by: 'item', idColumn: 'id' });
        expect(some.fixes).toEqual([{ column: 'cat', where: { id: 'A' }, to: 'Dairy' }]);
        expect(some.summary).toMatch(/1 fix for single rows, by id/);
        const noId = fixesFromEdits(rows, new Map([[2, ' ']]), { column: 'cat' });
        expect(noId.fixes).toEqual([{ column: 'cat', where: { cat: 'Dairy' }, to: null }]);
        expect(noId.summary).toMatch(/every row with the same cat/);
        expect(fixesFromEdits([{ v: 950 }], new Map([[0, 'abc']]), { column: 'v', isNumber: true }).summary).toMatch(/'abc' is not a number/);
    });

    it('applies fixes in order, reads numbers for number columns, and skips columns a file lacks', () => {
        const cols = [col('id', ColumnType.ID), col('cost', ColumnType.METRIC)];
        const out = applyValueFixes([{ id: 'A', cost: 950 }, { id: 'B', cost: 9 }], cols, [
            { column: 'cost', where: { id: 'A' }, to: '9.50' },
            { column: 'store', where: { id: 'A' }, to: 'x' },
        ]);
        expect(out.rows).toEqual([{ id: 'A', cost: 9.5 }, { id: 'B', cost: 9 }]);
        expect(out.log?.details).toBe("1 value changed by hand in 'cost' (1 fix). 1 fix skipped: this file has no such column.");
        expect(out.log?.transformSamples).toEqual([{ column: 'cost', before: 950, after: 9.5 }]);
        expect(applyValueFixes([{ id: 'Z', cost: 1 }], cols, [{ column: 'cost', where: { id: 'A' }, to: 2 }]).log?.status).toBe('info');
        expect(applyValueFixes([], cols, []).log).toBeUndefined();
        const merged = mergeFixes([{ column: 'cost', where: { id: 'A' }, to: 1 }, { column: 'cost', where: { id: 'B' }, to: 2 }], [{ column: 'cost', where: { id: 'A' }, to: 3 }]);
        expect(merged).toEqual([{ column: 'cost', where: { id: 'B' }, to: 2 }, { column: 'cost', where: { id: 'A' }, to: 3 }]);
    });
});
