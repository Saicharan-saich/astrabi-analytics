import React, { useMemo, useState } from 'react';
import {
    Database, Columns, BarChart3, Hash, Calendar, Type, Key,
    TrendingUp, TrendingDown, ChevronDown, ChevronRight, Layers,
    FileText, Eye, Table2, Sparkles, Wand2, GitMerge
} from 'lucide-react';
import { Dataset, DatasetDomainProfile, ColumnType } from '../types';
import { CleaningLogEntry } from '../services/dataCleaningEngine';
import { DataExplorerView } from './DataExplorerView';
import { ETLView } from './ETLView';
import { DataStudioView } from './DataStudioView';
import { SchemaView } from './SchemaView';
import { ColumnMappingWizard } from './ColumnMappingWizard';

type DatasetWorkspaceSection = 'overview' | 'explore' | 'cleaned' | 'studio' | 'mapping' | 'schema';

interface DatasetSummaryViewProps {
    dataset: Dataset | null;
    /** Lets legacy entry points open the corresponding workspace section directly. */
    initialSection?: DatasetWorkspaceSection;
    mappingProfile?: DatasetDomainProfile | null;
    isAIProfiling?: boolean;
    onApplyMapping?: (updatedProfile: DatasetDomainProfile, columnTypeOverrides: Record<string, ColumnType>) => void;
    onDismissMapping?: () => void;
    onSchemaOverride?: (columnName: string, newType: ColumnType) => void;
    onRowsRecovered?: (recoveredRows: Record<string, any>[]) => void;
    onDataCleaned?: (newRows: Record<string, any>[], log: CleaningLogEntry) => void;
    onSwitchToLive?: () => void;
}

interface ColumnStats {
    name: string;
    type: string;
    count: number;
    unique: number;
    nullCount: number;
    nullPct: number;
    min?: number | string;
    max?: number | string;
    sum?: number;
    mean?: number;
    median?: number;
    stdDev?: number;
    topValues?: { value: string; count: number }[];
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
    METRIC: <Hash className="w-3.5 h-3.5" />,
    DIMENSION: <Type className="w-3.5 h-3.5" />,
    DATE: <Calendar className="w-3.5 h-3.5" />,
    ID: <Key className="w-3.5 h-3.5" />,
};

const TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
    METRIC: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
    DIMENSION: { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/20' },
    DATE: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20' },
    ID: { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/20' },
};

function computeColumnStats(rows: Record<string, any>[], colName: string, colType: string): ColumnStats {
    const values = rows.map(r => r[colName]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    const count = values.length;
    const nullCount = count - nonNull.length;
    const nullPct = count > 0 ? (nullCount / count) * 100 : 0;
    const uniqueSet = new Set(nonNull.map(String));
    const unique = uniqueSet.size;

    const stats: ColumnStats = { name: colName, type: colType, count, unique, nullCount, nullPct };

    if (colType === 'METRIC') {
        const nums = nonNull.map(Number).filter(n => !isNaN(n));
        if (nums.length > 0) {
            nums.sort((a, b) => a - b);
            stats.min = nums[0];
            stats.max = nums[nums.length - 1];
            stats.sum = nums.reduce((s, n) => s + n, 0);
            stats.mean = stats.sum / nums.length;
            const mid = Math.floor(nums.length / 2);
            stats.median = nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
            const variance = nums.reduce((s, n) => s + Math.pow(n - stats.mean!, 2), 0) / nums.length;
            stats.stdDev = Math.sqrt(variance);
        }
    } else if (colType === 'DATE') {
        const dates = nonNull.map(v => new Date(v)).filter(d => !isNaN(d.getTime()));
        if (dates.length > 0) {
            dates.sort((a, b) => a.getTime() - b.getTime());
            stats.min = dates[0].toISOString().split('T')[0];
            stats.max = dates[dates.length - 1].toISOString().split('T')[0];
        }
    }

    // Top values for categorical
    if (colType === 'DIMENSION' || colType === 'ID') {
        const freq = new Map<string, number>();
        nonNull.forEach(v => {
            const s = String(v);
            freq.set(s, (freq.get(s) || 0) + 1);
        });
        stats.topValues = Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, count]) => ({ value, count }));
    }

    return stats;
}

function formatNum(n: number | undefined): string {
    if (n === undefined) return '—';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
    return n.toFixed(2);
}

const ColumnCard: React.FC<{ stat: ColumnStats; totalRows: number }> = ({ stat, totalRows }) => {
    const [expanded, setExpanded] = useState(false);
    const color = TYPE_COLORS[stat.type] || TYPE_COLORS.DIMENSION;
    const icon = TYPE_ICONS[stat.type] || <Type className="w-3.5 h-3.5" />;
    const fillPct = totalRows > 0 ? ((totalRows - stat.nullCount) / totalRows) * 100 : 0;

    return (
        <div
            className={`bg-white dark:bg-[#171c26] border ${color.border} rounded-xl overflow-hidden hover:shadow-md transition-all duration-200`}
        >
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-7 h-7 rounded-lg ${color.bg} flex items-center justify-center shrink-0 ${color.text}`}>
                        {icon}
                    </div>
                    <div className="min-w-0">
                        <h4 className="text-sm font-bold text-gray-900 dark:text-white truncate">{stat.name}</h4>
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${color.text}`}>{stat.type}</span>
                    </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs font-medium text-slate-400">
                        {stat.unique} unique
                    </span>
                    {expanded
                        ? <ChevronDown className="w-4 h-4 text-slate-400" />
                        : <ChevronRight className="w-4 h-4 text-slate-400" />}
                </div>
            </button>

            {/* Data completeness bar */}
            <div className="px-4 pb-2">
                <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                    <span>{fillPct.toFixed(0)}% filled</span>
                    <span>{stat.nullCount} nulls</span>
                </div>
                <div className="h-1.5 bg-slate-100 dark:bg-slate-700/50 rounded-full overflow-hidden">
                    <div
                        className={`h-full rounded-full transition-all duration-500 ${fillPct > 90 ? 'bg-emerald-500' : fillPct > 70 ? 'bg-amber-500' : 'bg-red-500'
                            }`}
                        style={{ width: `${fillPct}%` }}
                    />
                </div>
            </div>

            {/* Expanded details */}
            {expanded && (
                <div className="px-4 pb-4 pt-2 border-t border-slate-100 dark:border-white/5 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    {stat.type === 'METRIC' && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            {[
                                { label: 'Min', value: formatNum(stat.min as number) },
                                { label: 'Max', value: formatNum(stat.max as number) },
                                { label: 'Sum', value: formatNum(stat.sum) },
                                { label: 'Mean', value: formatNum(stat.mean) },
                                { label: 'Median', value: formatNum(stat.median) },
                                { label: 'Std Dev', value: formatNum(stat.stdDev) },
                            ].map(item => (
                                <div key={item.label} className="bg-slate-50 dark:bg-slate-800/60 rounded-lg px-2.5 py-2 text-center">
                                    <div className="text-[10px] text-slate-400 font-medium">{item.label}</div>
                                    <div className="text-xs font-bold text-gray-900 dark:text-white">{item.value}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {stat.type === 'DATE' && (
                        <div className="grid grid-cols-2 gap-2">
                            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                                <div className="text-[10px] text-slate-400 font-medium">Earliest</div>
                                <div className="text-xs font-bold text-gray-900 dark:text-white">{stat.min || '—'}</div>
                            </div>
                            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                                <div className="text-[10px] text-slate-400 font-medium">Latest</div>
                                <div className="text-xs font-bold text-gray-900 dark:text-white">{stat.max || '—'}</div>
                            </div>
                        </div>
                    )}

                    {stat.topValues && stat.topValues.length > 0 && (
                        <div>
                            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-2">Top Values</div>
                            <div className="space-y-1.5">
                                {stat.topValues.map((tv, i) => {
                                    const barW = stat.topValues![0].count > 0
                                        ? (tv.count / stat.topValues![0].count) * 100
                                        : 0;
                                    return (
                                        <div key={i} className="flex items-center gap-2">
                                            <span className="text-xs text-gray-700 dark:text-slate-300 font-medium truncate min-w-[80px] max-w-[140px]">
                                                {tv.value}
                                            </span>
                                            <div className="flex-1 h-4 bg-slate-100 dark:bg-slate-700/40 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-violet-500/30 dark:bg-violet-500/20 rounded-full flex items-center justify-end pr-1"
                                                    style={{ width: `${barW}%`, minWidth: '20px' }}
                                                >
                                                    <span className="text-[9px] font-bold text-violet-600 dark:text-violet-300">
                                                        {tv.count}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export const DatasetSummaryView: React.FC<DatasetSummaryViewProps> = ({
    dataset,
    initialSection = 'overview',
    mappingProfile,
    isAIProfiling = false,
    onApplyMapping,
    onDismissMapping,
    onSchemaOverride,
    onRowsRecovered,
    onDataCleaned,
    onSwitchToLive,
}) => {
    const [activeSection, setActiveSection] = useState<DatasetWorkspaceSection>(initialSection);
    const columnStats = useMemo(() => {
        if (!dataset?.rows || !dataset?.columns) return [];
        return dataset.columns.map(col =>
            computeColumnStats(dataset.rows, col.name, col.type)
        );
    }, [dataset]);

    const overviewStats = useMemo(() => {
        if (!dataset) return null;
        const rows = dataset.rows?.length || 0;
        const cols = dataset.columns?.length || 0;
        const metrics = dataset.columns?.filter(c => c.type === 'METRIC').length || 0;
        const dimensions = dataset.columns?.filter(c => c.type === 'DIMENSION').length || 0;
        const dates = dataset.columns?.filter(c => c.type === 'DATE').length || 0;
        const ids = dataset.columns?.filter(c => c.type === 'ID').length || 0;
        const totalCells = rows * cols;
        const nullCells = columnStats.reduce((s, c) => s + c.nullCount, 0);
        const completeness = totalCells > 0 ? ((totalCells - nullCells) / totalCells) * 100 : 100;
        return { rows, cols, metrics, dimensions, dates, ids, completeness };
    }, [dataset, columnStats]);

    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
                <Database className="w-16 h-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Please load a dataset to see its summary.</p>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto bg-gray-50 dark:bg-slate-900">
            <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">

                {/* Header */}
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg">
                        <Database className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
                            Dataset Workspace
                        </h2>
                        <p className="text-sm text-gray-500 dark:text-slate-400">
                            {dataset.name || 'Unnamed Dataset'} · {overviewStats?.rows.toLocaleString()} rows · {overviewStats?.cols} columns
                        </p>
                    </div>
                </div>

                {/* Workspace Sections */}
                <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-white dark:bg-[#171c26] border border-gray-200 dark:border-white/[0.06] shadow-sm">
                    {[
                        { id: 'overview' as const, label: 'Overview', icon: BarChart3, active: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300' },
                        { id: 'explore' as const, label: 'Explore Data', icon: Table2, active: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
                        { id: 'cleaned' as const, label: 'Cleaned Data', icon: Sparkles, active: 'bg-teal-50 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300' },
                        { id: 'studio' as const, label: 'Data Studio', icon: Wand2, active: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300' },
                        { id: 'mapping' as const, label: 'Column Mapping', icon: Eye, active: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' },
                        { id: 'schema' as const, label: 'Schema', icon: GitMerge, active: 'bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300' },
                    ].map(({ id, label, icon: Icon, active }) => (
                        <button
                            key={id}
                            onClick={() => setActiveSection(id)}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-bold transition-all ${activeSection === id
                                ? `${active} shadow-sm`
                                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.04]'}`}
                        >
                            <Icon className="w-4 h-4" /> {label}
                        </button>
                    ))}
                </div>

                {activeSection === 'overview' && (
                    <>
                {/* Overview KPI Cards */}
                {overviewStats && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        {[
                            { label: 'Total Rows', value: overviewStats.rows.toLocaleString(), icon: <Layers className="w-4 h-4" />, color: 'from-blue-500 to-cyan-500' },
                            { label: 'Columns', value: String(overviewStats.cols), icon: <Columns className="w-4 h-4" />, color: 'from-violet-500 to-purple-500' },
                            { label: 'Metrics', value: String(overviewStats.metrics), icon: <Hash className="w-4 h-4" />, color: 'from-emerald-500 to-teal-500' },
                            { label: 'Dimensions', value: String(overviewStats.dimensions), icon: <Type className="w-4 h-4" />, color: 'from-amber-500 to-orange-500' },
                            { label: 'Date Fields', value: String(overviewStats.dates), icon: <Calendar className="w-4 h-4" />, color: 'from-rose-500 to-pink-500' },
                            { label: 'Completeness', value: `${overviewStats.completeness.toFixed(1)}%`, icon: <Eye className="w-4 h-4" />, color: overviewStats.completeness > 90 ? 'from-emerald-500 to-green-500' : 'from-amber-500 to-red-500' },
                        ].map(kpi => (
                            <div key={kpi.label} className="bg-white dark:bg-[#171c26] rounded-xl border border-gray-200 dark:border-white/[0.06] p-4 hover:shadow-md transition-all">
                                <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${kpi.color} flex items-center justify-center text-white mb-2`}>
                                    {kpi.icon}
                                </div>
                                <div className="text-xl font-black text-gray-900 dark:text-white">{kpi.value}</div>
                                <div className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{kpi.label}</div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Column breakdown */}
                <div>
                    <h3 className="text-sm font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                        <FileText className="w-4 h-4" />
                        Column Details — Click to expand
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {columnStats.map(stat => (
                            <ColumnCard key={stat.name} stat={stat} totalRows={overviewStats?.rows || 0} />
                        ))}
                    </div>
                </div>
                    </>
                )}

                {activeSection === 'explore' && (
                    <div className="h-[calc(100vh-12rem)] min-h-[520px] bg-slate-900 rounded-xl border border-white/[0.06] overflow-hidden">
                        <DataExplorerView dataset={dataset} />
                    </div>
                )}

                {activeSection === 'cleaned' && (
                    <div className="h-[calc(100vh-12rem)] min-h-[520px] overflow-hidden">
                        <ETLView
                            dataset={dataset}
                            onSchemaOverride={onSchemaOverride}
                            onRowsRecovered={onRowsRecovered}
                            onDataCleaned={onDataCleaned}
                            onSwitchToLive={onSwitchToLive}
                        />
                    </div>
                )}

                {activeSection === 'studio' && (
                    <div className="h-[calc(100vh-12rem)] min-h-[520px] overflow-hidden">
                        <DataStudioView dataset={dataset} onDataCleaned={onDataCleaned} />
                    </div>
                )}

                {activeSection === 'mapping' && (
                    <div className="h-[calc(100vh-12rem)] min-h-[520px] overflow-hidden rounded-xl border border-white/[0.06]">
                        {(mappingProfile || dataset.domainProfile) ? (
                            <ColumnMappingWizard
                                profile={mappingProfile || dataset.domainProfile!}
                                columns={dataset.columns}
                                fileName={dataset.name}
                                isAIProfiling={isAIProfiling}
                                onApply={(profile, overrides) => {
                                    onApplyMapping?.(profile, overrides);
                                    setActiveSection('overview');
                                }}
                                onDismiss={() => {
                                    onDismissMapping?.();
                                    setActiveSection('overview');
                                }}
                            />
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-center px-6">
                                <Eye className="w-10 h-10 text-slate-500 mb-3" />
                                <h3 className="text-lg font-bold text-slate-700 dark:text-white">Column mapping is not ready yet</h3>
                                <p className="max-w-md text-sm text-slate-500 dark:text-slate-400 mt-2">Finish profiling this dataset, then return here to review its semantic roles and formats.</p>
                            </div>
                        )}
                    </div>
                )}

                {activeSection === 'schema' && (
                    <div className="h-[calc(100vh-12rem)] min-h-[520px] overflow-hidden">
                        <SchemaView dataset={dataset} />
                    </div>
                )}

            </div>
        </div>
    );
};
