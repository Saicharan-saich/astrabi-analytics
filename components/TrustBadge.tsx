import React, { useState } from 'react';
import type { TrustVerification } from '../services/ai-sql/types';

interface TrustBadgeProps {
    trust?: TrustVerification | null;
    isDark?: boolean;
    compact?: boolean;
}

/**
 * Trust & Verification Badge — Progressive Disclosure Component
 * 
 * Level 1: Colored badge (🟢 Verified / 🟡 Needs Review / 🔴 Validation Issue)
 * Level 2: Expandable verification summary with business-language checks
 * Level 3: "Explain This Result" plain-English explanation
 */
export default function TrustBadge({ trust, isDark = false, compact = false }: TrustBadgeProps) {
    const [showSummary, setShowSummary] = useState(false);
    const [showExplain, setShowExplain] = useState(false);

    if (!trust) return null;

    const statusConfig = {
        verified: {
            icon: '✓',
            label: 'Verified',
            badgeBg: isDark ? 'bg-emerald-500/15' : 'bg-emerald-50',
            badgeText: isDark ? 'text-emerald-400' : 'text-emerald-700',
            badgeBorder: isDark ? 'border-emerald-500/25' : 'border-emerald-200',
            dotColor: 'bg-emerald-500',
        },
        needs_review: {
            icon: '⚠',
            label: 'Needs Review',
            badgeBg: isDark ? 'bg-amber-500/15' : 'bg-amber-50',
            badgeText: isDark ? 'text-amber-400' : 'text-amber-700',
            badgeBorder: isDark ? 'border-amber-500/25' : 'border-amber-200',
            dotColor: 'bg-amber-500',
        },
        validation_issue: {
            icon: '✗',
            label: 'Issue Detected',
            badgeBg: isDark ? 'bg-red-500/15' : 'bg-red-50',
            badgeText: isDark ? 'text-red-400' : 'text-red-700',
            badgeBorder: isDark ? 'border-red-500/25' : 'border-red-200',
            dotColor: 'bg-red-500',
        },
    };

    const config = statusConfig[trust.status];

    const checkIcon = (status: string) => {
        switch (status) {
            case 'pass': return <span className="text-emerald-500 text-[13px]">✓</span>;
            case 'warn': return <span className="text-amber-500 text-[13px]">⚠</span>;
            case 'fail': return <span className="text-red-500 text-[13px]">✗</span>;
            default: return null;
        }
    };

    return (
        <div className="relative inline-flex flex-col items-end">
            {/* Level 1: Trust Badge */}
            <button
                onClick={() => { setShowSummary(!showSummary); setShowExplain(false); }}
                className={`
                    inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold
                    border cursor-pointer transition-all duration-200
                    hover:scale-105 active:scale-95
                    ${config.badgeBg} ${config.badgeText} ${config.badgeBorder}
                `}
                title="Click to see verification details"
            >
                <span className={`w-1.5 h-1.5 rounded-full ${config.dotColor} animate-pulse`} />
                {config.icon} {config.label}
            </button>

            {/* Level 2: Verification Summary */}
            {showSummary && (
                <div className={`
                    absolute top-full right-0 mt-2 z-50 w-80
                    rounded-xl border shadow-xl backdrop-blur-xl
                    ${isDark ? 'bg-slate-800/95 border-white/10' : 'bg-white/95 border-gray-200'}
                `}
                style={{ animation: 'fadeIn 0.2s ease-out' }}
                >
                    {/* Header */}
                    <div className={`px-4 pt-4 pb-2 border-b ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                        <div className="flex items-center justify-between">
                            <h4 className={`text-[13px] font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                Verification Summary
                            </h4>
                            <button
                                onClick={() => setShowSummary(false)}
                                className={`p-1 rounded-md text-gray-400 text-xs ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}
                            >
                                ✕
                            </button>
                        </div>
                        <p className={`text-[11px] mt-1 ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                            {trust.summary}
                        </p>
                    </div>

                    {/* Checks List */}
                    <div className="px-4 py-3 space-y-2">
                        {trust.checks.map((check, i) => (
                            <div key={i} className="flex items-start gap-2.5">
                                <div className="mt-0.5 shrink-0">{checkIcon(check.status)}</div>
                                <div className="min-w-0">
                                    <div className={`text-[12px] font-medium leading-tight ${isDark ? 'text-slate-200' : 'text-gray-800'}`}>
                                        {check.label}
                                    </div>
                                    {check.detail && (
                                        <div className={`text-[10px] mt-0.5 leading-snug ${isDark ? 'text-slate-500' : 'text-gray-400'}`}>
                                            {check.detail}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Confidence + Explain Button */}
                    <div className={`px-4 py-2.5 border-t flex items-center justify-between ${isDark ? 'border-white/5' : 'border-gray-100'}`}>
                        <span className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                            Confidence: <span className={`font-bold ${
                                trust.confidence === 'high' ? 'text-emerald-500' :
                                trust.confidence === 'medium' ? 'text-amber-500' : 'text-red-500'
                            }`}>{trust.confidence.charAt(0).toUpperCase() + trust.confidence.slice(1)}</span>
                        </span>
                        <button
                            onClick={() => setShowExplain(!showExplain)}
                            className={`
                                text-[11px] font-bold px-2.5 py-1 rounded-lg transition-all
                                ${isDark
                                    ? 'text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20'
                                    : 'text-cyan-600 bg-cyan-50 hover:bg-cyan-100 border border-cyan-200'
                                }
                            `}
                        >
                            {showExplain ? 'Hide Explanation' : 'Explain This Result'}
                        </button>
                    </div>

                    {/* Level 3: Explain This Result */}
                    {showExplain && (
                        <div className={`px-4 py-3 border-t ${isDark ? 'border-white/5 bg-cyan-500/5' : 'border-gray-100 bg-cyan-50/50'}`}>
                            <p className={`text-[12px] leading-relaxed ${isDark ? 'text-slate-200' : 'text-gray-700'}`}
                               style={{ fontFamily: "'Georgia', 'Times New Roman', serif" }}>
                                {trust.explainResult}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
