import React, { useState, useMemo } from 'react';
import { Search, Filter, ArrowUpDown, Download, Table as TableIcon, BarChart2, FileText, Sparkles } from 'lucide-react';
import { Dataset, ColumnType } from '../types';

interface DataExplorerViewProps {
    dataset: Dataset | null;
}

type ViewMode = 'clean' | 'raw';

export const DataExplorerView: React.FC<DataExplorerViewProps> = ({ dataset }) => {
    const [viewMode, setViewMode] = useState<ViewMode>('clean');
    const [searchTerm, setSearchTerm] = useState('');
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortAsc, setSortAsc] = useState(true);
    const [pageSize] = useState(50);
    const [currentPage, setCurrentPage] = useState(0);
    const [filterCol, setFilterCol] = useState<string | null>(null);
    const [filterVal, setFilterVal] = useState('');

    const hasRawData = !!(dataset?.rawRows && dataset.rawRows.length > 0);

    // Determine which data source to show
    const activeRows = useMemo(() => {
        if (!dataset) return [];
        if (viewMode === 'raw' && hasRawData) return dataset.rawRows!;
        return dataset.rows;
    }, [dataset, viewMode, hasRawData]);

    const columns = useMemo(() => {
        if (activeRows.length === 0) return [];
        if (viewMode === 'clean' && dataset) return dataset.columns.map(c => c.name);
        // Raw mode: use keys from the raw rows
        return Object.keys(activeRows[0] || {});
    }, [activeRows, viewMode, dataset]);

    // Filter & Search
    const filteredRows = useMemo(() => {
        let rows = activeRows;

        if (searchTerm) {
            const lower = searchTerm.toLowerCase();
            rows = rows.filter(row =>
                columns.some(col => String(row[col] ?? '').toLowerCase().includes(lower))
            );
        }

        if (filterCol && filterVal) {
            const lower = filterVal.toLowerCase();
            rows = rows.filter(row =>
                String(row[filterCol] ?? '').toLowerCase().includes(lower)
            );
        }

        if (sortCol) {
            rows = [...rows].sort((a, b) => {
                const va = a[sortCol] ?? '';
                const vb = b[sortCol] ?? '';
                const numA = Number(va);
                const numB = Number(vb);
                if (!isNaN(numA) && !isNaN(numB)) {
                    return sortAsc ? numA - numB : numB - numA;
                }
                return sortAsc
                    ? String(va).localeCompare(String(vb))
                    : String(vb).localeCompare(String(va));
            });
        }

        return rows;
    }, [activeRows, searchTerm, filterCol, filterVal, sortCol, sortAsc, columns]);

    if (!dataset) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
                <TableIcon className="w-16 h-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Upload or connect a data source to explore it here.</p>
            </div>
        );
    }

    const totalPages = Math.ceil(filteredRows.length / pageSize);
    const pageRows = filteredRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

    const handleSort = (col: string) => {
        if (sortCol === col) {
            setSortAsc(!sortAsc);
        } else {
            setSortCol(col);
            setSortAsc(true);
        }
    };

    const getColType = (name: string) => {
        if (viewMode === 'raw') return ColumnType.UNKNOWN;
        const col = dataset.columns.find(c => c.name === name);
        return col?.type || ColumnType.UNKNOWN;
    };

    const typeColor = (type: ColumnType) => {
        switch (type) {
            case ColumnType.METRIC: return 'text-emerald-400 bg-emerald-500/10';
            case ColumnType.DATE: return 'text-amber-400 bg-amber-500/10';
            case ColumnType.DIMENSION: return 'text-blue-400 bg-blue-500/10';
            case ColumnType.ID: return 'text-purple-400 bg-purple-500/10';
            default: return 'text-slate-400 bg-slate-500/10';
        }
    };

    const handleExportCSV = () => {
        const header = columns.join(',');
        const body = filteredRows.map(row =>
            columns.map(c => {
                const v = String(row[c] ?? '');
                return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
            }).join(',')
        ).join('\n');
        const suffix = viewMode === 'raw' ? '_raw' : '_cleaned';
        const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${dataset.name.replace(/\.[^.]+$/, '')}${suffix}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleTabSwitch = (mode: ViewMode) => {
        setViewMode(mode);
        setCurrentPage(0);
        setSortCol(null);
        setFilterCol(null);
        setFilterVal('');
        setSearchTerm('');
    };

    return (
        <div className="flex flex-col h-full overflow-hidden p-6 gap-4">
            {/* Raw / Clean Toggle Tabs */}
            <div className="flex items-center gap-1 bg-slate-800/60 border border-white/10 rounded-xl p-1 w-fit">
                <button
                    onClick={() => handleTabSwitch('clean')}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200
                        ${viewMode === 'clean'
                            ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm shadow-emerald-500/10'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                        }`}
                >
                    <Sparkles className="w-4 h-4" />
                    Cleaned Data
                    <span className={`text-xs px-1.5 py-0.5 rounded-full ${viewMode === 'clean' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-500'}`}>
                        {dataset.rows.length}
                    </span>
                </button>
                <button
                    onClick={() => handleTabSwitch('raw')}
                    disabled={!hasRawData}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200
                        ${!hasRawData ? 'text-slate-600 cursor-not-allowed opacity-50' :
                            viewMode === 'raw'
                                ? 'bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-300 border border-amber-500/30 shadow-sm shadow-amber-500/10'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                        }`}
                >
                    <FileText className="w-4 h-4" />
                    Raw Data
                    {hasRawData && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${viewMode === 'raw' ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700 text-slate-500'}`}>
                            {dataset.rawRows!.length}
                        </span>
                    )}
                </button>
            </div>

            {/* Info Bar */}
            {viewMode === 'raw' && (
                <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300 text-xs">
                    <FileText className="w-3.5 h-3.5" />
                    Showing original uploaded data before ETL cleaning. Column headers are as-uploaded.
                </div>
            )}
            {viewMode === 'clean' && (
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-300 text-xs">
                    <Sparkles className="w-3.5 h-3.5" />
                    Showing ETL-cleaned data with normalized headers, standardized values, and type-safe columns.
                </div>
            )}

            {/* Toolbar */}
            <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-[200px] bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2">
                    <Search className="w-4 h-4 text-slate-500 shrink-0" />
                    <input
                        type="text"
                        placeholder="Search all columns..."
                        value={searchTerm}
                        onChange={e => { setSearchTerm(e.target.value); setCurrentPage(0); }}
                        className="bg-transparent outline-none text-sm text-white placeholder-slate-500 flex-1"
                    />
                </div>

                <div className="flex items-center gap-2 bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2">
                    <Filter className="w-4 h-4 text-slate-500 shrink-0" />
                    <select
                        value={filterCol || ''}
                        onChange={e => { setFilterCol(e.target.value || null); setFilterVal(''); setCurrentPage(0); }}
                        className="bg-slate-800 text-sm text-slate-300 outline-none cursor-pointer"
                    >
                        <option value="" className="bg-slate-800 text-slate-300">Filter column</option>
                        {columns.map(c => <option key={c} value={c} className="bg-slate-800 text-slate-200">{c}</option>)}
                    </select>
                    {filterCol && (
                        <input
                            type="text"
                            placeholder={`Filter ${filterCol}...`}
                            value={filterVal}
                            onChange={e => { setFilterVal(e.target.value); setCurrentPage(0); }}
                            className="bg-transparent outline-none text-sm text-white placeholder-slate-500 w-28"
                        />
                    )}
                </div>

                <button
                    onClick={handleExportCSV}
                    className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-xl border border-white/10 hover:border-indigo-500/30 bg-slate-800/60 hover:bg-indigo-500/10 text-slate-300 hover:text-indigo-300 transition-all"
                >
                    <Download className="w-4 h-4" />
                    Export {viewMode === 'raw' ? 'Raw' : 'Clean'} CSV
                </button>

                <div className="flex items-center gap-2 text-xs text-slate-500">
                    <BarChart2 className="w-3.5 h-3.5" />
                    <span>{filteredRows.length.toLocaleString()} of {activeRows.length.toLocaleString()} rows</span>
                </div>
            </div>

            {/* Column Types Legend (only in clean mode) */}
            {viewMode === 'clean' && (
                <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-slate-500">
                    {[ColumnType.METRIC, ColumnType.DATE, ColumnType.DIMENSION, ColumnType.ID].map(t => (
                        <span key={t} className={`px-2 py-0.5 rounded-full ${typeColor(t)} font-bold`}>{t}</span>
                    ))}
                </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-auto rounded-xl border border-white/10 bg-slate-800/30">
                <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-800/95 backdrop-blur-sm">
                        <tr>
                            <th className="px-3 py-3 text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-white/5 w-12">#</th>
                            {columns.map(col => (
                                <th
                                    key={col}
                                    onClick={() => handleSort(col)}
                                    className="px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider border-b border-white/5 cursor-pointer hover:bg-white/5 transition-colors group whitespace-nowrap"
                                >
                                    <div className="flex items-center gap-1.5">
                                        {viewMode === 'clean' && (
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] ${typeColor(getColType(col))}`}>
                                                {getColType(col).charAt(0)}
                                            </span>
                                        )}
                                        <span className="text-slate-400">{col}</span>
                                        <ArrowUpDown className={`w-3 h-3 transition-opacity ${sortCol === col ? 'text-indigo-400 opacity-100' : 'text-slate-600 opacity-0 group-hover:opacity-50'
                                            }`} />
                                        {sortCol === col && (
                                            <span className="text-indigo-400 text-[9px]">{sortAsc ? '↑' : '↓'}</span>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/3">
                        {pageRows.map((row, idx) => (
                            <tr
                                key={idx}
                                className="hover:bg-white/3 transition-colors"
                            >
                                <td className="px-3 py-2 text-[10px] text-slate-600 font-mono">{currentPage * pageSize + idx + 1}</td>
                                {columns.map(col => {
                                    const val = row[col];
                                    const isEmpty = val === null || val === undefined || val === '';
                                    return (
                                        <td
                                            key={col}
                                            className={`px-3 py-2 max-w-[200px] truncate font-mono text-xs ${isEmpty
                                                ? 'text-red-400/50 italic'
                                                : viewMode === 'raw' ? 'text-amber-200/80' : 'text-slate-300'
                                                }`}
                                        >
                                            {isEmpty ? '∅' : String(val)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-slate-400">
                    <span>
                        Page {currentPage + 1} of {totalPages}
                    </span>
                    <div className="flex gap-2">
                        <button
                            disabled={currentPage === 0}
                            onClick={() => setCurrentPage(p => p - 1)}
                            className="px-3 py-1.5 rounded-lg bg-slate-800/60 border border-white/10 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                            Previous
                        </button>
                        <button
                            disabled={currentPage >= totalPages - 1}
                            onClick={() => setCurrentPage(p => p + 1)}
                            className="px-3 py-1.5 rounded-lg bg-slate-800/60 border border-white/10 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
