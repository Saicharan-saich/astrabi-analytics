/**
 * The owner benchmark's answers, checked by a second engine before release:
 * every gold query (and every other accepted reading) is run in DuckDB on the
 * datasets loaded exactly as the app loads them, and must give the answer that
 * was worked out separately in pandas. A top-N cut-off must not split a tie.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createDuck, type DuckHandle } from './helpers/duckdbNode';
import { OWNER_BENCHMARK_SUITE } from '../services/benchmark/ownerFixtures.generated';
import { compareResultSets } from '../services/benchmark/comparator';

const datasets = new Map<string, any>();
const dataset = (ref: string, sha: string) => {
    if (!datasets.has(ref)) {
        const bytes = gunzipSync(readFileSync(join(process.cwd(), 'public', ref)));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
        datasets.set(ref, JSON.parse(bytes.toString('utf8')));
    }
    return datasets.get(ref);
};
const plain = (rows: any[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])));

let duck: DuckHandle;
beforeAll(async () => { duck = await createDuck(); }, 60000);
afterAll(() => duck?.close());

describe('owner benchmark answers agree in DuckDB and pandas', () => {
    const byDataset = new Map<string, typeof OWNER_BENCHMARK_SUITE.cases>();
    for (const c of OWNER_BENCHMARK_SUITE.cases) byDataset.set(c.datasetRef!, [...(byDataset.get(c.datasetRef!) || []), c]);

    for (const [ref, cases] of byDataset) {
        it(`${ref.split('/').pop()}: ${cases.length} questions`, () => {
            const ds = dataset(ref, cases[0].datasetSha256!);
            duck.loadTableLikeApp('data', ds.rows);
            const problems: string[] = [];
            for (const c of cases) {
                const readings = [{ reading: 'main', goldSql: c.goldSql, expectedRows: c.expectedRows }, ...(c.goldAlternatives || [])];
                for (const r of readings) {
                    let got: any[];
                    try { got = plain(duck.query(r.goldSql)); } catch (error) { problems.push(`${c.id} (${r.reading}): ${String(error).slice(0, 200)}`); continue; }
                    const cmp = compareResultSets(r.expectedRows, got, { ...c.comparison, orderMatters: false, strictColumns: true });
                    if (!cmp.equal) problems.push(`${c.id} (${r.reading}): ${cmp.reason} expected ${JSON.stringify(r.expectedRows).slice(0, 160)} got ${JSON.stringify(got).slice(0, 160)}`);
                    // A top-N must not cut through equal values: the next row has to be different.
                    const limit = /\sLIMIT\s+(\d+)\s*$/i.exec(r.goldSql);
                    if (limit) {
                        const n = Number(limit[1]);
                        const all = plain(duck.query(r.goldSql.replace(/\sLIMIT\s+\d+\s*$/i, '')));
                        const key = Object.keys(all[0] || {}).pop()!;
                        if (all.length > n && Number(all[n - 1][key]) === Number(all[n][key])) problems.push(`${c.id} (${r.reading}): a tie at the LIMIT ${n} cut-off`);
                    }
                }
            }
            expect(problems).toEqual([]);
        }, 120000);
    }

    it('date and time text casts the way the AI is told', () => {
        const [row] = plain(duck.query(`SELECT CAST(CAST('2025-11-05T17:49:43' AS TIMESTAMP) AS DATE)::VARCHAR AS day, HOUR(CAST('2025-11-05T17:49:43' AS TIMESTAMP)) AS h, CAST(SPLIT_PART('07:04:23', ':', 1) AS INTEGER) AS clock_hour`));
        expect(row).toEqual({ day: '2025-11-05', h: 17, clock_hour: 7 });
    });
});
