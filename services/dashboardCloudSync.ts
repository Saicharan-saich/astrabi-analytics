/**
 * Dashboard Cloud Sync Service
 * 
 * Syncs dashboard state between local IndexedDB (fast, offline) and
 * PostgreSQL backend (persistent, cross-device).
 * 
 * Strategy:
 * - On login: pull from cloud → merge into local store
 * - On save/pin/delete: write to local store immediately, then push to cloud
 * - On logout: final push to cloud before clearing local
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

/**
 * Fetch all dashboards for the current user from the cloud.
 * Returns empty array if backend is unavailable (graceful degradation).
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
 * Save a dashboard to the cloud (upsert).
 * Fails silently if backend is unavailable — local store is the source of truth.
 */
export async function saveCloudDashboard(dashboard: CloudDashboard): Promise<boolean> {
    try {
        const token = getToken();
        if (!token) return false;

        const response = await fetch(`${API_BASE}/dashboards`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(dashboard),
        });

        if (!response.ok) {
            console.warn('[CloudSync] Failed to save dashboard:', response.status);
            return false;
        }

        console.log(`[CloudSync] Dashboard "${dashboard.name}" saved to cloud`);
        return true;
    } catch (err) {
        console.warn('[CloudSync] Save failed (offline?):', (err as Error).message);
        return false;
    }
}

/**
 * Delete a dashboard from the cloud.
 */
export async function deleteCloudDashboard(id: string): Promise<boolean> {
    try {
        const token = getToken();
        if (!token) return false;

        const response = await fetch(`${API_BASE}/dashboards/${id}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });

        if (!response.ok) {
            console.warn('[CloudSync] Failed to delete dashboard:', response.status);
            return false;
        }

        console.log(`[CloudSync] Dashboard ${id} deleted from cloud`);
        return true;
    } catch (err) {
        console.warn('[CloudSync] Delete failed:', (err as Error).message);
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
        items: state.items,
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
    const dashboards = await fetchCloudDashboards();
    if (dashboards.length === 0) return null;

    // Prefer the dashboard matching the current dataset
    if (datasetId) {
        const match = dashboards.find(d => d.dataset_id === datasetId);
        if (match) return match;
    }

    // Fallback: return the default dashboard or the most recently updated
    const defaultDb = dashboards.find(d => d.id === 'default');
    return defaultDb || dashboards[0];
}
