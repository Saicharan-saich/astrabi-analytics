
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Dataset, DashboardItem, DashboardDefinition, AnalysisResult, QueryConfig, FormattingConfig, Tab } from '../types';
import { saveCloudDashboard, fetchCloudDashboards, deleteCloudDashboard as deleteCloudDb, getDashboardSession, isDashboardSessionCurrent, cancelDashboardSync } from '../services/dashboardCloudSync';
import { restoreDashboardItems } from '../services/dashboardRestore';

// ── Helpers ──────────────────────────────────────────────────────
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

// ── Cloud Sync for Multi-Dashboard State ─────────────────────────
let dashPushTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedDashboardPush(dashboards: DashboardDefinition[]) {
    if (dashPushTimer) clearTimeout(dashPushTimer);
    const session = getDashboardSession();
    if (!session) return;
    dashPushTimer = setTimeout(() => {
        if (!isDashboardSessionCurrent(session)) return;
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
        }, session))).then(results => {
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
    const session = getDashboardSession();
    if (!session) return false;
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
        }, session)));
        const ok = results.filter(Boolean).length;
        console.log(`[DashSync] ✅ Flushed ${ok}/${dashboards.length} dashboards`);
        return ok === dashboards.length;
    } catch (err) {
        console.error('[DashSync] ❌ Flush failed:', err);
        return false;
    }
}

/** Pull dashboards from cloud and merge into local state. Call on login. */
export async function syncDashboardsFromCloud(): Promise<void> {
    const session = getDashboardSession();
    if (!session) return;
    try {
        console.log('[DashSync] 📥 Pulling dashboards from cloud...');
        const fetched = await fetchCloudDashboards(session);
        if (!isDashboardSessionCurrent(session)) return;

        // Older releases left a reset flag that could erase valid cloud
        // dashboards at login. Retain definitions and retire the flag.
        if (useAppStore.getState().resetLegacyDashboards) {
            useAppStore.setState({ resetLegacyDashboards: false });
        }

        // Drop anything the user deleted locally. Without this the pull hands
        // back a dashboard they just removed, because the cloud copy outlived
        // it. Any tombstone still present means the cloud delete never
        // confirmed, so retry it here.
        const tombstones = useAppStore.getState().deletedDashboardIds || [];
        const cloudDashboards = tombstones.length
            ? fetched.filter(cd => !tombstones.includes(cd.id))
            : fetched;
        if (tombstones.length) {
            const stillThere = fetched.filter(cd => tombstones.includes(cd.id)).map(cd => cd.id);
            if (stillThere.length) {
                console.log(`[DashSync] Re-deleting ${stillThere.length} dashboard(s) the cloud still holds`);
                for (const id of stillThere) {
                    deleteCloudDb(id, session)
                        .then(ok => { if (ok && isDashboardSessionCurrent(session)) useAppStore.setState(st => ({ deletedDashboardIds: (st.deletedDashboardIds || []).filter(x => x !== id) })); })
                        .catch(() => { /* keep the tombstone and try again next sync */ });
                }
            } else {
                // Nothing left to delete — clear the tombstones.
                useAppStore.setState({ deletedDashboardIds: [] });
            }
        }

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
                items: restoreDashboardItems(cd.items || [],
                    useAppStore.getState().dashboards.find(d => d.id === cd.id)?.items || []),
                layout: sanitizeLayout(cd.layout, cd.items || []),
                filters: cd.filters || [],
                createdAt: cd.created_at ? new Date(cd.created_at).getTime() : Date.now(),
            }));
            const active = restored.find(d => d.id === useAppStore.getState().activeDashboardId) || restored[0];
            useAppStore.setState({
                dashboards: restored,
                activeDashboardId: active.id,
                ...syncFromActive(restored, active.id),
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
    lastActiveDatasetId: string | null;
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
    dedupeOverviewDashboards: () => number;
    deleteDashboard: (id: string) => void;
    /** Dashboards deleted locally whose cloud copy is not yet confirmed gone. */
    deletedDashboardIds: string[];
    /** One-time migration flag that removes pre-reset dashboards from local and cloud storage. */
    resetLegacyDashboards: boolean;
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
            lastActiveDatasetId: null,
            datasets: [],
            isProcessing: false,
            error: null,
            setDataset: (dataset) => set((state) => {
                if (!dataset) return { dataset };
                const exists = state.datasets.some(d => d.id === dataset.id);
                return {
                    dataset,
                    lastActiveDatasetId: dataset.id,
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
                dataset: state.datasets.find(d => d.id === id) || state.dataset,
                lastActiveDatasetId: state.datasets.some(d => d.id === id) ? id : state.lastActiveDatasetId,
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
                headerSize: 'xl',
                headerBold: true,
                showLabels: true,
                showDataLabels: true,
                showAxis: true,
                showXAxis: true,
                showYAxis: true,
                headerColor: '#000000',
                axisColor: '#000000',
                axisBold: true,
                axisLabelSize: 'md',
                dataLabelColor: '#000000',
                dataLabelBold: true,
                dataLabelSize: 'md',
                tableCalculations: []
            },
            setWorkbenchState: (config, result) => set({ config, result }),
            updateFormatting: (formatting) => set({ formatting }),

            // ── Multi-Dashboard Slice ────────────────────────────────
            dashboards: [],
            activeDashboardId: null,
            deletedDashboardIds: [],
            resetLegacyDashboards: false,

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

            renameDashboard: (id, name) => {
                set((state) => {
                const newDashboards = updateDashboard(state.dashboards, id, d => ({ ...d, name }));
                return { dashboards: newDashboards };
                });
                debouncedDashboardPush(get().dashboards);
            },

            setDashboardMeta: (id, meta) => {
                set((state) => {
                const newDashboards = updateDashboard(state.dashboards, id, d => ({ ...d, ...meta }));
                return { dashboards: newDashboards };
                });
                debouncedDashboardPush(get().dashboards);
            },

            // Collapse duplicate auto-built "— Overview" dashboards, keeping the
            // newest of each name group. Only touches auto-generated Overviews so a
            // user's hand-made dashboards are never removed. Returns how many were
            // deleted. Invoked manually from the "Clean up duplicates" button.
            dedupeOverviewDashboards: () => {
                const state = get();
                const groups = new Map<string, DashboardDefinition[]>();
                for (const d of state.dashboards) {
                    const isAuto = d.autoGenerated === true || / — Overview$/.test(d.name);
                    if (!isAuto) continue;
                    const key = d.name;
                    (groups.get(key) || groups.set(key, []).get(key)!).push(d);
                }
                const removeIds: string[] = [];
                for (const list of groups.values()) {
                    if (list.length <= 1) continue;
                    // Keep the most recently created; drop the rest.
                    const sorted = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                    for (const dup of sorted.slice(1)) removeIds.push(dup.id);
                }
                if (removeIds.length === 0) return 0;

                const remaining = state.dashboards.filter(d => !removeIds.includes(d.id));
                const newActiveId = removeIds.includes(state.activeDashboardId || '')
                    ? (remaining[0]?.id || null)
                    : state.activeDashboardId;
                set({
                    dashboards: remaining,
                    activeDashboardId: newActiveId,
                    ...syncFromActive(remaining, newActiveId),
                });
                debouncedDashboardPush(get().dashboards);
                return removeIds.length;
            },

            deleteDashboard: (id) => {
                const session = getDashboardSession();
                // Deleting used to be local only, so the cloud copy survived and
                // the next login pulled it straight back. Record a tombstone
                // first — that way the deletion sticks even if the network call
                // fails, because the pull filters tombstoned ids out.
                set((state) => {
                    const remaining = state.dashboards.filter(d => d.id !== id);
                    const newActiveId = state.activeDashboardId === id
                        ? (remaining[0]?.id || null)
                        : state.activeDashboardId;
                    return {
                        dashboards: remaining,
                        activeDashboardId: newActiveId,
                        deletedDashboardIds: [...new Set([...(state.deletedDashboardIds || []), id])],
                        ...syncFromActive(remaining, newActiveId),
                    };
                });
                debouncedDashboardPush(get().dashboards);
                deleteCloudDb(id, session)
                    .then(ok => {
                        if (ok && isDashboardSessionCurrent(session)) {
                            // Confirmed gone server-side — the tombstone has done its job.
                            set((state) => ({
                                deletedDashboardIds: (state.deletedDashboardIds || []).filter(x => x !== id),
                            }));
                            console.log(`[DashSync] 🗑️ Dashboard ${id} deleted from cloud`);
                        } else {
                            console.warn(`[DashSync] Cloud delete for ${id} did not confirm — tombstone kept, will retry on next sync`);
                        }
                    })
                    .catch(err => console.warn('[DashSync] Cloud delete failed — tombstone kept:', err?.message || err));
            },

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
                debouncedDashboardPush(get().dashboards);
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

            updateItemInDashboard: (dashboardId, item) => {
                set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    items: d.items.map(i => i.id === item.id ? item : i),
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
                });
                debouncedDashboardPush(get().dashboards);
            },

            setDashboardLayout: (dashboardId, layout) => {
                set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    layout,
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
                });
                debouncedDashboardPush(get().dashboards);
            },

            setDashboardFilters: (dashboardId, filters) => {
                set((state) => {
                const newDashboards = updateDashboard(state.dashboards, dashboardId, d => ({
                    ...d,
                    filters,
                }));
                return {
                    dashboards: newDashboards,
                    ...syncFromActive(newDashboards, state.activeDashboardId),
                };
                });
                debouncedDashboardPush(get().dashboards);
            },

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
                debouncedDashboardPush(get().dashboards);
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
                debouncedDashboardPush(get().dashboards);
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
                // Preserve the user's current workspace across a browser refresh.
                // Dataset payloads remain in IndexedDB; this stores only the Tab enum value.
                activeTab: state.activeTab,
                lastActiveDatasetId: state.lastActiveDatasetId,
                dashboards: state.dashboards,
                activeDashboardId: state.activeDashboardId,
                deletedDashboardIds: state.deletedDashboardIds,
                resetLegacyDashboards: state.resetLegacyDashboards,
                formatting: state.formatting,
                queryHistory: state.queryHistory,
                savedQuestions: state.savedQuestions,
                theme: state.theme,
                // NOTE: datasets are persisted via IndexedDB (see datasetDB.ts), NOT localStorage
            }),
            // ── Migration: v3 (single dashboard) → v4 (multi-dashboard) ──
            migrate: (persisted: any, version: number) => {
                // Preserve dashboard definitions during upgrades. Legacy reset
                // flags must not delete the user's saved work at cloud sync.
                if (persisted && version < 5) {
                    persisted.deletedDashboardIds = persisted.deletedDashboardIds || [];
                    persisted.resetLegacyDashboards = false;
                }

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

                // ── Chart legibility upgrade ──────────────────────────────
                // Axes used to default to hidden, and titles/labels rendered in
                // slate grey at a small size, which read as faint over a chart.
                // Those choices are stored, so an existing user would keep them
                // for ever. Clear the stale values once so the new defaults —
                // axes visible, black, bold, larger — take effect. Any colour or
                // size the user has since chosen deliberately is left alone.
                if (persisted?.formatting && !persisted.formatting._legibilityUpgraded) {
                    const f = persisted.formatting;
                    if (f.showAxis === false) f.showAxis = true;
                    if (f.showXAxis === undefined) f.showXAxis = true;
                    if (f.showYAxis === undefined) f.showYAxis = true;
                    if (!f.headerColor || f.headerColor === '#1e293b') f.headerColor = '#000000';
                    if (!f.axisColor || f.axisColor === '#64748b') f.axisColor = '#000000';
                    if (!f.dataLabelColor || f.dataLabelColor === '#334155') f.dataLabelColor = '#000000';
                    if (f.axisBold === undefined) f.axisBold = true;
                    if (f.headerBold === undefined) f.headerBold = true;
                    if (f.dataLabelBold === undefined) f.dataLabelBold = true;
                    if (!f.axisLabelSize) f.axisLabelSize = 'md';
                    if (!f.dataLabelSize) f.dataLabelSize = 'md';
                    if (!f.headerSize || f.headerSize === 'md' || f.headerSize === 'lg') f.headerSize = 'xl';
                    f._legibilityUpgraded = true;
                    console.log('[Store] Chart text upgraded: axes on, titles and labels black, bold and larger.');
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
            version: 5,
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
    if (dashPushTimer) { clearTimeout(dashPushTimer); dashPushTimer = null; }
    cancelDashboardSync();
    useAppStore.setState({
        dataset: null,
        lastActiveDatasetId: null,
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
        deletedDashboardIds: [],
        resetLegacyDashboards: false,
        activeTab: 'upload' as any,
    });
}
