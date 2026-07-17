import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Zap, RotateCcw, Loader2, Database, Pin, Maximize2, X, TrendingUp, BarChart3, PieChart, Activity } from 'lucide-react';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement, LineElement,
    PointElement, ArcElement, Filler, Tooltip as ChartTooltip,
} from 'chart.js';
import { Dataset, AnalysisResult } from '../types';
import { generateAutoInsights, AutoInsight } from '../services/autoInsightsEngine';
import { FindingsFeed } from './FindingsFeed';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Filler, ChartTooltip);

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const CHART_COLORS = [
    'rgba(99, 102, 241, 0.85)',
    'rgba(16, 185, 129, 0.85)',
    'rgba(245, 158, 11, 0.85)',
    'rgba(239, 68, 68, 0.85)',
    'rgba(139, 92, 246, 0.85)',
    'rgba(6, 182, 212, 0.85)',
    'rgba(236, 72, 153, 0.85)',
    'rgba(34, 197, 94, 0.85)',
];

const CATEGORY_STYLES: Record<string, { bg: string; text: string; icon: any; label: string }> = {
    kpi: { bg: 'bg-blue-500/15', text: 'text-blue-400', icon: Activity, label: 'KPI' },
    ranking: { bg: 'bg-indigo-500/15', text: 'text-indigo-400', icon: BarChart3, label: 'Ranking' },
    trend: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', icon: TrendingUp, label: 'Trend' },
    distribution: { bg: 'bg-purple-500/15', text: 'text-purple-400', icon: PieChart, label: 'Distribution' },
    diagnostic: { bg: 'bg-amber-500/15', text: 'text-amber-400', icon: Activity, label: 'Diagnostic' },
    comparative: { bg: 'bg-rose-500/15', text: 'text-rose-400', icon: BarChart3, label: 'Comparative' },
};

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function formatKpiValue(value: number | string | undefined, format?: string): string {
    if (value === undefined || value === null) return '—';
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num)) return String(value);

    if (format === 'currency_usd') {
        if (Math.abs(num) >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
        return `$${num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
    if (format === 'percent') return `${num.toFixed(1)}%`;
    if (format === 'compact') {
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    }
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// ═══════════════════════════════════════════════════════════════════
// KPI GRADIENTS
// ═══════════════════════════════════════════════════════════════════

const KPI_GRADIENTS = [
    'from-indigo-500/20 to-blue-500/10',
    'from-emerald-500/20 to-teal-500/10',
    'from-amber-500/20 to-orange-500/10',
    'from-violet-500/20 to-purple-500/10',
];

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════

interface QuickInsightsViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
    onOpenInBuilder?: (config: any) => void;
}

export const QuickInsightsView: React.FC<QuickInsightsViewProps> = ({ dataset, onPin, onOpenInBuilder }) => {
    const [insights, setInsights] = useState<AutoInsight[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [elapsed, setElapsed] = useState('0.0');
    const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
    const cachedDatasetId = useRef<string | null>(null);

    // Generate insights when dataset changes
    useEffect(() => {
        if (!dataset || dataset.id === cachedDatasetId.current) return;
        runAnalysis();
    }, [dataset?.id]);

    const runAnalysis = async () => {
        if (!dataset) return;
        setIsLoading(true);
        setDismissedIds(new Set());
        const start = performance.now();

        try {
            const results = await generateAutoInsights(dataset);
            setInsights(results);
            cachedDatasetId.current = dataset.id;
        } catch (err) {
            console.error('[QuickInsights] Failed:', err);
            setInsights([]);
        } finally {
            setElapsed(((performance.now() - start) / 1000).toFixed(1));
            setIsLoading(false);
        }
    };

    const handleDismiss = (id: string) => {
        setDismissedIds(prev => new Set([...prev, id]));
    };

    const handlePin = (insight: AutoInsight) => {
        const result: AnalysisResult = {
            data: insight.data,
            xKey: insight.xKey,
            yKey: insight.yKey,
            yLabel: insight.title,
            insight: insight.subtitle,
            sql: insight.sql,
            config: { questionId: insight.id, questionLabel: insight.title },
            vis: insight.chartType as any,
            kpi: insight.kpiValue,
        };
        onPin?.(insight.title, result);
    };

    const visibleInsights = insights.filter(i => !dismissedIds.has(i.id));
    const kpiInsights = visibleInsights.filter(i => i.category === 'kpi');
    const chartInsights = visibleInsights.filter(i => i.category !== 'kpi');
    const domain = (dataset as any)?.domainProfile?.domain || 'General';

    // ── EMPTY STATE ──
    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
                <Database className="w-16 h-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Upload a dataset to see automatic insights.</p>
            </div>
        );
    }

    // ── LOADING STATE ──
    if (isLoading) {
        return (
            <div className="flex flex-col h-full bg-gray-50 dark:bg-slate-900 p-6 overflow-y-auto">
                <div className="max-w-6xl mx-auto w-full">
                    {/* Header skeleton */}
                    <div className="mb-6">
                        <div className="h-8 w-48 bg-slate-700/50 rounded-lg animate-pulse mb-2" />
                        <div className="h-4 w-96 bg-slate-700/30 rounded animate-pulse" />
                    </div>
                    {/* KPI skeletons */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        {[1,2,3,4].map(i => (
                            <div key={i} className="bg-slate-800/60 rounded-xl p-5 animate-pulse">
                                <div className="h-8 w-24 bg-slate-700/50 rounded mb-2" />
                                <div className="h-4 w-32 bg-slate-700/30 rounded" />
                            </div>
                        ))}
                    </div>
                    {/* Chart skeletons */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {[1,2,3,4,5,6].map(i => (
                            <div key={i} className="bg-slate-800/60 rounded-xl p-5 animate-pulse" style={{ height: 280 }}>
                                <div className="h-5 w-48 bg-slate-700/50 rounded mb-4" />
                                <div className="h-40 bg-slate-700/30 rounded" />
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col items-center justify-center mt-12 gap-3">
                        <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
                        <p className="text-slate-400 text-sm font-medium">Analyzing your data...</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-gray-50 dark:bg-slate-900 p-6 overflow-y-auto">
            <div className="max-w-6xl mx-auto w-full">

                {/* ── HEADER ── */}
                <div className="flex items-start justify-between mb-6">
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2.5">
                            <span className="text-xl">⚡</span>
                            Quick Insights
                            <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
                                domain === 'Sales' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20' :
                                domain === 'Healthcare' ? 'bg-red-500/15 text-red-400 border-red-500/20' :
                                domain === 'HR' ? 'bg-blue-500/15 text-blue-400 border-blue-500/20' :
                                domain === 'Finance' ? 'bg-amber-500/15 text-amber-400 border-amber-500/20' :
                                'bg-slate-500/15 text-slate-400 border-slate-500/20'
                            }`}>
                                {domain} Domain
                            </span>
                        </h2>
                        <p className="text-gray-500 dark:text-slate-400 text-sm mt-1">
                            Generated <strong className="text-gray-700 dark:text-white">{visibleInsights.length}</strong> insights in <strong className="text-gray-700 dark:text-white">{elapsed}s</strong> — Based on <strong className="text-gray-700 dark:text-white">{dataset.rows.length.toLocaleString()}</strong> records
                        </p>
                    </div>
                    <button
                        onClick={runAnalysis}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 hover:border-amber-400/50 text-gray-600 dark:text-slate-300 text-sm font-medium transition-all hover:bg-amber-50 dark:hover:bg-amber-500/10"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Refresh
                    </button>
                </div>

                {/* ── DISCOVERED FINDINGS (the "analyst beside you" feed) ── */}
                <FindingsFeed dataset={dataset} onOpenInBuilder={onOpenInBuilder} />

                {/* ── KPI ROW ── */}
                {kpiInsights.length > 0 && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                        {kpiInsights.map((kpi, idx) => (
                            <div
                                key={kpi.id}
                                className={`relative bg-gradient-to-br ${KPI_GRADIENTS[idx % KPI_GRADIENTS.length]} bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-xl p-5 group hover:border-indigo-500/30 transition-all`}
                            >
                                <button
                                    onClick={() => handleDismiss(kpi.id)}
                                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-all"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                                <div className="text-2xl md:text-3xl font-black text-gray-900 dark:text-white mb-1 tabular-nums">
                                    {formatKpiValue(kpi.kpiValue, kpi.kpiFormat)}
                                </div>
                                <div className="text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wider">
                                    {kpi.title}
                                </div>
                                <div className="mt-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                                    <button onClick={() => handlePin(kpi)} className="p-1 rounded bg-slate-700/40 hover:bg-indigo-500/30 text-slate-400 hover:text-indigo-300" title="Pin to Dashboard">
                                        <Pin className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* ── CHART GRID ── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {chartInsights.map(insight => (
                        <InsightCard
                            key={insight.id}
                            insight={insight}
                            onPin={() => handlePin(insight)}
                            onDismiss={() => handleDismiss(insight.id)}
                            onOpenInBuilder={onOpenInBuilder}
                        />
                    ))}
                </div>

                {visibleInsights.length === 0 && !isLoading && (
                    <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                        <Zap className="w-12 h-12 text-slate-600 mb-4" />
                        <p className="text-lg font-medium">All insights dismissed</p>
                        <button onClick={runAnalysis} className="mt-3 text-sm text-amber-400 hover:text-amber-300 underline">
                            Regenerate insights
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════
// INSIGHT CARD
// ═══════════════════════════════════════════════════════════════════

const InsightCard: React.FC<{
    insight: AutoInsight;
    onPin: () => void;
    onDismiss: () => void;
    onOpenInBuilder?: (config: any) => void;
}> = ({ insight, onPin, onDismiss, onOpenInBuilder }) => {
    const style = CATEGORY_STYLES[insight.category] || CATEGORY_STYLES.kpi;
    const IconComp = style.icon;

    const chartData = useMemo(() => {
        const labels = insight.data.map(d => {
            const raw = String(d[insight.xKey] ?? '');
            // Truncate long labels
            return raw.length > 18 ? raw.substring(0, 16) + '…' : raw;
        });
        const values = insight.data.map(d => Number(d[insight.yKey]) || 0);
        const colors = labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);
        const borderColors = colors.map(c => c.replace('0.85', '1'));

        const isBar = insight.chartType === 'bar' || insight.chartType === 'horizontalBar';
        const isLine = insight.chartType === 'line' || insight.chartType === 'area';
        const isDoughnut = insight.chartType === 'donut' || insight.chartType === 'pie';

        return {
            labels,
            datasets: [{
                data: values,
                // Bars: each bar gets a unique vibrant color
                backgroundColor: isDoughnut ? colors : isBar ? colors : 'rgba(16, 185, 129, 0.25)',
                borderColor: isDoughnut ? borderColors : isLine ? 'rgba(16, 185, 129, 1)' : borderColors,
                borderWidth: isLine ? 2.5 : isDoughnut ? 2 : 0,
                fill: insight.chartType === 'area',
                tension: 0.4,
                pointRadius: isLine ? 3 : 0,
                pointHoverRadius: isLine ? 6 : 0,
                pointBackgroundColor: isLine ? '#10b981' : '#fff',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                borderRadius: isBar ? 6 : 0,
                hoverBackgroundColor: isDoughnut ? borderColors : undefined,
            }]
        };
    }, [insight]);

    const chartOptions: any = useMemo(() => {
        const isHorizontal = insight.chartType === 'horizontalBar';
        const isDoughnut = insight.chartType === 'donut' || insight.chartType === 'pie';

        if (isDoughnut) {
            return {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: true, position: 'right' as const, labels: { color: 'rgba(148,163,184,0.8)', font: { size: 10 }, boxWidth: 10, padding: 8 } }, tooltip: { enabled: true } },
            };
        }

        return {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: isHorizontal ? 'y' as const : 'x' as const,
            plugins: { legend: { display: false }, tooltip: { enabled: true } },
            scales: {
                x: { display: true, grid: { display: false, color: 'rgba(148,163,184,0.08)' }, ticks: { color: 'rgba(148,163,184,0.6)', font: { size: 9 }, maxRotation: 45, maxTicksLimit: 8 } },
                y: { display: true, grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: 'rgba(148,163,184,0.6)', font: { size: 9 }, maxTicksLimit: 6 } }
            }
        };
    }, [insight.chartType]);

    const ChartComponent = useMemo(() => {
        if (insight.chartType === 'donut' || insight.chartType === 'pie') return Doughnut;
        if (insight.chartType === 'line' || insight.chartType === 'area') return Line;
        return Bar;
    }, [insight.chartType]);

    return (
        <div className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden group hover:border-indigo-500/30 transition-all shadow-sm hover:shadow-md">
            {/* Card Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                            {style.label}
                        </span>
                    </div>
                    <h3 className="text-sm font-bold text-gray-900 dark:text-white truncate">{insight.title}</h3>
                    <p className="text-[11px] text-gray-400 dark:text-slate-500 truncate">{insight.subtitle}</p>
                </div>
                <button
                    onClick={onDismiss}
                    className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-all p-1"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Chart */}
            <div className="px-4 py-2" style={{ height: 200 }}>
                <ChartComponent data={chartData} options={chartOptions} />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 px-4 pb-3 pt-1 opacity-0 group-hover:opacity-100 transition-all">
                <button
                    onClick={onPin}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 text-[11px] font-medium transition-all"
                >
                    <Pin className="w-3 h-3" />
                    Pin
                </button>
                {onOpenInBuilder && (
                    <button
                        onClick={() => onOpenInBuilder({ metric: insight.yKey, dimension: insight.xKey })}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[11px] font-medium transition-all"
                    >
                        <Maximize2 className="w-3 h-3" />
                        Builder
                    </button>
                )}
            </div>
        </div>
    );
};
