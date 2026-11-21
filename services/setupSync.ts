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

async function readAccount(): Promise<AccountSetups> {
    const res = await fetch(`${API_BASE}/cleaning-setups`, { headers: headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return { setups: Array.isArray(body?.setups) ? body.setups : [], deleted: Array.isArray(body?.deleted) ? body.deleted : [] };
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
