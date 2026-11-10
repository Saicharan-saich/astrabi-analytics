import React, { useEffect, useMemo, useState } from 'react';
import { NoDataYet } from './NoDataYet';
import { ChevronDown, ChevronRight, Columns3, Compass, Database, Download, MessageCircleQuestion, Upload, Zap } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { Dataset, DatasetDomainProfile, ColumnType, ETLLog, EtlOptions, Tab } from '../types';
import { CleaningLogEntry } from '../services/dataCleaningEngine';
import { CleaningChangesPanel } from './CleaningChangesPanel';
import { DataKindNote } from './DataKindNote';
import { WeeklyBriefingCard } from './WeeklyBriefingCard';
import { CleaningRulesPanel } from './CleaningRulesPanel';
import { DataExplorerView } from './DataExplorerView';
import { ETLView } from './ETLView';
import { DataCleaningPanel } from './DataCleaningPanel';
import { SchemaView } from './SchemaView';
import { ColumnMappingWizard } from './ColumnMappingWizard';

/** Entry points kept for the app's routes; they map onto the four views below. */
type DatasetWorkspaceSection = 'overview' | 'explore' | 'cleaned' | 'studio' | 'mapping' | 'schema';
type View = 'overview' | 'data' | 'columns' | 'cleaning' | 'relationships';
type CleaningMode = 'log' | 'fix';

interface DatasetSummaryViewProps {
    dataset: Dataset | null;
    /** Lets legacy entry points open the corresponding workspace section directly. */
    initialSection?: DatasetWorkspaceSection;
    /** Changes on every navigation into the workspace, so the route's view is re-selected. */
    sectionRequest?: number;
    mappingProfile?: DatasetDomainProfile | null;
    isAIProfiling?: boolean;
    onApplyMapping?: (updatedProfile: DatasetDomainProfile, columnTypeOverrides: Record<string, ColumnType>) => void;
    onDismissMapping?: () => void;
    onSchemaOverride?: (columnName: string, newType: ColumnType) => void;
    onRowsRecovered?: (recoveredRows: Record<string, any>[]) => void;
    onDataCleaned?: (newRows: Record<string, any>[], log: CleaningLogEntry) => void;
    onSwitchToLive?: () => void;
    /** Reverse or restore one automatic cleaning step. */
    onEtlRevert?: (revert: NonNullable<ETLLog['revert']>) => void;
    /** Re-runs the current cleaning on the original upload. */
    onEtlReclean?: () => void;
    /** Apply the cleaning review's decisions in one re-run. */
    onApplyCleaningDecisions?: (nextOptions: EtlOptions, label: string) => void;
    etlRevertPending?: string | null;
    /** Open AI SQL with a question ready (from the briefing). */
    onAskAiSql?: (question: string) => void;
    /** The column review has not been looked at yet (it is optional). */
    mappingPending?: boolean;
}

const viewFor = (section: DatasetWorkspaceSection): View =>
    section === 'explore' ? 'data'
        : section === 'mapping' ? 'columns'
            : section === 'cleaned' || section === 'studio' ? 'cleaning'
                : section === 'schema' ? 'relationships'
                    : 'overview';

const ROLE_LABEL: Record<string, string> = { METRIC: 'Measure', DIMENSION: 'Dimension', DATE: 'Date', ID: 'ID', BOOLEAN: 'Yes/No' };
const roleLabel = (type: string) => ROLE_LABEL[type] || type.charAt(0) + type.slice(1).toLowerCase();

interface ColumnStats {
    name: string;
    type: string;
    count: number;
    unique: number;
    nullCount: number;
    min?: number | string;
    max?: number | string;
    sum?: number;
    mean?: number;
    median?: number;
    stdDev?: number;
    topValues?: { value: string; count: number }[];
}

function computeColumnStats(rows: Record<string, any>[], colName: string, colType: string): ColumnStats {
    const values = rows.map(r => r[colName]);
    const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
    const count = values.length;
    const stats: ColumnStats = { name: colName, type: colType, count, unique: new Set(nonNull.map(String)).size, nullCount: count - nonNull.length };

    if (colType === 'METRIC') {
        const nums = nonNull.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        if (nums.length > 0) {
            stats.min = nums[0];
            stats.max = nums[nums.length - 1];
            stats.sum = nums.reduce((s, n) => s + n, 0);
            stats.mean = stats.sum / nums.length;
            const mid = Math.floor(nums.length / 2);
            stats.median = nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
            stats.stdDev = Math.sqrt(nums.reduce((s, n) => s + Math.pow(n - stats.mean!, 2), 0) / nums.length);
        }
    } else if (colType === 'DATE') {
        const dates = nonNull.map(v => new Date(v)).filter(d => !isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime());
        if (dates.length > 0) {
            stats.min = dates[0].toISOString().split('T')[0];
            stats.max = dates[dates.length - 1].toISOString().split('T')[0];
        }
    }
    if (colType === 'DIMENSION' || colType === 'ID') {
        const freq = new Map<string, number>();
        nonNull.forEach(v => { const s = String(v); freq.set(s, (freq.get(s) || 0) + 1); });
        stats.topValues = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, n]) => ({ value, count: n }));
    }
    return stats;
}

function formatNum(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const formatDay = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

/** One line that says what is in a column. */
function columnSummary(stat: ColumnStats): string {
    if (stat.type === 'METRIC' && stat.min !== undefined) return `${formatNum(stat.min as number)} – ${formatNum(stat.max as number)} · avg ${formatNum(stat.mean)}`;
    if (stat.type === 'DATE' && stat.min) return `${formatDay(String(stat.min))} – ${formatDay(String(stat.max))}`;
    if (stat.topValues?.length) {
        const filled = stat.count - stat.nullCount;
        const top = stat.topValues[0];
        if (stat.type === 'ID' && stat.unique === filled) return 'Unique on every row';
        return `Most common: ${top.value} (${filled ? Math.round((top.count / filled) * 100) : 0}%)`;
    }
    return '—';
}

const ColumnRow: React.FC<{ stat: ColumnStats }> = ({ stat }) => {
    const [open, setOpen] = useState(false);
    const filledPct = stat.count > 0 ? ((stat.count - stat.nullCount) / stat.count) * 100 : 0;
    return (
        <>
            <tr className="qi-ws-row" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                <td className="py-2.5 pl-4 pr-2 w-6">
                    {open ? <ChevronDown className="qi-ws-muted w-3.5 h-3.5" /> : <ChevronRight className="qi-ws-muted w-3.5 h-3.5" />}
                </td>
                <td className="py-2.5 pr-3">
                    <span className="qi-ws-strong font-medium">{stat.name}</span>
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap">
                    <span className={`qi-role is-${stat.type}`}>{roleLabel(stat.type)}</span>
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                    <span className={filledPct < 90 ? 'qi-ws-warn' : ''}>{filledPct.toFixed(filledPct === 100 ? 0 : 1)}%</span>
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums qi-ws-muted hidden sm:table-cell">{stat.unique.toLocaleString()}</td>
                <td className="py-2.5 pr-4 qi-ws-muted truncate max-w-[22rem] hidden md:table-cell">{columnSummary(stat)}</td>
            </tr>
            {open && (
                <tr className="qi-ws-detail">
                    <td />
                    <td colSpan={5} className="pb-4 pr-4">
                        {stat.type === 'METRIC' && (
                            <dl className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                                {[['Min', stat.min], ['Max', stat.max], ['Sum', stat.sum], ['Average', stat.mean], ['Median', stat.median], ['Std dev', stat.stdDev]].map(([label, value]) => (
                                    <div key={label as string}>
                                        <dt className="qi-ws-muted text-[11px]">{label}</dt>
                                        <dd className="qi-ws-strong text-[13px] font-semibold tabular-nums">{formatNum(value as number)}</dd>
                                    </div>
                                ))}
                            </dl>
                        )}
                        {stat.type === 'DATE' && (
                            <p className="text-[13px]">From <b>{formatDay(String(stat.min || ''))}</b> to <b>{formatDay(String(stat.max || ''))}</b></p>
                        )}
                        {stat.topValues && stat.topValues.length > 0 && (
                            <div className="space-y-1.5 max-w-xl">
                                {stat.topValues.map(tv => (
                                    <div key={tv.value} className="flex items-center gap-3 text-[12.5px]">
                                        <span className="w-40 truncate">{tv.value}</span>
                                        <span className="qi-ws-bar flex-1 h-1.5 rounded-full overflow-hidden">
                                            <span className="block h-full rounded-full" style={{ width: `${(tv.count / stat.topValues![0].count) * 100}%` }} />
                                        </span>
                                        <span className="qi-ws-muted w-12 text-right tabular-nums">{tv.count.toLocaleString()}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <p className="qi-ws-muted text-[11.5px] mt-2">{stat.nullCount.toLocaleString()} blank of {stat.count.toLocaleString()} rows</p>
                    </td>
                </tr>
            )}
        </>
    );
};

/** Column roles and how each was read, with the role editable in place. */
const ColumnTypesTable: React.FC<{ dataset: Dataset; onSchemaOverride?: (columnName: string, newType: ColumnType) => void }> = ({ dataset, onSchemaOverride }) => (
    <div className="qi-ws-card rounded-xl overflow-hidden">
        <div className="px-4 py-3">
            <h3 className="qi-ws-strong text-[14px] font-semibold">Column types</h3>
            <p className="qi-ws-muted text-[12.5px] mt-0.5">Change a role and the data is re-read with it. Measures are added up; dimensions group and filter.</p>
        </div>
        <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
                <thead>
                    <tr className="qi-ws-thead">
                        <th className="py-2 pl-4 pr-3 text-left">Column</th>
                        <th className="py-2 pr-3 text-left">Role</th>
                        <th className="py-2 pr-3 text-left">Stored as</th>
                        <th className="py-2 pr-4 text-right">Read correctly</th>
                    </tr>
                </thead>
                <tbody>
                    {dataset.columns.map(column => {
                        const conversion = column.conversion;
                        const rejected = conversion?.invalidCount || 0;
                        return (
                            <tr key={column.name} className="qi-ws-row is-static">
                                <td className="py-2 pl-4 pr-3 qi-ws-strong font-medium">{column.name}</td>
                                <td className="py-2 pr-3">
                                    <select
                                        value={column.type}
                                        disabled={!onSchemaOverride}
                                        onChange={e => onSchemaOverride?.(column.name, e.target.value as ColumnType)}
                                        className="qi-ws-select rounded-md px-2 py-1 text-[12.5px]"
                                        aria-label={`Role of ${column.name}`}
                                    >
                                        {(['METRIC', 'DIMENSION', 'DATE', 'ID'] as const).map(t => <option key={t} value={t}>{roleLabel(t)}</option>)}
                                    </select>
                                </td>
                                <td className="py-2 pr-3 qi-ws-muted font-mono text-[12px] whitespace-nowrap">
                                    {(conversion?.sourceType || column.originalType || 'unknown')} → {conversion?.normalizedType || column.physicalType || 'unknown'}
                                </td>
                                <td className={`py-2 pr-4 text-right tabular-nums whitespace-nowrap ${rejected > 0 ? 'qi-ws-warn' : 'qi-ws-muted'}`}>
                                    {conversion ? `${Math.round(conversion.parseSuccessRate * 100)}%${rejected ? ` · ${rejected} not read` : ''}` : '—'}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    </div>
);

function downloadCleaned(dataset: Dataset) {
    if (!dataset.rows.length) return;
    const columns = dataset.columns.map(c => c.name);
    const escapeCSV = (val: any) => {
        if (val == null) return '';
        const str = String(val);
        return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const csv = [columns.map(escapeCSV).join(','), ...dataset.rows.map(row => columns.map(col => escapeCSV(row[col])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dataset.name.replace(/\.[^.]+$/, '')}_cleaned.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

export const DatasetSummaryView: React.FC<DatasetSummaryViewProps> = ({
    dataset,
    initialSection = 'overview',
    sectionRequest,
    mappingProfile,
    isAIProfiling = false,
    onApplyMapping,
    onDismissMapping,
    onSchemaOverride,
    onRowsRecovered,
    onDataCleaned,
    onSwitchToLive,
    onEtlRevert,
    onEtlReclean,
    onApplyCleaningDecisions,
    etlRevertPending,
    onAskAiSql,
    mappingPending = false,
}) => {
    const [view, setView] = useState<View>(viewFor(initialSection));
    const [cleaningMode, setCleaningMode] = useState<CleaningMode>(initialSection === 'studio' ? 'fix' : 'log');
    // Opening the workspace from another route (e.g. after upload) selects that view.
    useEffect(() => {
        setView(viewFor(initialSection));
        if (initialSection === 'studio') setCleaningMode('fix');
        if (initialSection === 'cleaned') setCleaningMode('log');
    }, [initialSection, sectionRequest]);

    const columnStats = useMemo(() => {
        if (view !== 'overview' || !dataset?.rows || !dataset?.columns) return [];
        return dataset.columns.map(col => computeColumnStats(dataset.rows, col.name, col.type));
    }, [dataset, view]);

    const facts = useMemo(() => {
        if (!dataset) return null;
        const count = (type: string) => dataset.columns.filter(c => c.type === type).length;
        const rows = dataset.rows?.length || 0;
        const totalCells = rows * dataset.columns.length;
        const nullCells = columnStats.reduce((s, c) => s + c.nullCount, 0);
        const uploaded = dataset.etlLogs?.find(l => l.step === 'Final Summary')?.rowsBefore;
        const roles = [
            [count('METRIC'), 'measure', 'measures'], [count('DIMENSION'), 'dimension', 'dimensions'],
            [count('DATE'), 'date', 'dates'], [count('ID'), 'ID', 'IDs'],
        ].filter(([n]) => (n as number) > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ');
        return { rows, uploaded, cols: dataset.columns.length, roles, completeness: totalCells > 0 ? ((totalCells - nullCells) / totalCells) * 100 : 100 };
    }, [dataset, columnStats]);

    if (!dataset) {
        return <NoDataYet title="Dataset Workspace" purpose="See what your data holds, every change the cleaning made, and fix anything by hand." />;
    }

    const profile = mappingProfile || dataset.domainProfile;
    const hasRelationships = Boolean(dataset.sourceSchema);
    const time = dataset.timeContext;
    const tabs: { id: View; label: string }[] = [
        { id: 'overview', label: 'Overview' },
        { id: 'data', label: 'Data' },
        { id: 'columns', label: 'Columns' },
        { id: 'cleaning', label: 'Cleaning' },
        ...(hasRelationships || view === 'relationships' ? [{ id: 'relationships' as const, label: 'Relationships' }] : []),
    ];

    return (
        <div className="qi-workspace-page qi-ws h-full overflow-y-auto">
            <div className="qi-ws-inner max-w-[72rem] mx-auto px-6 pt-6 pb-10">
                {/* Header: what this dataset is, and the dataset-level actions */}
                <header className="qi-page-head flex flex-wrap items-end gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="qi-ws-strong text-[22px] font-semibold tracking-tight">Dataset Workspace</h2>
                        <p className="qi-ws-muted text-[13px] mt-1 truncate">
                            <span className="qi-ws-strong font-medium">{dataset.name || 'Unnamed dataset'}</span>
                            {` · ${dataset.rows.length.toLocaleString()} rows · ${dataset.columns.length} columns`}
                            {time?.minDate && time?.maxDate ? ` · ${formatDay(time.minDate)} – ${formatDay(time.maxDate)}` : ''}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {dataset.connectionMode === 'live' && (
                            <span className="qi-ws-badge inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium" title={`Real-time data from ${dataset.liveConnection?.dbType || 'database'}`}>
                                <Zap className="w-3.5 h-3.5" /> Live
                            </span>
                        )}
                        {dataset.connectionMode === 'import' && (
                            <span className="qi-ws-badge inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium" title="A snapshot taken at import">
                                <Upload className="w-3.5 h-3.5" /> Snapshot
                            </span>
                        )}
                        {dataset.connectionMode === 'import' && onSwitchToLive && (
                            <button type="button" onClick={onSwitchToLive} className="qi-ws-ghost rounded-md px-2.5 py-1 text-[12px] font-semibold" title="Reconnect to the database in Live mode for real-time data">
                                Switch to live
                            </button>
                        )}
                        <button type="button" onClick={() => downloadCleaned(dataset)} className="qi-ws-button inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold" title="Download the cleaned data as CSV">
                            <Download className="w-4 h-4" /> Download cleaned CSV
                        </button>
                    </div>
                </header>

                <nav className="qi-ws-tabs mt-5 flex gap-1 overflow-x-auto" role="tablist" aria-label="Dataset workspace">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={view === tab.id}
                            onClick={() => setView(tab.id)}
                            className={`qi-ws-tab px-3 py-2.5 text-[13.5px] font-medium ${view === tab.id ? 'is-active' : ''}`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>

                <div className="mt-6 space-y-5">
                    {view === 'overview' && facts && (
                        <>
                            <nav className="qi-next" aria-label="What to do next">
                                <p className="qi-next-label">What would you like to do next?</p>
                                <div className="qi-next-grid">
                                    <button type="button" className="qi-next-item is-primary" onClick={() => useAppStore.getState().setActiveTab(Tab.AI_SQL)}>
                                        <MessageCircleQuestion className="h-5 w-5" aria-hidden />
                                        <span><strong>Ask a question</strong>Type it in plain English and get a checked answer.</span>
                                    </button>
                                    <button type="button" className="qi-next-item" onClick={() => useAppStore.getState().setActiveTab(Tab.QUICK_INSIGHTS)}>
                                        <Compass className="h-5 w-5" aria-hidden />
                                        <span><strong>See what stands out</strong>An automatic read of the data, ready to turn into a dashboard.</span>
                                    </button>
                                    <button type="button" className="qi-next-item" onClick={() => setView('columns')}>
                                        <Columns3 className="h-5 w-5" aria-hidden />
                                        <span><strong>Check the columns</strong>{mappingPending ? 'Optional: a quick look at what each column is makes answers sharper.' : 'See what each column is and change it if needed.'}</span>
                                        {mappingPending && <em className="qi-next-tag">Suggested</em>}
                                    </button>
                                </div>
                            </nav>

                            <WeeklyBriefingCard dataset={dataset} onAsk={onAskAiSql} />

                            <CleaningChangesPanel dataset={dataset} onRevert={onEtlRevert} pendingOption={etlRevertPending} onReclean={onEtlReclean} />

                            <DataKindNote dataset={dataset} />

                            <dl className="qi-ws-card qi-ws-facts rounded-xl grid grid-cols-2 md:grid-cols-4">
                                <div className="px-5 py-4">
                                    <dt className="qi-ws-muted text-[12px]">Rows</dt>
                                    <dd className="qi-ws-strong text-[22px] font-semibold tabular-nums">{facts.rows.toLocaleString()}</dd>
                                    {facts.uploaded !== undefined && facts.uploaded !== facts.rows && (
                                        <dd className="qi-ws-muted text-[12px]">of {facts.uploaded.toLocaleString()} uploaded</dd>
                                    )}
                                </div>
                                <div className="px-5 py-4">
                                    <dt className="qi-ws-muted text-[12px]">Columns</dt>
                                    <dd className="qi-ws-strong text-[22px] font-semibold tabular-nums">{facts.cols}</dd>
                                    <dd className="qi-ws-muted text-[12px]">{facts.roles}</dd>
                                </div>
                                <div className="px-5 py-4">
                                    <dt className="qi-ws-muted text-[12px]">Filled in</dt>
                                    <dd className="qi-ws-strong text-[22px] font-semibold tabular-nums">{facts.completeness.toFixed(facts.completeness === 100 ? 0 : 1)}%</dd>
                                    <dd className="qi-ws-muted text-[12px]">of all cells</dd>
                                </div>
                                <div className="px-5 py-4">
                                    <dt className="qi-ws-muted text-[12px]">Time range</dt>
                                    {time?.minDate ? (
                                        <>
                                            <dd className="qi-ws-strong text-[15px] font-semibold mt-1.5">{formatDay(time.minDate)} – {formatDay(time.maxDate)}</dd>
                                            {time.defaultAnchorDate && <dd className="qi-ws-muted text-[12px]">“Latest” means {formatDay(time.defaultAnchorDate)}</dd>}
                                        </>
                                    ) : (
                                        <dd className="qi-ws-muted text-[13px] mt-1.5">No date column</dd>
                                    )}
                                </div>
                            </dl>

                            <section className="qi-ws-card rounded-xl overflow-hidden">
                                <div className="flex items-baseline justify-between px-4 py-3">
                                    <h3 className="qi-ws-strong text-[14px] font-semibold">Columns</h3>
                                    <button type="button" onClick={() => setView('columns')} className="qi-ws-link text-[12.5px] font-semibold">Change types</button>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-[13px]">
                                        <thead>
                                            <tr className="qi-ws-thead">
                                                <th className="py-2 pl-4 pr-2" />
                                                <th className="py-2 pr-3 text-left">Name</th>
                                                <th className="py-2 pr-3 text-left">Role</th>
                                                <th className="py-2 pr-3 text-left">Filled</th>
                                                <th className="py-2 pr-3 text-left hidden sm:table-cell">Distinct</th>
                                                <th className="py-2 pr-4 text-left hidden md:table-cell">What's in it</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {columnStats.map(stat => <ColumnRow key={stat.name} stat={stat} />)}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        </>
                    )}

                    {view === 'data' && (
                        <div className="h-[calc(100vh-15rem)] min-h-[520px] overflow-hidden">
                            <DataExplorerView dataset={dataset} />
                        </div>
                    )}

                    {view === 'columns' && (
                        profile ? (
                            <div className="qi-ws-card h-[calc(100vh-15rem)] min-h-[560px] overflow-hidden rounded-xl">
                                <ColumnMappingWizard
                                    profile={profile}
                                    columns={dataset.columns}
                                    fileName={dataset.name}
                                    isAIProfiling={isAIProfiling}
                                    onApply={(next, overrides) => {
                                        onApplyMapping?.(next, overrides);
                                        setView('overview');
                                    }}
                                    onDismiss={() => {
                                        onDismissMapping?.();
                                        setView('overview');
                                    }}
                                />
                            </div>
                        ) : (
                            <>
                                {isAIProfiling && <p className="qi-ws-muted text-[13px]">Working out what each column means… you can change roles below meanwhile.</p>}
                                <ColumnTypesTable dataset={dataset} onSchemaOverride={onSchemaOverride} />
                            </>
                        )
                    )}

                    {view === 'cleaning' && (
                        <>
                            <div className="flex flex-wrap items-center gap-3">
                                <div className="qi-ws-segmented inline-flex rounded-lg p-0.5" role="group" aria-label="Cleaning">
                                    <button type="button" aria-pressed={cleaningMode === 'log'} onClick={() => setCleaningMode('log')} className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${cleaningMode === 'log' ? 'is-active' : ''}`}>What was done</button>
                                    <button type="button" aria-pressed={cleaningMode === 'fix'} onClick={() => setCleaningMode('fix')} className={`px-3 py-1.5 rounded-md text-[13px] font-semibold ${cleaningMode === 'fix' ? 'is-active' : ''}`}>Fix by hand</button>
                                </div>
                                <p className="qi-ws-muted text-[12.5px]">
                                    {cleaningMode === 'log' ? 'Every automatic step, with the reason for it. Open a step for samples.' : 'Remove duplicates, fill blanks, fix text, split or merge columns.'}
                                </p>
                            </div>
                            {cleaningMode === 'log' ? (
                                <>
                                    <CleaningChangesPanel dataset={dataset} onRevert={onEtlRevert} pendingOption={etlRevertPending} onReclean={onEtlReclean} persistent />
                                    <CleaningRulesPanel dataset={dataset} onApply={onApplyCleaningDecisions} busy={Boolean(etlRevertPending)} />
                                    <ETLView dataset={dataset} onSchemaOverride={onSchemaOverride} onRowsRecovered={onRowsRecovered} onDataCleaned={onDataCleaned} onApplyDecisions={onApplyCleaningDecisions} applying={etlRevertPending === '__review__'} busy={Boolean(etlRevertPending)} />
                                </>
                            ) : (
                                <DataCleaningPanel dataset={dataset} onDataCleaned={(rows, entry) => onDataCleaned?.(rows, entry)} />
                            )}
                        </>
                    )}

                    {view === 'relationships' && (
                        <div className="h-[calc(100vh-15rem)] min-h-[520px] overflow-hidden">
                            <SchemaView dataset={dataset} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
