
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Dataset, DashboardItem, DashboardDefinition, AnalysisResult, QueryConfig, FormattingConfig, Tab } from '../types';
import { saveCloudDashboard, fetchCloudDashboards, deleteCloudDashboard as deleteCloudDb } from '../services/dashboardCloudSync';

// ── Helpers ──────────────────────────────────────────────────────
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

// ── Cloud Sync for Multi-Dashboard State ─────────────────────────
let dashPushTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedDashboardPush(dashboards: DashboardDefinition[]) {
    if (dashPushTimer) clearTimeout(dashPushTimer);
    dashPushTimer = setTimeout(() => {
        const token = localStorage.getItem('qi_token');
        if (!token) { console.warn('[DashSync] No token — skip push'); return; }
        console.log(`[DashSync] 📤 Pushing ${dashboards.length} dashboards to cloud...`);
        // Push each dashboard as a separate cloud record
        Promise.all(dashboards.map(d => saveCloudDashboard({
            id: d.id,
            name: d.name,
            dataset_id: null,
            items: d.items,
            layout: d.layout as any[] | null,
            filters: d.filters || [],
            formatting: {},
        }))).then(results => {
            const ok = results.filter(Boolean).length;
            console.log(`[DashSync] ✅ ${ok}/${dashboards.length} dashboards pushed to cloud`);
        }).catch(err => {
            console.error('[DashSync] ❌ Push failed:', err?.message || err);
        });
    }, 500);
}

/** Immediately push dashboards (for logout). Returns a promise. */
export async function flushDashboardsToCloud(): Promise<boolean> {
    if (dashPushTimer) { clearTimeout(dashPushTimer); dashPushTimer = null; }
    const token = localStorage.getItem('qi_token');
    if (!token) return false;
    const dashboards = useAppStore.getState().dashboards;
    if (!dashboards || dashboards.length === 0) return true;
    console.log(`[DashSync] 📤 Flushing ${dashboards.length} dashboards to cloud (logout)...`);
    try {
        const results = await Promise.all(dashboards.map(d => saveCloudDashboard({
            id: d.id,
            name: d.name,
            dataset_id: null,
            items: d.items,
            layout: d.layout as any[] | null,
            filters: d.filters || [],
            formatting: {},
        })));
        const ok = results.filter(Boolean).length;
        console.log(`[DashSync] ✅ Flushed ${ok}/${dashboards.length} dashboards`);
        return ok > 0;
    } catch (err) {
        console.error('[DashSync] ❌ Flush failed:', err);
        return false;
    }
}

/** Pull dashboards from cloud and merge into local state. Call on login. */
export async function syncDashboardsFromCloud(): Promise<void> {
    const token = localStorage.getItem('qi_token');
    if (!token) return;
    try {
        console.log('[DashSync] 📥 Pulling dashboards from cloud...');
        const cloudDashboards = await fetchCloudDashboards();
        if (cloudDashboards.length > 0) {
            // Sanitize layout: if items overlap, regenerate a clean 2-col grid
            const sanitizeLayout = (layoutArr: any[] | null, dashItems: any[]): any[] | null => {
                if (!layoutArr || !Array.isArray(layoutArr) || layoutArr.length === 0) return null;
                // Check for overlaps
                for (let a = 0; a < layoutArr.length; a++) {
                    for (let b = a + 1; b < layoutArr.length; b++) {
                        const la = layoutArr[a], lb = layoutArr[b];
                        const xHit = la.x < lb.x + lb.w && la.x + la.w > lb.x;
                        const yHit = la.y < lb.y + lb.h && la.y + la.h > lb.y;
                        if (xHit && yHit) {
                            console.warn('[DashSync] Overlap in cloud layout — regenerating clean grid');
                            return dashItems.map((item: any, idx: number) => ({
                                i: item.id,
                                x: (idx % 2) * 6,
                                y: Math.floor(idx / 2) * 6,
                                w: 6, h: 6, minW: 4, minH: 4,
                            }));
                        }
                    }
                }
                return layoutArr;
            };

            const restored: DashboardDefinition[] = cloudDashboards.map(cd => ({
                id: cd.id,
                name: cd.name,
                items: cd.items || [],
                layout: sanitizeLayout(cd.layout, cd.items || []),
                filters: cd.filters || [],
                createdAt: cd.created_at ? new Date(cd.created_at).getTime() : Date.now(),
            }));
            useAppStore.setState({
                dashboards: restored,
                activeDashboardId: restored[0].id,
                items: restored[0].items,
                dashboardLayout: restored[0].layout,
                dashboardFilters: restored[0].filters || [],
            });
            console.log(`[DashSync] ✅ Restored ${restored.length} dashboards (${restored.reduce((s, d) => s + d.items.length, 0)} total items) from cloud`);
        } else {
            // Cloud is empty — push local if we have any
            const local = useAppStore.getState().dashboards;
            if (local.length > 0) {
                console.log(`[DashSync] Cloud empty, pushing ${local.length} local dashboards...`);
                debouncedDashboardPush(local);
            } else {
                console.log('[DashSync] Both cloud and local empty — fresh start');
            }
        }
    } catch (err) {
        console.error('[DashSync] ❌ Pull failed:', err);
    }
}

interface UIState {
    activeTab: Tab;
    isSidebarOpen: boolean;
    showAbout: boolean;
    appFontSize: number;
    appFontBold: boolean;
    theme: 'dark' | 'light';
    hiddenTabs: string[];
    setActiveTab: (tab: Tab) => void;
    toggleSidebar: () => void;
    setSidebarOpen: (isOpen: boolean) => void;
    toggleAbout: (show: boolean) => void;
    setAppFontSize: (size: number) => void;
    toggleAppFontBold: () => void;
    setTheme: (theme: 'dark' | 'light') => void;
    toggleTheme: () => void;
    toggleTabVisibility: (tabId: string) => void;
    setHiddenTabs: (tabs: string[]) => void;
}

interface DataState {
    dataset: Dataset | null;
    datasets: Dataset[];
    isProcessing: boolean;
    error: string | null;
    setDataset: (dataset: Dataset | null) => void;
    addDataset: (dataset: Dataset) => void;
    removeDataset: (id: string) => void;
    setActiveDatasetById: (id: string) => void;
    setProcessing: (isProcessing: boolean) => void;
    setError: (error: string | null) => void;
}

interface WorkbenchState {
    config: QueryConfig | undefined;
    result: AnalysisResult | undefined;
    formatting: FormattingConfig;
    setWorkbenchState: (config: QueryConfig | undefined, result: AnalysisResult | undefined) => void;
    updateFormatting: (formatting: FormattingConfig) => void;
}

// ── Multi-Dashboard State ────────────────────────────────────────
interface MultiDashboardState {
    dashboards: DashboardDefinition[];
    activeDashboardId: string | null;

    // Dashboard CRUD
    createDashboard: (name: string) => string;
    renameDashboard: (id: string, name: string) => void;
    setDashboardMeta: (id: string, meta: { autoGenerated?: boolean; sourceDatasetId?: string }) => void;
    deleteDashboard: (id: string) => void;
    duplicateDashboard: (id: string) => string;
    setActiveDashboard: (id: string) => void;

    // Item operations (scoped to a target dashboard)
    addItemToDashboard: (dashboardId: string, item: DashboardItem) => void;
    removeItemFromDashboard: (dashboardId: string, itemId: string) => void;
    updateItemInDashboard: (dashboardId: string, item: DashboardItem) => void;
    setDashboardLayout: (dashboardId: string, layout: any[]) => void;
    setDashboardFilters: (dashboardId: string, filters: any[]) => void;

    // Backward-compat convenience — operates on activeDashboardId
    // These are SYNCED properties, not getters
    items: DashboardItem[];
    dashboardLayout: any[] | null;
    dashboardFilters: DashboardFilter[];

    addItem: (item: DashboardItem) => void;
    removeItem: (id: string) => void;
    updateItem: (item: DashboardItem) => void;
    setItems: (items: DashboardItem[]) => void;
    clearAllItems: () => void;
    setDashboardLayout_legacy: (layout: any[]) => void;
    setDashboardFilters_legacy: (filters: DashboardFilter[]) => void;
}

interface HistoryEntry {
    label: string;
    config: any;
    timestamp: number;
}

interface HistoryState {
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

interface SavedQuestionsState {
    savedQuestions: SavedQuestion[];
    saveQuestion: (q: SavedQuestion) => void;
    deleteQuestion: (id: string) => void;
}

export interface DashboardFilter {
    column: string;
    /** 'dimension' = categorical / 'measure' = numeric comparison */
    type?: 'dimension' | 'measure';
    /** Categorical: selected string values (WHERE col IN [...]) */
    values: string[];
    /** Numeric: comparison operator */
    operator?: '>' | '<' | '=' | '!=' | '>=' | '<=';
    /** Numeric: value to compare against */
    numericValue?: number;
}

interface DashboardFilterState {
    selectedDatasetId: string | null;
    setSelectedDatasetId: (id: string | null) => void;
}

type AppStore = UIState & DataState & WorkbenchState & MultiDashboardState & HistoryState & SavedQuestionsState & DashboardFilterState;

// ── Helper: find active dashboard ──
function getActive(dashboards: DashboardDefinition[], activeDashboardId: string | null): DashboardDefinition | undefined {
    if (!activeDashboardId) return dashboards[0];
    return dashboards.find(d => d.id === activeDashboardId) || dashboards[0];
}

function updateDashboard(
    dashboards: DashboardDefinition[],
    id: string,
    updater: (d: DashboardDefinition) => DashboardDefinition
): DashboardDefinition[] {
    return dashboards.map(d => d.id === id ? updater(d) : d);
}

/**
 * After any dashboard mutation, sync the backward-compat `items`, `dashboardLayout`,
 * and `dashboardFilters` from the active dashboard so existing components see the data.
 */
function syncFromActive(dashboards: DashboardDefinition[], activeDashboardId: string | null) {
    const active = getActive(dashboards, activeDashboardId);
    return {
        items: active?.items || [],
        dashboardLayout: active?.layout || null,
        dashboardFilters: (active?.filters || []) as DashboardFilter[],
    };
}

export const useAppStore = create<AppStore>()(
    persist(
        (set, get) => ({
            // UI Slice
            activeTab: Tab.UPLOAD,
            isSidebarOpen: true,
            showAbout: false,
            appFontSize: 14,
            appFontBold: false,
            theme: 'dark',
            hiddenTabs: [],
            setActiveTab: (tab) => set({ activeTab: tab }),
            toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
            setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
            toggleAbout: (show) => set({ showAbout: show }),
            setAppFontSize: (size) => set({ appFontSize: size }),
            toggleAppFontBold: () => set((state) => ({ appFontBold: !state.appFontBold })),
            setTheme: (theme) => set({ theme }),
            toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
            toggleTabVisibility: (tabId) => set((state) => ({
                hiddenTabs: state.hiddenTabs.includes(tabId)
                    ? state.hiddenTabs.filter(t => t !== tabId)
                    : [...state.hiddenTabs, tabId]
            })),
            setHiddenTabs: (tabs) => set({ hiddenTabs: tabs }),

            // Data Slice
            dataset: null,
            datasets: [],
            isProcessing: false,
            error: null,
            setDataset: (dataset) => set((state) => {
                if (!dataset) return { dataset };
                const exists = state.datasets.some(d => d.id === dataset.id);
                return {
                    dataset,
                    datasets: exists ? state.datasets.map(d => d.id === dataset.id ? dataset : d) : [...state.datasets, dataset]
                };
            }),
            addDataset: (dataset) => set((state) => {
                const exists = state.datasets.some(d => d.id === dataset.id);
                return { datasets: exists ? state.datasets : [...state.datasets, dataset] };
            }),
            removeDataset: (id) => set((state) => ({
                datasets: state.datasets.filter(d => d.id !== id),
                dataset: state.dataset?.id === id ? (state.datasets.filter(d => d.id !== id)[0] || null) : state.dataset
            })),
            setActiveDatasetById: (id) => set((state) => ({
                dataset: state.datasets.find(d => d.id === id) || state.dataset
            })),
            setProcessing: (isProcessing) => set({ isProcessing }),
            setError: (error) => set({ error }),

            // Workbench Slice
            config: undefined,
            result: undefined,
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
            setWorkbenchState: (config, result) => set({ config, result }),
            updateFormatting: (formatting) => set({ formatting }),

            // ── Multi-Dashboard Slice ────────────────────────────────
            dashboards: [],
            activeDashboardId: null,

            // Synced backward-compat properties (updated after every mutation)
            items: [],
            dashboardLayout: null,
            dashboardFilters: [],

            createDashboard: (name: string) => {
                const id = generateId();
                set((state) => {
                    const newDashboards = [...state.dashboards, {
                        id,
                        name,
                        items: [],
                        layout: null,
                        filters: [],
                        createdAt: Date.now(),
                    }];
                    return {
                        dashboards: newDashboards,
                        activeDashboardId: id,
                        ...syncFromActive(newDashboards, id),
                    };
                });
                debouncedDashboardPush(get().dashboards);
                return id;
            },

            renameDashboard: (id, name) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, id, d => ({ ...d, name }));
                return { dashboards: newDashboards };
            }),

            setDashboardMeta: (id, meta) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, id, d => ({ ...d, ...meta }));
                return { dashboards: newDashboards };
            }),

            deleteDashboard: (id) => set((state) => {
                const remaining = state.dashboards.filter(d => d.id !== id);
                const newActiveId = state.activeDashboardId === id
                    ? (remaining[0]?.id || null)
                    : state.activeDashboardId;
                return {
                    dashboards: remaining,
                    activeDashboardId: newActiveId,
                    ...syncFromActive(remaining, newActiveId),
                };
            }),

            duplicateDashboard: (id) => {
                const newId = generateId();
                set((state) => {
                    const source = state.dashboards.find(d => d.id === id);
                    if (!source) return {};
                    const newDashboards = [...state.dashboards, {
                        ...source,
                        id: newId,
                        name: `${source.name} (Copy)`,
                        items: source.items.map(item => ({ ...item, id: generateId() })),
                        createdAt: Date.now(),
                    }];
                    return {
                        dashboards: newDashboards,
                        activeDashboardId: newId,
                        ...syncFromActive(newDashboards, newId),
                    };
                });
                return newId;
            },

            setActiveDashboard: (id) => set((state) => ({
                activeDashboardId: id,
                ...syncFromActive(state.dashboards, id),
            })),

            addItemToDashboard: (dashboardId, item) => {
                console.log(`[DashSync] 📌 Pinning "${item.title || item.id}" to dashboard ${dashboardId}`);
                set((state) => {
                    const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                        ...d,
                        items: [...d.items, item],
                    }));
                    return {
                        dashboards: newDashboards,
                        ...syncFromActive(newDashboards, state.activeDashboardId),
                    };
                });
                debouncedDashboardPush(get().dashboards);
            },

            removeItemFromDashboard: (dashboardId, itemId) => {
                set((state) => {
                    const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                        ...d,
                        items: d.items.filter(i => i.id !== itemId),
                    }));
                    return {
                        dashboards: newDashboards,
                        ...syncFromActive(newDashboards, state.activeDashboardId),
                    };
                });
                debouncedDashboardPush(get().dashboards);
            },

            updateItemInDashboard: (dashboardId, item) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: d.items.map(i => i.id === item.id ? item : i),
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
            }),

            setDashboardLayout: (dashboardId, layout) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    layout,
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
            }),

            setDashboardFilters: (dashboardId, filters) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    filters,
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
            }),

            // ── Backward-Compat Convenience (operates on active dashboard) ──
            addItem: (item) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    state.addItemToDashboard(active.id, item);
                }
            },

            removeItem: (id) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    state.removeItemFromDashboard(active.id, id);
                }
            },

            updateItem: (item) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    state.updateItemInDashboard(active.id, item);
                }
            },

            setItems: (items) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    const newDashboards = updateDashboard(state.dashboards, active.id, d => ({ ...d, items }));
                    set({
                        dashboards: newDashboards,
                        items,
                    });
                }
            },

            clearAllItems: () => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    const newDashboards = updateDashboard(state.dashboards, active.id, d => ({ ...d, items: [] }));
                    set({
                        dashboards: newDashboards,
                        items: [],
                    });
                }
            },

            setDashboardLayout_legacy: (layout) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    state.setDashboardLayout(active.id, layout);
                }
            },

            setDashboardFilters_legacy: (filters) => {
                const state = get();
                const active = getActive(state.dashboards, state.activeDashboardId);
                if (active) {
                    state.setDashboardFilters(active.id, filters);
                }
            },

            // History Slice
            queryHistory: [],
            addToHistory: (entry) => set((state) => ({
                queryHistory: [entry, ...state.queryHistory].slice(0, 20)
            })),
            clearHistory: () => set({ queryHistory: [] }),

            // Saved Questions Slice
            savedQuestions: [],
            saveQuestion: (q) => set((state) => ({
                savedQuestions: [...state.savedQuestions, q]
            })),
            deleteQuestion: (id) => set((state) => ({
                savedQuestions: state.savedQuestions.filter(q => q.id !== id)
            })),

            // Dataset Filter Slice
            selectedDatasetId: null,
            setSelectedDatasetId: (id) => set({ selectedDatasetId: id }),
        }),
        {
            name: 'QuickInsight-storage-v4',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                dashboards: state.dashboards,
                activeDashboardId: state.activeDashboardId,
                formatting: state.formatting,
                queryHistory: state.queryHistory,
                savedQuestions: state.savedQuestions,
                theme: state.theme,
                // NOTE: datasets are persisted via IndexedDB (see datasetDB.ts), NOT localStorage
            }),
            // ── Migration: v3 (single dashboard) → v4 (multi-dashboard) ──
            migrate: (persisted: any, version: number) => {
                if (persisted && !persisted.dashboards) {
                    const legacyItems = persisted.items || [];
                    const legacyLayout = persisted.dashboardLayout || null;
                    const legacyFilters = persisted.dashboardFilters || [];

                    const defaultDashboard: DashboardDefinition = {
                        id: generateId(),
                        name: 'Dashboard 1',
                        items: legacyItems,
                        layout: legacyLayout,
                        filters: legacyFilters,
                        createdAt: Date.now(),
                    };

                    persisted.dashboards = legacyItems.length > 0 ? [defaultDashboard] : [];
                    persisted.activeDashboardId = legacyItems.length > 0 ? defaultDashboard.id : null;

                    delete persisted.items;
                    delete persisted.dashboardLayout;
                    delete persisted.dashboardFilters;

                    console.log(`[Store] Migrated v3 → v4: ${legacyItems.length} items → Dashboard 1`);
                }

                // After hydration, sync the backward-compat properties
                if (persisted?.dashboards) {
                    const active = getActive(persisted.dashboards, persisted.activeDashboardId);
                    persisted.items = active?.items || [];
                    persisted.dashboardLayout = active?.layout || null;
                    persisted.dashboardFilters = active?.filters || [];
                }

                return persisted;
            },
            version: 4,
            // ── Critical: sync backward-compat properties after EVERY rehydrate ──
            // The migrate function only runs on version mismatch. We need this to
            // always sync items/dashboardLayout/dashboardFilters from the active
            // dashboard, including after login/logout cycles.
            onRehydrateStorage: () => (state) => {
                if (state?.dashboards && state.dashboards.length > 0) {
                    const synced = syncFromActive(state.dashboards, state.activeDashboardId);
                    useAppStore.setState(synced);
                    console.log(`[Store] Rehydrated: synced ${synced.items.length} items from active dashboard`);
                }
            },
        }
    )
);

/** Reset all user-specific data in the app store. Call on login/logout. */
export function resetUserData(): void {
    useAppStore.setState({
        dataset: null,
        datasets: [],
        dashboards: [],
        activeDashboardId: null,
        items: [],
        dashboardLayout: null,
        dashboardFilters: [],
        queryHistory: [],
        savedQuestions: [],
        config: undefined,
        result: undefined,
        selectedDatasetId: null,
        activeTab: 'upload' as any,
    });
}
