import React, { useState } from 'react';
import { X, Plus, LayoutDashboard, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import { DashboardItem, DashboardDefinition } from '../types';

interface PinToDashboardModalProps {
    item: DashboardItem;
    onClose: () => void;
    onPinned: (dashboardName: string) => void;
}

export const PinToDashboardModal: React.FC<PinToDashboardModalProps> = ({ item, onClose, onPinned }) => {
    const { dashboards, createDashboard, addItemToDashboard } = useAppStore();
    const [isCreating, setIsCreating] = useState(dashboards.length === 0);
    const [newName, setNewName] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(dashboards[0]?.id || null);

    const theme = useAppStore(s => s.theme);
    const isDark = theme === 'dark';

    const handlePin = () => {
        if (isCreating && newName.trim()) {
            // Create new dashboard and pin to it
            const id = createDashboard(newName.trim());
            addItemToDashboard(id, item);
            onPinned(newName.trim());
        } else if (selectedId) {
            // Pin to existing dashboard
            addItemToDashboard(selectedId, item);
            const db = dashboards.find(d => d.id === selectedId);
            onPinned(db?.name || 'Dashboard');
        }
        onClose();
    };

    const handleCreateAndSwitch = () => {
        setIsCreating(true);
        setSelectedId(null);
        setTimeout(() => {
            document.getElementById('new-dashboard-name')?.focus();
        }, 100);
    };

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ duration: 0.2 }}
                    className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden ${
                        isDark
                            ? 'bg-[#171c26] border-white/[0.08]'
                            : 'bg-white border-gray-200'
                    }`}
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className={`px-6 py-4 border-b flex items-center justify-between ${
                        isDark ? 'border-white/[0.06]' : 'border-gray-100'
                    }`}>
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
                                <LayoutDashboard className="w-4 h-4 text-white" />
                            </div>
                            <div>
                                <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                                    Pin to Dashboard
                                </h3>
                                <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Choose where to save this visual
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className={`p-1.5 rounded-lg transition-colors ${
                                isDark ? 'text-gray-500 hover:text-white hover:bg-white/[0.06]' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
                            }`}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Visual preview */}
                    <div className={`mx-6 mt-4 px-3 py-2 rounded-lg text-xs font-medium truncate ${
                        isDark ? 'bg-white/[0.04] text-gray-400 border border-white/[0.06]' : 'bg-gray-50 text-gray-500 border border-gray-200'
                    }`}>
                        📌 {item.title || 'Untitled Visual'}
                    </div>

                    {/* Dashboard list */}
                    <div className="px-6 py-4 space-y-2 max-h-64 overflow-y-auto">
                        {dashboards.length > 0 && !isCreating && (
                            <>
                                <p className={`text-[11px] font-semibold uppercase tracking-wider mb-2 ${
                                    isDark ? 'text-gray-500' : 'text-gray-400'
                                }`}>
                                    Existing Dashboards
                                </p>
                                {dashboards.map(db => (
                                    <button
                                        key={db.id}
                                        onClick={() => { setSelectedId(db.id); setIsCreating(false); }}
                                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                                            selectedId === db.id
                                                ? isDark
                                                    ? 'bg-violet-500/15 border border-violet-500/30 text-violet-300'
                                                    : 'bg-violet-50 border border-violet-200 text-violet-700'
                                                : isDark
                                                    ? 'bg-white/[0.03] border border-white/[0.06] text-gray-300 hover:bg-white/[0.06]'
                                                    : 'bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100'
                                        }`}
                                    >
                                        <LayoutDashboard className="w-4 h-4 flex-shrink-0 opacity-60" />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate">{db.name}</div>
                                            <div className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {db.items.length} visual{db.items.length !== 1 ? 's' : ''}
                                            </div>
                                        </div>
                                        {selectedId === db.id && (
                                            <Check className="w-4 h-4 text-violet-400 flex-shrink-0" />
                                        )}
                                    </button>
                                ))}
                            </>
                        )}

                        {/* Create new dashboard */}
                        {isCreating ? (
                            <div className={`p-3 rounded-xl border-2 border-dashed ${
                                isDark ? 'border-violet-500/30 bg-violet-500/5' : 'border-violet-300 bg-violet-50'
                            }`}>
                                <p className={`text-xs font-semibold mb-2 ${isDark ? 'text-violet-300' : 'text-violet-600'}`}>
                                    New Dashboard
                                </p>
                                <input
                                    id="new-dashboard-name"
                                    type="text"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) handlePin(); }}
                                    placeholder="e.g. Sales Overview"
                                    autoFocus
                                    className={`w-full px-3 py-2 rounded-lg text-sm font-medium outline-none transition-colors ${
                                        isDark
                                            ? 'bg-[#12161f] text-white border border-white/[0.1] focus:border-violet-500/50 placeholder:text-gray-600'
                                            : 'bg-white text-gray-900 border border-gray-300 focus:border-violet-400 placeholder:text-gray-400'
                                    }`}
                                />
                                {dashboards.length > 0 && (
                                    <button
                                        onClick={() => { setIsCreating(false); setSelectedId(dashboards[0]?.id || null); }}
                                        className={`mt-2 text-xs ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
                                    >
                                        ← Back to existing
                                    </button>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={handleCreateAndSwitch}
                                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 border-dashed text-sm font-medium transition-all ${
                                    isDark
                                        ? 'border-white/[0.08] text-gray-400 hover:border-violet-500/30 hover:text-violet-300 hover:bg-violet-500/5'
                                        : 'border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50'
                                }`}
                            >
                                <Plus className="w-4 h-4" />
                                Create New Dashboard
                            </button>
                        )}
                    </div>

                    {/* Footer */}
                    <div className={`px-6 py-4 border-t flex items-center justify-end gap-2 ${
                        isDark ? 'border-white/[0.06]' : 'border-gray-100'
                    }`}>
                        <button
                            onClick={onClose}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                isDark ? 'text-gray-400 hover:text-white hover:bg-white/[0.06]' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                            }`}
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handlePin}
                            disabled={isCreating ? !newName.trim() : !selectedId}
                            className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${
                                (isCreating ? newName.trim() : selectedId)
                                    ? 'bg-gradient-to-r from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-500/25 hover:shadow-violet-500/40'
                                    : isDark
                                        ? 'bg-white/[0.06] text-gray-600 cursor-not-allowed'
                                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            }`}
                        >
                            Pin to Dashboard
                        </button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
