/**
 * The moment data is ready: the pop-up's plain summary of what was done, and
 * the first questions AI SQL offers — worded the way owners ask, built from
 * the data's shape and column names only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { summariseDataReady } from '../services/dataReadySummary';
import { starterQuestions } from '../services/ai-sql/starterQuestions';
import { spokenName } from '../utils/spokenName';
import { OWNER_BENCHMARK_SUITE } from '../services/benchmark/ownerFixtures.generated';

const owner = (tag: string) => {
    const c = OWNER_BENCHMARK_SUITE.cases.find(x => x.tags.includes(tag))!;
    const ds = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'public', c.datasetRef!))).toString('utf8'));
    return { ...ds, etlLogs: ds.etlLogs || [] };
};

describe('the "data is ready" summary', () => {
    it('says what the data holds and what the cleaning did, in plain words', () => {
        const ds = owner('cafe');
        ds.etlLogs = [
            { step: 'Duplicate Row Removal', status: 'applied', timestamp: 1, details: 'Removed 3 exact duplicate row(s).', rowsBefore: 10, rowsAfter: 7 },
            { step: 'Orders · Null Token Standardization', status: 'applied', timestamp: 1, details: 'Converted 14 null token(s) to NULL in 2 column(s).', affectedRows: 14 },
            { step: 'Outlier Flag', status: 'info', timestamp: 1, details: "Column 'net_sales': 6 value(s) outside the expected range.", affectedColumns: ['net_sales'] },
        ];
        const s = summariseDataReady(ds);
        expect(s.name).toBe('cafe square items');
        expect(s.facts).toBe('22,951 rows · 17 columns · Jul 2026 – Nov 2026');
        expect(s.changes).toContain('Removed 3 duplicate rows');
        expect(s.changes.some(c => /14/.test(c))).toBe(true); // a per-sheet step is still summarised
        expect(s.toCheck).toBe(1);
        expect(s.links).toEqual([]);
    });

    it('lists the sheets it linked', () => {
        const ds = owner('shop');
        ds.sourceTables = [{ name: 'Sales', rows: [] }, { name: 'Products', rows: [] }];
        ds.relationalCatalog = { version: 1, subjects: [], rejected: [], schema: { tables: [], joinLogs: [], joinEdges: [{ leftTable: 'Sales', leftColumn: 'sku', rightTable: 'Products', rightColumn: 'sku', type: 'fk' }] } };
        const s = summariseDataReady(ds);
        expect(s.links).toEqual(['Sales → Products']);
        expect(s.facts).toMatch(/2 sheets/);
    });
});

describe('first questions on an empty AI SQL screen', () => {
    it('ask about the money people mean, in their words', () => {
        expect(starterQuestions(owner('cafe')).slice(0, 4)).toEqual([
            'What were my total net sales last month?',
            'Which category brings in the most net sales?',
            'How have net sales changed month by month?',
            "What's the average spend per transaction?",
        ]);
        expect(starterQuestions(owner('cafe'))).toContain('How many customers came back more than once?');
        // "line total" and "total" are sales to an owner.
        expect(starterQuestions(owner('shop'))[0]).toBe('What were my total sales last month?');
        expect(starterQuestions(owner('online'))).toContain("What's the average spend per order?");
    });

    it('never shows a column path or a code name', () => {
        for (const tag of ['cafe', 'shop', 'online']) {
            for (const q of starterQuestions(owner(tag))) expect(q).not.toMatch(/_|→|\btotal total\b/);
        }
        expect(spokenName('sku → Products.title')).toBe('product');
        expect(spokenName('order → Orders / email → Customers.city')).toBe('city');
        expect(spokenName('lineitem_name')).toBe('product');
    });
});
