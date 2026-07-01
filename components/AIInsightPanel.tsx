import React, { useState, useEffect, useRef } from 'react';
import { X, RefreshCw, AlertTriangle } from 'lucide-react';
import { interpretChartVisual, captureChartAsImage } from '../services/aiService';

interface AIInsightPanelProps {
    isOpen: boolean;
    onClose: () => void;
    chartContainerRef: React.RefObject<HTMLElement | null>;
    chartTitle?: string;
    visualHash?: string; // New prop to force reset
    chartContext?: {
        chartType?: string;
        xKey?: string;
        yKey?: string;
        legendLabels?: string[];
        comparisonMode?: string;
        numberFormat?: string;
    };
}

/**
 * AI Insight Panel — displays AI interpretation of the VISIBLE chart only.
 * 
 * SECURITY: This component captures the chart canvas as an image and sends
 * ONLY that image to the AI. It has ZERO access to raw data, SQL, or datasets.
 */
export const AIInsightPanel: React.FC<AIInsightPanelProps> = ({
    isOpen,
    onClose,
    chartContainerRef,
    chartTitle,
    visualHash,
    chartContext
}) => {
    const [insight, setInsight] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const fetchInsight = async () => {
        if (!chartContainerRef.current) {
            setError('No chart available to interpret.');
            return;
        }

        setLoading(true);
        setError(null);
        setInsight('');

        // Capture ONLY the visual — the rendered chart image
        const imageBase64 = captureChartAsImage(chartContainerRef.current);
        if (!imageBase64) {
            setError('Could not capture the chart visual. Please ensure a chart is rendered.');
            setLoading(false);
            return;
        }

        try {
            const result = await interpretChartVisual(imageBase64, chartTitle, chartContext);
            if (result.startsWith('⚠️')) {
                setError(result);
            } else {
                setInsight(result);
            }
        } catch (err) {
            setError('Failed to get AI interpretation. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    // Auto-fetch when panel opens
    useEffect(() => {
        if (isOpen && !insight && !loading) {
            // Check if we have a stale insight from a previous visual
            fetchInsight();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    // Reset when chart OR visual hash changes
    useEffect(() => {
        if (isOpen) {
            setInsight('');
            setError(null);
            // Optional: Auto-refetch if the panel is already open
            if (visualHash) fetchInsight();
        }
    }, [chartTitle, visualHash]);

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                onClick={onClose}
            />

            {/* Panel */}
            <div
                ref={panelRef}
                className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] bg-white shadow-2xl z-50 flex flex-col"
                style={{
                    animation: 'slideInRight 0.3s ease-out',
                    borderLeft: '3px solid #3b82f6'
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100"
                    style={{ background: 'linear-gradient(135deg, #eff6ff 0%, #f0f4ff 100%)' }}
                >
                    <div className="flex items-center gap-3">
                        <img
                            src="/ai-insight-btn.png"
                            alt="Smart Insight"
                            className="w-8 h-8 object-contain"
                        />
                        <div>
                            <h3 className="text-base font-bold text-slate-800">Smart Visual Insight</h3>
                            <p className="text-[11px] text-slate-500">Interprets the chart visual only — no data access</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg hover:bg-slate-200 transition-colors"
                    >
                        <X className="w-4 h-4 text-slate-500" />
                    </button>
                </div>

                {/* Security Badge */}
                <div className="px-5 py-2 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-[11px] font-medium text-blue-700">
                        🔒 Secure — interprets the rendered chart image only
                    </span>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                    {loading && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-3 text-sm text-slate-600">
                                <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                                <span>Analyzing chart visual...</span>
                            </div>
                            {/* Skeleton loader */}
                            <div className="space-y-3 animate-pulse">
                                <div className="h-4 bg-slate-200 rounded w-full" />
                                <div className="h-4 bg-slate-200 rounded w-5/6" />
                                <div className="h-4 bg-slate-200 rounded w-4/6" />
                                <div className="h-8 bg-slate-100 rounded w-full mt-4" />
                                <div className="h-4 bg-slate-200 rounded w-full" />
                                <div className="h-4 bg-slate-200 rounded w-3/4" />
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm text-amber-800 font-medium">Unable to interpret</p>
                                <p className="text-sm text-amber-700 mt-1">{error}</p>
                            </div>
                        </div>
                    )}

                    {insight && !loading && (
                        <div className="prose prose-sm max-w-none">
                            <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                                {insight.split('\n').map((line, i) => {
                                    // Format bullet points
                                    if (line.trim().startsWith('- ') || line.trim().startsWith('• ') || line.trim().startsWith('* ')) {
                                        return (
                                            <div key={i} className="flex gap-2 my-1.5">
                                                <span className="text-blue-500 font-bold mt-0.5">•</span>
                                                <span>{line.trim().slice(2)}</span>
                                            </div>
                                        );
                                    }
                                    // Format headers (lines starting with **)
                                    if (line.trim().startsWith('**') && line.trim().endsWith('**')) {
                                        return (
                                            <h4 key={i} className="font-bold text-slate-800 mt-3 mb-1">
                                                {line.trim().replace(/\*\*/g, '')}
                                            </h4>
                                        );
                                    }
                                    // Format numbered lists
                                    const numMatch = line.trim().match(/^(\d+)\.\s+(.+)/);
                                    if (numMatch) {
                                        return (
                                            <div key={i} className="flex gap-2 my-1.5">
                                                <span className="text-blue-600 font-bold min-w-[18px]">{numMatch[1]}.</span>
                                                <span>{numMatch[2]}</span>
                                            </div>
                                        );
                                    }
                                    if (line.trim() === '') return <div key={i} className="h-2" />;
                                    return <p key={i} className="my-1">{line}</p>;
                                })}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50">
                    <span className="text-[10px] text-slate-400">
                        Smart Insight • Visual interpretation only
                    </span>
                    <button
                        onClick={fetchInsight}
                        disabled={loading}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-all"
                    >
                        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                        Regenerate
                    </button>
                </div>
            </div>

            {/* Animation keyframes */}
            <style>{`
                @keyframes slideInRight {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `}</style>
        </>
    );
};
