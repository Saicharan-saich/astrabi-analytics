/**
 * Test-suite (multi-instance) evaluation core.
 * Proves the central claim: a WRONG query that coincidentally matches gold on
 * the original data diverges once the data is bootstrap-resampled — so requiring
 * a match across multiple instances removes that false positive. Deterministic,
 * no LLM, real DuckDB via the Node harness.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { resampleTables, mulberry32 } from '../services/benchmark/resample';
import { compareResults } from '../services/benchmark/resultCompare';

describe('resampleTables', () => {
    it('preserves schema and row count, changes the row multiset', () => {
        const rng = mulberry32(42);
        const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, v: i * 2 }));
        const [t] = resampleTables([{ name: 't', rows }], rng);
        expect(t.rows).toHaveLength(50);
        expect(Object.keys(t.rows[0])).toEqual(['id', 'v']);
        // With replacement, at least one id repeats (multiset changed).
        const ids = new Set(t.rows.map(r => r.id));
        expect(ids.size).toBeLessThan(50);
    });
    it('leaves ≤1-row tables unchanged and is deterministic per seed', () => {
        expect(resampleTables([{ name: 't', rows: [{ a: 1 }] }], mulberry32(1))[0].rows).toEqual([{ a: 1 }]);
        const a = resampleTables([{ name: 't', rows: [{ x: 1 }, { x: 2 }, { x: 3 }] }], mulberry32(7))[0].rows;
        const b = resampleTables([{ name: 't', rows: [{ x: 1 }, { x: 2 }, { x: 3 }] }], mulberry32(7))[0].rows;
        expect(a).toEqual(b);
    });
});

describe('multi-instance evaluation catches a coincidental single-instance match', () => {
    let duck: DuckHandle;
    beforeAll(async () => { duck = await createDuck(); }, 60000);
    afterAll(() => duck?.close());

    // A database where, on the ORIGINAL rows, a WRONG query coincidentally equals gold.
    // gold:  SELECT COUNT(*) FROM t WHERE status='A'   → rows 1,2  (count 2)
    // wrong: SELECT COUNT(*) FROM t WHERE amount > 100 → rows 3,4  (count 2)
    // The two predicates select DISJOINT rows that happen to be equal in count.
    // Bootstrap resampling draws A-rows and high-amount rows independently, so the
    // counts diverge on some instance — breaking the coincidence.
    const rows = [
        { id: 1, status: 'A', amount: 10 },
        { id: 2, status: 'A', amount: 10 },
        { id: 3, status: 'B', amount: 500 },
        { id: 4, status: 'B', amount: 500 },
        { id: 5, status: 'B', amount: 10 },
        { id: 6, status: 'C', amount: 10 },
    ];
    const GOLD = "SELECT COUNT(*) AS n FROM t WHERE status='A'";
    const WRONG = 'SELECT COUNT(*) AS n FROM t WHERE amount > 100';

    const run = (rs: { name: string; rows: any[] }[], sql: string) => {
        for (const t of rs) duck.loadTable(t.name, t.rows);
        const out = duck.query(sql);
        return out;
    };

    it('matches on the original instance (the false positive)', () => {
        const gold = run([{ name: 't', rows }], GOLD);
        const wrong = run([{ name: 't', rows }], WRONG);
        expect(compareResults(gold, wrong).match).toBe(true); // coincidental match
    });

    it('diverges on at least one resampled instance → test-suite marks it wrong', () => {
        const rng = mulberry32(123);
        let robust = true;
        let checked = 0;
        for (let k = 0; k < 5 && robust; k++) {
            const [rt] = resampleTables([{ name: 't', rows }], rng);
            const gold = run([{ name: 't', rows: rt.rows }], GOLD);
            if (gold.length === 0) continue;
            const wrong = run([{ name: 't', rows: rt.rows }], WRONG);
            checked++;
            if (!compareResults(gold, wrong).match) robust = false;
        }
        expect(checked).toBeGreaterThan(0);
        expect(robust).toBe(false); // the coincidence did NOT survive resampling
    });

    it('a genuinely correct query stays correct across resamples', () => {
        const rng = mulberry32(999);
        const CORRECT = "SELECT COUNT(*) AS cnt FROM t WHERE status = 'A'"; // same as gold, different alias
        let robust = true;
        for (let k = 0; k < 5 && robust; k++) {
            const [rt] = resampleTables([{ name: 't', rows }], rng);
            const gold = run([{ name: 't', rows: rt.rows }], GOLD);
            if (gold.length === 0) continue;
            const got = run([{ name: 't', rows: rt.rows }], CORRECT);
            if (!compareResults(gold, got).match) robust = false;
        }
        expect(robust).toBe(true);
    });
});
