import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOLDOUT_BENCHMARK_SUITES, LEGACY_BENCHMARK_SUITES,
  executeBenchmarkCase, getBenchmarkCorpusSuites, getRunCorpusId,
  runBenchmark, type BenchmarkCase, type BenchmarkRunnerDependencies,
} from '../services/benchmark';
import { getSuiteCorpus } from '../services/benchmark/corpus';
import { BenchmarkFixtureIntegrityError, clearResearchBenchmarkDatasetCache, loadResearchBenchmarkDataset } from '../services/benchmark/researchDatasetLoader';

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = LEGACY_BENCHMARK_SUITES[0].cases[0];
const published: BenchmarkCase = {
  ...original, id: 'reference-test', suiteId: 'spider2-lite-holdout',
  datasetRef: '/test-fixture.json', datasetSha256: 'a'.repeat(64), goldSql: '',
  expectedRows: [{ label: 'first' }], comparison: { orderMatters: true },
  referenceResult: { kind: 'published-result', sourceCommit: 'test', alternatives: [
    { source: 'first.csv', sha256: 'b'.repeat(64), rows: [{ label: 'first' }], conditionColumns: [] },
    { source: 'second.csv', sha256: 'c'.repeat(64), rows: [{ label: 'second' }], conditionColumns: [] },
  ] },
};
function dependencies(rows = [{ label: 'second' }]): BenchmarkRunnerDependencies {
  return {
    reloadDataset: vi.fn(async () => undefined),
    executeGoldSql: vi.fn(async () => { throw new Error('No published gold SQL exists'); }),
    runPipeline: vi.fn(async () => ({ sql: 'SELECT label FROM data', rawData: rows,
      validation: { valid: true }, displaySafety: { allowed: true },
      engine: 'llm-sql', provenance: { strategy: 'hybrid-plan-llm-sql', model: 'test' },
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
    })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); clearResearchBenchmarkDatasetCache(); });

describe('new public-source benchmark corpus', () => {
  it('preserves the original 550 and adds exactly 500 BIRD + 50 genuine Spider 2.0 cases', () => {
    expect(getBenchmarkCorpusSuites('legacy-550').flatMap(s => s.cases)).toHaveLength(550);
    expect(HOLDOUT_BENCHMARK_SUITES.map(s => [s.id, s.cases.length])).toEqual([
      ['bird-dev-holdout', 500], ['spider2-lite-holdout', 50],
    ]);
    const old = LEGACY_BENCHMARK_SUITES.flatMap(s => s.cases);
    const cases = HOLDOUT_BENCHMARK_SUITES.flatMap(s => s.cases);
    expect(new Set(cases.map(c => c.id)).size).toBe(550);
    expect(new Set(cases.map(c => normalize(c.question))).size).toBe(550);
    const oldIds = new Set(old.map(c => c.sourceId));
    const oldQuestions = new Set(old.map(c => normalize(c.question)));
    const oldSQL = new Set(old.filter(c => c.goldSql).map(c => normalize(c.goldSql)));
    for (const testCase of cases) {
      expect(oldIds.has(testCase.sourceId), testCase.id).toBe(false);
      expect(oldQuestions.has(normalize(testCase.question)), testCase.id).toBe(false);
      if (testCase.suiteId === 'bird-dev-holdout') expect(oldSQL.has(normalize(testCase.goldSql)), testCase.id).toBe(false);
      else expect(testCase.sourceId).toMatch(/^spider2-lite:local\d+:/);
      expect(testCase.tags).toContain('oracle-tables');
    }
  });

  it('ships complete, checksum-locked fixtures and real published reference provenance', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/benchmarks/holdout-v1/manifest.json'), 'utf8'));
    expect(manifest.count).toBe(550);
    expect(manifest.sourceIds).toHaveLength(550);
    expect(HOLDOUT_BENCHMARK_SUITES.every(s => s.manifestSha256 === manifest.manifestSha256)).toBe(true);
    const checked = new Set<string>();
    for (const testCase of HOLDOUT_BENCHMARK_SUITES.flatMap(s => s.cases)) {
      expect(manifest.assets[testCase.datasetRef!]).toBe(testCase.datasetSha256);
      if (!checked.has(testCase.datasetRef!)) {
        const bytes = gunzipSync(readFileSync(resolve('public', testCase.datasetRef!.slice(1))));
        expect(sha(bytes), testCase.datasetRef).toBe(testCase.datasetSha256);
        const asset = JSON.parse(bytes.toString('utf8'));
        for (const table of asset.relatedTables) {
          expect(table.rows.length).toBe(asset.sourceSchema.tables.find((t: any) => t.name === table.name).rows);
        }
        checked.add(testCase.datasetRef!);
      }
      for (const reference of testCase.referenceResult?.alternatives || []) {
        expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(reference.source).toMatch(/^spider2-lite\/evaluation_suite\/gold\/exec_result\/local/);
        expect(reference.rows.length).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('isolates old reports, rejects mixed corpora and requires new manifest identity', () => {
    expect(getRunCorpusId({ selectedSuiteIds: ['bird-dev-research'] })).toBe('legacy-550');
    expect(getRunCorpusId({ selectedSuiteIds: ['spider2-lite-holdout'] })).toBe('holdout-550');
    expect(() => getSuiteCorpus([LEGACY_BENCHMARK_SUITES[0], HOLDOUT_BENCHMARK_SUITES[0]])).toThrow(/separately/);
    expect(() => getSuiteCorpus([{ ...HOLDOUT_BENCHMARK_SUITES[0], manifestSha256: undefined }])).toThrow(/checksum/);
  });

  it('uses published alternative results without executing invented gold SQL or sending gold to AI', async () => {
    const deps = dependencies();
    const result = await executeBenchmarkCase(published, deps);
    expect(result.status).toBe('pass');
    expect(result.matchedReferenceSource).toBe('second.csv');
    expect(result.expectedRows).toEqual([{ label: 'second' }]);
    expect(deps.executeGoldSql).not.toHaveBeenCalled();
    expect(deps.runPipeline).toHaveBeenCalledWith(original.question, original.dataset);
  });

  it('does not accept unrelated output or reorder an order-sensitive published result', async () => {
    expect((await executeBenchmarkCase(published, dependencies([{ label: 'unrelated' }]))).status).toBe('wrong_result');
    const ordered = { ...published, referenceResult: { ...published.referenceResult!, alternatives: [
      { ...published.referenceResult!.alternatives[0], rows: [{ label: 'one' }, { label: 'two' }] },
    ] } };
    expect((await executeBenchmarkCase(ordered, dependencies([{ label: 'two' }, { label: 'one' }]))).status).toBe('wrong_result');
  });

  it('stops incomplete published fixtures before model execution', async () => {
    const deps = dependencies();
    const result = await executeBenchmarkCase({ ...published, datasetSha256: undefined }, deps);
    expect(result.status).toBe('fixture_error');
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it('refuses to resume a new run after its frozen manifest changes', async () => {
    const suite = { ...HOLDOUT_BENCHMARK_SUITES[1], cases: [published] };
    const run = await runBenchmark([suite], dependencies(), { scope: 'full', appVersion: 'test' });
    expect(run.corpusId).toBe('holdout-550');
    await expect(runBenchmark([{ ...suite, manifestSha256: 'd'.repeat(64) }], dependencies(), {
      scope: 'full', appVersion: 'test', resumeRun: run,
    })).rejects.toThrow(/manifest/);
  });

  it('checks downloaded fixture bytes and rejects corruption before returning a dataset', async () => {
    const bytes = JSON.stringify(original.dataset);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const lazy = { ...original, dataset: undefined, datasetRef: '/fixture.json', datasetSha256: sha(bytes) };
    expect((await loadResearchBenchmarkDataset(lazy)).id).toBe(original.dataset!.id);
    await expect(loadResearchBenchmarkDataset({ ...lazy, datasetSha256: '0'.repeat(64) })).rejects.toThrow(/checksum mismatch/);
  });

  it('decompresses complete fixtures before checksum verification', async () => {
    const bytes = JSON.stringify(original.dataset);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(gzipSync(bytes))));
    const lazy = { ...original, dataset: undefined, datasetRef: '/fixture.json.gz', datasetSha256: sha(bytes) };
    expect(await loadResearchBenchmarkDataset(lazy)).toEqual(original.dataset);
  });

  it('classifies an integrity failure as a fixture error, never a model failure', async () => {
    const deps = { ...dependencies(), loadDataset: vi.fn(async () => { throw new BenchmarkFixtureIntegrityError('Checksum mismatch'); }) };
    const result = await executeBenchmarkCase({ ...published, dataset: undefined }, deps);
    expect(result.status).toBe('fixture_error');
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });
});
