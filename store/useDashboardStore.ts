/**
 * useDashboardStore.ts — Dashboard state (persisted)
 * Handles pinned dashboard items, layout, filters, and saved questions.
 * 
 * Extracted from the monolithic useAppStore for architectural separation.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DashboardItem, FormattingConfig } from '../types';

export interface DashboardFilter {
    column: string;
    values: string[];
}

interface DashboardState {
    // Dashboard items
    items: DashboardItem[];
    addItem: (item: DashboardItem) => void;
    removeItem: (id: string) => void;
    updateItem: (item: DashboardItem) => void;
    setItems: (items: DashboardItem[]) => void;
    clearAllItems: () => void;

    // Dashboard layout (react-grid-layout)
    dashboardLayout: any[] | null;
    setDashboardLayout: (layout: any[]) => void;

    // Dashboard filters
    dashboardFilters: DashboardFilter[];
    setDashboardFilters: (filters: DashboardFilter[]) => void;

    // Formatting
    formatting: FormattingConfig;
    updateFormatting: (formatting: FormattingConfig) => void;

    // Saved questions
    savedQuestions: SavedQuestion[];
    saveQuestion: (q: SavedQuestion) => void;
    deleteQuestion: (id: string) => void;

    // Query history
    queryHistory: HistoryEntry[];
    addToHistory: (entry: HistoryEntry) => void;
    clearHistory: () => void;
}

interface SavedQuestion {
    id: string;
    name: string;
    config: any;
    createdAt: number;
}

interface HistoryEntry {
    label: string;
    config: any;
    timestamp: number;
}

export const useDashboardStore = create<DashboardState>()(
    persist(
        (set) => ({
            // Dashboard items
            items: [],
            addItem: (item) => set((state) => ({ items: [...state.items, item] })),
            removeItem: (id) => set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
            updateItem: (updatedItem) => set((state) => ({
                items: state.items.map((i) => (i.id === updatedItem.id ? updatedItem : i))
            })),
            setItems: (items) => set({ items }),
            clearAllItems: () => set({ items: [] }),

            // Dashboard layout
            dashboardLayout: null,
            setDashboardLayout: (layout) => set({ dashboardLayout: layout }),

            // Dashboard filters
            dashboardFilters: [],
            setDashboardFilters: (filters) => set({ dashboardFilters: filters }),

            // Formatting
            formatting: {
                colorMode: 'vibrant',
                numberFormat: 'auto',
                fontSize: 'md',
                headerSize: 'lg',
                headerBold: true,
                showLabels: true,
                showDataLabels: false,
                showAxis: false,
                tableCalculations: []
            },
            updateFormatting: (formatting) => set({ formatting }),

            // Saved questions
            savedQuestions: [],
            saveQuestion: (q) => set((state) => ({ savedQuestions: [...state.savedQuestions, q] })),
            deleteQuestion: (id) => set((state) => ({
                savedQuestions: state.savedQuestions.filter(q => q.id !== id)
            })),

            // Query history
            queryHistory: [],
            addToHistory: (entry) => set((state) => ({
                queryHistory: [entry, ...state.queryHistory].slice(0, 20)
            })),
            clearHistory: () => set({ queryHistory: [] }),
        }),
        {
            name: 'astrabi-dashboard-v1',
            storage: createJSONStorage(() => localStorage),
        }
    )
);
