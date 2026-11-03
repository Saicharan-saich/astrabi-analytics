import { describe, expect, it } from 'vitest';
import { ColumnType, type ColumnDefinition } from '../types';
import { runQualityChecks, ruleViolations, shapeOf, describeRule, convertMixedUnits } from '../services/etlQualityChecks';
import { runETLPipeline, toTitleCase } from '../services/etlPipeline';
import { buildReviewOptions } from '../utils/cleaningReview';
import { summariseEtlChanges } from '../utils/etlChangeSummary';

const col = (name: string, type: ColumnType): ColumnDefinition => ({ name, type, originalType: type === ColumnType.METRIC ? 'number' : 'string' });
const PRODUCTS: Record<string, string> = { Milk: 'Dairy', Cheese: 'Dairy', Bread: 'Bakery', Bagel: 'Bakery', Apple: 'Produce', Pear: 'Produce' };
const NAMES = Object.keys(PRODUCTS);
const orders = (n = 400) => Array.from({ length: n }, (_, i) => ({
    order_id: `ORD-${10000 + i}`,
    order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-15`,
    product: NAMES[i % 6],
    category: PRODUCTS[NAMES[i % 6]],
    email: `user${i}@shop.co.uk`,
    price: 20 + (i % 7),
}));
const COLUMNS = [
    col('order_id', ColumnType.ID), col('order_date', ColumnType.DATE), col('product', ColumnType.DIMENSION),
    col('category', ColumnType.DIMENSION), col('email', ColumnType.DIMENSION), col('price', ColumnType.METRIC),
];
const TODAY = new Date('2026-11-03T12:00:00Z');
const flags = (rows: any[], opts = {}) => runQualityChecks(rows, COLUMNS, opts, TODAY).logs;
const step = (logs: any[], name: string) => logs.find(l => l.step === name);

describe('quality checks — each finds its planted problem', () => {
    it('stays quiet on clean data', () => {
        const logs = flags(orders());
        expect(logs.filter(l => l.status === 'info' && /Flag$/.test(l.step))).toEqual([]);
    });

    it('finds a product filed under the wrong category, and fixes it to the usual one', () => {
        const rows = orders(); rows[0].category = 'Bakery';
        const flag = step(flags(rows), 'Inconsistent Mapping Flag');
        expect(flag.details).toContain("'Milk' is under 'Dairy'");
        expect(flag.decision).toMatchObject({ kind: 'flag', key: 'mapping:product->category' });
        const fixed = runQualityChecks(rows, COLUMNS, { flagDecisions: { 'mapping:product->category': 'fix' } }, TODAY);
        expect(fixed.rows[0].category).toBe('Dairy');
        expect(step(fixed.logs, 'Inconsistent Mapping Fixed').revert).toMatchObject({ option: 'flagDecisions', value: null });
    });

    it('finds an invalid email, and clears it on request', () => {
        const rows = orders(); rows[5].email = 'not-an-email';
        expect(step(flags(rows), 'Invalid Format Flag').details).toContain("'not-an-email'");
        expect(step(flags(rows), 'Format Inconsistency Flag')).toBeUndefined(); // not flagged twice
        const fixed = runQualityChecks(rows, COLUMNS, { flagDecisions: { 'valid:email': 'fix' } }, TODAY);
        expect(fixed.rows[5].email).toBeNull();
    });

    it('finds a code that breaks the column\'s format', () => {
        const rows = orders(); rows[7].order_id = 'ORD10007X';
        expect(shapeOf('ORD-10006')).toBe('A-9');
        expect(step(flags(rows), 'Format Inconsistency Flag').details).toContain("'ORD10007X'");
    });

    it('finds a past event dated in the future, and missing months', () => {
        const rows = orders(); rows[9].order_date = '2099-01-01';
        rows.forEach(r => { if (r.order_date.startsWith('2024-06')) r.order_date = '2024-07-15'; });
        const logs = flags(rows);
        expect(step(logs, 'Future Date Flag').details).toContain('2099-01-01');
        expect(step(logs, 'Missing Period Note').details).toContain('Jun 2024');
        const removed = runQualityChecks(rows, COLUMNS, { flagDecisions: { 'future:order_date': 'remove' } }, TODAY);
        expect(removed.rows).toHaveLength(399);
    });

    it('finds a price typed in pence among pounds, and rescales it', () => {
        const rows = orders(); rows[13].price = 2300;
        expect(step(flags(rows), 'Scale Shift Flag').details).toContain('100× larger');
        const fixed = runQualityChecks(rows, COLUMNS, { flagDecisions: { 'scale:price': 'fix' } }, TODAY);
        expect(fixed.rows[13].price).toBe(23);
    });

    it('does not mistake the low end of an even spread for a different unit', () => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({ mileage: 1000 + i * 100 }));
        expect(runQualityChecks(rows, [col('mileage', ColumnType.METRIC)], {}, TODAY).logs.find(l => l.step === 'Scale Shift Flag')).toBeUndefined();
    });

    it('notes a column with a single value', () => {
        const rows = orders().map(r => ({ ...r, country: 'UK' }));
        const logs = runQualityChecks(rows, [...COLUMNS, col('country', ColumnType.DIMENSION)], {}, TODAY).logs;
        expect(step(logs, 'Constant Column Note').details).toContain("'country'");
    });

    it('finds near-duplicate rows that differ only in case and spacing', () => {
        const rows = [{ name: 'Acme Ltd', city: 'London', amount: 120 }, { name: 'acme ltd.', city: 'london ', amount: 120 }, { name: 'Beta', city: 'Leeds', amount: 80 }];
        const cols = [col('name', ColumnType.DIMENSION), col('city', ColumnType.DIMENSION), col('amount', ColumnType.METRIC)];
        expect(runQualityChecks(rows, cols, {}, TODAY).logs.find(l => l.step === 'Near-Duplicate Rows Flag')).toBeTruthy();
        expect(runQualityChecks(rows, cols, { flagDecisions: { 'near-duplicates': 'remove' } }, TODAY).rows).toHaveLength(2);
    });

    it('finds rows that are unusual in two ways at once, with no rule written', () => {
        const rows = orders(1000).map(r => ({ ...r, email: undefined }));
        rows[500] = { ...rows[500], price: 2600, category: 'Hardware' };
        const flag = runQualityChecks(rows, COLUMNS.filter(c => c.name !== 'email'), {}, TODAY).logs.find(l => l.step === 'Unusual Row Flag');
        expect(flag?.details).toContain('unusual in two or more ways');
    });
});

describe('custom rules — a problem found once is caught every time', () => {
    it('describes and checks each kind of rule', () => {
        const rows = [{ price: -5, fuel: 'Petrol', code: 'AB-1', d: '2099-01-01' }, { price: 10, fuel: 'Steam', code: 'X', d: '2024-01-01' }, { price: 10, fuel: 'petrol', code: 'CD-2', d: '' }];
        expect(ruleViolations(rows, { id: 'a', column: 'price', test: 'min', value: '0', action: 'flag' }).size).toBe(1);
        expect(ruleViolations(rows, { id: 'b', column: 'fuel', test: 'one_of', value: 'Petrol, Diesel', action: 'flag' }).size).toBe(1);
        expect(ruleViolations(rows, { id: 'c', column: 'code', test: 'matches', value: '^[A-Z]{2}-\\d$', action: 'flag' }).size).toBe(1);
        expect(ruleViolations(rows, { id: 'd', column: 'price', test: 'unique', action: 'flag' }).size).toBe(1);
        expect(ruleViolations(rows, { id: 'e', column: 'd', test: 'not_future', action: 'flag' }, TODAY).size).toBe(1);
        expect(ruleViolations(rows, { id: 'f', column: 'd', test: 'not_blank', action: 'flag' }).size).toBe(1);
        expect(describeRule({ id: 'g', column: 'unit_price', test: 'min', value: '0', action: 'flag' })).toBe('unit price is at least 0');
    });

    it('flags or removes rule breakers, and survives a re-run', () => {
        const rows = orders(); rows[2].price = -3;
        const rule = { id: 'r1', column: 'price', test: 'min' as const, value: '0', action: 'flag' as const };
        expect(step(runQualityChecks(rows, COLUMNS, { customRules: [rule] }, TODAY).logs, 'Rule Violation Flag').details).toContain('price is at least 0');
        const removed = runQualityChecks(rows, COLUMNS, { customRules: [{ ...rule, action: 'remove' }] }, TODAY);
        expect(removed.rows).toHaveLength(399);
        expect(step(removed.logs, 'Rule Applied').revert).toMatchObject({ option: 'customRules', value: null });
    });

    it('deleting one rule from the review keeps the others', () => {
        const a = { id: 'a', column: 'price', test: 'min' as const, value: '0', action: 'flag' as const };
        const b = { id: 'b', column: 'price', test: 'max' as const, value: '100', action: 'flag' as const };
        const next = buildReviewOptions({ customRules: [a, b] }, { x: { kind: 'undo', revert: { option: 'customRules', value: [b], label: 'Delete this rule' } } });
        expect(next.customRules).toEqual([b]);
    });
});

describe('cleaning fixes that change values', () => {
    it('converts mixed units of one kind to the most common unit', () => {
        const source = [{ w: '1 kg' }, { w: '2 kg' }, { w: '1500 g' }];
        const logs: any[] = [];
        const rows = convertMixedUnits([{ w: 1 }, { w: 2 }, { w: 1500 }], source, [col('w', ColumnType.METRIC)], {}, logs);
        expect(rows.map(r => r.w)).toEqual([1, 2, 1.5]);
        expect(logs[0].step).toBe('Mixed Units Converted');
        expect(convertMixedUnits([{ w: 1500 }], [{ w: '1500 g' }], [col('w', ColumnType.METRIC)], { keepMixedUnits: true }, []).at(0)!.w).toBe(1500);
    });

    it('keeps capitals inside hyphenated names', () => {
        expect(toTitleCase('MERCEDES-BENZ')).toBe('Mercedes-Benz');
        expect(toTitleCase('Mercedes-Benz')).toBe('Mercedes-Benz');
        expect(toTitleCase('C-Class')).toBe('C-Class');
        expect(toTitleCase('stoke-on-trent')).toBe('Stoke-On-Trent');
    });

    it('explains the new checks in the "what we changed" summary', () => {
        const rows = orders(); rows[13].price = 2300;
        const result = runETLPipeline(rows, 'orders.csv', undefined, { flagDecisions: { 'scale:price': 'fix' } });
        const titles = summariseEtlChanges(result.logs).items.map(item => item.title);
        expect(titles.some(t => /Fixed .*values off by ×100 or ×1000 in 'price' \(your choice\)/.test(t))).toBe(true);
    });
});
