import React, { useState, useMemo } from 'react';
import { Search, Filter, ArrowUpDown, Download, Table as TableIcon } from 'lucide-react';
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

    const roleClass = (type: ColumnType) => `qi-role is-${type}`;

    return (
        <div className="qi-ws-card flex flex-col h-full overflow-hidden rounded-xl">
            {/* One toolbar: which version, search, filter, export */}
            <div className="qi-ws-toolbar flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="qi-ws-segmented inline-flex rounded-lg p-0.5" role="group" aria-label="Which version of the data">
                    <button
                        type="button"
                        onClick={() => handleTabSwitch('clean')}
                        aria-pressed={viewMode === 'clean'}
                        title="Cleaned data: tidy headers, standardised values and typed columns"
                        className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold ${viewMode === 'clean' ? 'is-active' : ''}`}
                    >
                        Cleaned <span className="qi-ws-count">{dataset.rows.length.toLocaleString()}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => handleTabSwitch('raw')}
                        disabled={!hasRawData}
                        aria-pressed={viewMode === 'raw'}
                        title={hasRawData ? 'The file exactly as uploaded, before cleaning' : 'The original upload is not stored for this dataset'}
                        className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed ${viewMode === 'raw' ? 'is-active' : ''}`}
                    >
                        As uploaded {hasRawData && <span className="qi-ws-count">{dataset.rawRows!.length.toLocaleString()}</span>}
                    </button>
                </div>

                <label className="qi-ws-field flex items-center gap-2 flex-1 min-w-[180px] rounded-lg px-2.5 py-1.5">
                    <Search className="qi-ws-muted w-4 h-4 shrink-0" />
                    <input
                        type="text"
                        placeholder="Search all columns"
                        value={searchTerm}
                        onChange={e => { setSearchTerm(e.target.value); setCurrentPage(0); }}
                        className="bg-transparent outline-none text-[13px] flex-1 min-w-0"
                        aria-label="Search all columns"
                    />
                </label>

                <div className="qi-ws-field flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <Filter className="qi-ws-muted w-4 h-4 shrink-0" />
                    <select
                        value={filterCol || ''}
                        onChange={e => { setFilterCol(e.target.value || null); setFilterVal(''); setCurrentPage(0); }}
                        className="bg-transparent text-[13px] outline-none cursor-pointer"
                        aria-label="Filter by column"
                    >
                        <option value="">Filter column</option>
                        {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    {filterCol && (
                        <input
                            type="text"
                            placeholder={`Value in ${filterCol}`}
                            value={filterVal}
                            onChange={e => { setFilterVal(e.target.value); setCurrentPage(0); }}
                            className="bg-transparent outline-none text-[13px] w-32"
                            aria-label={`Filter value for ${filterCol}`}
                        />
                    )}
                </div>

                <button type="button" onClick={handleExportCSV} className="qi-ws-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold">
                    <Download className="w-4 h-4" /> Export {viewMode === 'raw' ? 'as uploaded' : 'cleaned'}
                </button>

                <span className="qi-ws-muted text-[12px] tabular-nums ml-auto">{filteredRows.length.toLocaleString()} of {activeRows.length.toLocaleString()} rows</span>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-[13px]">
                    <thead className="sticky top-0 z-10">
                        <tr className="qi-ws-thead">
                            <th className="px-3 py-2 text-left w-12">#</th>
                            {columns.map(col => (
                                <th
                                    key={col}
                                    onClick={() => handleSort(col)}
                                    className="px-3 py-2 text-left cursor-pointer whitespace-nowrap group"
                                    aria-sort={sortCol === col ? (sortAsc ? 'ascending' : 'descending') : undefined}
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        {viewMode === 'clean' ? <span className={roleClass(getColType(col))} title={getColType(col)}>{col}</span> : col}
                                        {sortCol === col
                                            ? <span className="qi-ws-strong text-[11px]">{sortAsc ? '↑' : '↓'}</span>
                                            : <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-60" />}
                                    </span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {pageRows.map((row, idx) => (
                            <tr key={idx} className="qi-ws-row is-static">
                                <td className="qi-ws-muted px-3 py-1.5 text-[11.5px] tabular-nums">{currentPage * pageSize + idx + 1}</td>
                                {columns.map(col => {
                                    const val = row[col];
                                    const isEmpty = val === null || val === undefined || val === '';
                                    return (
                                        <td key={col} className={`px-3 py-1.5 max-w-[220px] truncate ${isEmpty ? 'qi-ws-muted italic' : 'qi-ws-strong'}`}>
                                            {isEmpty ? 'blank' : String(val)}
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
                <div className="qi-ws-toolbar is-bottom flex items-center justify-between px-3 py-2 text-[12.5px]">
                    <span className="qi-ws-muted">Page {currentPage + 1} of {totalPages.toLocaleString()}</span>
                    <div className="flex gap-2">
                        <button type="button" disabled={currentPage === 0} onClick={() => setCurrentPage(p => p - 1)} className="qi-ws-ghost px-2.5 py-1 rounded-md disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
                        <button type="button" disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(p => p + 1)} className="qi-ws-ghost px-2.5 py-1 rounded-md disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
                    </div>
                </div>
            )}
        </div>
    );
};
