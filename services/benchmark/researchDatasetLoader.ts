import type { Dataset } from '../../types';
import type { BenchmarkCase } from './types';

const datasetCache = new Map<string, Promise<Dataset>>();
// New public-source fixtures can be much larger than the old compatibility
// data. Keep only a few table sets resident, not all 550 cases' datasets.
const MAX_CACHED_DATASETS = 3;

export class BenchmarkFixtureIntegrityError extends Error {}

function assertDataset(value: unknown, source: string): Dataset {
  const candidate = value as Partial<Dataset> | null;
  if (!candidate || !Array.isArray(candidate.rows) || !Array.isArray(candidate.columns) || typeof candidate.id !== 'string') {
    throw new BenchmarkFixtureIntegrityError(`Research benchmark fixture is malformed: ${source}`);
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

  const cacheKey = `${source}|${testCase.datasetSha256 || ''}`;
  let pending = datasetCache.get(cacheKey);
  if (!pending) {
    pending = fetch(source, { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) {
        throw new Error(`Could not load research fixture ${source} (${response.status}).`);
      }
      let bytes = await response.arrayBuffer();
      const signature = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
      if (signature[0] === 0x1f && signature[1] === 0x8b) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress benchmark fixtures. Use a current browser.');
        bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      if (testCase.datasetSha256) {
        if (!globalThis.crypto?.subtle) throw new Error('Secure fixture checksum verification is unavailable. Use HTTPS or localhost.');
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const actual = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
        if (actual !== testCase.datasetSha256) throw new BenchmarkFixtureIntegrityError(`Benchmark fixture checksum mismatch: ${source}. Reload the correct frozen version.`);
      }
      return assertDataset(JSON.parse(new TextDecoder().decode(bytes)), source);
    });
    datasetCache.set(cacheKey, pending);
    while (datasetCache.size > MAX_CACHED_DATASETS) datasetCache.delete(datasetCache.keys().next().value!);
  } else {
    datasetCache.delete(cacheKey);
    datasetCache.set(cacheKey, pending);
  }

  try {
    return await pending;
  } catch (error) {
    datasetCache.delete(cacheKey);
    throw error;
  }
}

export function clearResearchBenchmarkDatasetCache(): void {
  datasetCache.clear();
}
