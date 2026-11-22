/**
 * setupSync.ts — keeps saved cleaning setups with the person's account.
 *
 * Setups are choices and column names, never rows. A sync reconciles this
 * browser with the account: the newest version of each setup wins, deletions
 * travel both ways, and setups made before signing in join the account. Any
 * change in the store is synced shortly after; signing in syncs at once.
 * Offline, everything keeps working from this browser and syncs later.
 */
import type { CleaningSetup } from '../types';
import { useSetupStore } from '../store/useSetupStore';
import { planSync, type AccountSetups } from '../utils/cleaningSetups';

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';
const token = () => (typeof localStorage === 'undefined' ? '' : localStorage.getItem('qi_token') || '');
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });

async function readAccount(): Promise<AccountSetups & { shares: Record<string, string[]> }> {
    const res = await fetch(`${API_BASE}/cleaning-setups`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return {
        setups: Array.isArray(body?.setups) ? body.setups : [],
        deleted: Array.isArray(body?.deleted) ? body.deleted : [],
        shares: body?.shares && typeof body.shares === 'object' ? body.shares : {},
    };
}

let running: Promise<void> | null = null;
let again = false;
let applying = false;

/** Bring this browser and the account into line. Safe to call often. */
export function syncSetups(userId?: string): Promise<void> {
    if (running) { again = true; return running; }
    running = (async () => {
        const store = useSetupStore.getState();
        if (!token()) { store.setSync({ status: 'local' }); return; }
        // Setups another person left on this browser stay with their account.
        if (userId && store.ownerId && store.ownerId !== userId) {
            applying = true;
            store.resetFor(userId);
            applying = false;
        }
        store.setSync({ ...store.sync, status: 'syncing' });
        try {
            const account = await readAccount();
            const now = useSetupStore.getState();
            const plan = planSync(now.setups, now.deleted, account);
            for (const setup of plan.push) {
                const res = await fetch(`${API_BASE}/cleaning-setups/${encodeURIComponent(setup.id)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(setup) });
                if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
            }
            const settled: string[] = [];
            for (const gone of plan.remove) {
                const res = await fetch(`${API_BASE}/cleaning-setups/${encodeURIComponent(gone.id)}?at=${gone.at}`, { method: 'DELETE', headers: headers() });
                if (res.ok) settled.push(gone.id);
            }
            // Deletions the account already has are settled too.
            for (const d of account.deleted) if ((now.deleted[d.id] ?? Infinity) <= d.at) settled.push(d.id);
            applying = true;
            useSetupStore.getState().replaceAll(plan.keep, userId || now.ownerId || '', settled);
            useSetupStore.getState().setShares(account.shares);
            applying = false;
            useSetupStore.getState().setSync({ status: 'synced', at: Date.now() });
        } catch (error: any) {
            applying = false;
            useSetupStore.getState().setSync({ status: 'offline', at: useSetupStore.getState().sync.at, message: 'Could not reach your account; your setups are safe in this browser and will sync later.' });
        }
    })().finally(() => {
        running = null;
        if (again) { again = false; void syncSetups(userId); }
    });
    return running;
}

/**
 * Admins: choose which accounts receive a setup. The setup is synced first, so
 * the account has the version being shared.
 */
export async function shareSetup(setupId: string, userIds: string[], userId?: string): Promise<{ ok: boolean; message?: string }> {
    await syncSetups(userId);
    const res = await fetch(`${API_BASE}/cleaning-setups/${encodeURIComponent(setupId)}/shares`, { method: 'PUT', headers: headers(), body: JSON.stringify({ userIds }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: body?.error || 'Could not share the setup. Try again in a moment.' };
    const store = useSetupStore.getState();
    store.setShares({ ...store.shares, [setupId]: Array.isArray(body?.userIds) ? body.userIds : userIds });
    return { ok: true };
}

/**
 * Everyone else (contributors, viewers): the setups an admin shared with this
 * account, read-only. They clean this person's uploads automatically.
 */
export async function loadSharedSetups(userId: string): Promise<void> {
    const store = useSetupStore.getState();
    applying = true;
    if (store.ownerId && store.ownerId !== userId) store.resetFor(userId);
    applying = false;
    if (!token()) return;
    try {
        const res = await fetch(`${API_BASE}/cleaning-setups/shared`, { headers: headers() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const received: CleaningSetup[] = Array.isArray(body?.setups) ? body.setups : [];
        // Keep this browser's use counts for setups it already had.
        const local = new Map<string, CleaningSetup>(useSetupStore.getState().setups.map(s => [s.id, s] as [string, CleaningSetup]));
        const merged = received.map(s => {
            const mine = local.get(s.id);
            return mine && (mine.timesUsed || 0) > (s.timesUsed || 0) ? { ...s, timesUsed: mine.timesUsed, lastUsedAt: mine.lastUsedAt } : s;
        });
        applying = true;
        useSetupStore.getState().replaceAll(merged, userId, Object.keys(useSetupStore.getState().deleted));
        applying = false;
        useSetupStore.getState().setSync({ status: 'synced', at: Date.now() });
    } catch {
        applying = false;
        // Offline: the setups received last time keep working.
    }
}

let receiver: string | undefined;
let lastReceived = 0;
const onFocus = () => { if (receiver && Date.now() - lastReceived > 2 * 60_000) { lastReceived = Date.now(); void loadSharedSetups(receiver); } };

/** Called at sign-in for non-admins: fetch shared setups now and when the tab is used again. */
export function startSharedSetups(userId: string): void {
    receiver = userId;
    lastReceived = Date.now();
    void loadSharedSetups(userId);
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
}

export function stopSharedSetups(): void {
    receiver = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let currentUser: string | undefined;

/** Called at sign-in: sync now, then after every change. */
export function startSetupSync(userId: string): void {
    currentUser = userId;
    void syncSetups(userId);
}

/** Called at sign-out: stop syncing; the setups stay with the account. */
export function stopSetupSync(): void {
    currentUser = undefined;
    if (timer) clearTimeout(timer);
    useSetupStore.getState().setSync({ status: 'local' });
}

// Any change to the setups (save, rename, delete, use) syncs shortly after.
useSetupStore.subscribe((state, previous) => {
    if (applying || !currentUser) return;
    if (state.setups === previous.setups && state.deleted === previous.deleted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncSetups(currentUser); }, 800);
});
