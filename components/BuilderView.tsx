import React, { useState, useMemo, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import { QuestionBuilder } from './QuestionBuilder';
import { QuerySelect } from './QuerySelect';
import { ChartVisualization } from './ChartVisualization';
import { SmallMultiplesGrid } from './SmallMultiplesGrid';
import { resolveDimensionVisualization } from '../utils/dimensionVisualization';
import { effectiveDataLabelMode, toggleDataLabels } from '../utils/dataLabelVisibility';
import { AnalysisResult, Dataset, QueryConfig, FormattingConfig, AggregationType, TimeGrain, AnalysisType, ColumnType, RefreshSchedule } from '../types';
import { runAnalysis } from '../services/analysisEngine';
import { getCalculationDisplayName, applyMultipleCalculations, type TableCalculation, type CalculatedColumn } from '../utils/tableCalculations';
import { Tooltip } from './Tooltip';
import { RefreshSchedulerDropdown } from './RefreshSchedulerDropdown';
import { FormatPanel } from './FormatPanel';
import { QuestionBuilderVideoGuide } from './QuestionBuilderVideoGuide';
import { describeBuilderFinding, describeBuilderQuestion } from '../utils/builderAnswer';
import { BUILDER_SPLIT_DEFAULT, BUILDER_SPLIT_MIN, builderSplitMaximum, clampBuilderSplit } from '../utils/builderSplitter';
import { chartShapeSignature, suggestCharts } from '../utils/chartSuggestions';

import { AIInsightPanel } from './AIInsightPanel';
import { ExploreMenu } from './ExploreMenu';
import { UnderlyingRowsDrawer } from './UnderlyingRowsDrawer';
import {
    describeTarget, drillConfig, drillOptions, excludeConfig, isGrainKey, keepConfig, primaryDateColumn, resolveTargets,
    rowMatchesTargets, rowsForBuilderConfig,
    type ChartPointSelection, type DrillOption, type ExploreTarget,
} from '../utils/explore';
import { TransparencyPanel } from './TransparencyPanel';

import { AlertTriangle, Code, Play, Palette, X, Pin, CheckCircle2, Activity, TrendingUp, BarChart3, BarChart2, Download, Loader2, Eye, EyeOff, Table2, PanelTopClose, RotateCcw, RefreshCw, Zap, LayoutGrid, Layers, Calendar, Undo2, GripVertical, PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react';

interface BuilderViewProps {
    dataset: Dataset;
    formatting?: FormattingConfig;
    onUpdateFormatting?: (config: FormattingConfig) => void;
    onPin?: (title: string, result: AnalysisResult) => void;
    initialConfig?: any; // QueryConfig from dashboard edit
    editingItemId?: string | null; // ID of dashboard item being edited
    onSaveBackToDashboard?: (result: AnalysisResult) => void; // Save edits back to dashboard
    onCancelEdit?: () => void; // Cancel editing and return to dashboard
    onLiveRefresh?: () => Promise<void>;
    isLiveRefreshing?: boolean;
    refreshSchedule?: RefreshSchedule;
    onScheduleChange?: (schedule: RefreshSchedule) => void;
    /** True only while the Question Builder page is visible. Keeps document-level portals scoped to this page. */
    isActive?: boolean;
    /** Clears any parent-owned dashboard/AI SQL handoff when Reset starts a new builder session. */
    onReset?: () => void;
}

/** "You are viewing total sales by month." → "Total sales by month" */
function headlineQuestion(sentence: string): string {
    const text = sentence.replace(/^You are viewing\s+/i, '').replace(/\.$/, '');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export const BuilderView: React.FC<BuilderViewProps> = ({ dataset, formatting, onUpdateFormatting, onPin, initialConfig, editingItemId, onSaveBackToDashboard, onCancelEdit, onLiveRefresh, isLiveRefreshing, refreshSchedule, onScheduleChange, isActive = true, onReset }) => {
    const workspaceRef = useRef<HTMLDivElement>(null);
    const [workspaceWidth, setWorkspaceWidth] = useState(() => typeof window === 'undefined' ? 1200 : window.innerWidth);
    const [preferredBuilderWidth, setPreferredBuilderWidth] = useState(() => {
        try {
            const saved = Number(localStorage.getItem('qi_builder_pane_width_v2'));
            return Number.isFinite(saved) && saved > 0 ? saved : BUILDER_SPLIT_DEFAULT;
        } catch { return BUILDER_SPLIT_DEFAULT; }
    });
    const [isResizingBuilder, setIsResizingBuilder] = useState(false);
    const builderWidth = clampBuilderSplit(preferredBuilderWidth, workspaceWidth);
    const builderMaxWidth = builderSplitMaximum(workspaceWidth);

    React.useEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const updateWidth = () => setWorkspaceWidth(workspace.getBoundingClientRect().width);
        updateWidth();
        const observer = new ResizeObserver(updateWidth);
        observer.observe(workspace);
        return () => observer.disconnect();
    }, []);

    React.useEffect(() => {
        const timer = window.setTimeout(() => {
            try { localStorage.setItem('qi_builder_pane_width_v2', String(preferredBuilderWidth)); } catch { /* private storage unavailable */ }
        }, 250);
        return () => window.clearTimeout(timer);
    }, [preferredBuilderWidth]);

    const resizeBuilderToPointer = (clientX: number) => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const rect = workspace.getBoundingClientRect();
        setPreferredBuilderWidth(clampBuilderSplit(clientX - rect.left, rect.width));
    };

    // ── Session persistence key (scoped to dataset) ──
    const storageKey = `qi_builder_${dataset.id}`;
    const [savedSession, setSavedSession] = useState<any>(() => {
        try {
            const raw = sessionStorage.getItem(storageKey);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    });

    const [result, setResult] = useState<AnalysisResult | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [chartType, setChartType] = useState<any>(savedSession?.chartType || 'bar');
    // A chart the user picked is kept while they refine the same question
    // (filters, time range, sort); a new metric or grouping gets a fresh
    // shape-based pick, so results are not always a bar or a line.
    const chartChoiceRef = useRef<{ signature: string; type: string } | null>(
        savedSession?.chartType && savedSession?.config
            ? { signature: chartShapeSignature(savedSession.config), type: savedSession.chartType }
            : null,
    );
    const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
    const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
    const [showGrowthChart, setShowGrowthChart] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [lastRunConfig, setLastRunConfig] = useState<any>(savedSession?.config || null);
    const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
    const [isBuilderCollapsed, setIsBuilderCollapsed] = useState(false);
    const [showHandoffNotice, setShowHandoffNotice] = useState(true);
    const [freshSession, setFreshSession] = useState(false);
    const [builderResetVersion, setBuilderResetVersion] = useState(0);
    const [undoDepth, setUndoDepth] = useState(0);
    const [undoRestoreConfig, setUndoRestoreConfig] = useState<any>(null);
    const undoHistoryRef = useRef<any[]>([]);
    const requestedConfigRef = useRef<any>(null);
    const lastHandoffIdRef = useRef<string | null>(null);
    const lastIncomingConfigRef = useRef<any>(initialConfig);
    // Builder controls can fire rapidly (typing a limit, swapping fields,
    // toggling filters). Only the newest requested analysis is allowed to
    // update the visible result; a slower older run must never overwrite it.
    const runSequenceRef = useRef(0);
    // The user's own pick from the chart menu or the "Views" chips.
    const chooseChartType = useCallback((type: string) => {
        const config = requestedConfigRef.current || lastRunConfig;
        chartChoiceRef.current = config ? { signature: chartShapeSignature(config), type } : null;
        setChartType(type);
    }, [lastRunConfig]);

    const clearUndoHistory = useCallback(() => {
        undoHistoryRef.current = [];
        requestedConfigRef.current = null;
        setUndoDepth(0);
        setUndoRestoreConfig(null);
    }, []);

    // Responsive chart libraries measure their parent. Notify them immediately
    // and once more after the layout settles when the Builder column changes.
    React.useEffect(() => {
        const notifyResize = () => window.dispatchEvent(new Event('resize'));
        const frame = requestAnimationFrame(notifyResize);
        const settle = window.setTimeout(notifyResize, 320);
        return () => {
            cancelAnimationFrame(frame);
            window.clearTimeout(settle);
        };
    }, [isBuilderCollapsed, builderWidth]);

    // Full-screen mode is intentionally local to this Builder instance. Keeping
    // the same instance alive preserves the query, result, filters and formatting.
    const [isAnalyticsExplorer, setIsAnalyticsExplorer] = useState(false);
    const [contentTab, setContentTab] = useState<'visual' | 'sql' | 'data'>('visual');
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const [forceGridMode, setForceGridMode] = useState<'auto' | 'grid' | 'combined'>('auto');
    const hasAutoRestoredRef = useRef(false);


    // Export CSV helper
    const exportToCSV = () => {
        if (!result) return;
        const data = tableData.data;
        if (!data.length) return;
        const keys = Object.keys(data[0]);
        const csvRows = [
            keys.join(','),
            ...data.map(row => keys.map(k => {
                const val = row[k];
                const str = String(val ?? '');
                return str.includes(',') ? `"${str}"` : str;
            }).join(','))
        ];
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.yLabel || 'export'}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // anchor_date: defaults to MAX of the anchor date column (defaultAnchorDate)
    const [anchorColumn, setAnchorColumn] = useState<string>(
        dataset.timeContext?.anchorDateColumn || ''
    );
    const [asOfDate, setAsOfDate] = useState<string>(
        dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate || ''
    );
    const [isUserOverride, setIsUserOverride] = useState(false);

    // Recompute when dataset changes
    React.useEffect(() => {
        const tc = dataset.timeContext;
        if (tc) {
            setAnchorColumn(tc.anchorDateColumn || '');
            setAsOfDate(tc.defaultAnchorDate || tc.maxDate || '');
            setIsUserOverride(false); // Reset override on dataset change
        }
    }, [dataset.id]);

    React.useEffect(() => {
        clearUndoHistory();
    }, [dataset.id, clearUndoHistory]);

    // Dedicated effect: sync asOfDate when ETL populates timeContext (async)
    React.useEffect(() => {
        const tc = dataset.timeContext;
        if (tc && !isUserOverride) {
            const newDate = tc.defaultAnchorDate || tc.maxDate || '';
            if (newDate) {
                setAnchorColumn(tc.anchorDateColumn || '');
                setAsOfDate(newDate);
            }
        }
    }, [dataset.timeContext]);

    // Reset ignores the configuration that was active at that moment. Any
    // later navigation into Builder (AI SQL, Quick Insights or dashboard edit)
    // is a new explicit handoff and may initialize the controls again.
    React.useEffect(() => {
        if (!initialConfig) {
            lastIncomingConfigRef.current = undefined;
            return;
        }
        if (initialConfig !== lastIncomingConfigRef.current) {
            lastIncomingConfigRef.current = initialConfig;
            setFreshSession(false);
            clearUndoHistory();
        }
    }, [initialConfig, clearUndoHistory]);

    // Auto-run when editing from dashboard (initialConfig changes)
    React.useEffect(() => {
        if (initialConfig && editingItemId) {
            setFreshSession(false);
            // Small delay to let QuestionBuilder remount with new initial values
            const timer = setTimeout(() => {
                handleRun(initialConfig, { recordHistory: false });
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [editingItemId]);

    // AI SQL handoffs are explicit new analyses, not dashboard edits. Remount
    // the controls from the transferred configuration and run the editable
    // base query once when the handoff arrives.
    React.useEffect(() => {
        const handoffId = initialConfig?._handoffId;
        if (!handoffId || lastHandoffIdRef.current === handoffId) return;
        lastHandoffIdRef.current = handoffId;
        setFreshSession(false);
        setShowHandoffNotice(true);
        if (initialConfig.chartType) {
            setChartType(initialConfig.chartType);
            chartChoiceRef.current = { signature: chartShapeSignature(initialConfig), type: initialConfig.chartType };
        }
        clearUndoHistory();
        const timer = setTimeout(() => handleRun(initialConfig, { recordHistory: false }), 120);
        return () => clearTimeout(timer);
    }, [initialConfig?._handoffId]);

    // Auto-re-run analysis when dataset refreshes (version changes)
    // This handles live refresh: worker updates dataset.rows → version increments → re-run query
    const prevVersionRef = useRef(dataset.version);
    React.useEffect(() => {
        if (dataset.version !== prevVersionRef.current && lastRunConfig) {
            prevVersionRef.current = dataset.version;
            console.log(`[BuilderView] Dataset version changed (v${dataset.version}) — re-running analysis`);
            handleRun(lastRunConfig, { recordHistory: false });
        }
    }, [dataset.version]);

    // ── Persist builder state to sessionStorage on every successful run ──
    React.useEffect(() => {
        if (lastRunConfig) {
            try {
                sessionStorage.setItem(storageKey, JSON.stringify({
                    config: lastRunConfig,
                    chartType,
                    timestamp: Date.now()
                }));
            } catch { /* quota exceeded — ignore */ }
        }
    }, [lastRunConfig, chartType, storageKey]);

    // ── Auto-restore from session on mount (browser refresh) ──
    React.useEffect(() => {
        if (hasAutoRestoredRef.current) return;
        if (editingItemId) return; // Don't auto-restore when editing a dashboard item
        if (initialConfig) return; // Don't override explicit config from dashboard
        if (savedSession?.config && dataset.rows.length > 0) {
            hasAutoRestoredRef.current = true;
            console.log('[BuilderView] Restoring session — auto-running saved config');
            // Delay slightly to let QuestionBuilder mount with saved initial values
            const timer = setTimeout(() => handleRun(savedSession.config, { recordHistory: false }), 300);
            return () => clearTimeout(timer);
        }
    }, [dataset.rows.length]);

    // User manually changes AS OF date
    const handleAsOfDateChange = (date: string) => {
        setAsOfDate(date);
        setIsUserOverride(true);
    };

    // When user changes anchor column, recompute AS OF date (not a user override)
    const handleAnchorColumnChange = (col: string) => {
        setAnchorColumn(col);
        const maxForCol = dataset.timeContext?.dateColumnMaxDates?.[col];
        if (maxForCol && !isUserOverride) setAsOfDate(maxForCol);
    };

    const handleRun = async (config: any, options: { recordHistory?: boolean } = {}) => {
        const nextRequestedConfig = JSON.parse(JSON.stringify(config));
        const previousRequestedConfig = requestedConfigRef.current;
        if (options.recordHistory !== false && previousRequestedConfig
            && JSON.stringify(previousRequestedConfig) !== JSON.stringify(nextRequestedConfig)) {
            undoHistoryRef.current = [...undoHistoryRef.current, previousRequestedConfig].slice(-30);
            setUndoDepth(undoHistoryRef.current.length);
        }
        requestedConfigRef.current = nextRequestedConfig;

        const runSequence = ++runSequenceRef.current;
        try {
            setError(null);
            setIsLoading(true);
            setIsAIInsightOpen(false); // Reset AI insight on new question

            const query: QueryConfig = {
                questionId: 'custom_builder',
                metric: config.metric,
                dimension: config.dimension,
                aggregation: config.aggregation || AggregationType.SUM,
                timeGrain: TimeGrain.RAW,
                analysisType: AnalysisType.STANDARD,
                timeFilter: config.timeFilter,
                filters: config.filters,
                measureFilters: config.measureFilters,
                dateFilters: config.dateFilters,
                limit: config.limit,
                sort: config.sort,
                chartType: chartType,
                asOfDate: asOfDate,
                comparison: ('comparison' in config) ? (config.comparison || '') : (result?.config?.comparison || ''),
                comparisonMode: config.comparisonMode || result?.config?.comparisonMode,
                comparisonGrain: ('comparisonGrain' in config) ? config.comparisonGrain : (result?.config?.comparisonGrain),
                comparisonOffset: ('comparisonOffset' in config) ? config.comparisonOffset : (result?.config?.comparisonOffset),
                ...(config.secondaryMetrics?.length > 0 ? { secondaryMetrics: config.secondaryMetrics, axisMode: config.axisMode || 'auto', secondaryMetricVisuals: config.secondaryMetricVisuals || {}, secondaryMetricAggregations: config.secondaryMetricAggregations || {} } : {}),
                ...(config.secondaryDimensions?.length > 0 ? { secondaryDimensions: config.secondaryDimensions } : {}),
                tableCalculations: (formatting?.tableCalculations || []).filter(c => c !== 'none'),
            };

            const res = await runAnalysis(dataset, query);

            if (runSequence !== runSequenceRef.current) return;

            // Apply the recommended chart type from the question/registry
            // Override: when comparison is active with few data points, force bar chart
            // (line chart with 1-4 points looks like dots, not a useful visualization)
            const hasComp = config.comparison && config.comparison !== 'none' && config.comparison !== '';
            const hasSecondary = config.secondaryMetrics?.length > 0;

            const shapeSignature = chartShapeSignature(config);
            const pinnedChart = chartChoiceRef.current?.signature === shapeSignature ? chartChoiceRef.current.type : null;
            if (!pinnedChart) chartChoiceRef.current = null;

            if (hasSecondary) {
                // Combo chart: primary metric as BAR, secondary overlays as line/bar/area
                // Force the primary chart to 'bar' for a clean combo look
                setChartType(pinnedChart || 'bar');
            } else {
                const fewPts = (res.data?.length || 0) <= 4;
                const suggested = suggestCharts({
                    rows: res.data || [],
                    xKey: res.xKey,
                    yKey: res.yKey,
                    dimension: config.dimension,
                    aggregation: query.aggregation,
                    seriesKey: config.secondaryDimensions?.[0],
                    hasComparison: Boolean(hasComp && (res.data || []).some((row: any) => row?.previous_value !== undefined)),
                    sort: config.sort,
                    limit: config.limit,
                    kpiGoal: formatting?.kpiGoal,
                }).best?.type;
                const next = pinnedChart || suggested || res.vis;
                const isLineType = ['line', 'area', 'steppedLine', 'curvedLine', 'stackedArea'].includes(next || '');
                if (next) {
                    // Line chart with 1-4 compared points looks like dots, not a trend.
                    setChartType(hasComp && fewPts && isLineType ? 'bar' : next);
                } else if (!hasComp && (res.data?.length || 0) <= 1) {
                    // No recommendation and a single aggregated row (Total mode)
                    setChartType('kpiCard');
                }
            }

            setResult(res);
            setLastRunConfig(nextRequestedConfig);
            const previousGrouping = JSON.stringify([lastRunConfig?.dimension, ...(lastRunConfig?.secondaryDimensions || [])]);
            const nextGrouping = JSON.stringify([config.dimension, ...(config.secondaryDimensions || [])]);
            if (previousGrouping !== nextGrouping) {
                setForceGridMode('auto');
                setContentTab('visual');
            }
            setIsLoading(false);

        } catch (err: any) {
            if (runSequence !== runSequenceRef.current) return;
            console.error(err);
            setError(err.message || 'An error occurred during analysis');
            setResult(undefined);
            setIsLoading(false);
        }
    };

    const handleUndo = () => {
        if (isLoading || undoHistoryRef.current.length === 0) return;
        const targetConfig = undoHistoryRef.current[undoHistoryRef.current.length - 1];
        undoHistoryRef.current = undoHistoryRef.current.slice(0, -1);
        setUndoDepth(undoHistoryRef.current.length);
        setUndoRestoreConfig(targetConfig);
        setBuilderResetVersion(version => version + 1);
        setContentTab('visual');
        setForceGridMode('auto');
        void handleRun(targetConfig, { recordHistory: false });
    };

    React.useEffect(() => {
        if (!isActive) return;
        const onUndoShortcut = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
            const target = event.target as HTMLElement | null;
            if (target?.matches('input, textarea, [contenteditable="true"]')) return;
            if (undoHistoryRef.current.length === 0 || isLoading) return;
            event.preventDefault();
            handleUndo();
        };
        window.addEventListener('keydown', onUndoShortcut);
        return () => window.removeEventListener('keydown', onUndoShortcut);
    }, [isActive, isLoading, undoDepth]);

    // --- Click to explore: show only, exclude, break down, see rows ---
    const [explore, setExplore] = useState<{ selection: ChartPointSelection; targets: ExploreTarget[]; options: DrillOption[]; rowCount: number } | null>(null);
    const [rowsView, setRowsView] = useState<{ title: string; conditions: string[]; rows: Record<string, any>[] } | null>(null);
    // The trail of views that led here; shown while the visible question is the one it leads to.
    const [drillTrail, setDrillTrail] = useState<{ levels: Array<{ label: string; config: any }>; current: string; leadsTo: string } | null>(null);
    // What defines a view: grouping, measure and filters. Defaults the controls
    // add when they rebuild (sort, limit, empty lists) must not break the trail.
    const configSignature = (config: any) => {
        const c = config || {};
        const filters = Object.entries(c.filters || {})
            .filter(([, v]) => Array.isArray(v) && v.length > 0)
            .map(([k, v]) => [k, [...(v as string[])].map(String).sort()])
            .sort(([a], [b]) => String(a).localeCompare(String(b)));
        const dates = (c.dateFilters || []).filter((d: any) => d?.values?.length)
            .map((d: any) => [d.column || '', d.timeGrain || '', [...d.values].sort()]);
        const measures = (c.measureFilters || []).map((m: any) => [m.column, m.operator, m.value]);
        return JSON.stringify([c.metric || '', c.dimension || '', filters, dates, measures,
            [...(c.secondaryDimensions || [])].sort(), String(c.aggregation || '').toUpperCase()]);
    };
    const words = (name: string) => String(name || '').replace(/_/g, ' ');
    const viewLabel = (config: any) => {
        const dim = config?.dimension;
        return dim ? `By ${isGrainKey(dim) ? dim : words(dim)}` : 'Total';
    };

    const runExplored = (next: any, currentLabel: string) => {
        if (!lastRunConfig) return;
        const levels = drillTrail && drillTrail.leadsTo === configSignature(lastRunConfig)
            ? [...drillTrail.levels, { label: drillTrail.current, config: lastRunConfig }]
            : [{ label: viewLabel(lastRunConfig), config: lastRunConfig }];
        setDrillTrail({ levels, current: currentLabel, leadsTo: configSignature(next) });
        // Rebuild the controls from the new question so they always match the chart.
        setUndoRestoreConfig(next);
        setBuilderResetVersion(version => version + 1);
        setContentTab('visual');
        void handleRun(next);
    };

    /** One-click breakdowns offered when the question has no grouping yet. */
    const quickStarts = useMemo(() => {
        if (!result || !lastRunConfig || lastRunConfig.dimension || !lastRunConfig.metric) return [] as { value: string; label: string }[];
        const sample = (dataset.rows || []).slice(0, 2000);
        const options: { value: string; label: string }[] = [];
        for (const column of dataset.columns) {
            if (column.type !== ColumnType.DIMENSION) continue;
            const distinct = new Set(sample.map(row => row[column.name]).filter(v => v !== null && v !== undefined && v !== ''));
            if (distinct.size < 2 || distinct.size > 40) continue;
            options.push({ value: column.name, label: `by ${column.name.replace(/_/g, ' ')}` });
            if (options.length >= 3) break;
        }
        if (primaryDateColumn(dataset)) options.push({ value: 'month', label: 'over time' });
        return options;
    }, [result, lastRunConfig, dataset]);

    const runQuickStart = (dimension: string) => {
        if (!lastRunConfig) return;
        const next = { ...lastRunConfig, dimension };
        if (dimension === 'month') { next.sort = 'oldest'; delete next.limit; }
        setUndoRestoreConfig(next);
        setBuilderResetVersion(version => version + 1);
        setContentTab('visual');
        void handleRun(next);
    };

    const goToTrailLevel = (index: number) => {
        if (!drillTrail) return;
        const level = drillTrail.levels[index];
        if (!level) return;
        setDrillTrail(index === 0 ? null : { levels: drillTrail.levels.slice(0, index), current: level.label, leadsTo: configSignature(level.config) });
        setUndoRestoreConfig(level.config);
        setBuilderResetVersion(version => version + 1);
        void handleRun(level.config);
    };

    const handlePointSelect = useCallback((selection: ChartPointSelection) => {
        if (!result || !lastRunConfig) return;
        const targets = resolveTargets(dataset, lastRunConfig.dimension, selection);
        if (targets.length === 0) return;
        const scope = rowsForBuilderConfig(dataset, lastRunConfig).filter(row => rowMatchesTargets(row, targets));
        setExplore({ selection, targets, options: drillOptions(dataset, lastRunConfig, targets), rowCount: scope.length });
    }, [result, lastRunConfig, dataset]);

    const exploreMenu = (() => {
        if (!explore || !lastRunConfig) return null;
        const { selection, targets, options, rowCount } = explore;
        const title = targets.map(t => t.label).join(' · ');
        const metricText = Number.isFinite(selection.metricValue)
            ? `${selection.metricLabel || (words(lastRunConfig.metric || '') || 'Value').replace(/^./, c => c.toUpperCase())}: ${Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(selection.metricValue!)}`
            : undefined;
        const xTarget = targets[0];
        const onlyOne = (result?.data?.length || 0) <= 1;
        const actions = [
            ...(!onlyOne || targets.length > 1 ? [{
                id: 'keep', icon: 'keep' as const, label: `Show only ${title}`,
                onSelect: () => runExplored(keepConfig(lastRunConfig, targets), `Only ${title}`),
            }] : []),
            ...(xTarget.kind === 'column' && !onlyOne ? [{
                id: 'exclude', icon: 'exclude' as const, label: `Exclude ${xTarget.label}`,
                onSelect: () => runExplored(excludeConfig(dataset, lastRunConfig, xTarget), `Without ${xTarget.label}`),
            }] : []),
            {
                id: 'rows', icon: 'rows' as const, label: `See the ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'}`,
                onSelect: () => setRowsView({
                    title: `Rows behind ${title}`,
                    conditions: targets.map(describeTarget),
                    rows: rowsForBuilderConfig(dataset, lastRunConfig).filter(row => rowMatchesTargets(row, targets)),
                }),
            },
        ];
        return (
            <ExploreMenu
                anchor={selection.anchor}
                title={title}
                context={metricText}
                actions={actions}
                drill={{
                    heading: `Break ${title} down`,
                    options,
                    onSelect: option => runExplored(drillConfig(lastRunConfig, targets, option), `${title} · ${option.label}`),
                }}
                onClose={() => setExplore(null)}
            />
        );
    })();

    const trailVisible = Boolean(drillTrail && lastRunConfig && drillTrail.leadsTo === configSignature(lastRunConfig));

    const tableData = useMemo(() => {
        if (!result) return { data: [], columns: [] as CalculatedColumn[] };

        // Only user-selected table calculations go to the Calculated tab
        // Comparison (previous_period) stays in Original tab — handled by ChartVisualization natively
        const activeCalcs: TableCalculation[] = (formatting?.tableCalculations || []).filter(c => c !== 'none');

        if (activeCalcs.length === 0) {
            return { data: result.data || [], columns: [] as CalculatedColumn[] };
        }

        // Strip comparison fields BEFORE calculations so they don't leak through { ...row } spreads
        const cleanRows = (result.data || []).map((r: any) => {
            const { previous_value, growth_pct, previous_period_label, difference, ...rest } = r;
            return rest;
        });

        const { transformedData, columns } = applyMultipleCalculations(
            cleanRows,
            result.yKey,
            activeCalcs,
            result.yLabel,
            formatting?.numberFormat || 'raw',
            formatting?.movingAvgWindow || 3,
            formatting?.tableCalculationComparison
                ? { ...formatting.tableCalculationComparison, dimensionKey: result.xKey }
                : undefined
        );
        return { data: transformedData, columns };
    }, [result, formatting?.tableCalculations, formatting?.tableCalculationComparison, formatting?.numberFormat, formatting?.movingAvgWindow]);

    const handleTableCalculationToggle = useCallback((calc: TableCalculation, isSelected: boolean) => {
        if (!formatting || !onUpdateFormatting) return;
        const current = formatting.tableCalculations || [];
        const tableCalculations = isSelected
            ? current.filter(calculation => calculation !== calc)
            : [...current, calc];
        const nextFormatting = { ...formatting, tableCalculations };

        onUpdateFormatting(nextFormatting);
        // The explorer is a mode of this exact Builder instance, not a copied
        // preview. Its result and all Question Builder controls stay live.
        if (!isSelected && tableCalculations.length > 0 && result) {
            setShowGrowthChart(true);
            setIsAnalyticsExplorer(true);
        }
    }, [formatting, onUpdateFormatting, result]);

    const handleReset = useCallback(() => {
        // Invalidate an analysis already in flight before clearing the result.
        // Otherwise its late response can repopulate the supposedly fresh page.
        runSequenceRef.current += 1;
        setResult(undefined);
        setError(null);
        setIsLoading(false);
        setLastRunConfig(null);
        setDrillTrail(null);
        setExplore(null);
        setShowGrowthChart(false);
        setIsAnalyticsExplorer(false);
        setIsAIInsightOpen(false);
        setIsFormatPanelOpen(false);
        setIsAnalyticsPanelOpen(false);
        setContentTab('visual');
        setForceGridMode('auto');
        setChartType('bar');
        chartChoiceRef.current = null;
        setShowHandoffNotice(false);
        clearUndoHistory();

        // A transferred AI SQL config and the persisted builder config are two
        // independent sources. Both must be ignored/removed or the synthetic
        // result fields (for example Metric and Value) return on the next edit.
        setFreshSession(true);
        setSavedSession(null);
        setBuilderResetVersion(version => version + 1);
        try { sessionStorage.removeItem(storageKey); } catch { /* unavailable storage */ }

        // AI SQL can transfer table calculations into the global formatting
        // state. They belong to the old analysis and must not affect the new one.
        if (formatting?.tableCalculations?.length) {
            onUpdateFormatting?.({ ...formatting, tableCalculations: [] });
        }
        onReset?.();
    }, [clearUndoHistory, formatting, onReset, onUpdateFormatting, storageKey]);

    const effectiveInitialConfig = freshSession ? undefined : initialConfig;
    const effectiveSavedSession = freshSession ? null : savedSession;
    const activeBuilderConfig = undoRestoreConfig || effectiveInitialConfig || effectiveSavedSession?.config || {};
    const dimensionLayout = useMemo(() => result
        ? resolveDimensionVisualization(result.data, result.xKey, result.yKey, result.config, forceGridMode)
        : null,
    [result, forceGridMode]);

    return (
        <div ref={workspaceRef} style={{ '--qi-builder-dock-width': `${builderWidth}px` } as React.CSSProperties} className={`qi-builder-workspace qi-builder-layout ${isBuilderCollapsed ? 'qi-builder-layout--builder-collapsed' : ''} ${isAnalyticsExplorer ? 'qi-builder-layout--explorer' : ''} ${isResizingBuilder ? 'qi-builder-layout--resizing' : ''} flex flex-col h-full bg-slate-50`}>
            {isAnalyticsExplorer && (
                <div className="qi-analytics-explorer-header qi-builder-context flex items-center justify-between px-5 py-3 bg-white border-b border-slate-200 shadow-sm shrink-0 z-30">
                    <div>
                        <div className="text-sm font-black text-slate-900">Analytics Explorer</div>
                        <div className="text-xs text-slate-500">{result?.yLabel || 'Explore your current analysis'}</div>
                    </div>
                    <button
                        onClick={() => setIsAnalyticsExplorer(false)}
                        className="px-3 py-2 text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
                    >
                        ← Back to Question Builder
                    </button>
                </div>
            )}

            {/* â”€â”€â”€ COLLAPSIBLE BUILDER â”€â”€â”€ */}
            <div id="qi-builder-panel" className={`qi-builder-panel qi-builder-dock relative bg-white border-b border-slate-200 shadow-sm z-20 shrink-0 transition-all duration-300 ease-in-out ${isAnalyticsExplorer ? 'hidden' : (isBuilderCollapsed ? 'max-h-0 border-b-0 overflow-hidden' : 'max-h-[500px] overflow-visible')}`}>
                {effectiveInitialConfig?._source === 'ai-sql' && showHandoffNotice && (
                    <div className={`mx-3 mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${effectiveInitialConfig._handoffWarnings?.length ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`} role="status">
                        {effectiveInitialConfig._handoffWarnings?.length ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        <div className="min-w-0 flex-1">
                            <div className="font-extrabold">Opened from AI SQL — GAFS edit mode.</div>
                            <div className="mt-0.5">Edit grouping, aggregation, filtering, sorting and the result limit. Reset starts a new full Question Builder session.</div>
                            {effectiveInitialConfig._handoffWarnings?.length > 0 && (
                                <div className="mt-0.5">{effectiveInitialConfig._handoffWarnings.join(' ')}</div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowHandoffNotice(false)}
                            className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-current opacity-70 transition hover:bg-black/10 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-current/30"
                            aria-label="Dismiss AI SQL handoff notice"
                            title="Dismiss"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                )}
                <QuestionBuilder
                    key={`${editingItemId || effectiveInitialConfig?._handoffId || 'default'}:${builderResetVersion}`}
                    dataset={dataset}
                    mode={effectiveInitialConfig?._source === 'ai-sql' ? 'gafs' : 'full'}
                    onRun={handleRun}
                    initialMetric={activeBuilderConfig.metric || ''}
                    initialAggregation={activeBuilderConfig.aggregation || 'SUM'}
                    initialDimension={activeBuilderConfig.dimension || ''}
                    initialTimeFilter={activeBuilderConfig.timeFilter || 'all_time'}
                    initialLimit={activeBuilderConfig.limit ?? 0}
                    initialSort={activeBuilderConfig.sort || 'desc'}
                    initialComparison={activeBuilderConfig.comparison || ''}
                    initialComparisonGrain={activeBuilderConfig.comparisonGrain || 'month'}
                    initialComparisonOffset={activeBuilderConfig.comparisonOffset ?? 1}
                    initialSecondaryMetrics={activeBuilderConfig.secondaryMetrics || []}
                    initialSecondaryMetricVisuals={activeBuilderConfig.secondaryMetricVisuals || {}}
                    initialSecondaryMetricAggregations={activeBuilderConfig.secondaryMetricAggregations || {}}
                    initialSecondaryDimensions={activeBuilderConfig.secondaryDimensions || []}
                    initialFilters={activeBuilderConfig.filters || {}}
                    initialMeasureFilters={activeBuilderConfig.measureFilters || []}
                    initialDateFilters={activeBuilderConfig.dateFilters || []}
                    asOfDate={asOfDate}
                    onDateChange={handleAsOfDateChange}
                    anchorColumn={anchorColumn}
                    onAnchorColumnChange={handleAnchorColumnChange}
                    isActive={isActive}
                    tableCalculations={(formatting?.tableCalculations || []).filter(calculation => calculation !== 'none')}
                    movingAvgWindow={formatting?.movingAvgWindow || 3}
                    onTableCalculationsChange={tableCalculations => formatting && onUpdateFormatting?.({ ...formatting, tableCalculations })}
                    onMovingAvgWindowChange={movingAvgWindow => formatting && onUpdateFormatting?.({ ...formatting, movingAvgWindow })}
                />
            </div>

            {!isBuilderCollapsed && !isAnalyticsExplorer && (
                <div
                    role="separator"
                    tabIndex={0}
                    aria-label="Resize Question Builder and visual result"
                    aria-orientation="vertical"
                    aria-controls="qi-builder-panel qi-builder-result-pane"
                    aria-valuemin={BUILDER_SPLIT_MIN}
                    aria-valuemax={builderMaxWidth}
                    aria-valuenow={builderWidth}
                    aria-valuetext={`${builderWidth} pixels for Question Builder`}
                    className="qi-builder-splitter"
                    title="Drag to resize the Question Builder. Use arrow keys when focused; double-click to reset."
                    onPointerDown={event => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setIsResizingBuilder(true);
                    }}
                    onPointerMove={event => {
                        if (isResizingBuilder && event.currentTarget.hasPointerCapture(event.pointerId)) {
                            resizeBuilderToPointer(event.clientX);
                        }
                    }}
                    onPointerUp={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                        setIsResizingBuilder(false);
                    }}
                    onPointerCancel={event => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                        setIsResizingBuilder(false);
                    }}
                    onLostPointerCapture={() => setIsResizingBuilder(false)}
                    onDoubleClick={() => setPreferredBuilderWidth(BUILDER_SPLIT_DEFAULT)}
                    onKeyDown={event => {
                        const step = event.shiftKey ? 40 : 16;
                        if (event.key === 'ArrowLeft') setPreferredBuilderWidth(clampBuilderSplit(builderWidth - step, workspaceWidth));
                        else if (event.key === 'ArrowRight') setPreferredBuilderWidth(clampBuilderSplit(builderWidth + step, workspaceWidth));
                        else if (event.key === 'Home') setPreferredBuilderWidth(BUILDER_SPLIT_MIN);
                        else if (event.key === 'End') setPreferredBuilderWidth(builderMaxWidth);
                        else return;
                        event.preventDefault();
                    }}
                >
                    <span className="qi-builder-splitter-grip" aria-hidden="true"><GripVertical className="h-4 w-4" /></span>
                </div>
            )}

            {/* â”€â”€â”€ TOOLBAR â”€â”€â”€ */}
            <div className="qi-builder-toolbar qi-builder-commandbar relative flex items-center gap-2 bg-white border-b border-slate-200 px-3 py-1.5 shrink-0 shadow-sm z-10">
                {/* Builder Toggle */}
                <button
                    onClick={() => setIsBuilderCollapsed(!isBuilderCollapsed)}
                    className="qi-cmd-icon"
                    aria-label={isBuilderCollapsed ? 'Show Builder' : 'Hide Builder'}
                    title={isBuilderCollapsed ? 'Show the question controls' : 'Hide the question controls for a bigger chart'}
                >
                    {isBuilderCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
                </button>

                <QuestionBuilderVideoGuide />

                <button
                    type="button"
                    onClick={handleUndo}
                    disabled={undoDepth === 0 || isLoading}
                    className="qi-cmd-button disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Undo last Question Builder change"
                    title={undoDepth > 0 ? `Undo last Question Builder change (${undoDepth} available) · Ctrl/Cmd+Z` : 'Nothing to undo yet'}
                >
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                    Undo
                    {undoDepth > 1 && <span className="rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums">{undoDepth}</span>}
                </button>

                {/* Time anchor stays visible in the top command bar. */}
                {isActive && ReactDOM.createPortal(
                    <div className="qi-time-anchor-bar flex items-center gap-2 shrink-0">
                    {dataset.timeContext?.dateColumnMaxDates && Object.keys(dataset.timeContext.dateColumnMaxDates).length > 1 && (
                        <Tooltip text="Choose which date column defines the analysis time anchor." position="bottom">
                            <div className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1 shadow-sm">
                                <span
                                    className="qi-anchor-label text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap"
                                >
                                    Date field
                                </span>
                                <QuerySelect
                                    value={anchorColumn || dataset.timeContext?.anchorDateColumn || ''}
                                    onChange={(newAnchor) => { if (newAnchor) handleAnchorColumnChange(newAnchor); }}
                                    options={Object.keys(dataset.timeContext.dateColumnMaxDates).map(col => ({
                                        label: col.replace(/_/g, ' '),
                                        value: col
                                    }))}
                                    colorTextClass="text-indigo-600"
                                    colorRingClass="focus:ring-indigo-500/30"
                                    searchable={false}
                                    className="!border-0 !bg-transparent !py-0.5 !pl-1 !pr-1.5"
                                />
                            </div>
                        </Tooltip>
                    )}
                    <Tooltip text="As of date — defines what “today” means for time queries." position="bottom">
                        <label className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 shadow-sm cursor-pointer hover:border-indigo-300 transition-colors">
                            <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                            <span
                                className="qi-anchor-label text-[11px] font-semibold uppercase tracking-wide"
                            >
                                As of
                            </span>
                            <input
                                type="date"
                                value={asOfDate}
                                onChange={(e) => handleAsOfDateChange(e.target.value)}
                                className="w-[110px] cursor-pointer border-0 bg-transparent p-0 text-xs font-bold text-slate-800 focus:ring-0"
                            />
                        </label>
                    </Tooltip>
                </div>,
                    document.body
                )}

                {/* Content Tabs */}
                {result && !error && (
                    <>
                        <div className="qi-builder-view-tabs qi-cmd-segmented flex items-center" role="group" aria-label="Result view">
                            {(['visual', 'sql', 'data'] as const).map(tab => (
                                <button
                                    key={tab}
                                    aria-pressed={contentTab === tab}
                                    onClick={() => setContentTab(tab)}
                                    className={`flex items-center gap-1 ${contentTab === tab ? 'is-active' : ''}`}
                                >
                                    {tab === 'visual' ? <><BarChart2 className="w-3 h-3" /> Visual</> :
                                        tab === 'sql' ? <><Code className="w-3 h-3" /> SQL</> :
                                            <><Table2 className="w-3 h-3" /> Data</>}
                                </button>
                            ))}
                        </div>
                    </>
                )}

                {/* Small Multiples Toggle */}
                {result && !error && contentTab === 'visual' && (() => {
                    if (!dimensionLayout?.facetKey) return null;
                    const isGridActive = dimensionLayout.useGrid;
                    return (
                        <>
                            <div className="qi-cmd-segmented flex items-center">
                                <button
                                    onClick={() => setForceGridMode('grid')}
                                    aria-pressed={isGridActive}
                                    className={`flex items-center gap-1 ${isGridActive ? 'is-active' : ''}`}
                                    title="Small Multiples Grid"
                                >
                                    <LayoutGrid className="w-3.5 h-3.5" />
                                    Grid
                                </button>
                                <button
                                    onClick={() => setForceGridMode('combined')}
                                    aria-pressed={!isGridActive}
                                    className={`flex items-center gap-1 ${!isGridActive ? 'is-active' : ''}`}
                                    title="Combined Chart"
                                >
                                    <Layers className="w-3.5 h-3.5" />
                                    Combined
                                </button>
                            </div>
                        </>
                    );
                })()}

                {result && !error && contentTab === 'visual' && dimensionLayout?.useGrid && formatting && onUpdateFormatting && (
                    <button
                        onClick={() => onUpdateFormatting(toggleDataLabels(formatting))}
                        className={`qi-cmd-button ${effectiveDataLabelMode(formatting) === 'all' ? 'is-active' : ''}`}
                        title={effectiveDataLabelMode(formatting) === 'all' ? 'Hide labels in every panel' : 'Show labels for all series in every panel'}
                    >Labels {effectiveDataLabelMode(formatting) === 'off' ? 'Off' : effectiveDataLabelMode(formatting) === 'all' ? 'All' : '1st'}</button>
                )}

                {/* X/Y Axis Toggles */}
                {result && !error && contentTab === 'visual' && formatting && onUpdateFormatting && (
                    <div className="qi-cmd-segmented flex items-center" role="group" aria-label="Axes">
                        <span className="qi-cmd-caption">Axes</span>
                        <button
                            onClick={() => onUpdateFormatting({ ...formatting, showXAxis: !(formatting.showXAxis ?? formatting.showAxis ?? false) })}
                            aria-pressed={Boolean(formatting.showXAxis ?? formatting.showAxis ?? false)}
                            className={(formatting.showXAxis ?? formatting.showAxis ?? false) ? 'is-active' : ''}
                            title="Toggle X-Axis visibility"
                        >X</button>
                        <button
                            onClick={() => onUpdateFormatting({ ...formatting, showYAxis: !(formatting.showYAxis ?? formatting.showAxis ?? false) })}
                            aria-pressed={Boolean(formatting.showYAxis ?? formatting.showAxis ?? false)}
                            className={(formatting.showYAxis ?? formatting.showAxis ?? false) ? 'is-active' : ''}
                            title="Toggle Y-Axis visibility"
                        >Y</button>
                    </div>
                )}

                {/* Compact KPI + Actions */}
                {result && !error && (
                    <div className="qi-builder-actions-toolbar flex flex-wrap items-center gap-1.5 min-w-0 ml-auto">
                        {/* Actions stay beside the workspace tabs; the redundant summary now lives in the result view. */}
                        {/* Export */}
                        <button onClick={exportToCSV} className="qi-cmd-icon" aria-label="Export CSV" title="Export the result as CSV">
                            <Download className="w-4 h-4" />
                        </button>

                        {/* Cancel Edit button — only in edit mode */}
                        {editingItemId && onCancelEdit && (
                            <button onClick={onCancelEdit} className="qi-cmd-button" title="Cancel editing and return to Dashboard">
                                <X className="w-4 h-4" /> Cancel
                            </button>
                        )}
                        {(onPin || (editingItemId && onSaveBackToDashboard)) && (
                            <button onClick={() => {
                                const firstCol = tableData.columns[0];
                                let pinResult: AnalysisResult;
                                let pinTitle: string;
                                if (showGrowthChart && firstCol) {
                                    // Pin the CALCULATED view (e.g., % of Total pie chart)
                                    const calcColumnKeys = new Set([result.xKey, ...tableData.columns.map(c => c.key)]);
                                    const calcCleanData = tableData.data.map((d: any) => {
                                        const clean: any = {};
                                        for (const k of Object.keys(d)) {
                                            if (calcColumnKeys.has(k) || typeof d[k] !== 'number') {
                                                clean[k] = d[k];
                                            }
                                        }
                                        return clean;
                                    });
                                    const calcChartType = firstCol.calculation === 'percent_of_total' ? 'pie' : chartType;
                                    const calcFormatting = { ...formatting, tableCalculations: [], numberFormat: (firstCol.format || formatting?.numberFormat), showDataLabels: true } as any;
                                    pinTitle = firstCol.label || result.yLabel;
                                    pinResult = {
                                        ...result,
                                        data: calcCleanData,
                                        yKey: firstCol.key,
                                        yLabel: firstCol.label,
                                        vis: calcChartType,
                                        visualizationMode: forceGridMode,
                                        formatting: calcFormatting,
                                        config: lastRunConfig ? { ...lastRunConfig, comparison: 'none' } : undefined,
                                        queryConfig: lastRunConfig ? { ...lastRunConfig, comparison: 'none' } : undefined,
                                    };
                                } else {
                                    // Pin the ORIGINAL view — preserve config (comparison, filters, etc.)
                                    pinTitle = result.yLabel;
                                    pinResult = {
                                        ...result,
                                        vis: chartType,
                                        visualizationMode: forceGridMode,
                                        formatting: { ...formatting, tableCalculations: [] } as any,
                                        config: lastRunConfig || undefined,
                                        queryConfig: lastRunConfig || undefined,
                                    };
                                }
                                // Edit mode: save back to dashboard (UPDATE existing item)
                                if (editingItemId && onSaveBackToDashboard) {
                                    onSaveBackToDashboard({ ...pinResult, insight: pinTitle });
                                } else if (onPin) {
                                    // Normal mode: pin as new item
                                    onPin(pinTitle, pinResult);
                                }
                            }} className={`qi-cmd-primary flex items-center whitespace-nowrap ${editingItemId ? 'is-edit' : ''}`} title={editingItemId ? 'Save changes back to Dashboard' : showGrowthChart && tableData.columns.length > 0 ? 'Pin Calculated View to Dashboard' : 'Pin to Dashboard'}>
                                <Pin className="w-4 h-4 mr-1" /> {editingItemId ? 'Save to Dashboard' : showGrowthChart && tableData.columns.length > 0 ? 'Pin Calculated' : 'Pin'}
                            </button>
                        )}
                        <button
                            onClick={async () => {
                                if (!lastRunConfig) return;
                                // If live mode, refresh the dataset — the useEffect on dataset.version
                                // will automatically re-run the analysis once the worker completes
                                if (dataset.connectionMode === 'live' && onLiveRefresh) {
                                    await onLiveRefresh();
                                    return; // Don't call handleRun here — wait for dataset.version change
                                }
                                // Import mode: just re-run with current data
                                handleRun(lastRunConfig, { recordHistory: false });
                            }}
                            disabled={isLiveRefreshing}
                            aria-label={isLiveRefreshing ? 'Refreshing' : 'Refresh'}
                            className={`qi-cmd-icon ${dataset.connectionMode === 'live' ? 'is-live' : ''}`}
                            title={dataset.connectionMode === 'live'
                                ? 'Refresh — fetch latest data from live database & re-run query'
                                : 'Refresh — re-run current query'
                            }
                        >
                            {isLiveRefreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        </button>
                        {dataset.connectionMode === 'live' && onScheduleChange && (
                            <RefreshSchedulerDropdown
                                schedule={refreshSchedule}
                                onScheduleChange={onScheduleChange}
                                isRefreshing={isLiveRefreshing || false}
                            />
                        )}
                        <button
                            onClick={handleReset}
                            className="qi-cmd-icon is-danger"
                            aria-label="Reset"
                            title="Reset — clear all results and start fresh"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>

            {/* â”€â”€â”€ CONTENT AREA â€” Tabbed â”€â”€â”€ */}
            <div id="qi-builder-result-pane" className="qi-builder-content flex-1 flex flex-col overflow-auto p-4">

                {error && (
                    <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg mb-4 flex items-start">
                        <AlertTriangle className="w-5 h-5 mr-3 mt-0.5 shrink-0" />
                        <div>
                            <h4 className="font-bold">Analysis Failed</h4>
                            <p className="text-sm mt-1">{error}</p>
                        </div>
                    </div>
                )}

                {isLoading && (
                    <div className="space-y-6 max-w-7xl mx-auto animate-pulse">
                        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-3">
                            <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
                            <span className="text-sm font-medium text-slate-600">Running analysis...</span>
                        </div>
                        <div className="bg-white rounded-xl border border-slate-200 shadow-sm h-[500px] flex items-center justify-center">
                            <div className="space-y-4 w-3/4">
                                <div className="h-4 bg-slate-200 rounded w-1/3 mx-auto" />
                                <div className="flex items-end gap-2 justify-center h-48">
                                    {[40, 70, 55, 85, 65, 90, 45, 75].map((h, i) => (
                                        <div key={i} className="bg-slate-200 rounded-t w-10" style={{ height: `${h}%` }} />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {!result && !error && !isLoading && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400">
                        <Play className="w-12 h-12 mb-4 opacity-20" />
                        <p className="text-lg font-medium">Build your question on the left to see results</p>
                        <p className="text-sm mt-1 text-slate-300">Press <kbd className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-xs font-mono border border-slate-200">Ctrl+Enter</kbd> to run</p>


                    </div>
                )}

                {result && !error && !isLoading && (
                    <>
                        <section className="qi-builder-answer qi-builder-headline mb-2 shrink-0" aria-label="Your answer in words" aria-live="polite">
                            <h2 className="qi-builder-headline-title">{headlineQuestion(describeBuilderQuestion({ ...(lastRunConfig || result.config), aggregation: result.config?.aggregation || lastRunConfig?.aggregation }))}</h2>
                            {result.notices?.map(notice => (
                                <p key={notice} className="qi-builder-headline-notice">{notice}</p>
                            ))}
                            {describeBuilderFinding(result, formatting) && (
                                <p className="qi-builder-headline-finding">{describeBuilderFinding(result, formatting)}</p>
                            )}
                            {quickStarts.length > 0 && (
                                <div className="qi-builder-quickstarts" role="group" aria-label="Try a breakdown">
                                    <Sparkles className="w-3.5 h-3.5" aria-hidden />
                                    <span>Try</span>
                                    {quickStarts.map(option => (
                                        <button key={option.value} type="button" className="qi-quickstart" onClick={() => runQuickStart(option.value)}>{option.label}</button>
                                    ))}
                                </div>
                            )}
                        </section>
                        {/* â”€â”€â”€ VISUAL TAB â”€â”€â”€ */}
                        {contentTab === 'visual' && (
                          <>
                            {trailVisible && drillTrail ? (
                                <nav className="qi-crumbs mb-2 flex flex-wrap items-center gap-1 text-[12.5px]" aria-label="How you got here">
                                    {drillTrail.levels.map((level, index) => (
                                        <React.Fragment key={index}>
                                            <button type="button" className="qi-crumb rounded px-1 py-0.5 font-medium" onClick={() => goToTrailLevel(index)} title="Go back to this view">{level.label}</button>
                                            <span aria-hidden>›</span>
                                        </React.Fragment>
                                    ))}
                                    <span className="qi-crumb is-current px-1 py-0.5" aria-current="page">{drillTrail.current}</span>
                                </nav>
                            ) : (result.data?.length || 0) > 1 && !['kpiCard', 'gauge', 'waterfall'].includes(chartType) && (
                                <p className="qi-explore-hint-line mb-2 text-[12px]">Click a {['line', 'area', 'curvedLine', 'steppedLine', 'stackedArea', 'scatter'].includes(chartType) ? 'point' : ['pie', 'doughnut', 'polarArea'].includes(chartType) ? 'slice' : chartType === 'map' ? 'region' : chartType === 'treemap' ? 'tile' : 'bar'} to filter it, break it down or see its rows.</p>
                            )}
                            <div className={`qi-visual-stage ${isFormatPanelOpen || isAnalyticsPanelOpen ? 'qi-visual-stage--inspector-open' : ''} relative bg-white flex-1 min-h-[350px] rounded-xl border border-slate-200 shadow-sm overflow-visible`}>
                                {/* Growth toggle */}
                                {tableData.columns.length > 0 && (
                                    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex bg-slate-100 rounded-lg p-0.5 border border-slate-200 shadow-sm">
                                        <button onClick={() => setShowGrowthChart(false)} className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-md transition-all ${!showGrowthChart ? 'bg-white text-indigo-700 shadow-sm border border-indigo-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                                            <BarChart3 className="w-3.5 h-3.5" /> Original
                                        </button>
                                        <button onClick={() => setShowGrowthChart(true)} className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold rounded-md transition-all ${showGrowthChart ? 'bg-white text-emerald-700 shadow-sm border border-emerald-200' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                                            <TrendingUp className="w-3.5 h-3.5" /> Calculated
                                        </button>
                                    </div>
                                )}

                                {(() => {
                                    const firstCol = tableData.columns[0];
                                    if (firstCol && showGrowthChart) {
                                        // tableData.data is already clean (comparison fields stripped in useMemo above)
                                        // Also strip the original metric column (e.g. 'sales') so ChartVisualization
                                        // doesn't auto-detect it as a secondary series and render a ghost line chart
                                        const calcColumnKeys = new Set([result.xKey, ...tableData.columns.map(c => c.key)]);
                                        const calcCleanData = tableData.data.map((d: any) => {
                                            const clean: any = {};
                                            for (const k of Object.keys(d)) {
                                                if (calcColumnKeys.has(k) || typeof d[k] !== 'number') {
                                                    clean[k] = d[k];
                                                }
                                            }
                                            return clean;
                                        });
                                        const calcConfig = result.config ? { ...result.config, comparison: 'none' as const } : undefined;
                                        const calcLayout = resolveDimensionVisualization(
                                            calcCleanData, result.xKey, firstCol.key, result.config, forceGridMode,
                                        );
                                        if (calcLayout.useGrid && calcLayout.facetKey) {
                                            return (
                                                <SmallMultiplesGrid
                                                    data={calcLayout.rows}
                                                    config={calcConfig}
                                                    xKey={result.xKey}
                                                    yKey={firstCol.key}
                                                    yLabel={firstCol.label}
                                                    splitKey={calcLayout.facetKey}
                                                    seriesKey={calcLayout.seriesKey}
                                                    chartType={firstCol.calculation === 'percent_of_total' ? 'bar' : chartType}
                                                    formatting={{ ...formatting, tableCalculations: [], numberFormat: (firstCol.format || formatting?.numberFormat) as FormattingConfig['numberFormat'] }}
                                                />
                                            );
                                        }
                                        return (
                                            <ChartVisualization
                                                key={`growth-${firstCol.key}`}
                                                data={calcLayout.rows}
                                                config={calcConfig}
                                                xKey={result.xKey}
                                                yKey={firstCol.key}
                                                yLabel={firstCol.label}
                                                chartType={firstCol.calculation === 'percent_of_total' ? 'pie' : chartType}
                                                seriesKey={calcLayout.seriesKey}
                                                disableAutoSeries={calcLayout.groupedDimensions.length > 1 && !calcLayout.seriesKey}
                                                onChartTypeChange={chooseChartType}
                                                formatting={{ ...formatting, tableCalculations: [], numberFormat: (firstCol.format || formatting?.numberFormat) as FormattingConfig['numberFormat'], showDataLabels: true }}
                                                onToggleFormat={onUpdateFormatting ? () => setIsFormatPanelOpen(!isFormatPanelOpen) : undefined}
                                                isFormatOpen={isFormatPanelOpen}
                                                onToggleAnalytics={onUpdateFormatting ? () => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen) : undefined}
                                                isAnalyticsOpen={isAnalyticsPanelOpen}
                                                onToggleLabels={undefined}
                                                onPointSelect={handlePointSelect}
                                                onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                                isAIInsightOpen={isAIInsightOpen}
                                                chartContainerRef={chartContainerRef}
                                            />
                                        );
                                    }
                                    if (dimensionLayout?.useGrid && dimensionLayout.facetKey) {
                                        return (
                                            <SmallMultiplesGrid
                                                data={dimensionLayout.rows}
                                                xKey={result.xKey}
                                                yKey={result.yKey}
                                                yLabel={result.yLabel}
                                                splitKey={dimensionLayout.facetKey}
                                                seriesKey={dimensionLayout.seriesKey}
                                                chartType={chartType}
                                                onPointSelect={handlePointSelect}
                                                formatting={{ ...formatting, tableCalculations: [] }}
                                                config={result.config}
                                            />
                                        );
                                    }

                                    return (
                                        <ChartVisualization
                                            key={`result-${result.xKey}-${result.yKey}-${chartType}`}
                                            data={dimensionLayout?.rows || result.data}
                                            config={result.config}
                                            xKey={result.xKey}
                                            yKey={result.yKey}
                                            yLabel={result.yLabel}
                                            chartType={chartType}
                                            seriesKey={dimensionLayout?.seriesKey}
                                            disableAutoSeries={!!dimensionLayout && dimensionLayout.groupedDimensions.length > 1 && !dimensionLayout.seriesKey}
                                            onChartTypeChange={chooseChartType}
                                            formatting={{ ...formatting, tableCalculations: [] }}
                                            onToggleFormat={onUpdateFormatting ? () => setIsFormatPanelOpen(!isFormatPanelOpen) : undefined}
                                            isFormatOpen={isFormatPanelOpen}
                                            onToggleAnalytics={onUpdateFormatting ? () => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen) : undefined}
                                            isAnalyticsOpen={isAnalyticsPanelOpen}
                                            onToggleLabels={onUpdateFormatting && formatting ? () => {
                                              onUpdateFormatting(toggleDataLabels(formatting));
                                            } : undefined}
                                            onPointSelect={handlePointSelect}
                                            onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)}
                                            isAIInsightOpen={isAIInsightOpen}
                                            chartContainerRef={chartContainerRef}
                                        />
                                    );
                                })()}

                                {/* AI Insight Panel */}
                                <AIInsightPanel isOpen={isAIInsightOpen} onClose={() => setIsAIInsightOpen(false)} chartContainerRef={chartContainerRef} chartTitle={result?.yLabel} chartContext={{ chartType: result?.vis, xKey: result?.xKey, yKey: result?.yKey, comparisonMode: (result?.config as any)?.comparison || undefined }} />

                                {isFormatPanelOpen && formatting && onUpdateFormatting && (
                                    <FormatPanel
                                        formatting={formatting}
                                        onUpdateFormatting={onUpdateFormatting}
                                        onClose={() => setIsFormatPanelOpen(false)}
                                        chartType={result?.vis}
                                    />
                                )}

                                {/* FLOATING ANALYTICS PANEL */}
                                {isAnalyticsPanelOpen && formatting && onUpdateFormatting && (
                                    <div className="qi-analytics-panel absolute top-4 right-4 w-80 max-h-[calc(100%-2rem)] overflow-y-auto bg-white shadow-2xl border border-emerald-200 rounded-xl p-5 z-[80] animate-in fade-in slide-in-from-right-4 ring-1 ring-black/5">
                                        <div className="flex justify-between items-center mb-4 pb-3 border-b border-emerald-100">
                                            <h3 className="font-bold text-slate-800 flex items-center gap-2"><Activity className="w-5 h-5 text-emerald-600" /> Analytics</h3>
                                            <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5" /></button>
                                        </div>
                                        <div className="space-y-4">
                                            <div className="pb-4 border-b border-emerald-100">
                                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Period Comparison</label>
                                                <div className="space-y-1.5">
                                                    {/* None */}
                                                    <label className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all border ${!result?.config?.comparison || result?.config?.comparison === 'none' ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'}`}>
                                                        <input type="radio" name="builder-comparison" checked={!result?.config?.comparison || result?.config?.comparison === 'none'} onChange={() => { if (result) handleRun({ ...result.config, comparison: 'none' as any }); }} className="text-emerald-600" />
                                                        <div>
                                                            <span className="text-sm font-bold text-slate-700">Single Period</span>
                                                            <span className="text-[11px] text-slate-500 block leading-tight">No comparison</span>
                                                        </div>
                                                    </label>
                                                    {/* Previous Period */}
                                                    <label className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all border ${result?.config?.comparison === 'previous_period' ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'}`}>
                                                        <input type="radio" name="builder-comparison" checked={result?.config?.comparison === 'previous_period'} onChange={() => { if (result) handleRun({ ...result.config, comparison: 'previous_period' as any }); }} className="text-emerald-600" />
                                                        <div>
                                                            <span className="text-sm font-bold text-slate-700">Previous Period</span>
                                                            <span className="text-[11px] text-slate-500 block leading-tight">Compare with preceding period</span>
                                                        </div>
                                                    </label>
                                                    {/* Same Period Last N (replaces static Same Period Last Year) */}
                                                    <label className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all border ${result?.config?.comparison === 'same_period_last_n' ? 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-slate-50 border-transparent hover:border-slate-200'}`}>
                                                        <input type="radio" name="builder-comparison" checked={result?.config?.comparison === 'same_period_last_n'} onChange={() => { if (result) handleRun({ ...result.config, comparison: 'same_period_last_n' as any, comparisonGrain: result.config.comparisonGrain || 'year', comparisonOffset: result.config.comparisonOffset || 1 }); }} className="text-emerald-600" />
                                                        <div>
                                                            <span className="text-sm font-bold text-slate-700">Same Period Last N</span>
                                                            <span className="text-[11px] text-slate-500 block leading-tight">Flexible: pick the period &amp; how far back (D/W/M/Q/Y)</span>
                                                        </div>
                                                    </label>
                                                    {/* Grain + Offset controls (only when Same Period Last N is active) */}
                                                    {result?.config?.comparison === 'same_period_last_n' && (
                                                        <div className="ml-7 mt-2 p-3 bg-emerald-50/60 rounded-lg border border-emerald-200 space-y-3">
                                                            {/* Grain selector pills */}
                                                            <div>
                                                                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide block mb-1.5">Period</span>
                                                                <div className="flex gap-1">
                                                                    {(['day', 'week', 'month', 'quarter', 'year'] as const).map(g => {
                                                                        const labels: Record<string, string> = { day: 'D', week: 'W', month: 'M', quarter: 'Q', year: 'Y' };
                                                                        const active = (result.config.comparisonGrain || 'month') === g;
                                                                        return (
                                                                            <button key={g} onClick={() => handleRun({ ...result.config, comparisonGrain: g })}
                                                                                className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all ${active ? 'bg-emerald-600 text-white shadow-sm' : 'bg-white text-slate-600 border border-slate-200 hover:border-emerald-400 hover:text-emerald-700'}`}>
                                                                                {labels[g]}
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                            {/* Offset stepper */}
                                                            <div>
                                                                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide block mb-1.5">Offset</span>
                                                                <div className="flex items-center gap-2">
                                                                    <button onClick={() => { const n = Math.max(1, (result.config.comparisonOffset || 1) - 1); handleRun({ ...result.config, comparisonOffset: n }); }}
                                                                        className="w-7 h-7 flex items-center justify-center rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-emerald-50 hover:border-emerald-400 hover:text-emerald-700 font-bold text-sm transition-all">−</button>
                                                                    <span className="w-8 text-center text-sm font-bold text-emerald-800">{result.config.comparisonOffset || 1}</span>
                                                                    <button onClick={() => { const n = Math.min(24, (result.config.comparisonOffset || 1) + 1); handleRun({ ...result.config, comparisonOffset: n }); }}
                                                                        className="w-7 h-7 flex items-center justify-center rounded-md bg-white border border-slate-200 text-slate-600 hover:bg-emerald-50 hover:border-emerald-400 hover:text-emerald-700 font-bold text-sm transition-all">+</button>
                                                                </div>
                                                                <span className="text-[11px] text-emerald-700 mt-1.5 block font-medium">
                                                                    vs {result.config.comparisonOffset || 1} {(result.config.comparisonGrain || 'month') + ((result.config.comparisonOffset || 1) > 1 ? 's' : '')} ago
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Table Calculation</label>
                                                <div className="space-y-1 max-h-[300px] overflow-y-auto pr-2">
                                                    {(['percent_of_total', 'rank_desc', 'rank_asc', 'running_total', 'moving_avg', 'pct_diff_from_prev', 'diff_from_prev', 'percentile'] as TableCalculation[]).map(calc => {
                                                        const isSelected = (formatting.tableCalculations || []).includes(calc);
                                                        return (
                                                            <label key={calc} className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? 'bg-emerald-100 border border-emerald-500 ring-1 ring-emerald-500 shadow-sm' : 'hover:bg-slate-50 border border-transparent hover:border-slate-200'}`}>
                                                                <div className="relative flex items-center shrink-0">
                                                                    <input type="checkbox" checked={isSelected} onChange={() => handleTableCalculationToggle(calc, isSelected)} className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-400 checked:border-emerald-700 checked:bg-emerald-600 transition-all" />
                                                                    <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 peer-checked:opacity-100 transition-opacity"><svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg></div>
                                                                </div>
                                                                <span className={`text-sm ${isSelected ? 'font-bold text-emerald-900' : 'text-slate-700 font-medium'}`}>{getCalculationDisplayName(calc)}</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                                {(['pct_diff_from_prev', 'diff_from_prev'] as TableCalculation[]).some(calc => (formatting.tableCalculations || []).includes(calc)) && (
                                                    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                                                        <label className="block text-[11px] font-bold uppercase tracking-wider text-emerald-700">Comparison baseline</label>
                                                        <select
                                                            value={formatting.tableCalculationComparison?.mode || 'previous'}
                                                            onChange={e => {
                                                                const mode = e.target.value as 'previous' | 'selected_value';
                                                                const values = Array.from(new Set((result.data || []).map((row: any) => String(row[result.xKey] ?? '')).filter(Boolean)));
                                                                const currentReference = formatting.tableCalculationComparison?.referenceValue;
                                                                const referenceValue = values.includes(currentReference || '') ? currentReference : values[0];
                                                                onUpdateFormatting({
                                                                    ...formatting,
                                                                    tableCalculationComparison: mode === 'selected_value'
                                                                        ? { mode, referenceValue }
                                                                        : { mode },
                                                                });
                                                            }}
                                                            className="w-full rounded-md border border-emerald-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                                                            style={{ colorScheme: 'light' }}
                                                        >
                                                            <option value="previous" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>Previous row (current chart order)</option>
                                                            <option value="selected_value" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>Selected {result.xKey} value</option>
                                                        </select>
                                                        {(formatting.tableCalculationComparison?.mode || 'previous') === 'selected_value' && (
                                                            <select
                                                                value={formatting.tableCalculationComparison?.referenceValue || String(result.data?.[0]?.[result.xKey] ?? '')}
                                                                onChange={e => onUpdateFormatting({
                                                                    ...formatting,
                                                                    tableCalculationComparison: { mode: 'selected_value', referenceValue: e.target.value },
                                                                })}
                                                                className="w-full rounded-md border border-emerald-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-900 outline-none focus:ring-2 focus:ring-emerald-500"
                                                            style={{ colorScheme: 'light' }}
                                                                aria-label={`Compare every value with a selected ${result.xKey}`}
                                                            >
                                                                {Array.from(new Set((result.data || []).map((row: any) => String(row[result.xKey] ?? '')).filter(Boolean))).map(value => (
                                                                    <option key={value} value={value} style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>{value}</option>
                                                                ))}
                                                            </select>
                                                        )}
                                                        <p className="text-[11px] leading-relaxed text-emerald-700">
                                                            {(formatting.tableCalculationComparison?.mode || 'previous') === 'selected_value'
                                                                ? 'Every visible value is compared with the selected baseline.'
                                                                : 'Each value is compared with the previous visible row, using the current chart order.'}
                                                        </p>
                                                    </div>
                                                )}
                                                {(formatting.tableCalculations || []).length > 0 && (
                                                    <div className="mt-2 flex items-center gap-3">
                                                        <button onClick={() => { setShowGrowthChart(true); setIsAnalyticsExplorer(true); }} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer">Open Analytics Explorer →</button>
                                                        <button onClick={() => onUpdateFormatting({ ...formatting, tableCalculations: [] })} className="text-[11px] text-slate-400 hover:text-red-500 transition-colors cursor-pointer">Clear all calculations</button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <TransparencyPanel result={result} datasetName={dataset.name} />
                          </>
                        )}

                        {/* â”€â”€â”€ SQL TAB â”€â”€â”€ */}
                        {contentTab === 'sql' && (
                            <div className="space-y-4">
                                <div className="bg-gray-100 dark:bg-slate-900 rounded-xl p-4 shadow-inner overflow-hidden relative">
                                    <div className="absolute top-2 right-2 text-[11px] text-gray-500 dark:text-slate-500 font-mono uppercase flex items-center bg-gray-200 dark:bg-slate-800 px-2 py-1 rounded"><Code className="w-3 h-3 mr-1" /> Generated SQL</div>
                                    <pre className="text-sm text-green-400 font-mono overflow-auto whitespace-pre-wrap p-2 min-h-[200px]">{showGrowthChart && result.calculatedSql ? result.calculatedSql : result.sql}</pre>
                                </div>
                                <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Query Config</h4>
                                    <pre className="text-xs text-slate-600 font-mono whitespace-pre-wrap">{JSON.stringify(result.config, null, 2)}</pre>
                                </div>
                            </div>
                        )}

                        {/* â”€â”€â”€ DATA TAB â”€â”€â”€ */}
                        {contentTab === 'data' && (
                            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                                <div className="overflow-auto max-h-[calc(100vh-200px)]">
                                    <table className="min-w-full divide-y divide-slate-200">
                                        <thead className="bg-slate-50 sticky top-0 z-10">
                                            <tr>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{result.xKey.replace(/_/g, ' ')}</th>
                                                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">{result.yKey.replace(/_/g, ' ')}</th>
                                                {tableData.columns.map(col => (
                                                    <th key={col.key} className="px-6 py-3 text-right text-xs font-bold text-emerald-600 uppercase tracking-wider bg-emerald-50/50 border-l border-emerald-100">{col.label}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-slate-200">
                                            {tableData.data.map((row, i) => (
                                                <tr key={i} className="hover:bg-indigo-50/30 transition-colors">
                                                    <td className="px-6 py-3 text-sm font-medium text-slate-900 whitespace-nowrap">{String(row[result.xKey])}</td>
                                                    <td className="px-6 py-3 text-sm text-slate-600 text-right whitespace-nowrap font-mono">{Number(row[result.yKey]).toLocaleString(undefined, { maximumFractionDigits: formatting?.decimals ?? 2 })}</td>
                                                    {tableData.columns.map(col => {
                                                        const val = Number(row[col.key]) || 0;
                                                        const isNeg = val < 0;
                                                        const isZero = val === 0;
                                                        const colorClass = isZero ? 'text-slate-500 bg-slate-50/30' : isNeg ? 'text-red-600 bg-red-50/40' : 'text-emerald-600 bg-emerald-50/40';
                                                        return (
                                                            <td key={col.key} className={`px-6 py-3 text-sm font-bold text-right whitespace-nowrap font-mono border-l border-emerald-100 ${colorClass}`}>
                                                                {col.format === 'percent' ? val.toFixed(formatting?.decimals ?? 2) + '%' : val.toLocaleString(undefined, { maximumFractionDigits: formatting?.decimals ?? 2 })}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
            {exploreMenu}
            {rowsView && (
                <UnderlyingRowsDrawer
                    title={rowsView.title}
                    conditions={rowsView.conditions}
                    rows={rowsView.rows}
                    columns={dataset.columns.map(c => c.name)}
                    fileName={rowsView.title}
                    onClose={() => setRowsView(null)}
                />
            )}
        </div>
    );
};

