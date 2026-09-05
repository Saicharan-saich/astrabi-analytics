import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  loadBundledBenchmarkArchive,
  seedBundledBenchmarkHistory,
  validateBenchmarkRun,
} = require('../backend/benchmarkHistory.js');

describe('database-backed benchmark history archive', () => {
  it('retains all eleven unique exported runs with source checksums', () => {
    const archive = loadBundledBenchmarkArchive();
    expect(archive.version).toBe('quickinsight-benchmark-history-v1');
    expect(archive.runCount).toBe(11);
    expect(archive.runs).toHaveLength(11);
    expect(new Set(archive.runs.map((entry: any) => entry.run.id)).size).toBe(11);
    expect(archive.runs.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.sourceSha256))).toBe(true);
    expect(archive.runs.map((entry: any) => entry.run.id)).toContain('benchmark-1787675050248-epbpj1');
    expect(archive.runs.map((entry: any) => entry.run.id)).toContain('benchmark-1788288062531-hw1mjd');
  });

  it('rejects malformed evidence before it can be inserted', () => {
    expect(validateBenchmarkRun({})).toMatchObject({ valid: false });
    expect(validateBenchmarkRun({
      id: 'unsafe id', schemaVersion: 1, startedAt: 1, results: [], metrics: {},
      selectedSuiteIds: [], scope: 'full', methodologyLabel: 'Test',
    })).toMatchObject({ valid: false });
  });

  it('imports the archive once for the active administrator', async () => {
    const query = async (sql: string) => {
      if (sql.includes('SELECT value FROM app_settings')) return { rows: [] };
      if (sql.includes("SELECT id FROM users")) return { rows: [{ id: 'admin_001' }] };
      if (sql.includes('INSERT INTO benchmark_runs')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO app_settings')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    };
    const result = await seedBundledBenchmarkHistory({ query });
    expect(result).toMatchObject({ imported: 11, archivedRuns: 11, skipped: false });
  });

  it('creates admin-only API routes and a persistent PostgreSQL table', () => {
    const server = readFileSync(join(process.cwd(), 'backend/server.js'), 'utf8');
    expect(server).toMatch(/CREATE TABLE IF NOT EXISTS benchmark_runs/);
    expect(server).toMatch(/app\.get\('\/api\/admin\/benchmark-runs'/);
    expect(server).toMatch(/app\.post\('\/api\/admin\/benchmark-runs'/);
    expect(server).toMatch(/extractCurrentAdmin\(req\)/);
  });
});
