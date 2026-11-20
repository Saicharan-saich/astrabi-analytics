/**
 * useSetupStore.ts — saved cleaning setups (persisted in this browser).
 *
 * Setups hold cleaning choices and column names, never rows, and stay on the
 * computer they were made on. A setup file (download / load) moves them to
 * another computer.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CleaningSetup } from '../types';
import { mergeSetups } from '../utils/cleaningSetups';

interface SetupState {
    setups: CleaningSetup[];
    /** Add a new setup or replace one with the same id. */
    saveSetup: (setup: CleaningSetup) => void;
    renameSetup: (id: string, name: string) => void;
    deleteSetup: (id: string) => void;
    /** A setup was used to clean a file. */
    markUsed: (id: string, at?: number) => void;
    /** Add setups from a setup file. */
    addSetups: (setups: CleaningSetup[]) => void;
}

export const useSetupStore = create<SetupState>()(
    persist(
        (set) => ({
            setups: [],
            saveSetup: (setup) => set(state => ({ setups: [setup, ...state.setups.filter(s => s.id !== setup.id)] })),
            renameSetup: (id, name) => set(state => ({
                setups: state.setups.map(s => (s.id === id && name.trim() ? { ...s, name: name.trim(), updatedAt: Date.now() } : s)),
            })),
            deleteSetup: (id) => set(state => ({ setups: state.setups.filter(s => s.id !== id) })),
            markUsed: (id, at = Date.now()) => set(state => ({
                setups: state.setups.map(s => (s.id === id ? { ...s, timesUsed: (s.timesUsed || 0) + 1, lastUsedAt: at } : s)),
            })),
            addSetups: (incoming) => set(state => ({ setups: mergeSetups(state.setups, incoming) })),
        }),
        {
            name: 'QuickInsight-cleaning-setups-v1',
            storage: createJSONStorage(() => localStorage),
        }
    )
);
