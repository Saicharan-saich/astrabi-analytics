import React, { useState, useRef, useEffect } from 'react';
import { Database, ChevronDown, X, Plus } from 'lucide-react';
import { Dataset } from '../types';

interface DatasetSwitcherProps {
    datasets: Dataset[];
    activeDataset: Dataset | null;
    onSwitch: (id: string) => void;
    onRemove: (id: string) => void;
    onAddNew: () => void;
}

export const DatasetSwitcher: React.FC<DatasetSwitcherProps> = ({
    datasets,
    activeDataset,
    onSwitch,
    onRemove,
    onAddNew,
}) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    if (datasets.length <= 1) return null;

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/10 transition-all text-slate-300 hover:text-white"
            >
                <Database className="w-4 h-4 text-indigo-400" />
                <span className="truncate max-w-[140px]">{activeDataset?.name || 'Select'}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="absolute top-full mt-2 left-0 w-72 rounded-xl border border-white/10 bg-slate-900/95 backdrop-blur-lg shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2">
                    <div className="px-3 py-2.5 border-b border-white/5">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                            Loaded Datasets ({datasets.length})
                        </span>
                    </div>

                    <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
                        {datasets.map(ds => (
                            <div
                                key={ds.id}
                                className={`flex items-center justify-between px-3 py-2.5 cursor-pointer transition-colors group ${ds.id === activeDataset?.id
                                        ? 'bg-indigo-500/15 text-white'
                                        : 'hover:bg-white/5 text-slate-400'
                                    }`}
                            >
                                <button
                                    onClick={() => { onSwitch(ds.id); setOpen(false); }}
                                    className="flex-1 text-left truncate"
                                >
                                    <span className={`text-sm font-medium ${ds.id === activeDataset?.id ? 'text-indigo-300' : 'text-slate-300'}`}>
                                        {ds.name}
                                    </span>
                                    <span className="block text-[10px] text-slate-500">
                                        {ds.totalRows.toLocaleString()} rows · {ds.columns.length} cols
                                    </span>
                                </button>
                                {ds.id !== activeDataset?.id && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onRemove(ds.id); }}
                                        className="p-1 rounded text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                                        title="Remove dataset"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>

                    <div className="border-t border-white/5">
                        <button
                            onClick={() => { onAddNew(); setOpen(false); }}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-slate-400 hover:text-indigo-300 hover:bg-white/5 transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            Load another dataset
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
