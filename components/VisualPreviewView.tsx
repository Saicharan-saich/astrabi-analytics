import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Pin, Code, Table2, BarChart2, Palette, Activity, Sparkles,
  Copy, Check, X, RefreshCw, Play, Database, Loader2, Microscope,
  MessageSquare, Send, MousePointerClick, ChevronDown
} from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { ChartVisualization } from './ChartVisualization';
import { FormatPanel } from './FormatPanel';
import { AIInsightPanel } from './AIInsightPanel';
import { getCalculationDisplayName, type TableCalculation } from '../utils/tableCalculations';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { useTheme } from './ThemeProvider';
import TrustBadge from './TrustBadge';
import { PipelineReport } from './PipelineReport';

interface VisualPreviewViewProps {
  dataset: Dataset | null;
  result: AnalysisResult;
  pipelineResult?: AISQLPipelineResult | null;
  query: string;
  formatting: FormattingConfig;
  onBack: () => void;
  onPin?: (title: string, result: AnalysisResult) => void;
  onFormatChange?: (formatting: FormattingConfig) => void;
  conversationHistory?: Array<{ question: string; planSummary: string }>;
  onConversationUpdate?: (history: Array<{ question: string; planSummary: string }>) => void;
}

interface DrillDownResult {
  query: string;
  result: AnalysisResult;
  pipeline: AISQLPipelineResult;
}

export const VisualPreviewView: React.FC<VisualPreviewViewProps> = ({
  dataset, result: initialResult, pipelineResult: initialPipeline, query,
  formatting, onBack, onPin, onFormatChange,
  conversationHistory: externalHistory, onConversationUpdate,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'chart' | 'table' | 'sql'>('chart');
  const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
  const [isAnalyticsPanelOpen, setIsAnalyticsPanelOpen] = useState(false);
  const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
  const [copiedSQL, setCopiedSQL] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [showConfidence, setShowConfidence] = useState(false);
  const [showPipelineReport, setShowPipelineReport] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartType, setChartType] = useState<string>((initialResult.vis as string) || 'bar');
  const [localFormatting, setLocalFormatting] = useState<FormattingConfig>(formatting);
  const [result, setResult] = useState<AnalysisResult>(initialResult);
  const [pipeline, setPipeline] = useState<AISQLPipelineResult | null | undefined>(initialPipeline);
  const [isReloading, setIsReloading] = useState(false);
  const [timeGrain, setTimeGrain] = useState<'day'|'week'|'month'|'quarter'|'year'>('month');

  // ── Feature 1: Click-to-Drill-Down ──
  const [drillDown, setDrillDown] = useState<DrillDownResult | null>(null);
  const [isDrilling, setIsDrilling] = useState(false);

  // ── Feature 2: Conversational Follow-ups ──
  const [followUpQuery, setFollowUpQuery] = useState('');
  const [isFollowUpLoading, setIsFollowUpLoading] = useState(false);
  const [convHistory, setConvHistory] = useState<Array<{ question: string; planSummary: string }>>(externalHistory || []);
  const followUpRef = useRef<HTMLInputElement>(null);

  // ── Sync internal state when new query results arrive ──
  // useState only uses initialValue on FIRST mount. Since this component
  // stays mounted (hidden with CSS), we need useEffect to update state
  // when the parent passes new props from a subsequent AI SQL query.
  useEffect(() => {
    setResult(initialResult);
    setChartType((initialResult.vis as string) || 'bar');
    setActiveTab('chart');
  }, [initialResult]);

  useEffect(() => {
    setPipeline(initialPipeline);
  }, [initialPipeline]);

  useEffect(() => {
    setLocalFormatting(formatting);
  }, [formatting]);

  const activeResult = drillDown?.result || result;
  const activePipeline = drillDown?.pipeline || pipeline;
  const activeQuery = drillDown?.query || query;
  const sql = activeResult.sql || activePipeline?.sql || '';
  const explanation = activeResult.insight || activePipeline?.explanation || '';
  const sqlEngine = activePipeline?.engine;
  const engineBadge = sqlEngine === 'question-builder'
    ? { label: 'Question Builder', cls: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' }
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
      const history = [...convHistory, { question: query, planSummary: pipeline?.plan?.resultGrain || '' }];
      const res = await runAISQLPipeline(drillQuery, dataset, undefined, undefined, undefined, false, history);
      if (res.rawData.length === 0) { setIsDrilling(false); return; }
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'bar' };
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
      setActiveTab('chart');
    } catch { /* ignore */ } finally { setIsDrilling(false); }
  }, [dataset, isDrilling, pipeline, query, convHistory]);

  // ── Follow-Up Handler ──
  const handleFollowUp = useCallback(async () => {
    if (!dataset || !followUpQuery.trim() || isFollowUpLoading) return;
    setIsFollowUpLoading(true);
    const q = followUpQuery.trim();
    setFollowUpQuery('');
    try {
      const history = [...convHistory, { question: activeQuery, planSummary: activePipeline?.plan?.resultGrain || '' }];
      const res = await runAISQLPipeline(q, dataset, undefined, undefined, undefined, false, history);
      if (res.rawData.length === 0) { setIsFollowUpLoading(false); return; }
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'bar' };
      const newHistory = [...history, { question: q, planSummary: res.plan.resultGrain || '' }];
      setConvHistory(newHistory);
      onConversationUpdate?.(newHistory);
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
      setActiveTab('chart');
    } catch { /* ignore */ } finally { setIsFollowUpLoading(false); }
  }, [dataset, followUpQuery, isFollowUpLoading, activeQuery, activePipeline, convHistory, onConversationUpdate]);

  const updateFormatting = useCallback((f: FormattingConfig) => {
    setLocalFormatting(f);
    onFormatChange?.(f);
  }, [onFormatChange]);

  const handleCopySQL = () => {
    if (sql) { navigator.clipboard.writeText(sql); setCopiedSQL(true); setTimeout(() => setCopiedSQL(false), 2000); }
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
      const chartMap: Record<string,string> = { kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'donut', heatmap:'heatmap', table:'table' };
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
    } catch { /* ignore */ } finally { setIsReloading(false); }
  };

  const tabBtnClass = (t: string) => `flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${activeTab === t ? 'bg-amber-50 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300 ring-1 ring-amber-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`;

  const confLevel = pipeline?.confidence?.level;
  const confScore = pipeline?.confidence?.score;

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* ── Top Bar ───────────────────────────────────────── */}
      <div className={`flex items-center justify-between px-5 py-3 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => { if (drillDown) { setDrillDown(null); } else { onBack(); } }} className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}><ArrowLeft className="w-4 h-4" /></button>
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
              {(activePipeline as any)?.tokenUsage && (
                <span
                  title={`AI tokens for this question: ${(activePipeline as any).tokenUsage.prompt} prompt + ${(activePipeline as any).tokenUsage.completion} completion. Only the AI planning step uses tokens — the prompt is your column metadata, never the rows — so this cost is independent of how large your dataset is. SQL generation and execution cost 0 tokens.`}
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
          {/* Trust Badge */}
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
        </div>
      </div>

      {/* ── Confidence Breakdown (expandable) ───────────── */}
      {showConfidence && pipeline?.confidence && (
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

      {/* ── Tab Bar ────────────────────────────────────── */}
      <div className={`flex items-center gap-2 px-5 py-2 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0f1219]/50' : 'bg-gray-50/50 border-gray-100'}`}>
        <button onClick={() => setActiveTab('chart')} className={tabBtnClass('chart')}><BarChart2 className="w-3.5 h-3.5" /> Chart</button>
        <button onClick={() => setActiveTab('table')} className={tabBtnClass('table')}><Table2 className="w-3.5 h-3.5" /> Table</button>
        <button onClick={() => setActiveTab('sql')} className={tabBtnClass('sql')}><Code className="w-3.5 h-3.5" /> SQL</button>
        <div className="w-px h-5 bg-gray-200 dark:bg-white/10 mx-1" />
        <button onClick={() => setIsFormatPanelOpen(!isFormatPanelOpen)} className={`px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${isFormatPanelOpen ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}><Palette className="w-3.5 h-3.5 inline mr-1" />Format</button>
        <button onClick={() => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen)} className={`px-3 py-2 rounded-lg text-[13px] font-bold transition-all ${isAnalyticsPanelOpen ? 'bg-emerald-50 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 ring-1 ring-emerald-400/30' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-slate-700/50'}`}><Activity className="w-3.5 h-3.5 inline mr-1" />Analytics</button>
        <div className="flex-1" />
        {/* KPI badge */}
        {result.kpi !== undefined && (
          <span className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-600 to-orange-500">
            {typeof result.kpi === 'number' ? result.kpi.toLocaleString(undefined, { maximumFractionDigits: 2 }) : result.kpi}
          </span>
        )}
      </div>

      {/* ── Content Area ──────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Chart Tab */}
          {activeTab === 'chart' && (
            <div className="h-full p-6 overflow-hidden relative" ref={chartContainerRef}>
              <ChartVisualization
                data={activeResult.data} xKey={activeResult.xKey} yKey={activeResult.yKey} yLabel={activeResult.yLabel}
                chartType={(drillDown ? ((({ kpiCard:'kpiCard', line:'line', bar:'bar', horizontalBar:'horizontalBar', groupedBar:'groupedBar', stackedBar:'stackedBar', area:'area', dualAxisCombo:'combo', multiLine:'line', donut:'doughnut', heatmap:'bar', table:'bar' } as Record<string,string>)[drillDown.pipeline.chart.chartType] || 'bar')) : chartType) as any}
                onChartTypeChange={(type) => setChartType(type)}
                formatting={localFormatting}
                onToggleFormat={() => setIsFormatPanelOpen(!isFormatPanelOpen)} isFormatOpen={isFormatPanelOpen}
                onToggleAnalytics={() => setIsAnalyticsPanelOpen(!isAnalyticsPanelOpen)} isAnalyticsOpen={isAnalyticsPanelOpen}
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
              />
              {/* Drill-down hint */}
              {!drillDown && !isDrilling && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-slate-500 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm px-3 py-1 rounded-full border border-gray-200/50 dark:border-white/5 opacity-60 hover:opacity-100 transition-opacity pointer-events-none">
                  <MousePointerClick className="w-3 h-3" /> Click any data point to drill down
                </div>
              )}
              <AIInsightPanel isOpen={isAIInsightOpen} onClose={() => setIsAIInsightOpen(false)} chartContainerRef={chartContainerRef} chartTitle={activeResult.yLabel} chartContext={{ chartType: activeResult.vis, xKey: activeResult.xKey, yKey: activeResult.yKey, comparisonMode: (activeResult.config as any)?.comparison || undefined }} />
            </div>
          )}

          {/* Table Tab */}
          {activeTab === 'table' && (
            <div className="h-full overflow-auto p-4">
              <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                <table className="w-full text-sm border-collapse">
                  <thead><tr className={isDark ? 'bg-slate-800/80' : 'bg-gray-50'}>
                    {result.data.length > 0 && Object.keys(result.data[0]).map(col => (
                      <th key={col} className={`text-left text-xs uppercase tracking-wider px-3 py-2.5 font-bold sticky top-0 ${isDark ? 'text-slate-400 bg-slate-800/80' : 'text-gray-500 bg-gray-50'}`}>{col}</th>
                    ))}
                  </tr></thead>
                  <tbody>{result.data.map((row: any, i: number) => (
                    <tr key={i} className={`border-t ${isDark ? 'border-white/[0.04] hover:bg-white/[0.02]' : 'border-gray-100 hover:bg-gray-50'}`}>
                      {Object.values(row).map((val: any, j: number) => (
                        <td key={j} className="px-3 py-2 font-mono text-xs">{typeof val === 'number' ? val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(val ?? '')}</td>
                      ))}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="text-xs text-gray-400 dark:text-slate-500 mt-3 text-center">{result.data.length} rows</div>
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
        {isFormatPanelOpen && (
          <div className={`w-[300px] shrink-0 border-l overflow-y-auto ${isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'}`}>
            <FormatPanel formatting={localFormatting} onUpdateFormatting={updateFormatting} onClose={() => setIsFormatPanelOpen(false)} chartType={chartType} />
          </div>
        )}
        {isAnalyticsPanelOpen && (
          <div className={`w-72 shrink-0 border-l overflow-y-auto ${isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'}`}>
            <div className="p-4 border-b border-gray-100 dark:border-white/5">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-emerald-500" /> Analytics</h3>
                <button onClick={() => setIsAnalyticsPanelOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-white p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="p-4 space-y-1">
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
                    <input type="checkbox" checked={isSelected} onChange={() => { const cur = localFormatting.tableCalculations || []; updateFormatting({ ...localFormatting, tableCalculations: isSelected ? cur.filter(c => c !== calc) : [...cur, calc] }); }} className="rounded text-emerald-600 focus:ring-emerald-500" />
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

      {/* ── Follow-Up Question Bar ──────────────────────── */}
      <div className={`flex items-center gap-2 px-4 py-2.5 border-t shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <MessageSquare className="w-4 h-4 text-indigo-400 shrink-0" />
        <input
          ref={followUpRef}
          type="text"
          value={followUpQuery}
          onChange={e => setFollowUpQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleFollowUp(); } }}
          placeholder="Ask a follow-up... e.g. 'Break that down by region' or 'Now show the trend'"
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

      {/* ── Suggested Follow-ups ──────────────────────────── */}
      {!isFollowUpLoading && !drillDown && (
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
