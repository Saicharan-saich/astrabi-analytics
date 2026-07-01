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

/** Compact a layout array — resolve overlaps by pushing items down */
function compactLayout(layout: any[], itemIds?: string[]): any[] {
    if (!layout || !Array.isArray(layout) || layout.length === 0) return layout;
    // Only keep entries for items that exist (if itemIds provided)
    let filtered = itemIds
        ? layout.filter((l: any) => itemIds.includes(l.i))
        : [...layout];
    // Sort by y then x (top-left first)
    filtered.sort((a: any, b: any) => (a.y - b.y) || (a.x - b.x));
    // Resolve collisions
    for (let i = 0; i < filtered.length; i++) {
        const cur = filtered[i];
        for (let j = 0; j < i; j++) {
            const other = filtered[j];
            const xOverlap = cur.x < other.x + other.w && cur.x + cur.w > other.x;
            const yOverlap = cur.y < other.y + other.h && cur.y + cur.h > other.y;
            if (xOverlap && yOverlap) {
                cur.y = other.y + other.h;
            }
        }
    }
    return filtered;
}

/** Debounce cloud push — avoid flooding on rapid changes */
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedCloudPush(state: DashboardState) {
    const itemCount = state.items?.length || 0;
    const hasToken = !!localStorage.getItem('qi_token');
    console.log(`[Dashboard] 📤 Scheduling cloud push (${itemCount} items, token=${hasToken})`);
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        console.log(`[Dashboard] 📤 Executing cloud push NOW...`);
        pushDashboardToCloud({
            items: state.items,
            layout: state.dashboardLayout,
            filters: state.dashboardFilters as any[],
            formatting: state.formatting as any,
            datasetId: state.selectedDatasetId,
        }).then(ok => {
            if (ok) {
                console.log('[Dashboard] ✅ Cloud push succeeded!');
            } else {
                console.warn('[Dashboard] ⚠️ Cloud push returned false — will retry on next change');
            }
        }).catch(err => {
            console.error('[Dashboard] ❌ Cloud push error:', err?.message || err);
        });
    }, 500); // 500ms debounce
}

export const useDashboardStore = create<DashboardState>()(
    persist(
        (set, get) => ({
            // Dashboard items
            items: [],
            addItem: (item) => {
                console.log(`[Dashboard] 📌 Pinning item "${item.title || item.id}" to dashboard`);
                set((state) => {
                    const newItems = [...state.items, item];
                    // Compute layout position for the new item below all existing ones
                    const existingLayout = state.dashboardLayout || [];
                    let maxY = 0;
                    existingLayout.forEach((l: any) => {
                        const bottom = (l.y || 0) + (l.h || 6);
                        if (bottom > maxY) maxY = bottom;
                    });
                    // Place in 2-column grid: check if there's space on the right in the last row
                    const lastRowItems = existingLayout.filter((l: any) => l.y + l.h > maxY - 6);
                    const rightSlotFree = !lastRowItems.some((l: any) => l.x >= 6);
                    const leftSlotFree = !lastRowItems.some((l: any) => l.x < 6);
                    let newX = 0;
                    let newY = maxY;
                    if (lastRowItems.length > 0 && rightSlotFree && !leftSlotFree) {
                        // Place next to the last item in the same row
                        newX = 6;
                        newY = maxY - (lastRowItems[0]?.h || 6);
                    }
                    const newLayout = [
                        ...existingLayout,
                        { i: item.id, x: newX, y: newY, w: 6, h: 6, minW: 4, minH: 4 }
                    ];
                    return { items: newItems, dashboardLayout: newLayout };
                });
                debouncedCloudPush(get());
            },
            removeItem: (id) => {
                set((state) => ({
                    items: state.items.filter((i) => i.id !== id),
                    dashboardLayout: (state.dashboardLayout || []).filter((l: any) => l.i !== id),
                }));
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
                const itemIds = get().items.map(i => i.id);
                set({ dashboardLayout: compactLayout(layout, itemIds) });
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
                    if (cloud && (cloud.items || []).length > 0) {
                        // Cloud has data — use it as source of truth
                        const cloudItems = cloud.items || [];
                        const cloudLayout = cloud.layout || get().dashboardLayout;
                        const itemIds = cloudItems.map((i: any) => i.id);
                        set({
                            items: cloudItems,
                            dashboardLayout: compactLayout(cloudLayout, itemIds),
                            dashboardFilters: (cloud.filters || []) as DashboardFilter[],
                            formatting: { ...get().formatting, ...(cloud.formatting || {}) },
                        });
                        console.log(`[CloudSync] ✅ Restored ${cloudItems.length} dashboard items from cloud`);
                    } else {
                        // Cloud is empty — push local to cloud if we have any
                        const localItems = get().items;
                        if (localItems.length > 0) {
                            console.log(`[CloudSync] Cloud empty, pushing ${localItems.length} local items to cloud...`);
                            debouncedCloudPush(get());
                        } else {
                            console.log('[CloudSync] Both cloud and local are empty — fresh start');
                        }
                    }
                    set({ cloudSyncStatus: 'synced' });
                } catch (err) {
                    console.error('[CloudSync] ❌ Pull failed:', (err as Error).message);
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
