/**
 * Helping a first-time owner: one-click starts for an empty Question Builder,
 * built from the data's shape, and an honest route in for stores that cannot
 * be connected directly yet (never made-up rows).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { builderStarters } from '../services/builderStarters';
import { SOURCE_GUIDES, connectsDirectly } from '../services/sourceGuides';
import { getMockConnectorData } from '../services/analysisEngine';
import { OWNER_BENCHMARK_SUITE } from '../services/benchmark/ownerFixtures.generated';

const owner = (tag: string) => {
    const c = OWNER_BENCHMARK_SUITE.cases.find(x => x.tags.includes(tag))!;
    return JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'public', c.datasetRef!))).toString('utf8'));
};

describe('Question Builder starts', () => {
    it('offers the main amount over time, by what owners split by, and in total', () => {
        const starters = builderStarters(owner('cafe'));
        expect(starters.map(s => s.label)).toEqual(['Net sales month by month', 'Net sales by category', 'Net sales by item', 'Total net sales']);
        expect(starters[0].config).toEqual({ metric: 'net_sales', aggregation: 'SUM', dimension: 'month', sort: 'oldest' });
        expect(starters[1].config).toMatchObject({ metric: 'net_sales', dimension: 'category' });
    });

    it('never shows a code name, and offers nothing when there is nothing to add up', () => {
        for (const tag of ['cafe', 'shop', 'online']) for (const s of builderStarters(owner(tag))) expect(s.label).not.toMatch(/_|→/);
        expect(builderStarters({ id: 'x', name: 'x', rows: [{ a: 'x' }], columns: [{ name: 'a', type: 'DIMENSION' }] } as any)).toEqual([]);
    });
});

describe('stores without a direct connection', () => {
    it('explain how to export, instead of pretending to connect', async () => {
        expect(connectsDirectly('postgres')).toBe(true);
        expect(connectsDirectly('mssql')).toBe(true);
        for (const id of ['shopify', 'woocommerce', 'mysql']) {
            expect(connectsDirectly(id)).toBe(false);
            expect(SOURCE_GUIDES[id].steps).toHaveLength(3);
            expect(SOURCE_GUIDES[id].lead).toMatch(/isn't available yet/);
        }
        // Without a live connection nothing is read — never sample rows passed off as the user's.
        expect(await getMockConnectorData()).toEqual({});
    });
});
