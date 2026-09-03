import type { BenchmarkCorpusId, BenchmarkRun, BenchmarkSuite } from './types';

export const BENCHMARK_CORPUS_LABELS: Record<BenchmarkCorpusId, string> = {
  'legacy-550': 'Original 550',
  'holdout-550': 'New 550 · BIRD + Spider 2.0',
};

export function getRunCorpusId(run: Pick<BenchmarkRun, 'corpusId' | 'selectedSuiteIds'>): BenchmarkCorpusId {
  return run.corpusId || (run.selectedSuiteIds.some(id => id === 'bird-dev-holdout' || id === 'spider2-lite-holdout')
    ? 'holdout-550' : 'legacy-550');
}

export function getSuiteCorpus(suites: BenchmarkSuite[]): { corpusId: BenchmarkCorpusId; corpusManifestSha256?: string } {
  const ids = new Set(suites.map(suite => suite.corpusId || 'legacy-550'));
  if (ids.size > 1) throw new Error('Original and new benchmark corpora must run separately. Select one corpus tab.');
  const hashes = new Set(suites.map(suite => suite.manifestSha256).filter(Boolean));
  if (hashes.size > 1) throw new Error('Benchmark suites have inconsistent frozen manifest hashes.');
  if (ids.has('holdout-550') && suites.some(suite => !/^[a-f0-9]{64}$/.test(suite.manifestSha256 || ''))) {
    throw new Error('New benchmark suites require an immutable manifest checksum.');
  }
  return { corpusId: [...ids][0] || 'legacy-550', corpusManifestSha256: [...hashes][0] };
}
