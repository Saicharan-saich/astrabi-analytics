/**
 * VisualPreviewView.tsx — Full-page visual preview for AI SQL results.
 *
 * When AI SQL generates a result, the user is immediately navigated to this
 * full-page view where they can interact with the chart, format it, pin it
 * to a dashboard, view the generated SQL, and explore the data table.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  ArrowLeft, Pin, Code, Table2, BarChart2, Palette, Activity, Download,
  Sparkles, Copy, Check, X, Eye, EyeOff, RotateCcw, Maximize2
} from 'lucide-react';
import { AnalysisResult, Dataset, FormattingConfig } from '../types';
import { ChartVisualization } from './ChartVisualization';
import { FormatPanel } from './FormatPanel';
import { AIInsightPanel } from './AIInsightPanel';
import { Tooltip } from './Tooltip';
import { getCalculationDisplayName, type TableCalculation } from '../utils/tableCalculations';
import { AISQLPipelineResult } from '../services/ai-sql';
import { useTheme } from './ThemeProvider';

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

export const VisualPreviewView: React.FC<VisualPreviewViewProps> = ({
  dataset,
  result,
  pipelineResult,
  query,
  formatting,
  onBack,
  onPin,
  onFormatChange,
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [activeTab, setActiveTab] = useState<'chart' | 'table' | 'sql'>('chart');
  const [isFormatPanelOpen, setIsFormatPanelOpen] = useState(false);
  const [isAIInsightOpen, setIsAIInsightOpen] = useState(false);
  const [copiedSQL, setCopiedSQL] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(500);
  const [chartType, setChartType] = useState<string>((result.vis as string) || 'bar');

  const sql = result.sql || pipelineResult?.sql || '';
  const explanation = result.insight || pipelineResult?.explanation || '';

  // Confidence: handle both 0-1 and 0-100 ranges, guard against NaN
  const rawConfidence = pipelineResult?.confidence;
  const confidencePct = typeof rawConfidence === 'number' && !isNaN(rawConfidence)
    ? (rawConfidence <= 1 ? Math.round(rawConfidence * 100) : Math.round(rawConfidence))
    : null;

  // Measure chart container height dynamically with ResizeObserver
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setChartHeight(h - 48);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTab]);

  const handleCopySQL = () => {
    if (sql) {
      navigator.clipboard.writeText(sql);
      setCopiedSQL(true);
      setTimeout(() => setCopiedSQL(false), 2000);
    }
  };

  const handlePin = () => {
    if (onPin && result) {
      onPin(query, { ...result, formatting });
      setIsPinned(true);
      setTimeout(() => setIsPinned(false), 2500);
    }
  };

  const handleExportCSV = () => {
    if (!result?.data?.length) return;
    const data = result.data;
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
    a.download = `${query.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const updateFormatting = useCallback((f: FormattingConfig) => {
    onFormatChange?.(f);
  }, [onFormatChange]);

  const tabBtnClass = (tab: string) =>
    `flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg transition-all ${
      activeTab === tab
        ? isDark
          ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
          : 'bg-violet-50 text-violet-700 border border-violet-200'
        : isDark
          ? 'text-gray-400 hover:text-gray-200 hover:bg-white/5 border border-transparent'
          : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100 border border-transparent'
    }`;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Top Bar ─────────────────────────────────────────── */}
      <div className={`shrink-0 flex items-center justify-between px-5 py-3 border-b ${
        isDark ? 'bg-[#0f1219] border-white/[0.06]' : 'bg-white border-gray-200'
      }`}>
        {/* Left: Back + Query */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={onBack}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
              isDark
                ? 'text-gray-400 hover:text-white hover:bg-white/10 border border-white/10'
                : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            AI SQL
          </button>
          <div className={`h-5 w-px ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className={`w-4 h-4 shrink-0 ${isDark ? 'text-violet-400' : 'text-violet-500'}`} />
            <span className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {query}
            </span>
          </div>
          {confidencePct !== null && (
            <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${
              confidencePct >= 80
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : confidencePct >= 50
                  ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {confidencePct}% confidence
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 shrink-0 ml-4">
          <button onClick={handlePin} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
            isPinned
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
              : isDark
                ? 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20'
                : 'text-amber-600 bg-amber-50 hover:bg-amber-100 border border-amber-200'
          }`}>
            {isPinned ? <Check className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
            {isPinned ? 'Pinned!' : 'Pin'}
          </button>
          <button onClick={handleExportCSV} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
            isDark ? 'text-gray-400 hover:text-white hover:bg-white/10 border border-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100 border border-gray-200'
          }`}>
            <Download className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setIsFormatPanelOpen(!isFormatPanelOpen)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
            isFormatPanelOpen
              ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-50 text-violet-700 border border-violet-200'
              : isDark ? 'text-gray-400 hover:text-white hover:bg-white/10 border border-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100 border border-gray-200'
          }`}>
            <Palette className="w-3.5 h-3.5" />
            Style
          </button>
          <button onClick={() => setIsAIInsightOpen(!isAIInsightOpen)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all active:scale-95 ${
            isAIInsightOpen
              ? isDark ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : isDark ? 'text-gray-400 hover:text-white hover:bg-white/10 border border-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100 border border-gray-200'
          }`}>
            <Activity className="w-3.5 h-3.5" />
            Insight
          </button>
        </div>
      </div>

      {/* ── AI Explanation Banner ─────────────────────────── */}
      {explanation && (
        <div className={`shrink-0 px-5 py-2.5 text-xs border-b ${
          isDark ? 'bg-violet-500/5 border-white/[0.04] text-gray-300' : 'bg-violet-50/50 border-gray-100 text-gray-600'
        }`}>
          <span className={`font-bold mr-1.5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>AI:</span>
          {explanation}
        </div>
      )}

      {/* ── Tab Bar ───────────────────────────────────────── */}
      <div className={`shrink-0 flex items-center gap-1.5 px-5 py-2 border-b ${
        isDark ? 'bg-[#0f1219]/50 border-white/[0.04]' : 'bg-gray-50/50 border-gray-100'
      }`}>
        <button onClick={() => setActiveTab('chart')} className={tabBtnClass('chart')}>
          <BarChart2 className="w-3.5 h-3.5" /> Chart
        </button>
        <button onClick={() => setActiveTab('table')} className={tabBtnClass('table')}>
          <Table2 className="w-3.5 h-3.5" /> Table
        </button>
        <button onClick={() => setActiveTab('sql')} className={tabBtnClass('sql')}>
          <Code className="w-3.5 h-3.5" /> SQL
        </button>
        <div className="flex-1" />
        <span className={`text-[11px] font-medium ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          {result.data.length} rows
        </span>
      </div>

      {/* ── Content Area ─────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Chart Tab */}
          {activeTab === 'chart' && (
            <div className="h-full p-6 overflow-hidden" ref={chartContainerRef}>
              <ChartVisualization
                data={result.data}
                xKey={result.xKey}
                yKey={result.yKey}
                yLabel={result.yLabel}
                chartType={chartType as any}
                onChartTypeChange={(type) => setChartType(type)}
                formatting={formatting}
                hideControls
                chartContainerRef={chartContainerRef}
              />
            </div>
          )}

          {/* Table Tab */}
          {activeTab === 'table' && (
            <div className="h-full overflow-auto p-4">
              <div className={`rounded-xl border overflow-hidden ${
                isDark ? 'border-white/[0.06]' : 'border-gray-200'
              }`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={isDark ? 'bg-white/[0.03]' : 'bg-gray-50'}>
                      {result.data.length > 0 && Object.keys(result.data[0]).map(key => (
                        <th key={key} className={`px-4 py-3 text-left text-xs font-bold uppercase tracking-wider ${
                          isDark ? 'text-gray-400 border-b border-white/[0.06]' : 'text-gray-500 border-b border-gray-200'
                        }`}>
                          {key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((row, i) => (
                      <tr key={i} className={`${
                        isDark ? 'hover:bg-white/[0.02] border-b border-white/[0.03]' : 'hover:bg-gray-50 border-b border-gray-100'
                      } transition-colors`}>
                        {Object.values(row).map((val, j) => (
                          <td key={j} className={`px-4 py-2.5 text-xs ${
                            isDark ? 'text-gray-300' : 'text-gray-700'
                          } ${typeof val === 'number' ? 'font-mono tabular-nums text-right' : ''}`}>
                            {typeof val === 'number' ? val.toLocaleString() : String(val ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SQL Tab */}
          {activeTab === 'sql' && sql && (
            <div className="h-full p-6 overflow-auto">
              <div className={`rounded-xl border overflow-hidden ${
                isDark ? 'bg-[#0d1117] border-white/[0.06]' : 'bg-gray-900 border-gray-200'
              }`}>
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
                  <span className="text-xs font-bold text-gray-400">Generated SQL</span>
                  <button onClick={handleCopySQL} className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-white transition-colors">
                    {copiedSQL ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedSQL ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="p-4 text-sm text-emerald-300 font-mono overflow-auto whitespace-pre-wrap leading-relaxed">
                  {sql}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* Side Panels */}
        {isFormatPanelOpen && (
          <div className={`w-72 shrink-0 border-l overflow-y-auto ${
            isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'
          }`}>
            <FormatPanel
              formatting={formatting}
              onUpdate={updateFormatting}
              onClose={() => setIsFormatPanelOpen(false)}
            />
          </div>
        )}
        {isAIInsightOpen && dataset && (
          <div className={`w-80 shrink-0 border-l overflow-y-auto ${
            isDark ? 'border-white/[0.06] bg-[#0f1219]' : 'border-gray-200 bg-white'
          }`}>
            <AIInsightPanel
              dataset={dataset}
              result={result}
              onClose={() => setIsAIInsightOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
};
