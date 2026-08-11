import type { BenchmarkRun } from './types';

const STORAGE_KEY = 'QuickInsight_ai_sql_benchmark_latest_v1';

export function saveBenchmarkRun(run: BenchmarkRun): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
    return true;
  } catch (error) {
    console.warn('[Benchmark] Could not persist the latest run:', error);
    return false;
  }
}

export function loadBenchmarkRun(): BenchmarkRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BenchmarkRun;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearBenchmarkRun(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable in hardened browser contexts.
  }
}
