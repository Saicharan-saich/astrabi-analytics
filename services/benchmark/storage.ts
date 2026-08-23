import type { BenchmarkRun } from './types';

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

function isValidRun(value: unknown): value is BenchmarkRun {
  const run = value as BenchmarkRun | null;
  return run?.schemaVersion === 1 && Array.isArray(run.results);
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
    request.onsuccess = () => resolve((request.result || []).filter(isValidRun));
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
  try {
    const database = await openHistoryDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE, 'readwrite');
      transaction.objectStore(HISTORY_STORE).put(sanitizeBigInts(run));
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not save benchmark history')); };
    });
    await pruneHistory(await readHistoryRecords());
    return true;
  } catch (error) {
    console.warn('[Benchmark] Could not persist benchmark history:', error);
    return false;
  }
}

/** Load newest first and migrate the legacy latest-run record automatically. */
export async function loadBenchmarkRunHistory(): Promise<BenchmarkRun[]> {
  const latest = loadBenchmarkRun();
  try {
    if (latest) await saveBenchmarkRunToHistory(latest);
    return (await readHistoryRecords()).sort((left, right) => right.startedAt - left.startedAt);
  } catch (error) {
    console.warn('[Benchmark] Could not load benchmark history:', error);
    return latest ? [latest] : [];
  }
}

export async function deleteBenchmarkRunFromHistory(runId: string): Promise<boolean> {
  try {
    const database = await openHistoryDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(HISTORY_STORE, 'readwrite');
      transaction.objectStore(HISTORY_STORE).delete(runId);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Could not delete benchmark history')); };
    });
    return true;
  } catch (error) {
    console.warn('[Benchmark] Could not delete benchmark history:', error);
    return false;
  }
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
    if (!isValidRun(parsed)) return null;
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
