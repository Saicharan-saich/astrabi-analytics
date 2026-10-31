import { describe, expect, it } from 'vitest';
import { buildAutoReport, recomputeAutoCard } from '../services/autoAnalysis';
import { chooseFocus, prepare, parseDate } from '../services/autoAnalysis/core';
import { analyzeConcentration, analyzeDrivers, analyzeMix, compareWindows, latestPair } from '../services/autoAnalysis/analyzers';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';

const columns = [
    { name: 'order_id', type: 'ID' },
    { name: 'order_date', type: 'DATE' },
    { name: 'category', type: 'DIMENSION' },
    { name: 'region', type: 'DIMENSION' },
    { name: 'revenue', type: 'METRIC' },
    { name: 'profit', type: 'METRIC' },
];

type Row = { order_id: string; order_date: string; category: string; region: string; revenue: number; profit: number };
const dataset = (rows: Row[]) => ({ id: 't', name: 'Sales', rows, columns, totalRows: rows.length, etlLogs: [] } as any);

let seq = 0;
/** n orders on day `day` of month `m` (1-based) in 2025. */
function orders(m: number, day: number, n: number, category: string, region: string, revenue: number, profit = revenue * 0.2): Row[] {
    return Array.from({ length: n }, () => ({
        order_id: `O${++seq}`,
        order_date: `2025-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        category, region, revenue, profit,
    }));
}

/** Jan–May complete (orders on the 1st and the 28th), plus a few days of June. */
function baseRows(): Row[] {
    const rows: Row[] = [];
    for (const m of [1, 2, 3, 4, 5]) {
        for (const day of [1, 28]) {
            rows.push(...orders(m, day, 5, 'Electronics', 'North', 200));
            rows.push(...orders(m, day, 5, 'Apparel', 'South', 50));
            rows.push(...orders(m, day, 2, 'Toys', 'North', 30));
        }
    }
    // May: Electronics +1,000 on top of the regular pattern.
    rows.push(...orders(5, 15, 5, 'Electronics', 'North', 200));
    // June has only 5 days of data.
    rows.push(...orders(6, 5, 3, 'Apparel', 'South', 50));
    return rows;
}

describe('auto analysis — preparation', () => {
    it('parses common date formats', () => {
        expect(parseDate('2025-03-28')).toBe(Date.UTC(2025, 2, 28));
        expect(parseDate('28/03/2025')).toBe(Date.UTC(2025, 2, 28));
        expect(parseDate('2025-03')).toBe(Date.UTC(2025, 2, 1));
        expect(Number.isNaN(parseDate(''))).toBe(true);
    });

    it('picks revenue, an order count, average order value and margin', () => {
        const focus = chooseFocus(dataset(baseRows()));
        expect(focus.metrics[0]).toMatchObject({ kind: 'sum', column: 'revenue' });
        expect(focus.metrics.map(m => m.id)).toEqual(expect.arrayContaining(['count:order_id', 'ratio:revenue/per', 'ratio:profit/revenue']));
        expect(focus.noun.many).toBe('orders');
        expect(focus.dims.map(d => d.column)).toEqual(expect.arrayContaining(['category', 'region']));
    });

    it('leaves an incomplete latest month out of comparisons', () => {
        const ds = dataset(baseRows());
        const prep = prepare(ds.rows, chooseFocus(ds));
        expect(prep.focus.grain).toBe('month');
        expect(prep.partial.map(p => p.key)).toContain('2025-06');
        expect(latestPair(prep)).toMatchObject({ cur: { key: '2025-05' }, prev: { key: '2025-04' } });
        const report = buildAutoReport(ds);
        expect(report.notes.join(' ')).toMatch(/Jun 2025 is incomplete/);
        expect(report.kpis[0].card.data[0]).toMatchObject({ label: 'May 2025', previous_label: 'Apr 2025' });
    });
});

describe('auto analysis — findings', () => {
    it('attributes a change to the member that drove it, and the bridge adds up', () => {
        const ds = dataset(baseRows());
        const prep = prepare(ds.rows, chooseFocus(ds));
        const finding = analyzeDrivers(prep, 'sum:revenue')!;
        expect(finding).not.toBeNull();
        expect(finding.title).toMatch(/^Electronics drove most of the rise in revenue/);
        const data = finding.card.data;
        expect(data[0]).toMatchObject({ label: 'Apr 2025', __kind: 'total' });
        expect(data[data.length - 1]).toMatchObject({ label: 'May 2025', __kind: 'total' });
        const steps = data.slice(1, -1).reduce((sum, row) => sum + row.value, 0);
        expect(data[0].value + steps).toBeCloseTo(data[data.length - 1].value, 6);
    });

    it('splits a ratio change into mix and within-segment effects that add up exactly', () => {
        const rows: Row[] = [];
        // Same price per category every month; May sells relatively more cheap Apparel.
        for (const m of [1, 2, 3, 4]) for (const day of [1, 28]) {
            rows.push(...orders(m, day, 5, 'Electronics', 'North', 200));
            rows.push(...orders(m, day, 5, 'Apparel', 'South', 50));
            rows.push(...orders(m, day, 5, 'Toys', 'North', 30));
        }
        for (const day of [1, 28]) {
            rows.push(...orders(5, day, 2, 'Electronics', 'North', 200));
            rows.push(...orders(5, day, 10, 'Apparel', 'South', 50));
            rows.push(...orders(5, day, 5, 'Toys', 'North', 30));
        }
        const ds = dataset(rows);
        const prep = prepare(ds.rows, chooseFocus(ds));
        const finding = analyzeMix(prep, 'ratio:revenue/per', 'category')!;
        expect(finding).not.toBeNull();
        expect(finding.title).toMatch(/fell .*mostly a shift in mix/);
        const total = finding.card.data.reduce((sum, row) => sum + row.value, 0);
        // Apr AOV = (10·200+10·50+10·30)/30 = 93.33; May = (4·200+20·50+10·30)/34 = 61.76.
        expect(total).toBeCloseTo(2100 / 34 - 2800 / 30, 3);
        // No price changed, so every within-category effect is zero.
        expect(finding.card.data.slice(1).every(row => Math.abs(row.value) < 1e-9)).toBe(true);
    });

    it('flags a dominant member and never treats an average as a share', () => {
        const ds = dataset(baseRows());
        const prep = prepare(ds.rows, chooseFocus(ds));
        const finding = analyzeConcentration(prep, 'sum:revenue', 'category')!;
        expect(finding.title).toMatch(/^Electronics accounts for \d+% of revenue/);
        expect(finding.tone).toBe('attention');
        expect(analyzeConcentration(prep, 'ratio:revenue/per')).toBeNull();
        expect(analyzeConcentration(prep, 'ratio:profit/revenue')).toBeNull();
    });

    it('compares like with like over longer histories', () => {
        const rows: Row[] = [];
        for (let m = 1; m <= 12; m++) for (const day of [1, 28]) rows.push(...orders(m, day, 2, 'Apparel', 'South', 50));
        const prep = prepare(rows, chooseFocus(dataset(rows)));
        expect(compareWindows(prep)?.label).toBe('last 3 months vs the 3 before');
    });

    it('builds a ranked report with a summary and a trend first', () => {
        const rows: Row[] = [];
        for (let m = 1; m <= 12; m++) for (const day of [1, 28]) {
            rows.push(...orders(m, day, 4 + m, 'Electronics', 'North', 200));
            rows.push(...orders(m, day, 6, 'Apparel', 'South', 50));
            rows.push(...orders(m, day, 3, 'Toys', m > 6 ? 'North' : 'South', 30));
        }
        const report = buildAutoReport(dataset(rows));
        expect(report.findings[0].analyzer).toBe('trend');
        expect(report.findings[0].title).toMatch(/^Revenue is up \d+%/);
        expect(report.summary.length).toBeGreaterThanOrEqual(3);
        expect(report.findings.every(f => f.card.data.length > 0)).toBe(true);
        expect(report.scope).toMatch(/orders · Jan 2025 – Dec 2025 · by month/);
    });

    it('recomputes a card from its spec on filtered rows', () => {
        const ds = dataset(baseRows());
        const report = buildAutoReport(ds);
        const trend = report.findings.find(f => f.analyzer === 'trend') || report.findings[0];
        const filtered = ds.rows.filter((row: Row) => row.region === 'North');
        const again = recomputeAutoCard(trend.spec, filtered)!;
        expect(again).not.toBeNull();
        expect(again.card.data.length).toBeGreaterThan(0);
    });

    it('syncs the recipe to the cloud but not the findings', () => {
        const report = buildAutoReport(dataset(baseRows()));
        const finding = report.findings[0];
        const clean = sanitizeDashboard({
            id: 'd', name: 'Overview',
            items: [{ id: 'i', title: 'Revenue by month', note: finding.title, width: 'full', result: { xKey: 'period', yKey: 'value', data: finding.card.data, insight: finding.title, autoAnalysis: finding.spec } }],
        });
        expect(clean.items[0].note).toBeUndefined();
        expect(clean.items[0].result.insight).toBe('');
        expect(clean.items[0].result.autoAnalysis).toMatchObject({ analyzer: finding.analyzer, metricId: finding.spec.metricId });
        expect(clean.items[0].result.autoAnalysis.focus.metrics[0]).toMatchObject({ column: 'revenue' });
    });
});
