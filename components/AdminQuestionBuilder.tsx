import React, { useState, useEffect } from 'react';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { UserRole, QuestionTemplate, EvalType, QuestionGrain } from '../types';
import { loadCustomQuestions, saveCustomQuestion, deleteCustomQuestion, exportCustomQuestions, importCustomQuestions } from '../services/questionRegistry';
import { Plus, Trash2, Download, Upload, Save, X, Code, Database, BarChart2, AlertCircle, Check, Edit2, Copy } from 'lucide-react';
import { useTheme } from './ThemeProvider';

const EVAL_TYPES: { value: EvalType; label: string; desc: string }[] = [
    { value: 'ranking', label: 'Ranking (Top/Bottom N)', desc: 'Groups by dimension, sorts by metric' },
    { value: 'comparison', label: 'Comparison (vs Period)', desc: 'Compares current vs previous period' },
    { value: 'trend', label: 'Trend (Time Series)', desc: 'Shows data over time' },
    { value: 'kpi', label: 'KPI (Single Value)', desc: 'Aggregates to a single number' },
    { value: 'percentOfTotal', label: '% of Total', desc: 'Shows share breakdown' },
    { value: 'movingAvg', label: 'Moving Average', desc: 'Smoothed time series' },
    { value: 'runningTotal', label: 'Running Total', desc: 'Cumulative sum over time' },
];

const VIS_TYPES = [
    'kpiCard', 'bar', 'horizontalBar', 'groupedBar', 'line', 'curvedLine',
    'area', 'pie', 'doughnut', 'treemap', 'table', 'gauge'
];

const GRAINS: QuestionGrain[] = ['day', 'week', 'month', 'quarter', 'year', 'item', 'customer', 'any'];

const COMMON_COLUMNS = [
    'revenue', 'order_id', 'order_date', 'product_name', 'customer_id',
    'customer_name', 'quantity', 'source', 'campaign'
];

interface AdminQuestionBuilderProps {
    dataset?: any;
}

export const AdminQuestionBuilder: React.FC<AdminQuestionBuilderProps> = ({ dataset }) => {
    const { currentUser } = useAuthStore();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const isAdmin = currentUser?.role === UserRole.ADMIN;

    // Form state
    const [id, setId] = useState('');
    const [question, setQuestion] = useState('');
    const [category, setCategory] = useState('');
    const [customCategory, setCustomCategory] = useState('');
    const [reqColumns, setReqColumns] = useState<string[]>(['revenue', 'order_date']);
    const [grain, setGrain] = useState<QuestionGrain>('month');
    const [vis, setVis] = useState<string>('bar');
    const [evalType, setEvalType] = useState<EvalType>('kpi');
    const [sql, setSql] = useState('SELECT SUM(revenue) FROM orders\nWHERE order_date >= DATE_TRUNC(\'month\', CURRENT_DATE)');

    // List state
    const [customQuestions, setCustomQuestions] = useState<QuestionTemplate[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [showImport, setShowImport] = useState(false);
    const [importJson, setImportJson] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Existing categories (for dropdown)
    const existingCategories = [...new Set(customQuestions.map(q => q.category))];

    useEffect(() => {
        setCustomQuestions(loadCustomQuestions());
    }, []);

    const showMessage = (type: 'success' | 'error', text: string) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), 3000);
    };

    const resetForm = () => {
        setId('');
        setQuestion('');
        setCategory('');
        setCustomCategory('');
        setReqColumns(['revenue', 'order_date']);
        setGrain('month');
        setVis('bar');
        setEvalType('kpi');
        setSql('SELECT SUM(revenue) FROM orders\nWHERE order_date >= DATE_TRUNC(\'month\', CURRENT_DATE)');
        setEditingId(null);
    };

    const handleSave = () => {
        const finalCategory = customCategory.trim() || category;
        if (!id.trim() || !question.trim() || !finalCategory) {
            showMessage('error', 'ID, Question, and Category are required');
            return;
        }

        const q: QuestionTemplate = {
            id: id.trim(),
            question: question.trim(),
            category: finalCategory,
            req: reqColumns,
            grain,
            vis: vis as any,
            sql: sql.trim(),
            evalType,
            isCustom: true,
        };

        saveCustomQuestion(q);
        setCustomQuestions(loadCustomQuestions());
        showMessage('success', editingId ? 'Question updated!' : 'Question created!');
        resetForm();
    };

    const handleEdit = (q: QuestionTemplate) => {
        setId(q.id);
        setQuestion(q.question);
        setCategory(q.category);
        setCustomCategory('');
        setReqColumns(q.req);
        setGrain(q.grain);
        setVis(q.vis);
        setEvalType(q.evalType || 'kpi');
        setSql(q.sql);
        setEditingId(q.id);
    };

    const handleDelete = (qId: string) => {
        deleteCustomQuestion(qId);
        setCustomQuestions(loadCustomQuestions());
        showMessage('success', 'Question deleted');
        if (editingId === qId) resetForm();
    };

    const handleExport = () => {
        const json = exportCustomQuestions();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'QuickInsight-custom-questions.json';
        a.click();
        URL.revokeObjectURL(url);
        showMessage('success', `Exported ${customQuestions.length} questions`);
    };

    const handleImport = () => {
        const result = importCustomQuestions(importJson);
        if (result.success) {
            setCustomQuestions(loadCustomQuestions());
            setShowImport(false);
            setImportJson('');
            showMessage('success', `Imported ${result.count} questions`);
        } else {
            showMessage('error', result.error || 'Import failed');
        }
    };

    const toggleColumn = (col: string) => {
        setReqColumns(prev =>
            prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
        );
    };

    const autoGenerateId = () => {
        if (!question) return;
        const prefix = grain === 'day' ? 'cq_d_' : grain === 'week' ? 'cq_w_' : grain === 'month' ? 'cq_m_' : 'cq_';
        const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
        setId(prefix + slug);
    };

    if (!isAdmin) {
        return (
            <div className={`h-full flex items-center justify-center ${isDark ? 'bg-[#0c0f1a]' : 'bg-gray-50'}`}>
                <div className="text-center space-y-3">
                    <AlertCircle className="w-12 h-12 text-red-400 mx-auto" />
                    <h2 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>Admin Access Required</h2>
                    <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        Only administrators can create custom questions.
                    </p>
                </div>
            </div>
        );
    }

    const inputClass = `w-full px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-colors ${isDark
            ? 'bg-slate-800 border border-white/10 text-white placeholder:text-slate-500'
            : 'bg-white border border-slate-200 text-slate-800 placeholder:text-slate-400'
        }`;

    const labelClass = `block text-xs font-bold uppercase tracking-wider mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`;

    return (
        <div className={`h-full overflow-y-auto ${isDark ? 'bg-[#0c0f1a]' : 'bg-gray-50'}`}>
            <div className="max-w-6xl mx-auto p-6 space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                            Custom Question Builder
                        </h1>
                        <p className={`text-sm mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                            Create custom analytical questions with SQL queries. Admin only.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={handleExport} disabled={customQuestions.length === 0}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
                            <Download className="w-4 h-4" /> Export
                        </button>
                        <button onClick={() => setShowImport(!showImport)}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all bg-violet-600 text-white hover:bg-violet-500">
                            <Upload className="w-4 h-4" /> Import
                        </button>
                    </div>
                </div>

                {/* Message Banner */}
                {message && (
                    <div className={`p-3 rounded-xl text-sm flex items-center gap-2 ${message.type === 'success'
                            ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                            : 'bg-red-500/10 border border-red-500/20 text-red-400'
                        }`}>
                        {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                        {message.text}
                    </div>
                )}

                {/* Import Panel */}
                {showImport && (
                    <div className={`p-4 rounded-xl border ${isDark ? 'bg-slate-800/50 border-white/10' : 'bg-white border-slate-200'}`}>
                        <h3 className={`font-bold text-sm mb-2 ${isDark ? 'text-white' : 'text-slate-800'}`}>Import Questions (JSON)</h3>
                        <textarea
                            value={importJson}
                            onChange={e => setImportJson(e.target.value)}
                            placeholder='Paste exported JSON here...'
                            rows={5}
                            className={`${inputClass} font-mono text-xs`}
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => { setShowImport(false); setImportJson(''); }}
                                className={`px-3 py-1.5 text-sm ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800'}`}>
                                Cancel
                            </button>
                            <button onClick={handleImport}
                                className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-500">
                                Import
                            </button>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* ─── FORM ─── */}
                    <div className={`p-6 rounded-2xl border space-y-4 ${isDark ? 'bg-slate-900/50 border-white/10' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <h2 className={`text-lg font-bold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                            <Plus className="w-5 h-5 text-indigo-400" />
                            {editingId ? 'Edit Question' : 'New Question'}
                        </h2>

                        {/* Question Text */}
                        <div>
                            <label className={labelClass}>Question Text</label>
                            <input
                                type="text" value={question} onChange={e => setQuestion(e.target.value)}
                                placeholder="e.g. What's our best performing product this quarter?"
                                className={inputClass}
                                onBlur={() => { if (!id) autoGenerateId(); }}
                            />
                        </div>

                        {/* ID */}
                        <div>
                            <label className={labelClass}>Question ID</label>
                            <div className="flex gap-2">
                                <input type="text" value={id} onChange={e => setId(e.target.value)}
                                    placeholder="cq_custom_question_id" className={inputClass} />
                                <button onClick={autoGenerateId} title="Auto-generate ID"
                                    className="px-3 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors">
                                    <Code className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {/* Category */}
                        <div>
                            <label className={labelClass}>Category</label>
                            <select value={category} onChange={e => setCategory(e.target.value)} className={inputClass}>
                                <option value="">— Select or type new below —</option>
                                {['Revenue Diagnostics', 'Growth & Momentum', 'Products & Inventory', 'Channels & Marketing',
                                    'Customer Intelligence', 'Profit & Margins', 'Time & Comparisons',
                                    ...existingCategories.filter(c => !['Revenue Diagnostics', 'Growth & Momentum', 'Products & Inventory', 'Channels & Marketing', 'Customer Intelligence', 'Profit & Margins', 'Time & Comparisons'].includes(c))
                                ].map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input type="text" value={customCategory} onChange={e => setCustomCategory(e.target.value)}
                                placeholder="Or type a new category name" className={`${inputClass} mt-2`} />
                        </div>

                        {/* Required Columns */}
                        <div>
                            <label className={labelClass}>Required Columns</label>
                            <div className="flex flex-wrap gap-1.5">
                                {COMMON_COLUMNS.map(col => (
                                    <button key={col} onClick={() => toggleColumn(col)}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ring-1 ${reqColumns.includes(col)
                                                ? 'bg-indigo-600 text-white ring-indigo-500'
                                                : isDark
                                                    ? 'text-slate-400 ring-white/10 hover:ring-indigo-500/50'
                                                    : 'text-slate-500 ring-slate-200 hover:ring-indigo-300'
                                            }`}>
                                        {col}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Grid: Grain + Vis + EvalType */}
                        <div className="grid grid-cols-3 gap-3">
                            <div>
                                <label className={labelClass}>Grain</label>
                                <select value={grain} onChange={e => setGrain(e.target.value as QuestionGrain)} className={inputClass}>
                                    {GRAINS.map(g => <option key={g} value={g}>{g}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Visualization</label>
                                <select value={vis} onChange={e => setVis(e.target.value)} className={inputClass}>
                                    {VIS_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Eval Type</label>
                                <select value={evalType} onChange={e => setEvalType(e.target.value as EvalType)} className={inputClass}>
                                    {EVAL_TYPES.map(et => <option key={et.value} value={et.value}>{et.label}</option>)}
                                </select>
                            </div>
                        </div>
                        <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            {EVAL_TYPES.find(et => et.value === evalType)?.desc}
                        </p>

                        {/* SQL */}
                        <div>
                            <label className={labelClass}>SQL Query</label>
                            <textarea value={sql} onChange={e => setSql(e.target.value)}
                                rows={5} className={`${inputClass} font-mono text-xs`}
                                placeholder="SELECT ... FROM ... WHERE ..." />
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 pt-2">
                            <button onClick={handleSave}
                                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg transition-all">
                                <Save className="w-4 h-4" />
                                {editingId ? 'Update Question' : 'Save Question'}
                            </button>
                            {editingId && (
                                <button onClick={resetForm}
                                    className={`px-4 py-2.5 rounded-lg text-sm font-medium ${isDark ? 'text-slate-400 hover:text-white hover:bg-white/5' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'}`}>
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* ─── EXISTING CUSTOM QUESTIONS LIST ─── */}
                    <div className={`p-6 rounded-2xl border space-y-3 ${isDark ? 'bg-slate-900/50 border-white/10' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <h2 className={`text-lg font-bold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                            <Database className="w-5 h-5 text-emerald-400" />
                            Custom Questions ({customQuestions.length})
                        </h2>

                        {customQuestions.length === 0 ? (
                            <div className={`text-center py-12 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
                                <p className="text-sm">No custom questions yet.</p>
                                <p className="text-xs mt-1">Use the form to create your first one.</p>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                                {customQuestions.map(q => (
                                    <div key={q.id} className={`group p-3 rounded-xl border transition-all ${editingId === q.id
                                            ? isDark ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-indigo-50 border-indigo-200'
                                            : isDark ? 'bg-slate-800/50 border-white/5 hover:border-white/10' : 'bg-slate-50 border-slate-100 hover:border-slate-200'
                                        }`}>
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-slate-800'}`}>{q.question}</p>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isDark ? 'bg-violet-500/15 text-violet-400' : 'bg-violet-100 text-violet-600'}`}>
                                                        {q.category}
                                                    </span>
                                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isDark ? 'bg-cyan-500/15 text-cyan-400' : 'bg-cyan-100 text-cyan-600'}`}>
                                                        {q.evalType || 'auto'}
                                                    </span>
                                                    <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{q.id}</span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                                                <button onClick={() => handleEdit(q)} title="Edit"
                                                    className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10' : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'}`}>
                                                    <Edit2 className="w-3.5 h-3.5" />
                                                </button>
                                                <button onClick={() => handleDelete(q.id)} title="Delete"
                                                    className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:text-red-400 hover:bg-red-500/10' : 'text-slate-400 hover:text-red-600 hover:bg-red-50'}`}>
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
