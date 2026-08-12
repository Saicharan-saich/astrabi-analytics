import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESEARCH_BENCHMARK_SUITES } from '../services/benchmark';

describe('research benchmark fixture manifest', () => {
  it('contains two separately labelled 200-case public development subsets', () => {
    expect(RESEARCH_BENCHMARK_SUITES).toHaveLength(2);
    expect(RESEARCH_BENCHMARK_SUITES.map(suite => suite.cases.length)).toEqual([200, 200]);
    expect(RESEARCH_BENCHMARK_SUITES.every(suite => suite.evaluationClass === 'official-public-subset')).toBe(true);
  });

  it('keeps original-source identity, gold SQL, outputs, and lazy fixture references', () => {
    const cases = RESEARCH_BENCHMARK_SUITES.flatMap(suite => suite.cases);
    expect(new Set(cases.map(testCase => testCase.id)).size).toBe(400);
    expect(new Set(cases.map(testCase => testCase.sourceId)).size).toBe(400);

    for (const testCase of cases) {
      expect(testCase.dataset).toBeUndefined();
      expect(testCase.datasetRef).toMatch(/^\/benchmarks\/research-v1\/datasets\/.+\.json$/);
      expect(testCase.goldSql.trim().toLowerCase().startsWith('select')).toBe(true);
      expect(Array.isArray(testCase.expectedRows)).toBe(true);
      expect(testCase.tags).toContain('official-public-dev');
      const assetPath = resolve('public', testCase.datasetRef!.replace(/^\/benchmarks\//, 'benchmarks/'));
      expect(existsSync(assetPath), assetPath).toBe(true);
    }
  });

  it('ships a locked, auditable selection manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/benchmarks/research-v1/manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.constraints.countPerSuite).toBe(200);
    expect(manifest.sources.spider.selected).toBe(200);
    expect(manifest.sources.bird.selected).toBe(200);
    expect(manifest.cases.spider).toHaveLength(200);
    expect(manifest.cases.bird).toHaveLength(200);
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
