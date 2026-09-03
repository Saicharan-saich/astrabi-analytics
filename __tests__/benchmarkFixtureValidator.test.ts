import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('bulk offline fixture loading preserves the existing SQL-insert values and resets changed assets', () => {
  const asset = { id: 'first', rows: [
    { label: "Women's Soccer", amount: '$1,234', when: '2025-01-01', nullable: null, flag: false },
    { label: '雪', amount: '', when: '2025-02-01', nullable: 'text', flag: true },
  ] };
  const requests = [
    { asset, sql: 'SELECT * FROM data ORDER BY when', maxRows: 10 },
    { asset, sql: 'SELECT SUM(amount) AS total FROM data', maxRows: 10 },
    { asset: { id: 'second', rows: [{ different: 42 }] }, sql: 'SELECT * FROM data', maxRows: 10 },
  ];
  // Quote the reserved identifier in this deliberately awkward fixture.
  requests[0].sql = 'SELECT * FROM data ORDER BY "when"';
  const run = (bulk: boolean) => {
    const result = spawnSync(process.execPath, [resolve('scripts/duckdb-benchmark-validator.cjs')], {
      encoding: 'utf8', input: requests.map(r => JSON.stringify(r)).join('\n') + '\n',
      env: { ...process.env, BENCHMARK_BULK_FIXTURES: bulk ? '1' : '0' }, timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  const standard = run(false);
  expect(standard.every(r => r.ok)).toBe(true);
  expect(run(true)).toEqual(standard);
}, 60_000);
