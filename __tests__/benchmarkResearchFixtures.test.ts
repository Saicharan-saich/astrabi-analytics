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

  it('preserves declared keys and joins for known multi-table failures', () => {
    const carAsset = JSON.parse(readFileSync(resolve('public/benchmarks/research-v1/datasets/spider--car-1--924b50f2d3.json'), 'utf8'));
    expect(carAsset.sourceSchema.joinEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ leftTable: 'countries', rightTable: 'continents', leftColumn: 'Continent', rightColumn: 'ContId', type: 'fk' }),
      expect.objectContaining({ leftTable: 'car_makers', rightTable: 'countries', leftColumn: 'Country', rightColumn: 'CountryId', type: 'fk' }),
    ]));

    const superheroAsset = JSON.parse(readFileSync(resolve('public/benchmarks/research-v1/datasets/bird--superhero--0b1941fbcb.json'), 'utf8'));
    expect(superheroAsset.sourceSchema.joinEdges).toContainEqual(
      expect.objectContaining({ leftTable: 'superhero', rightTable: 'alignment', leftColumn: 'alignment_id', rightColumn: 'id', type: 'fk' }),
    );
  });

  it('ships internally valid source-schema metadata for every fixture asset', () => {
    const datasetRefs = new Set(
      RESEARCH_BENCHMARK_SUITES.flatMap(suite => suite.cases.map(testCase => testCase.datasetRef!)),
    );

    for (const datasetRef of datasetRefs) {
      const assetPath = resolve('public', datasetRef.replace(/^\/benchmarks\//, 'benchmarks/'));
      const asset = JSON.parse(readFileSync(assetPath, 'utf8'));
      const schemaTables = new Map<string, Set<string>>(
        asset.sourceSchema.tables.map((table: any) => [
          table.name,
          new Set<string>(table.columns.map((column: any) => column.name)),
        ]),
      );
      expect([...schemaTables.keys()].sort()).toEqual(
        asset.relatedTables.map((table: any) => table.name).sort(),
      );
      for (const edge of asset.sourceSchema.joinEdges) {
        expect(schemaTables.get(edge.leftTable)?.has(edge.leftColumn), `${datasetRef}: ${edge.leftTable}.${edge.leftColumn}`).toBe(true);
        expect(schemaTables.get(edge.rightTable)?.has(edge.rightColumn), `${datasetRef}: ${edge.rightTable}.${edge.rightColumn}`).toBe(true);
      }
    }
  });
});
