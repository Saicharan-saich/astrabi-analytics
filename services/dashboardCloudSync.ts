/**
 * Cloud definitions contain replay settings only. Full results remain local.
 */
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';
export interface CloudDashboard {
    id: string; name: string; dataset_id: string | null; items: any[];
    layout: any[] | null; filters: any[]; formatting: Record<string, any>;
    created_at?: string; updated_at?: string;
}
export interface DashboardSession { token: string; generation: number }
let generation = 0;
const writes = new Map<string, Promise<boolean>>();
const revisions = new Map<string, number>();
const controllers = new Set<AbortController>();
let failedPushQueue = new Map<string, { dashboard: CloudDashboard; session: DashboardSession; revision: number }>();
export function getDashboardSession(): DashboardSession | null {
    const token = typeof localStorage === 'undefined' ? '' : localStorage.getItem('qi_token');
    return token ? { token, generation } : null;
}
export function isDashboardSessionCurrent(session: DashboardSession | null): session is DashboardSession {
    return !!session && session.generation === generation && session.token === getDashboardSession()?.token;
}
/** Drop queued requests at logout/login; they must never inherit another token. */
export function cancelDashboardSync(): void {
    generation++;
    controllers.forEach(controller => controller.abort());
    controllers.clear();
    failedPushQueue.clear();
    writes.clear();
    revisions.clear();
}
function queueWrite(id: string, session: DashboardSession, operation: () => Promise<boolean>): Promise<boolean> {
    const previous = writes.get(id) || Promise.resolve(false);
    const task = previous.catch(() => false).then(() => isDashboardSessionCurrent(session) ? operation() : false);
    writes.set(id, task);
    void task.finally(() => { if (writes.get(id) === task) writes.delete(id); });
    return task;
}
type SyncStatus = 'pushing' | 'pushed' | 'push_failed' | 'pulling' | 'pulled' | 'pull_failed';
let syncStatusCallback: ((status: SyncStatus) => void) | null = null;
export function onSyncStatus(cb: (status: SyncStatus) => void) { syncStatusCallback = cb; }
function notifyStatus(status: SyncStatus, session: DashboardSession) {
    if (isDashboardSessionCurrent(session)) syncStatusCallback?.(status);
}
async function request(path: string, session: DashboardSession, init: RequestInit = {}) {
    if (!isDashboardSessionCurrent(session)) throw new Error('Dashboard session changed');
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${API_BASE}/dashboards${path}`, {
            ...init, signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        });
        if (!isDashboardSessionCurrent(session)) throw new Error('Dashboard session changed');
        return response;
    } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
    }
}
export async function fetchCloudDashboards(session = getDashboardSession()): Promise<CloudDashboard[]> {
    if (!session || !isDashboardSessionCurrent(session)) return [];
    try {
        const response = await request('', session);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!isDashboardSessionCurrent(session)) return [];
        return (data.dashboards || []).map(sanitizeDashboard) as CloudDashboard[];
    } catch { return []; }
}
async function sendDashboard(dashboard: CloudDashboard, session: DashboardSession, revision: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3 && isDashboardSessionCurrent(session); attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        if (!isDashboardSessionCurrent(session) || revisions.get(dashboard.id) !== revision) return false;
        try {
            const response = await request('', session, { method: 'POST', body: JSON.stringify(dashboard) });
            if (response.ok) return true;
            if ([400, 401, 403, 409].includes(response.status)) return false;
        } catch { /* retry only within the captured session */ }
    }
    if (isDashboardSessionCurrent(session) && revisions.get(dashboard.id) === revision) {
        failedPushQueue.set(dashboard.id, { dashboard, session, revision });
    }
    return false;
}
export async function saveCloudDashboard(dashboard: CloudDashboard, session = getDashboardSession()): Promise<boolean> {
    if (!session || !isDashboardSessionCurrent(session)) return false;
    const clean = sanitizeDashboard(dashboard) as CloudDashboard;
    const revision = (revisions.get(clean.id) || 0) + 1;
    revisions.set(clean.id, revision);
    failedPushQueue.delete(clean.id);
    notifyStatus('pushing', session);
    const ok = await queueWrite(clean.id, session, () => sendDashboard(clean, session, revision));
    notifyStatus(ok ? 'pushed' : 'push_failed', session);
    if (ok && isDashboardSessionCurrent(session)) {
        const queued = [...failedPushQueue.values()];
        failedPushQueue.clear();
        for (const entry of queued) {
            if (isDashboardSessionCurrent(entry.session) && revisions.get(entry.dashboard.id) === entry.revision) {
                await queueWrite(entry.dashboard.id, entry.session,
                    () => sendDashboard(entry.dashboard, entry.session, entry.revision));
            }
        }
    }
    return ok;
}
export async function deleteCloudDashboard(id: string, session = getDashboardSession()): Promise<boolean> {
    if (!session || !isDashboardSessionCurrent(session)) return false;
    failedPushQueue.delete(id);
    revisions.set(id, (revisions.get(id) || 0) + 1);
    return queueWrite(id, session, async () => {
        try {
            const response = await request(`/${encodeURIComponent(id)}`, session, { method: 'DELETE' });
            return response.ok || response.status === 404;
        } catch { return false; }
    });
}
/** Legacy single-dashboard callers get an account-specific default ID. */
export async function pushDashboardToCloud(state: {
    id?: string; name?: string; datasetId?: string | null;
    items: any[]; layout: any[] | null; filters: any[]; formatting: Record<string, any>;
}, session = getDashboardSession()): Promise<boolean> {
    if (!session || !isDashboardSessionCurrent(session)) return false;
    let id = state.id;
    if (!id || id === 'default') {
        try {
            const payload = session.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const userId = JSON.parse(atob(payload)).userId;
            if (typeof userId !== 'string' || !userId) return false;
            id = `default-${userId}`;
        } catch { return false; }
    }
    return saveCloudDashboard({
        id, name: state.name || 'My Dashboard', dataset_id: state.datasetId || null,
        items: state.items, layout: state.layout, filters: state.filters, formatting: state.formatting,
    }, session);
}
export async function pullDashboardFromCloud(datasetId?: string, session = getDashboardSession()): Promise<CloudDashboard | null> {
    if (!session) return null;
    notifyStatus('pulling', session);
    const dashboards = await fetchCloudDashboards(session);
    notifyStatus('pulled', session);
    return dashboards.find(d => datasetId && d.dataset_id === datasetId)
        || dashboards.find(d => d.id === 'default' || d.id.startsWith('default-'))
        || dashboards[0] || null;
}
export function getPendingPushCount(): number { return failedPushQueue.size; }
