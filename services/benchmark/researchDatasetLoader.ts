import type { Dataset } from '../../types';
import type { BenchmarkCase } from './types';

const datasetCache = new Map<string, Promise<Dataset>>();

function assertDataset(value: unknown, source: string): Dataset {
  const candidate = value as Partial<Dataset> | null;
  if (!candidate || !Array.isArray(candidate.rows) || !Array.isArray(candidate.columns) || typeof candidate.id !== 'string') {
    throw new Error(`Research benchmark fixture is malformed: ${source}`);
  }
  return candidate as Dataset;
}

/**
 * Load an official-source research fixture only when its first case runs.
 * A promise cache deduplicates table assets shared by multiple questions and
 * prevents the 400-case corpus from increasing the application's startup cost.
 */
export async function loadResearchBenchmarkDataset(testCase: BenchmarkCase): Promise<Dataset> {
  if (testCase.dataset) return testCase.dataset;
  const source = testCase.datasetRef;
  if (!source) throw new Error(`Benchmark case ${testCase.id} has no dataset fixture.`);

  let pending = datasetCache.get(source);
  if (!pending) {
    pending = fetch(source, { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) {
        throw new Error(`Could not load research fixture ${source} (${response.status}).`);
      }
      return assertDataset(await response.json(), source);
    });
    datasetCache.set(source, pending);
  }

  try {
    return await pending;
  } catch (error) {
    datasetCache.delete(source);
    throw error;
  }
}

export function clearResearchBenchmarkDatasetCache(): void {
  datasetCache.clear();
}
