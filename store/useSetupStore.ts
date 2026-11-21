/**
 * useSetupStore.ts — saved cleaning setups.
 *
 * Setups hold cleaning choices and column names, never rows. They are kept in
 * this browser and, when signed in, with the person's account (setupSync.ts),
 * so they survive a cleared browser or a new computer. A deleted setup leaves
 * a marker until the account has it, so other computers delete it too.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CleaningSetup } from '../types';
import { mergeSetups } from '../utils/cleaningSetups';

export interface SetupSyncState {
    /** local = kept in this browser only (not signed in); synced = matches the account. */
    status: 'local' | 'syncing' | 'synced' | 'offline';
    at?: number;
    message?: string;
}

interface SetupState {
    setups: CleaningSetup[];
    /** Deleted here, not yet deleted in the account: id → when. */
    deleted: Record<string, number>;
    /** The account these setups belong to (none = made before signing in). */
    ownerId?: string;
    sync: SetupSyncState;
    saveSetup: (setup: CleaningSetup) => void;
    renameSetup: (id: string, name: string) => void;
    deleteSetup: (id: string) => void;
    /** A setup was used to clean a file. */
    markUsed: (id: string, at?: number) => void;
    /** Add setups from a setup file. */
    addSetups: (setups: CleaningSetup[]) => void;
    /** The account's view, after a sync. */
    replaceAll: (setups: CleaningSetup[], ownerId: string, settledDeletes: string[]) => void;
    /** Another person signed in on this browser: their setups start from their account. */
    resetFor: (ownerId: string) => void;
    setSync: (sync: SetupSyncState) => void;
}

export const useSetupStore = create<SetupState>()(
    persist(
        (set) => ({
            setups: [],
            deleted: {},
            ownerId: undefined,
            sync: { status: 'local' },
            saveSetup: (setup) => set(state => ({ setups: [setup, ...state.setups.filter(s => s.id !== setup.id)] })),
            renameSetup: (id, name) => set(state => ({
                setups: state.setups.map(s => (s.id === id && name.trim() ? { ...s, name: name.trim(), updatedAt: Date.now() } : s)),
            })),
            deleteSetup: (id) => set(state => ({ setups: state.setups.filter(s => s.id !== id), deleted: { ...state.deleted, [id]: Date.now() } })),
            markUsed: (id, at = Date.now()) => set(state => ({
                setups: state.setups.map(s => (s.id === id ? { ...s, timesUsed: (s.timesUsed || 0) + 1, lastUsedAt: at } : s)),
            })),
            addSetups: (incoming) => set(state => ({ setups: mergeSetups(state.setups, incoming) })),
            replaceAll: (setups, ownerId, settledDeletes) => set(state => {
                const deleted = { ...state.deleted };
                for (const id of settledDeletes) delete deleted[id];
                return { setups, ownerId, deleted };
            }),
            resetFor: (ownerId) => set({ setups: [], deleted: {}, ownerId }),
            setSync: (sync) => set({ sync }),
        }),
        {
            name: 'QuickInsight-cleaning-setups-v1',
            storage: createJSONStorage(() => localStorage),
            // The sync status is about this visit only.
            partialize: (state) => ({ setups: state.setups, deleted: state.deleted, ownerId: state.ownerId }) as any,
        }
    )
);
