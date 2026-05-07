
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Dataset, DashboardItem, DashboardDefinition, AnalysisResult, QueryConfig, FormattingConfig, Tab } from '../types';

// ── Helpers ──────────────────────────────────────────────────────
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

interface UIState {
    activeTab: Tab;
    isSidebarOpen: boolean;
    showAbout: boolean;
    appFontSize: number; // Numeric font size in pixels (e.g. 14, 16)
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
    createDashboard: (name: string) => string; // returns new dashboard ID
    renameDashboard: (id: string, name: string) => void;
    deleteDashboard: (id: string) => void;
    duplicateDashboard: (id: string) => string; // returns new dashboard ID
    setActiveDashboard: (id: string) => void;

    // Item operations (scoped to a target dashboard)
    addItemToDashboard: (dashboardId: string, item: DashboardItem) => void;
    removeItemFromDashboard: (dashboardId: string, itemId: string) => void;
    updateItemInDashboard: (dashboardId: string, item: DashboardItem) => void;
    setDashboardLayout: (dashboardId: string, layout: any[]) => void;
    setDashboardFilters: (dashboardId: string, filters: any[]) => void;

    // Backward-compat convenience — operates on activeDashboardId
    addItem: (item: DashboardItem) => void;
    removeItem: (id: string) => void;
    updateItem: (item: DashboardItem) => void;
    setItems: (items: DashboardItem[]) => void;
    clearAllItems: () => void;
}

// Legacy items/layout/filters kept as computed getters via the active dashboard
interface LegacyDashboardCompat {
    /** items[] from the active dashboard (backward compat) */
    items: DashboardItem[];
    /** layout from the active dashboard (backward compat) */
    dashboardLayout: any[] | null;
    /** filters from the active dashboard (backward compat) */
    dashboardFilters: DashboardFilter[];
    /** Legacy setters that proxy to active dashboard */
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

type AppStore = UIState & DataState & WorkbenchState & MultiDashboardState & LegacyDashboardCompat & HistoryState & SavedQuestionsState & DashboardFilterState;

// ── Helper: find the active dashboard or return undefined ──
function getActiveDashboard(state: { dashboards: DashboardDefinition[]; activeDashboardId: string | null }): DashboardDefinition | undefined {
    if (!state.activeDashboardId) return state.dashboards[0];
    return state.dashboards.find(d => d.id === state.activeDashboardId) || state.dashboards[0];
}

function updateDashboard(
    dashboards: DashboardDefinition[],
    id: string,
    updater: (d: DashboardDefinition) => DashboardDefinition
): DashboardDefinition[] {
    return dashboards.map(d => d.id === id ? updater(d) : d);
}

export const useAppStore = create<AppStore>()(
    persist(
        (set, get) => ({
            // UI Slice
            activeTab: Tab.UPLOAD,
            isSidebarOpen: true,
            showAbout: false,
            appFontSize: 14, // Default 14px
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
                numberFormat: 'auto', // Default to Intelligent Auto
                fontSize: 'md',
                headerSize: 'lg',
                headerBold: true,
                showLabels: true,
                showDataLabels: false,
                showAxis: false, // Explicitly default to hidden
                tableCalculations: []
            },
            setWorkbenchState: (config, result) => set({ config, result }),
            updateFormatting: (formatting) => set({ formatting }),

            // ── Multi-Dashboard Slice ────────────────────────────────
            dashboards: [],
            activeDashboardId: null,

            createDashboard: (name: string) => {
                const id = generateId();
                set((state) => ({
                    dashboards: [...state.dashboards, {
                        id,
                        name,
                        items: [],
                        layout: null,
                        filters: [],
                        createdAt: Date.now(),
                    }],
                    activeDashboardId: id,
                }));
                return id;
            },

            renameDashboard: (id, name) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, id, d => ({ ...d, name })),
            })),

            deleteDashboard: (id) => set((state) => {
                const remaining = state.dashboards.filter(d => d.id !== id);
                return {
                    dashboards: remaining,
                    activeDashboardId: state.activeDashboardId === id
                        ? (remaining[0]?.id || null)
                        : state.activeDashboardId,
                };
            }),

            duplicateDashboard: (id) => {
                const newId = generateId();
                set((state) => {
                    const source = state.dashboards.find(d => d.id === id);
                    if (!source) return {};
                    return {
                        dashboards: [...state.dashboards, {
                            ...source,
                            id: newId,
                            name: `${source.name} (Copy)`,
                            items: source.items.map(item => ({ ...item, id: generateId() })),
                            createdAt: Date.now(),
                        }],
                        activeDashboardId: newId,
                    };
                });
                return newId;
            },

            setActiveDashboard: (id) => set({ activeDashboardId: id }),

            addItemToDashboard: (dashboardId, item) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: [...d.items, item],
                })),
            })),

            removeItemFromDashboard: (dashboardId, itemId) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: d.items.filter(i => i.id !== itemId),
                })),
            })),

            updateItemInDashboard: (dashboardId, item) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: d.items.map(i => i.id === item.id ? item : i),
                })),
            })),

            setDashboardLayout: (dashboardId, layout) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    layout,
                })),
            })),

            setDashboardFilters: (dashboardId, filters) => set((state) => ({
                dashboards: updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    filters,
                })),
            })),

            // ── Backward-Compat Convenience (operates on active dashboard) ──
            get items() {
                const state = get();
                const active = getActiveDashboard(state);
                return active?.items || [];
            },

            get dashboardLayout() {
                const state = get();
                const active = getActiveDashboard(state);
                return active?.layout || null;
            },

            get dashboardFilters() {
                const state = get();
                const active = getActiveDashboard(state);
                return (active?.filters || []) as DashboardFilter[];
            },

            addItem: (item) => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    state.addItemToDashboard(active.id, item);
                }
            },

            removeItem: (id) => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    state.removeItemFromDashboard(active.id, id);
                }
            },

            updateItem: (item) => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    state.updateItemInDashboard(active.id, item);
                }
            },

            setItems: (items) => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    set((s) => ({
                        dashboards: updateDashboard(s.dashboards, active.id, d => ({ ...d, items })),
                    }));
                }
            },

            clearAllItems: () => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    set((s) => ({
                        dashboards: updateDashboard(s.dashboards, active.id, d => ({ ...d, items: [] })),
                    }));
                }
            },

            setDashboardLayout_legacy: (layout) => {
                const state = get();
                const active = getActiveDashboard(state);
                if (active) {
                    state.setDashboardLayout(active.id, layout);
                }
            },

            setDashboardFilters_legacy: (filters) => {
                const state = get();
                const active = getActiveDashboard(state);
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
            name: 'QuickInsight-storage-v4', // Bumped version for migration
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                dashboards: state.dashboards,
                activeDashboardId: state.activeDashboardId,
                formatting: state.formatting,
                queryHistory: state.queryHistory,
                savedQuestions: state.savedQuestions,
                theme: state.theme,
                // NOTE: datasets are persisted via IndexedDB (see datasetDB.ts), NOT localStorage
                // localStorage has a 5MB cap which is too small for real datasets
            }),
            // ── Migration: v3 (single dashboard) → v4 (multi-dashboard) ──
            migrate: (persisted: any, version: number) => {
                if (persisted && !persisted.dashboards) {
                    // Old format had items[], dashboardLayout, dashboardFilters at root
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

                    // Clean up old keys
                    delete persisted.items;
                    delete persisted.dashboardLayout;
                    delete persisted.dashboardFilters;

                    console.log(`[Store] Migrated v3 → v4: ${legacyItems.length} items → Dashboard 1`);
                }
                return persisted;
            },
            version: 4,
        }
    )
);
