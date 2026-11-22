import { describe, expect, it } from 'vitest';
import { buildDataStory, buildDeeperLook } from '../services/dataStory';
import { buildDatasetOverview, buildDeeperOverview } from '../services/ai-sql/datasetOverview';
import { runETLPipeline } from '../services/etlPipeline';
import type { Dataset } from '../types';

// A restaurant file with patterns planted in it: Delivery falls away recently,
// Leeds Delivery does badly, Saturdays are busy, slow dishes get lower ratings.
function restaurant(): Dataset {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const raw: Record<string, unknown>[] = [];
    const items = [['Mains', 'Classic Burger', 14], ['Mains', 'Steak Frites', 22], ['Sides', 'Fries', 4], ['Drinks', 'Fresh Lemonade', 3.5], ['Desserts', 'Brownie', 6]] as const;
    for (let i = 0; i < 3000; i++) {
        const day = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 637) * 86_400_000);
        const iso = day.toISOString().slice(0, 10);
        const location = ['Leeds', 'York', 'Hull'][Math.floor(rnd() * 3)];
        const recent = iso >= '2026-07-01';
        let service = ['Dine-in', 'Takeaway', 'Delivery'][Math.floor(rnd() * 3)];
        if (recent && service === 'Delivery' && rnd() < 0.6) service = 'Dine-in';
        if (location === 'Leeds' && service === 'Delivery' && rnd() < 0.5) continue;
        if (day.getUTCDay() === 6 && rnd() < 0.5) i--; // extra Saturday orders
        const [category, item, price] = items[Math.floor(rnd() * items.length)];
        const quantity = 1 + Math.floor(rnd() * 3);
        const gross = price * quantity;
        const minutes = category === 'Mains' ? 18 + rnd() * 10 : 5 + rnd() * 6;
        raw.push({
            'Order ID': `R${100000 + raw.length}`, 'Order Date': iso, Location: location, 'Service Type': service, 'Menu Category': category, 'Menu Item': item,
            Quantity: quantity, 'Gross Sales': gross.toFixed(2), 'Food Cost': (gross * (category === 'Mains' ? 0.35 : 0.22)).toFixed(2),
            'Preparation Minutes': minutes.toFixed(1), 'Customer Rating': Math.max(1, Math.min(5, 5.6 - minutes / 12 + rnd() * 0.8)).toFixed(1),
        });
    }
    const out = runETLPipeline(raw, '03_Restaurant_Performance_RAW.xlsx');
    return { id: 'r', name: '03_Restaurant_Performance_RAW.xlsx', rows: out.rows, columns: out.columns, etlLogs: out.logs, totalRows: out.rows.length } as unknown as Dataset;
}

describe('a deeper look after the overview', () => {
    const ds = restaurant();
    const overview = buildDatasetOverview(ds);
    const said = [overview.summary, ...overview.insights];

    it('investigates things the overview did not say, with reasons', () => {
        const look = buildDeeperLook(ds, 1, said);
        expect(look.findings.length).toBeGreaterThanOrEqual(3);
        for (const f of look.findings) {
            expect(said.some(s => s.startsWith(f.headline))).toBe(false);
            expect(f.points.length).toBeGreaterThan(0);
        }
        const ids = look.findings.map(f => f.id);
        expect(ids).toEqual(expect.arrayContaining(['deeper_recent']));
        const recent = look.findings.find(f => f.id === 'deeper_recent')!;
        expect(recent.headline).toMatch(/service type explains most of it|explains most of it/);
        expect(look.summary).toMatch(/^Past the headline numbers, I looked into /);
        // Never a combination that cannot happen (a burger is never a side).
        const hotspot = look.findings.find(f => f.id === 'deeper_hotspot');
        if (hotspot) expect(hotspot.headline).not.toMatch(/Sides · Classic Burger|menu category and menu item/);
        // eslint-disable-next-line no-console
        console.log([look.title, look.summary, ...look.findings.map(f => `- ${f.headline} | ${f.points[0]}`)].join('\n'));
    });

    it('goes further each time it is asked, never repeating, and says when it has run out', () => {
        const first = buildDeeperOverview(ds, 1, said);
        const second = buildDeeperOverview(ds, 2, [...said, first.summary, ...first.insights]);
        expect(first.insights.length).toBeGreaterThan(0);
        expect(second.title).toMatch(/^Digging further into/);
        for (const line of second.insights) expect(first.insights).not.toContain(line);
        let all = [...said, ...first.insights, ...second.insights];
        let last = second;
        for (let depth = 3; depth < 10 && !last.exhausted; depth++) { last = buildDeeperOverview(ds, depth, all); all = [...all, ...last.insights]; }
        expect(last.exhausted).toBe(true);
        expect(last.summary).toMatch(/That is everything that stands out/);
        // eslint-disable-next-line no-console
        console.log(['', second.title, second.summary, ...second.insights.map(i => `- ${i}`)].join('\n'));
    });

    it('still answers for a file of records with no amounts', () => {
        const records = { ...ds, rows: ds.rows.map(r => ({ order_id: r.order_id, order_date: r.order_date, location: r.location, service_type: r.service_type })), columns: ds.columns.filter(c => ['order_id', 'order_date', 'location', 'service_type'].includes(c.name)) } as Dataset;
        expect(() => buildDeeperLook(records, 1, [])).not.toThrow();
        expect(buildDataStory(records).rowCount).toBe(ds.rows.length);
    });
});
