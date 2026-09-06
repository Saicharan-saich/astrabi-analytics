import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
const ResponsiveGridLayout = WidthProvider(Responsive) as any;
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartVisualization } from './ChartVisualization';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Trash2, Edit, AlertTriangle, X, FileDown, Presentation,
  ChevronLeft, ChevronRight, Maximize2, LayoutDashboard, GripVertical,
  BarChart3, PieChart, LineChart, Activity, Zap,
  Eye, Filter, ChevronDown, RefreshCw, SlidersHorizontal, Database,
  Plus, Pencil, Copy, MoreHorizontal, Check, Loader2, Tag, Sparkles
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { Dataset, DashboardItem, RefreshSchedule } from '../types';
import { DashboardFilter } from '../store/useAppStore';
import { RefreshSchedulerDropdown } from './RefreshSchedulerDropdown';

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
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterColumn, setFilterColumn] = useState<string>('');
  const [filterMeasureOp, setFilterMeasureOp] = useState<'>' | '<' | '=' | '!=' | '>=' | '<='>('>');
  const [filterMeasureValue, setFilterMeasureValue] = useState<string>('');
  const [refreshingCards, setRefreshingCards] = useState<Set<string>>(new Set());

  // ── Reusable helper: apply global filters to a dashboard card's data ──
  const getFilteredData = useCallback((item: DashboardItem) => {
    if (item.ignoreGlobalFilter) return item.result.data;
    if (dashboardFilters.length === 0 || !Array.isArray(item.result.data)) return item.result.data;

    // A dashboard can hold cards pinned from DIFFERENT datasets, but filtering
    // re-aggregates from the dataset that happens to be loaded right now. Doing
    // that to a card from another dataset looks for columns that are not there
    // (e.g. an Amazon card asking for "sales"/"ship_mode" inside a different
    // workbook), every row is skipped, and the card renders "No data to
    // display". Leave those cards on their pinned figures instead — a stale
    // number is far better than a blank tile.
    if (item.datasetId && dataset?.id && item.datasetId !== dataset.id) {
      return item.result.data;
    }

    // AI SQL cards can contain CTEs, window calculations, conditional
    // aggregates and several result measures. Re-aggregating them through the
    // single-metric dashboard filter helper destroys that result grain (often
    // collapsing a comparison to one bar). Until filters can be compiled into
    // the stored SQL AST, preserve the verified AI SQL result as-is.
    if (item.result.aiSqlRefresh || item.result.queryConfig?.aiSql) return item.result.data;

    const isDateStr = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const xKey = item.result.xKey;
    const yKey = item.result.yKey;
    const sourceRows = dataset?.rows ?? [];
    const cfg = item.result.config || item.result.queryConfig;

    // Pass 1: filter raw dataset rows by ALL global filters
    let filteredSource = sourceRows;
    dashboardFilters.forEach(f => {
      filteredSource = filteredSource.filter((row: any) => {
        const val = row[f.column];
        if (val === undefined || val === null) return true;
        const colType = dataset?.columns?.find(c => c.name === f.column)?.type;

        if (colType === 'DATE' && f.values.length > 0) {
          const d = new Date(val);
          if (isNaN(d.getTime())) return true;
          const yr = String(d.getFullYear());
          const qtr = `${yr}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
          const hierarchyTokens = f.values.filter(v => !isDateStr(v));
          const dateRangeValues = f.values.filter(v => isDateStr(v));
          let passedHierarchy = hierarchyTokens.length === 0;
          let passedRange = dateRangeValues.length === 0;
          if (hierarchyTokens.length > 0) passedHierarchy = hierarchyTokens.some(v => v === yr || v === qtr);
          if (dateRangeValues.length >= 2) { const from = new Date(dateRangeValues[0]); const to = new Date(dateRangeValues[1]); passedRange = d >= from && d <= to; }
          if (hierarchyTokens.length > 0 && dateRangeValues.length >= 2) return passedHierarchy || passedRange;
          return passedHierarchy && passedRange;
        }
        if (f.type === 'measure' && f.operator !== undefined && f.numericValue !== undefined) {
          const num = typeof val === 'number' ? val : parseFloat(val);
          if (isNaN(num)) return true;
          switch (f.operator) {
            case '>': return num > f.numericValue; case '<': return num < f.numericValue;
            case '=': return num === f.numericValue; case '!=': return num !== f.numericValue;
            case '>=': return num >= f.numericValue; case '<=': return num <= f.numericValue;
            default: return true;
          }
        }
        return f.values.length === 0 || f.values.includes(String(val));
      });
    });

    // ── RE-AGGREGATE from filtered rows ──
    if (cfg && cfg.metric && filteredSource.length > 0) {
      const metricCol = cfg.metric;
      const dimCol = cfg.dimension || '';
      const agg = (cfg.aggregation || 'SUM').toUpperCase();
      const timeDims = ['day', 'week', 'month', 'quarter', 'year'];
      const isTimeDim = timeDims.includes(dimCol);
      const dateCol = dataset?.timeContext?.anchorDateColumn || dataset?.columns?.find(c => c.type === 'DATE')?.name;
      const groups = new Map<string, number[]>();
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
      const sort = cfg.sort || 'desc';
      if (sort === 'desc') reAggregated.sort((a, b) => (b[yKey] || 0) - (a[yKey] || 0));
      else if (sort === 'asc') reAggregated.sort((a, b) => (a[yKey] || 0) - (b[yKey] || 0));
      else if (sort === 'newest') reAggregated.reverse();
      const limit = cfg.limit || 0;
      if (limit > 0 && reAggregated.length > limit) return reAggregated.slice(0, limit);
      return reAggregated;
    }

    // Fallback: simple row filtering for charts without config
    const chartVis = (item.result.vis as string) || 'bar';
    const maxRows = ['bar', 'horizontalBar', 'pie', 'donut', 'groupedBar', 'stackedBar'].includes(chartVis) ? 25 : 500;
    const rawData = item.result.data || [];
    return rawData.length > maxRows ? rawData.slice(0, maxRows) : rawData;
  }, [dashboardFilters, dataset]);

  // Fix #8: Re-evaluate a dashboard card by re-running its stored query config
  const handleRefreshCard = useCallback(async (item: DashboardItem) => {
    if (!dataset || !item.result?.queryConfig) return;
    setRefreshingCards(prev => new Set(prev).add(item.id));
    try {
      if (item.result.aiSqlRefresh || item.result.queryConfig?.aiSql) {
        const { refreshPinnedAISQLResult } = await import('../services/ai-sql/pinnedResult');
        const refreshed = await refreshPinnedAISQLResult(dataset, item.result);
        updateItem({ ...item, result: refreshed, pinnedAt: Date.now(), datasetVersion: dataset.version });
        return;
      }
      // Dynamically import the analysis engine to avoid circular deps
      const { runAnalysis } = await import('../services/analysisEngine');
      const config = item.result.queryConfig;
      const freshResult = await runAnalysis(dataset, {
        ...config,
        asOfDate: dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || '',
      });
      updateItem({
        ...item,
        result: {
          ...freshResult,
          vis: item.result.vis || freshResult.vis,
          formatting: item.result.formatting,
          queryConfig: config,
        },
        pinnedAt: Date.now(),
        datasetVersion: dataset.version,
      });
    } catch (err) {
      console.warn('[Dashboard] Refresh failed for card:', item.id, err);
    } finally {
      setRefreshingCards(prev => { const next = new Set(prev); next.delete(item.id); return next; });
    }
  }, [dataset, updateItem]);

  // ── Auto-refresh ALL dashboard cards when dataset.version changes ──
  const prevDashVersionRef = useRef(dataset?.version);
  useEffect(() => {
    if (!dataset || dataset.version === prevDashVersionRef.current) return;
    prevDashVersionRef.current = dataset.version;
    console.log(`[Dashboard] Dataset v${dataset.version} — refreshing all cards`);
    items.forEach(item => {
      if (item.datasetId === dataset.id && item.result?.queryConfig) {
        handleRefreshCard(item);
      }
    });
  }, [dataset?.version]);

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

  // Presentation Mode keyboard navigation
  useEffect(() => {
    if (!presentationMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept keys when user is typing in an input (e.g. renaming title)
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === 'Escape') setPresentationMode(false);
      if (!isTyping && (e.key === 'ArrowRight' || e.key === ' ')) setCurrentSlide(prev => Math.min(prev + 1, items.length - 1));
      if (!isTyping && e.key === 'ArrowLeft') setCurrentSlide(prev => Math.max(prev - 1, 0));
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [presentationMode, items.length]);

  // Presentation Mode Overlay
  if (presentationMode && items.length > 0) {
    const item = items[currentSlide];
    return (
      <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col presentation-slide">
        {/* Presentation Header */}
        <div className="flex items-center justify-between px-8 py-4 bg-slate-900/80 border-b border-white/5 print:hidden">
          <div className="flex items-center gap-4">
            <Presentation className="w-5 h-5 text-indigo-400" />
            <EditableTitle
              value={item.title}
              onSave={(t) => updateItem({ ...item, title: t })}
              className="text-white font-bold text-lg"
              inputClassName="text-white text-lg"
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
            <span className="text-slate-400 text-sm">{currentSlide + 1} / {items.length}</span>
            <button
              onClick={() => setPresentationMode(false)}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Slide Content */}
        <div className="flex-1 flex items-center justify-center p-12 min-h-0">
          <div className="w-full max-w-5xl h-full bg-white rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-3 border-b border-slate-100 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800 text-center">
                <EditableTitle
                  value={item.title}
                  onSave={(t) => updateItem({ ...item, title: t })}
                  className=""
                  inputClassName="text-slate-800 text-lg text-center"
                />
              </h3>
            </div>
            <div className="h-[calc(100%-52px)]">
              <ChartVisualization
                config={item.result.config}
                data={getFilteredData(item)}
                xKey={item.result.xKey}
                yKey={item.result.yKey}
                yLabel={item.result.yLabel}
                chartType={(item.result.vis as any) || 'bar'}
                onChartTypeChange={() => { }}
                formatting={item.result.formatting || formatting}
                hideControls={true}
              />
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-6 pb-6 print:hidden">
          <button
            onClick={() => setCurrentSlide(prev => Math.max(prev - 1, 0))}
            disabled={currentSlide === 0}
            className="p-3 rounded-full bg-slate-800 hover:bg-slate-700 text-white transition-colors disabled:opacity-30"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div className="flex gap-2">
            {items.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentSlide(i)}
                className={`w-3 h-3 rounded-full transition-all ${i === currentSlide ? 'bg-indigo-500 scale-125' : 'bg-slate-600 hover:bg-slate-500'}`}
              />
            ))}
          </div>
          <button
            onClick={() => setCurrentSlide(prev => Math.min(prev + 1, items.length - 1))}
            disabled={currentSlide === items.length - 1}
            className="p-3 rounded-full bg-slate-800 hover:bg-slate-700 text-white transition-colors disabled:opacity-30"
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
              className={`group relative flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all whitespace-nowrap ${
                db.id === (activeDashboardId || dashboards[0]?.id)
                  ? 'bg-gradient-to-r from-violet-500/15 to-indigo-500/10 text-violet-300 border border-violet-500/25 shadow-sm shadow-violet-500/10'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 opacity-60" />
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
              <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-bold ${
                db.id === (activeDashboardId || dashboards[0]?.id)
                  ? 'bg-violet-500/20 text-violet-300'
                  : 'bg-white/[0.06] text-gray-500'
              }`}>
                {db.items.length}
              </span>
              {/* More menu button */}
              <button
                onClick={(e) => { e.stopPropagation(); handleTabContextMenu(e, db.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/[0.1] transition-all"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </button>
          ))}

          {/* + New Dashboard */}
          <button
            onClick={handleCreateDashboard}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-gray-500 hover:text-violet-300 hover:bg-violet-500/10 border border-dashed border-white/[0.08] hover:border-violet-500/25 transition-all whitespace-nowrap"
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
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-indigo-600 dark:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/15 border border-indigo-500/25 transition-all whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
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
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md">
                <LayoutDashboard className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">{activeDashboard?.name || 'Dashboard'}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {filteredItems.length > 0
                    ? `${filteredItems.length} visual${filteredItems.length !== 1 ? 's' : ''}${selectedDatasetId ? ` · Filtered by dataset` : ''} · Drag to rearrange`
                    : 'Create a visual in AI SQL or Question Builder, then pin it here'}
                </p>
                {dataset && (
                  <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
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

              {/* Inline stats badges — adjacent to Dashboard title */}
              {kpiSummary && (
                <div className="flex items-center gap-2 ml-4">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 dark:bg-violet-500/10 border border-violet-200/50 dark:border-violet-500/20 rounded-lg">
                    <Eye className="w-3.5 h-3.5 text-violet-500 dark:text-violet-400" />
                    <span className="text-xs font-bold text-violet-700 dark:text-violet-300">{kpiSummary.totalVisuals}</span>
                    <span className="text-[10px] text-violet-500/70 dark:text-violet-400/60 font-medium">visuals</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-500/10 border border-amber-200/50 dark:border-amber-500/20 rounded-lg">
                    {getChartIcon(kpiSummary.mostUsedChart)}
                    <span className="text-xs font-bold text-amber-700 dark:text-amber-300 capitalize">{kpiSummary.mostUsedChart}</span>
                    <span className="text-[10px] text-amber-500/70 dark:text-amber-400/60 font-medium">most used</span>
                  </div>
                </div>
              )}
            </div>

            {items.length > 0 && (
              <div className="flex items-center gap-2 print:hidden">
                <button
                  onClick={() => { setCurrentSlide(0); setPresentationMode(true); }}
                  className="group flex items-center gap-2 px-3.5 py-2 bg-violet-50 dark:bg-violet-500/10 hover:bg-violet-100 dark:hover:bg-violet-500/20 text-violet-700 dark:text-violet-300 rounded-lg transition-all border border-violet-200 dark:border-violet-500/20 text-sm font-medium"
                >
                  <Presentation className="w-4 h-4" />
                  Present
                </button>
                <button
                  onClick={handleExportPDF}
                  className="group flex items-center gap-2 px-3.5 py-2 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded-lg transition-all border border-emerald-200 dark:border-emerald-500/20 text-sm font-medium"
                >
                  <FileDown className="w-4 h-4" />
                  Export
                </button>
                <button
                  onClick={() => setShowClearModal(true)}
                  className="group flex items-center gap-2 px-3.5 py-2 bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 text-red-600 dark:text-red-300 rounded-lg transition-all border border-red-200 dark:border-red-500/20 text-sm font-medium"
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

          // ── Date hierarchy values (year > quarter > month) ──
          const dateHierarchy: { years: string[]; quarters: Map<string, string[]>; months: Map<string, string[]> } = (() => {
            const years = new Set<string>();
            const quarters = new Map<string, string[]>();
            const months = new Map<string, string[]>();
            if (!filterColumn || !isDateColumn) return { years: [], quarters, months };
            const rows = dataset?.rows ?? [];
            rows.forEach((row: any) => {
              const raw = row[filterColumn];
              if (!raw) return;
              const d = new Date(raw);
              if (isNaN(d.getTime())) return;
              const yr = String(d.getFullYear());
              const qtr = `Q${Math.ceil((d.getMonth() + 1) / 3)}`;
              const qKey = `${yr}-${qtr}`;
              const mon = d.toLocaleString('en', { month: 'short' });
              const mKey = `${yr}-${mon}`;
              years.add(yr);
              if (!quarters.has(yr)) quarters.set(yr, []);
              if (!quarters.get(yr)!.includes(qKey)) quarters.get(yr)!.push(qKey);
              if (!months.has(qKey)) months.set(qKey, []);
              if (!months.get(qKey)!.includes(mKey)) months.get(qKey)!.push(mKey);
            });
            return { years: Array.from(years).sort(), quarters, months };
          })();

          const activeFilter = dashboardFilters.find(f => f.column === filterColumn);

          return (
            <div className="mb-4 print:hidden">
              {/* Toggle button */}
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${dashboardFilters.length > 0
                  ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/40 hover:bg-indigo-100 dark:hover:bg-indigo-500/20'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-slate-700'
                  }`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                Global Filters
                {dashboardFilters.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-indigo-500 text-white text-[10px] font-bold">
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
                      <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Column</label>
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
                          <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Operator</label>
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
                          <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Value</label>
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

                    {/* ── DATE filter: hierarchical year/quarter/month + date range ── */}
                    {filterColumn && isDateColumn && (
                      <div className="flex flex-col gap-2 flex-1 min-w-[240px]">
                        <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                          Date Range / Hierarchy
                        </label>

                        {/* Date-range inputs */}
                        {(() => {
                          // Only populate date inputs with actual yyyy-MM-dd values, not hierarchy tokens like "2024" or "2024-Q3"
                          const isDateStr = (v?: string) => v ? /^\d{4}-\d{2}-\d{2}$/.test(v) : false;
                          const dateFrom = activeFilter?.values?.find(v => isDateStr(v) && (activeFilter.values!.indexOf(v) === 0 || !isDateStr(activeFilter.values![0]))) ?? '';
                          const dateTo = activeFilter?.values?.find((v, i) => isDateStr(v) && i > 0) ?? '';
                          return (
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">From</span>
                                <input
                                  type="date"
                                  value={dateFrom}
                                  onChange={e => {
                                    const from = e.target.value;
                                    if (!from) { setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn)); return; }
                                    // Remove any existing date-range values and keep hierarchy tokens
                                    const hierarchyTokens = (activeFilter?.values || []).filter(v => !isDateStr(v));
                                    const existing = dashboardFilters.filter(f => f.column !== filterColumn);
                                    setDashboardFilters([...existing, { column: filterColumn, type: 'dimension', values: [...hierarchyTokens, from, dateTo || from] }]);
                                  }}
                                  className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                />
                              </div>
                              <div className="flex flex-col gap-0.5">
                                <span className="text-[9px] text-slate-400 dark:text-slate-500 font-medium">To</span>
                                <input
                                  type="date"
                                  value={dateTo}
                                  onChange={e => {
                                    const to = e.target.value;
                                    const from = dateFrom;
                                    if (!from && !to) { setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn)); return; }
                                    const hierarchyTokens = (activeFilter?.values || []).filter(v => !isDateStr(v));
                                    const existing = dashboardFilters.filter(f => f.column !== filterColumn);
                                    setDashboardFilters([...existing, { column: filterColumn, type: 'dimension', values: [...hierarchyTokens, from || to, to || from] }]);
                                  }}
                                  className="bg-white dark:bg-slate-700 border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-slate-800 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                />
                              </div>
                            </div>
                          );
                        })()}

                        {/* Hierarchy pills — year / quarter / month */}
                        {dateHierarchy.years.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 max-h-[90px] overflow-y-auto pr-1">
                            {dateHierarchy.years.map(yr => {
                              const isActive = activeFilter?.values?.includes(yr) ?? false;
                              return (
                                <button
                                  key={yr}
                                  onClick={() => {
                                    const existing = dashboardFilters.find(f => f.column === filterColumn);
                                    if (isActive) {
                                      const newVals = (existing?.values || []).filter(v => v !== yr);
                                      if (newVals.length === 0) setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn));
                                      else setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: newVals } : f));
                                    } else {
                                      if (existing) setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: [...f.values, yr] } : f));
                                      else setDashboardFilters([...dashboardFilters, { column: filterColumn, type: 'dimension', values: [yr] }]);
                                    }
                                  }}
                                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all border ${isActive
                                    ? 'bg-indigo-100 dark:bg-indigo-500/30 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-500/50'
                                    : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-slate-300'
                                    }`}
                                >
                                  {yr}
                                </button>
                              );
                            })}
                            {dateHierarchy.years.flatMap(yr => (dateHierarchy.quarters.get(yr) || []).map(q => {
                              const isActive = activeFilter?.values?.includes(q) ?? false;
                              return (
                                <button
                                  key={q}
                                  onClick={() => {
                                    const existing = dashboardFilters.find(f => f.column === filterColumn);
                                    if (isActive) {
                                      const newVals = (existing?.values || []).filter(v => v !== q);
                                      if (newVals.length === 0) setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn));
                                      else setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: newVals } : f));
                                    } else {
                                      if (existing) setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: [...f.values, q] } : f));
                                      else setDashboardFilters([...dashboardFilters, { column: filterColumn, type: 'dimension', values: [q] }]);
                                    }
                                  }}
                                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all border ${isActive
                                    ? 'bg-violet-100 dark:bg-violet-500/25 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-500/40'
                                    : 'bg-slate-50 dark:bg-slate-700 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/10 hover:border-slate-300'
                                    }`}
                                >
                                  {q}
                                </button>
                              );
                            }))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── DIMENSION filter: value pills ── */}
                    {filterColumn && !isNumericColumn && !isDateColumn && categoricalValues.length > 0 && (
                      <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                        <label className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
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
                      Select a column to build a filter. Categorical fields show selectable values; numeric fields show a comparison operator; date fields show hierarchy + calendar.
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
                  className={`
                    animate-card-entrance
                    bg-white dark:bg-[#171c26]/80 dark:backdrop-blur-sm border border-gray-200 dark:border-white/[0.08] rounded-xl overflow-hidden
                    shadow-sm hover:shadow-lg dark:hover:shadow-violet-500/5
                    transition-all duration-300 group flex flex-col
                    hover:border-gray-300 dark:hover:border-violet-500/20
                    print:break-inside-avoid
                  `}
                  onMouseEnter={() => setHoveredCard(item.id)}
                  onMouseLeave={() => setHoveredCard(null)}
                >
                  {/* ── Card Header — drag handle ── */}
                  <div className="drag-handle flex items-center justify-between px-3.5 py-2.5 border-b border-gray-100 dark:border-white/[0.06] bg-gray-50/80 dark:bg-white/[0.02] flex-shrink-0 cursor-grab active:cursor-grabbing">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      {/* Grip dots visible on hover */}
                      <div className="opacity-0 group-hover:opacity-40 transition-opacity">
                        <GripVertical className="w-4 h-4 text-slate-400" />
                      </div>

                      {/* Chart type badge */}
                      <div
                        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                        style={{ backgroundColor: accent.accent + '20', color: accent.accent }}
                      >
                        {getChartIcon(vis)}
                      </div>

                      <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate">
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
                          <span className={`hidden sm:flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.bg} ${c.text} shrink-0`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                            {item.datasetName}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all print:hidden shrink-0 ml-2">
                      {/* Global filter toggle — only shown when filters are active */}
                      {dashboardFilters.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            updateItem({ ...item, ignoreGlobalFilter: !item.ignoreGlobalFilter });
                          }}
                          className={`p-1.5 rounded-lg transition-all ${item.ignoreGlobalFilter
                            ? 'bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-600'
                            : 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25'
                            }`}
                          title={item.ignoreGlobalFilter ? 'Global filter OFF — click to enable' : 'Global filter ON — click to disable'}
                        >
                          <Filter className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {/* Labels toggle — cycle Off → Primary → All */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const fmt = item.result.formatting || formatting;
                          const mode = fmt?.dataLabelMode || 'off';
                          let newFmt;
                          if (!fmt?.showDataLabels || mode === 'off') {
                            newFmt = { ...fmt, showDataLabels: true, dataLabelMode: 'primary' as const };
                          } else if (mode === 'primary') {
                            newFmt = { ...fmt, showDataLabels: true, dataLabelMode: 'all' as const };
                          } else {
                            newFmt = { ...fmt, showDataLabels: false, dataLabelMode: 'off' as const };
                          }
                          updateItem({ ...item, result: { ...item.result, formatting: newFmt } });
                        }}
                        className={`p-1.5 rounded-lg transition-all ${
                          (item.result.formatting || formatting)?.showDataLabels
                            ? (item.result.formatting || formatting)?.dataLabelMode === 'all'
                              ? 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-200'
                              : 'bg-sky-50 dark:bg-sky-500/15 text-sky-600 dark:text-sky-300 hover:bg-sky-100'
                            : 'bg-gray-50 dark:bg-gray-700 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-600'
                        }`}
                        title={`Labels: ${!(item.result.formatting || formatting)?.showDataLabels ? 'Off — click for Primary' : (item.result.formatting || formatting)?.dataLabelMode === 'all' ? 'All — click to turn Off' : 'Primary — click for All'}`}
                      >
                        <Tag className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onEdit?.(item); }}
                        className="p-1.5 rounded-lg bg-violet-50 dark:bg-violet-500/15 hover:bg-violet-100 dark:hover:bg-violet-500/25 text-violet-600 dark:text-violet-300 transition-all"
                        title="Edit in Workbench"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      {/* Fix #8: Refresh card with current dataset */}
                      {dataset && item.result?.queryConfig && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRefreshCard(item); }}
                          className={`p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 hover:bg-emerald-100 dark:hover:bg-emerald-500/25 text-emerald-600 dark:text-emerald-300 transition-all ${refreshingCards.has(item.id) ? 'animate-spin' : ''}`}
                          title="Refresh with current data"
                          disabled={refreshingCards.has(item.id)}
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                        className="p-1.5 rounded-lg bg-red-50 dark:bg-red-500/15 hover:bg-red-100 dark:hover:bg-red-500/25 text-red-500 dark:text-red-300 transition-all"
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
                  <div className="flex-1 p-2 min-h-0 overflow-hidden flex items-center justify-center bg-white">
                    <div className="w-full h-full min-h-0 overflow-hidden rounded-xl bg-white">
                      <ErrorBoundary compact label={item.title || 'Chart'}>
                        <ChartVisualization
                          config={item.result.config}
                          data={getFilteredData(item)}
                          xKey={item.result.xKey}
                          yKey={item.result.yKey}
                          yLabel={item.result.yLabel}
                          chartType={(item.result.vis as any) || 'bar'}
                          onChartTypeChange={() => { }}
                          formatting={item.result.formatting || formatting}
                          hideControls={true}
                        />
                      </ErrorBoundary>
                    </div>
                  </div>

                  {/* ── Card Footer — Metric Summary ── */}
                  <div className="px-3.5 py-2 border-t border-gray-100 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.02] flex items-center justify-between text-[11px] shrink-0">
                    <span className="text-gray-500 dark:text-gray-400 font-medium truncate">
                      {item.result.yLabel || item.result.yKey}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500 font-mono">
                      {item.result.data?.length || 0} rows
                    </span>
                  </div>
                </div>
              );
            })}
          </ResponsiveGridLayout>
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
