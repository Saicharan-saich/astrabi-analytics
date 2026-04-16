/**
 * TrustBadge.tsx — Confidence & Warnings UI Component
 *
 * Displays trust indicators for analysis results:
 *   - Confidence score (green/amber/red badge)
 *   - Warning count with expandable list
 *   - Explainability breakdown (metric, aggregation, dimension, filters)
 *
 * RULES:
 *   - Always visible when result has confidence < 1.0
 *   - Warnings expandable on click
 *   - Color-coded: green (>=0.85), amber (0.6-0.84), red (<0.6)
 */

import React, { useState } from 'react';
import { Shield, AlertTriangle, ChevronDown, ChevronUp, Info, CheckCircle } from 'lucide-react';

interface TrustBadgeProps {
    confidence?: number;
    warnings?: string[];
    explainability?: {
        metric: string;
        aggregation: string;
        sourceColumn: string;
        dimension: string;
        filtersApplied: string[];
        rowsProcessed: number;
    };
    compact?: boolean;
}

export const TrustBadge: React.FC<TrustBadgeProps> = ({
    confidence,
    warnings,
    explainability,
    compact = false,
}) => {
    const [expanded, setExpanded] = useState(false);

    // No trust data = no badge
    if (confidence === undefined && (!warnings || warnings.length === 0)) return null;

    const score = confidence ?? 1.0;
    const pct = Math.round(score * 100);
    const warningCount = warnings?.length || 0;

    // Color tiers
    const tier = score >= 0.85 ? 'high' : score >= 0.6 ? 'medium' : 'low';
    const colors = {
        high: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', icon: 'text-emerald-500' },
        medium: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20', icon: 'text-amber-500' },
        low: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20', icon: 'text-red-500' },
    };
    const c = colors[tier];

    if (compact) {
        return (
            <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${c.bg} ${c.text} ${c.border} border`}>
                <Shield className="w-3 h-3" />
                {pct}%
                {warningCount > 0 && (
                    <span className="flex items-center gap-0.5 text-amber-400">
                        <AlertTriangle className="w-3 h-3" />
                        {warningCount}
                    </span>
                )}
            </div>
        );
    }

    return (
        <div className={`rounded-lg border ${c.border} ${c.bg} overflow-hidden transition-all`}>
            {/* Header Row */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Shield className={`w-4 h-4 ${c.icon}`} />
                    <span className={`text-xs font-semibold ${c.text}`}>
                        Confidence: {pct}%
                    </span>
                    {warningCount > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
                            <AlertTriangle className="w-3 h-3" />
                            {warningCount} warning{warningCount > 1 ? 's' : ''}
                        </span>
                    )}
                    {warningCount === 0 && score >= 0.85 && (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                            <CheckCircle className="w-3 h-3" />
                            Verified
                        </span>
                    )}
                </div>
                {(warningCount > 0 || explainability) && (
                    expanded
                        ? <ChevronUp className="w-4 h-4 text-gray-500" />
                        : <ChevronDown className="w-4 h-4 text-gray-500" />
                )}
            </button>

            {/* Expanded Details */}
            {expanded && (
                <div className="px-3 pb-3 space-y-2 border-t border-white/5">
                    {/* Warnings */}
                    {warnings && warnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                            {warnings.map((w, i) => (
                                <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-300/90">
                                    <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    <span>{w}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Explainability */}
                    {explainability && (
                        <div className="mt-2 bg-white/5 rounded-md p-2 space-y-1">
                            <div className="flex items-center gap-1 text-[11px] font-semibold text-gray-300 mb-1">
                                <Info className="w-3 h-3" />
                                Computation Trace
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                                <span className="text-gray-500">Metric</span>
                                <span className="text-gray-300 font-medium">{explainability.metric}</span>
                                <span className="text-gray-500">Aggregation</span>
                                <span className="text-gray-300 font-medium">{explainability.aggregation}</span>
                                <span className="text-gray-500">Dimension</span>
                                <span className="text-gray-300 font-medium">{explainability.dimension}</span>
                                <span className="text-gray-500">Rows Processed</span>
                                <span className="text-gray-300 font-medium">{explainability.rowsProcessed.toLocaleString()}</span>
                            </div>
                            {explainability.filtersApplied.length > 0 && (
                                <div className="mt-1">
                                    <span className="text-[11px] text-gray-500">Filters: </span>
                                    <span className="text-[11px] text-violet-400">
                                        {explainability.filtersApplied.join(' • ')}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * StaleBadge — Shows when a dashboard item's dataset version doesn't match current.
 */
export const StaleBadge: React.FC<{ itemVersion?: number; currentVersion?: number }> = ({
    itemVersion,
    currentVersion,
}) => {
    if (!itemVersion || !currentVersion || itemVersion === currentVersion) return null;

    return (
        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20">
            <AlertTriangle className="w-3 h-3" />
            Stale — data has been updated since this was pinned
        </div>
    );
};
