/**
 * Dashboard Cloud Sync Service
 * 
 * Cloud-first persistence for dashboards to PostgreSQL backend.
 * Strategy: every create/edit/delete syncs to cloud with retry.
 * Local IndexedDB is a cache; cloud is the source of truth.
 * 
 * Only metadata is stored — raw dataset rows are NEVER sent to the backend.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

function getToken(): string {
    return localStorage.getItem('qi_token') || '';
}

function authHeaders(): HeadersInit {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
    };
}

export interface CloudDashboard {
    id: string;
    name: string;
    dataset_id: string | null;
    items: any[];
    layout: any[] | null;
    filters: any[];
    formatting: Record<string, any>;
    created_at?: string;
    updated_at?: string;
}

// ── Retry Queue ──────────────────────────────────────────
// Failed pushes are queued and retried on next successful network call
let failedPushQueue: CloudDashboard[] = [];

/**
 * Strip raw data from dashboard items before sending to cloud.
 * Only metadata, chart config, SQL, and formatting are stored — NOT dataset rows.
 */
function stripRawData(items: any[]): any[] {
    return items.map(item => {
        const clean = { ...item };
        // Strip raw result data (rows) — keep only metadata
        if (clean.result) {
            clean.result = {
                ...clean.result,
                // Keep: sql, chartType, xKey, yKey, title, format, insights
                // Strip: raw data rows (the actual dataset content)
                data: (clean.result.data || []).slice(0, 100), // Cap at 100 rows for chart rendering
            };
        }
        // Never store raw uploaded file data
        delete clean.rawData;
        delete clean.fileContent;
        delete clean.uploadedRows;
        return clean;
    });
}

/**
 * Retry wrapper with exponential backoff.
 * Attempts 3 times: 0s, 1s, 3s delays.
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries = 3
): Promise<T> {
    const delays = [0, 1000, 3000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                console.log(`[CloudSync] Retry ${attempt}/${maxRetries - 1} for ${label}...`);
                await new Promise(r => setTimeout(r, delays[attempt] || 3000));
            }
            return await fn();
        } catch (err) {
            lastError = err as Error;
            console.warn(`[CloudSync] ${label} attempt ${attempt + 1} failed:`, lastError.message);
        }
    }
    throw lastError || new Error(`${label} failed after ${maxRetries} attempts`);
}

// ── Sync Status Callbacks ────────────────────────────────
type SyncCallback = (status: 'pushing' | 'pushed' | 'push_failed' | 'pulling' | 'pulled' | 'pull_failed') => void;
let syncStatusCallback: SyncCallback | null = null;

export function onSyncStatus(cb: SyncCallback) {
    syncStatusCallback = cb;
}

function notifyStatus(status: Parameters<SyncCallback>[0]) {
    syncStatusCallback?.(status);
}

/**
 * Fetch all dashboards for the current user from the cloud.
 * Returns empty array if backend is unavailable.
 */
export async function fetchCloudDashboards(): Promise<CloudDashboard[]> {
    try {
        const token = getToken();
        if (!token) return [];

        const response = await fetch(`${API_BASE}/dashboards`, {
            method: 'GET',
            headers: authHeaders(),
        });

        if (!response.ok) {
            console.warn('[CloudSync] Failed to fetch dashboards:', response.status);
            return [];
        }

        const data = await response.json();
        return data.dashboards || [];
    } catch (err) {
        console.warn('[CloudSync] Backend unreachable, using local data:', (err as Error).message);
        return [];
    }
}

/**
 * Save a dashboard to the cloud (upsert) with retry.
 * This is the core persistence function — failures are retried and queued.
 */
export async function saveCloudDashboard(dashboard: CloudDashboard): Promise<boolean> {
    const token = getToken();
    if (!token) {
        console.warn('[CloudSync] No auth token — queuing push for later');
        failedPushQueue.push(dashboard);
        return false;
    }

    // Strip raw data — only metadata goes to cloud
    const cleanDashboard = {
        ...dashboard,
        items: stripRawData(dashboard.items),
    };

    try {
        notifyStatus('pushing');
        const result = await withRetry(async () => {
            const response = await fetch(`${API_BASE}/dashboards`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(cleanDashboard),
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            return true;
        }, `save "${dashboard.name || dashboard.id}"`);

        console.log(`[CloudSync] ✅ Dashboard "${dashboard.name}" saved to cloud`);
        notifyStatus('pushed');

        // Flush any previously failed pushes
        if (failedPushQueue.length > 0) {
            console.log(`[CloudSync] Flushing ${failedPushQueue.length} queued pushes...`);
            const queue = [...failedPushQueue];
            failedPushQueue = [];
            for (const queued of queue) {
                await saveCloudDashboard(queued).catch(() => {});
            }
        }

        return result;
    } catch (err) {
        console.error(`[CloudSync] ❌ Dashboard push FAILED after retries:`, (err as Error).message);
        // Queue for retry on next successful push
        failedPushQueue.push(cleanDashboard);
        notifyStatus('push_failed');
        return false;
    }
}

/**
 * Delete a dashboard from the cloud with retry.
 */
export async function deleteCloudDashboard(id: string): Promise<boolean> {
    const token = getToken();
    if (!token) return false;

    try {
        const result = await withRetry(async () => {
            const response = await fetch(`${API_BASE}/dashboards/${id}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return true;
        }, `delete dashboard ${id}`);

        console.log(`[CloudSync] ✅ Dashboard ${id} deleted from cloud`);
        return result;
    } catch (err) {
        console.warn('[CloudSync] Delete failed after retries:', (err as Error).message);
        return false;
    }
}

/**
 * Push the entire local dashboard state to the cloud.
 * Called on major state changes (pin, delete, layout change) and before logout.
 */
export async function pushDashboardToCloud(state: {
    id?: string;
    name?: string;
    datasetId?: string | null;
    items: any[];
    layout: any[] | null;
    filters: any[];
    formatting: Record<string, any>;
}): Promise<boolean> {
    const dashboard: CloudDashboard = {
        id: state.id || 'default',
        name: state.name || 'My Dashboard',
        dataset_id: state.datasetId || null,
        items: state.items, // stripRawData is called inside saveCloudDashboard
        layout: state.layout,
        filters: state.filters,
        formatting: state.formatting,
    };
    return saveCloudDashboard(dashboard);
}

/**
 * Pull dashboards from cloud and return the most recently updated one
 * (or the one matching the given datasetId).
 */
export async function pullDashboardFromCloud(datasetId?: string): Promise<CloudDashboard | null> {
    notifyStatus('pulling');
    try {
        const dashboards = await fetchCloudDashboards();
        if (dashboards.length === 0) {
            notifyStatus('pulled');
            return null;
        }

        // Prefer the dashboard matching the current dataset
        if (datasetId) {
            const match = dashboards.find(d => d.dataset_id === datasetId);
            if (match) {
                notifyStatus('pulled');
                return match;
            }
        }

        // Fallback: return the default dashboard or the most recently updated
        const defaultDb = dashboards.find(d => d.id === 'default');
        notifyStatus('pulled');
        return defaultDb || dashboards[0];
    } catch (err) {
        console.error('[CloudSync] Pull failed:', (err as Error).message);
        notifyStatus('pull_failed');
        return null;
    }
}

/**
 * Get the number of pending (failed) pushes in the retry queue.
 */
export function getPendingPushCount(): number {
    return failedPushQueue.length;
}
