import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
const ResponsiveGridLayout = WidthProvider(Responsive) as any;
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { DashboardResultVisualization } from './DashboardResultVisualization';
import { effectiveDataLabelMode, toggleDataLabels } from '../utils/dataLabelVisibility';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Trash2, Edit, AlertTriangle, X, FileDown, Presentation,
  ChevronLeft, ChevronRight, Maximize2, LayoutDashboard, GripVertical,
  BarChart3, PieChart, LineChart, Activity, Zap,
  Eye, Filter, ChevronDown, RefreshCw, SlidersHorizontal, Database,
  Plus, Pencil, Copy, MoreHorizontal, Check, Loader2, Tag, Sparkles
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { AnalysisResult, Dataset, DashboardItem, RefreshSchedule } from '../types';
import { DashboardFilter } from '../store/useAppStore';
import { RefreshSchedulerDropdown } from './RefreshSchedulerDropdown';
import { DashboardDateFilter } from './DashboardDateFilter';
import { dashboardDateFilterLabel } from '../utils/dashboardDateFilter';
import { filterDashboardRows } from '../utils/dashboardFilterRows';
import { dashboardFilterColumnExists, resolveDashboardFilterSource } from '../utils/dashboardFilterSource';
import { isItemPresentable, summariseDashboardReadiness } from '../utils/presentationReadiness';
import { PresentDashboardDialog } from './PresentDashboardDialog';

interface DashboardProps {
  dataset?: Dataset;
  onAddResult?: any;
  onEdit?: (item: any) => void;
  onLiveRefresh?: () => void;
  isLiveRefreshing?: boolean;
  refreshSchedule?: RefreshSchedule;
  onScheduleChange?: (schedule: RefreshSchedule) => void;
  onBuildDashboard?: () => void;
  isBuildingDashboard?: boolean;
}

// Format large numbers compactly
const formatCompact = (val: number): string => {
  if (Math.abs(val) >= 1_000_000) return (val / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(val) >= 1_000) return (val / 1_000).toFixed(1) + 'K';
  return val.toFixed(val % 1 === 0 ? 0 : 2);
};

// Get chart type icon
const getChartIcon = (vis: string) => {
  switch (vis) {
    case 'bar': return <BarChart3 className="w-3.5 h-3.5" />;
    case 'pie': return <PieChart className="w-3.5 h-3.5" />;
    case 'line': return <LineChart className="w-3.5 h-3.5" />;
    case 'area': return <Activity className="w-3.5 h-3.5" />;
    default: return <BarChart3 className="w-3.5 h-3.5" />;
  }
};

// Generate a subtle accent color for each card
const CARD_ACCENTS = [
  { border: 'hover:border-indigo-500/30', glow: 'shadow-indigo-500/5', accent: '#6366f1' },
  { border: 'hover:border-violet-500/30', glow: 'shadow-violet-500/5', accent: '#8b5cf6' },
  { border: 'hover:border-cyan-500/30', glow: 'shadow-cyan-500/5', accent: '#06b6d4' },
  { border: 'hover:border-emerald-500/30', glow: 'shadow-emerald-500/5', accent: '#10b981' },
  { border: 'hover:border-amber-500/30', glow: 'shadow-amber-500/5', accent: '#f59e0b' },
  { border: 'hover:border-rose-500/30', glow: 'shadow-rose-500/5', accent: '#f43f5e' },
];

// Inline editable title component
const EditableTitle: React.FC<{
  value: string;
  onSave: (newTitle: string) => void;
  className?: string;
  inputClassName?: string;
}> = ({ value, onSave, className = '', inputClassName = '' }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={`bg-transparent border-b-2 border-indigo-400 outline-none font-bold ${inputClassName}`}
        style={{ width: `${Math.max(draft.length, 8)}ch` }}
      />
    );
  }

  return (
    <span
      className={`cursor-pointer hover:opacity-70 transition-opacity ${className}`}
      onClick={e => { e.stopPropagation(); setEditing(true); }}
      title="Click to edit title"
    >
      {value}
    </span>
  );
};

// Colour palette for dataset badges
const DATASET_COLORS = [
  { bg: 'bg-cyan-500/15', text: 'text-cyan-400', dot: 'bg-cyan-400' },
  { bg: 'bg-amber-500/15', text: 'text-amber-400', dot: 'bg-amber-400' },
  { bg: 'bg-pink-500/15', text: 'text-pink-400', dot: 'bg-pink-400' },
  { bg: 'bg-lime-500/15', text: 'text-lime-400', dot: 'bg-lime-400' },
  { bg: 'bg-violet-500/15', text: 'text-violet-400', dot: 'bg-violet-400' },
  { bg: 'bg-orange-500/15', text: 'text-orange-400', dot: 'bg-orange-400' },
];

export const Dashboard: React.FC<DashboardProps> = ({ dataset, onAddResult, onEdit, onLiveRefresh, isLiveRefreshing, refreshSchedule, onScheduleChange, onBuildDashboard, isBuildingDashboard }) => {
  const {
    dashboards, activeDashboardId, setActiveDashboard, createDashboard, renameDashboard, deleteDashboard, duplicateDashboard, dedupeOverviewDashboards,
    items, removeItem, updateItem, formatting, clearAllItems,
    dashboardLayout, dashboardFilters,
    setDashboardLayout_legacy: setDashboardLayout,
    setDashboardFilters_legacy: setDashboardFilters,
    selectedDatasetId, setSelectedDatasetId,
  } = useAppStore();
  const availableDatasets = useAppStore(state => state.datasets);

  // ── Multi-Dashboard Tab State ────────────────────────────────
  const [renamingDashboardId, setRenamingDashboardId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });

  const activeDashboard = dashboards.find(d => d.id === activeDashboardId) || dashboards[0];

  const handleCreateDashboard = () => {
    const count = dashboards.length + 1;
    createDashboard(`Dashboard ${count}`);
  };

  // ── Duplicate "— Overview" cleanup (manual, opt-in) ──────────
  // Count how many auto-built Overview tabs are redundant (same name group,
  // minus one keeper each). The button only appears when there's ≥1 to remove.
  const [cleanupMsg, setCleanupMsg] = useState('');
  const duplicateOverviewCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of dashboards) {
      if (d.autoGenerated === true || / — Overview$/.test(d.name)) {
        counts.set(d.name, (counts.get(d.name) || 0) + 1);
      }
    }
    let redundant = 0;
    for (const n of counts.values()) if (n > 1) redundant += n - 1;
    return redundant;
  }, [dashboards]);

  const handleCleanupDuplicates = () => {
    const removed = dedupeOverviewDashboards();
    setCleanupMsg(removed > 0 ? `Removed ${removed} duplicate ${removed === 1 ? 'tab' : 'tabs'}` : 'No duplicates found');
    setTimeout(() => setCleanupMsg(''), 3000);
  };

  const handleTabContextMenu = (e: React.MouseEvent, dbId: string) => {
    e.preventDefault();
    setContextMenuId(dbId);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleStartRename = (dbId: string) => {
    const db = dashboards.find(d => d.id === dbId);
    setRenamingDashboardId(dbId);
    setRenameValue(db?.name || '');
    setContextMenuId(null);
  };

  const handleFinishRename = () => {
    if (renamingDashboardId && renameValue.trim()) {
      renameDashboard(renamingDashboardId, renameValue.trim());
    }
    setRenamingDashboardId(null);
  };

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenuId) return;
    const close = () => setContextMenuId(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenuId]);


  // ── Dataset scoping ─────────────────────────────────────────
  const uniqueDatasets = useMemo(() => {
    const map = new Map<string, string>();
    items.forEach(item => {
      if (item.datasetId && item.datasetName) map.set(item.datasetId, item.datasetName);
    });
    return Array.from(map.entries()); // [[id, name], ...]
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!selectedDatasetId) return items;
    return items.filter(item => item.datasetId === selectedDatasetId);
  }, [items, selectedDatasetId]);

  // Map dataset IDs to colours for badges
  const datasetColorMap = useMemo(() => {
    const map = new Map<string, typeof DATASET_COLORS[0]>();
    uniqueDatasets.forEach(([id], i) => map.set(id, DATASET_COLORS[i % DATASET_COLORS.length]));
    return map;
  }, [uniqueDatasets]);
  const [showClearModal, setShowClearModal] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  // Present: the user first picks a dashboard; by default only visuals whose
  // data is loaded become slides (others would just show an error).
  const [showPresentPicker, setShowPresentPicker] = useState(false);
  const [presentOnlyReady, setPresentOnlyReady] = useState(true);
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterColumn, setFilterColumn] = useState<string>('');
  const [filterMeasureOp, setFilterMeasureOp] = useState<'>' | '<' | '=' | '!=' | '>=' | '<='>('>');
  const [filterMeasureValue, setFilterMeasureValue] = useState<string>('');
  const [refreshingCards, setRefreshingCards] = useState<Set<string>>(new Set());
  const [filteredSqlCards, setFilteredSqlCards] = useState<Record<string, {
    key: string; result?: AnalysisResult; error?: string;
  }>>({});
  const filterQueue = useRef<Promise<void>>(Promise.resolve());
  const filterSignature = JSON.stringify(dashboardFilters);
  const filterSource = (item: DashboardItem) => resolveDashboardFilterSource(item, dataset, availableDatasets);
  const filterSourceError = (item: DashboardItem) => {
    if (!dashboardFilters.length || item.ignoreGlobalFilter) return null;
    const source = filterSource(item);
    if (!source) return 'This card’s source dataset is not available locally. Reopen or reconnect it to apply dashboard filters.';
    const missing = dashboardFilters.find(filter => !dashboardFilterColumnExists(source, filter.column));
    return missing ? `The card’s source dataset does not have “${missing.column}”. This filter cannot be applied to this card.` : null;
  };
  const isSqlCard = (item: DashboardItem) => Boolean(item.result.aiSqlRefresh
    || item.result.queryConfig?.aiSql || (!item.result.queryConfig && item.result.sql));
  const usesSqlFilter = (item: DashboardItem) => dashboardFilters.length > 0 && !item.ignoreGlobalFilter
    && !item.result.needsLocalData && isSqlCard(item) && !filterSourceError(item);
  const sqlFilterKey = (item: DashboardItem) => [activeDashboardId, filterSource(item)?.id, filterSource(item)?.version,
    filterSignature, item.id, item.pinnedAt, item.result.aiSqlRefresh?.sql || item.result.queryConfig?.aiSql || item.result.sql].join(':');

  // Saved SQL must be evaluated at the source grain. Filtering its already
  // aggregated chart rows would leave KPIs unchanged or corrupt multi-metric
  // comparisons. Keep this derived answer local and never overwrite the pin.
  useEffect(() => {
    let cancelled = false;
    if (!dashboardFilters.length) return () => { cancelled = true; };
    const cards = filteredItems.filter(item => usesSqlFilter(item));
    if (!cards.length) return () => { cancelled = true; };
    const run = async () => {
      for (const item of cards) {
        if (cancelled) return;
        const source = filterSource(item);
        if (!source) continue;
        const rows = filterDashboardRows(source.rows, source.columns, dashboardFilters);
        const key = sqlFilterKey(item);
        try {
          const { rebuildDashboardItem } = await import('../services/dashboardRestore');
          const refreshed = await rebuildDashboardItem(item, source, rows);
          if (!cancelled) setFilteredSqlCards(previous => ({ ...previous, [item.id]: { key, result: refreshed.result } }));
        } catch (error) {
          if (!cancelled) setFilteredSqlCards(previous => ({ ...previous, [item.id]: {
            key, error: error instanceof Error ? error.message : 'Could not apply this filter to the saved query.',
          } }));
        }
      }
    };
    // DuckDB uses one local `data` table: never run two dashboard filter
    // rebuilds concurrently while a user changes filter selections quickly.
    filterQueue.current = filterQueue.current.catch(() => {}).then(run);
    return () => { cancelled = true; };
  }, [activeDashboardId, dashboardFilters, dataset, availableDatasets, filteredItems]);

  const sqlFilterState = (item: DashboardItem) => usesSqlFilter(item)
    ? filteredSqlCards[item.id]?.key === sqlFilterKey(item) ? filteredSqlCards[item.id] : null
    : undefined;
  const visibleResult = (item: DashboardItem) => sqlFilterState(item)?.result || item.result;
  const sqlFilterView = (item: DashboardItem) => {
    const sourceError = filterSourceError(item);
    if (sourceError) return <div className="h-full flex flex-col items-center justify-center gap-2 p-5 text-center text-amber-700">
      <AlertTriangle className="w-6 h-6" /><p role="alert" className="text-xs max-w-sm">{sourceError}</p>
    </div>;
    const state = sqlFilterState(item);
    if (state === undefined || state?.result) return null;
    return <div className="h-full flex flex-col items-center justify-center gap-2 p-5 text-center text-slate-600">
      {state?.error ? <AlertTriangle className="w-6 h-6 text-amber-500" /> : <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />}
      <p className="text-sm font-semibold">{state?.error ? 'Filter could not be applied' : 'Applying dashboard filters…'}</p>
      {state?.error && <p role="alert" className="text-xs max-w-sm text-amber-700">{state.error}</p>}
    </div>;
  };

  // ── Reusable helper: apply global filters to a dashboard card's data ──
  const getFilteredData = useCallback((item: DashboardItem) => {
    if (usesSqlFilter(item)) {
      const entry = filteredSqlCards[item.id];
      return entry?.key === sqlFilterKey(item) ? entry.result?.data || [] : [];
    }
    if (item.ignoreGlobalFilter) return item.result.data;
    if (dashboardFilters.length === 0 || !Array.isArray(item.result.data)) return item.result.data;

    const source = filterSource(item);
    if (!source || filterSourceError(item)) return [];
    const xKey = item.result.xKey;
    const yKey = item.result.yKey;
    const sourceRows = source.rows;
    const cfg = item.result.config || item.result.queryConfig;

    // Pass 1: filter raw dataset rows by ALL global filters
    const filteredSource = filterDashboardRows(sourceRows, source.columns, dashboardFilters);

    // ── RE-AGGREGATE from filtered rows ──
    if (cfg && cfg.metric && filteredSource.length === 0) return [];
    if (cfg && cfg.metric) {
      const metricCol = cfg.metric;
      const dimCol = cfg.dimension || '';
      const agg = (cfg.aggregation || 'SUM').toUpperCase();
      const timeDims = ['day', 'week', 'month', 'quarter', 'year'];
      const isTimeDim = timeDims.includes(dimCol);
      const dateCol = source.timeContext?.anchorDateColumn || source.columns.find(c => c.type === 'DATE')?.name;
      const groups = new Map<string, number[]>();
      // Earliest timestamp per period label, so time axes stay chronological.
      const periodStart = new Map<string, number>();
      filteredSource.forEach((row: any) => {
        let dimVal = '(Total)';
        if (dimCol && !isTimeDim) {
          dimVal = String(row[dimCol] ?? '(empty)');
        } else if (isTimeDim && dateCol) {
          const d = new Date(row[dateCol]);
          if (!isNaN(d.getTime())) {
            if (dimCol === 'year') dimVal = String(d.getFullYear());
            else if (dimCol === 'quarter') dimVal = `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`;
            else if (dimCol === 'month') dimVal = `${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()}`;
            else if (dimCol === 'week') dimVal = `W${Math.ceil(((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)} ${d.getFullYear()}`;
            else if (dimCol === 'day') dimVal = d.toISOString().slice(0, 10);
            const seen = periodStart.get(dimVal);
            if (seen === undefined || d.getTime() < seen) periodStart.set(dimVal, d.getTime());
          }
        }
        const metricVal = typeof row[metricCol] === 'number' ? row[metricCol] : parseFloat(row[metricCol]);
        if (!isNaN(metricVal)) {
          if (!groups.has(dimVal)) groups.set(dimVal, []);
          groups.get(dimVal)!.push(metricVal);
        }
      });
      const reAggregated: any[] = [];
      groups.forEach((vals, dim) => {
        let result = 0;
        if (agg === 'SUM') result = vals.reduce((a, b) => a + b, 0);
        else if (agg === 'AVG') result = vals.reduce((a, b) => a + b, 0) / vals.length;
        else if (agg === 'COUNT') result = vals.length;
        else if (agg === 'COUNT_DISTINCT') result = new Set(vals).size;
        else if (agg === 'MAX') result = Math.max(...vals);
        else if (agg === 'MIN') result = Math.min(...vals);
        else result = vals.reduce((a, b) => a + b, 0);
        const row: any = { [xKey]: dim, [yKey]: result };
        if (xKey !== 'dim') row.dim = dim;
        if (yKey !== 'metric') row.metric = result;
        reAggregated.push(row);
      });
      // Time periods default to chronological order (oldest first); only an
      // explicit asc/desc ranks them by value. Other dimensions keep the
      // previous default of largest first.
      const sort = cfg.sort || (isTimeDim ? 'oldest' : 'desc');
      if (isTimeDim && (sort === 'oldest' || sort === 'newest')) {
        reAggregated.sort((a, b) => (periodStart.get(String(a[xKey])) ?? 0) - (periodStart.get(String(b[xKey])) ?? 0));
        if (sort === 'newest') reAggregated.reverse();
      } else if (sort === 'desc') reAggregated.sort((a, b) => (b[yKey] || 0) - (a[yKey] || 0));
      else if (sort === 'asc') reAggregated.sort((a, b) => (a[yKey] || 0) - (b[yKey] || 0));
      else if (sort === 'newest' && !isTimeDim) reAggregated.reverse();
      const limit = cfg.limit || 0;
      if (limit > 0 && reAggregated.length > limit) return reAggregated.slice(0, limit);
      return reAggregated;
    }

    // Fallback: simple row filtering for charts without config
    const chartVis = (item.result.vis as string) || 'bar';
    const maxRows = ['bar', 'horizontalBar', 'pie', 'donut', 'groupedBar', 'stackedBar'].includes(chartVis) ? 25 : 500;
    const rawData = item.result.data || [];
    return rawData.length > maxRows ? rawData.slice(0, maxRows) : rawData;
  }, [dashboardFilters, dataset, availableDatasets, filteredSqlCards, filterSignature, activeDashboardId]);

  // Cards restored from cloud contain definitions only. Rebuild against their
  // original local dataset, or an explicitly selected replacement.
  const restoreAttempts = useRef(new Set<string>());
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
  const handleRefreshCard = useCallback(async (item: DashboardItem, replacement?: Dataset) => {
    const source = replacement || resolveDashboardFilterSource(item, dataset, useAppStore.getState().datasets);
    if (!source) return;
    const dashboardId = activeDashboardId;
    setRefreshingCards(prev => new Set(prev).add(item.id));
    setRestoreErrors(prev => ({ ...prev, [item.id]: '' }));
    try {
      const { rebuildDashboardItem } = await import('../services/dashboardRestore');
      const refreshed = await rebuildDashboardItem(item, source);
      const current = useAppStore.getState();
      // A logout, edit or dashboard switch invalidates this pending result.
      if (current.activeDashboardId === dashboardId && current.items.find(i => i.id === item.id) === item) {
        updateItem(refreshed);
      }
    } catch (err) {
      setRestoreErrors(prev => ({ ...prev, [item.id]: err instanceof Error ? err.message : 'Could not rebuild this visual.' }));
    } finally {
      setRefreshingCards(prev => { const next = new Set(prev); next.delete(item.id); return next; });
    }
  }, [dataset, activeDashboardId, updateItem]);

  useEffect(() => { restoreAttempts.current.clear(); }, [activeDashboardId]);
  useEffect(() => {
    for (const item of items) {
      const source = resolveDashboardFilterSource(item, dataset, availableDatasets);
      if (!source || !item.result.needsLocalData) continue;
      const key = `${activeDashboardId}:${item.id}:${source.id}:${source.version}`;
      if (restoreAttempts.current.has(key)) continue;
      restoreAttempts.current.add(key);
      void handleRefreshCard(item, source);
    }
  }, [items, availableDatasets, dataset, activeDashboardId, handleRefreshCard]);

  const prevDashVersionRef = useRef(`${dataset?.id}:${dataset?.version}`);
  useEffect(() => {
    const version = `${dataset?.id}:${dataset?.version}`;
    if (!dataset || version === prevDashVersionRef.current) return;
    prevDashVersionRef.current = version;
    items.forEach(item => {
      if (item.datasetId === dataset.id && !item.result.needsLocalData
          && (item.result.queryConfig || item.result.aiSqlRefresh)) void handleRefreshCard(item);
    });
  }, [dataset?.id, dataset?.version]);

  const missingDataView = (item: DashboardItem) => (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-5 text-center text-slate-600">
      <Database className="w-7 h-7 text-indigo-500" />
      <p className="text-sm font-semibold">
        {refreshingCards.has(item.id) ? 'Rebuilding your visual locally…' : 'Open the source data to display this visual'}
      </p>
      <p className="text-xs max-w-sm">
        Your layout and settings are saved. Chart results stay on your device.
        Reopen {item.datasetName || 'the original dataset'} or reconnect its source.
      </p>
      {restoreErrors[item.id] && <p role="alert" className="text-xs text-amber-700">{restoreErrors[item.id]}</p>}
      {dataset && (
        <button onClick={() => void handleRefreshCard(item, dataset)} disabled={refreshingCards.has(item.id)}
          className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
          Use current dataset: {dataset.name}
        </button>
      )}
    </div>
  );

  // Measure container width for ResponsiveGridLayout
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Generate default layout from items for all breakpoints
  const defaultLayout = useMemo(() => {
    return items.map((item, i) => ({
      i: item.id,
      x: (i % 2) * 6,
      y: Math.floor(i / 2) * 6,
      w: 6,
      h: 6,
      minW: 4,
      minH: 4,
    }));
  }, [items]);

  // Use persisted layout if available and matches current items
  // Robustly reconciling persisted layout with current items
  const layout = useMemo(() => {
    // 1. Build a map of persisted layout entries
    const layoutMap = new Map();
    if (dashboardLayout && Array.isArray(dashboardLayout)) {
      dashboardLayout.forEach((l: any) => layoutMap.set(l.i, l));
    }

    // 2. Gather persisted entries for current items
    const persistedEntries = items
      .map(item => layoutMap.get(item.id))
      .filter(Boolean);

    // 3. Check if ALL items have persisted positions AND none overlap
    let usePersistedLayout = persistedEntries.length === items.length;
    if (usePersistedLayout) {
      for (let a = 0; a < persistedEntries.length && usePersistedLayout; a++) {
        for (let b = a + 1; b < persistedEntries.length; b++) {
          const la = persistedEntries[a];
          const lb = persistedEntries[b];
          const xHit = la.x < lb.x + lb.w && la.x + la.w > lb.x;
          const yHit = la.y < lb.y + lb.h && la.y + la.h > lb.y;
          if (xHit && yHit) {
            console.warn('[Dashboard] Overlap detected in persisted layout — regenerating');
            usePersistedLayout = false;
            break;
          }
        }
      }
    }

    if (usePersistedLayout) {
      // Persisted layout is valid — use it
      return items.map(item => ({ ...layoutMap.get(item.id) }));
    }

    // 4. Generate a fresh 2-column layout
    console.log('[Dashboard] Generating fresh 2-col layout for', items.length, 'items');
    return items.map((item, idx) => ({
      i: item.id,
      x: (idx % 2) * 6,
      y: Math.floor(idx / 2) * 6,
      w: 6,
      h: 6,
      minW: 4,
      minH: 4,
    }));
  }, [items, dashboardLayout]);

  // Use the SAME 12-column layout at every breakpoint so a card keeps the exact
  // size and position the user chose regardless of container width. Previously
  // md/sm/xs were *derived* from lg with scaled-down widths, so toggling the
  // sidebar (which changes the dashboard's width enough to cross a breakpoint)
  // remapped every card to the shrunken layout — the "my resize reset itself"
  // bug. With one shared layout + a fixed column count, only the pixel width of
  // each grid column scales; the cards never resize themselves.
  const allLayouts = useMemo(() => ({
    lg: layout,
    md: layout,
    sm: layout,
    xs: layout,
  }), [layout]);

  // Debounced layout save — prevents feedback loop between RGL and state
  const layoutSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleLayoutChange = useCallback((_cur: any, _allLayouts: any) => {
    // Persist the layout the user actually manipulated at the current breakpoint.
    // All breakpoints share one layout now, so _cur is always the source of
    // truth — preferring a specific breakpoint (lg) could save a stale copy when
    // the user resized at a different width.
    const lg = _allLayouts?.lg;
    const toSave = (Array.isArray(_cur) && _cur.length > 0) ? _cur
      : (Array.isArray(lg) && lg.length > 0) ? lg
      : null;
    if (!toSave) return;
    if (layoutSaveTimer.current) clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = setTimeout(() => {
      setDashboardLayout(toSave);
    }, 300);
  }, [setDashboardLayout]);

  // PDF Export via print
  const handleExportPDF = useCallback(() => {
    window.print();
  }, []);

  // Compute KPI Summary
  const kpiSummary = useMemo(() => {
    if (items.length === 0) return null;
    let totalDataPoints = 0;
    let totalVisuals = items.length;
    const chartTypes = new Map<string, number>();

    items.forEach(item => {
      totalDataPoints += item.result.data?.length || 0;
      const vis = (item.result.vis as string) || 'bar';
      chartTypes.set(vis, (chartTypes.get(vis) || 0) + 1);
    });

    const mostUsedChart = [...chartTypes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'bar';

    return { totalVisuals, totalDataPoints, mostUsedChart };
  }, [items]);

  // Slides for the current presentation (declared after the presentation
  // state it reads, so it is initialised before first use).
  const presentItems = useMemo(() => (presentOnlyReady
    ? items.filter(item => isItemPresentable(item, dataset, availableDatasets, dashboardFilters.length))
    : items), [items, presentOnlyReady, dataset, availableDatasets, dashboardFilters.length]);

  // Presentation Mode keyboard navigation
  useEffect(() => {
    if (!presentationMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept keys when user is typing in an input (e.g. renaming title)
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === 'Escape') setPresentationMode(false);
      if (!isTyping && (e.key === 'ArrowRight' || e.key === ' ')) setCurrentSlide(prev => Math.min(prev + 1, presentItems.length - 1));
      if (!isTyping && e.key === 'ArrowLeft') setCurrentSlide(prev => Math.max(prev - 1, 0));
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [presentationMode, presentItems.length]);

  // Presentation Mode Overlay
  if (presentationMode && presentItems.length > 0) {
    const item = presentItems[Math.min(currentSlide, presentItems.length - 1)];
    return (
      <div className="qi-present-stage fixed inset-0 z-[200] flex flex-col presentation-slide">
        {/* Presentation Header */}
        <div className="qi-present-bar flex items-center justify-between px-8 py-4 print:hidden">
          <div className="flex items-center gap-4">
            <Presentation className="w-5 h-5 qi-present-accent" />
            <EditableTitle
              value={item.title}
              onSave={(t) => updateItem({ ...item, title: t })}
              className="qi-present-heading font-semibold text-lg"
              inputClassName="text-lg"
            />
            {/* Active filter chips in presentation mode */}
            {dashboardFilters.length > 0 && (
              <div className="flex items-center gap-2 ml-4">
                <Filter className="w-3.5 h-3.5 text-indigo-300" />
                {dashboardFilters.map(f => (
                  <span key={f.column} className="px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    {f.column}: {f.type === 'measure' ? `${f.operator} ${f.numericValue}` : f.values.slice(0, 3).join(', ')}{f.values.length > 3 ? ` +${f.values.length - 3}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="qi-present-muted text-sm tabular-nums">{Math.min(currentSlide, presentItems.length - 1) + 1} / {presentItems.length}</span>
            <button
              onClick={() => setPresentationMode(false)}
              className="qi-present-icon-button p-2 rounded-lg"
              aria-label="Exit presentation"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Slide Content */}
        <div className="flex-1 flex items-center justify-center p-12 min-h-0">
          <div className="qi-present-slide w-full max-w-5xl h-full overflow-hidden">
            <div className="px-5 pt-4 pb-1">
              <h3 className="qi-present-heading text-lg font-semibold">
                <EditableTitle
                  value={item.title}
                  onSave={(t) => updateItem({ ...item, title: t })}
                  className=""
                  inputClassName="text-lg"
                />
              </h3>
            </div>
            <div className="h-[calc(100%-52px)]">
              {item.result.needsLocalData ? missingDataView(item) : sqlFilterView(item) || <DashboardResultVisualization
                result={visibleResult(item)}
                data={getFilteredData(item)}
                formatting={item.result.formatting || formatting}
              />}
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-6 pb-6 print:hidden">
          <button
            onClick={() => setCurrentSlide(prev => Math.max(prev - 1, 0))}
            disabled={currentSlide === 0}
            className="qi-present-icon-button p-3 rounded-full disabled:opacity-30"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex gap-2">
            {presentItems.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentSlide(i)}
                className={`qi-present-dot w-2.5 h-2.5 rounded-full transition-all ${i === currentSlide ? 'is-current' : ''}`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>
          <button
            onClick={() => setCurrentSlide(prev => Math.min(prev + 1, presentItems.length - 1))}
            disabled={currentSlide >= presentItems.length - 1}
            className="qi-present-icon-button p-3 rounded-full disabled:opacity-30"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qi-dashboard-workspace h-full overflow-y-auto" ref={containerRef}>
      <div className="max-w-[1900px] mx-auto px-6 py-6 pb-24" ref={dashboardRef}>

        {/* ─── Dashboard Tab Bar ─── */}
        <div className="qi-dashboard-tabs flex items-center gap-1 mb-4 overflow-x-auto pb-1 print:hidden">
          {dashboards.map(db => (
            <button
              key={db.id}
              onClick={() => setActiveDashboard(db.id)}
              onContextMenu={(e) => handleTabContextMenu(e, db.id)}
              onDoubleClick={() => handleStartRename(db.id)}
              className={`qi-dash-tab group relative flex items-center gap-2 px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                db.id === (activeDashboardId || dashboards[0]?.id) ? 'is-active' : ''
              }`}
            >
              {renamingDashboardId === db.id ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={handleFinishRename}
                  onKeyDown={e => { if (e.key === 'Enter') handleFinishRename(); if (e.key === 'Escape') setRenamingDashboardId(null); }}
                  className="bg-transparent border-b border-violet-400 outline-none text-sm font-semibold text-white w-28"
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <span>{db.name}</span>
              )}
              <span className="qi-dash-tab-count text-[11px] px-1.5 py-0.5 rounded-md font-medium tabular-nums">
                {db.items.length}
              </span>
              {/* More menu button */}
              <button
                onClick={(e) => { e.stopPropagation(); handleTabContextMenu(e, db.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-hover)] transition-opacity"
                aria-label={`More options for ${db.name}`}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </button>
          ))}

          {/* + New Dashboard */}
          <button
            onClick={handleCreateDashboard}
            className="qi-dash-ghost flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New
          </button>

          {/* ✨ Auto-build dashboard */}
          {onBuildDashboard && dataset && (
            <button
              onClick={onBuildDashboard}
              disabled={isBuildingDashboard}
              title="Auto-build a dashboard from the most useful insights"
              className="qi-dash-ghost flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isBuildingDashboard ? 'Building…' : 'Auto-build'}
            </button>
          )}

          {/* 🧹 Clean up duplicate "— Overview" tabs (only shows when there are any) */}
          {duplicateOverviewCount > 0 && (
            <button
              onClick={handleCleanupDuplicates}
              title={`Remove ${duplicateOverviewCount} duplicate auto-built Overview ${duplicateOverviewCount === 1 ? 'tab' : 'tabs'}, keeping the newest of each`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-amber-600 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/25 transition-all whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clean up {duplicateOverviewCount} duplicate{duplicateOverviewCount === 1 ? '' : 's'}
            </button>
          )}
          {cleanupMsg && (
            <span className="flex items-center px-2 text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {cleanupMsg}
            </span>
          )}
        </div>

        {/* ─── Tab Context Menu ─── */}
        {contextMenuId && (
          <div
            className="fixed z-[200] min-w-[160px] rounded-xl border bg-[#1e2134] border-white/[0.08] shadow-2xl py-1.5 text-sm"
            style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => handleStartRename(contextMenuId)}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-gray-300 hover:bg-white/[0.06] hover:text-white transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Rename
            </button>
            <button
              onClick={() => { duplicateDashboard(contextMenuId); setContextMenuId(null); }}
              className="w-full flex items-center gap-2.5 px-4 py-2 text-gray-300 hover:bg-white/[0.06] hover:text-white transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              Duplicate
            </button>
            {dashboards.length > 1 && (
              <>
                <div className="mx-3 my-1 border-t border-white/[0.06]" />
                <button
                  onClick={() => { deleteDashboard(contextMenuId); setContextMenuId(null); }}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </>
            )}
          </div>
        )}

        {/* ─── Dashboard Header ─── */}
        <div className="flex flex-col gap-4 mb-6 print:hidden">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div>
                <h2 className="qi-dash-title text-[22px] font-semibold tracking-tight">{activeDashboard?.name || 'Dashboard'}</h2>
                <p className="qi-dash-subtitle text-[13px] mt-0.5">
                  {filteredItems.length > 0
                    ? `${filteredItems.length} visual${filteredItems.length !== 1 ? 's' : ''}${selectedDatasetId ? ` · Filtered by dataset` : ''} · Drag to rearrange`
                    : 'Create a visual in AI SQL or Question Builder, then pin it here'}
                </p>
                {dataset && (
                  <span className="qi-dash-meta mt-2 inline-flex items-center gap-1.5 text-xs font-medium">
                    <Database className="w-3 h-3" /> Current dataset · {dataset.totalRows?.toLocaleString() || 0} rows
                  </span>
                )}
              </div>

              {/* ⚡ Live Connection Badge + Refresh */}
              {dataset?.connectionMode === 'live' && (
                <div className="flex items-center gap-2 ml-3">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/25 rounded-lg animate-pulse">
                    <Zap className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs font-bold text-emerald-400">Live</span>
                  </div>
                  {onScheduleChange && (
                    <RefreshSchedulerDropdown
                      schedule={refreshSchedule}
                      onScheduleChange={onScheduleChange}
                      isRefreshing={isLiveRefreshing || false}
                    />
                  )}
                  <button
                    onClick={onLiveRefresh}
                    disabled={isLiveRefreshing}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded-lg transition-all border border-emerald-200 dark:border-emerald-500/20 text-xs font-semibold disabled:opacity-50"
                    title="Refresh data from live database"
                  >
                    {isLiveRefreshing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    {isLiveRefreshing ? 'Refreshing...' : 'Refresh Now'}
                  </button>
                </div>
              )}

            </div>

            {items.length > 0 && (
              <div className="flex items-center gap-2 print:hidden">
                <button
                  onClick={() => setShowPresentPicker(true)}
                  className="qi-dash-button group flex items-center gap-2 px-3 py-2 text-sm font-medium"
                >
                  <Presentation className="w-4 h-4" />
                  Present
                </button>
                <button
                  onClick={handleExportPDF}
                  className="qi-dash-button group flex items-center gap-2 px-3 py-2 text-sm font-medium"
                >
                  <FileDown className="w-4 h-4" />
                  Export
                </button>
                <button
                  onClick={() => setShowClearModal(true)}
                  className="qi-dash-button is-danger group flex items-center gap-2 px-3 py-2 text-sm font-medium"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear All
                </button>
              </div>
            )}
          </div>

          {/* ── Dataset Selector ── */}
          {uniqueDatasets.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-slate-400 mr-1">
                <Database className="w-3.5 h-3.5" />
                <span className="font-medium">Dataset:</span>
              </div>
              <button
                onClick={() => { setSelectedDatasetId(null); setDashboardFilters([]); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${!selectedDatasetId
                  ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                  : 'bg-slate-800 text-slate-400 border-white/10 hover:bg-slate-700'
                  }`}
              >
                All Datasets
              </button>
              {uniqueDatasets.map(([id, name]) => {
                const c = datasetColorMap.get(id) || DATASET_COLORS[0];
                return (
                  <button
                    key={id}
                    onClick={() => { setSelectedDatasetId(id); setDashboardFilters([]); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${selectedDatasetId === id
                      ? `${c.bg} ${c.text} border-current/30`
                      : 'bg-slate-800 text-slate-400 border-white/10 hover:bg-slate-700'
                      }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${c.dot}`} />
                    {name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ─── Print-only title ─── */}
        <h1 className="hidden print:block text-2xl font-bold text-black mb-4">
          {activeDashboard?.name || 'Dashboard'}
        </h1>

        {items.length > 0 && (() => {
          // ── Group columns from the FULL dataset by their type ──────────
          const colGroups: Record<string, string[]> = { Dimensions: [], Measures: [], Dates: [], IDs: [], Other: [] };
          if (dataset?.columns) {
            dataset.columns.forEach(c => {
              if (c.type === 'DIMENSION') colGroups.Dimensions.push(c.name);
              else if (c.type === 'METRIC') colGroups.Measures.push(c.name);
              else if (c.type === 'DATE') colGroups.Dates.push(c.name);
              else if (c.type === 'ID') colGroups.IDs.push(c.name);
              else colGroups.Other.push(c.name);
            });
          }

          // ── Detect column type using column definition ──
          const colDef = filterColumn && dataset?.columns ? dataset.columns.find(c => c.name === filterColumn) : undefined;
          const isNumericColumn = colDef?.type === 'METRIC';
          const isDateColumn = colDef?.type === 'DATE';

          // ── Distinct values from the FULL dataset rows (categorical) ──
          const categoricalValues: string[] = (() => {
            if (!filterColumn || isNumericColumn || isDateColumn) return [];
            const valSet = new Set<string>();
            const rows = dataset?.rows ?? [];
            rows.forEach((row: any) => {
              if (row[filterColumn] !== undefined && row[filterColumn] !== null)
                valSet.add(String(row[filterColumn]));
            });
            return Array.from(valSet).sort();
          })();

          const activeFilter = dashboardFilters.find(f => f.column === filterColumn);

          return (
            <div className="mb-4 print:hidden">
              {/* Toggle button */}
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className={`qi-dash-button flex items-center gap-2 px-3 py-2 text-sm font-medium ${dashboardFilters.length > 0 ? 'is-active' : ''}`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                Global Filters
                {dashboardFilters.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-indigo-500 text-white text-[11px] font-bold">
                    {dashboardFilters.length}
                  </span>
                )}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ml-1 ${filterOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Active filter chips — always visible when filters are applied */}
              {dashboardFilters.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {dashboardFilters.map(f => (
                    <div
                      key={f.column}
                      className="flex items-center gap-1.5 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 rounded-lg px-2.5 py-1 text-xs"
                    >
                      <Filter className="w-3 h-3 text-indigo-400" />
                      <span className="font-bold text-indigo-700 dark:text-indigo-300">{f.column}</span>
                      {f.type === 'measure' ? (
                        <span className="text-slate-500 dark:text-slate-400">
                          {f.operator} {f.numericValue}
                        </span>
                      ) : dataset?.columns?.find(column => column.name === f.column)?.type === 'DATE' ? (
                        <span className="text-slate-500 dark:text-slate-400">{dashboardDateFilterLabel(f)}</span>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          ∈ {f.values.length > 2 ? `${f.values.slice(0, 2).join(', ')} +${f.values.length - 2}` : f.values.join(', ')}
                        </span>
                      )}
                      <button
                        onClick={() => setDashboardFilters(dashboardFilters.filter(df => df.column !== f.column))}
                        className="ml-0.5 text-slate-400 hover:text-red-400 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {dashboardFilters.length > 0 && (
                    <button
                      onClick={() => { setDashboardFilters([]); setFilterColumn(''); }}
                      className="text-xs font-semibold text-red-500 hover:text-red-600 transition-colors px-2 py-1"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}

              {/* Expanded filter builder panel */}
              {filterOpen && (
                <div className="mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-xl p-4 shadow-lg dark:shadow-2xl">
                  <div className="flex flex-wrap items-end gap-4">

                    {/* ── Column picker with optgroup by type ── */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Column</label>
                      <select
                        value={filterColumn}
                        onChange={e => {
                          setFilterColumn(e.target.value);
                          setFilterMeasureOp('>');
                          setFilterMeasureValue('');
                        }}
                        className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none min-w-[220px]"
                      >
                        <option value="">Select column…</option>
                        {Object.entries(colGroups).filter(([_, cols]) => cols.length > 0).map(([groupLabel, cols]) => (
                          <optgroup key={groupLabel} label={`── ${groupLabel} ──`}>
                            {cols.sort().map(col => (
                              <option key={col} value={col}>{col}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </div>

                    {/* ── MEASURE filter: operator + numeric input ── */}
                    {filterColumn && isNumericColumn && (
                      <>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Operator</label>
                          <select
                            value={filterMeasureOp}
                            onChange={e => setFilterMeasureOp(e.target.value as any)}
                            className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none min-w-[90px]"
                          >
                            {(['>', '<', '=', '!=', '>=', '<='] as const).map(op => (
                              <option key={op} value={op}>{op}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Value</label>
                          <input
                            type="number"
                            placeholder="e.g. 1000"
                            value={filterMeasureValue}
                            onChange={e => setFilterMeasureValue(e.target.value)}
                            className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none w-32"
                          />
                        </div>
                        <button
                          disabled={filterMeasureValue === ''}
                          onClick={() => {
                            const numVal = parseFloat(filterMeasureValue);
                            if (isNaN(numVal)) return;
                            const updated = dashboardFilters.filter(f => f.column !== filterColumn);
                            setDashboardFilters([...updated, {
                              column: filterColumn,
                              type: 'measure',
                              values: [],
                              operator: filterMeasureOp,
                              numericValue: numVal,
                            }]);
                          }}
                          className="self-end px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-all"
                        >
                          Apply
                        </button>
                      </>
                    )}

                    {/* ── DATE filter: choose either an inclusive range or a calendar level ── */}
                    {filterColumn && isDateColumn && (
                      <DashboardDateFilter
                        key={filterColumn}
                        column={filterColumn}
                        rows={dataset?.rows ?? []}
                        activeFilter={activeFilter}
                        onApply={next => setDashboardFilters([
                          ...dashboardFilters.filter(filter => filter.column !== filterColumn), next,
                        ])}
                        onRemove={() => setDashboardFilters(dashboardFilters.filter(filter => filter.column !== filterColumn))}
                      />
                    )}

                    {/* ── DIMENSION filter: value pills ── */}
                    {filterColumn && !isNumericColumn && !isDateColumn && categoricalValues.length > 0 && (
                      <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                        <label className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                          Values <span className="normal-case font-normal">(click to select)</span>
                        </label>
                        <div className="flex flex-wrap gap-1.5 max-h-[100px] overflow-y-auto pr-1">
                          {categoricalValues.map(val => {
                            const isActive = activeFilter?.values.includes(val) ?? false;
                            return (
                              <button
                                key={val}
                                onClick={() => {
                                  const existing = dashboardFilters.find(f => f.column === filterColumn);
                                  if (isActive) {
                                    const newVals = (existing?.values || []).filter(v => v !== val);
                                    if (newVals.length === 0) {
                                      setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn));
                                    } else {
                                      setDashboardFilters(dashboardFilters.map(f =>
                                        f.column === filterColumn ? { ...f, values: newVals } : f
                                      ));
                                    }
                                  } else {
                                    if (existing) {
                                      setDashboardFilters(dashboardFilters.map(f =>
                                        f.column === filterColumn ? { ...f, values: [...f.values, val] } : f
                                      ));
                                    } else {
                                      setDashboardFilters([...dashboardFilters, {
                                        column: filterColumn,
                                        type: 'dimension',
                                        values: [val],
                                      }]);
                                    }
                                  }
                                }}
                                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all border ${isActive
                                  ? 'bg-indigo-100 dark:bg-indigo-500/30 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/50'
                                  : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
                                  }`}
                              >
                                {val}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Remove filter for selected column */}
                    {activeFilter && (
                      <button
                        onClick={() => setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn))}
                        className="self-end px-3 py-2 text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-700 bg-red-50 dark:bg-red-500/10 hover:bg-red-100 border border-red-200 dark:border-red-500/20 rounded-lg transition-all"
                      >
                        Remove filter
                      </button>
                    )}
                  </div>

                  {/* Help text */}
                  {!filterColumn && (
                    <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                      Select a column to build a filter. Categorical fields show selectable values; numeric fields show a comparison operator; date fields let you choose a range or a year-to-day calendar level.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ─── Empty State ─── */}
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center min-h-[500px] rounded-2xl border border-dashed border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
            <div className="text-center max-w-lg">
              <div className="w-18 h-18 rounded-2xl bg-violet-100 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/20 flex items-center justify-center mx-auto mb-5">
                <LayoutDashboard className="w-9 h-9 text-violet-500 dark:text-violet-400/60" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Turn analysis into a clear story</h3>
              <p className="text-gray-500 dark:text-gray-400 mb-6 leading-relaxed text-sm">
                Start with a useful dashboard from your current dataset, or pin individual visuals as you explore in{' '}
                <span className="text-violet-600 dark:text-violet-300 font-semibold">Question Builder</span> and{' '}
                <span className="text-purple-600 dark:text-purple-300 font-semibold">AI SQL</span>.
              </p>
              {onBuildDashboard && dataset && (
                <button
                  onClick={onBuildDashboard}
                  disabled={isBuildingDashboard}
                  className="inline-flex items-center gap-2 px-5 py-2.5 mb-7 rounded-xl text-sm font-semibold text-white bg-gradient-to-b from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 shadow-lg shadow-indigo-500/25 hover:-translate-y-0.5 active:translate-y-0 transition-all disabled:opacity-60 disabled:cursor-not-allowed disabled:translate-y-0"
                >
                  <Sparkles className="w-4 h-4" />
                  {isBuildingDashboard ? 'Building…' : 'Create a starter dashboard'}
                </button>
              )}
              <div className="flex items-center justify-center gap-5 text-xs text-gray-400 dark:text-gray-500">
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center">
                    <GripVertical className="w-3 h-3 text-violet-500 dark:text-violet-400" />
                  </div>
                  Drag & Drop
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center">
                    <Maximize2 className="w-3 h-3 text-violet-500 dark:text-violet-400" />
                  </div>
                  Resize
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded bg-violet-100 dark:bg-violet-500/10 flex items-center justify-center">
                    <Edit className="w-3 h-3 text-violet-500 dark:text-violet-400" />
                  </div>
                  Edit
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── Drag-Drop Grid Layout ─── */}
        {filteredItems.length > 0 && (
          <ResponsiveGridLayout
            className="layout"
            layouts={allLayouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
            cols={{ lg: 12, md: 12, sm: 12, xs: 12 }}
            rowHeight={70}
            width={containerWidth - 48}
            onLayoutChange={handleLayoutChange}
            isDraggable={true}
            isResizable={true}
            draggableHandle=".drag-handle"
            compactType="vertical"
            margin={[16, 16]}
            containerPadding={[24, 0]}
          >
            {filteredItems.map((item, idx) => {
              const accent = CARD_ACCENTS[idx % CARD_ACCENTS.length];
              const vis = (item.result.vis as string) || 'bar';
              const isHovered = hoveredCard === item.id;

              return (
                <div
                  key={item.id}
                  className="qi-dash-card animate-card-entrance overflow-hidden group flex flex-col print:break-inside-avoid"
                  onMouseEnter={() => setHoveredCard(item.id)}
                  onMouseLeave={() => setHoveredCard(null)}
                >
                  {/* ── Card Header — drag handle ── */}
                  <div className="qi-dash-card-header drag-handle flex items-center justify-between pl-4 pr-2.5 pt-3 pb-1 flex-shrink-0 cursor-grab active:cursor-grabbing">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <h3 className="qi-dash-card-title text-sm font-semibold truncate">
                        <EditableTitle
                          value={item.title}
                          onSave={(t) => updateItem({ ...item, title: t })}
                          className=""
                          inputClassName="text-gray-900 dark:text-white text-sm"
                        />
                      </h3>

                      {/* Dataset badge */}
                      {item.datasetName && uniqueDatasets.length > 1 && (() => {
                        const c = datasetColorMap.get(item.datasetId || '') || DATASET_COLORS[0];
                        return (
                          <span className={`hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${c.bg} ${c.text} shrink-0`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                            {item.datasetName}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Actions */}
                    <div className="qi-dash-card-actions flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity print:hidden shrink-0 ml-2">
                      {/* Global filter toggle — only shown when filters are active */}
                      {dashboardFilters.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            updateItem({ ...item, ignoreGlobalFilter: !item.ignoreGlobalFilter });
                          }}
                          className={`qi-dash-icon-button p-1.5 ${item.ignoreGlobalFilter ? '' : 'is-active'}`}
                          title={item.ignoreGlobalFilter ? 'Global filter OFF — click to enable' : 'Global filter ON — click to disable'}
                        >
                          <Filter className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {/* Labels toggle — Off/legacy Primary → All → Off */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const fmt = item.result.formatting || formatting;
                          if (!fmt) return;
                          const newFmt = toggleDataLabels(fmt);
                          updateItem({ ...item, result: { ...item.result, formatting: newFmt } });
                        }}
                        className={`qi-dash-icon-button p-1.5 ${(item.result.formatting || formatting)?.showDataLabels ? 'is-active' : ''}`}
                        title={`Labels: ${effectiveDataLabelMode(item.result.formatting || formatting) === 'off' ? 'Off — click to show all' : effectiveDataLabelMode(item.result.formatting || formatting) === 'all' ? 'All — click to turn off' : 'First series only — click to show all'}`}
                      >
                        <Tag className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onEdit?.(item); }}
                        className="qi-dash-icon-button p-1.5"
                        title="Edit in Workbench"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      {/* Fix #8: Refresh card with current dataset */}
                      {dataset && (!item.datasetId || item.datasetId === dataset.id) && item.result?.queryConfig && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRefreshCard(item); }}
                          className={`qi-dash-icon-button p-1.5 ${refreshingCards.has(item.id) ? 'animate-spin' : ''}`}
                          title="Refresh with current data"
                          disabled={refreshingCards.has(item.id)}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                        className="qi-dash-icon-button is-danger p-1.5"
                        title="Remove from Dashboard"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* ── Chart Area ──
                      Pinned visuals intentionally use the same light canvas as Question Builder.
                      ChartVisualization is transparent, so the explicit surface keeps stored
                      axis/data-label colours legible in both light and dark dashboard themes. ── */}
                  <div className="flex-1 px-2 pb-1 min-h-0 overflow-hidden flex items-center justify-center">
                    <div className="w-full h-full min-h-0 overflow-hidden">
                      <ErrorBoundary compact label={item.title || 'Chart'}>
                        {item.result.needsLocalData ? missingDataView(item) : sqlFilterView(item) || <DashboardResultVisualization
                          result={visibleResult(item)}
                          data={getFilteredData(item)}
                          formatting={item.result.formatting || formatting}
                        />}
                      </ErrorBoundary>
                    </div>
                  </div>

                  {/* ── Card Footer — Metric Summary ── */}
                  <div className="qi-dash-card-footer px-4 pb-2.5 pt-0.5 flex items-center justify-between text-[11px] shrink-0">
                    <span className="truncate">
                      {item.result.yLabel || item.result.yKey}
                    </span>
                    <span className="tabular-nums">
                      {item.result.needsLocalData ? 'Data stays local' : `${item.result.data?.length || 0} rows`}
                    </span>
                  </div>
                </div>
              );
            })}
          </ResponsiveGridLayout>
        )}

        {showPresentPicker && (
          <PresentDashboardDialog
            dashboards={dashboards.map(db => summariseDashboardReadiness(
              db.id === activeDashboard?.id ? { ...db, items, filters: dashboardFilters } : db,
              dataset,
              availableDatasets,
            ))}
            initialDashboardId={activeDashboard?.id}
            onCancel={() => setShowPresentPicker(false)}
            onStart={(dashboardId, onlyReady) => {
              if (dashboardId !== activeDashboard?.id) setActiveDashboard(dashboardId);
              setPresentOnlyReady(onlyReady);
              setCurrentSlide(0);
              setShowPresentPicker(false);
              setPresentationMode(true);
            }}
          />
        )}

        {/* ─── Clear All Confirmation Modal ─── */}
        {showClearModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm print:hidden">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
              <div className="flex items-start gap-4 mb-6">
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 shrink-0">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Clear All Visuals?</h3>
                  <p className="text-sm text-slate-500 mt-1 leading-relaxed">
                    This will permanently remove all <span className="text-slate-900 font-semibold">{items.length}</span> pinned visuals from your dashboard. This action cannot be undone.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowClearModal(false)}
                  className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { clearAllItems(); setShowClearModal(false); }}
                  className="px-5 py-2.5 text-sm font-bold text-white bg-red-600 hover:bg-red-500 rounded-xl transition-colors shadow-lg shadow-red-500/20"
                >
                  Yes, Clear All
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
