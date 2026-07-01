import React, { useState } from 'react';
import { Bell, Plus, Shield, Trash2, Copy, Pause, Play, Edit2, AlertTriangle, AlertCircle, Info, Clock, MoreVertical, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dataset, AlertRule, AlertEvent } from '../types';
import { useAlertStore } from '../store/useAlertStore';
import { useTheme } from './ThemeProvider';
import { AlertRuleWizard } from './AlertRuleWizard';

interface AlertsViewProps {
  dataset: Dataset | null;
}

export const AlertsView: React.FC<AlertsViewProps> = ({ dataset }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { rules, events, addRule, updateRule, deleteRule, duplicateRule, snoozeRule, enableRule, disableRule } = useAlertStore();
  const [showWizard, setShowWizard] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [menuRuleId, setMenuRuleId] = useState<string | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  const datasetRules = rules.filter(r => !dataset || r.datasetId === dataset.id);
  const datasetEvents = events.filter(e => datasetRules.some(r => r.id === e.ruleId));

  const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const timeAgo = (ts: number) => {
    const d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
    return `${Math.floor(d / 86400000)}d ago`;
  };

  const severityConfig = {
    critical: { icon: <AlertTriangle className="w-3.5 h-3.5" />, bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20', label: 'Critical' },
    warning: { icon: <AlertCircle className="w-3.5 h-3.5" />, bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20', label: 'Warning' },
    info: { icon: <Info className="w-3.5 h-3.5" />, bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20', label: 'Info' },
  };

  const statusBadge = (rule: AlertRule) => {
    const s = rule.status;
    if (s === 'active') return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Active</span>;
    if (s === 'snoozed') return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Snoozed</span>;
    if (s === 'disabled') return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-500/10 text-gray-400 border border-gray-500/20">Disabled</span>;
    return null;
  };

  const handleSave = (rule: AlertRule) => {
    if (editingRule) updateRule(rule);
    else addRule(rule);
    setShowWizard(false);
    setEditingRule(null);
  };

  if (!dataset) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Shield className={`w-12 h-12 mx-auto mb-3 ${isDark ? 'text-gray-700' : 'text-gray-300'}`} />
          <h3 className={`text-lg font-bold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>No Dataset Loaded</h3>
          <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Upload or connect a dataset to set up monitoring rules.</p>
        </div>
      </div>
    );
  }

  if (showWizard) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <AlertRuleWizard
            dataset={dataset}
            editingRule={editingRule}
            onSave={handleSave}
            onCancel={() => { setShowWizard(false); setEditingRule(null); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Monitoring</h1>
              <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                {datasetRules.length} rule{datasetRules.length !== 1 ? 's' : ''} · {dataset.name}
              </p>
            </div>
          </div>
          <button onClick={() => { setEditingRule(null); setShowWizard(true); }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-lg shadow-violet-500/20 transition-all">
            <Plus className="w-4 h-4" /> New Rule
          </button>
        </motion.div>

        {/* Rules List */}
        {datasetRules.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className={`rounded-2xl border p-12 text-center ${isDark ? 'bg-[#1a1f2e] border-white/[0.06]' : 'bg-white border-gray-200'}`}>
            <Bell className={`w-10 h-10 mx-auto mb-3 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
            <h3 className={`text-base font-bold mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>No monitoring rules yet</h3>
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Create a rule to monitor metrics and get alerted when conditions are met.
            </p>
            <button onClick={() => { setEditingRule(null); setShowWizard(true); }}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-lg shadow-violet-500/20">
              <Plus className="w-4 h-4 inline mr-2" />Create First Rule
            </button>
          </motion.div>
        ) : (
          <div className="grid gap-3">
            {datasetRules.map((rule, i) => {
              const sev = severityConfig[rule.severity];
              const ruleEvents = events.filter(e => e.ruleId === rule.id);
              const lastEvent = ruleEvents[0];
              return (
                <motion.div key={rule.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
                  onClick={() => setSelectedRuleId(selectedRuleId === rule.id ? null : rule.id)}
                  className={`rounded-xl border p-4 cursor-pointer transition-all ${
                    selectedRuleId === rule.id
                      ? isDark ? 'bg-violet-500/5 border-violet-500/20' : 'bg-violet-50 border-violet-200'
                      : isDark ? 'bg-[#1a1f2e] border-white/[0.06] hover:border-white/[0.12]' : 'bg-white border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-xl ${sev.bg}`}>{sev.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{rule.name}</span>
                        {statusBadge(rule)}
                      </div>
                      <p className={`text-xs mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {titleCase(rule.aggregation)} of {titleCase(rule.metric)}
                        {rule.condition.type === 'threshold' && ` ${rule.condition.operator} ${rule.condition.value.toLocaleString()}`}
                        {rule.condition.type === 'trend' && ` ${rule.condition.direction} by ${rule.condition.changePercent}%+`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {rule.lastValue !== undefined && (
                        <span className={`text-xs font-mono font-bold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                          {rule.lastValue >= 1000 ? `${(rule.lastValue / 1000).toFixed(1)}K` : rule.lastValue.toLocaleString()}
                        </span>
                      )}
                      {rule.lastEvaluatedAt && (
                        <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                          <Clock className="w-3 h-3 inline mr-0.5" />{timeAgo(rule.lastEvaluatedAt)}
                        </span>
                      )}
                      <div className="relative">
                        <button onClick={e => { e.stopPropagation(); setMenuRuleId(menuRuleId === rule.id ? null : rule.id); }}
                          className={`p-1.5 rounded-lg transition-all ${isDark ? 'hover:bg-white/[0.06] text-gray-500' : 'hover:bg-gray-100 text-gray-400'}`}>
                          <MoreVertical className="w-4 h-4" />
                        </button>
                        {menuRuleId === rule.id && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setMenuRuleId(null)} />
                            <div className={`absolute right-0 top-full mt-1 z-50 w-44 rounded-xl shadow-2xl border overflow-hidden ${isDark ? 'bg-[#1e2333] border-white/10' : 'bg-white border-gray-200'}`}>
                              <button onClick={e => { e.stopPropagation(); setEditingRule(rule); setShowWizard(true); setMenuRuleId(null); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-gray-300 hover:bg-white/[0.05]' : 'text-gray-700 hover:bg-gray-50'}`}>
                                <Edit2 className="w-3.5 h-3.5" /> Edit
                              </button>
                              <button onClick={e => { e.stopPropagation(); duplicateRule(rule.id); setMenuRuleId(null); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-gray-300 hover:bg-white/[0.05]' : 'text-gray-700 hover:bg-gray-50'}`}>
                                <Copy className="w-3.5 h-3.5" /> Duplicate
                              </button>
                              {rule.status === 'active' ? (
                                <>
                                  <button onClick={e => { e.stopPropagation(); snoozeRule(rule.id, 1); setMenuRuleId(null); }}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-amber-400 hover:bg-amber-500/10' : 'text-amber-600 hover:bg-amber-50'}`}>
                                    <Pause className="w-3.5 h-3.5" /> Snooze 1h
                                  </button>
                                  <button onClick={e => { e.stopPropagation(); disableRule(rule.id); setMenuRuleId(null); }}
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.05]' : 'text-gray-500 hover:bg-gray-50'}`}>
                                    <X className="w-3.5 h-3.5" /> Disable
                                  </button>
                                </>
                              ) : (
                                <button onClick={e => { e.stopPropagation(); enableRule(rule.id); setMenuRuleId(null); }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-emerald-400 hover:bg-emerald-500/10' : 'text-emerald-600 hover:bg-emerald-50'}`}>
                                  <Play className="w-3.5 h-3.5" /> Enable
                                </button>
                              )}
                              <div className={`h-px ${isDark ? 'bg-white/[0.06]' : 'bg-gray-100'}`} />
                              <button onClick={e => { e.stopPropagation(); deleteRule(rule.id); setMenuRuleId(null); }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium ${isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-500 hover:bg-red-50'}`}>
                                <Trash2 className="w-3.5 h-3.5" /> Delete
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Expanded: recent events for this rule */}
                  <AnimatePresence>
                    {selectedRuleId === rule.id && ruleEvents.length > 0 && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden">
                        <div className={`mt-3 pt-3 border-t space-y-2 ${isDark ? 'border-white/[0.06]' : 'border-gray-100'}`}>
                          <span className={`text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>Recent Events</span>
                          {ruleEvents.slice(0, 5).map(evt => (
                            <div key={evt.id} className={`flex items-center gap-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${evt.severity === 'critical' ? 'bg-red-400' : evt.severity === 'warning' ? 'bg-amber-400' : 'bg-blue-400'}`} />
                              <span className="flex-1 truncate">{evt.message}</span>
                              <span className={`text-[10px] shrink-0 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>{timeAgo(evt.triggeredAt)}</span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Alert History Timeline */}
        {datasetEvents.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <div className="flex items-center gap-2.5 mb-4">
              <Clock className={`w-5 h-5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
              <h2 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Alert History</h2>
              <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>({datasetEvents.length})</span>
            </div>
            <div className={`rounded-2xl border overflow-hidden ${isDark ? 'bg-[#1a1f2e] border-white/[0.06]' : 'bg-white border-gray-200'}`}>
              <div className="max-h-[300px] overflow-y-auto divide-y" style={{ borderColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
                {datasetEvents.slice(0, 50).map(evt => {
                  const sev = severityConfig[evt.severity];
                  return (
                    <div key={evt.id} className={`flex items-center gap-3 px-4 py-3 ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-gray-50'} transition-colors`}>
                      <div className={`p-1.5 rounded-lg ${sev.bg}`}>{sev.icon}</div>
                      <div className="flex-1 min-w-0">
                        <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>{evt.ruleName}</span>
                        <p className={`text-[11px] truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{evt.message}</p>
                      </div>
                      <span className={`text-[10px] shrink-0 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>{timeAgo(evt.triggeredAt)}</span>
                      {evt.acknowledged && <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};
