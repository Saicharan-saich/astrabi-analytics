import React, { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Check, X, Trash2, Pencil, Calculator, BookOpen, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { MetricTemplate, Industry, INDUSTRY_META, getTemplatesForDomain, searchTemplates, autoSuggestMappings, ALL_TEMPLATES } from '../services/metricTemplates';
import { ExpressionTerm, DerivedColumnSuggestion, computeDerivedColumn, materializeDerivedColumns, registerDerivedInSemanticModel } from '../services/aiDerivedSuggestions';
import { useTheme } from './ThemeProvider';

interface Props { dataset: Dataset | null; onDatasetUpdate: (ds: Dataset) => void; }

type SubTab = 'library' | 'custom';
type OpType = 'multiply' | 'subtract' | 'divide' | 'add';
const OP_SYM: Record<string, string> = { multiply: '×', subtract: '−', divide: '÷', add: '+' };

/** Robust number parser */
function parseNum(v: any): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/[$€£¥,\s%]/g, '').trim());
}

export const DerivedColumnsView: React.FC<Props> = ({ dataset, onDatasetUpdate }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // ── State ──
  const [subTab, setSubTab] = useState<SubTab>('library');
  const [search, setSearch] = useState('');
  const [activeIndustry, setActiveIndustry] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [mapping, setMapping] = useState<{ template: MetricTemplate; columns: Record<string, string> } | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Array<{ id: string; label: string; preview: string; category: string }>>([]);

  // Custom formula state
  const [customLabel, setCustomLabel] = useState('');
  const [customFormat, setCustomFormat] = useState<'number' | 'currency' | 'percent'>('number');
  const [terms, setTerms] = useState<ExpressionTerm[]>([{ column: '', operator: 'multiply' }, { column: '' }]);

  // Domain-aware industry detection
  const rawProfile = (dataset as any)?.domainProfile || (dataset as any)?.semanticModel?.domainProfile || '';
  const domainProfile = typeof rawProfile === 'string' ? rawProfile : String(rawProfile?.name || rawProfile?.label || '');
  const { primary, others } = useMemo(() => getTemplatesForDomain(domainProfile), [domainProfile]);
  const industries = useMemo(() => {
    const all = primary ? [primary, ...others] : others;
    return all;
  }, [primary, others]);

  // Auto-select detected industry on mount
  useEffect(() => {
    if (primary && !activeIndustry) setActiveIndustry(primary.industry);
    else if (!activeIndustry && industries.length > 0) setActiveIndustry(industries[0].industry);
  }, [primary?.industry]);

  // Detect existing derived columns
  useEffect(() => {
    if (!dataset) return;
    const existing = dataset.columns
      .filter(c => (c as any).semanticRole === 'derived_metric')
      .map(c => ({ id: c.name, label: (c as any).label || c.name, preview: '', category: 'custom' }));
    if (existing.length > 0 && applied.length === 0) setApplied(existing);
  }, [dataset?.columns.length]);

  const currentIndustry = industries.find(i => i.industry === activeIndustry) || industries[0];
  const currentTemplates = currentIndustry?.templates || [];
  const filtered = useMemo(() => search ? searchTemplates(search, currentTemplates) : currentTemplates, [search, currentTemplates]);
  const grouped = useMemo(() => {
    const g: Record<string, MetricTemplate[]> = {};
    filtered.forEach(t => (g[t.category] ||= []).push(t));
    return g;
  }, [filtered]);

  const numericCols = useMemo(() =>
    dataset?.columns.filter(c => c.type === ColumnType.METRIC) || [],
  [dataset?.columns]);

  // All columns grouped by type for dropdowns
  const colsByType = useMemo(() => {
    if (!dataset) return { metrics: [], dimensions: [], ids: [], dates: [], booleans: [] };
    return {
      metrics: dataset.columns.filter(c => c.type === ColumnType.METRIC),
      dimensions: dataset.columns.filter(c => c.type === ColumnType.DIMENSION),
      ids: dataset.columns.filter(c => c.type === ColumnType.ID),
      dates: dataset.columns.filter(c => c.type === ColumnType.DATE),
      booleans: dataset.columns.filter(c => c.type === ColumnType.BOOLEAN),
    };
  }, [dataset?.columns]);

  // ── Mapping Flow ──
  const startMapping = (t: MetricTemplate) => {
    const auto = autoSuggestMappings(t, dataset?.columns.map(c => ({ name: c.name, type: c.type, semanticRole: (c as any).semanticRole, label: (c as any).label })) || []);
    setMapping({ template: t, columns: auto });
    setMapError(null);
  };

  const updateMapping = (key: string, col: string) => {
    if (!mapping) return;
    setMapping({ ...mapping, columns: { ...mapping.columns, [key]: col } });
    setMapError(null);
  };

  const applyTemplate = () => {
    if (!mapping || !dataset) return;
    const { template, columns } = mapping;

    // Validate all inputs mapped
    for (const inp of template.requiredInputs) {
      if (!columns[inp.key]) { setMapError(`"${inp.label}" is not mapped`); return; }
      const col = dataset.columns.find(c => c.name === columns[inp.key]);
      if (!col) { setMapError(`Column "${columns[inp.key]}" not found`); return; }
    }

    // Compute values
    const newRows = dataset.rows.map(row => {
      const inputs: Record<string, number> = {};
      let valid = true;
      for (const inp of template.requiredInputs) {
        const v = parseNum(row[columns[inp.key]]);
        if (isNaN(v)) { valid = false; break; }
        inputs[inp.key] = v;
      }
      return { ...row, [template.id]: valid ? template.formulaFn(inputs) : null };
    });

    const newCols = [...dataset.columns, {
      name: template.id, type: ColumnType.METRIC, originalName: template.id,
      semanticRole: 'derived_metric' as any, label: template.name,
    }];

    const updatedModel = (dataset as any).semanticModel
      ? registerDerivedInSemanticModel((dataset as any).semanticModel, [{
          id: template.id, label: template.name, description: template.description,
          formula: 'multiply', columnA: '', columnB: '',
          category: template.category as any, confidence: 100, format: template.outputFormat,
        }])
      : undefined;

    const updated: any = { ...dataset, rows: newRows, columns: newCols, version: (dataset.version || 1) + 1 };
    if (updatedModel) updated.semanticModel = updatedModel;
    onDatasetUpdate(updated);
    setApplied(prev => [...prev, { id: template.id, label: template.name, preview: template.formulaPreview, category: template.category }]);
    setMapping(null);
  };

  // ── Custom Formula ──
  const updateTerm = (i: number, f: 'column' | 'operator', v: string) =>
    setTerms(prev => prev.map((t, idx) => idx === i ? { ...t, [f]: v || undefined } : t));

  const addTerm = () => setTerms(prev => {
    const u = [...prev];
    if (!u[u.length - 1].operator) u[u.length - 1] = { ...u[u.length - 1], operator: 'add' };
    return [...u, { column: '' }];
  });

  const removeTerm = (i: number) => {
    if (terms.length <= 2) return;
    setTerms(prev => { const u = prev.filter((_, idx) => idx !== i); u[u.length - 1] = { ...u[u.length - 1], operator: undefined }; return u; });
  };

  const buildPreview = () => terms.filter(t => t.column).map((t, i, a) =>
    i < a.length - 1 && t.operator ? `${t.column} ${OP_SYM[t.operator] || '?'}` : t.column
  ).join(' ');

  const addCustomColumn = () => {
    if (!dataset || !customLabel.trim()) return;
    const valid = terms.filter(t => t.column);
    if (valid.length < 2) return;
    const id = customLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const expr: ExpressionTerm[] = valid.map((t, i, a) => ({ column: t.column, operator: i < a.length - 1 ? (t.operator || 'multiply') as OpType : undefined }));
    const custom: DerivedColumnSuggestion = {
      id, label: customLabel, description: 'Custom', formula: expr[0].operator || 'multiply',
      columnA: expr[0].column, columnB: expr[1].column, expression: expr,
      category: 'custom', confidence: 100, format: customFormat, preview: buildPreview(),
    };
    const newRows = materializeDerivedColumns(dataset.rows || [], [custom]);
    const newCols = [...dataset.columns, { name: id, type: ColumnType.METRIC, originalName: id, semanticRole: 'derived_metric' as any, label: customLabel }];
    const updatedModel = (dataset as any).semanticModel ? registerDerivedInSemanticModel((dataset as any).semanticModel, [custom]) : undefined;
    const updated: any = { ...dataset, rows: newRows, columns: newCols, version: (dataset.version || 1) + 1 };
    if (updatedModel) updated.semanticModel = updatedModel;
    onDatasetUpdate(updated);
    setApplied(prev => [...prev, { id, label: customLabel, preview: buildPreview(), category: 'custom' }]);
    setCustomLabel(''); setTerms([{ column: '', operator: 'multiply' }, { column: '' }]);
  };

  // ── Remove ──
  const removeCol = (colId: string) => {
    if (!dataset) return;
    const newRows = dataset.rows.map(r => { const n = { ...r }; delete n[colId]; return n; });
    const newCols = dataset.columns.filter(c => c.name !== colId);
    onDatasetUpdate({ ...dataset, rows: newRows, columns: newCols, version: (dataset.version || 1) + 1 });
    setApplied(prev => prev.filter(a => a.id !== colId));
  };

  if (!dataset) return <div className="flex items-center justify-center h-full text-slate-400"><p>Load a dataset first.</p></div>;

  const inputCls = `w-full px-2.5 py-2 rounded-lg border text-sm ${isDark ? 'bg-slate-700 border-white/10 text-white' : 'bg-gray-50 border-gray-200'}`;
  const catLabel = (cat: string) => cat.charAt(0).toUpperCase() + cat.slice(1).replace(/_/g, ' ');

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'} overflow-hidden`}>
      {/* Header */}
      <div className={`px-6 py-4 border-b shrink-0 ${isDark ? 'border-white/[0.06] bg-[#0d1117]' : 'border-gray-200 bg-white'}`}>
        <h2 className="text-xl font-bold flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center"><BookOpen className="w-4 h-4 text-white" /></div>
          Metric Dictionary
        </h2>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Browse business metrics or build custom formulas.</p>
        {/* Sub-tabs */}
        <div className="flex gap-1 mt-3">
          {(['library', 'custom'] as SubTab[]).map(t => (
            <button key={t} onClick={() => setSubTab(t)}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${subTab === t
                ? 'bg-purple-600 text-white shadow-lg' : isDark ? 'text-slate-400 hover:text-white hover:bg-white/5' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'}`}>
              {t === 'library' ? '📖 Metric Library' : '🛠️ Custom Formula'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Active columns */}
        {applied.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {applied.map(a => (
              <div key={a.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border ${isDark ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
                <Check className="w-3 h-3" /> {a.label}
                <button onClick={() => removeCol(a.id)} className="ml-1 text-red-400 hover:text-red-600"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        )}

        {/* ── Library Tab ── */}
        {subTab === 'library' && (
          <>
            {/* Industry tabs */}
            <div className="flex gap-1.5 flex-wrap">
              {industries.map(ind => (
                <button key={ind.industry} onClick={() => { setActiveIndustry(ind.industry); setSearch(''); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                    activeIndustry === ind.industry
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg'
                      : isDark ? 'text-slate-400 hover:text-white hover:bg-white/5 border border-white/[0.06]' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100 border border-gray-200'
                  } ${ind.industry === primary?.industry ? 'ring-1 ring-purple-400/30' : ''}`}>
                  <span>{ind.icon}</span> {ind.label}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeIndustry === ind.industry ? 'bg-white/20' : isDark ? 'bg-white/5' : 'bg-gray-100'}`}>{ind.templates.length}</span>
                </button>
              ))}
            </div>

            {primary && activeIndustry === primary.industry && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${isDark ? 'bg-purple-500/10 border border-purple-500/20 text-purple-300' : 'bg-purple-50 border border-purple-200 text-purple-700'}`}>
                ✨ Recommended for your <strong>{domainProfile}</strong> dataset
              </div>
            )}

            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${currentIndustry?.label || ''} metrics...`}
                className={`${inputCls} pl-9`} />
            </div>

            {Object.entries(grouped).map(([cat, templates]) => (
              <div key={cat}>
                <button onClick={() => setExpanded(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; })}
                  className="flex items-center gap-2 w-full text-left py-2">
                  {expanded.has(cat) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">{catLabel(cat)}</span>
                  <span className="text-xs text-gray-400">({templates.length})</span>
                </button>
                {expanded.has(cat) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mt-1">
                    {templates.map(t => (
                      <div key={t.id} className={`rounded-xl border p-4 flex flex-col gap-2 transition-all hover:shadow-md ${isDark ? 'bg-slate-800/50 border-white/[0.06] hover:border-purple-500/30' : 'bg-white border-gray-200 hover:border-purple-300'} ${applied.some(a => a.id === t.id) ? 'opacity-50 pointer-events-none' : ''}`}>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{t.icon}</span>
                            <span className="font-bold text-sm">{t.name}</span>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${t.outputFormat === 'currency' ? 'bg-emerald-500/15 text-emerald-500' : t.outputFormat === 'percent' ? 'bg-blue-500/15 text-blue-500' : 'bg-gray-500/15 text-gray-500'}`}>{t.outputFormat}</span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed">{t.description}</p>
                        <div className={`text-xs font-mono px-2 py-1 rounded ${isDark ? 'bg-slate-900 text-purple-300' : 'bg-gray-100 text-purple-700'}`}>{t.formulaPreview}</div>
                        <div className="text-[10px] text-gray-400">Needs: {t.requiredInputs.map(i => i.label).join(', ')}</div>
                        <button onClick={() => startMapping(t)} className="mt-auto bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2 rounded-lg transition-all flex items-center justify-center gap-1.5">
                          <Plus className="w-3 h-3" /> Use Metric
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">No metrics match "{search}"</div>
            )}
          </>
        )}

        {/* ── Mapping Modal (inline) ── */}
        {mapping && (
          <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm`} onClick={() => setMapping(null)}>
            <div className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl ${isDark ? 'bg-slate-800 border-white/10' : 'bg-white border-gray-200'}`} onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-2xl">{mapping.template.icon}</span>
                <div>
                  <h3 className="font-bold text-lg">{mapping.template.name}</h3>
                  <p className="text-xs text-gray-500 dark:text-slate-400">{mapping.template.description}</p>
                </div>
              </div>
              <div className={`text-xs font-mono px-3 py-2 rounded-lg mb-4 ${isDark ? 'bg-slate-900 text-purple-300' : 'bg-gray-100 text-purple-700'}`}>
                <Calculator className="w-3 h-3 inline mr-1" /> {mapping.template.formulaPreview}
              </div>

              <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-2">Map Dataset Columns</h4>
              <div className="space-y-3">
                {mapping.template.requiredInputs.map(inp => (
                  <div key={inp.key} className="flex items-center gap-3">
                    <span className="text-xs font-bold w-28 shrink-0 text-right text-gray-600 dark:text-slate-300">{inp.label}</span>
                    <span className="text-gray-400">→</span>
                    <select value={mapping.columns[inp.key] || ''} onChange={e => updateMapping(inp.key, e.target.value)} className={`flex-1 ${inputCls}`}>
                      <option value="" style={{ color: '#0f172a', backgroundColor: '#fff' }}>Select column...</option>
                      {colsByType.metrics.length > 0 && <optgroup label="📊 Measures" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.metrics.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                      {colsByType.dimensions.length > 0 && <optgroup label="📁 Dimensions" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.dimensions.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                      {colsByType.ids.length > 0 && <optgroup label="🔑 IDs" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.ids.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                      {colsByType.dates.length > 0 && <optgroup label="📅 Dates" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.dates.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                    </select>
                  </div>
                ))}
              </div>

              {/* Sample preview */}
              {Object.values(mapping.columns).every(Boolean) && dataset && dataset.rows.length > 0 && (
                <div className={`mt-4 text-xs rounded-lg overflow-hidden border ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                  <div className={`px-3 py-1.5 font-bold uppercase tracking-wider ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-gray-100 text-gray-500'}`}>Preview (3 rows)</div>
                  {dataset.rows.slice(0, 3).map((row, i) => {
                    const inputs: Record<string, number> = {};
                    let ok = true;
                    for (const inp of mapping.template.requiredInputs) {
                      const v = parseNum(row[mapping.columns[inp.key]]);
                      if (isNaN(v)) { ok = false; break; }
                      inputs[inp.key] = v;
                    }
                    const val = ok ? mapping.template.formulaFn(inputs) : null;
                    return (
                      <div key={i} className={`px-3 py-1.5 flex justify-between ${isDark ? 'text-slate-300' : 'text-gray-700'}`}>
                        <span className="text-gray-500">{mapping.template.requiredInputs.map(inp => row[mapping.columns[inp.key]]).join(', ')}</span>
                        <span className="font-bold text-emerald-500">{val !== null ? (mapping.template.outputFormat === 'currency' ? `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : mapping.template.outputFormat === 'percent' ? `${val.toFixed(1)}%` : val.toLocaleString(undefined, { maximumFractionDigits: 2 })) : 'null'}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {mapError && (
                <div className={`mt-3 flex items-center gap-2 text-xs text-red-500 ${isDark ? 'bg-red-500/10' : 'bg-red-50'} px-3 py-2 rounded-lg`}>
                  <AlertTriangle className="w-3.5 h-3.5" /> {mapError}
                </div>
              )}

              <div className="flex gap-2 mt-4">
                <button onClick={applyTemplate} className="flex-1 bg-purple-600 hover:bg-purple-500 text-white font-bold py-2.5 rounded-lg text-sm flex items-center justify-center gap-2"><Check className="w-4 h-4" /> Create Metric</button>
                <button onClick={() => setMapping(null)} className={`px-4 py-2.5 rounded-lg border text-sm ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-gray-200 hover:bg-gray-50'}`}><X className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        )}

        {/* ── Custom Formula Tab ── */}
        {subTab === 'custom' && (
          <div className={`rounded-xl border p-5 space-y-4 ${isDark ? 'bg-slate-800/50 border-white/[0.06]' : 'bg-white border-gray-200'}`}>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Column Name</label>
                <input value={customLabel} onChange={e => setCustomLabel(e.target.value)} placeholder="e.g. Total Sales" className={`mt-1 ${inputCls}`} />
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase">Format</label>
                <select value={customFormat} onChange={e => setCustomFormat(e.target.value as any)} className={`mt-1 ${inputCls}`}>
                  <option value="number">Number</option><option value="currency">Currency</option><option value="percent">Percent</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase mb-2 block">Formula</label>
              {terms.map((term, idx) => (
                <div key={idx} className="flex items-center gap-2 mb-2">
                  <select value={term.column} onChange={e => updateTerm(idx, 'column', e.target.value)} className={`flex-1 ${inputCls}`}>
                    <option value="" style={{ color: '#0f172a', backgroundColor: '#fff' }}>Select column...</option>
                    {colsByType.metrics.length > 0 && <optgroup label="📊 Measures" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.metrics.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                    {colsByType.dimensions.length > 0 && <optgroup label="📁 Dimensions" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.dimensions.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                    {colsByType.ids.length > 0 && <optgroup label="🔑 IDs" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.ids.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                    {colsByType.dates.length > 0 && <optgroup label="📅 Dates" style={{ color: '#0f172a', backgroundColor: '#fff' }}>{colsByType.dates.map(c => <option key={c.name} value={c.name} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{(c as any).label || c.name}</option>)}</optgroup>}
                  </select>
                  {idx < terms.length - 1 && (
                    <select value={term.operator || 'multiply'} onChange={e => updateTerm(idx, 'operator', e.target.value)} className={`w-20 shrink-0 text-center font-bold ${inputCls}`}>
                      <option value="multiply">×</option><option value="add">+</option><option value="subtract">−</option><option value="divide">÷</option>
                    </select>
                  )}
                  {terms.length > 2 && <button onClick={() => removeTerm(idx)} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>}
                </div>
              ))}
              <button onClick={addTerm} className="text-xs text-cyan-500 flex items-center gap-1 hover:underline"><Plus className="w-3 h-3" /> Add column</button>
            </div>
            {terms.some(t => t.column) && (
              <div className={`text-xs font-mono px-3 py-2 rounded-lg ${isDark ? 'bg-slate-900 text-purple-300' : 'bg-gray-100 text-purple-700'}`}>
                {customLabel || 'result'} = {buildPreview()}
              </div>
            )}
            <button onClick={addCustomColumn} disabled={!customLabel.trim() || terms.filter(t => t.column).length < 2}
              className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-2.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-2 text-sm">
              <Plus className="w-4 h-4" /> Create Column
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
