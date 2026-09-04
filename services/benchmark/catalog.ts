import { BENCHMARK_SUITES } from './fixtures';
import { RESEARCH_BENCHMARK_SUITES } from './researchFixtures.generated';
import { HOLDOUT_BENCHMARK_SUITES } from './holdoutFixtures.generated';
import { AUDITED_HOLDOUT_BENCHMARK_SUITES } from './holdoutQuality';
import type { BenchmarkCorpusId, BenchmarkSuite, BenchmarkSuiteId } from './types';

/** All selectable suites. Existing product-regression packs remain first. */
export const LEGACY_BENCHMARK_SUITES: BenchmarkSuite[] = [
  ...BENCHMARK_SUITES,
  ...RESEARCH_BENCHMARK_SUITES,
];

export const ALL_BENCHMARK_SUITES: BenchmarkSuite[] = [...LEGACY_BENCHMARK_SUITES, ...AUDITED_HOLDOUT_BENCHMARK_SUITES];

export function getBenchmarkCorpusSuites(id: BenchmarkCorpusId): BenchmarkSuite[] {
  return id === 'holdout-550' ? AUDITED_HOLDOUT_BENCHMARK_SUITES : LEGACY_BENCHMARK_SUITES;
}

export function getAvailableBenchmarkSuite(id: BenchmarkSuiteId): BenchmarkSuite | undefined {
  return ALL_BENCHMARK_SUITES.find(suite => suite.id === id);
}
