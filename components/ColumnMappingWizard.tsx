import React, { useState, useMemo, useCallback } from 'react';
import {
    CheckCircle2, Eye, EyeOff, AlertTriangle, RotateCcw, Search, ChevronDown, XCircle,
} from 'lucide-react';
import { DatasetDomainProfile, ColumnSemantic, ColumnType, ColumnDefinition } from '../types';
import { nameDirection } from '../services/columnDictionary';
import { inferDefaultAggregationForGrain } from '../services/smartAggregation';
import { inferRowGrain } from '../services/rowGrainInference';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const ALL_DOMAINS = [
    'Sales', 'HR', 'Finance', 'Healthcare', 'Inventory', 'SaaS',
    'Education', 'Marketing', 'Logistics', 'Real_Estate', 'Manufacturing',
    'Insurance', 'Hospitality', 'Retail', 'Telecom', 'Agriculture',
    'Energy', 'Government', 'Legal', 'Other'
];


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

const AGG_WORD: Record<string, string> = { SUM: 'Sum', AVG: 'Average', COUNT: 'Count', COUNT_DISTINCT: 'Count distinct', MIN: 'Minimum', MAX: 'Maximum' };
const FORMAT_WORD: Record<string, string> = { currency_usd: 'US dollars', currency_eur: 'Euros', percent: 'Percent', raw: 'Plain number', count: 'Count', date_iso: 'Date' };

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
    // Without an AI opinion the role comes from the cleaning's own profiling,
    // which is usually right: start in the middle and let the name decide.
    let score = aiSem ? aiProfile.confidence : 0.55;
    // Type match bonus
    if (aiSem && aiSem.role === sem.role) score = Math.min(1, score + 0.1);
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
    const inferredGrain = useMemo(() => inferRowGrain(
        [],
        columns,
        fileName,
        initialProfile.domain,
        initialProfile.columnSemantics,
    ), [columns, fileName, initialProfile.domain, initialProfile.columnSemantics]);
    const initialGrain = initialProfile.grain || inferredGrain.label;
    const [domain, setDomain] = useState(initialProfile.domain);
    const [subDomain, setSubDomain] = useState(initialProfile.subDomain || '');
    const [grain, setGrain] = useState(initialGrain);
    const [grainWasEdited, setGrainWasEdited] = useState(initialProfile.grainSource === 'user');
    const [showPreview, setShowPreview] = useState(false);

    const [columnSemantics, setColumnSemantics] = useState<Record<string, ColumnSemantic>>(() => {
        const merged: Record<string, ColumnSemantic> = {};
        for (const col of columns) {
            const existing = initialProfile.columnSemantics?.[col.name];
            merged[col.name] = existing || {
                role: col.type,
                aggregation: inferDefaultAggregationForGrain(col.name, col.type, columns, fileName) as ColumnSemantic['aggregation'],
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
    const [showDetails, setShowDetails] = useState(false);

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
    const validationErrors = useMemo(() => validateMapping(columnSemantics), [columnSemantics]);
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
        setGrain(initialGrain);
        setGrainWasEdited(initialProfile.grainSource === 'user');
        const merged: Record<string, ColumnSemantic> = {};
        for (const col of columns) {
            const existing = initialProfile.columnSemantics?.[col.name];
            merged[col.name] = existing || {
                role: col.type,
                aggregation: inferDefaultAggregationForGrain(col.name, col.type, columns, fileName) as ColumnSemantic['aggregation'],
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
            grain: grain.trim() || inferredGrain.label,
            grainConfidence: grainWasEdited ? 1 : (initialProfile.grainConfidence ?? inferredGrain.confidence),
            grainSource: grainWasEdited ? 'user' : (initialProfile.grainSource ?? inferredGrain.source),
            grainEvidence: grainWasEdited
                ? ['Adjusted by the user in advanced row-detail settings']
                : (initialProfile.grainEvidence ?? inferredGrain.evidence),
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

    const toCheck = columns.filter(col => (columnConfidences[col.name] ?? 0) < 0.45);
    const lookRight = columns.length - toCheck.length;
    const ROLE_WORD: Record<string, string> = { METRIC: 'Measure', DIMENSION: 'Dimension', DATE: 'Date', BOOLEAN: 'Yes/No', ID: 'ID', UNKNOWN: 'Unknown' };
    const FILTER_WORD: Record<string, string> = { METRIC: 'Measures', DIMENSION: 'Dimensions', DATE: 'Dates', BOOLEAN: 'Yes/No', ID: 'IDs' };

    return (
        <div className="qi-map h-full flex flex-col overflow-hidden">
            {/* ── Header ── */}
            <div className="qi-ws-toolbar flex-shrink-0 px-5 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                    <h3 className="qi-ws-strong text-[15px] font-semibold">Review column mapping</h3>
                    <p className="qi-ws-muted text-[12.5px] mt-0.5 truncate">
                        {isAIProfiling
                            ? 'Working out what each column means…'
                            : 'Check what each column is. Measures are added up; dimensions group and filter; dates drive trends.'}
                    </p>
                </div>
                <button type="button" onClick={resetToAI} className="qi-ws-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold" title="Undo your edits and go back to the detected mapping">
                    <RotateCcw className="w-3.5 h-3.5" /> Reset
                </button>
            </div>

            {/* ── Body ── */}
            <div className="flex-1 overflow-y-auto">
                <div className="px-5 py-4 space-y-4">
                    {/* Summary: subject · how many columns look right */}
                    <div className="qi-ws-subcard qi-ws-facts rounded-lg grid grid-cols-1 md:grid-cols-2">
                        <div className="px-4 py-3">
                            <label className="qi-ws-muted text-[12px] block" htmlFor="qi-map-domain">Subject</label>
                            <select id="qi-map-domain" value={domain} onChange={e => setDomain(e.target.value)} className="qi-ws-select mt-1 w-full rounded-md px-2.5 py-1.5 text-[13px]">
                                {ALL_DOMAINS.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
                            </select>
                            {subDomain && <p className="qi-ws-muted text-[11.5px] mt-1">{subDomain}</p>}
                        </div>
                        <div className="px-4 py-3">
                            <div className="qi-ws-muted text-[12px]">Columns</div>
                            <div className="qi-ws-strong text-[14px] font-semibold mt-0.5">
                                {toCheck.length === 0 ? `All ${columns.length} look right` : `${lookRight} of ${columns.length} look right`}
                            </div>
                            {toCheck.length > 0 && (
                                <button type="button" onClick={() => setShowDetails(v => !v)} className="qi-ws-link text-[12.5px] font-semibold">
                                    {showDetails ? 'Hide' : `${toCheck.length} to check`}
                                </button>
                            )}
                            {showDetails && toCheck.length > 0 && (
                                <ul className="mt-1.5 space-y-0.5 text-[12px]">
                                    {toCheck.slice(0, 8).map(col => (
                                        <li key={col.name}>
                                            <button type="button" className="qi-ws-link" onClick={() => { setSearchFilter(col.name); setTypeFilter('ALL'); setExpandedCol(col.name); }}>{col.name}</button>
                                            <span className="qi-ws-muted"> — {columnSemantics[col.name]?.role === ColumnType.ID ? 'may not be an ID' : 'unusual name; confirm its role'}</span>
                                        </li>
                                    ))}
                                    {toCheck.length > 8 && <li className="qi-ws-muted">and {toCheck.length - 8} more</li>}
                                </ul>
                            )}
                        </div>
                    </div>

                    {/* Validation */}
                    {showErrors && (hardErrors.length > 0 || warnings.length > 0) && (
                        <ul className="space-y-1">
                            {(hardErrors.length > 0 ? hardErrors : warnings).map(e => (
                                <li key={e.id} className={`qi-issue is-${e.severity === 'error' ? 'critical' : 'warning'} flex items-start gap-2 text-[12.5px]`}>
                                    {e.severity === 'error' ? <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                                    <span>{e.message}</span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* Search, role filter and counts */}
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="qi-ws-field flex items-center gap-2 flex-1 min-w-[180px] rounded-lg px-2.5 py-1.5">
                            <Search className="qi-ws-muted w-4 h-4 shrink-0" />
                            <input type="text" value={searchFilter} onChange={e => setSearchFilter(e.target.value)} placeholder="Search columns" className="bg-transparent outline-none text-[13px] flex-1 min-w-0" aria-label="Search columns" />
                        </label>
                        <div className="qi-ws-segmented inline-flex flex-wrap rounded-lg p-0.5" role="group" aria-label="Show columns by role">
                            <button type="button" aria-pressed={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')} className={`px-2.5 py-1 rounded-md text-[12px] font-semibold ${typeFilter === 'ALL' ? 'is-active' : ''}`}>
                                All <span className="qi-ws-count">{columns.length}</span>
                            </button>
                            {([ColumnType.METRIC, ColumnType.DIMENSION, ColumnType.DATE, ColumnType.BOOLEAN, ColumnType.ID] as ColumnType[]).map(t => {
                                const n = t === ColumnType.METRIC ? stats.metrics : t === ColumnType.DIMENSION ? stats.dimensions : t === ColumnType.DATE ? stats.dates : t === ColumnType.BOOLEAN ? stats.booleans : stats.ids;
                                const required = t === ColumnType.METRIC || t === ColumnType.DIMENSION;
                                if (n === 0 && !required) return null;
                                const missing = showErrors && required && n === 0;
                                return (
                                    <button key={t} type="button" aria-pressed={typeFilter === t} onClick={() => setTypeFilter(typeFilter === t ? 'ALL' : t)} className={`px-2.5 py-1 rounded-md text-[12px] font-semibold ${typeFilter === t ? 'is-active' : ''} ${missing ? 'qi-ws-warn' : ''}`} title={missing ? 'At least one is needed' : undefined}>
                                        {FILTER_WORD[t]} <span className="qi-ws-count">{n}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {stats.hidden > 0 && <span className="qi-ws-muted text-[12px]">{stats.hidden} hidden</span>}
                    </div>

                    {/* Column table */}
                    <div className="qi-ws-subcard rounded-lg overflow-hidden">
                        <div className="qi-ws-thead grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_3rem] gap-3 px-4 py-2 text-[11.5px] font-semibold">
                            <span>Column</span>
                            <span>Role</span>
                            <span>Combine by</span>
                            <span>Confidence</span>
                            <span className="text-center">Show</span>
                        </div>
                        <div className="qi-ws-list">
                            {filteredColumns.map(col => {
                                const sem = columnSemantics[col.name];
                                if (!sem) return null;
                                const isExpanded = expandedCol === col.name;
                                const conf = columnConfidences[col.name] || 0;
                                const confInfo = confidenceIndicator(conf);
                                const hasAggError = showErrors && sem.role === ColumnType.METRIC && sem.aggregation === 'NONE';
                                return (
                                    <div key={col.name} className={sem.isHidden ? 'opacity-50' : ''}>
                                        <div
                                            className={`qi-ws-row grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_3rem] gap-3 px-4 py-2 items-center ${isExpanded ? 'is-open' : ''}`}
                                            onClick={() => setExpandedCol(isExpanded ? null : col.name)}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <ChevronDown className={`qi-ws-muted w-3.5 h-3.5 shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                                                <div className="min-w-0">
                                                    <p className="qi-ws-strong text-[13px] font-medium truncate">{col.name}</p>
                                                    {sem.humanLabel && sem.humanLabel.toLowerCase().replace(/\s+/g, '_') !== col.name.toLowerCase() && (
                                                        <p className="qi-ws-muted text-[11.5px] truncate">{sem.humanLabel}</p>
                                                    )}
                                                </div>
                                            </div>
                                            <select
                                                value={sem.role}
                                                onClick={e => e.stopPropagation()}
                                                onChange={e => {
                                                    const newType = e.target.value as ColumnType;
                                                    updateColumn(col.name, {
                                                        role: newType,
                                                        aggregation: newType === ColumnType.METRIC ? (sem.aggregation === 'NONE' ? 'SUM' : sem.aggregation) : 'NONE',
                                                    });
                                                }}
                                                className="qi-ws-select w-full rounded-md px-2 py-1 text-[12.5px]"
                                                aria-label={`Role of ${col.name}`}
                                            >
                                                {COLUMN_TYPES.map(t => <option key={t} value={t}>{ROLE_WORD[t] || t}</option>)}
                                            </select>
                                            {sem.role === ColumnType.METRIC ? (
                                                <select
                                                    value={sem.aggregation}
                                                    onClick={e => e.stopPropagation()}
                                                    onChange={e => updateColumn(col.name, { aggregation: e.target.value as any })}
                                                    className={`qi-ws-select w-full rounded-md px-2 py-1 text-[12.5px] ${hasAggError ? 'is-error' : ''}`}
                                                    aria-label={`How to combine ${col.name}`}
                                                >
                                                    {AGGREGATIONS.filter(a => a !== 'NONE').map(a => <option key={a} value={a}>{AGG_WORD[a] || a}</option>)}
                                                </select>
                                            ) : <span className="qi-ws-muted text-[12px]">—</span>}
                                            <span className={`qi-conf is-${confInfo.label.toLowerCase()} text-[12px]`}>{confInfo.label}</span>
                                            <div className="text-center">
                                                <button
                                                    type="button"
                                                    onClick={e => { e.stopPropagation(); toggleHidden(col.name); }}
                                                    className="qi-step-chevron p-1 rounded-md"
                                                    aria-label={sem.isHidden ? `Show ${col.name}` : `Hide ${col.name}`}
                                                    title={sem.isHidden ? 'Hidden from questions and charts — click to show' : 'Hide from questions and charts'}
                                                >
                                                    {sem.isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                </button>
                                            </div>
                                        </div>
                                        {isExpanded && (
                                            <div className="qi-ws-detail px-4 pb-4 pt-2 pl-10">
                                                <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px] mb-3">
                                                    <div><dt className="qi-ws-muted">Uploaded as</dt><dd className="font-mono">{col.conversion?.sourceType || col.originalType || 'unknown'}</dd></div>
                                                    <div><dt className="qi-ws-muted">Stored as</dt><dd className="font-mono">{col.physicalType || 'unknown'}</dd></div>
                                                    <div><dt className="qi-ws-muted">Read as</dt><dd className="font-mono">{col.conversion?.normalizedType || 'not checked'}</dd></div>
                                                    <div><dt className="qi-ws-muted">Read correctly</dt><dd className={(col.conversion?.invalidCount || 0) > 0 ? 'qi-ws-warn' : ''}>{col.conversion ? `${Math.round(col.conversion.parseSuccessRate * 100)}%${col.conversion.invalidCount ? ` · ${col.conversion.invalidCount} not read` : ''}` : '—'}</dd></div>
                                                </dl>
                                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">Importance</span>
                                                        <select value={sem.semanticRole || 'other'} onChange={e => updateColumn(col.name, { semanticRole: e.target.value })} className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]">
                                                            {SEMANTIC_ROLES.map(r => <option key={r} value={r}>{ROLE_DISPLAY[r]?.label || r}</option>)}
                                                        </select>
                                                    </label>
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">Format</span>
                                                        <select value={sem.format} onChange={e => updateColumn(col.name, { format: e.target.value as any })} className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]">
                                                            {FORMATS.map(f => <option key={f} value={f}>{FORMAT_WORD[f] || f}</option>)}
                                                        </select>
                                                    </label>
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">Display name</span>
                                                        <input type="text" value={sem.humanLabel} onChange={e => updateColumn(col.name, { humanLabel: e.target.value })} className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]" />
                                                    </label>
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">What it means</span>
                                                        <input type="text" value={sem.description} onChange={e => updateColumn(col.name, { description: e.target.value, meaningSource: 'user' })} placeholder="What does this column hold?" className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]" />
                                                    </label>
                                                </div>
                                                {/* The column's meaning, used for every question: which way is good, and what people call it. */}
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">Higher is</span>
                                                        <select value={sem.goodDirection || nameDirection(col.name, sem.role) || ''} onChange={e => updateColumn(col.name, { goodDirection: (e.target.value || undefined) as ColumnSemantic['goodDirection'], meaningSource: 'user' })} className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]" aria-label={`Is a higher ${col.name} better or worse`}>
                                                            <option value="">Not set</option>
                                                            <option value="higher">Better (like sales)</option>
                                                            <option value="lower">Worse (like costs or complaints)</option>
                                                            <option value="neutral">Neither</option>
                                                        </select>
                                                    </label>
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">Below zero means</span>
                                                        <input type="text" value={sem.negativeMeans || ''} onChange={e => updateColumn(col.name, { negativeMeans: e.target.value, meaningSource: 'user' })} placeholder="e.g. spent more than budgeted" className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]" />
                                                    </label>
                                                    <label className="text-[12px]"><span className="qi-ws-muted block mb-1">People call it</span>
                                                        <input type="text" value={(sem.aliases || []).join(', ')} onChange={e => updateColumn(col.name, { aliases: e.target.value.split(/,\s*/), meaningSource: 'user' })} placeholder="e.g. over budget, losses" className="qi-ws-select w-full rounded-md px-2 py-1.5 text-[12.5px]" />
                                                    </label>
                                                </div>
                                                <p className="qi-ws-muted text-[11.5px] mt-2">{sem.meaningSource === 'user' ? 'Set by you: used for every question and remembered for this kind of file.' : sem.meaningSource === 'ai' ? 'Written from the column names only (never your values). Correct anything that is wrong; your words are used from then on.' : 'Worked out from the column name and how it is calculated. Correct anything that is wrong.'}</p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {filteredColumns.length === 0 && (
                                <div className="qi-ws-muted px-4 py-6 text-center text-[13px]">No columns match.</div>
                            )}
                        </div>
                    </div>

                    {/* Preview */}
                    <div className="qi-ws-subcard rounded-lg">
                        <button type="button" onClick={() => setShowPreview(!showPreview)} className="w-full flex items-center justify-between px-4 py-2.5" aria-expanded={showPreview}>
                            <span className="qi-ws-strong text-[13px] font-semibold">What questions will use</span>
                            <ChevronDown className={`qi-ws-muted w-4 h-4 transition-transform ${showPreview ? 'rotate-180' : ''}`} />
                        </button>
                        {showPreview && (
                            <div className="px-4 pb-4 space-y-2 text-[12.5px]">
                                <p><span className="qi-ws-muted">Measures: </span>{previewData.metricList.join(', ') || <span className="qi-ws-warn">none — at least one is needed</span>}</p>
                                <p><span className="qi-ws-muted">Dimensions: </span>{previewData.dimensionList.join(', ') || <span className="qi-ws-warn">none — at least one is needed</span>}</p>
                                {previewData.dateList.length > 0 && <p><span className="qi-ws-muted">Dates: </span>{previewData.dateList.join(', ')}</p>}
                                {previewData.sampleQuestion && <p><span className="qi-ws-muted">A question that will work: </span><span className="qi-ws-strong">“{previewData.sampleQuestion}”</span></p>}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Actions ── */}
            <div className="qi-ws-toolbar is-bottom flex-shrink-0 px-5 py-3 flex items-center gap-3">
                <p className="qi-ws-muted text-[12.5px] flex-1 min-w-0 truncate">
                    {columns.length} columns · {domain.replace(/_/g, ' ')}
                    {hardErrors.length > 0 && showErrors && <span className="qi-ws-warn"> · {hardErrors.length} to fix</span>}
                </p>
                <button type="button" onClick={onDismiss} className="qi-ws-ghost px-3 py-1.5 rounded-lg text-[13px] font-semibold">Skip</button>
                <button
                    type="button"
                    onClick={handleApply}
                    disabled={showErrors && !canApply}
                    className="qi-ws-button inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <CheckCircle2 className="w-4 h-4" /> Apply & Continue
                </button>
            </div>
        </div>
    );
};
