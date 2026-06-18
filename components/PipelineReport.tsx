/**
 * PipelineReport.tsx — Pipeline Transparency Report
 *
 * Interactive, visually rich report showing how each engine
 * in the AI SQL pipeline contributed to answering a question.
 * Displays step-by-step timing, decisions, inputs/outputs.
 */

import React, { useState } from 'react';
import { X, ChevronDown, ChevronRight, Zap, Clock, AlertTriangle, CheckCircle, SkipForward, XCircle } from 'lucide-react';
import type { PipelineTrace, PipelineStepTrace } from '../services/ai-sql/types';
import { useTheme } from './ThemeProvider';

interface PipelineReportProps {
    trace: PipelineTrace;
    onClose: () => void;
}

// ── Engine category colors ──────────────────────────────────────
const ENGINE_COLORS: Record<string, { bg: string; border: string; text: string; barColor: string }> = {
    semanticLayer:       { bg: 'rgba(99, 102, 241, 0.08)',  border: 'rgba(99, 102, 241, 0.3)',  text: '#818cf8', barColor: '#818cf8' },
    timeResolver:        { bg: 'rgba(99, 102, 241, 0.08)',  border: 'rgba(99, 102, 241, 0.3)',  text: '#818cf8', barColor: '#a5b4fc' },
    intentPlanner:       { bg: 'rgba(245, 158, 11, 0.08)',  border: 'rgba(245, 158, 11, 0.3)',  text: '#fbbf24', barColor: '#fbbf24' },
    derivedMetricEngine: { bg: 'rgba(245, 158, 11, 0.08)',  border: 'rgba(245, 158, 11, 0.3)',  text: '#fbbf24', barColor: '#fcd34d' },
    sqlGenerator:        { bg: 'rgba(16, 185, 129, 0.08)',  border: 'rgba(16, 185, 129, 0.3)',  text: '#34d399', barColor: '#34d399' },
    sqlCorrectionEngine: { bg: 'rgba(16, 185, 129, 0.08)',  border: 'rgba(16, 185, 129, 0.3)',  text: '#34d399', barColor: '#6ee7b7' },
    sqlValidator:        { bg: 'rgba(16, 185, 129, 0.08)',  border: 'rgba(16, 185, 129, 0.3)',  text: '#34d399', barColor: '#a7f3d0' },
    duckdbEngine:        { bg: 'rgba(239, 68, 68, 0.08)',   border: 'rgba(239, 68, 68, 0.3)',   text: '#f87171', barColor: '#f87171' },
    resultProfiler:      { bg: 'rgba(168, 85, 247, 0.08)',  border: 'rgba(168, 85, 247, 0.3)',  text: '#c084fc', barColor: '#c084fc' },
    chartRecommender:    { bg: 'rgba(168, 85, 247, 0.08)',  border: 'rgba(168, 85, 247, 0.3)',  text: '#c084fc', barColor: '#d8b4fe' },
    confidenceScorer:    { bg: 'rgba(6, 182, 212, 0.08)',   border: 'rgba(6, 182, 212, 0.3)',   text: '#22d3ee', barColor: '#22d3ee' },
};

const DEFAULT_COLOR = { bg: 'rgba(148, 163, 184, 0.08)', border: 'rgba(148, 163, 184, 0.3)', text: '#94a3b8', barColor: '#94a3b8' };

function getColor(engine: string) {
    return ENGINE_COLORS[engine] || DEFAULT_COLOR;
}

// ── Status icon ─────────────────────────────────────────────────
function StatusIcon({ status }: { status: string }) {
    switch (status) {
        case 'pass': return <CheckCircle size={16} style={{ color: '#22c55e' }} />;
        case 'warn': return <AlertTriangle size={16} style={{ color: '#eab308' }} />;
        case 'skip': return <SkipForward size={16} style={{ color: '#64748b' }} />;
        case 'fail': return <XCircle size={16} style={{ color: '#ef4444' }} />;
        default: return <CheckCircle size={16} style={{ color: '#22c55e' }} />;
    }
}

// ── Format duration ─────────────────────────────────────────────
function fmtMs(ms: number): string {
    if (ms < 1) return '<1ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

// ── Detail Value Renderer ───────────────────────────────────────
function DetailValue({ value, depth = 0 }: { value: any; depth?: number }) {
    if (value === null || value === undefined) return <span style={{ color: '#64748b', fontStyle: 'italic' }}>none</span>;
    if (typeof value === 'boolean') return <span style={{ color: value ? '#22c55e' : '#ef4444' }}>{String(value)}</span>;
    if (typeof value === 'number') return <span style={{ color: '#818cf8', fontFamily: 'monospace' }}>{value}</span>;
    if (typeof value === 'string') {
        // SQL gets special formatting
        if (value.includes('SELECT') || value.includes('FROM')) {
            return <pre style={{ margin: 0, padding: '8px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: 11, fontFamily: "'Fira Code', 'Cascadia Code', monospace", lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#e2e8f0' }}>{value}</pre>;
        }
        return <span style={{ color: '#e2e8f0' }}>{value}</span>;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return <span style={{ color: '#64748b', fontStyle: 'italic' }}>empty</span>;
        // Array of objects → table-like
        if (typeof value[0] === 'object' && value[0] !== null) {
            const keys = Object.keys(value[0]);
            return (
                <div style={{ overflowX: 'auto', marginTop: 4 }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                        <thead>
                            <tr>
                                {keys.map(k => <th key={k} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>{k}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {value.slice(0, 20).map((row: any, i: number) => (
                                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                                    {keys.map(k => <td key={k} style={{ padding: '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.05)', color: '#cbd5e1', fontFamily: typeof row[k] === 'number' ? 'monospace' : 'inherit' }}>{String(row[k] ?? '')}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {value.length > 20 && <div style={{ fontSize: 10, color: '#64748b', padding: '4px 8px' }}>... and {value.length - 20} more</div>}
                </div>
            );
        }
        // Array of primitives → inline
        return <span style={{ color: '#e2e8f0', fontFamily: 'monospace', fontSize: 11 }}>[{value.map(String).join(', ')}]</span>;
    }
    if (typeof value === 'object') {
        return (
            <div style={{ marginLeft: depth > 0 ? 12 : 0 }}>
                {Object.entries(value).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0' }}>
                        <span style={{ color: '#94a3b8', fontSize: 11, minWidth: 80, flexShrink: 0 }}>{k}:</span>
                        <DetailValue value={v} depth={depth + 1} />
                    </div>
                ))}
            </div>
        );
    }
    return <span>{String(value)}</span>;
}

// ── Step Card ───────────────────────────────────────────────────
function StepCard({ step, maxDuration, pipelineTotal }: { step: PipelineStepTrace; maxDuration: number; pipelineTotal: number }) {
    const [expanded, setExpanded] = useState(false);
    const color = getColor(step.engine);
    const barWidth = maxDuration > 0 ? Math.max(4, (step.durationMs / maxDuration) * 100) : 4;
    const pctOfTotal = pipelineTotal > 0 ? ((step.durationMs / pipelineTotal) * 100).toFixed(1) : '0';

    return (
        <div style={{
            position: 'relative',
            background: color.bg,
            border: `1px solid ${color.border}`,
            borderRadius: 12,
            overflow: 'hidden',
            transition: 'all 0.2s ease',
        }}>
            {/* Header */}
            <div
                onClick={() => setExpanded(!expanded)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                    cursor: 'pointer', userSelect: 'none',
                }}
            >
                {/* Step number badge */}
                <div style={{
                    width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: color.border, color: '#fff', fontSize: 12, fontWeight: 700, flexShrink: 0,
                }}>
                    {step.stepNumber}
                </div>

                {/* Icon */}
                <span style={{ fontSize: 20, flexShrink: 0 }}>{step.icon}</span>

                {/* Name + summary */}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, color: color.text, fontSize: 13 }}>{step.name}</span>
                        <StatusIcon status={step.status} />
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {step.summary}
                    </div>
                </div>

                {/* Timing */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>
                        <Clock size={12} style={{ opacity: 0.5 }} />
                        {fmtMs(step.durationMs)}
                    </div>
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{pctOfTotal}%</div>
                </div>

                {/* Expand chevron */}
                <div style={{ flexShrink: 0, color: '#64748b' }}>
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </div>
            </div>

            {/* Duration bar */}
            <div style={{ height: 3, background: 'rgba(255,255,255,0.05)' }}>
                <div style={{
                    height: '100%', width: `${barWidth}%`,
                    background: `linear-gradient(90deg, ${color.barColor}, ${color.barColor}88)`,
                    borderRadius: '0 2px 2px 0',
                    transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                }} />
            </div>

            {/* Expanded details */}
            {expanded && (
                <div style={{
                    padding: '12px 16px', borderTop: `1px solid ${color.border}`,
                    background: 'rgba(0,0,0,0.15)',
                    animation: 'fadeSlideIn 0.2s ease-out',
                }}>
                    <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontWeight: 600 }}>
                        Engine Details
                    </div>
                    {Object.entries(step.details).map(([key, value]) => (
                        <div key={key} style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2, fontWeight: 500 }}>{key}</div>
                            <div style={{ fontSize: 12 }}><DetailValue value={value} /></div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Main Component ──────────────────────────────────────────────
export const PipelineReport: React.FC<PipelineReportProps> = ({ trace, onClose }) => {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const maxDuration = Math.max(...trace.steps.map(s => s.durationMs), 1);
    const passCount = trace.steps.filter(s => s.status === 'pass').length;
    const warnCount = trace.steps.filter(s => s.status === 'warn').length;
    const failCount = trace.steps.filter(s => s.status === 'fail').length;
    const skipCount = trace.steps.filter(s => s.status === 'skip').length;

    // Overall health color
    const healthColor = failCount > 0 ? '#ef4444' : warnCount > 0 ? '#eab308' : '#22c55e';
    const healthLabel = failCount > 0 ? 'Issues Detected' : warnCount > 0 ? 'Minor Warnings' : 'All Systems Nominal';

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
            animation: 'fadeIn 0.2s ease-out',
        }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <style>{`
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                .pipeline-report-scroll::-webkit-scrollbar { width: 6px; }
                .pipeline-report-scroll::-webkit-scrollbar-track { background: transparent; }
                .pipeline-report-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
            `}</style>

            <div style={{
                width: '90%', maxWidth: 720, maxHeight: '90vh',
                background: isDark
                    ? 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)'
                    : 'linear-gradient(135deg, #f8fafc 0%, #eef2ff 50%, #f8fafc 100%)',
                border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
                borderRadius: 20,
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column',
                animation: 'slideUp 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                overflow: 'hidden',
            }}>
                {/* Header */}
                <div style={{
                    padding: '20px 24px 16px',
                    borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{
                                width: 40, height: 40, borderRadius: 12,
                                background: 'linear-gradient(135deg, #818cf8, #c084fc)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>
                                <Zap size={20} color="#fff" />
                            </div>
                            <div>
                                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: isDark ? '#f1f5f9' : '#1e293b' }}>
                                    Pipeline Report
                                </h2>
                                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                                    Engine transparency for your query
                                </div>
                            </div>
                        </div>
                        <button onClick={onClose} style={{
                            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: 8, padding: 6, cursor: 'pointer', color: '#94a3b8',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            <X size={18} />
                        </button>
                    </div>

                    {/* Question banner */}
                    <div style={{
                        marginTop: 12, padding: '10px 14px', borderRadius: 10,
                        background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        border: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
                        fontSize: 13, color: isDark ? '#e2e8f0' : '#334155',
                        fontStyle: 'italic',
                    }}>
                        "{trace.question}"
                    </div>

                    {/* Stats bar */}
                    <div style={{
                        display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap',
                    }}>
                        {/* Total time */}
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 12px', borderRadius: 8,
                            background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)',
                        }}>
                            <Clock size={14} style={{ color: '#818cf8' }} />
                            <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'monospace', color: '#818cf8' }}>
                                {fmtMs(trace.totalDurationMs)}
                            </span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>total</span>
                        </div>

                        {/* Steps count */}
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 12px', borderRadius: 8,
                            background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.2)',
                        }}>
                            <Zap size={14} style={{ color: '#22c55e' }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>
                                {trace.steps.length}
                            </span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>engines</span>
                        </div>

                        {/* Health */}
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '6px 12px', borderRadius: 8,
                            background: `${healthColor}15`, border: `1px solid ${healthColor}33`,
                        }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: healthColor }} />
                            <span style={{ fontSize: 12, color: healthColor, fontWeight: 500 }}>
                                {healthLabel}
                            </span>
                        </div>

                        {/* Status breakdown */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#64748b' }}>
                            {passCount > 0 && <span style={{ color: '#22c55e' }}>✓{passCount}</span>}
                            {warnCount > 0 && <span style={{ color: '#eab308' }}>⚠{warnCount}</span>}
                            {skipCount > 0 && <span style={{ color: '#64748b' }}>⏭{skipCount}</span>}
                            {failCount > 0 && <span style={{ color: '#ef4444' }}>✗{failCount}</span>}
                        </div>
                    </div>
                </div>

                {/* Waterfall Timeline */}
                <div className="pipeline-report-scroll" style={{
                    flex: 1, overflowY: 'auto', padding: '16px 24px 24px',
                }}>
                    {/* Timeline connector */}
                    <div style={{ position: 'relative' }}>
                        {/* Vertical line */}
                        <div style={{
                            position: 'absolute', left: 29, top: 14, bottom: 14,
                            width: 2, background: `linear-gradient(to bottom, #818cf8, #c084fc, #22c55e)`,
                            opacity: 0.2, borderRadius: 1, zIndex: 0,
                        }} />

                        {/* Step cards */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'relative', zIndex: 1 }}>
                            {trace.steps.map((step) => (
                                <StepCard key={step.stepNumber} step={step} maxDuration={maxDuration} pipelineTotal={trace.totalDurationMs} />
                            ))}
                        </div>
                    </div>

                    {/* Footer */}
                    <div style={{
                        marginTop: 16, padding: '12px 16px', borderRadius: 10,
                        background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                        border: `1px solid ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}`,
                        textAlign: 'center',
                        fontSize: 11, color: '#64748b',
                    }}>
                        Expand any step to see engine internals • {trace.steps.length} engines processed your question in {fmtMs(trace.totalDurationMs)}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PipelineReport;
