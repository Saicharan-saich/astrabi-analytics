import React, { useState } from 'react';
import {
    Database, GitMerge, Columns3, Key, Hash, Type, Calendar,
    ArrowRight, Table2, AlertCircle, FileSpreadsheet, Link2,
    ChevronDown, ChevronRight, Layers, Zap, CheckCircle2
} from 'lucide-react';
import { Dataset, SourceSchema, SourceTableInfo, SourceJoinEdge, SourceColumnInfo } from '../types';
import { RelationshipEditor } from './RelationshipEditor';

interface SchemaViewProps {
    dataset: Dataset | null;
}

const getTypeIcon = (dt: string) => {
    const lower = dt.toLowerCase();
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'bit'].some(t => lower.includes(t)))
        return <Hash className="w-3.5 h-3.5 text-emerald-400" />;
    if (['date', 'time', 'datetime', 'datetime2', 'timestamp'].some(t => lower.includes(t)))
        return <Calendar className="w-3.5 h-3.5 text-amber-400" />;
    return <Type className="w-3.5 h-3.5 text-blue-400" />;
};

const getTypeColor = (dt: string) => {
    const lower = dt.toLowerCase();
    if (['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'bit'].some(t => lower.includes(t)))
        return 'text-emerald-400';
    if (['date', 'time', 'datetime', 'datetime2', 'timestamp'].some(t => lower.includes(t)))
        return 'text-amber-400';
    return 'text-blue-400';
};

export const SchemaView: React.FC<SchemaViewProps> = ({ dataset }) => {
    const [expandedTable, setExpandedTable] = useState<string | null>(null);
    const schema = dataset?.sourceSchema;

    if (!dataset) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center py-20">
                    <Database className="w-16 h-16 text-slate-600 mx-auto mb-4 opacity-30" />
                    <h3 className="text-lg font-semibold text-slate-400">No Dataset Loaded</h3>
                    <p className="text-sm text-slate-500 mt-2">Upload a file or connect to a data source first.</p>
                </div>
            </div>
        );
    }

    if (!schema) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center py-20 max-w-md">
                    <Layers className="w-16 h-16 text-slate-600 mx-auto mb-4 opacity-30" />
                    <h3 className="text-lg font-semibold text-slate-400">No Source Schema Available</h3>
                    <p className="text-sm text-slate-500 mt-2">
                        Schema information is available when you import multiple tables from a SQL database connector.
                        The application automatically detects relationships and builds a star schema.
                    </p>
                    <div className="mt-5 p-4 bg-slate-800/50 rounded-xl border border-slate-700 text-left">
                        <p className="text-xs text-slate-400 font-medium mb-2">Current Dataset</p>
                        <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-4 h-4 text-indigo-500" />
                            <span className="text-sm text-slate-300 font-semibold">{dataset.name}</span>
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">
                            {dataset.totalRows.toLocaleString()} rows · {dataset.columns.length} columns
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const totalSourceCols = schema.tables.reduce((sum, t) => sum + t.columns.length, 0);
    const totalSourceRows = schema.tables.reduce((sum, t) => sum + t.rows, 0);

    return (
        <div className="h-full overflow-y-auto p-6 space-y-6">

            {/* ─── Header ──────────────────────────────── */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <GitMerge className="w-5 h-5 text-indigo-400" />
                        Source Schema
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">
                        Showing the imported table structure and relationships for <span className="text-indigo-400 font-medium">{dataset.name}</span>
                    </p>
                </div>
            </div>

            <RelationshipEditor dataset={dataset} />
            {/* ─── Summary Cards ──────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                    { label: 'Source Tables', value: schema.tables.length, icon: Table2, color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/20' },
                    { label: 'Total Columns', value: totalSourceCols, icon: Columns3, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/20' },
                    { label: 'Joins Detected', value: schema.joinEdges.length, icon: Link2, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
                    { label: 'Master Table Rows', value: dataset.totalRows.toLocaleString(), icon: FileSpreadsheet, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
                ].map((card, i) => (
                    <div key={i} className={`rounded-xl border p-4 ${card.bg}`}>
                        <div className="flex items-center gap-2 mb-2">
                            <card.icon className={`w-4 h-4 ${card.color}`} />
                            <span className="text-xs text-slate-400 font-medium">{card.label}</span>
                        </div>
                        <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
                    </div>
                ))}
            </div>

            {/* ─── Relationship Diagram ──────────────── */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-5">
                <div className="flex items-center gap-2 mb-4">
                    <GitMerge className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-sm font-bold text-white">Relationship Map</h3>
                    {schema.joinEdges.length > 0 && (
                        <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full font-semibold">
                            {schema.joinEdges.length} join{schema.joinEdges.length !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>

                {schema.joinEdges.length === 0 ? (
                    <div className="text-center py-8">
                        <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2 opacity-60" />
                        <p className="text-sm text-slate-400">No automatic relationships detected between tables.</p>
                        <p className="text-xs text-slate-500 mt-1">Tables were imported independently.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {schema.joinEdges.map((edge, i) => (
                            <div key={i} className="flex items-center gap-3 group">
                                {/* Left table card */}
                                <div className="flex items-center gap-2 bg-slate-700/60 rounded-lg px-4 py-2.5 border border-slate-600 shadow-sm min-w-[160px] group-hover:border-indigo-500/50 transition-colors">
                                    <Database className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                                    <div>
                                        <div className="text-xs font-bold text-white">{edge.leftTable}</div>
                                        <div className="text-[10px] font-mono text-indigo-300">{edge.leftColumn}</div>
                                    </div>
                                </div>

                                {/* Join connector */}
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                    <div className="w-10 h-[2px] bg-gradient-to-r from-slate-500 to-transparent group-hover:from-indigo-500 transition-colors" />
                                    <div className={`px-2 py-1 rounded-md text-[9px] font-extrabold uppercase tracking-wider border ${edge.type === 'fk'
                                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                            : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                                        }`}>
                                        {edge.provenance === 'inferred' ? 'VALIDATED INFERENCE' : edge.provenance === 'user' ? 'USER CONFIRMED' : edge.type === 'fk' ? 'FOREIGN KEY' : 'NAME MATCH'}
                                    </div>
                                    <div className="w-10 h-[2px] bg-gradient-to-l from-slate-500 to-transparent group-hover:from-purple-500 transition-colors" />
                                    <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-indigo-400 transition-colors" />
                                </div>

                                {/* Right table card */}
                                <div className="flex items-center gap-2 bg-slate-700/60 rounded-lg px-4 py-2.5 border border-slate-600 shadow-sm min-w-[160px] group-hover:border-purple-500/50 transition-colors">
                                    <Database className="w-4 h-4 text-purple-400 flex-shrink-0" />
                                    <div>
                                        <div className="text-xs font-bold text-white">{edge.rightTable}</div>
                                        <div className="text-[10px] font-mono text-purple-300">{edge.rightColumn}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ─── Join Log ──────────────────────────── */}
            {schema.joinLogs.length > 0 && (
                <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-5">
                    <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-4 h-4 text-amber-400" />
                        <h3 className="text-sm font-bold text-white">Join Execution Log</h3>
                    </div>
                    <div className="space-y-1.5">
                        {schema.joinLogs.map((log, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs">
                                <span className="text-slate-500 font-mono w-5 text-right flex-shrink-0">{i + 1}.</span>
                                <span className="text-slate-300 font-mono leading-relaxed">{log}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ─── Tables & Columns ──────────────────── */}
            <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-5">
                <div className="flex items-center gap-2 mb-4">
                    <Columns3 className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-sm font-bold text-white">Source Table Columns</h3>
                </div>

                <div className="space-y-3">
                    {schema.tables.map((table) => {
                        const isExpanded = expandedTable === table.name;
                        const pkCols = table.columns.filter(c => c.isPK);
                        // Check if this table participates in any join
                        const joins = schema.joinEdges.filter(e => e.leftTable === table.name || e.rightTable === table.name);

                        return (
                            <div key={table.name} className={`rounded-xl border transition-colors ${isExpanded ? 'border-indigo-500/40 bg-slate-700/30' : 'border-slate-600 hover:border-slate-500'
                                }`}>
                                <button
                                    onClick={() => setExpandedTable(isExpanded ? null : table.name)}
                                    className="w-full flex items-center justify-between p-4 text-left"
                                >
                                    <div className="flex items-center gap-3">
                                        {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                                        <Database className="w-4 h-4 text-indigo-400" />
                                        <div>
                                            <div className="text-sm font-bold text-white">{table.name}</div>
                                            <div className="text-[10px] text-slate-400">
                                                {table.rows.toLocaleString()} rows · {table.columns.length} columns
                                                {pkCols.length > 0 && <span className="ml-2 text-amber-400">· {pkCols.length} PK</span>}
                                                {joins.length > 0 && <span className="ml-2 text-emerald-400">· {joins.length} join{joins.length !== 1 ? 's' : ''}</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {joins.length > 0 && (
                                            <span className="text-[9px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full font-semibold border border-emerald-500/20">
                                                RELATIONSHIPS AVAILABLE
                                            </span>
                                        )}
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="px-4 pb-4 pl-12">
                                        <div className="bg-slate-900/50 rounded-lg border border-slate-600 overflow-hidden">
                                            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 bg-slate-700/50 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                                <span>Column</span>
                                                <span>Type</span>
                                                <span>Nullable</span>
                                                <span>Key</span>
                                            </div>
                                            {table.columns.map((col, i) => (
                                                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-4 py-2 text-xs border-t border-slate-700/50 items-center hover:bg-slate-700/20 transition-colors">
                                                    <span className="font-mono text-slate-200 flex items-center gap-2 truncate">
                                                        {getTypeIcon(col.dataType)}
                                                        {col.name}
                                                    </span>
                                                    <span className={`font-mono text-[10px] ${getTypeColor(col.dataType)}`}>{col.dataType}</span>
                                                    <span className="text-center">{col.isNullable ? <span className="text-slate-500 text-[10px]">YES</span> : <span className="text-amber-400 text-[10px] font-bold">NOT NULL</span>}</span>
                                                    <span className="text-center">{col.isPK && <Key className="w-3.5 h-3.5 text-amber-400" />}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ─── Master Table Summary ──────────────── */}
            <div className="bg-gradient-to-r from-indigo-500/10 to-purple-500/10 rounded-xl border border-indigo-500/20 p-5">
                <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                    <h3 className="text-sm font-bold text-white">Master Table Result</h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
                    <div>
                        <div className="text-2xl font-bold text-indigo-400">{dataset.totalRows.toLocaleString()}</div>
                        <div className="text-[10px] text-slate-400 font-medium uppercase">Rows</div>
                    </div>
                    <div>
                        <div className="text-2xl font-bold text-purple-400">{dataset.columns.length}</div>
                        <div className="text-[10px] text-slate-400 font-medium uppercase">Columns</div>
                    </div>
                    <div>
                        <div className="text-2xl font-bold text-emerald-400">{schema.tables.length}</div>
                        <div className="text-[10px] text-slate-400 font-medium uppercase">Source Tables</div>
                    </div>
                </div>
            </div>
        </div>
    );
};
