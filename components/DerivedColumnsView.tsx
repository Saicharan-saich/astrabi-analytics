import React, { useState, useEffect, useCallback } from 'react';
import { Sparkles, Plus, Check, X, Loader2, RefreshCw, Calculator, Trash2, AlertTriangle, Pencil } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { DerivedColumnSuggestion, ExpressionTerm, getAIDerivedSuggestions, computeDerivedColumn, materializeDerivedColumns, validateDerivedColumn, registerDerivedInSemanticModel } from '../services/aiDerivedSuggestions';
import { useTheme } from './ThemeProvider';

interface DerivedColumnsViewProps {
  dataset: Dataset | null;
  onDatasetUpdate: (dataset: Dataset) => void;
}

const OP_SYMBOLS: Record<string, string> = { multiply: '×', subtract: '−', divide: '÷', add: '+' };
type OpType = 'multiply' | 'subtract' | 'divide' | 'add';

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
  const [customFormat, setCustomFormat] = useState<'number' | 'currency' | 'percent'>('number');
  const [editingId, setEditingId] = useState<string | null>(null);
  // Multi-term expression — ALWAYS init with operator on first term
  const [terms, setTerms] = useState<ExpressionTerm[]>([
    { column: '', operator: 'multiply' },
    { column: '' }
  ]);

  const fetchSuggestions = useCallback(async () => {
    if (!dataset || !dataset.data || dataset.data.length === 0) return;
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

  useEffect(() => {
    if (dataset && dataset.data && dataset.data.length > 0 && suggestions.length === 0 && !isLoadingAI) {
      fetchSuggestions();
    }
  }, [dataset]);

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const applySelected = () => {
    if (!dataset) return;
    const toApply = suggestions.filter(s => selected.has(s.id));
    const newRows = materializeDerivedColumns(dataset.data || [], toApply);
    const newCols = [...dataset.columns, ...toApply.map(s => ({
      name: s.id, type: ColumnType.MEASURE as any, originalName: s.id,
      semanticRole: 'derived_metric' as any, label: s.label,
    }))];
    const updatedModel = (dataset as any).semanticModel
      ? registerDerivedInSemanticModel((dataset as any).semanticModel, toApply)
      : undefined;
    const updated = { ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 };
    if (updatedModel) (updated as any).semanticModel = updatedModel;
    onDatasetUpdate(updated);
    setApplied(prev => [...prev, ...toApply]);
    setSuggestions(prev => prev.filter(s => !selected.has(s.id)));
    setSelected(new Set());
  };

  // ── Multi-term expression helpers ──
  const updateTerm = (idx: number, field: 'column' | 'operator', value: string) => {
    setTerms(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value || undefined } : t));
  };

  const addTerm = () => {
    setTerms(prev => {
      const updated = [...prev];
      // Ensure the current last term gets an operator
      if (!updated[updated.length - 1].operator) {
        updated[updated.length - 1] = { ...updated[updated.length - 1], operator: 'add' };
      }
      return [...updated, { column: '' }];
    });
  };

  const removeTerm = (idx: number) => {
    if (terms.length <= 2) return;
    setTerms(prev => {
      const updated = prev.filter((_, i) => i !== idx);
      // Remove operator from new last term
      updated[updated.length - 1] = { ...updated[updated.length - 1], operator: undefined };
      return updated;
    });
  };

  const buildPreview = (): string => {
    return terms
      .filter(t => t.column)
      .map((t, i, arr) => {
        const name = t.column;
        return i < arr.length - 1 && t.operator
          ? `${name} ${OP_SYMBOLS[t.operator] || '?'}`
          : name;
      })
      .join(' ');
  };

  const resetCustomForm = () => {
    setCustomLabel('');
    setCustomFormat('number');
    setTerms([{ column: '', operator: 'multiply' }, { column: '' }]);
    setEditingId(null);
    setAiError(null);
  };

  const startEdit = (col: DerivedColumnSuggestion) => {
    setShowCustom(true);
    setEditingId(col.id);
    setCustomLabel(col.label);
    setCustomFormat((col.format as any) || 'number');
    if (col.expression && col.expression.length >= 2) {
      setTerms(col.expression.map((t, i, arr) => ({
        column: t.column,
        operator: i < arr.length - 1 ? (t.operator || 'multiply') : undefined,
      })));
    } else {
      setTerms([
        { column: col.columnA, operator: col.formula },
        { column: col.columnB }
      ]);
    }
  };

  const addCustomColumn = () => {
    if (!dataset || !customLabel.trim()) return;
    const validTerms = terms.filter(t => t.column);
    if (validTerms.length < 2) { setAiError('Need at least 2 columns'); return; }

    const id = editingId || customLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    // Build expression with operators properly set
    const expression: ExpressionTerm[] = validTerms.map((t, i) => ({
      column: t.column,
      operator: i < validTerms.length - 1 ? (t.operator || 'multiply') as OpType : undefined,
    }));

    const custom: DerivedColumnSuggestion = {
      id, label: customLabel, description: 'Custom derived column',
      formula: expression[0].operator || 'multiply',
      columnA: expression[0].column,
      columnB: expression[1].column,
      expression,
      category: 'custom', confidence: 100, format: customFormat,
      preview: buildPreview(),
    };

    // Validate each column semantically
    for (const term of expression) {
      const col = dataset.columns.find(c => c.name === term.column);
      if (!col) { setAiError(`Column "${term.column}" not found`); return; }
      const idRoles = ['identifier', 'id', 'primary_key', 'foreign_key'];
      if (idRoles.includes(String((col as any).semanticRole || '').toLowerCase())) {
        setAiError(`"${col.name}" is an identifier — cannot use in math`);
        return;
      }
    }
    setAiError(null);

    // If editing, remove old column first
    let baseData = dataset.data || [];
    let baseCols = dataset.columns;
    if (editingId) {
      baseData = baseData.map(r => { const n = { ...r }; delete n[editingId]; return n; });
      baseCols = baseCols.filter(c => c.name !== editingId);
    }

    const newRows = materializeDerivedColumns(baseData, [custom]);
    const newCols = [...baseCols, { name: id, type: ColumnType.MEASURE as any, originalName: id, semanticRole: 'derived_metric' as any, label: customLabel }];
    const updatedModel = (dataset as any).semanticModel
      ? registerDerivedInSemanticModel((dataset as any).semanticModel, [custom])
      : undefined;
    const updated = { ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 };
    if (updatedModel) (updated as any).semanticModel = updatedModel;
    onDatasetUpdate(updated);

    if (editingId) {
      setApplied(prev => prev.map(a => a.id === editingId ? custom : a));
    } else {
      setApplied(prev => [...prev, custom]);
    }
    resetCustomForm();
    setShowCustom(false);
  };

  const removeApplied = (col: DerivedColumnSuggestion) => {
    if (!dataset) return;
    const newRows = (dataset.data || []).map(r => { const n = { ...r }; delete n[col.id]; return n; });
    const newCols = dataset.columns.filter(c => c.name !== col.id);
    onDatasetUpdate({ ...dataset, data: newRows, columns: newCols, version: (dataset.version || 1) + 1 });
    setApplied(prev => prev.filter(a => a.id !== col.id));
  };

  if (!dataset) return <div className="flex items-center justify-center h-full text-slate-400"><p>Load a dataset first.</p></div>;

  const confColor = (c: number) => c >= 85 ? 'text-emerald-500' : c >= 60 ? 'text-yellow-500' : 'text-red-400';
  const confBg = (c: number) => c >= 85 ? 'bg-emerald-500/10 border-emerald-500/20' : c >= 60 ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-red-500/10 border-red-500/20';
  const catIcon: Record<string, string> = { financial: '💰', unit_economics: '📊', time_intelligence: '🕐', segmentation: '🏷️', custom: '🛠️' };
  const inputCls = `w-full px-2.5 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`;

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'} overflow-hidden`}>
      {/* Header */}
      <div className={`px-6 py-4 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <h2 className="text-xl font-bold flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center"><Calculator className="w-4 h-4 text-white" /></div>
          Derived Columns
          <span className="text-xs font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/20">AI-Powered</span>
        </h2>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">AI suggests business metrics from your data. Create custom multi-column formulas too.</p>
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
                    <div>
                      <div className="font-bold text-sm">{col.label}</div>
                      <div className="text-xs text-gray-500 dark:text-slate-400 font-mono">{col.preview}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => startEdit(col)} className="text-blue-400 hover:text-blue-500 p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-500/10" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => removeApplied(col)} className="text-red-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error display */}
        {aiError && (
          <div className={`rounded-xl border p-4 flex items-start gap-3 ${isDark ? 'bg-red-500/10 border-red-500/20' : 'bg-red-50 border-red-200'}`}>
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div className="text-sm text-red-700 dark:text-red-300">{aiError}</div>
            <button onClick={() => setAiError(null)} className="ml-auto text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
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

        {/* Custom Column Builder — Multi-Term Expression */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex items-center gap-2"><Plus className="w-4 h-4 text-cyan-500" /> {editingId ? 'Edit Column' : 'Custom Column'}</h3>
            {!showCustom && <button onClick={() => { resetCustomForm(); setShowCustom(true); }} className="text-xs text-cyan-600 dark:text-cyan-400 flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Create</button>}
          </div>

          {showCustom && (
            <div className={`rounded-xl border p-5 space-y-4 ${isDark ? 'bg-slate-800/50 border-white/[0.06]' : 'bg-white border-gray-200'}`}>
              {/* Name + Format */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Column Name</label>
                  <input value={customLabel} onChange={e => setCustomLabel(e.target.value)} placeholder="e.g. Total Sales" className={`mt-1 ${inputCls}`} />
                </div>
                <div>
                  <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Format</label>
                  <select value={customFormat} onChange={e => setCustomFormat(e.target.value as any)} className={`mt-1 ${inputCls}`}>
                    <option value="number">Number</option>
                    <option value="currency">Currency</option>
                    <option value="percent">Percent</option>
                  </select>
                </div>
              </div>

              {/* Expression Terms */}
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase mb-2 block">Formula Expression</label>
                <div className="space-y-2">
                  {terms.map((term, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={term.column}
                        onChange={e => updateTerm(idx, 'column', e.target.value)}
                        className={`flex-1 ${inputCls}`}
                      >
                        <option value="">Select column...</option>
                        {dataset.columns.map(c => <option key={c.name} value={c.name}>{c.label || c.name}</option>)}
                      </select>

                      {idx < terms.length - 1 && (
                        <select
                          value={term.operator || 'multiply'}
                          onChange={e => updateTerm(idx, 'operator', e.target.value)}
                          className={`w-24 shrink-0 text-center font-bold ${inputCls}`}
                        >
                          <option value="multiply">×</option>
                          <option value="add">+</option>
                          <option value="subtract">−</option>
                          <option value="divide">÷</option>
                        </select>
                      )}

                      {terms.length > 2 && (
                        <button onClick={() => removeTerm(idx)} className="text-red-400 hover:text-red-600 p-1 shrink-0"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>
                <button onClick={addTerm} className="mt-2 text-xs text-cyan-600 dark:text-cyan-400 flex items-center gap-1 hover:underline">
                  <Plus className="w-3 h-3" /> Add another column
                </button>
              </div>

              {/* Live Preview */}
              {terms.some(t => t.column) && (
                <div className={`text-xs font-mono px-3 py-2.5 rounded-lg flex items-center gap-2 ${isDark ? 'bg-slate-900 text-purple-300' : 'bg-gray-100 text-purple-700'}`}>
                  <Calculator className="w-3.5 h-3.5 shrink-0" />
                  <span>{customLabel || 'result'} = {buildPreview()}</span>
                </div>
              )}

              {/* Sample output */}
              {terms.filter(t => t.column).length >= 2 && dataset.data && dataset.data.length > 0 && (
                <div className={`text-xs rounded-lg overflow-hidden border ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                  <div className={`px-3 py-1.5 font-bold uppercase tracking-wider ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-gray-100 text-gray-500'}`}>Sample Output (first 3 rows)</div>
                  <div className={`divide-y ${isDark ? 'divide-white/[0.04]' : 'divide-gray-100'}`}>
                    {dataset.data.slice(0, 3).map((row, i) => {
                      const filledTerms = terms.filter(t => t.column);
                      const expr: ExpressionTerm[] = filledTerms.map((t, idx, arr) => ({
                        column: t.column,
                        operator: idx < arr.length - 1 ? (t.operator || 'multiply') as OpType : undefined,
                      }));
                      const mockSuggestion: DerivedColumnSuggestion = {
                        id: '_preview', label: '', description: '', formula: expr[0]?.operator || 'multiply',
                        columnA: filledTerms[0]?.column || '', columnB: filledTerms[1]?.column || '',
                        expression: expr,
                        category: 'custom', confidence: 100, format: 'number',
                      };
                      const val = computeDerivedColumn(row, mockSuggestion);
                      return (
                        <div key={i} className={`px-3 py-1.5 flex justify-between ${isDark ? 'text-slate-300' : 'text-gray-700'}`}>
                          <span className="text-gray-500">{filledTerms.map(t => row[t.column]).join(', ')}</span>
                          <span className="font-bold text-emerald-500">
                            {val !== null ? (
                              customFormat === 'currency' ? `$${val.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` :
                              customFormat === 'percent' ? `${val.toFixed(1)}%` :
                              val.toLocaleString(undefined, {maximumFractionDigits: 2})
                            ) : 'null'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button onClick={addCustomColumn} disabled={!customLabel.trim() || terms.filter(t => t.column).length < 2} className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2.5 rounded-lg transition-all disabled:opacity-40 flex items-center justify-center gap-2 text-sm">
                  {editingId ? <><Pencil className="w-4 h-4" /> Update Column</> : <><Plus className="w-4 h-4" /> Create Column</>}
                </button>
                <button onClick={() => { setShowCustom(false); resetCustomForm(); }} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 text-sm hover:bg-gray-50 dark:hover:bg-white/5"><X className="w-4 h-4" /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
