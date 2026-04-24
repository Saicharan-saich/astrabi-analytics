import React, { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Brain, CheckCircle2, Eye, EyeOff, Sparkles, ArrowRight,
    AlertTriangle, PenLine, RotateCcw, ShieldCheck, Layers, Search,
    ChevronDown, XCircle
} from 'lucide-react';
import { DatasetDomainProfile, ColumnSemantic, ColumnType, ColumnDefinition } from '../types';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const ALL_DOMAINS = [
    'Sales', 'HR', 'Finance', 'Healthcare', 'Inventory', 'SaaS',
    'Education', 'Marketing', 'Logistics', 'Real_Estate', 'Manufacturing',
    'Insurance', 'Hospitality', 'Retail', 'Telecom', 'Agriculture',
    'Energy', 'Government', 'Legal', 'Other'
];

const GRAIN_SUGGESTIONS: Record<string, string[]> = {
    Sales: ['Order', 'Transaction', 'Line Item', 'Invoice'],
    HR: ['Employee', 'Payroll Record', 'Attendance Record', 'Performance Review'],
    Finance: ['Transaction', 'Journal Entry', 'Invoice', 'Budget Line'],
    Healthcare: ['Patient Visit', 'Prescription', 'Diagnosis', 'Claim'],
    Education: ['Student', 'Enrollment', 'Course', 'Grade'],
    Marketing: ['Campaign', 'Lead', 'Impression', 'Conversion'],
    Inventory: ['SKU', 'Stock Movement', 'Purchase Order', 'Shipment'],
    SaaS: ['Subscription', 'User', 'Event', 'License'],
    default: ['Record', 'Row', 'Entry', 'Event'],
};

const COLUMN_TYPES: ColumnType[] = [ColumnType.METRIC, ColumnType.DIMENSION, ColumnType.DATE, ColumnType.BOOLEAN, ColumnType.ID, ColumnType.UNKNOWN];
const AGGREGATIONS = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX', 'NONE'] as const;
const FORMATS = ['currency_usd', 'currency_eur', 'percent', 'raw', 'count', 'date_iso'] as const;
const SEMANTIC_ROLES = [
    'primary_metric', 'secondary_metric',
    'primary_dimension', 'secondary_dimension',
    'primary_date', 'secondary_date',
    'identifier', 'attribute', 'other'
];

const ROLE_DISPLAY: Record<string, { icon: string; label: string; color: string }> = {
    primary_metric: { icon: '📊', label: 'Primary Metric', color: 'text-emerald-400' },
    secondary_metric: { icon: '📈', label: 'Secondary Metric', color: 'text-teal-400' },
    primary_dimension: { icon: '🏷️', label: 'Primary Dimension', color: 'text-violet-400' },
    secondary_dimension: { icon: '🏷️', label: 'Secondary Dimension', color: 'text-purple-400' },
    primary_date: { icon: '📅', label: 'Primary Date', color: 'text-blue-400' },
    secondary_date: { icon: '📅', label: 'Secondary Date', color: 'text-sky-400' },
    identifier: { icon: '🔑', label: 'Identifier', color: 'text-amber-400' },
    attribute: { icon: '📋', label: 'Attribute', color: 'text-gray-400' },
    other: { icon: '📋', label: 'Other', color: 'text-gray-500' },
};

const TYPE_COLORS: Record<string, string> = {
    METRIC: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
    DIMENSION: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
    DATE: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
    BOOLEAN: 'bg-rose-500/15 text-rose-400 border-rose-500/25',
    ID: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
    UNKNOWN: 'bg-gray-500/15 text-gray-400 border-gray-500/25',
};

// ─── Per-column confidence computation ───
function computeColumnConfidence(col: ColumnDefinition, sem: ColumnSemantic, aiProfile: DatasetDomainProfile): number {
    const aiSem = aiProfile.columnSemantics?.[col.name];
    if (!aiSem) return 0.3; // No AI data → low confidence
    // Perfect match = high confidence
    let score = aiProfile.confidence;
    // Type match bonus
    if (aiSem.role === sem.role) score = Math.min(1, score + 0.1);
    // Name pattern bonus (known patterns are more reliable)
    const lower = col.name.toLowerCase();
    const strongPatterns = ['revenue', 'sales', 'salary', 'price', 'cost', 'total', 'amount', 'date', 'id', 'name', 'category', 'department', 'qty', 'quantity'];
    if (strongPatterns.some(p => lower.includes(p))) score = Math.min(1, score + 0.15);
    // Vague names = lower confidence
    const weakPatterns = ['value', 'col', 'field', 'data', 'var', 'x', 'y', 'z'];
    if (weakPatterns.some(p => lower === p || lower.startsWith(p + '_'))) score = Math.max(0.1, score - 0.3);
    return Math.min(1, Math.max(0, score));
}

function confidenceIndicator(score: number): { emoji: string; color: string; label: string } {
    if (score >= 0.75) return { emoji: '🟢', color: 'text-emerald-400', label: 'High' };
    if (score >= 0.45) return { emoji: '🟡', color: 'text-amber-400', label: 'Medium' };
    return { emoji: '🔴', color: 'text-red-400', label: 'Low' };
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

interface ValidationError {
    id: string;
    message: string;
    severity: 'error' | 'warning';
}

function validateMapping(
    columnSemantics: Record<string, ColumnSemantic>,
    grain: string,
): ValidationError[] {
    const errors: ValidationError[] = [];
    const visible = Object.entries(columnSemantics).filter(([, s]) => !s.isHidden);
    const metrics = visible.filter(([, s]) => s.role === ColumnType.METRIC);
    const dimensions = visible.filter(([, s]) => s.role === ColumnType.DIMENSION);
    const dates = visible.filter(([, s]) => s.role === ColumnType.DATE);

    // ── HARD ERRORS (block apply) ──
    if (metrics.length === 0) {
        errors.push({ id: 'no_metric', message: 'At least 1 metric column is required. What will be measured?', severity: 'error' });
    }
    if (dimensions.length === 0) {
        errors.push({ id: 'no_dimension', message: 'At least 1 dimension column is required. What will values be grouped by?', severity: 'error' });
    }
    if (!grain.trim()) {
        errors.push({ id: 'no_grain', message: 'Define what each row represents (grain). This is required.', severity: 'error' });
    }

    // Check METRIC aggregation
    for (const [name, sem] of metrics) {
        if (sem.aggregation === 'NONE') {
            errors.push({ id: `agg_${name}`, message: `"${name}" is a metric but has no aggregation. Select SUM, AVG, COUNT, etc.`, severity: 'error' });
        }
    }

    // ── WARNINGS (allow apply but highlight) ──
    if (dates.length > 0) {
        const hasPrimaryDate = dates.some(([, s]) => s.semanticRole === 'primary_date');
        if (!hasPrimaryDate) {
            errors.push({ id: 'no_primary_date', message: 'Date columns detected but none marked as Primary Date. Consider setting one.', severity: 'warning' });
        }
    }

    return errors;
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT PROPS
// ═══════════════════════════════════════════════════════════════════

interface ColumnMappingWizardProps {
    profile: DatasetDomainProfile;
    columns: ColumnDefinition[];
    fileName: string;
    isAIProfiling: boolean;
    onApply: (updatedProfile: DatasetDomainProfile, columnTypeOverrides: Record<string, ColumnType>) => void;
    onDismiss: () => void;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

export const ColumnMappingWizard: React.FC<ColumnMappingWizardProps> = ({
    profile: initialProfile,
    columns,
    fileName,
    isAIProfiling,
    onApply,
    onDismiss,
}) => {
    // ── Editable state ──
    const [domain, setDomain] = useState(initialProfile.domain);
    const [subDomain, setSubDomain] = useState(initialProfile.subDomain || '');
    const [grain, setGrain] = useState(initialProfile.grain || '');
    const [showPreview, setShowPreview] = useState(false);

    const [columnSemantics, setColumnSemantics] = useState<Record<string, ColumnSemantic>>(() => {
        const merged: Record<string, ColumnSemantic> = {};
        for (const col of columns) {
            const existing = initialProfile.columnSemantics?.[col.name];
            merged[col.name] = existing || {
                role: col.type,
                aggregation: col.type === ColumnType.METRIC ? 'SUM' : col.type === ColumnType.ID ? 'COUNT_DISTINCT' : col.type === ColumnType.BOOLEAN ? 'COUNT' : 'NONE',
                format: 'raw',
                humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                description: '',
                semanticRole: 'other',
                isHidden: false,
            };
        }
        return merged;
    });

    const [expandedCol, setExpandedCol] = useState<string | null>(null);
    const [searchFilter, setSearchFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState<ColumnType | 'ALL'>('ALL');
    const [showErrors, setShowErrors] = useState(false);

    // ── Derived stats ──
    const stats = useMemo(() => {
        const entries = Object.entries(columnSemantics).filter(([, s]) => !s.isHidden);
        return {
            metrics: entries.filter(([, s]) => s.role === ColumnType.METRIC).length,
            dimensions: entries.filter(([, s]) => s.role === ColumnType.DIMENSION).length,
            dates: entries.filter(([, s]) => s.role === ColumnType.DATE).length,
            booleans: entries.filter(([, s]) => s.role === ColumnType.BOOLEAN).length,
            ids: entries.filter(([, s]) => s.role === ColumnType.ID).length,
            hidden: Object.values(columnSemantics).filter(s => s.isHidden).length,
        };
    }, [columnSemantics]);

    // ── Validation ──
    const validationErrors = useMemo(() => validateMapping(columnSemantics, grain), [columnSemantics, grain]);
    const hardErrors = validationErrors.filter(e => e.severity === 'error');
    const warnings = validationErrors.filter(e => e.severity === 'warning');
    const canApply = hardErrors.length === 0;

    // ── Per-column confidence ──
    const columnConfidences = useMemo(() => {
        const map: Record<string, number> = {};
        for (const col of columns) {
            const sem = columnSemantics[col.name];
            if (sem) map[col.name] = computeColumnConfidence(col, sem, initialProfile);
        }
        return map;
    }, [columns, columnSemantics, initialProfile]);

    // ── Grain suggestions ──
    const grainOptions = useMemo(() => {
        return GRAIN_SUGGESTIONS[domain] || GRAIN_SUGGESTIONS.default;
    }, [domain]);

    // ── Preview data ──
    const previewData = useMemo(() => {
        const visible = Object.entries(columnSemantics).filter(([, s]) => !s.isHidden);
        const firstMetric = visible.find(([, s]) => s.role === ColumnType.METRIC);
        const firstDim = visible.find(([, s]) => s.role === ColumnType.DIMENSION);
        const firstDate = visible.find(([, s]) => s.role === ColumnType.DATE);
        return {
            sampleQuestion: firstMetric && firstDim
                ? `Show ${firstMetric[1].humanLabel} (${firstMetric[1].aggregation}) by ${firstDim[1].humanLabel}`
                : null,
            metricList: visible.filter(([, s]) => s.role === ColumnType.METRIC).map(([n, s]) => `${s.humanLabel} (${s.aggregation})`),
            dimensionList: visible.filter(([, s]) => s.role === ColumnType.DIMENSION).map(([, s]) => s.humanLabel),
            dateList: visible.filter(([, s]) => s.role === ColumnType.DATE).map(([, s]) => s.humanLabel),
            grain,
        };
    }, [columnSemantics, grain]);

    // ── Column editing helpers ──
    const updateColumn = useCallback((colName: string, updates: Partial<ColumnSemantic>) => {
        setColumnSemantics(prev => ({
            ...prev,
            [colName]: { ...prev[colName], ...updates },
        }));
    }, []);

    const toggleHidden = useCallback((colName: string) => {
        setColumnSemantics(prev => ({
            ...prev,
            [colName]: { ...prev[colName], isHidden: !prev[colName].isHidden },
        }));
    }, []);

    const resetToAI = () => {
        setDomain(initialProfile.domain);
        setSubDomain(initialProfile.subDomain || '');
        setGrain(initialProfile.grain || '');
        const merged: Record<string, ColumnSemantic> = {};
        for (const col of columns) {
            const existing = initialProfile.columnSemantics?.[col.name];
            merged[col.name] = existing || {
                role: col.type,
                aggregation: col.type === ColumnType.METRIC ? 'SUM' : col.type === ColumnType.ID ? 'COUNT_DISTINCT' : 'NONE',
                format: 'raw',
                humanLabel: col.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                description: '',
                semanticRole: 'other',
                isHidden: false,
            };
        }
        setColumnSemantics(merged);
        setShowErrors(false);
    };

    // ── Filtered columns ──
    const filteredColumns = useMemo(() => {
        return columns.filter(col => {
            if (searchFilter && !col.name.toLowerCase().includes(searchFilter.toLowerCase())) return false;
            if (typeFilter !== 'ALL' && columnSemantics[col.name]?.role !== typeFilter) return false;
            return true;
        });
    }, [columns, searchFilter, typeFilter, columnSemantics]);

    // ── Apply handler ──
    const handleApply = () => {
        setShowErrors(true);
        if (!canApply) return;

        const updatedProfile: DatasetDomainProfile = {
            ...initialProfile,
            domain,
            subDomain: subDomain || undefined,
            grain,
            columnSemantics,
            detectedAt: Date.now(),
        };

        // Build column type overrides ONLY for actual type changes
        const overrides: Record<string, ColumnType> = {};
        for (const col of columns) {
            const sem = columnSemantics[col.name];
            if (sem && sem.role !== col.type) {
                overrides[col.name] = sem.role;
            }
        }

        onApply(updatedProfile, overrides);
    };

    // ── Inline aggregation change (no expand needed) ──
    const cycleAggregation = (colName: string) => {
        const sem = columnSemantics[colName];
        if (sem.role !== ColumnType.METRIC) return;
        const aggs: typeof AGGREGATIONS[number][] = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX'];
        const idx = aggs.indexOf(sem.aggregation as any);
        const next = aggs[(idx + 1) % aggs.length];
        updateColumn(colName, { aggregation: next });
    };

    return (
        <div className="h-full flex flex-col bg-[#0f1219] overflow-hidden">
            {/* ── TOP HEADER ── */}
            <div className="flex-shrink-0 border-b border-white/[0.06] bg-[#141824]">
                <div className="max-w-7xl mx-auto px-6 py-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                                <Brain className="w-5 h-5 text-white" />
                            </div>
                            <div>
                                <h1 className="text-base font-bold text-white">Column Mapping Review</h1>
                                <p className="text-xs text-gray-400">
                                    {isAIProfiling ? (
                                        <span className="flex items-center gap-2">
                                            <Sparkles className="w-3 h-3 text-violet-400 animate-pulse" />
                                            AI is analyzing your dataset...
                                        </span>
                                    ) : (
                                        <>Verify how <span className="text-violet-400 font-medium">{fileName}</span> columns are classified</>
                                    )}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button onClick={resetToAI} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-gray-400 hover:text-gray-200 text-xs transition-all border border-white/[0.06]" title="Reset to AI/ETL defaults">
                                <RotateCcw className="w-3 h-3" /> Reset
                            </button>
                            <button onClick={onDismiss} className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-gray-300 text-xs transition-all border border-white/[0.06]">
                                Skip
                            </button>
                            <button
                                onClick={handleApply}
                                disabled={showErrors && !canApply}
                                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all shadow-lg ${showErrors && !canApply
                                    ? 'bg-gray-600/50 text-gray-400 cursor-not-allowed shadow-none'
                                    : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-violet-500/20'
                                    }`}
                            >
                                <CheckCircle2 className="w-4 h-4" />
                                Apply & Continue
                                <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── MAIN CONTENT ── */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="max-w-7xl mx-auto px-6 py-5 space-y-4">

                    {/* ══ SECTION 1: GRAIN + DOMAIN (Mandatory) ══ */}
                    <div className="grid grid-cols-4 gap-3">
                        {/* Grain (MANDATORY — most prominent) */}
                        <div className={`col-span-2 rounded-xl p-4 border transition-all ${showErrors && !grain.trim()
                            ? 'bg-red-500/10 border-red-500/30'
                            : 'bg-[#1c2033] border-white/[0.06]'
                            }`}>
                            <div className="flex items-center gap-2 mb-2">
                                <Layers className="w-4 h-4 text-violet-400" />
                                <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Each row represents a... <span className="text-red-400">*</span></label>
                            </div>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={grain}
                                    onChange={e => setGrain(e.target.value)}
                                    placeholder="e.g. Order, Employee, Transaction..."
                                    className="flex-1 bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all"
                                />
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {grainOptions.map(g => (
                                    <button
                                        key={g}
                                        onClick={() => setGrain(g)}
                                        className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${grain === g
                                            ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                            : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 border border-white/[0.06]'
                                            }`}
                                    >{g}</button>
                                ))}
                            </div>
                        </div>

                        {/* Domain */}
                        <div className="bg-[#1c2033] border border-white/[0.06] rounded-xl p-4">
                            <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold block mb-2">Domain</label>
                            <select
                                value={domain}
                                onChange={e => { setDomain(e.target.value); setGrain(''); }}
                                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                            >
                                {ALL_DOMAINS.map(d => (
                                    <option key={d} value={d} className="bg-[#1c2033]">{d}</option>
                                ))}
                            </select>
                            {subDomain && <p className="text-[10px] text-gray-500 mt-1">Sub: {subDomain}</p>}
                        </div>

                        {/* AI Confidence — expandable breakdown */}
                        <div className="bg-[#1c2033] border border-white/[0.06] rounded-xl p-4">
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold">AI Confidence</label>
                                <span className={`text-lg font-bold ${initialProfile.confidence >= 0.8 ? 'text-emerald-400' :
                                    initialProfile.confidence >= 0.5 ? 'text-amber-400' : 'text-red-400'
                                    }`}>
                                    {(initialProfile.confidence * 100).toFixed(0)}%
                                </span>
                            </div>
                            <div className="h-2.5 bg-white/[0.06] rounded-full overflow-hidden mb-3">
                                <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${initialProfile.confidence * 100}%` }}
                                    transition={{ duration: 0.8, ease: 'easeOut' }}
                                    className={`h-full rounded-full ${initialProfile.confidence >= 0.8 ? 'bg-emerald-500' :
                                        initialProfile.confidence >= 0.5 ? 'bg-amber-500' : 'bg-red-500'
                                        }`}
                                />
                            </div>
                            {/* Factor breakdown */}
                            {(() => {
                                // Compute column-level factors
                                const lowConfCols = Object.entries(columnConfidences).filter(([, v]) => v < 0.45);
                                const medConfCols = Object.entries(columnConfidences).filter(([, v]) => v >= 0.45 && v < 0.75);
                                const highConfCols = Object.entries(columnConfidences).filter(([, v]) => v >= 0.75);
                                const totalCols = columns.length;
                                const domainScore = initialProfile.confidence >= 0.8 ? 1 : initialProfile.confidence >= 0.5 ? 0.6 : 0.3;
                                const nameClarity = totalCols > 0 ? highConfCols.length / totalCols : 0;
                                const typeBalance = stats.metrics > 0 && stats.dimensions > 0 ? 1 : 0.3;
                                const factors = [
                                    { label: 'Domain Detection', value: Math.round(domainScore * 100), max: 100, desc: domainScore >= 0.8 ? `Detected: ${domain}` : `Low certainty for ${domain}` },
                                    { label: 'Column Name Clarity', value: Math.round(nameClarity * 100), max: 100, desc: `${highConfCols.length}/${totalCols} columns have clear names` },
                                    { label: 'Type Distribution', value: Math.round(typeBalance * 100), max: 100, desc: typeBalance >= 1 ? `${stats.metrics} metrics, ${stats.dimensions} dimensions` : 'Missing metrics or dimensions' },
                                ];
                                return (
                                    <div className="space-y-2">
                                        {factors.map(f => (
                                            <div key={f.label}>
                                                <div className="flex items-center justify-between mb-0.5">
                                                    <span className="text-[10px] font-medium text-gray-500">{f.label}</span>
                                                    <span className={`text-[10px] font-bold ${f.value >= 80 ? 'text-emerald-400' : f.value >= 50 ? 'text-amber-400' : 'text-red-400'}`}>{f.value}%</span>
                                                </div>
                                                <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                                                    <div className={`h-full rounded-full transition-all ${f.value >= 80 ? 'bg-emerald-500' : f.value >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${f.value}%` }} />
                                                </div>
                                                <p className="text-[9px] text-gray-600 mt-0.5">{f.desc}</p>
                                            </div>
                                        ))}
                                        {lowConfCols.length > 0 && (
                                            <div className="mt-2 pt-2 border-t border-white/[0.04]">
                                                <p className="text-[10px] font-bold text-red-400 mb-1">⚠ {lowConfCols.length} column{lowConfCols.length > 1 ? 's' : ''} dragging score down:</p>
                                                <div className="space-y-0.5">
                                                    {lowConfCols.slice(0, 5).map(([name]) => {
                                                        const lower = name.toLowerCase();
                                                        const weakPatterns = ['value', 'col', 'field', 'data', 'var', 'x', 'y', 'z'];
                                                        const isWeak = weakPatterns.some(p => lower === p || lower.startsWith(p + '_'));
                                                        const sem = columnSemantics[name];
                                                        const reason = isWeak ? 'Ambiguous column name' : !sem ? 'No AI match' : sem.role === ColumnType.ID ? 'Classified as ID (review type)' : 'Unrecognized pattern';
                                                        return (
                                                            <div key={name} className="flex items-center gap-1.5 text-[10px]">
                                                                <span className="text-red-400">🔴</span>
                                                                <span className="text-gray-400 font-mono">{name}</span>
                                                                <span className="text-gray-600">— {reason}</span>
                                                            </div>
                                                        );
                                                    })}
                                                    {lowConfCols.length > 5 && <p className="text-[9px] text-gray-600">...and {lowConfCols.length - 5} more</p>}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                    </div>

                    {/* ══ LOW CONFIDENCE WARNING (moved to top) ══ */}
                    {initialProfile.confidence < 0.7 && (
                        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
                            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="text-xs font-medium text-amber-300">Low confidence — please review columns with 🔴 and 🟡 indicators carefully.</p>
                                <p className="text-[10px] text-amber-400/70 mt-0.5">The AI is {(initialProfile.confidence * 100).toFixed(0)}% confident in its classification. Click the confidence panel above to see which columns need attention.</p>
                            </div>
                        </div>
                    )}

                    {/* ══ VALIDATION ERRORS ══ */}
                    {showErrors && hardErrors.length > 0 && (
                        <div className="bg-red-500/10 border border-red-500/25 rounded-xl p-3 space-y-1.5">
                            {hardErrors.map(e => (
                                <div key={e.id} className="flex items-center gap-2 text-sm text-red-300">
                                    <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                                    {e.message}
                                </div>
                            ))}
                        </div>
                    )}
                    {showErrors && warnings.length > 0 && hardErrors.length === 0 && (
                        <div className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-3 space-y-1.5">
                            {warnings.map(e => (
                                <div key={e.id} className="flex items-center gap-2 text-sm text-amber-300">
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                                    {e.message}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ══ STATS BAR ══ */}
                    <div className="flex gap-2">
                        {[
                            { label: 'Metrics', count: stats.metrics, color: 'text-emerald-400', bg: 'bg-emerald-500/10', req: true },
                            { label: 'Dimensions', count: stats.dimensions, color: 'text-violet-400', bg: 'bg-violet-500/10', req: true },
                            { label: 'Dates', count: stats.dates, color: 'text-blue-400', bg: 'bg-blue-500/10', req: false },
                            { label: 'Booleans', count: stats.booleans, color: 'text-rose-400', bg: 'bg-rose-500/10', req: false },
                            { label: 'IDs', count: stats.ids, color: 'text-amber-400', bg: 'bg-amber-500/10', req: false },
                            { label: 'Hidden', count: stats.hidden, color: 'text-gray-400', bg: 'bg-gray-500/10', req: false },
                        ].map(s => (
                            <div key={s.label} className={`${s.bg} border rounded-lg px-3 py-2 text-center flex-1 ${showErrors && s.req && s.count === 0 ? 'border-red-500/40' : 'border-white/[0.05]'
                                }`}>
                                <p className={`text-base font-bold ${showErrors && s.req && s.count === 0 ? 'text-red-400' : s.color}`}>{s.count}</p>
                                <p className="text-[10px] text-gray-500">{s.label}{s.req ? ' *' : ''}</p>
                            </div>
                        ))}
                    </div>

                    {/* ══ SEARCH & FILTER ══ */}
                    <div className="flex items-center gap-2">
                        <div className="flex-1 relative">
                            <Search className="w-3.5 h-3.5 text-gray-600 absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                                type="text"
                                value={searchFilter}
                                onChange={e => setSearchFilter(e.target.value)}
                                placeholder="Search columns..."
                                className="w-full bg-[#1c2033] border border-white/[0.06] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                            />
                        </div>
                        <div className="flex gap-1">
                            <button onClick={() => setTypeFilter('ALL')}
                                className={`px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all ${typeFilter === 'ALL' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 border border-white/[0.06]'
                                    }`}
                            >All</button>
                            {COLUMN_TYPES.filter(t => t !== ColumnType.UNKNOWN).map(t => (
                                <button key={t} onClick={() => setTypeFilter(typeFilter === t ? 'ALL' : t)}
                                    className={`px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all ${typeFilter === t ? TYPE_COLORS[t] + ' border' : 'bg-white/[0.04] text-gray-500 hover:text-gray-300 border border-white/[0.06]'
                                        }`}
                                >{t}</button>
                            ))}
                        </div>
                    </div>

                    {/* ══ COLUMN TABLE (SIMPLIFIED — critical fields only in main row) ══ */}
                    <div className="bg-[#1c2033] border border-white/[0.06] rounded-xl overflow-hidden">
                        {/* Header */}
                        <div className="grid grid-cols-[2.5fr_0.8fr_1.2fr_0.6fr_0.4fr] gap-2 px-4 py-2.5 bg-white/[0.02] border-b border-white/[0.06] text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                            <span>Column</span>
                            <span>Type</span>
                            <span>Aggregation</span>
                            <span>Confidence</span>
                            <span className="text-center">Show</span>
                        </div>

                        {/* Rows */}
                        <div className="divide-y divide-white/[0.04]">
                            {filteredColumns.map((col) => {
                                const sem = columnSemantics[col.name];
                                if (!sem) return null;
                                const isExpanded = expandedCol === col.name;
                                const roleInfo = ROLE_DISPLAY[sem.semanticRole || 'other'] || ROLE_DISPLAY.other;
                                const conf = columnConfidences[col.name] || 0;
                                const confInfo = confidenceIndicator(conf);
                                const hasAggError = showErrors && sem.role === ColumnType.METRIC && sem.aggregation === 'NONE';

                                return (
                                    <div key={col.name} className={`transition-colors ${sem.isHidden ? 'opacity-40' : ''}`}>
                                        {/* Main row — CRITICAL fields only */}
                                        <div
                                            className={`grid grid-cols-[2.5fr_0.8fr_1.2fr_0.6fr_0.4fr] gap-2 px-4 py-2.5 items-center hover:bg-white/[0.02] cursor-pointer transition-all ${isExpanded ? 'bg-white/[0.03]' : ''
                                                } ${hasAggError ? 'bg-red-500/5' : ''}`}
                                            onClick={() => setExpandedCol(isExpanded ? null : col.name)}
                                        >
                                            {/* Column Name + Label */}
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className="text-xs">{roleInfo.icon}</span>
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-white truncate">{col.name}</p>
                                                    <p className="text-[10px] text-gray-500 truncate">{sem.humanLabel}</p>
                                                </div>
                                            </div>

                                            {/* Type — inline dropdown */}
                                            <div>
                                                <select
                                                    value={sem.role}
                                                    onChange={e => {
                                                        e.stopPropagation();
                                                        const newType = e.target.value as ColumnType;
                                                        updateColumn(col.name, {
                                                            role: newType,
                                                            aggregation: newType === ColumnType.METRIC ? (sem.aggregation === 'NONE' ? 'SUM' : sem.aggregation) : 'NONE',
                                                        });
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                    className={`w-full px-1.5 py-1 rounded text-[10px] font-bold border cursor-pointer focus:outline-none focus:ring-1 focus:ring-violet-500/50 ${TYPE_COLORS[sem.role] || TYPE_COLORS.UNKNOWN}`}
                                                >
                                                    {COLUMN_TYPES.map(t => (
                                                        <option key={t} value={t} className="bg-[#1c2033] text-white font-normal">{t}</option>
                                                    ))}
                                                </select>
                                            </div>

                                            {/* Aggregation — inline, prominent for metrics */}
                                            <div>
                                                {sem.role === ColumnType.METRIC ? (
                                                    <select
                                                        value={sem.aggregation}
                                                        onChange={e => { e.stopPropagation(); updateColumn(col.name, { aggregation: e.target.value as any }); }}
                                                        onClick={e => e.stopPropagation()}
                                                        className={`w-full px-1.5 py-1 rounded text-[10px] font-bold border cursor-pointer focus:outline-none focus:ring-1 focus:ring-violet-500/50 ${hasAggError
                                                            ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                                            : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                                                            }`}
                                                    >
                                                        {AGGREGATIONS.filter(a => a !== 'NONE').map(a => (
                                                            <option key={a} value={a} className="bg-[#1c2033] text-white font-normal">{a}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <span className="text-[10px] text-gray-600 px-1.5">—</span>
                                                )}
                                            </div>

                                            {/* Confidence */}
                                            <div className="flex items-center gap-1">
                                                <span className="text-xs">{confInfo.emoji}</span>
                                                <span className={`text-[10px] ${confInfo.color}`}>{confInfo.label}</span>
                                            </div>

                                            {/* Visibility toggle */}
                                            <div className="text-center">
                                                <button
                                                    onClick={e => { e.stopPropagation(); toggleHidden(col.name); }}
                                                    className={`p-1 rounded-lg transition-all ${sem.isHidden
                                                        ? 'text-red-400/60 hover:text-red-400 hover:bg-red-500/10'
                                                        : 'text-emerald-400/60 hover:text-emerald-400 hover:bg-emerald-500/10'
                                                        }`}
                                                >
                                                    {sem.isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Expanded — SECONDARY fields */}
                                        <AnimatePresence>
                                            {isExpanded && (
                                                <motion.div
                                                    initial={{ height: 0, opacity: 0 }}
                                                    animate={{ height: 'auto', opacity: 1 }}
                                                    exit={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.15 }}
                                                    className="overflow-hidden"
                                                >
                                                    <div className="px-6 py-3 bg-white/[0.02] border-t border-white/[0.04]">
                                                        <div className="flex items-center gap-2 mb-2">
                                                            <PenLine className="w-3 h-3 text-violet-400" />
                                                            <span className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">Advanced Settings</span>
                                                        </div>
                                                        <div className="grid grid-cols-4 gap-3">
                                                            {/* Semantic Role */}
                                                            <div>
                                                                <label className="text-[10px] text-gray-600 uppercase tracking-wider block mb-1">Semantic Role</label>
                                                                <select
                                                                    value={sem.semanticRole || 'other'}
                                                                    onChange={e => updateColumn(col.name, { semanticRole: e.target.value })}
                                                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                                >
                                                                    {SEMANTIC_ROLES.map(r => (
                                                                        <option key={r} value={r} className="bg-[#1c2033]">{ROLE_DISPLAY[r]?.label || r}</option>
                                                                    ))}
                                                                </select>
                                                            </div>
                                                            {/* Format */}
                                                            <div>
                                                                <label className="text-[10px] text-gray-600 uppercase tracking-wider block mb-1">Format</label>
                                                                <select
                                                                    value={sem.format}
                                                                    onChange={e => updateColumn(col.name, { format: e.target.value as any })}
                                                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                                >
                                                                    {FORMATS.map(f => (
                                                                        <option key={f} value={f} className="bg-[#1c2033]">{f}</option>
                                                                    ))}
                                                                </select>
                                                            </div>
                                                            {/* Label */}
                                                            <div>
                                                                <label className="text-[10px] text-gray-600 uppercase tracking-wider block mb-1">Display Label</label>
                                                                <input type="text" value={sem.humanLabel}
                                                                    onChange={e => updateColumn(col.name, { humanLabel: e.target.value })}
                                                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                                />
                                                            </div>
                                                            {/* Description */}
                                                            <div>
                                                                <label className="text-[10px] text-gray-600 uppercase tracking-wider block mb-1">Description</label>
                                                                <input type="text" value={sem.description}
                                                                    onChange={e => updateColumn(col.name, { description: e.target.value })}
                                                                    placeholder="What does this column represent?"
                                                                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                );
                            })}

                            {filteredColumns.length === 0 && (
                                <div className="px-4 py-6 text-center text-gray-500 text-sm">
                                    No columns match the current filter.
                                </div>
                            )}
                        </div>
                    </div>



                    {/* ══ PREVIEW BEFORE COMMIT ══ */}
                    <div className="bg-[#1c2033] border border-white/[0.06] rounded-xl overflow-hidden">
                        <button
                            onClick={() => setShowPreview(!showPreview)}
                            className="w-full flex items-center justify-between px-4 py-3 bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <ShieldCheck className="w-4 h-4 text-violet-400" />
                                <span className="text-sm font-medium text-gray-300">Preview — What will happen</span>
                            </div>
                            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showPreview ? 'rotate-180' : ''}`} />
                        </button>
                        <AnimatePresence>
                            {showPreview && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                    className="overflow-hidden"
                                >
                                    <div className="px-4 pb-4 pt-2 space-y-3">
                                        {/* Grain */}
                                        <div className="flex items-center gap-2">
                                            <Layers className="w-3.5 h-3.5 text-violet-400" />
                                            <span className="text-xs text-gray-400">Grain:</span>
                                            <span className="text-xs text-white font-medium">{previewData.grain || '(not set)'}</span>
                                        </div>

                                        {/* Metrics */}
                                        <div>
                                            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Metrics ({previewData.metricList.length})</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {previewData.metricList.map(m => (
                                                    <span key={m} className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{m}</span>
                                                ))}
                                                {previewData.metricList.length === 0 && <span className="text-[10px] text-red-400">None — at least 1 required</span>}
                                            </div>
                                        </div>

                                        {/* Dimensions */}
                                        <div>
                                            <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Dimensions ({previewData.dimensionList.length})</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {previewData.dimensionList.map(d => (
                                                    <span key={d} className="px-2 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">{d}</span>
                                                ))}
                                                {previewData.dimensionList.length === 0 && <span className="text-[10px] text-red-400">None — at least 1 required</span>}
                                            </div>
                                        </div>

                                        {/* Dates */}
                                        {previewData.dateList.length > 0 && (
                                            <div>
                                                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Dates ({previewData.dateList.length})</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {previewData.dateList.map(d => (
                                                        <span key={d} className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">{d}</span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Sample question */}
                                        {previewData.sampleQuestion && (
                                            <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg p-3">
                                                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sample question that will work</p>
                                                <p className="text-sm text-violet-300 font-medium">"{previewData.sampleQuestion}"</p>
                                            </div>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <div className="h-4" />
                </div>
            </div>

            {/* ── BOTTOM ACTION BAR ── */}
            <div className="flex-shrink-0 border-t border-white/[0.06] bg-[#141824] px-6 py-3">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div className="text-xs text-gray-400">
                        {columns.length} columns · <span className="text-violet-400 font-medium">{domain}</span>
                        {grain && <> · Grain: <span className="text-white">{grain}</span></>}
                        {hardErrors.length > 0 && <span className="text-red-400 ml-2">· {hardErrors.length} error{hardErrors.length > 1 ? 's' : ''}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={onDismiss}
                            className="px-3 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-gray-300 font-medium text-xs transition-all border border-white/[0.06]"
                        >Skip</button>
                        <button
                            onClick={handleApply}
                            disabled={showErrors && !canApply}
                            className={`flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-all shadow-lg ${showErrors && !canApply
                                ? 'bg-gray-600/50 text-gray-400 cursor-not-allowed shadow-none'
                                : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-violet-500/20'
                                }`}
                        >
                            <CheckCircle2 className="w-4 h-4" />
                            Apply & Continue
                            <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
