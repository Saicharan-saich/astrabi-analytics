import React from 'react';
import { Upload, FileSpreadsheet, Database, Zap, FileText, Trash2, FolderOpen, Clock } from 'lucide-react';
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
            <div className="flex flex-col items-center justify-center min-h-full p-8">
                <div className="max-w-5xl w-full">

                    {/* Hero Section */}
                    <div className="text-center mb-12">
                        <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 dark:text-white mb-4 tracking-tight">
                            Analyze Data Instantly
                        </h1>
                        <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto font-medium">
                            Upload your CSV/Excel files or connect to a database to instantly generate insights.
                            Powered by local deterministic compute.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">

                        {/* File Upload Card */}
                        <div className="bg-white dark:bg-[#1c2033] border border-gray-200 dark:border-white/10 rounded-2xl p-8 shadow-sm hover:shadow-md transition-shadow">
                            <div className="w-12 h-12 rounded-xl bg-violet-100 dark:bg-violet-500/20 flex items-center justify-center mb-6">
                                <Upload className="w-6 h-6 text-violet-600 dark:text-violet-400" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Upload Files</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 font-medium">Support for .csv and .xlsx files. Large datasets processed locally via Web Workers.</p>

                            <label className={`
                flex items-center justify-center w-full p-4 rounded-xl border-2 border-dashed 
                border-violet-300 dark:border-violet-500/30 
                hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-all cursor-pointer group/label
                ${processing ? 'opacity-50 pointer-events-none' : ''}
              `}>
                                <input type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={onFileUpload} disabled={processing} />
                                <div className="flex flex-col items-center gap-2">
                                    <span className="font-bold text-violet-600 dark:text-violet-300 group-hover/label:text-violet-700 dark:group-hover/label:text-violet-200">
                                        {processing ? 'Processing...' : 'Click to Browse'}
                                    </span>
                                </div>
                            </label>

                            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-white/5 flex gap-2 justify-center">
                                <button
                                    onClick={onSampleLoad}
                                    disabled={processing}
                                    className="text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-white flex items-center gap-1 transition-colors font-semibold"
                                >
                                    <Zap className="w-3 h-3" /> Try Sample Data
                                </button>
                            </div>
                        </div>

                        {/* Connectors Card */}
                        <div className="bg-white dark:bg-[#1c2033] border border-gray-200 dark:border-white/10 rounded-2xl p-8 flex flex-col shadow-sm hover:shadow-md transition-shadow">
                            <div className="w-12 h-12 rounded-xl bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center mb-6">
                                <Database className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Connect Data Source</h3>
                            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 font-medium">Directly connect to SQL Server or other databases.</p>

                            <div className="flex-1 -mx-4">
                                <ConnectorsPanel onDataReady={onConnectorLoad} />
                            </div>
                        </div>

                    </div>

                    {/* Recent Uploads Section */}
                    {datasets.length > 0 && (
                        <div className="mt-10">
                            <div className="flex items-center gap-3 mb-4">
                                <Clock className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Recent Uploads</h3>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-semibold">
                                    {datasets.length}
                                </span>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                {datasets.map((ds) => {
                                    const isActive = ds.id === activeDatasetId;
                                    return (
                                        <div
                                            key={ds.id}
                                            className={`relative bg-white dark:bg-[#1c2033] border rounded-xl p-4 transition-all hover:shadow-md ${isActive
                                                ? 'border-emerald-400 dark:border-emerald-500/40 ring-1 ring-emerald-300 dark:ring-emerald-500/20'
                                                : 'border-gray-200 dark:border-white/5'
                                                }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isActive ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400'}`}>
                                                    <FileSpreadsheet className="w-5 h-5" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <h4 className="font-bold text-gray-900 dark:text-white text-sm truncate" title={ds.name}>
                                                        {ds.name}
                                                    </h4>
                                                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400 font-medium">
                                                        <span>{ds.rows.length.toLocaleString()} rows</span>
                                                        <span>{ds.columns.length} columns</span>
                                                    </div>
                                                    {isActive && (
                                                        <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 px-2 py-0.5 rounded-full">
                                                            Active
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-white/5">
                                                {!isActive && onLoadDataset && (
                                                    <button
                                                        onClick={() => onLoadDataset(ds.id)}
                                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-500/20 hover:bg-violet-100 dark:hover:bg-violet-500/30 text-violet-700 dark:text-violet-300 text-xs font-bold transition-colors"
                                                    >
                                                        <FolderOpen className="w-3 h-3" />
                                                        Load
                                                    </button>
                                                )}
                                                {isActive && (
                                                    <span className="flex-1 text-center text-xs text-emerald-600 dark:text-emerald-400 font-semibold py-1.5">
                                                        Currently Loaded
                                                    </span>
                                                )}
                                                {onDeleteDataset && (
                                                    <button
                                                        onClick={() => onDeleteDataset(ds.id)}
                                                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 text-red-600 dark:text-red-400 text-xs font-bold transition-colors"
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
                        <div className="mt-8 p-4 bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/50 rounded-xl text-red-700 dark:text-red-200 text-sm text-center font-medium">
                            {error}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
