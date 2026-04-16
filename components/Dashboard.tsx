import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { ResponsiveGridLayout as RGLBase } from 'react-grid-layout';
const ResponsiveGridLayout = RGLBase as any;
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartVisualization } from './ChartVisualization';
import { ErrorBoundary } from './ErrorBoundary';
import {
  Trash2, Plus, Edit, AlertTriangle, X, FileDown, Presentation,
  ChevronLeft, ChevronRight, Maximize2, LayoutDashboard, GripVertical,
  TrendingUp, TrendingDown, BarChart3, PieChart, LineChart, Activity,
  Sparkles, Eye, Clock, ArrowUpRight, Filter, ChevronDown, RefreshCw
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { Dataset, DashboardItem } from '../types';
import { DashboardFilter } from '../store/useAppStore';

interface DashboardProps {
  dataset?: Dataset;
  onAddResult?: any;
  onEdit?: (item: any) => void;
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

export const Dashboard: React.FC<DashboardProps> = ({ dataset, onAddResult, onEdit }) => {
  const { items, removeItem, updateItem, formatting, clearAllItems, dashboardLayout, setDashboardLayout, dashboardFilters, setDashboardFilters } = useAppStore();
  const [showClearModal, setShowClearModal] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterColumn, setFilterColumn] = useState<string>('');
  const [refreshingCards, setRefreshingCards] = useState<Set<string>>(new Set());

  // Fix #8: Re-evaluate a dashboard card by re-running its stored query config
  const handleRefreshCard = useCallback(async (item: DashboardItem) => {
    if (!dataset || !item.result?.queryConfig) return;
    setRefreshingCards(prev => new Set(prev).add(item.id));
    try {
      // Dynamically import the analysis engine to avoid circular deps
      const { runAnalysis } = await import('../services/analysisEngine');
      const config = item.result.queryConfig;
      const freshResult = runAnalysis(dataset, {
        ...config,
        asOfDate: dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || new Date().toISOString().split('T')[0],
      });
      updateItem({ ...item, result: { ...freshResult, queryConfig: config } });
    } catch (err) {
      console.warn('[Dashboard] Refresh failed for card:', item.id, err);
    } finally {
      setRefreshingCards(prev => { const next = new Set(prev); next.delete(item.id); return next; });
    }
  }, [dataset, updateItem]);

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
    // 1. Create a map of existing layout items for quick lookup
    const layoutMap = new Map();
    if (dashboardLayout && Array.isArray(dashboardLayout)) {
      dashboardLayout.forEach((l: any) => layoutMap.set(l.i, l));
    }

    // 2. Determine where to place new items (below everything else)
    let maxY = 0;
    // Calculate the bottom-most point of the existing *persisted* layout
    // We only care about items that are still present to avoid gaps from deleted items
    const presentIds = new Set(items.map(i => i.id));
    layoutMap.forEach((l: any) => {
      if (presentIds.has(l.i)) {
        if ((l.y + l.h) > maxY) maxY = l.y + l.h;
      }
    });

    return items.map((item, i) => {
      // If this item exists in the persisted layout, reuse its config
      if (layoutMap.has(item.id)) {
        return layoutMap.get(item.id);
      }

      // Otherwise, create a new layout item at the bottom
      const newItem = {
        i: item.id,
        x: (i % 2) * 6,
        y: maxY,
        w: 6,
        h: 6,
        minW: 4,
        minH: 4,
      };

      if (i % 2 === 1) maxY += 6;

      return newItem;
    });
  }, [items, dashboardLayout]);

  // Generate responsive layouts for all breakpoints
  const allLayouts = useMemo(() => {
    // lg: 12 cols — use user-persisted layout directly
    const lg = layout;

    // md: 8 cols — scale x/w proportionally but preserve user height
    const md = layout.map((item: any) => ({
      ...item,
      x: Math.min(Math.floor(item.x * 8 / 12), 4),
      w: Math.min(Math.max(Math.floor(item.w * 8 / 12), 4), 8),
    }));

    // sm: 4 cols — full width single column, preserve height
    const sm = layout.map((item: any, i: number) => ({
      ...item,
      x: 0,
      w: 4,
      y: i * item.h,
    }));

    // xs: 2 cols — full width single column, preserve height
    const xs = layout.map((item: any, i: number) => ({
      ...item,
      x: 0,
      w: 2,
      y: i * item.h,
    }));

    return { lg, md, sm, xs };
  }, [layout]);

  const handleLayoutChange = useCallback((_cur: any, _allLayouts: any) => {
    // _cur is always the current breakpoint's live layout with the user's latest resize/drag.
    // allLayouts.lg can be stale on re-render, so we always save _cur directly.
    if (Array.isArray(_cur) && _cur.length > 0) {
      setDashboardLayout(_cur);
    }
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
      if (e.key === 'Escape') setPresentationMode(false);
      if (e.key === 'ArrowRight' || e.key === ' ') setCurrentSlide(prev => Math.min(prev + 1, items.length - 1));
      if (e.key === 'ArrowLeft') setCurrentSlide(prev => Math.max(prev - 1, 0));
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
                data={item.result.data}
                xKey={item.result.xKey}
                yKey={item.result.yKey}
                yLabel={item.result.yLabel}
                chartType={(item.result.vis as any) || 'bar'}
                onChartTypeChange={() => { }}
                formatting={formatting}
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
    <div className="h-full overflow-y-auto" ref={containerRef}>
      <div className="max-w-[1900px] mx-auto px-6 py-6 pb-24" ref={dashboardRef}>

        {/* ─── Dashboard Header ─── */}
        <div className="flex flex-col gap-4 mb-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md">
                <LayoutDashboard className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white tracking-tight">Dashboard</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {items.length > 0
                    ? `${items.length} visual${items.length !== 1 ? 's' : ''} · Drag to rearrange · Hover to interact`
                    : 'Pin visuals from Builder, NLQ, or Workbench'}
                </p>
              </div>

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
        </div>

        {/* ─── Global Filter Bar ─── */}
        {items.length > 0 && (
          <div className="mb-4">
            <button
              onClick={() => setFilterOpen(!filterOpen)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${dashboardFilters.length > 0
                ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100'
                : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-700'
                }`}
            >
              <Filter className="w-4 h-4" />
              Global Filters
              {dashboardFilters.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">
                  {dashboardFilters.length}
                </span>
              )}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ml-1 ${filterOpen ? 'rotate-180' : ''}`} />
            </button>

            {filterOpen && (() => {
              // Collect all columns from all dashboard items
              const allColumns = new Set<string>();
              items.forEach(item => {
                if (item.result?.data?.length > 0) {
                  Object.keys(item.result.data[0]).forEach(k => allColumns.add(k));
                }
              });
              const columnList = Array.from(allColumns).sort();

              // Get unique values for the selected filter column
              const selectedColValues: string[] = [];
              if (filterColumn) {
                const valSet = new Set<string>();
                items.forEach(item => {
                  item.result?.data?.forEach((row: any) => {
                    if (row[filterColumn] !== undefined && row[filterColumn] !== null) {
                      valSet.add(String(row[filterColumn]));
                    }
                  });
                });
                selectedColValues.push(...Array.from(valSet).sort());
              }

              const activeFilter = dashboardFilters.find(f => f.column === filterColumn);

              return (
                <div className="mt-2 bg-white border border-slate-200 rounded-xl p-4 shadow-lg">
                  <div className="flex flex-wrap items-start gap-4">
                    {/* Column Selector */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Filter Column</label>
                      <select
                        value={filterColumn}
                        onChange={e => setFilterColumn(e.target.value)}
                        className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none min-w-[180px]"
                      >
                        <option value="">Select column...</option>
                        {columnList.map(col => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </div>

                    {/* Value Multi-Select */}
                    {filterColumn && selectedColValues.length > 0 && (
                      <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Values (click to toggle)</label>
                        <div className="flex flex-wrap gap-1.5 max-h-[100px] overflow-y-auto">
                          {selectedColValues.map(val => {
                            const isActive = activeFilter?.values.includes(val) ?? false;
                            return (
                              <button
                                key={val}
                                onClick={() => {
                                  const existing = dashboardFilters.find(f => f.column === filterColumn);
                                  if (isActive) {
                                    // Remove this value
                                    if (existing) {
                                      const newValues = existing.values.filter(v => v !== val);
                                      if (newValues.length === 0) {
                                        setDashboardFilters(dashboardFilters.filter(f => f.column !== filterColumn));
                                      } else {
                                        setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: newValues } : f));
                                      }
                                    }
                                  } else {
                                    // Add this value
                                    if (existing) {
                                      setDashboardFilters(dashboardFilters.map(f => f.column === filterColumn ? { ...f, values: [...f.values, val] } : f));
                                    } else {
                                      setDashboardFilters([...dashboardFilters, { column: filterColumn, values: [val] }]);
                                    }
                                  }
                                }}
                                className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all border ${isActive
                                  ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                                  }`}
                              >
                                {val}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Clear All Filters */}
                    {dashboardFilters.length > 0 && (
                      <button
                        onClick={() => { setDashboardFilters([]); setFilterColumn(''); }}
                        className="self-end px-3 py-2 text-xs font-semibold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-all"
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>

                  {/* Active Filters Summary */}
                  {dashboardFilters.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200 flex flex-wrap gap-2">
                      {dashboardFilters.map(f => (
                        <div key={f.column} className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-xs">
                          <span className="text-amber-700 font-bold">{f.column}</span>
                          <span className="text-slate-500">=</span>
                          <span className="text-amber-600">{f.values.join(', ')}</span>
                          <button
                            onClick={() => setDashboardFilters(dashboardFilters.filter(df => df.column !== f.column))}
                            className="ml-1 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* ─── Empty State ─── */}
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center min-h-[500px] rounded-2xl border border-dashed border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
            <div className="text-center max-w-lg">
              <div className="w-18 h-18 rounded-2xl bg-violet-100 dark:bg-violet-500/15 border border-violet-200 dark:border-violet-500/20 flex items-center justify-center mx-auto mb-5">
                <LayoutDashboard className="w-9 h-9 text-violet-500 dark:text-violet-400/60" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Build Your Dashboard</h3>
              <p className="text-gray-500 dark:text-gray-400 mb-6 leading-relaxed text-sm">
                Pin charts from the <span className="text-violet-600 dark:text-violet-300 font-semibold">Question Builder</span>,{' '}
                <span className="text-purple-600 dark:text-purple-300 font-semibold">Ask Data</span>, or{' '}
                <span className="text-teal-600 dark:text-teal-300 font-semibold">Workbench</span> to create your analytics dashboard.
              </p>
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
        {items.length > 0 && (
          <ResponsiveGridLayout
            className="layout"
            layouts={allLayouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
            cols={{ lg: 12, md: 8, sm: 4, xs: 2 }}
            rowHeight={70}
            width={containerWidth}
            onLayoutChange={handleLayoutChange}
            isResizable={true}
            isDraggable={true}
            draggableHandle=".drag-handle"
            compactType="vertical"
            margin={[16, 16]}
          >
            {items.map((item, idx) => {
              const accent = CARD_ACCENTS[idx % CARD_ACCENTS.length];
              const vis = (item.result.vis as string) || 'bar';
              const isHovered = hoveredCard === item.id;

              return (
                <div
                  key={item.id}
                  className={`
                    animate-card-entrance
                    bg-white dark:bg-[#1c2033] border border-gray-200 dark:border-white/[0.08] rounded-xl overflow-hidden
                    shadow-sm hover:shadow-md
                    transition-all duration-200 group flex flex-col
                    print:break-inside-avoid
                  `}
                  onMouseEnter={() => setHoveredCard(item.id)}
                  onMouseLeave={() => setHoveredCard(null)}
                >
                  {/* ── Card Header — drag handle ── */}
                  <div className="drag-handle flex items-center justify-between px-3.5 py-2.5 border-b border-gray-100 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.02] flex-shrink-0 cursor-grab active:cursor-grabbing">
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
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all print:hidden shrink-0 ml-2">
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

                  {/* ── Chart Area ── */}
                  <div className="flex-1 p-2 min-h-0 overflow-hidden flex items-center justify-center">
                    <div className="w-full h-full">
                      <ErrorBoundary compact label={item.title || 'Chart'}>
                        <ChartVisualization
                          data={(() => {
                            // Apply global dashboard filters
                            let filteredData = item.result.data;
                            if (dashboardFilters.length > 0 && Array.isArray(filteredData)) {
                              dashboardFilters.forEach(f => {
                                filteredData = filteredData.filter((row: any) => {
                                  const val = row[f.column];
                                  if (val === undefined || val === null) return true;
                                  return f.values.includes(String(val));
                                });
                              });
                            }
                            return filteredData;
                          })()}
                          xKey={item.result.xKey}
                          yKey={item.result.yKey}
                          yLabel={item.result.yLabel}
                          chartType={(item.result.vis as any) || 'bar'}
                          onChartTypeChange={() => { }}
                          formatting={formatting}
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