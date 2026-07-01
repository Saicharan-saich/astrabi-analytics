import React, { useMemo, useState } from 'react';
import { Dataset, ColumnType } from '../types';
import { generateColumnProfile } from '../services/analysisEngine';
import { Search, ChevronDown, ChevronRight, Hash, Calendar, Type, Fingerprint } from 'lucide-react';

export const DataView: React.FC<{ dataset: Dataset }> = ({ dataset }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const profiles = useMemo(() => generateColumnProfile(dataset.rows, dataset.columns), [dataset]);
    const [activeTab, setActiveTab] = useState<'table' | 'profile'>('table');

    const filteredRows = useMemo(() => {
        if (!searchTerm) return dataset.rows.slice(0, 100); // Pagination cap for performance
        return dataset.rows.filter(row => 
            Object.values(row).some(val => String(val).toLowerCase().includes(searchTerm.toLowerCase()))
        ).slice(0, 100);
    }, [dataset.rows, searchTerm]);

    return (
        <div className="flex flex-col h-full bg-slate-50">
            <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-slate-200">
                <div className="flex space-x-4">
                    <button 
                        onClick={() => setActiveTab('table')}
                        className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'table' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        Raw Data Table
                    </button>
                    <button 
                        onClick={() => setActiveTab('profile')}
                        className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'profile' ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        Column Profiler
                    </button>
                </div>
                {activeTab === 'table' && (
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input 
                            type="text" 
                            placeholder="Search data..." 
                            className="pl-9 pr-4 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                        />
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-auto p-6">
                {activeTab === 'table' ? (
                    <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left text-slate-600">
                                <thead className="text-xs text-slate-700 uppercase bg-slate-50 border-b border-slate-200">
                                    <tr>
                                        {dataset.columns.map(col => (
                                            <th key={col.name} className="px-6 py-3 font-semibold whitespace-nowrap">
                                                {col.name}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredRows.map((row, i) => (
                                        <tr key={i} className="bg-white border-b hover:bg-slate-50">
                                            {dataset.columns.map(col => (
                                                <td key={`${i}-${col.name}`} className="px-6 py-4 whitespace-nowrap">
                                                    {row[col.name]?.toString() || '-'}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="p-4 border-t border-slate-200 text-xs text-slate-400 text-center">
                            Showing first {filteredRows.length} of {dataset.totalRows} rows
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {profiles.map(p => (
                            <div key={p.name} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                                <div className="flex items-start justify-between mb-4">
                                    <div>
                                        <h3 className="font-bold text-slate-800 text-lg flex items-center">
                                            {p.name}
                                        </h3>
                                        <span className={`text-xs px-2 py-0.5 rounded-full font-mono mt-1 inline-block
                                            ${p.type === ColumnType.METRIC ? 'bg-emerald-100 text-emerald-700' : 
                                              p.type === ColumnType.DATE ? 'bg-orange-100 text-orange-700' : 
                                              'bg-blue-100 text-blue-700'}`
                                        }>
                                            {p.type}
                                        </span>
                                    </div>
                                    <div className="p-2 bg-slate-50 rounded-lg">
                                        {p.type === ColumnType.METRIC ? <Hash className="w-5 h-5 text-slate-400" /> :
                                         p.type === ColumnType.DATE ? <Calendar className="w-5 h-5 text-slate-400" /> :
                                         p.type === ColumnType.ID ? <Fingerprint className="w-5 h-5 text-slate-400" /> :
                                         <Type className="w-5 h-5 text-slate-400" />}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
                                    <div className="bg-slate-50 p-2 rounded">
                                        <div className="text-slate-400 text-xs uppercase">Unique</div>
                                        <div className="font-semibold text-slate-700">{p.uniqueCount}</div>
                                    </div>
                                    <div className="bg-slate-50 p-2 rounded">
                                        <div className="text-slate-400 text-xs uppercase">Nulls</div>
                                        <div className="font-semibold text-slate-700">{p.nullCount}</div>
                                    </div>
                                </div>

                                {p.type === ColumnType.METRIC && (
                                     <div className="mb-4 space-y-2 text-sm border-t border-slate-100 pt-3">
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Min</span>
                                            <span className="font-mono">{p.min?.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Max</span>
                                            <span className="font-mono">{p.max?.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-500">Avg</span>
                                            <span className="font-mono">{p.avg?.toFixed(2)}</span>
                                        </div>
                                     </div>
                                )}

                                <div className="border-t border-slate-100 pt-3">
                                    <div className="text-xs font-bold text-slate-400 uppercase mb-2">Top Values</div>
                                    <div className="space-y-1">
                                        {p.topValues.map((v, i) => (
                                            <div key={i} className="flex justify-between text-sm">
                                                <span className="truncate text-slate-600 w-2/3" title={v.value}>{v.value}</span>
                                                <span className="text-slate-400 bg-slate-100 px-1.5 rounded text-xs">{v.count}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};