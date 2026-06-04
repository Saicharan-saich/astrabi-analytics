
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Dataset, DashboardItem, DashboardDefinition, AnalysisResult, QueryConfig, FormattingConfig, Tab } from '../types';

// ── Helpers ──────────────────────────────────────────────────────
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

interface UIState {
    activeTab: Tab;
    isSidebarOpen: boolean;
    showAbout: boolean;
    appFontSize: number;
    appFontBold: boolean;
    theme: 'dark' | 'light';
    setActiveTab: (tab: Tab) => void;
    toggleSidebar: () => void;
    setSidebarOpen: (isOpen: boolean) => void;
    toggleAbout: (show: boolean) => void;
    setAppFontSize: (size: number) => void;
    toggleAppFontBold: () => void;
    setTheme: (theme: 'dark' | 'light') => void;
    toggleTheme: () => void;
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
            setActiveTab: (tab) => set({ activeTab: tab }),
            toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
            setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
            toggleAbout: (show) => set({ showAbout: show }),
            setAppFontSize: (size) => set({ appFontSize: size }),
            toggleAppFontBold: () => set((state) => ({ appFontBold: !state.appFontBold })),
            setTheme: (theme) => set({ theme }),
            toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

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
                showDataLabels: false,
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
                return id;
            },

            renameDashboard: (id, name) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, id, d => ({ ...d, name }));
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

            addItemToDashboard: (dashboardId, item) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: [...d.items, item],
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
            }),

            removeItemFromDashboard: (dashboardId, itemId) => set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: d.items.filter(i => i.id !== itemId),
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
            }),

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
