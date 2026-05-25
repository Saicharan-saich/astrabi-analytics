import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, Plus, Check, X, Loader2, RefreshCw, Calculator, Trash2, AlertTriangle } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { DerivedColumnSuggestion, getAIDerivedSuggestions, computeDerivedColumn, materializeDerivedColumns } from '../services/aiDerivedSuggestions';
import { useTheme } from './ThemeProvider';

interface DerivedColumnsViewProps {
  dataset: Dataset | null;
  onDatasetUpdate: (dataset: Dataset) => void;
}

export const DerivedColumnsView: React.FC<DerivedColumnsViewProps> = ({ dataset, onDatasetUpdate }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [suggestions, setSuggestions] = useState<DerivedColumnSuggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [applied, setApplied] = useState<DerivedColumnSuggestion[]>([]);
  const [showCustom, setShowCustom] = useState(false);
  const [customLabel, setCustomLabel] = useState('');
  const [customColA, setCustomColA] = useState('');
  const [customColB, setCustomColB] = useState('');
  const [customFormula, setCustomFormula] = useState<'multiply' | 'subtract' | 'divide' | 'add'>('multiply');
  const [customMultiplier, setCustomMultiplier] = useState<string>('');

  const numericColumns = dataset?.columns.filter(c => c.type === ColumnType.MEASURE || c.type === ColumnType.METRIC || /number|numeric|decimal|float|int|double|currency/i.test(c.type)) || [];

  const fetchSuggestions = useCallback(async () => {
    if (!dataset) return;
    setIsLoadingAI(true);
    setAiError(null);
    try {
      const s = await getAIDerivedSuggestions(dataset);
      setSuggestions(s);
      const highConf = new Set(s.filter(x => x.confidence >= 85).map(x => x.id));
      setSelected(highConf);
    } catch (err: any) {
      setAiError(err.message || 'Failed to get AI suggestions');
    } finally {
      setIsLoadingAI(false);
    }
  }, [dataset]);

  useEffect(() => { if (dataset && suggestions.length === 0 && !isLoadingAI) fetchSuggestions(); }, [dataset]);

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const applySelected = () => {
    if (!dataset) return;
    const toApply = suggestions.filter(s => selected.has(s.id));
    const newRows = materializeDerivedColumns(dataset.data, toApply);
    const newCols = [...dataset.columns, ...toApply.map(s => ({
      name: s.id, type: ColumnType.MEASURE as any, originalName: s.id,
      semanticRole: 'derived_metric' as any, label: s.label,
    }))];
    onDatasetUpdate({ ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 });
    setApplied(prev => [...prev, ...toApply]);
    setSuggestions(prev => prev.filter(s => !selected.has(s.id)));
    setSelected(new Set());
  };

  const addCustomColumn = () => {
    if (!dataset || !customLabel.trim() || !customColA || !customColB) return;
    const id = customLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const custom: DerivedColumnSuggestion = {
      id, label: customLabel, description: 'Custom derived column',
      formula: customFormula, columnA: customColA, columnB: customColB,
      multiplier: customMultiplier ? Number(customMultiplier) : undefined,
      category: 'custom', confidence: 100, format: 'number',
      preview: `${customColA} ${customFormula === 'multiply' ? '×' : customFormula === 'subtract' ? '−' : customFormula === 'divide' ? '÷' : '+'} ${customColB}`,
    };
    const newRows = materializeDerivedColumns(dataset.data, [custom]);
    const newCols = [...dataset.columns, { name: id, type: ColumnType.MEASURE as any, originalName: id, semanticRole: 'derived_metric' as any, label: customLabel }];
    onDatasetUpdate({ ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 });
    setApplied(prev => [...prev, custom]);
    setCustomLabel(''); setCustomColA(''); setCustomColB(''); setCustomMultiplier(''); setShowCustom(false);
  };

  const removeApplied = (col: DerivedColumnSuggestion) => {
    if (!dataset) return;
    const newRows = dataset.data.map(r => { const n = { ...r }; delete n[col.id]; return n; });
    const newCols = dataset.columns.filter(c => c.name !== col.id);
    onDatasetUpdate({ ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 });
    setApplied(prev => prev.filter(a => a.id !== col.id));
  };

  if (!dataset) return <div className="flex items-center justify-center h-full text-slate-400"><p>Load a dataset first.</p></div>;

  const confColor = (c: number) => c >= 85 ? 'text-emerald-500' : c >= 60 ? 'text-yellow-500' : 'text-red-400';
  const confBg = (c: number) => c >= 85 ? 'bg-emerald-500/10 border-emerald-500/20' : c >= 60 ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-red-500/10 border-red-500/20';
  const catIcon: Record<string, string> = { financial: '💰', unit_economics: '📊', time_intelligence: '🕐', segmentation: '🏷️', custom: '🛠️' };

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'} overflow-hidden`}>
      {/* Header */}
      <div className={`px-6 py-4 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <h2 className="text-xl font-bold flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center"><Calculator className="w-4 h-4 text-white" /></div>
          Derived Columns
          <span className="text-xs font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/20">AI-Powered</span>
        </h2>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">AI suggests business metrics from your data. You can also create custom formulas.</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Applied Columns */}
        {applied.length > 0 && (
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-3 flex items-center gap-2"><Check className="w-4 h-4 text-emerald-500" /> Active Derived Columns ({applied.length})</h3>
            <div className="space-y-2">
              {applied.map(col => (
                <div key={col.id} className={`flex items-center justify-between px-4 py-3 rounded-xl border ${isDark ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-lg">{catIcon[col.category] || '✨'}</span>
                    <div><div className="font-bold text-sm">{col.label}</div><div className="text-xs text-gray-500 dark:text-slate-400 font-mono">{col.preview}</div></div>
                  </div>
                  <button onClick={() => removeApplied(col)} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Suggestions */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex items-center gap-2"><Sparkles className="w-4 h-4 text-amber-400" /> AI Suggestions</h3>
            <button onClick={fetchSuggestions} disabled={isLoadingAI} className="text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1 hover:underline disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${isLoadingAI ? 'animate-spin' : ''}`} /> {isLoadingAI ? 'Analyzing...' : 'Refresh'}
            </button>
          </div>

          {isLoadingAI && (
            <div className={`rounded-xl border p-8 text-center ${isDark ? 'border-white/[0.06] bg-slate-800/50' : 'border-gray-200 bg-white'}`}>
              <Loader2 className="w-8 h-8 animate-spin text-purple-500 mx-auto mb-3" />
              <p className="text-sm text-gray-500 dark:text-slate-400">AI is analyzing your dataset schema...</p>
            </div>
          )}

          {aiError && (
            <div className={`rounded-xl border p-4 flex items-start gap-3 ${isDark ? 'bg-red-500/10 border-red-500/20' : 'bg-red-50 border-red-200'}`}>
              <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
              <div className="text-sm text-red-700 dark:text-red-300">{aiError}</div>
            </div>
          )}

          {!isLoadingAI && suggestions.length > 0 && (
            <div className="space-y-2">
              {suggestions.map(s => (
                <label key={s.id} className={`flex items-center gap-4 px-4 py-3.5 rounded-xl border cursor-pointer transition-all ${selected.has(s.id) ? (isDark ? 'bg-purple-500/10 border-purple-500/30 ring-1 ring-purple-500/30' : 'bg-purple-50 border-purple-300 ring-1 ring-purple-400/30') : (isDark ? 'bg-slate-800/50 border-white/[0.06] hover:border-white/10' : 'bg-white border-gray-200 hover:border-gray-300')}`}>
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggleSelect(s.id)} className="rounded text-purple-600 focus:ring-purple-500 w-4 h-4" />
                  <span className="text-lg shrink-0">{catIcon[s.category] || '✨'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">{s.label}</div>
                    <div className="text-xs text-gray-500 dark:text-slate-400">{s.description}</div>
                    <div className="text-xs font-mono text-purple-600 dark:text-purple-400 mt-0.5">{s.preview}</div>
                  </div>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${confBg(s.confidence)} ${confColor(s.confidence)}`}>{s.confidence}%</span>
                </label>
              ))}
              <button onClick={applySelected} disabled={selected.size === 0} className="w-full mt-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold py-3 rounded-xl transition-all disabled:opacity-40 flex items-center justify-center gap-2 shadow-lg">
                <Check className="w-4 h-4" /> Apply {selected.size} Selected Column{selected.size !== 1 ? 's' : ''}
              </button>
            </div>
          )}

          {!isLoadingAI && suggestions.length === 0 && !aiError && applied.length === 0 && (
            <div className={`rounded-xl border p-8 text-center ${isDark ? 'border-white/[0.06] bg-slate-800/50' : 'border-gray-200 bg-white'}`}>
              <Sparkles className="w-8 h-8 text-gray-300 dark:text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-gray-400">No suggestions yet. Click "Refresh" to analyze your dataset.</p>
            </div>
          )}
        </div>

        {/* Custom Column Builder */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex items-center gap-2"><Plus className="w-4 h-4 text-cyan-500" /> Custom Column</h3>
            {!showCustom && <button onClick={() => setShowCustom(true)} className="text-xs text-cyan-600 dark:text-cyan-400 flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Create</button>}
          </div>

          {showCustom && (
            <div className={`rounded-xl border p-5 space-y-4 ${isDark ? 'bg-slate-800/50 border-white/[0.06]' : 'bg-white border-gray-200'}`}>
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Column Name</label>
                <input value={customLabel} onChange={e => setCustomLabel(e.target.value)} placeholder="e.g. Total Sales" className={`w-full mt-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Column A</label>
                  <select value={customColA} onChange={e => setCustomColA(e.target.value)} className={`w-full mt-1 px-2 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`}>
                    <option value="">Select...</option>
                    {dataset.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Operation</label>
                  <select value={customFormula} onChange={e => setCustomFormula(e.target.value as any)} className={`w-full mt-1 px-2 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`}>
                    <option value="multiply">× Multiply</option>
                    <option value="add">+ Add</option>
                    <option value="subtract">− Subtract</option>
                    <option value="divide">÷ Divide</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Column B</label>
                  <select value={customColB} onChange={e => setCustomColB(e.target.value)} className={`w-full mt-1 px-2 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`}>
                    <option value="">Select...</option>
                    {dataset.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Multiplier (optional, e.g. 100 for %)</label>
                <input value={customMultiplier} onChange={e => setCustomMultiplier(e.target.value)} placeholder="Leave empty for none" type="number" className={`w-full mt-1 px-3 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`} />
              </div>
              {customColA && customColB && (
                <div className={`text-xs font-mono px-3 py-2 rounded-lg ${isDark ? 'bg-slate-900 text-purple-300' : 'bg-gray-100 text-purple-700'}`}>
                  Preview: {customLabel || 'result'} = {customColA} {customFormula === 'multiply' ? '×' : customFormula === 'subtract' ? '−' : customFormula === 'divide' ? '÷' : '+'} {customColB}{customMultiplier ? ` × ${customMultiplier}` : ''}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={addCustomColumn} disabled={!customLabel.trim() || !customColA || !customColB} className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2.5 rounded-lg transition-all disabled:opacity-40 flex items-center justify-center gap-2 text-sm"><Plus className="w-4 h-4" /> Create Column</button>
                <button onClick={() => setShowCustom(false)} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 text-sm hover:bg-gray-50 dark:hover:bg-white/5"><X className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
