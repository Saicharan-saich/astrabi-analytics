/**
 * The briefing: the latest full week (or month) against a usual one, for any
 * dataset with dates. Built from generated data with known changes, the
 * golden exports, and the benchmark datasets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBriefing, categoryKind } from '../services/weeklyBriefing';
import { parseDelimitedText } from '../services/delimitedText';
import { runETLPipeline } from '../services/etlPipeline';
import { ColumnType, type Dataset } from '../types';

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** A café group: two sites, open Monday–Saturday, ten weeks to Wednesday 5 Nov 2025. */
function cafe(options: { dropCafe?: boolean } = {}): Dataset {
    seed = 7;
    const rows: Record<string, any>[] = [];
    const start = Date.UTC(2025, 7, 25); // Monday 25 Aug 2025
    const end = Date.UTC(2025, 10, 5);   // Wednesday 5 Nov 2025
    let order = 1000;
    for (let t = start; t <= end; t += DAY) {
        const date = day(t);
        const dow = new Date(t).getUTCDay();
        if (dow === 0) continue; // closed on Sundays
        const lastFullWeek = date >= '2025-10-27' && date <= '2025-11-02';
        for (const location of ['Station', 'Market']) {
            let orders = 18 + Math.floor(rnd() * 5);
            if (options.dropCafe && lastFullWeek && location === 'Station') orders = Math.round(orders * 0.5);
            if (options.dropCafe && date === '2025-10-30') orders = Math.round(orders * 0.4); // a poor Thursday everywhere
            for (let o = 0; o < orders; o++) {
                order++;
                const items = ['Flat White', 'Croissant', 'Oat Milk Latte', 'Tea'];
                const item = items[Math.floor(rnd() * items.length)];
                if (options.dropCafe && lastFullWeek && item === 'Oat Milk Latte') continue; // stopped selling
                rows.push({ order_id: `#${order}`, date, location, item, gross_sales: Math.round((2.5 + rnd() * 2) * 100) / 100 });
            }
        }
    }
    const columns = [
        { name: 'order_id', type: ColumnType.ID }, { name: 'date', type: ColumnType.DATE },
        { name: 'location', type: ColumnType.DIMENSION }, { name: 'item', type: ColumnType.DIMENSION },
        { name: 'gross_sales', type: ColumnType.METRIC, currency: 'GBP' },
    ];
    return { id: 'cafe', name: 'cafe.csv', rows, columns, timeContext: { anchorDateColumn: 'date' } } as any;
}
const TODAY = new Date('2025-11-05T12:00:00Z');

describe('the weekly briefing', () => {
    it('picks the latest full week, and names what explains a bad one', () => {
        const b = buildBriefing(cafe({ dropCafe: true }), TODAY);
        expect(b.status).toBe('ready');
        expect(b.grain).toBe('week');
        // Data runs to Wednesday 5 Nov; the café is closed on Sundays, so 27 Oct–2 Nov is the latest full week.
        expect(b.periodKey).toBe('2025-10-27');
        expect(b.periodLabel).toBe('Last week · 27 Oct – 2 Nov 2025');
        expect(b.headline).toMatch(/^Last week, gross sales came to £[\d,.]+ from [\d,]+ orders — \d+% below a usual week, mostly because of Station\./);
        expect(b.figures.map(f => f.label)).toEqual(['Gross sales', 'Orders', 'Average per order']);
        expect(b.figures[0].tone).toBe('bad');
        const kinds = b.findings.map(f => f.kind);
        expect(kinds[0]).toBe('driver');
        const driver = b.findings[0];
        expect(driver.text).toMatch(/^Station \(location\) accounts for −£/);
        expect(driver.check).toMatch(/Check what changed at Station last week/);
        expect(driver.ask).toBe('Why did gross sales for Station fall last week?');
        const stopped = b.findings.find(f => f.kind === 'stopped');
        expect(stopped?.text).toMatch(/^Oat Milk Latte had no gross sales last week, after about £/);
        const thursday = b.findings.find(f => f.kind === 'weekday');
        expect(thursday?.text).toMatch(/^Thursday 30 Oct: £[\d,.]+, \d+% below a usual Thursday/);
        expect(b.stale).toBeUndefined();
    });

    it('calls a normal week normal and does not invent a cause', () => {
        const b = buildBriefing(cafe(), TODAY);
        expect(b.headline).toMatch(/— a normal week/);
        expect(b.findings.some(f => f.kind === 'driver')).toBe(false);
        expect(b.figures[0].tone).toBe('neutral');
    });

    it('says when the data is out of date', () => {
        const b = buildBriefing(cafe(), new Date('2025-12-01T12:00:00Z'));
        expect(b.periodLabel).toMatch(/the latest full week in your data/);
        expect(b.stale).toMatch(/Your data stops on 5 Nov 2025/);
    });

    it('works for records with an outcome: counts and the outcome rate', () => {
        seed = 11;
        const rows: Record<string, any>[] = [];
        for (let t = Date.UTC(2025, 8, 1); t <= Date.UTC(2025, 10, 2); t += DAY) {
            const date = day(t);
            const late = date >= '2025-10-27';
            for (let i = 0; i < 40; i++) rows.push({ appointment_id: rows.length + 1, appointment_day: date, clinic: i % 2 ? 'North' : 'South', showed_up: rnd() > (late ? 0.4 : 0.15) });
        }
        const ds = { id: 'appts', name: 'appointments.csv', rows, columns: [
            { name: 'appointment_id', type: ColumnType.ID }, { name: 'appointment_day', type: ColumnType.DATE },
            { name: 'clinic', type: ColumnType.DIMENSION }, { name: 'showed_up', type: ColumnType.DIMENSION },
        ], timeContext: { anchorDateColumn: 'appointment_day' } } as any;
        const b = buildBriefing(ds, new Date('2025-11-03T09:00:00Z'));
        expect(b.headline).toMatch(/^Last week, there were 280 appointments/);
        expect(b.figures.map(f => f.label)).toEqual(['Appointments', "% didn't show up"]);
        const rate = b.findings.find(f => f.kind === 'rate');
        expect(rate?.text).toMatch(/^% didn't show up was \d+(\.\d)?% last week, against \d+(\.\d)?% in a usual week — more than chance would explain\./);
        expect(rate?.tone).toBe('bad');
    });

    it('uses months for monthly data', () => {
        const rows = Array.from({ length: 14 }, (_, m) => Array.from({ length: 6 }, (_, k) => ({ month: day(Date.UTC(2024, m, 1)), product: `P${k}`, revenue: 1000 + m * 10 + k }))).flat();
        const ds = { id: 'm', name: 'monthly.csv', rows, columns: [{ name: 'month', type: ColumnType.DATE }, { name: 'product', type: ColumnType.DIMENSION }, { name: 'revenue', type: ColumnType.METRIC }] } as any;
        const b = buildBriefing(ds, new Date('2025-03-10T09:00:00Z'));
        expect(b.grain).toBe('month');
        expect(b.periodLabel).toBe('Last month · February 2025');
    });

    it('says plainly when there is not enough to compare', () => {
        const noDates = buildBriefing({ id: 'x', name: 'x', rows: [{ product: 'A', revenue: 1 }], columns: [{ name: 'product', type: ColumnType.DIMENSION }, { name: 'revenue', type: ColumnType.METRIC }] } as any);
        expect(noDates.status).toBe('not-enough');
        expect(noDates.reason).toMatch(/needs a date column/);
        const fewWeeks = cafe();
        fewWeeks.rows = fewWeeks.rows.filter(r => r.date >= '2025-10-20');
        expect(buildBriefing(fewWeeks, TODAY).reason).toMatch(/at least three full weeks/);
    });

    it('never names a label that changes with the calendar as a cause', () => {
        // The sheet each month's rows came from moves with time itself.
        const ds = cafe({ dropCafe: true });
        ds.rows = ds.rows.map(r => ({ ...r, sheet: r.date.slice(0, 7) }));
        ds.columns = [...ds.columns, { name: 'sheet', type: ColumnType.DIMENSION } as any];
        const b = buildBriefing(ds, TODAY);
        expect(b.findings.some(f => /\(sheet\)/.test(f.text))).toBe(false);
        expect(b.findings[0].text).toMatch(/^Station \(location\)/);
    });

    it('never gives advice that does not fit the column', () => {
        expect(categoryKind('location')).toBe('place');
        expect(categoryKind('lineitem_name')).toBe('offer');
        expect(categoryKind('paid_by')).toBe('channel');
        expect(categoryKind('gender')).toBe('trait');
        expect(categoryKind('status')).toBe('status');
        expect(categoryKind('employee')).toBe('staff');
    });
});

describe('the briefing on real export layouts', () => {
    const exportFile = (file: string) => {
        const parsed = parseDelimitedText(readFileSync(join(process.cwd(), '__tests__', 'golden-exports', file), 'utf8'));
        const r = runETLPipeline(parsed.rows, file);
        return { id: file, name: file, rows: r.rows, columns: r.columns, timeContext: (r as any).timeContext } as any;
    };
    const today = new Date('2026-11-09T09:00:00Z');

    it.each([
        ['square_item_sales.csv', /gross sales came to £[\d,.]+ from \d+ transactions/],
        ['shopify_orders_export.csv', /total came to £[\d,.]+ from \d+ orders/],
        ['sumup_transactions.csv', /total amount came to €[\d,.]+ from \d+ transactions/],
        ['messy_daily_takings.csv', /takings came to £[\d,.]+ —/],
        ['bank_statement.csv', /paid in came to £[\d,.]+ —/],
        ['timesheets.csv', /hours worked came to [\d,.]+ —/],
    ])('%s', (file, headline) => {
        const b = buildBriefing(exportFile(file), today);
        expect(b.status).toBe('ready');
        expect(b.headline).toMatch(headline);
        expect(b.stale).toMatch(/Your data stops on/);
        for (const f of b.findings) {
            expect(f.text).not.toMatch(/NaN|undefined|Infinity|\d{5,}%/);
            expect(f.text).not.toMatch(/^\d{1,2}:\d{2}/); // clock times are not items
            expect(f.text).not.toMatch(/\(status\)/);     // statuses are outcomes, not causes
        }
    });

    it('wide sheets without real dates get a clear reason, not a guess', () => {
        expect(buildBriefing(exportFile('monthly_sales_by_product.csv'), today).status).toBe('not-enough');
    });
});
