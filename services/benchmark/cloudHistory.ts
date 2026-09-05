import type { BenchmarkRun } from './types';

const API_BASE = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api').replace(/\/$/, '');

function authToken(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem('qi_token') || '';
  } catch {
    return '';
  }
}

export function isValidBenchmarkRun(value: unknown): value is BenchmarkRun {
  const run = value as BenchmarkRun | null;
  return Boolean(
    run
    && run.schemaVersion === 1
    && typeof run.id === 'string'
    && Number.isFinite(run.startedAt)
    && Array.isArray(run.selectedSuiteIds)
    && Array.isArray(run.results)
    && run.metrics
    && typeof run.metrics === 'object',
  );
}

async function cloudRequest(path: string, init: RequestInit = {}): Promise<Response | null> {
  const token = authToken();
  if (!token || typeof fetch === 'undefined') return null;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
}

export async function loadBenchmarkRunsFromCloud(): Promise<BenchmarkRun[]> {
  try {
    const response = await cloudRequest('/admin/benchmark-runs', { method: 'GET', cache: 'no-store' });
    if (!response || response.status === 404) return [];
    if (!response.ok) throw new Error(`Benchmark history API returned ${response.status}`);
    const payload = await response.json() as { runs?: unknown[] };
    return Array.isArray(payload.runs) ? payload.runs.filter(isValidBenchmarkRun) : [];
  } catch (error) {
    console.warn('[Benchmark] Could not load database-backed benchmark history:', error);
    return [];
  }
}

export async function saveBenchmarkRunToCloud(run: BenchmarkRun): Promise<boolean> {
  try {
    const response = await cloudRequest('/admin/benchmark-runs', {
      method: 'POST',
      body: JSON.stringify({ run }),
    });
    if (!response || response.status === 404) return false;
    if (!response.ok) throw new Error(`Benchmark history API returned ${response.status}`);
    return true;
  } catch (error) {
    console.warn('[Benchmark] Could not save database-backed benchmark history:', error);
    return false;
  }
}

export async function deleteBenchmarkRunFromCloud(runId: string): Promise<boolean> {
  try {
    const response = await cloudRequest(`/admin/benchmark-runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
    if (!response || response.status === 404) return false;
    if (!response.ok) throw new Error(`Benchmark history API returned ${response.status}`);
    return true;
  } catch (error) {
    console.warn('[Benchmark] Could not delete database-backed benchmark history:', error);
    return false;
  }
}
