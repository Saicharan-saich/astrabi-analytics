/**
 * useDashboardStore.ts — Dashboard state (persisted + cloud synced)
 * Handles pinned dashboard items, layout, filters, and saved questions.
 * 
 * Dual persistence strategy:
 * - IndexedDB (local): fast, instant, works offline
 * - PostgreSQL (cloud): persistent across devices, survives cache clears
 * 
 * Sync flow:
 * - On login:  pull from cloud → merge into local
 * - On pin/delete/layout change: write local + async push to cloud
 * - On logout: final push to cloud before clearing local
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DashboardItem, FormattingConfig, AnalysisResult } from '../types';
import { indexedDBStorage } from '../services/indexedDBStorage';
import { pushDashboardToCloud, pullDashboardFromCloud, deleteCloudDashboard } from '../services/dashboardCloudSync';

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
    // Fix #8: Re-evaluate a dashboard card with fresh data
    refreshItem: (id: string, newResult: AnalysisResult) => void;

    // Dashboard layout (react-grid-layout)
    dashboardLayout: any[] | null;
    setDashboardLayout: (layout: any[]) => void;

    // Dashboard filters
    dashboardFilters: DashboardFilter[];
    setDashboardFilters: (filters: DashboardFilter[]) => void;

    // Dataset scoping
    selectedDatasetId: string | null;
    setSelectedDatasetId: (id: string | null) => void;

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

    // Cloud sync
    syncFromCloud: (datasetId?: string) => Promise<void>;
    pushToCloud: () => Promise<void>;
    cloudSyncStatus: 'idle' | 'syncing' | 'synced' | 'error';
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

/** Debounce cloud push — avoid flooding on rapid changes */
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedCloudPush(state: DashboardState) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushDashboardToCloud({
            items: state.items,
            layout: state.dashboardLayout,
            filters: state.dashboardFilters as any[],
            formatting: state.formatting as any,
            datasetId: state.selectedDatasetId,
        }).catch(() => { /* silent — local is source of truth */ });
    }, 2000); // 2s debounce
}

export const useDashboardStore = create<DashboardState>()(
    persist(
        (set, get) => ({
            // Dashboard items
            items: [],
            addItem: (item) => {
                set((state) => ({ items: [...state.items, item] }));
                debouncedCloudPush(get());
            },
            removeItem: (id) => {
                set((state) => ({ items: state.items.filter((i) => i.id !== id) }));
                debouncedCloudPush(get());
            },
            updateItem: (updatedItem) => {
                set((state) => ({
                    items: state.items.map((i) => (i.id === updatedItem.id ? updatedItem : i))
                }));
                debouncedCloudPush(get());
            },
            setItems: (items) => {
                set({ items });
                debouncedCloudPush(get());
            },
            clearAllItems: () => {
                set({ items: [] });
                debouncedCloudPush(get());
            },
            // Fix #8: Re-evaluate dashboard card with fresh result data
            refreshItem: (id, newResult) => {
                set((state) => ({
                    items: state.items.map((i) => (
                        i.id === id ? { ...i, result: newResult, pinnedAt: Date.now() } : i
                    ))
                }));
                // Don't push on refresh — this is just a data update, not a user action
            },

            // Dashboard layout
            dashboardLayout: null,
            setDashboardLayout: (layout) => {
                set({ dashboardLayout: layout });
                debouncedCloudPush(get());
            },

            // Dashboard filters
            dashboardFilters: [],
            setDashboardFilters: (filters) => set({ dashboardFilters: filters }),

            // Dataset scoping
            selectedDatasetId: null,
            setSelectedDatasetId: (id) => set({ selectedDatasetId: id }),

            // Formatting
            formatting: {
                colorMode: 'vibrant',
                numberFormat: 'auto',
                fontSize: 'md',
                headerSize: 'lg',
                headerBold: true,
                showLabels: true,
                showDataLabels: true,
                showAxis: false,
                tableCalculations: []
            },
            updateFormatting: (formatting) => set({ formatting }),

            // Saved questions
            savedQuestions: [],
            saveQuestion: (q) => {
                set((state) => ({ savedQuestions: [...state.savedQuestions, q] }));
                debouncedCloudPush(get());
            },
            deleteQuestion: (id) => {
                set((state) => ({
                    savedQuestions: state.savedQuestions.filter(q => q.id !== id)
                }));
                debouncedCloudPush(get());
            },

            // Query history
            queryHistory: [],
            addToHistory: (entry) => set((state) => ({
                queryHistory: [entry, ...state.queryHistory].slice(0, 20)
            })),
            clearHistory: () => set({ queryHistory: [] }),

            // ── Cloud Sync ──────────────────────────────────────────
            cloudSyncStatus: 'idle',

            syncFromCloud: async (datasetId?: string) => {
                set({ cloudSyncStatus: 'syncing' });
                try {
                    const cloud = await pullDashboardFromCloud(datasetId);
                    if (cloud) {
                        const localItems = get().items;
                        const localIds = new Set(localItems.map(i => i.id));

                        // Merge strategy: cloud items that don't exist locally get added
                        // Local items are preserved (user may have unsaved local work)
                        const cloudOnlyItems = (cloud.items || []).filter(
                            (ci: any) => !localIds.has(ci.id)
                        );

                        if (cloudOnlyItems.length > 0 || localItems.length === 0) {
                            // If local is empty, fully restore from cloud
                            // If local has items, merge cloud-only items in
                            const mergedItems = localItems.length === 0
                                ? cloud.items || []
                                : [...localItems, ...cloudOnlyItems];

                            set({
                                items: mergedItems,
                                dashboardLayout: cloud.layout || get().dashboardLayout,
                                dashboardFilters: (cloud.filters || []) as DashboardFilter[],
                                formatting: { ...get().formatting, ...(cloud.formatting || {}) },
                            });
                            console.log(`[CloudSync] Restored ${mergedItems.length} dashboard items from cloud`);
                        } else {
                            console.log('[CloudSync] Local dashboard is up-to-date');
                        }
                    }
                    set({ cloudSyncStatus: 'synced' });
                } catch (err) {
                    console.warn('[CloudSync] Pull failed:', (err as Error).message);
                    set({ cloudSyncStatus: 'error' });
                }
            },

            pushToCloud: async () => {
                const state = get();
                set({ cloudSyncStatus: 'syncing' });
                try {
                    await pushDashboardToCloud({
                        items: state.items,
                        layout: state.dashboardLayout,
                        filters: state.dashboardFilters as any[],
                        formatting: state.formatting as any,
                        datasetId: state.selectedDatasetId,
                    });
                    set({ cloudSyncStatus: 'synced' });
                    console.log('[CloudSync] Dashboard pushed to cloud');
                } catch (err) {
                    console.warn('[CloudSync] Push failed:', (err as Error).message);
                    set({ cloudSyncStatus: 'error' });
                }
            },
        }),
        {
            name: 'QuickInsight-dashboard-v2',
            storage: createJSONStorage(() => indexedDBStorage), // Fix #13: IndexedDB
        }
    )
);
