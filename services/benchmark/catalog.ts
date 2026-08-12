import { BENCHMARK_SUITES } from './fixtures';
import { RESEARCH_BENCHMARK_SUITES } from './researchFixtures.generated';
import type { BenchmarkSuite, BenchmarkSuiteId } from './types';

/** All selectable suites. Existing product-regression packs remain first. */
export const ALL_BENCHMARK_SUITES: BenchmarkSuite[] = [
  ...BENCHMARK_SUITES,
  ...RESEARCH_BENCHMARK_SUITES,
];

export function getAvailableBenchmarkSuite(id: BenchmarkSuiteId): BenchmarkSuite | undefined {
  return ALL_BENCHMARK_SUITES.find(suite => suite.id === id);
}
