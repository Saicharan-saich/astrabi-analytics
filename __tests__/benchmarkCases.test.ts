/**
 * Validates the benchmark harness core: every GOLD SQL must execute against its
 * mini-database (a broken gold answer makes a benchmark worthless), and the
 * execution/denotation comparison must behave correctly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { BENCHMARK_CASES } from '../services/benchmark/spiderCases';
import { compareResults, normalizeCell } from '../services/benchmark/resultCompare';

let duck: DuckHandle;
beforeAll(async () => { duck = await createDuck(); }, 60000);
afterAll(() => duck?.close());

describe('every gold SQL executes and returns a well-formed result', () => {
    for (const c of BENCHMARK_CASES) {
        it(`${c.id} — ${c.question}`, () => {
            // Fresh load of this case's tables.
            for (const t of c.tables) duck.loadTable(t.name, t.rows);
            const rows = duck.query(c.goldSQL);
            expect(Array.isArray(rows)).toBe(true);
            // Gold must be answerable (non-empty) for these designed cases.
            expect(rows.length).toBeGreaterThan(0);
            // Clean up so table-name reuse across DBs (e.g. employee) stays fresh.
            for (const t of c.tables) duck.query(`DROP TABLE IF EXISTS "${t.name}"`);
        });
    }
});

describe('case metadata is internally consistent', () => {
    it('tableCount matches whether more than one table is referenced', () => {
        for (const c of BENCHMARK_CASES) {
            expect(c.tables.length).toBeGreaterThanOrEqual(c.tableCount);
            expect(c.tables.some(t => t.name === c.primaryTable)).toBe(true);
        }
    });
    it('ids are unique', () => {
        const ids = BENCHMARK_CASES.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
    it('covers both single- and multi-table cases', () => {
        expect(BENCHMARK_CASES.some(c => c.tableCount === 1)).toBe(true);
        expect(BENCHMARK_CASES.some(c => c.tableCount > 1)).toBe(true);
    });
});

describe('normalizeCell', () => {
    it('treats numeric strings and numbers alike', () => {
        expect(normalizeCell('62000')).toBe(normalizeCell(62000));
        expect(normalizeCell('$1,200')).toBe(normalizeCell(1200));
    });
    it('rounds floats to tolerance and folds -0', () => {
        expect(normalizeCell(4.00000001)).toBe('4');
        expect(normalizeCell(-0)).toBe('0');
    });
    it('lowercases/trims strings and marks blanks', () => {
        expect(normalizeCell('  France ')).toBe('france');
        expect(normalizeCell(null)).toBe('∅');
        expect(normalizeCell('')).toBe('∅');
    });
});

describe('compareResults — execution accuracy', () => {
    it('scalar answer matches even with an extra label column', () => {
        const gold = [{ n: 6 }];
        const sys = [{ singer_count: 6, label: 'Total singers' }];
        expect(compareResults(gold, sys).match).toBe(true);
    });

    it('scalar mismatch is caught', () => {
        expect(compareResults([{ n: 6 }], [{ x: 7 }]).match).toBe(false);
    });

    it('row multiset matches regardless of column names/order', () => {
        const gold = [{ country: 'France', n: 3 }, { country: 'USA', n: 2 }];
        const sys = [{ n: 2, country: 'USA' }, { country: 'France', n: 3 }];
        expect(compareResults(gold, sys).match).toBe(true);
    });

    it('honors ORDER BY when orderMatters', () => {
        const gold = [{ name: 'Omar Vale' }, { name: 'Aria Blue' }, { name: 'Mia Stone' }];
        const wrongOrder = [{ name: 'Aria Blue' }, { name: 'Mia Stone' }, { name: 'Omar Vale' }];
        const right = compareResults(gold, gold, { orderMatters: true });
        const wrong = compareResults(gold, wrongOrder, { orderMatters: true });
        expect(right.match).toBe(true);
        expect(wrong.match).toBe(false);
        expect(wrong.reason).toMatch(/order/i);
    });

    it('ignores pipeline helper columns', () => {
        const gold = [{ month: '2024-01', revenue: 1000 }];
        const sys = [{ month: '2024-01', revenue: 1000, growth_pct: 12.5, running_total: 1000 }];
        expect(compareResults(gold, sys).match).toBe(true);
    });

    it('different row counts do not match', () => {
        const gold = [{ a: 1 }, { a: 2 }];
        expect(compareResults(gold, [{ a: 1 }]).match).toBe(false);
    });
});
