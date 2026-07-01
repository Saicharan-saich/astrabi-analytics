import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Brain, X, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { DatasetDomainProfile } from '../types';

interface DomainReviewModalProps {
    profile: DatasetDomainProfile;
    isOpen: boolean;
    onAccept: () => void;
    onDismiss: () => void;
}

export const DomainReviewModal: React.FC<DomainReviewModalProps> = ({ profile, isOpen, onAccept, onDismiss }) => {
    const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>({ semantics: false });

    if (!isOpen) return null;

    const toggleSection = (key: string) => {
        setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const confidenceColor = profile.confidence >= 0.8
        ? 'text-emerald-400'
        : profile.confidence >= 0.5
            ? 'text-amber-400'
            : 'text-red-400';

    const confidenceBg = profile.confidence >= 0.8
        ? 'bg-emerald-500/10 border-emerald-500/20'
        : profile.confidence >= 0.5
            ? 'bg-amber-500/10 border-amber-500/20'
            : 'bg-red-500/10 border-red-500/20';

    const semanticEntries = Object.entries(profile.columnSemantics || {});
    const hiddenCount = semanticEntries.filter(([, s]) => s.isHidden).length;
    const visibleCount = semanticEntries.length - hiddenCount;

    // Group by semanticRole
    const roleGroups: Record<string, { col: string; label: string; hidden: boolean }[]> = {};
    for (const [col, sem] of semanticEntries) {
        const role = sem.semanticRole || 'other';
        if (!roleGroups[role]) roleGroups[role] = [];
        roleGroups[role].push({ col, label: sem.humanLabel, hidden: sem.isHidden });
    }

    const roleDisplayNames: Record<string, string> = {
        primary_metric: '📊 Primary Metric',
        secondary_metric: '📈 Secondary Metrics',
        primary_date: '📅 Primary Date',
        secondary_date: '📅 Secondary Date',
        primary_dimension: '🏷️ Primary Dimension',
        secondary_dimension: '🏷️ Secondary Dimensions',
        identifier: '🔑 Identifiers',
        other: '📋 Other Columns',
    };

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                <motion.div
                    initial={{ opacity: 0, scale: 0.92, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    className="w-full max-w-xl bg-[#1c2033] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
                >
                    {/* Header */}
                    <div className="px-6 pt-5 pb-4 border-b border-white/[0.06]">
                        <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg">
                                    <Brain className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-white">AI Domain Detection</h2>
                                    <p className="text-sm text-gray-400">Review the AI&apos;s analysis of your dataset</p>
                                </div>
                            </div>
                            <button
                                onClick={onDismiss}
                                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                    </div>

                    {/* Body */}
                    <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
                        {/* Domain & Confidence */}
                        <div className="flex items-center gap-3">
                            <div className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Detected Domain</p>
                                <p className="text-xl font-bold text-white">{profile.domain}</p>
                                {profile.subDomain && (
                                    <p className="text-sm text-gray-400 mt-0.5">{profile.subDomain}</p>
                                )}
                            </div>
                            <div className={`flex-shrink-0 rounded-xl p-4 border ${confidenceBg}`}>
                                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Confidence</p>
                                <p className={`text-2xl font-bold ${confidenceColor}`}>
                                    {(profile.confidence * 100).toFixed(0)}%
                                </p>
                            </div>
                        </div>

                        {/* Summary */}
                        {profile.summary && (
                            <div className="bg-white/[0.03] border border-white/[0.05] rounded-xl p-4">
                                <p className="text-sm text-gray-300 leading-relaxed">{profile.summary}</p>
                            </div>
                        )}

                        {/* Stats */}
                        <div className="flex gap-3">
                            <div className="flex-1 bg-white/[0.03] border border-white/[0.05] rounded-lg px-3 py-2 text-center">
                                <p className="text-lg font-bold text-emerald-400">{visibleCount}</p>
                                <p className="text-xs text-gray-500">Mapped Columns</p>
                            </div>
                            <div className="flex-1 bg-white/[0.03] border border-white/[0.05] rounded-lg px-3 py-2 text-center">
                                <p className="text-lg font-bold text-gray-400">{hiddenCount}</p>
                                <p className="text-xs text-gray-500">Hidden (Junk)</p>
                            </div>
                            <div className="flex-1 bg-white/[0.03] border border-white/[0.05] rounded-lg px-3 py-2 text-center">
                                <p className="text-lg font-bold text-violet-400">{Object.keys(roleGroups).length}</p>
                                <p className="text-xs text-gray-500">Semantic Roles</p>
                            </div>
                        </div>

                        {/* Column Semantics (collapsible) */}
                        <div className="border border-white/[0.06] rounded-xl overflow-hidden">
                            <button
                                onClick={() => toggleSection('semantics')}
                                className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.05] transition-colors"
                            >
                                <span className="text-sm font-medium text-gray-300">Column Mapping Details</span>
                                {expandedSections.semantics ? (
                                    <ChevronUp className="w-4 h-4 text-gray-500" />
                                ) : (
                                    <ChevronDown className="w-4 h-4 text-gray-500" />
                                )}
                            </button>
                            {expandedSections.semantics && (
                                <div className="px-4 pb-3 pt-2 space-y-3">
                                    {Object.entries(roleGroups).map(([role, items]) => (
                                        <div key={role}>
                                            <p className="text-xs font-semibold text-gray-500 mb-1.5">
                                                {roleDisplayNames[role] || role}
                                            </p>
                                            <div className="space-y-1">
                                                {items.map(item => (
                                                    <div
                                                        key={item.col}
                                                        className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-sm ${item.hidden
                                                                ? 'bg-red-500/5 border border-red-500/10'
                                                                : 'bg-white/[0.02] border border-white/[0.04]'
                                                            }`}
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            {item.hidden ? (
                                                                <EyeOff className="w-3.5 h-3.5 text-red-400/60" />
                                                            ) : (
                                                                <Eye className="w-3.5 h-3.5 text-emerald-400/60" />
                                                            )}
                                                            <span className={item.hidden ? 'text-gray-600 line-through' : 'text-gray-300'}>
                                                                {item.col}
                                                            </span>
                                                        </div>
                                                        <span className={`text-xs ${item.hidden ? 'text-red-400/50' : 'text-violet-400/70'}`}>
                                                            {item.label}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Low confidence warning */}
                        {profile.confidence < 0.7 && (
                            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                                <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm font-medium text-amber-300">Low Confidence Detection</p>
                                    <p className="text-xs text-amber-400/70 mt-1">
                                        The AI is not highly confident about this domain classification. The heuristic fallback
                                        engine will still work correctly with pattern-based column matching.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-4 border-t border-white/[0.06] flex items-center gap-3">
                        <button
                            onClick={onDismiss}
                            className="flex-1 py-2.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-gray-300 font-medium transition-colors border border-white/[0.06]"
                        >
                            Dismiss
                        </button>
                        <button
                            onClick={onAccept}
                            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white font-medium transition-all shadow-lg shadow-violet-500/20 flex items-center justify-center gap-2"
                        >
                            <CheckCircle2 className="w-4 h-4" />
                            Accept Mapping
                        </button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
