import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Eye, EyeOff, Search, BarChart2, Lightbulb, Sparkles, Wrench, Layout, Bell, Activity, Upload, GitMerge, Database, Gamepad2, Check, CloudOff, Loader2 } from 'lucide-react';
import { Tab } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useTheme } from './ThemeProvider';
import { saveGlobalHiddenTabs } from '../services/tabVisibilityService';

interface TabInfo {
  id: Tab;
  label: string;
  icon: React.FC<any>;
  section: string;
  description: string;
  canHide: boolean; // Some tabs should never be hidden (e.g., UPLOAD, DASHBOARD)
}

const ALL_TABS: TabInfo[] = [
  // Data
  { id: Tab.UPLOAD, label: 'Data Source', icon: Upload, section: 'Data', description: 'Upload CSV/Excel or connect to databases', canHide: false },
  // Explore Data
  { id: Tab.COLUMN_MAPPING, label: 'Column Mapping', icon: Database, section: 'Explore Data', description: 'Review AI-detected column types', canHide: true },
  { id: Tab.ETL, label: 'ETL Pipeline', icon: Database, section: 'Explore Data', description: 'Automated data cleaning steps', canHide: true },
  { id: Tab.SCHEMA, label: 'Schema', icon: GitMerge, section: 'Explore Data', description: 'Column classification overview', canHide: true },
  { id: Tab.DATA, label: 'Data Explorer', icon: BarChart2, section: 'Explore Data', description: 'Browse cleaned data', canHide: true },
  { id: Tab.DATASET_SUMMARY, label: 'Dataset Summary', icon: BarChart2, section: 'Explore Data', description: 'Column statistics and distributions', canHide: true },
  // Analysis
  { id: Tab.GAME, label: 'GAFS Challenge', icon: Gamepad2, section: 'Analysis', description: 'Story-led GAFS lessons and practice drill', canHide: true },
  { id: Tab.SMART_QUESTIONS, label: 'Smart Insights', icon: Lightbulb, section: 'Analysis', description: 'AI-curated analytical questions', canHide: true },
  { id: Tab.BUILDER, label: 'Question Builder', icon: Search, section: 'Analysis', description: 'Visual no-code query designer', canHide: false },
  { id: Tab.AI_SQL, label: 'AI SQL', icon: Sparkles, section: 'Analysis', description: 'Natural language to SQL', canHide: true },
  { id: Tab.DERIVED_COLUMNS, label: 'Derived Columns', icon: Lightbulb, section: 'Analysis', description: 'Custom calculated metrics', canHide: true },
  { id: Tab.CUSTOM_QUESTIONS, label: 'Custom Questions', icon: Wrench, section: 'Analysis', description: 'Admin question templates', canHide: true },
  // Special (not a Tab enum — uses string ID)
  { id: 'DATA_STORY' as any, label: 'Data Story', icon: BarChart2, section: 'Analysis', description: 'AI-generated narrative from your data', canHide: true },
  // Views
  { id: Tab.DASHBOARD, label: 'Dashboard', icon: Layout, section: 'Views', description: 'Pinned charts and analyses', canHide: false },
  { id: Tab.ALERTS, label: 'Monitoring', icon: Bell, section: 'Views', description: 'Business rules and alerts', canHide: true },
  { id: Tab.USER_INSIGHTS, label: 'User Insights', icon: Activity, section: 'Views', description: 'Usage analytics per user', canHide: true },
];

interface TabVisibilityManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TabVisibilityManager: React.FC<TabVisibilityManagerProps> = ({ isOpen, onClose }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const hiddenTabs = useAppStore((s) => s.hiddenTabs) || [];
  const setHiddenTabs = useAppStore((s) => s.setHiddenTabs);

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Toggle a tab AND persist the new global config to the backend so the
  // change applies to every user — not just this admin's browser.
  const handleToggle = async (tabId: string) => {
    const next = hiddenTabs.includes(tabId)
      ? hiddenTabs.filter((t) => t !== tabId)
      : [...hiddenTabs, tabId];
    setHiddenTabs(next); // optimistic local update
    setSaveState('saving');
    const ok = await saveGlobalHiddenTabs(next);
    setSaveState(ok ? 'saved' : 'error');
    if (ok) setTimeout(() => setSaveState('idle'), 2000);
  };

  const sections = ['Data', 'Explore Data', 'Analysis', 'Views'];

  const isHidden = (tabId: string) => hiddenTabs.includes(tabId);
  const hiddenCount = ALL_TABS.filter(t => t.canHide && isHidden(t.id)).length;
  const totalHideable = ALL_TABS.filter(t => t.canHide).length;

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className={`w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border ${isDark ? 'bg-[#171c26] border-white/10' : 'bg-white border-gray-200'}`}
          >
            {/* Header */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <div>
                <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Manage Tabs</h2>
                <p className={`text-xs mt-0.5 flex items-center gap-2 ${isDark ? 'text-slate-400' : 'text-gray-500'}`}>
                  <span>{hiddenCount} of {totalHideable} optional tabs hidden · applies to all users</span>
                  {saveState === 'saving' && <span className="inline-flex items-center gap-1 text-slate-400"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>}
                  {saveState === 'saved' && <span className="inline-flex items-center gap-1 text-emerald-500"><Check className="w-3 h-3" /> Saved for everyone</span>}
                  {saveState === 'error' && <span className="inline-flex items-center gap-1 text-amber-500"><CloudOff className="w-3 h-3" /> Couldn’t sync — check connection</span>}
                </p>
              </div>
              <button
                onClick={onClose}
                className={`p-2 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-auto px-6 py-4 space-y-5">
              {sections.map(section => {
                const sectionTabs = ALL_TABS.filter(t => t.section === section);
                if (sectionTabs.length === 0) return null;

                return (
                  <div key={section}>
                    <h3 className={`text-[10px] font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-slate-500' : 'text-gray-400'}`}>
                      {section}
                    </h3>
                    <div className="space-y-1">
                      {sectionTabs.map(tab => {
                        const hidden = isHidden(tab.id);
                        const Icon = tab.icon;
                        return (
                          <button
                            key={tab.id}
                            onClick={() => tab.canHide && handleToggle(tab.id)}
                            disabled={!tab.canHide}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left group ${
                              !tab.canHide
                                ? isDark ? 'opacity-50 cursor-not-allowed' : 'opacity-50 cursor-not-allowed'
                                : hidden
                                  ? isDark ? 'bg-white/[0.02] hover:bg-white/[0.05]' : 'bg-gray-50 hover:bg-gray-100'
                                  : isDark ? 'bg-white/[0.04] hover:bg-white/[0.07]' : 'bg-white hover:bg-gray-50 shadow-sm border border-gray-100'
                            }`}
                          >
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                              hidden
                                ? isDark ? 'bg-white/[0.04] text-slate-600' : 'bg-gray-100 text-gray-300'
                                : isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-50 text-violet-600'
                            }`}>
                              <Icon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-semibold ${
                                hidden
                                  ? isDark ? 'text-slate-500 line-through' : 'text-gray-400 line-through'
                                  : isDark ? 'text-white' : 'text-gray-900'
                              }`}>{tab.label}</p>
                              <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-gray-400'}`}>{tab.description}</p>
                            </div>
                            <div className="shrink-0">
                              {!tab.canHide ? (
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isDark ? 'bg-white/5 text-slate-500' : 'bg-gray-100 text-gray-400'}`}>Required</span>
                              ) : hidden ? (
                                <EyeOff className={`w-4 h-4 ${isDark ? 'text-slate-600' : 'text-gray-300'}`} />
                              ) : (
                                <Eye className={`w-4 h-4 ${isDark ? 'text-emerald-400' : 'text-emerald-500'}`} />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className={`px-6 py-3 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
              <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-gray-400'}`}>
                Changes apply globally for all users
              </p>
              <button
                onClick={onClose}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${isDark ? 'bg-violet-600 hover:bg-violet-500 text-white' : 'bg-violet-600 hover:bg-violet-500 text-white'}`}
              >
                Done
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default TabVisibilityManager;
