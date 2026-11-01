import { describe, expect, it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { summariseEtlChanges } from '../utils/etlChangeSummary';
import { percentScaleOf, percentScalesByKey, scaleForName, toPercentPoints } from '../utils/percentScale';

const sum = (rows: any[], key: string) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

const report = () => [
    { region: 'North', product: 'A', sales: 100 }, { region: 'North', product: 'B', sales: 50 },
    { region: 'North Subtotal', product: '', sales: 150 },
    { region: 'South', product: 'A', sales: 70 }, { region: 'South', product: 'B', sales: 30 },
    { region: 'Grand Total', product: '', sales: 250 },
];

describe('what we changed — summary', () => {
    it('says which rows were removed and why, with a way back', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ invoice_id: `INV-${i}`, amount: 100 + i, note: i % 5 === 0 ? 'N/A' : 'ok' }));
        raw.push({ ...raw[3] }, { ...raw[7] });
        const summary = summariseEtlChanges(runETLPipeline(raw, 'invoices.csv').logs);
        const removed = summary.byKind.removed.find(i => /duplicate row/.test(i.title))!;
        expect(removed.title).toBe('Removed 2 duplicate rows');
        expect(removed.revert).toMatchObject({ option: 'keepDuplicateRows', value: true });
        expect(removed.samples).toHaveLength(2);
        expect(summary.byKind.converted.some(i => /like "N\/A"/.test(i.title))).toBe(true);
        expect(summary.headline).toMatch(/^2 rows removed/);
        expect(summary).toMatchObject({ rowsBefore: 22, rowsAfter: 20 });
    });

    it('leaves out bookkeeping steps that change no number', () => {
        const raw = Array.from({ length: 30 }, (_, i) => ({ OrderID: `O${i}`, Amount: 10 }));
        const summary = summariseEtlChanges(runETLPipeline(raw, 'clean.csv').logs);
        expect(summary.items.map(i => i.title).join(' ')).not.toMatch(/snake|Profil|Order|Contract/);
    });

    it('flags values that could not be read as numbers', () => {
        const raw = Array.from({ length: 40 }, (_, i) => ({ order_id: `O${i}`, amount: i === 3 ? 'see note' : 10 + i }));
        const summary = summariseEtlChanges(runETLPipeline(raw, 'notes.csv').logs);
        const check = summary.byKind.check.find(i => /couldn't be read/.test(i.title));
        expect(check?.title).toBe("1 value in 'amount' couldn't be read as numbers");
    });
});

describe('what we changed — undo', () => {
    it('keeps total rows when asked, and offers to clean them again', () => {
        const kept = runETLPipeline(report(), 'report.csv', undefined, { keepTotalRows: true });
        expect(kept.rows).toHaveLength(6);
        expect(sum(kept.rows, 'sales')).toBe(650);
        const item = summariseEtlChanges(kept.logs).byKind.kept[0];
        expect(item.title).toBe('Total rows kept');
        expect(item.revert).toMatchObject({ option: 'keepTotalRows', value: null });
    });

    it('keeps exact copies when asked', () => {
        const raw = Array.from({ length: 20 }, (_, i) => ({ invoice_id: `INV-${i}`, amount: 100 }));
        raw.push({ ...raw[3] });
        expect(runETLPipeline(raw, 'inv.csv', undefined, { keepDuplicateRows: true }).rows).toHaveLength(21);
    });

    it('keeps a wide table wide when asked', () => {
        const raw = [
            { product: 'Desk', 'Jan 2024': 100, 'Feb 2024': 120, 'Mar 2024': 90 },
            { product: 'Chair', 'Jan 2024': 40, 'Feb 2024': 45, 'Mar 2024': 50 },
        ];
        const etl = runETLPipeline(raw, 'wide.csv', undefined, { keepWideLayout: true });
        expect(etl.rows).toHaveLength(2);
        expect(etl.columns.map(c => c.name)).toContain('jan_2024');
    });

    it('keeps placeholder codes and spelling variants when asked', () => {
        const raw = Array.from({ length: 60 }, (_, i) => ({ order_id: `O${i}`, amount: i % 20 === 0 ? 999999 : 10 + (i % 7), city: i % 3 ? 'St. Louis' : 'St Louis' }));
        const cleaned = runETLPipeline(raw, 'p.csv');
        expect(cleaned.rows.filter(r => r.amount === null)).toHaveLength(3);
        const kept = runETLPipeline(raw, 'p.csv', undefined, { keepPlaceholders: true, keepCategorySpellings: true });
        expect(kept.rows.filter(r => r.amount === 999999)).toHaveLength(3);
        expect(new Set(kept.rows.map(r => r.city)).size).toBe(2);
    });

    it('reads ambiguous dates the other way round when asked', () => {
        const raw = Array.from({ length: 10 }, (_, i) => ({ order_id: `O${i}`, order_date: '03/04/2025', amount: 1 }));
        const dayFirst = runETLPipeline(raw, 'd.csv', undefined, { dateOrder: 'day_first' });
        expect(String(dayFirst.rows[0].order_date).slice(0, 10)).toBe('2025-04-03');
        const flag = summariseEtlChanges(dayFirst.logs).byKind.check.find(i => /Day\/month/.test(i.title))!;
        expect(flag.revert).toMatchObject({ option: 'dateOrder', value: 'month_first', label: 'Read as month/day' });
        const monthFirst = runETLPipeline(raw, 'd.csv', undefined, { dateOrder: 'month_first' });
        expect(String(monthFirst.rows[0].order_date).slice(0, 10)).toBe('2025-03-04');
    });
});

describe('percent scale is decided per series', () => {
    it('reads a series of fractions as fractions', () => {
        expect(percentScaleOf([0.12, 0.3, 0.05])).toBe('fraction');
        expect(toPercentPoints(0.12, 'fraction')).toBeCloseTo(12);
    });

    it('does not inflate a small rate beside larger ones', () => {
        // 0.5% and 1.2% stored as points: per value, 0.5 used to read as 50%.
        const scale = percentScaleOf([0.5, 1.2, 0.8]);
        expect(scale).toBe('points');
        expect(toPercentPoints(0.5, scale)).toBe(0.5);
    });

    it('trusts a column known to be written in percent points', () => {
        expect(percentScaleOf([0.3, 0.5], 'points')).toBe('points');
        const scales = percentScalesByKey([{ conversion_rate: 0.3, share: 0.4 }, { conversion_rate: 0.6, share: 0.6 }], new Set(['conversion_rate']));
        expect(scales.get('conversion_rate')).toBe('points');
        expect(scales.get('share')).toBe('fraction');
        expect(scaleForName(scales, 'Conversion Rate', 'fraction')).toBe('points');
    });

    it('marks columns written as "12.5%" so charts never rescale them', () => {
        const raw = Array.from({ length: 30 }, (_, i) => ({ store: `S${i}`, conversion_rate: `${(0.2 + (i % 5) * 0.1).toFixed(1)}%` }));
        const etl = runETLPipeline(raw, 'conv.csv');
        expect(etl.columns.find(c => c.name === 'conversion_rate')).toMatchObject({ type: 'METRIC', valueUnit: 'percent_points' });
        expect(etl.rows[0].conversion_rate).toBeCloseTo(0.2);
    });
});
