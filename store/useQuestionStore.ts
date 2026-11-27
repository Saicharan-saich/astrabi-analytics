/**
 * useQuestionStore.ts — the person's saved and recent Question Builder
 * questions, kept in this browser. Questions are the builder's choices, never
 * rows. Another person signing in on this browser starts with their own list.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { SavedQuestion } from '../types';
import { withRecent, withSaved } from '../utils/savedQuestions';

interface QuestionState {
    ownerId?: string;
    saved: SavedQuestion[];
    recent: SavedQuestion[];
    save: (question: SavedQuestion) => void;
    remove: (id: string) => void;
    addRecent: (question: SavedQuestion) => void;
    clearRecent: () => void;
    /** Make sure the lists belong to this person. */
    ownedBy: (ownerId: string | undefined) => void;
}

export const useQuestionStore = create<QuestionState>()(
    persist(
        (set, get) => ({
            ownerId: undefined,
            saved: [],
            recent: [],
            save: (question) => set(state => ({ saved: withSaved(state.saved, question) })),
            remove: (id) => set(state => ({ saved: state.saved.filter(q => q.id !== id) })),
            addRecent: (question) => set(state => ({ recent: withRecent(state.recent, question) })),
            clearRecent: () => set({ recent: [] }),
            ownedBy: (ownerId) => {
                const current = get().ownerId;
                if (!ownerId || current === ownerId) return;
                if (current && current !== ownerId) set({ ownerId, saved: [], recent: [] });
                else set({ ownerId });
            },
        }),
        {
            name: 'QuickInsight-questions-v1',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({ ownerId: state.ownerId, saved: state.saved, recent: state.recent }) as any,
        }
    )
);
