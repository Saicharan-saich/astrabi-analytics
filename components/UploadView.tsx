import React from 'react';
import { Upload, FileSpreadsheet, Database, Zap, Trash2, FolderOpen, Clock, Sparkles, BarChart2, Brain } from 'lucide-react';
import { ConnectorsPanel } from './ConnectorsPanel';
import { Dataset, LiveConnectionInfo } from '../types';

interface UploadViewProps {
    onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onSampleLoad: () => void;
    processing: boolean;
    error: string | null;
    onConnectorLoad: (data: any, name: string, sourceSchema?: any, liveInfo?: LiveConnectionInfo) => void;
    datasets?: Dataset[];
    onLoadDataset?: (id: string) => void;
    onDeleteDataset?: (id: string) => void;
    activeDatasetId?: string;
}

export const UploadView: React.FC<UploadViewProps> = ({
    onFileUpload, onSampleLoad, processing, error, onConnectorLoad,
    datasets = [], onLoadDataset, onDeleteDataset, activeDatasetId
}) => {
    return (
        <div className="h-full w-full overflow-y-auto">
            <div className="flex flex-col items-center justify-center min-h-full p-4 md:p-8 relative">
                {/* Ambient background */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    <div className="absolute top-0 left-1/4 w-[500px] h-[500px] rounded-full bg-violet-500/[0.03] blur-[100px]" />
                    <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] rounded-full bg-indigo-500/[0.03] blur-[80px]" />
                </div>

                <div className="max-w-5xl w-full relative z-10">

                    {/* Hero Section */}
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 mb-6">
                            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                            <span className="text-xs font-bold text-violet-400 uppercase tracking-wider">AI-Powered Analytics</span>
                        </div>
                        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4">
                            <span className="gradient-text">Analyze Data Instantly</span>
                        </h1>
                        <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto font-medium">
                            Upload your CSV/Excel files or connect to a database to instantly generate insights.
                        </p>

                        {/* Feature pills */}
                        <div className="flex items-center justify-center gap-4 mt-6">
                            {[
                                { icon: <BarChart2 className="w-3.5 h-3.5" />, label: '20+ Chart Types' },
                                { icon: <Brain className="w-3.5 h-3.5" />, label: 'AI SQL Engine' },
                                { icon: <Zap className="w-3.5 h-3.5" />, label: 'Real-time Insights' },
                            ].map((feat, i) => (
                                <div key={i} className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-500">
                                    <span className="text-indigo-400">{feat.icon}</span>
                                    {feat.label}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">

                        {/* File Upload Card */}
                        <div className="glass-frost rounded-2xl p-8 card-hover-lift">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-500/20 to-indigo-500/20 flex items-center justify-center mb-6 border border-violet-500/10">
                                <Upload className="w-6 h-6 text-violet-400" />
                            </div>
                            <h3 className="text-xl font-bold text-white dark:text-white mb-2">Upload Files</h3>
                            <p className="text-sm text-gray-400 mb-6 font-medium">Support for .csv and .xlsx files. Large datasets processed locally via Web Workers.</p>

                            <label className={`
                                flex flex-col items-center justify-center w-full p-6 rounded-xl border-2 border-dashed 
                                border-violet-500/20 
                                hover:border-violet-500/40 hover:bg-violet-500/[0.04] transition-all cursor-pointer group/label
                                ${processing ? 'opacity-50 pointer-events-none' : ''}
                            `}>
                                <input type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={onFileUpload} disabled={processing} />
                                <div className="w-10 h-10 rounded-full bg-violet-500/10 flex items-center justify-center mb-3 group-hover/label:bg-violet-500/20 transition-colors">
                                    <Upload className="w-5 h-5 text-violet-400" />
                                </div>
                                <span className="font-bold text-violet-300 group-hover/label:text-violet-200 text-sm">
                                    {processing ? 'Processing...' : 'Click to Browse or Drag & Drop'}
                                </span>
                                <span className="text-[11px] text-gray-500 mt-1">.csv, .xlsx, .xls</span>
                            </label>

                            <div className="mt-5 pt-4 border-t border-white/[0.06] flex gap-3 justify-center">
                                <button
                                    onClick={onSampleLoad}
                                    disabled={processing}
                                    className="text-xs text-gray-400 hover:text-violet-300 flex items-center gap-1.5 transition-colors font-bold px-3 py-1.5 rounded-lg hover:bg-violet-500/10"
                                >
                                    <Zap className="w-3.5 h-3.5 text-amber-400" /> Try Sample Data
                                </button>
                            </div>
                        </div>

                        {/* Connectors Card */}
                        <div className="glass-frost rounded-2xl p-8 flex flex-col card-hover-lift">
                            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center mb-6 border border-emerald-500/10">
                                <Database className="w-6 h-6 text-emerald-400" />
                            </div>
                            <h3 className="text-xl font-bold text-white dark:text-white mb-2">Connect Data Source</h3>
                            <p className="text-sm text-gray-400 mb-6 font-medium">Directly connect to SQL Server or PostgreSQL databases.</p>

                            <div className="flex-1 -mx-4">
                                <ConnectorsPanel onDataReady={onConnectorLoad} />
                            </div>
                        </div>

                    </div>

                    {/* Recent Uploads Section */}
                    {datasets.length > 0 && (
                        <div className="mt-10">
                            <div className="flex items-center gap-3 mb-5">
                                <div className="h-px flex-1 bg-gradient-to-r from-violet-500/20 to-transparent" />
                                <div className="flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-gray-500" />
                                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">Recent Uploads</h3>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 font-bold">
                                        {datasets.length}
                                    </span>
                                </div>
                                <div className="h-px flex-1 bg-gradient-to-l from-violet-500/20 to-transparent" />
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                {datasets.map((ds) => {
                                    const isActive = ds.id === activeDatasetId;
                                    return (
                                        <div
                                            key={ds.id}
                                            className={`relative glass-frost rounded-xl p-4 transition-all card-hover-lift ${isActive
                                                ? 'border-emerald-500/30 ring-1 ring-emerald-500/20'
                                                : 'border-white/[0.06]'
                                                }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-violet-500/15 text-violet-400'}`}>
                                                    <FileSpreadsheet className="w-5 h-5" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <h4 className="font-bold text-white text-sm truncate" title={ds.name}>
                                                        {ds.name}
                                                    </h4>
                                                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 font-medium">
                                                        <span>{ds.rows.length.toLocaleString()} rows</span>
                                                        <span>{ds.columns.length} columns</span>
                                                    </div>
                                                    {isActive && (
                                                        <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                                            Active
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.06]">
                                                {!isActive && onLoadDataset && (
                                                    <button
                                                        onClick={() => onLoadDataset(ds.id)}
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 text-xs font-bold transition-colors"
                                                    >
                                                        <FolderOpen className="w-3 h-3" />
                                                        Load
                                                    </button>
                                                )}
                                                {isActive && (
                                                    <span className="flex-1 text-center text-xs text-emerald-400 font-semibold py-1.5">
                                                        Currently Loaded
                                                    </span>
                                                )}
                                                {onDeleteDataset && (
                                                    <button
                                                        onClick={() => onDeleteDataset(ds.id)}
                                                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-bold transition-colors"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                        Delete
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm text-center font-medium">
                            {error}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
