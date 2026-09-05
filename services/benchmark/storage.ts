import type { BenchmarkRun } from './types';
import {
  deleteBenchmarkRunFromCloud,
  isValidBenchmarkRun,
  loadBenchmarkRunsFromCloud,
  saveBenchmarkRunToCloud,
} from './cloudHistory';

const STORAGE_KEY = 'QuickInsight_ai_sql_benchmark_latest_v1';
const HISTORY_DB_NAME = 'QuickInsightBenchmarkHistory';
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE = 'runs';
const HISTORY_LIMIT = 20;

/**
 * Recursively convert any BigInt values to Number so the object is safe
 * for both JSON.stringify and IndexedDB structured cloning.
 * DuckDB-WASM returns BigInt for large integers; neither serialiser
 * supports them natively.
 */
function sanitizeBigInts<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeBigInts) as unknown as T;
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeBigInts(v);
    }
    return result as T;
  }
  return value;
}

function openHistoryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(HISTORY_STORE)) {
        database.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open benchmark history'));
  });
}

async function readHistoryRecords(): Promise<BenchmarkRun[]> {
  const database = await openHistoryDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE, 'readonly');
    const request = transaction.objectStore(HISTORY_STORE).getAll();
    request.onsuccess = () => resolve((request.result || []).filter(isValidBenchmarkRun));
    request.onerror = () => reject(request.error || new Error('Could not read benchmark history'));
    transaction.oncomplete = () => database.close();
  });
}

async function pruneHistory(records: BenchmarkRun[]): Promise<void> {
  const stale = [...records]
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(HISTORY_LIMIT);
  if (!stale.length) return;
  const database = await openHistoryDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(HISTORY_STORE, 'readwrite');
    const store = transaction.objectStore(HISTORY_STORE);
    stale.forEach(run => store.delete(run.id));
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not prune benchmark history')); };
  });
}

/** Upsert one complete run in the local, browser-only history archive. */
export async function saveBenchmarkRunToHistory(run: BenchmarkRun): Promise<boolean> {
  let localSaved = false;
  try {
    const database = await openHistoryDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE, 'readwrite');
      transaction.objectStore(HISTORY_STORE).put(sanitizeBigInts(run));
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not save benchmark history')); };
    });
    await pruneHistory(await readHistoryRecords());
    localSaved = true;
  } catch (error) {
    console.warn('[Benchmark] Could not persist benchmark history:', error);
  }
  const cloudSaved = await saveBenchmarkRunToCloud(sanitizeBigInts(run));
  return localSaved || cloudSaved;
}

function evidenceScore(run: BenchmarkRun): [number, number, number] {
  const reviewed = run.results.reduce((total, result) => {
    const evidence = result as typeof result & { humanVerification?: unknown };
    return total + (result.adjudication || evidence.humanVerification ? 1 : 0);
  }, 0);
  return [reviewed, run.results.length, run.completedAt || 0];
}

function richerRun(left: BenchmarkRun, right: BenchmarkRun): BenchmarkRun {
  const a = evidenceScore(left);
  const b = evidenceScore(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? left : right;
  }
  return right;
}

/** Load newest first from PostgreSQL plus the private browser cache. */
export async function loadBenchmarkRunHistory(): Promise<BenchmarkRun[]> {
  const latest = loadBenchmarkRun();
  if (latest) await saveBenchmarkRunToHistory(latest);

  const [localRuns, cloudRuns] = await Promise.all([
    readHistoryRecords().catch(error => {
      console.warn('[Benchmark] Could not load local benchmark history:', error);
      return [] as BenchmarkRun[];
    }),
    loadBenchmarkRunsFromCloud(),
  ]);

  const merged = new Map<string, BenchmarkRun>();
  for (const run of [...localRuns, ...cloudRuns, ...(latest ? [latest] : [])]) {
    const existing = merged.get(run.id);
    merged.set(run.id, existing ? richerRun(existing, run) : run);
  }
  return [...merged.values()].sort((left, right) => right.startedAt - left.startedAt);
}

export async function deleteBenchmarkRunFromHistory(runId: string): Promise<boolean> {
  let localDeleted = false;
  try {
    const database = await openHistoryDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE, 'readwrite');
      transaction.objectStore(HISTORY_STORE).delete(runId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not delete benchmark history')); };
    });
    localDeleted = true;
  } catch (error) {
    console.warn('[Benchmark] Could not delete benchmark history:', error);
  }
  const cloudDeleted = await deleteBenchmarkRunFromCloud(runId);
  return localDeleted || cloudDeleted;
}

export function saveBenchmarkRun(run: BenchmarkRun): boolean {
  // IndexedDB is the durable history path and must still run if the compact
  // latest-run localStorage record exceeds the browser's quota.
  void saveBenchmarkRunToHistory(run);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeBigInts(run)));
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
    if (!isValidBenchmarkRun(parsed)) return null;
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
