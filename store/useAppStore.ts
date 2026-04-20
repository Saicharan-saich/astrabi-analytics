
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Dataset, DashboardItem, AnalysisResult, QueryConfig, FormattingConfig, Tab } from '../types';

interface UIState {
    activeTab: Tab;
    isSidebarOpen: boolean;
    showAbout: boolean;
    appFontSize: number; // Numeric font size in pixels (e.g. 14, 16)
    appFontBold: boolean;
    theme: 'dark' | 'light';
    setActiveTab: (tab: Tab) => void;
    toggleSidebar: () => void;
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

interface DashboardState {
    items: DashboardItem[];
    addItem: (item: DashboardItem) => void;
    removeItem: (id: string) => void;
    updateItem: (item: DashboardItem) => void;
    setItems: (items: DashboardItem[]) => void;
    clearAllItems: () => void;
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

interface DashboardLayoutState {
    dashboardLayout: any[] | null;
    setDashboardLayout: (layout: any[]) => void;
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
    dashboardFilters: DashboardFilter[];
    setDashboardFilters: (filters: DashboardFilter[]) => void;
}

type AppStore = UIState & DataState & WorkbenchState & DashboardState & HistoryState & SavedQuestionsState & DashboardLayoutState & DashboardFilterState;

export const useAppStore = create<AppStore>()(
    persist(
        (set) => ({
            // UI Slice
            activeTab: Tab.UPLOAD,
            isSidebarOpen: true,
            showAbout: false,
            appFontSize: 14, // Default 14px
            appFontBold: false,
            theme: 'dark',
            setActiveTab: (tab) => set({ activeTab: tab }),
            toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
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

            // Dashboard Slice
            items: [],
            addItem: (item) => set((state) => ({ items: [...state.items, item] })),
            removeItem: (id) => set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
            updateItem: (updatedItem) => set((state) => ({
                items: state.items.map((i) => (i.id === updatedItem.id ? updatedItem : i))
            })),
            setItems: (items) => set({ items }),
            clearAllItems: () => set({ items: [] }),

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

            // Dashboard Layout Slice
            dashboardLayout: null,
            setDashboardLayout: (layout) => set({ dashboardLayout: layout }),

            // Dashboard Filter Slice
            dashboardFilters: [],
            setDashboardFilters: (filters) => set({ dashboardFilters: filters }),
        }),
        {
            name: 'QuickInsight-storage-v3', // unique name
            storage: createJSONStorage(() => localStorage), // (optional) by default, 'localStorage' is used
            partialize: (state) => ({
                items: state.items,
                formatting: state.formatting,
                queryHistory: state.queryHistory,
                savedQuestions: state.savedQuestions,
                dashboardLayout: state.dashboardLayout,
                dashboardFilters: state.dashboardFilters,
                theme: state.theme,
                // NOTE: datasets are persisted via IndexedDB (see datasetDB.ts), NOT localStorage
                // localStorage has a 5MB cap which is too small for real datasets
            }),
        }
    )
);
