/**
 * Validates the benchmark harness core: every GOLD SQL must execute against its
 * mini-database (a broken gold answer makes a benchmark worthless), and the
 * execution/denotation comparison must behave correctly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { BENCHMARK_CASES } from '../services/benchmark/spiderCases';
import { compareResults, normalizeCell } from '../services/benchmark/resultCompare';
import { autoJoinDatasets } from '../services/analysisEngine';

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

// Equivalent SINGLE-table SQL over the denormalized master table — this is the
// shape the AI-SQL pipeline must produce after the app widens the tables. If the
// master table can answer each multi-table question identically to the gold
// multi-table SQL, the denormalize→single-table path is sound (independent of
// the LLM). This is the direct code-level answer to "multi-table joins work".
const MASTER_EQUIVALENT_SQL: Record<string, string> = {
    'spider-concert-stadium-join': 'SELECT DISTINCT name FROM master',
    'spider-concert-capacity-join': 'SELECT concert_name, capacity FROM master',
    'spider-singers-in-gala': "SELECT name FROM master WHERE concert_name = 'Gala'",
    'spider-emp-avg-salary-by-shop': 'SELECT shop_name, AVG(salary) AS avg_salary FROM master GROUP BY shop_name',
    'spider-customer-most-orders': 'SELECT customer_name FROM master GROUP BY customer_name ORDER BY COUNT(*) DESC LIMIT 1',
    'spider-customer-total-spend': 'SELECT customer_name, SUM(amount) AS total FROM master GROUP BY customer_name',
};

describe('multi-table cases: denormalize (autoJoinDatasets) → single-table query equals gold', () => {
    const multi = BENCHMARK_CASES.filter(c => c.tableCount > 1);
    for (const c of multi) {
        it(`${c.id} — master table reproduces the gold answer`, () => {
            // Ground truth from the ORIGINAL normalized multi-table gold SQL.
            for (const t of c.tables) duck.loadTable(t.name, t.rows);
            const gold = duck.query(c.goldSQL);
            for (const t of c.tables) duck.query(`DROP TABLE IF EXISTS "${t.name}"`);

            // The app's real join: merge the tables into one master table.
            const tableMap: Record<string, any[]> = {};
            for (const t of c.tables) tableMap[t.name] = t.rows;
            const { mergedRows } = autoJoinDatasets(tableMap, c.joinEdges);
            expect(mergedRows.length).toBeGreaterThan(0);

            // A single-table query over the master must match the gold.
            duck.loadTable('master', mergedRows);
            const overMaster = duck.query(MASTER_EQUIVALENT_SQL[c.id]);
            duck.query('DROP TABLE IF EXISTS "master"');

            const cmp = compareResults(gold, overMaster, { orderMatters: c.orderMatters });
            expect(cmp.match, `${c.id}: ${cmp.reason}`).toBe(true);
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
