import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Pin, Code, Table2, BarChart2, Palette, Activity, Sparkles,
  Copy, Check, X, RefreshCw, Play, Database, Loader2, Microscope,
  MessageSquare, Send, MousePointerClick, ChevronDown, ListChecks
} from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { ChartVisualization } from './ChartVisualization';
import { DimensionResultView } from './DimensionResultView';
import { FormatPanel } from './FormatPanel';
import { AIInsightPanel } from './AIInsightPanel';
import { getCalculationDisplayName, type TableCalculation } from '../utils/tableCalculations';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { useTheme } from './ThemeProvider';
import TrustBadge from './TrustBadge';
import { PipelineReport } from './PipelineReport';
import { isDimensionOnlyResult } from '../services/ai-sql/resultPresentation';
import { TraceStoryPanel } from './TraceStoryPanel';

interface VisualPreviewViewProps {
  dataset: Dataset | null;
  result: AnalysisResult;
  pipelineResult?: AISQLPipelineResult | null;
  query: string;
  formatting: FormattingConfig;
  onBack: () => void;
  onPin?: (title: string, result: AnalysisResult) => void;
  onFormatChange?: (formatting: FormattingConfig) => void;
}

interface DrillDownResult {
  query: string;
  result: AnalysisResult;
  pipeline: AISQLPipelineResult;
}

export const VisualPreviewView: React.FC<VisualPreviewViewProps> = ({
  dataset, result: initialResult, pipelineResult: initialPipeline, query,
  formatting, onBack, onPin, onFormatChange,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'chart' | 'table' | 'sql'>(() =>
    isDimensionOnlyResult(initialPipeline?.profile, initialPipeline?.rawData?.length ? initialPipeline.rawData : initialResult.data)
      ? 'chart'
      : initialPipeline?.chart?.chartType === 'table' ? 'table' : 'chart'
  );
  const [workspaceMode, setWorkspaceMode] = useState<'result' | 'details'>('result');
  const [detailsSection, setDetailsSection] = useState<'overview' | 'workspace' | 'trace'>('overview');
  const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
  const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
  const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
  const [copiedSQL, setCopiedSQL] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [showConfidence, setShowConfidence] = useState(false);
  const [showPipelineReport, setShowPipelineReport] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartType, setChartType] = useState<string>(
    initialPipeline?.chart?.chartType === 'table'
      ? 'horizontalBar'
      : ((initialResult.vis as string) || 'bar')
  );
  const [localFormatting, setLocalFormatting] = useState<FormattingConfig>(formatting);
  const [result, setResult] = useState<AnalysisResult>(initialResult);
  const [pipeline, setPipeline] = useState<AISQLPipelineResult | null | undefined>(initialPipeline);
  const [isReloading, setIsReloading] = useState(false);
  const [timeGrain, setTimeGrain] = useState<'day'|'week'|'month'|'quarter'|'year'>('month');

  // ── Feature 1: Click-to-Drill-Down ──
  const [drillDown, setDrillDown] = useState<DrillDownResult | null>(null);
  const [isDrilling, setIsDrilling] = useState(false);

  // ── Ask another question (standalone — no memory of the previous one) ──
  const [followUpQuery, setFollowUpQuery] = useState('');
  const [isFollowUpLoading, setIsFollowUpLoading] = useState(false);
  const followUpRef = useRef<HTMLInputElement>(null);

  // ── Sync internal state when new query results arrive ──
  // useState only uses initialValue on FIRST mount. Since this component
  // stays mounted (hidden with CSS), we need useEffect to update state
  // when the parent passes new props from a subsequent AI SQL query.
  useEffect(() => {
    setResult(initialResult);
    const recommendedTable = initialPipeline?.chart?.chartType === 'table';
    const dimensionOnly = isDimensionOnlyResult(initialPipeline?.profile, initialPipeline?.rawData?.length ? initialPipeline.rawData : initialResult.data);
    setChartType(recommendedTable ? 'horizontalBar' : ((initialResult.vis as string) || 'bar'));
    setActiveTab(dimensionOnly ? 'chart' : recommendedTable ? 'table' : 'chart');
    setWorkspaceMode('result');
    setDetailsSection('overview');
  }, [initialResult, initialPipeline]);

  useEffect(() => {
    setPipeline(initialPipeline);
  }, [initialPipeline]);

  useEffect(() => {
    setLocalFormatting(formatting);
  }, [formatting]);

  const activeResult = drillDown?.result || result;
  const activePipeline = drillDown?.pipeline || pipeline;
  // The chart may use reshaped/pivoted rows, but the Table tab is evidence of
  // the SQL result and must retain every column DuckDB returned.
  const activeTableData = activePipeline?.rawData?.length
    ? activePipeline.rawData
    : activeResult.data;
  const activeDimensionOnly = isDimensionOnlyResult(activePipeline?.profile, activeTableData);
  useEffect(() => {
    if (!activeDimensionOnly) return;
    setIsFormatPanelOpen(false);
    setIsAnalyticsPanelOpen(false);
    setIsAIInsightOpen(false);
  }, [activeDimensionOnly]);
  const activeQuery = drillDown?.query || query;
  const sql = activeResult.sql || activePipeline?.sql || '';
  const explanation = activeResult.insight || activePipeline?.explanation || '';
  const sqlEngine = activePipeline?.engine;
  const provenance = activePipeline?.provenance;
  const isLocalAnswer = provenance?.strategy === 'deterministic';
  const provenanceLabel = isLocalAnswer
    ? 'Local analytics'
    : provenance?.model
      ? `AI fallback · ${provenance.model.replace('openai/', '').toUpperCase()}`
      : provenance ? 'AI fallback' : null;
  const provenanceClass = isLocalAnswer
    ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    : 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300';
  const engineBadge = sqlEngine === 'question-builder'
    ? { label: 'Question Builder', cls: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' }
    : sqlEngine === 'llm-sql'
      ? { label: 'AI SQL', cls: 'bg-violet-100 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300' }
      : sqlEngine === 'correction-engine'
        ? { label: 'Correction Engine', cls: 'bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300' }
        : sqlEngine === 'llm'
          ? { label: 'LLM', cls: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' }
          : null;

  // ── Drill-Down Handler ──
  const handleDrillDown = useCallback(async (dimensionValue: string) => {
    if (!dataset || isDrilling) return;
    setIsDrilling(true);
    const drillQuery = `Show breakdown of ${pipeline?.plan?.metrics?.[0]?.field || 'sales'} for "${dimensionValue}"`;
    try {
      const res = await runAISQLPipeline(drillQuery, dataset);
      if (res.rawData.length === 0) { setIsDrilling(false); return; }
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'horizontalBar' };
      setDrillDown({
        query: drillQuery,
        pipeline: res,
        result: {
          data: res.chartData, xKey: res.chart.xKey, yKey: res.chart.yKey, yLabel: drillQuery,
          insight: res.explanation, sql: res.sql,
          config: { metric: res.plan.metrics[0]?.field || res.chart.yKey, dimension: res.plan.dimensions[0]?.field || res.chart.xKey, aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, questionId: 'drill_' + Date.now(), questionLabel: drillQuery, secondaryMetrics: res.chart.secondaryYKeys, axisMode: res.chart.useDualAxis ? 'dual' : 'auto', limit: res.plan.limit || 0, sort: res.plan.sort?.[0]?.dir || 'desc' },
          vis: (chartMap[res.chart.chartType] || 'bar') as any,
          kpi: res.chart.chartType === 'kpiCard' && res.chartData.length > 0 ? res.chartData[0][res.chart.yKey] : undefined,
          growth: res.chart.growth ? { diff: res.chart.growth.diff, pct: res.chart.growth.pct } : undefined,
          secondaryYKeys: res.chart.secondaryYKeys,
        },
      });
      setActiveTab(isDimensionOnlyResult(res.profile, res.rawData) ? 'chart' : res.chart.chartType === 'table' ? 'table' : 'chart');
    } catch { /* ignore */ } finally { setIsDrilling(false); }
  }, [dataset, isDrilling, pipeline, query]);

  // ── Ask-Another-Question Handler (standalone) ──
  const handleFollowUp = useCallback(async () => {
    if (!dataset || !followUpQuery.trim() || isFollowUpLoading) return;
    setIsFollowUpLoading(true);
    const q = followUpQuery.trim();
    setFollowUpQuery('');
    try {
      // Standalone: a follow-up is treated as a brand-new question, with no
      // memory of earlier ones.
      const res = await runAISQLPipeline(q, dataset);
      if (res.rawData.length === 0) { setIsFollowUpLoading(false); return; }
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'horizontalBar' };
      // Replace current result with follow-up result
      setDrillDown(null);
      setResult({
        data: res.chartData, xKey: res.chart.xKey, yKey: res.chart.yKey, yLabel: q,
        insight: res.explanation, sql: res.sql,
        config: { metric: res.plan.metrics[0]?.field || res.chart.yKey, dimension: res.plan.dimensions[0]?.field || res.chart.xKey, aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, questionId: 'followup_' + Date.now(), questionLabel: q, secondaryMetrics: res.chart.secondaryYKeys, axisMode: res.chart.useDualAxis ? 'dual' : 'auto', limit: res.plan.limit || 0, sort: res.plan.sort?.[0]?.dir || 'desc' },
        vis: (chartMap[res.chart.chartType] || 'bar') as any,
        kpi: res.chart.chartType === 'kpiCard' && res.chartData.length > 0 ? res.chartData[0][res.chart.yKey] : undefined,
        growth: res.chart.growth ? { diff: res.chart.growth.diff, pct: res.chart.growth.pct } : undefined,
        secondaryYKeys: res.chart.secondaryYKeys,
      });
      setPipeline(res);
      setChartType(chartMap[res.chart.chartType] || 'bar');
      setActiveTab(isDimensionOnlyResult(res.profile, res.rawData) ? 'chart' : res.chart.chartType === 'table' ? 'table' : 'chart');
      setWorkspaceMode('result');
    } catch { /* ignore */ } finally { setIsFollowUpLoading(false); }
  }, [dataset, followUpQuery, isFollowUpLoading, activeQuery, activePipeline]);

  const updateFormatting = useCallback((f: FormattingConfig) => {
    setLocalFormatting(f);
    onFormatChange?.(f);
  }, [onFormatChange]);

  const handleCopySQL = () => {
    if (sql) { navigator.clipboard.writeText(sql); setCopiedSQL(true); setTimeout(() => setCopiedSQL(false), 2000); }
  };

  const formatTableCell = (column: string, value: unknown) => {
    if (typeof value !== 'number') return String(value ?? '');
    const normalized = column.toLowerCase();
    const semanticType = activePipeline?.profile?.metricSemanticTypes?.[column];
    if (/(?:pct|percent|percentage|share)/i.test(normalized) || semanticType === 'percentage') {
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
    }
    if (/(?:^|_)(?:rank|ranking|row_number|dense_rank)(?:_|$)/i.test(normalized)) {
      return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }
    if (semanticType === 'currency') {
      return value.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      });
    }
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const handlePin = () => {
    if (onPin) { onPin(query, result); setIsPinned(true); setTimeout(() => setIsPinned(false), 2000); }
  };

  const handleRegenerate = async () => {
    if (!dataset || isReloading) return;
    setIsReloading(true);
    try {
      const res = await runAISQLPipeline(query, dataset, undefined, undefined, timeGrain, true);
      if (res.rawData.length === 0) { setIsReloading(false); return; }
      setPipeline(res);
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'donut', heatmap:'heatmap', table:'horizontalBar' };
      setResult({
        data: res.chartData, xKey: res.chart.xKey, yKey: res.chart.yKey, yLabel: query,
        insight: res.explanation, sql: res.sql,
        config: { metric: res.plan.metrics[0]?.field || res.chart.yKey, dimension: res.plan.dimensions[0]?.field || res.chart.xKey, aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, questionId: 'regen_' + Date.now(), questionLabel: query, secondaryMetrics: res.chart.secondaryYKeys, axisMode: res.chart.useDualAxis ? 'dual' : 'auto', limit: res.plan.limit || 0, sort: res.plan.sort?.[0]?.dir || 'desc' },
        vis: (chartMap[res.chart.chartType] || 'bar') as any,
        kpi: res.chart.chartType === 'kpiCard' && res.chartData.length > 0 ? res.chartData[0][res.chart.yKey] : undefined,
        growth: res.chart.growth ? { diff: res.chart.growth.diff, pct: res.chart.growth.pct } : undefined,
        secondaryYKeys: res.chart.secondaryYKeys,
      });
      setChartType((chartMap[res.chart.chartType] || 'bar'));
      setActiveTab(isDimensionOnlyResult(res.profile, res.rawData) ? 'chart' : res.chart.chartType === 'table' ? 'table' : 'chart');
      setWorkspaceMode('result');
    } catch { /* ignore */ } finally { setIsReloading(false); }
  };

  const tabBtnClass = (t: string) => `flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${detailsSection === 'workspace' && activeTab === t ? 'bg-amber-50 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300 ring-1 ring-amber-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`;

  const confLevel = pipeline?.confidence?.level;
  const confScore = pipeline?.confidence?.score;

  return (
    <div className={`relative flex flex-col h-full ${isDark ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* ── Result navigation stays visible above the chart ── */}
      {workspaceMode === 'result' && (
        <div className={`flex min-h-16 shrink-0 items-center justify-between gap-4 border-b px-4 py-2.5 sm:px-6 ${isDark ? 'border-white/[0.08] bg-[#0d1117]' : 'border-slate-200 bg-white'}`}>
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => { if (drillDown) { setDrillDown(null); } else { onBack(); } }}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors ${isDark ? 'border-white/10 bg-white/[0.05] text-white hover:bg-white/10' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}
              aria-label="Back"
              title="Back to AI SQL"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <div className="truncate text-sm font-extrabold sm:text-base">{activeQuery}</div>
              <div className="mt-0.5 text-[11px] font-medium text-slate-400">
                {activeTableData.length.toLocaleString()} rows
                {activePipeline?.executionTimeMs ? ` · ${activePipeline.executionTimeMs.toLocaleString()}ms` : ''}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {activePipeline?.traceStory && (
              <button
                onClick={() => { setDetailsSection('trace'); setWorkspaceMode('details'); }}
                aria-label="Open calculation trace"
                aria-controls="ai-sql-trace-story"
                className={`flex h-12 items-center gap-2 rounded-xl border px-4 text-sm font-extrabold transition-all ${isDark ? 'border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20' : 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100'}`}
              >
                <ListChecks className="h-5 w-5" /> Trace
              </button>
            )}
            <button
              onClick={() => { setDetailsSection('overview'); setWorkspaceMode('details'); }}
              aria-label="Open answer details"
              aria-controls="ai-sql-details-workspace"
              className="flex h-12 items-center gap-2.5 rounded-xl bg-indigo-600 px-5 text-sm font-extrabold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2"
            >
              <Database className="h-5 w-5" /> <span className="hidden sm:inline">View </span>Details
            </button>
          </div>
        </div>
      )}

      {/* ── Details workspace header: diagnostics and actions stay separate ── */}
      {workspaceMode === 'details' && (
      <div id="ai-sql-details-workspace" role="region" aria-label="Answer details" className={`flex items-center justify-between px-5 py-3 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <button aria-label={drillDown ? 'Return to original answer' : 'Back to AI SQL'} onClick={() => { if (drillDown) { setDrillDown(null); } else { onBack(); } }} className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}><ArrowLeft className="w-4 h-4" /></button>
          <div className="min-w-0">
            {drillDown && (
              <div className="text-[10px] text-indigo-400 dark:text-indigo-300 font-medium flex items-center gap-1 mb-0.5">
                <MousePointerClick className="w-3 h-3" />
                <span className="opacity-60 cursor-pointer hover:opacity-100" onClick={() => setDrillDown(null)}>{query}</span>
                <span className="opacity-40">→</span>
              </div>
            )}
            <div className="text-sm font-bold truncate max-w-md">{activeQuery}</div>
            <div className="text-[11px] text-gray-400 dark:text-slate-500 flex items-center gap-2">
              <span>{activeResult.data.length} rows</span>
              {activePipeline && <span>· {(activePipeline as any).executionTimeMs}ms</span>}
              {provenanceLabel && (
                <span
                  title={provenance?.summary}
                  className={`cursor-help font-semibold ${isLocalAnswer ? 'text-emerald-600 dark:text-emerald-300' : 'text-violet-600 dark:text-violet-300'}`}
                >
                  · {provenanceLabel}
                </span>
              )}
              {(activePipeline as any)?.tokenUsage && !isLocalAnswer && (
                <span
                  title={`AI fallback tokens: ${(activePipeline as any).tokenUsage.prompt} prompt + ${(activePipeline as any).tokenUsage.completion} completion. Only schema metadata and approved safe values are shared; dataset rows are not sent to the model.`}
                  className="cursor-help"
                >
                  · 🪙 {(((activePipeline as any).tokenUsage.total) || 0).toLocaleString()} tokens
                </span>
              )}
              {(activePipeline as any)?.chart?.growth && (
                <span className={(activePipeline as any).chart.growth.pct >= 0 ? 'text-emerald-500' : 'text-red-500'}>
                  {(activePipeline as any).chart.growth.pct >= 0 ? '▲' : '▼'} {(activePipeline as any).chart.growth.pct >= 0 ? '+' : ''}{(activePipeline as any).chart.growth.pct.toFixed(1)}%
                </span>
              )}
              {isDrilling && <span className="text-indigo-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Drilling...</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Answer workspace" className={`flex items-center rounded-xl border p-1 ${isDark ? 'border-white/10 bg-white/[0.04]' : 'border-gray-200 bg-gray-50'}`}>
            <button role="tab" aria-selected={false} aria-controls="ai-sql-result-workspace" onClick={() => {
              setActiveTab('chart');
              setWorkspaceMode('result');
            }} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold ${isDark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-600 hover:bg-white'}`}>
              <BarChart2 className="w-3.5 h-3.5" /> Result
            </button>
            <button role="tab" aria-selected={true} aria-controls="ai-sql-details-overview" onClick={() => setDetailsSection('overview')} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-bold text-white shadow-sm">
              <Database className="w-3.5 h-3.5" /> Details
            </button>
          </div>
          {/* Answer path makes the local-first privacy boundary visible to the user. */}
          {provenanceLabel && (
            <span
              title={provenance?.summary}
              className={`hidden sm:inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-current/20 ${provenanceClass}`}
            >
              <Database className="w-3 h-3" /> {provenanceLabel}
            </span>
          )}
          <TrustBadge trust={pipeline?.trust} isDark={isDark} />
          <button onClick={handleRegenerate} disabled={isReloading} className="flex items-center gap-1 text-[12px] font-bold text-cyan-600 dark:text-cyan-300 bg-cyan-50 dark:bg-cyan-500/10 hover:bg-cyan-100 dark:hover:bg-cyan-500/20 px-2.5 py-1.5 rounded-lg transition-all border border-cyan-200 dark:border-cyan-500/20 disabled:opacity-50">
            {isReloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Regen
          </button>
          <button onClick={handlePin} className="flex items-center gap-1.5 text-[12px] font-bold text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 px-3 py-1.5 rounded-lg transition-all border border-amber-200 dark:border-amber-500/20">
            <Pin className="w-3.5 h-3.5" /> {isPinned ? 'Pinned!' : 'Pin'}
          </button>
          {pipeline?.trace && (
            <button onClick={() => setShowPipelineReport(true)} className="flex items-center gap-1.5 text-[12px] font-bold text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-500/10 hover:bg-purple-100 dark:hover:bg-purple-500/20 px-3 py-1.5 rounded-lg transition-all border border-purple-200 dark:border-purple-500/20">
              <Microscope className="w-3.5 h-3.5" /> Pipeline
            </button>
          )}
          {activePipeline?.traceStory && (
            <button onClick={() => { setWorkspaceMode('details'); setDetailsSection('trace'); }} className="flex items-center gap-1.5 text-[12px] font-bold text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-500/10 hover:bg-violet-100 dark:hover:bg-violet-500/20 px-3 py-1.5 rounded-lg transition-all border border-violet-200 dark:border-violet-500/20">
              <ListChecks className="w-3.5 h-3.5" /> Trace
            </button>
          )}
        </div>
      </div>

      )}
      
      {/* ── Confidence Breakdown (expandable) ───────────── */}
      {workspaceMode === 'details' && showConfidence && pipeline?.confidence && (
        <div className={`px-5 py-3 border-b ${isDark ? 'border-white/[0.06] bg-slate-800/50' : 'border-gray-200 bg-white'}`}>
          <div className="max-w-2xl mx-auto grid grid-cols-3 sm:grid-cols-5 gap-3">
            {[
              { label: 'Semantic', value: pipeline.confidence.factors.semanticMatch, max: 30 },
              { label: 'Filters', value: pipeline.confidence.factors.filterClarity, max: 20 },
              { label: 'Aggregation', value: pipeline.confidence.factors.aggregationCertainty, max: 20 },
              { label: 'Complexity', value: pipeline.confidence.factors.planComplexity, max: 15 },
              { label: 'SQL Quality', value: pipeline.confidence.factors.repairAttempts, max: 15 },
            ].map(f => (
              <div key={f.label}>
                <div className="flex justify-between text-[10px] mb-0.5"><span className="text-gray-500 dark:text-slate-400">{f.label}</span><span className={`font-bold ${f.value >= f.max * 0.8 ? 'text-emerald-500' : f.value >= f.max * 0.5 ? 'text-yellow-500' : 'text-red-500'}`}>{f.value}/{f.max}</span></div>
                <div className="h-1.5 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden"><div className={`h-full rounded-full ${f.value >= f.max * 0.8 ? 'bg-emerald-500' : f.value >= f.max * 0.5 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${(f.value / f.max) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Result tools: the complete workspace requested by the user ── */}
      {workspaceMode === 'details' && (
      <div role="tablist" aria-label="Answer detail sections" className={`flex items-center gap-2 px-5 py-2 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0f1219]/50' : 'bg-gray-50/50 border-gray-100'}`}>
        <button role="tab" aria-selected={detailsSection === 'overview'} aria-controls="ai-sql-details-overview" onClick={() => setDetailsSection('overview')} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${detailsSection === 'overview' ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-400/30' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}><Database className="w-3.5 h-3.5" /> Overview</button>
        <button role="tab" aria-selected={detailsSection === 'workspace' && activeTab === 'chart'} aria-controls="ai-sql-result-workspace" onClick={() => { setActiveTab('chart'); setDetailsSection('workspace'); }} className={tabBtnClass('chart')}>
          {activeDimensionOnly ? <ListChecks className="w-3.5 h-3.5" /> : <BarChart2 className="w-3.5 h-3.5" />} {activeDimensionOnly ? 'List' : 'Chart'}
        </button>
        <button role="tab" aria-selected={detailsSection === 'workspace' && activeTab === 'table'} aria-controls="ai-sql-result-workspace" onClick={() => { setActiveTab('table'); setDetailsSection('workspace'); }} className={tabBtnClass('table')}><Table2 className="w-3.5 h-3.5" /> Table</button>
        <button role="tab" aria-selected={detailsSection === 'workspace' && activeTab === 'sql'} aria-controls="ai-sql-result-workspace" onClick={() => { setActiveTab('sql'); setDetailsSection('workspace'); }} className={tabBtnClass('sql')}><Code className="w-3.5 h-3.5" /> SQL</button>
        {activePipeline?.traceStory && (
          <button role="tab" aria-selected={detailsSection === 'trace'} aria-controls="ai-sql-trace-story" onClick={() => setDetailsSection('trace')} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${detailsSection === 'trace' ? 'bg-violet-50 dark:bg-violet-500/20 text-violet-600 dark:text-violet-300 ring-1 ring-violet-400/30' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}>
            <ListChecks className="w-3.5 h-3.5" /> Trace
          </button>
        )}
        <div className="w-px h-5 bg-gray-200 dark:bg-white/10 mx-1" />
        {!activeDimensionOnly && (
          <>
            <button onClick={() => { setActiveTab('chart'); setDetailsSection('workspace'); setIsFormatPanelOpen(!isFormatPanelOpen); }} className={`px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${isFormatPanelOpen ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}><Palette className="w-3.5 h-3.5 inline mr-1" />Format</button>
            <button onClick={() => { setActiveTab('chart'); setDetailsSection('workspace'); setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen); }} className={`px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${isAnalyticsPanelOpen ? 'bg-emerald-50 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 ring-1 ring-emerald-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}><Activity className="w-3.5 h-3.5 inline mr-1" />Analytics</button>
          </>
        )}
        <div className="flex-1" />
        {/* KPI badge */}
        {result.kpi !== undefined && (
          <span className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-600 to-orange-500">
            {typeof result.kpi === 'number' ? result.kpi.toLocaleString(undefined, { maximumFractionDigits: 2 }) : result.kpi}
          </span>
        )}
      </div>

      )}
      
      {/* ── Result workspace: complete Chart/Table/SQL/Format/Analytics experience ── */}
      {(workspaceMode === 'result' || detailsSection === 'workspace') && (
      <div id="ai-sql-result-workspace" role="tabpanel" aria-label={activeTab === 'chart' ? 'Chart result' : activeTab === 'table' ? 'Table result' : 'SQL result'} tabIndex={0} className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Chart Tab */}
          {activeTab === 'chart' && (
            <div className={activeDimensionOnly
              ? `relative overflow-hidden ${workspaceMode === 'result' ? 'm-3 h-[calc(100%_-_1.5rem)] sm:m-5 sm:h-[calc(100%_-_2.5rem)]' : 'h-full p-4'}`
              : `relative overflow-hidden border border-slate-200 bg-white shadow-xl ${workspaceMode === 'result' ? 'm-3 h-[calc(100%_-_1.5rem)] rounded-[24px] p-4 sm:m-5 sm:h-[calc(100%_-_2.5rem)] sm:p-5' : 'h-full rounded-2xl p-6'}`
            } ref={chartContainerRef}>
              {activeDimensionOnly ? (
                <DimensionResultView
                  rows={activeTableData}
                  isDark={isDark}
                  ranked={activePipeline?.plan?.intent === 'ranking'}
                />
              ) : (
              <ChartVisualization
                data={activeResult.data} xKey={activeResult.xKey} yKey={activeResult.yKey} yLabel={activeResult.yLabel}
                config={activeResult.config}
                seriesLabel={activeResult.yKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                chartType={(drillDown ? ((({ kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'horizontalBar' } as Record<string,string>)[drillDown.pipeline.chart.chartType] || 'bar')) : chartType) as any}
                onChartTypeChange={(type) => setChartType(type)}
                formatting={localFormatting}
                onToggleFormat={() => {
                  setIsAnalyticsPanelOpen(false);
                  setIsFormatPanelOpen(open => !open);
                }} isFormatOpen={isFormatPanelOpen}
                onToggleAnalytics={() => {
                  setIsFormatPanelOpen(false);
                  setIsAnalyticsPanelOpen(open => !open);
                }} isAnalyticsOpen={isAnalyticsPanelOpen}
                onToggleLabels={() => {
                  const mode = localFormatting.dataLabelMode || 'off';
                  if (!localFormatting.showDataLabels || mode === 'off') {
                    // Off → Primary
                    updateFormatting({ ...localFormatting, showDataLabels: true, dataLabelMode: 'primary' });
                  } else if (mode === 'primary') {
                    // Primary → All
                    updateFormatting({ ...localFormatting, showDataLabels: true, dataLabelMode: 'all' });
                  } else {
                    // All → Off
                    updateFormatting({ ...localFormatting, showDataLabels: false, dataLabelMode: 'off' });
                  }
                }}
                onAIInsight={() => setIsAIInsightOpen(!isAIInsightOpen)} isAIInsightOpen={isAIInsightOpen}
                chartContainerRef={chartContainerRef}
                onDrillDown={handleDrillDown}
                disableAutoSeries={Boolean(activePipeline) && !['stackedBar', 'groupedBar', 'multiLine'].includes(activePipeline?.chart?.chartType || '')}
              />
              )}
              {/* Drill-down hint */}
              {!activeDimensionOnly && (workspaceMode === 'result' || detailsSection === 'workspace') && !drillDown && !isDrilling && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-slate-500 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm px-3 py-1 rounded-full border border-gray-200/50 dark:border-white/5 opacity-60 hover:opacity-100 transition-opacity pointer-events-none">
                  <MousePointerClick className="w-3 h-3" /> Click any data point to drill down
                </div>
              )}
              {!activeDimensionOnly && (workspaceMode === 'result' || detailsSection === 'workspace') && <AIInsightPanel isOpen={isAIInsightOpen} onClose={() => setIsAIInsightOpen(false)} chartContainerRef={chartContainerRef} chartTitle={activeResult.yLabel} chartContext={{ chartType: activeResult.vis, xKey: activeResult.xKey, yKey: activeResult.yKey, comparisonMode: (activeResult.config as any)?.comparison || undefined }} />}
            </div>
          )}

          {/* Table Tab */}
          {activeTab === 'table' && (
            <div className="h-full overflow-auto p-4">
              <div className={`rounded-xl border overflow-hidden shadow-sm ${isDark ? 'border-white/[0.08] bg-slate-900/40' : 'border-gray-200 bg-white'}`}>
                <table className="w-full text-sm border-collapse">
                  <thead><tr className={isDark ? 'bg-slate-800/95' : 'bg-slate-50'}>
                    {activePipeline?.plan?.intent === 'ranking' && (
                      <th className={`w-14 text-center text-[11px] uppercase tracking-wider px-3 py-3 font-bold sticky top-0 ${isDark ? 'text-slate-400 bg-slate-800/95' : 'text-slate-500 bg-slate-50'}`}>#</th>
                    )}
                    {activeTableData.length > 0 && Object.keys(activeTableData[0]).map(col => (
                      <th key={col} className={`text-left text-[11px] uppercase tracking-wider px-4 py-3 font-bold sticky top-0 ${isDark ? 'text-slate-300 bg-slate-800/95' : 'text-slate-600 bg-slate-50'}`}>
                        {col.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>{activeTableData.map((row: any, i: number) => (
                    <tr key={i} className={`border-t transition-colors ${isDark ? 'border-white/[0.05] hover:bg-white/[0.04]' : 'border-slate-100 hover:bg-indigo-50/40'}`}>
                      {activePipeline?.plan?.intent === 'ranking' && (
                        <td className={`px-3 py-3 text-center text-xs font-bold ${i < 3 ? 'text-indigo-500' : isDark ? 'text-slate-500' : 'text-slate-400'}`}>{i + 1}</td>
                      )}
                      {Object.entries(row).map(([col, val]: [string, any], j: number) => {
                        // Identifiers and years are numbers but not quantities —
                        // "order 1,154" / "year 2,025" reads as a bug, so show them bare.
                        const isIdLike = /(^|_)(id|no|num|number|code|zip|postcode|year)$/i.test(col);
                        const isNumeric = typeof val === 'number';
                        return (
                          <td key={j} className={`px-4 py-3 text-xs ${isNumeric ? 'text-right font-mono tabular-nums font-semibold' : 'text-left font-medium'} ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                            {isNumeric ? (isIdLike ? String(val) : formatTableCell(col, val)) : String(val ?? '')}
                          </td>
                        );
                      })}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {detailsSection === 'workspace' && <div className="text-xs text-gray-400 dark:text-slate-500 mt-3 text-center">{activeTableData.length} rows</div>}
            </div>
          )}

          {/* SQL Tab */}
          {activeTab === 'sql' && (
            <div className="h-full overflow-auto p-4 space-y-4">
              <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-800/50 border-white/[0.06]' : 'bg-white border-gray-200'}`}>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Generated SQL
                    {engineBadge && (
                      <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded normal-case tracking-normal ${engineBadge.cls}`}>{engineBadge.label}</span>
                    )}
                    {provenanceLabel && (
                      <span title={provenance?.summary} className={`text-[10px] font-bold px-1.5 py-0.5 rounded normal-case tracking-normal ${provenanceClass}`}>
                        {provenanceLabel}
                      </span>
                    )}
                  </span>
                  <button onClick={handleCopySQL} className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 flex items-center gap-1">
                    {copiedSQL ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy</>}
                  </button>
                </div>
                <pre className="text-sm text-emerald-700 dark:text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed">{sql || 'No SQL generated.'}</pre>
              </div>
              {explanation && (
                <div className={`rounded-xl border p-4 ${isDark ? 'bg-amber-500/5 border-amber-500/10' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-2"><Database className="w-3.5 h-3.5" /> Explanation</div>
                  <p className="text-sm text-amber-800 dark:text-amber-200/80 leading-relaxed">{explanation}</p>
                </div>
              )}
              {pipeline && (
                <div className={`rounded-xl border p-4 space-y-3 ${isDark ? 'bg-slate-800/50 border-white/[0.06]' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">🔍 Query Trace</div>
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><span className="text-slate-400">Intent:</span><span className="ml-1.5 font-bold">{pipeline.plan.intent}</span></div>
                    <div><span className="text-slate-400">Grain:</span><span className="ml-1.5 font-bold">{pipeline.plan.resultGrain}</span></div>
                    <div><span className="text-slate-400">Chart:</span><span className="ml-1.5 font-bold">{pipeline.chart.chartType}</span></div>
                    <div><span className="text-slate-400">Time:</span><span className="ml-1.5 font-bold">{pipeline.executionTimeMs}ms</span></div>
                    {provenance && (
                      <div className="col-span-2">
                        <span className="text-slate-400">Answer path:</span>
                        <span title={provenance.summary} className={`ml-1.5 font-bold ${isLocalAnswer ? 'text-emerald-600 dark:text-emerald-300' : 'text-violet-600 dark:text-violet-300'}`}>
                          {provenanceLabel}
                        </span>
                        <span className="ml-1.5 text-slate-400">· {provenance.dataAccess === 'metadata_only' ? 'metadata only' : 'approved safe values only'}</span>
                      </div>
                    )}
                    {pipeline.repairAttempts > 0 && <div className="col-span-2 text-yellow-500">⚠ SQL required {pipeline.repairAttempts} repair attempt(s)</div>}
                  </div>
                  {pipeline.validation?.checks && (
                    <div className="pt-2 border-t border-slate-100 dark:border-white/5">
                      <div className="text-[10px] text-slate-400 font-bold uppercase mb-1.5">Validation</div>
                      <div className="flex flex-wrap gap-1.5">
                        {pipeline.validation.checks.slice(0, 6).map((c, i) => (
                          <span key={i} className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${c.status === 'pass' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400' : c.status === 'warn' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600' : 'bg-red-50 dark:bg-red-900/20 text-red-600'}`} title={c.message}>
                            {c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗'} {c.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Side Panels ─────────────────────────────── */}
        {!activeDimensionOnly && (workspaceMode === 'result' || detailsSection === 'workspace') && isFormatPanelOpen && (
          <div className={`w-[320px] shrink-0 border-l overflow-hidden ${isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'}`}>
            <FormatPanel embedded formatting={localFormatting} onUpdateFormatting={updateFormatting} onClose={() => setIsFormatPanelOpen(false)} chartType={chartType} />
          </div>
        )}
        {!activeDimensionOnly && (workspaceMode === 'result' || detailsSection === 'workspace') && isAnalyticsPanelOpen && (
          <div className={`w-72 shrink-0 border-l overflow-y-auto ${isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'}`}>
            <div className="p-4 border-b border-gray-100 dark:border-white/5">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-emerald-500" /> Analytics</h3>
                <button aria-label="Close analytics panel" onClick={() => setIsAnalyticsPanelOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="p-4 space-y-1">
              {(['pct_diff_from_prev', 'diff_from_prev'] as TableCalculation[]).some(calc => (localFormatting.tableCalculations || []).includes(calc)) && (
                <div className="mb-3 rounded-lg border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-500/[0.06] p-3 space-y-2">
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Comparison baseline</label>
                  <select
                    value={localFormatting.tableCalculationComparison?.mode || 'previous'}
                    onChange={e => {
                      const mode = e.target.value as 'previous' | 'selected_value';
                      const values = Array.from(new Set(activeResult.data.map((row: any) => String(row[activeResult.xKey] ?? '')).filter(Boolean)));
                      const currentReference = localFormatting.tableCalculationComparison?.referenceValue;
                      const referenceValue = values.includes(currentReference || '') ? currentReference : values[0];
                      updateFormatting({
                        ...localFormatting,
                        tableCalculationComparison: mode === 'selected_value'
                          ? { mode, referenceValue }
                          : { mode },
                      });
                    }}
                    className="w-full rounded-md border border-emerald-200 dark:border-emerald-500/30 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="previous">Previous row (current chart order)</option>
                    <option value="selected_value">Selected {activeResult.xKey} value</option>
                  </select>
                  {(localFormatting.tableCalculationComparison?.mode || 'previous') === 'selected_value' && (
                    <select
                      value={localFormatting.tableCalculationComparison?.referenceValue || String(activeResult.data[0]?.[activeResult.xKey] ?? '')}
                      onChange={e => updateFormatting({
                        ...localFormatting,
                        tableCalculationComparison: { mode: 'selected_value', referenceValue: e.target.value },
                      })}
                      className="w-full rounded-md border border-emerald-200 dark:border-emerald-500/30 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                      aria-label={`Compare every value with a selected ${activeResult.xKey}`}
                    >
                      {Array.from(new Set(activeResult.data.map((row: any) => String(row[activeResult.xKey] ?? '')).filter(Boolean))).map(value => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  )}
                  <p className="text-[10px] leading-relaxed text-emerald-700/80 dark:text-emerald-300/80">
                    {(localFormatting.tableCalculationComparison?.mode || 'previous') === 'selected_value'
                      ? 'Every visible value is compared with the selected baseline.'
                      : 'Each value is compared with the previous visible row, using the current chart order.'}
                  </p>
                </div>
              )}
              {([
                { id: 'percent_of_total', desc: 'Each value as % of column total' },
                { id: 'rank_desc', desc: 'Rank highest to lowest' },
                { id: 'rank_asc', desc: 'Rank lowest to highest' },
                { id: 'running_total', desc: 'Cumulative sum across rows' },
                { id: 'moving_avg', desc: 'N-period moving average' },
                { id: 'pct_diff_from_prev', desc: '% change from previous row' },
                { id: 'diff_from_prev', desc: 'Absolute diff from previous' },
              ] as { id: TableCalculation; desc: string }[]).map(({ id: calc, desc }) => {
                const isSelected = (localFormatting.tableCalculations || []).includes(calc);
                return (
                  <label key={calc} className={`flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? 'bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-400 ring-1 ring-emerald-400 shadow-sm' : 'hover:bg-gray-50 dark:hover:bg-white/5 border border-transparent hover:border-gray-200 dark:hover:border-white/10'}`}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        // The chart has one value axis, so one calculation can be
                        // active at a time. This also prevents a stale percentage
                        // calculation from formatting Rank/Moving Average/etc.
                        const tableCalculations = isSelected ? [] : [calc];
                        const usesComparison = calc === 'pct_diff_from_prev' || calc === 'diff_from_prev';
                        updateFormatting({
                          ...localFormatting,
                          tableCalculations,
                          tableCalculationComparison: !isSelected && usesComparison
                            ? localFormatting.tableCalculationComparison
                            : undefined,
                        });
                      }}
                      className="rounded text-emerald-600 focus:ring-emerald-500"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-bold leading-tight block">{getCalculationDisplayName(calc)}</span>
                      <span className="text-[10px] text-gray-500 dark:text-slate-500 leading-tight">{desc}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      )}

      {/* ── Details workspace: provenance, usage, trust and actions ── */}
      {workspaceMode === 'details' && detailsSection === 'overview' && (
        <div id="ai-sql-details-overview" role="tabpanel" aria-label="Answer overview" tabIndex={0} className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-7">
          <div className="mx-auto max-w-5xl space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Rows returned</div>
                <div className="mt-2 text-2xl font-black">{activeResult.data.length.toLocaleString()}</div>
              </div>
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Execution time</div>
                <div className="mt-2 text-2xl font-black">{Number(activePipeline?.executionTimeMs || 0).toLocaleString()}<span className="ml-1 text-sm font-bold text-slate-400">ms</span></div>
              </div>
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">AI tokens</div>
                <div className="mt-2 text-2xl font-black">{Number((activePipeline as any)?.tokenUsage?.total || 0).toLocaleString()}</div>
                <div className="mt-1 text-[10px] text-slate-400">
                  {Number((activePipeline as any)?.tokenUsage?.prompt || 0).toLocaleString()} prompt · {Number((activePipeline as any)?.tokenUsage?.completion || 0).toLocaleString()} completion
                </div>
              </div>
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Confidence</div>
                <div className="mt-2 flex items-end gap-2">
                  <span className="text-2xl font-black">{confScore ?? '—'}</span>
                  {confScore !== undefined && <span className="pb-1 text-xs font-bold text-slate-400">/ 100</span>}
                </div>
                <div className={`mt-1 text-xs font-bold capitalize ${confLevel === 'high' ? 'text-emerald-500' : confLevel === 'medium' ? 'text-amber-500' : 'text-rose-500'}`}>{confLevel || 'Unavailable'}</div>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
              <div className={`rounded-2xl border p-5 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="mb-4 flex items-center gap-2 text-sm font-black"><Database className="h-4 w-4 text-indigo-500" /> Answer details</div>
                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Answer path</dt><dd className="mt-1 font-bold">{provenanceLabel || 'Local analytics'}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Model route</dt><dd className="mt-1 break-words font-bold">{provenance?.model?.replace('openai/', '').toUpperCase() || 'No LLM used'}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Intent</dt><dd className="mt-1 font-bold">{activePipeline?.plan?.intent || '—'}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Result grain</dt><dd className="mt-1 font-bold">{activePipeline?.plan?.resultGrain || '—'}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Recommended visual</dt><dd className="mt-1 font-bold">{activePipeline?.chart?.chartType || chartType}</dd></div>
                  <div><dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">SQL repairs</dt><dd className="mt-1 font-bold">{activePipeline?.repairAttempts || 0}</dd></div>
                </dl>
                {explanation && <p className={`mt-5 rounded-xl border p-4 text-sm leading-relaxed ${isDark ? 'border-indigo-500/15 bg-indigo-500/[0.06] text-slate-300' : 'border-indigo-100 bg-indigo-50/60 text-slate-700'}`}>{explanation}</p>}
              </div>

              <div className={`rounded-2xl border p-5 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
                <div className="mb-4 text-sm font-black">Actions</div>
                <div className="grid gap-2">
                  <button onClick={handleRegenerate} disabled={isReloading} className="flex items-center justify-center gap-2 rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-4 py-3 text-sm font-bold text-cyan-500 transition-colors hover:bg-cyan-500/20 disabled:opacity-50">
                    {isReloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Regenerate answer
                  </button>
                  <button onClick={handlePin} className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm font-bold text-amber-500 transition-colors hover:bg-amber-500/20">
                    <Pin className="h-4 w-4" /> {isPinned ? 'Pinned to dashboard' : 'Pin to dashboard'}
                  </button>
                  {activePipeline?.trace && (
                    <button onClick={() => setShowPipelineReport(true)} className="flex items-center justify-center gap-2 rounded-xl border border-purple-500/25 bg-purple-500/10 px-4 py-3 text-sm font-bold text-purple-500 transition-colors hover:bg-purple-500/20">
                      <Microscope className="h-4 w-4" /> Open pipeline report
                    </button>
                  )}
                  {activePipeline?.traceStory && (
                    <button onClick={() => setDetailsSection('trace')} className="flex items-center justify-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/10 px-4 py-3 text-sm font-bold text-violet-500 transition-colors hover:bg-violet-500/20">
                      <ListChecks className="h-4 w-4" /> View calculation story
                    </button>
                  )}
                  <button onClick={() => { setActiveTab('table'); setDetailsSection('workspace'); }} className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-colors ${isDark ? 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                    <Table2 className="h-4 w-4" /> Explore result data
                  </button>
                  <button onClick={() => { setActiveTab('sql'); setDetailsSection('workspace'); }} className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-colors ${isDark ? 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                    <Code className="h-4 w-4" /> Inspect generated SQL
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {workspaceMode === 'details' && detailsSection === 'trace' && activePipeline?.traceStory && (
        <div id="ai-sql-trace-story" role="tabpanel" aria-label="Calculation trace story" tabIndex={0} className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-7">
          <TraceStoryPanel story={activePipeline.traceStory} question={activeQuery} />
        </div>
      )}

      {/* ── Follow-Up Question Bar ──────────────────────── */}
      {workspaceMode === 'details' && detailsSection === 'overview' && (
      <div className={`flex items-center gap-2 px-4 py-2.5 border-t shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0" />
        <input
          ref={followUpRef}
          type="text"
          value={followUpQuery}
          onChange={e => setFollowUpQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleFollowUp(); } }}
          placeholder="Ask another question... e.g. 'Revenue by region' or 'Monthly sales trend'"
          className={`flex-1 text-sm bg-transparent outline-none placeholder:text-gray-400 dark:placeholder:text-slate-500 ${isDark ? 'text-white' : 'text-gray-900'}`}
          disabled={isFollowUpLoading}
        />
        {isFollowUpLoading ? (
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
        ) : (
          <button
            onClick={handleFollowUp}
            disabled={!followUpQuery.trim()}
            className="p-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      )}
      
      {/* ── Suggested Follow-ups ──────────────────────────── */}
      {workspaceMode === 'details' && detailsSection === 'overview' && !isFollowUpLoading && !drillDown && (
        <div className={`flex items-center gap-1.5 px-4 pb-2 overflow-x-auto shrink-0 ${isDark ? 'bg-[#0d1117]' : 'bg-white'}`}>
          {[
            { label: '📊 Break down by region', q: `Break down ${pipeline?.plan?.metrics?.[0]?.field || 'sales'} by region` },
            { label: '📈 Show trend over time', q: `Show ${pipeline?.plan?.metrics?.[0]?.field || 'sales'} trend over time` },
            { label: '🥧 Show as percentages', q: `What percentage does each ${pipeline?.plan?.dimensions?.[0]?.field || 'category'} contribute?` },
            { label: '🔝 Top 5 only', q: `Show top 5 ${pipeline?.plan?.dimensions?.[0]?.field || 'items'} by ${pipeline?.plan?.metrics?.[0]?.field || 'sales'}` },
          ].map(({ label, q }) => (
            <button
              key={q}
              onClick={() => { setFollowUpQuery(q); setTimeout(() => handleFollowUp(), 50); }}
              className={`text-[11px] px-2.5 py-1 rounded-full border whitespace-nowrap transition-all hover:scale-[1.02] ${
                isDark
                  ? 'border-white/10 text-slate-400 hover:text-white hover:border-indigo-500/30 hover:bg-indigo-500/10'
                  : 'border-gray-200 text-gray-500 hover:text-gray-900 hover:border-indigo-300 hover:bg-indigo-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ── Pipeline Report Modal ─────────────────────── */}
      {showPipelineReport && activePipeline?.trace && (
        <PipelineReport trace={(activePipeline as any).trace} onClose={() => setShowPipelineReport(false)} />
      )}
    </div>
  );
};
