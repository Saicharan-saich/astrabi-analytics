/**
 * BENCHMARK REGRESSION GATE (deterministic).
 * ─────────────────────────────────────────────────────────────────────
 * This is the CI safety net for the Benchmark Lab's ground truth and the app's
 * ingestion path. It does NOT call the LLM (that needs a key + browser); it
 * asserts the parts that MUST stay green on every commit:
 *   1. Every built-in gold SQL still executes and returns a well-formed result.
 *   2. Every multi-table case still reproduces its gold answer through the real
 *      denormalize (autoJoinDatasets) → single-table query path.
 * If either drops below threshold the build fails — the "accuracy 92% → 89%
 * fails the build" idea, applied to the deterministic guarantees we control.
 *
 * The full engine-accuracy gate (with the live planner) runs in the browser via
 * the Benchmark Lab and is documented in research/benchmark/README.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { ALL_BUILTIN_CASES } from '../services/benchmark/registry';
import { autoJoinDatasets } from '../services/analysisEngine';
import { compareResults } from '../services/benchmark/resultCompare';

const HARNESS_INTEGRITY_THRESHOLD = 1.0; // 100% — these are guarantees, not estimates.

// Equivalent single-table SQL over the denormalized master table for EVERY
// multi-table case. The pipeline must produce a query of this shape after the
// app widens the tables; here we prove the widening preserves the gold answer.
const MASTER_EQUIVALENT_SQL: Record<string, string> = {
    'spider-concert-stadium-join': 'SELECT DISTINCT name FROM master',
    'spider-concert-capacity-join': 'SELECT concert_name, capacity FROM master',
    'spider-singers-in-gala': "SELECT name FROM master WHERE concert_name = 'Gala'",
    'spider-emp-avg-salary-by-shop': 'SELECT shop_name, AVG(salary) AS avg_salary FROM master GROUP BY shop_name',
    'spider-customer-most-orders': 'SELECT customer_name FROM master GROUP BY customer_name ORDER BY COUNT(*) DESC LIMIT 1',
    'spider-customer-total-spend': 'SELECT customer_name, SUM(amount) AS total FROM master GROUP BY customer_name',
    'internal-revenue-by-region': 'SELECT region_name, SUM(revenue) AS revenue FROM master GROUP BY region_name',
    'internal-revenue-by-category': 'SELECT category, SUM(revenue) AS revenue FROM master GROUP BY category',
    'internal-top-product': 'SELECT product_name FROM master GROUP BY product_name ORDER BY SUM(revenue) DESC LIMIT 1',
    'internal-revenue-by-product-region': 'SELECT category, region_name, SUM(revenue) AS revenue FROM master GROUP BY category, region_name',
};

let duck: DuckHandle;
beforeAll(async () => { duck = await createDuck(); }, 60000);
afterAll(() => duck?.close());

describe('regression gate: gold SQL integrity', () => {
    it(`≥ ${HARNESS_INTEGRITY_THRESHOLD * 100}% of built-in gold SQL executes`, () => {
        let ok = 0;
        const failures: string[] = [];
        for (const c of ALL_BUILTIN_CASES) {
            try {
                for (const t of c.tables) duck.loadTable(t.name, t.rows);
                const rows = duck.query(c.goldSQL);
                if (Array.isArray(rows) && rows.length > 0) ok++; else failures.push(c.id);
            } catch (e: any) {
                failures.push(`${c.id}: ${e.message}`);
            } finally {
                for (const t of c.tables) duck.query(`DROP TABLE IF EXISTS "${t.name}"`);
            }
        }
        const rate = ok / ALL_BUILTIN_CASES.length;
        expect(rate, `gold SQL failures: ${failures.join('; ')}`).toBeGreaterThanOrEqual(HARNESS_INTEGRITY_THRESHOLD);
    });
});

describe('regression gate: denormalize → single-table reproduces gold', () => {
    const multi = ALL_BUILTIN_CASES.filter(c => c.tableCount > 1);

    it('every multi-table case has a master-equivalent defined', () => {
        const missing = multi.filter(c => !MASTER_EQUIVALENT_SQL[c.id]).map(c => c.id);
        expect(missing, `add MASTER_EQUIVALENT_SQL for: ${missing.join(', ')}`).toEqual([]);
    });

    it(`≥ ${HARNESS_INTEGRITY_THRESHOLD * 100}% reproduce gold through autoJoinDatasets`, () => {
        let ok = 0;
        const failures: string[] = [];
        for (const c of multi) {
            for (const t of c.tables) duck.loadTable(t.name, t.rows);
            const gold = duck.query(c.goldSQL);
            for (const t of c.tables) duck.query(`DROP TABLE IF EXISTS "${t.name}"`);

            const tableMap: Record<string, any[]> = {};
            for (const t of c.tables) tableMap[t.name] = t.rows;
            const { mergedRows } = autoJoinDatasets(tableMap, c.joinEdges);

            duck.loadTable('master', mergedRows);
            const overMaster = duck.query(MASTER_EQUIVALENT_SQL[c.id]);
            duck.query('DROP TABLE IF EXISTS "master"');

            const cmp = compareResults(gold, overMaster, { orderMatters: c.orderMatters });
            if (cmp.match) ok++; else failures.push(`${c.id}: ${cmp.reason}`);
        }
        const rate = multi.length ? ok / multi.length : 1;
        expect(rate, `denormalization failures: ${failures.join('; ')}`).toBeGreaterThanOrEqual(HARNESS_INTEGRITY_THRESHOLD);
    });
});
