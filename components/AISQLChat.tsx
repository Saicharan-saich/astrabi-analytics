import React, { useState, useRef, useEffect } from 'react';
import { Send, Copy, Save, Check, Sparkles, AlertCircle, Loader2, Database, X, Lock, Clock } from 'lucide-react';
import { Dataset, QuestionTemplate, ColumnType } from '../types';
import { generateSQL, ChatMessage, extractMetadata } from '../services/aiSQLService';
import { saveCustomQuestion, getFullRegistry } from '../services/questionRegistry';
import { checkAiSqlLimit, formatResetTime } from '../services/aiSqlRateLimiter';
import { useAuthStore } from '../store/useAuthStore';

interface AISQLChatProps {
    dataset: Dataset;
    onClose?: () => void;
}

export const AISQLChat: React.FC<AISQLChatProps> = ({ dataset, onClose }) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [showSaveModal, setSaveModal] = useState<string | null>(null);
    const [saveCategory, setSaveCategory] = useState('Custom Questions');
    const [saveQuestionText, setSaveQuestionText] = useState('');
    const [saveSuccess, setSaveSuccess] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Rate limiting
    const currentUser = useAuthStore(s => s.currentUser);
    const incrementAiSqlUsage = useAuthStore(s => s.incrementAiSqlUsage);
    const limitStatus = checkAiSqlLimit(currentUser);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleSend = async () => {
        const question = input.trim();
        if (!question || isLoading) return;

        // ── Rate limit check ──
        const currentStatus = checkAiSqlLimit(currentUser);
        if (!currentStatus.allowed) {
            const limitMsg: ChatMessage = {
                id: `limit-${Date.now()}`,
                role: 'assistant',
                content: currentStatus.blocked
                    ? 'Your account role does not have access to AI SQL.'
                    : `You've used all ${currentStatus.limit} AI SQL queries. Your limit resets in ${formatResetTime(currentStatus.resetsInMs)}.`,
                timestamp: Date.now()
            };
            setMessages(prev => [...prev, limitMsg]);
            return;
        }

        const userMsg: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: question,
            timestamp: Date.now()
        };

        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setIsLoading(true);

        try {
            const result = await generateSQL(question, dataset, [...messages, userMsg]);

            const assistantMsg: ChatMessage = {
                id: `ai-${Date.now()}`,
                role: 'assistant',
                content: result.error || result.explanation || 'SQL generated.',
                sql: result.sql,
                explanation: result.explanation,
                columnsUsed: result.columnsUsed,
                timestamp: Date.now()
            };

            setMessages(prev => [...prev, assistantMsg]);

            // ── Increment usage AFTER successful query ──
            if (!result.error) {
                incrementAiSqlUsage();
            }
        } catch (err) {
            const errorMsg: ChatMessage = {
                id: `err-${Date.now()}`,
                role: 'assistant',
                content: 'An unexpected error occurred. Please try again.',
                timestamp: Date.now()
            };
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCopy = (sql: string, msgId: string) => {
        navigator.clipboard.writeText(sql);
        setCopiedId(msgId);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const handleSave = () => {
        if (!showSaveModal || !saveQuestionText.trim()) return;

        const uniqueQuestionId = `ai_sql_${Date.now()}`;

        // Just save the exact AI SQL — it will be executed directly via alasql
        const newQuestion: QuestionTemplate = {
            id: uniqueQuestionId,  // MUST be unique — never use 'custom_builder' (that's the Question Builder's ID)
            category: saveCategory || 'Custom Questions',
            question: saveQuestionText.trim(),
            req: [],
            grain: 'any',
            vis: 'bar',
            sql: showSaveModal,
            aiSql: showSaveModal, // The exact AI-generated SQL to execute directly
            questionId: uniqueQuestionId,
        } as any;

        console.log('[AI SQL Save] Saving with direct SQL:', showSaveModal);

        saveCustomQuestion(newQuestion);
        setSaveSuccess(true);
        setTimeout(() => {
            setSaveModal(null);
            setSaveSuccess(false);
            setSaveQuestionText('');
        }, 1500);
    };

    const existingCategories = [...new Set(getFullRegistry().map(q => q.category))];

    return (
        <div className="flex flex-col h-full bg-gradient-to-b from-slate-50 to-white" style={{ color: '#1e293b' }}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white">
                <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center">
                        <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold">AI SQL Generator</h3>
                        <p className="text-[10px] text-white/70">Ask questions, get SQL queries</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 px-2 py-0.5 bg-white/10 rounded-full text-[10px]">
                        <Database className="w-3 h-3" />
                        <span>{dataset.columns.length} cols</span>
                    </div>
                    {onClose && (
                        <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ minHeight: 200, maxHeight: 400 }}>
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center py-8">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center mb-3">
                            <Sparkles className="w-6 h-6 text-violet-500" />
                        </div>
                        <p className="text-sm font-semibold mb-1" style={{ color: '#334155' }}>Ask anything about your data</p>
                        <p className="text-xs max-w-xs" style={{ color: '#94a3b8' }}>
                            I'll generate SQL queries using your columns: {dataset.columns.slice(0, 3).map(c => c.name).join(', ')}{dataset.columns.length > 3 ? ` +${dataset.columns.length - 3} more` : ''}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-4 justify-center">
                            {[
                                'Top 10 products by revenue',
                                'Average order value by month',
                                'Customer count by segment'
                            ].map(q => (
                                <button
                                    key={q}
                                    onClick={() => { setInput(q); }}
                                    className="px-2.5 py-1 text-[11px] bg-white border border-slate-200 rounded-full hover:border-violet-300 transition-colors"
                                    style={{ color: '#475569' }}
                                >{q}</button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[90%] rounded-xl px-3 py-2 ${msg.role === 'user'
                            ? 'bg-gradient-to-r from-violet-500 to-indigo-500 text-white'
                            : 'bg-white border border-slate-200 shadow-sm'
                            }`}>
                            {msg.role === 'user' ? (
                                <p className="text-sm">{msg.content}</p>
                            ) : (
                                <div className="space-y-2">
                                    {msg.explanation && (
                                        <p className="text-xs" style={{ color: '#475569' }}>{msg.explanation}</p>
                                    )}

                                    {msg.sql && (
                                        <div className="relative">
                                            <pre className="bg-slate-900 text-emerald-300 text-[11px] rounded-lg p-3 overflow-x-auto font-mono leading-relaxed">
                                                {msg.sql}
                                            </pre>
                                            <div className="absolute top-1.5 right-1.5 flex gap-1">
                                                <button
                                                    onClick={() => handleCopy(msg.sql!, msg.id)}
                                                    className="p-1 rounded bg-slate-700 hover:bg-slate-600 transition-colors"
                                                    title="Copy SQL"
                                                >
                                                    {copiedId === msg.id
                                                        ? <Check className="w-3 h-3 text-emerald-400" />
                                                        : <Copy className="w-3 h-3 text-slate-300" />
                                                    }
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setSaveModal(msg.sql!);
                                                        setSaveQuestionText(messages.find(m => m.id < msg.id && m.role === 'user')?.content || '');
                                                    }}
                                                    className="p-1 rounded bg-slate-700 hover:bg-violet-600 transition-colors"
                                                    title="Save as Question"
                                                >
                                                    <Save className="w-3 h-3 text-slate-300" />
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {msg.columnsUsed && msg.columnsUsed.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {msg.columnsUsed.map(col => (
                                                <span key={col} className="px-1.5 py-0.5 text-[9px] bg-violet-50 text-violet-600 border border-violet-200 rounded font-mono">
                                                    {col}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {!msg.sql && msg.content.includes('error') && (
                                        <div className="flex items-center gap-1.5 text-amber-600">
                                            <AlertCircle className="w-3 h-3" />
                                            <p className="text-xs" style={{ color: '#d97706' }}>{msg.content}</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                ))}

                {isLoading && (
                    <div className="flex justify-start">
                        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
                            <div className="flex items-center gap-2">
                                <Loader2 className="w-4 h-4 text-violet-500 animate-spin" />
                                <span className="text-xs" style={{ color: '#64748b' }}>Generating SQL...</span>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="px-3 py-2.5 border-t border-slate-200 bg-white">
                {/* Remaining queries indicator */}
                {!limitStatus.blocked && limitStatus.limit !== Infinity && (
                    <div className="flex items-center justify-between mb-2 px-1">
                        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: limitStatus.remaining > 3 ? '#64748b' : limitStatus.remaining > 0 ? '#d97706' : '#dc2626' }}>
                            {limitStatus.remaining > 0
                                ? <Clock className="w-3 h-3" />
                                : <Lock className="w-3 h-3" />
                            }
                            <span className="font-semibold">{limitStatus.remaining}/{limitStatus.limit} queries remaining</span>
                            {limitStatus.used > 0 && (
                                <span className="text-slate-400"> · Resets in {formatResetTime(limitStatus.resetsInMs)}</span>
                            )}
                        </div>
                        <div className="flex gap-0.5">
                            {Array.from({ length: limitStatus.limit }, (_, i) => (
                                <div
                                    key={i}
                                    className="w-1.5 h-1.5 rounded-full transition-colors"
                                    style={{
                                        backgroundColor: i < limitStatus.used
                                            ? (limitStatus.remaining > 3 ? '#8b5cf6' : limitStatus.remaining > 0 ? '#f59e0b' : '#ef4444')
                                            : '#e2e8f0'
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                        placeholder={!limitStatus.allowed ? 'Query limit reached...' : 'Ask a question about your data...'}
                        className="flex-1 text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-violet-100 focus:border-violet-400 outline-none"
                        style={{ color: '#0f172a', backgroundColor: !limitStatus.allowed ? '#fef2f2' : '#f8fafc', caretColor: '#0f172a' }}
                        disabled={isLoading || !limitStatus.allowed}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading || !limitStatus.allowed}
                        className="p-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 text-white hover:from-violet-600 hover:to-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                    >
                        {!limitStatus.allowed ? <Lock className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Save Modal */}
            {showSaveModal && (
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 rounded-xl">
                    <div className="bg-white rounded-xl shadow-2xl p-5 w-[90%] max-w-md">
                        <h3 className="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                            <Save className="w-4 h-4 text-violet-500" />
                            Save as Custom Question
                        </h3>

                        {saveSuccess ? (
                            <div className="flex items-center gap-2 text-emerald-600 py-4 justify-center">
                                <Check className="w-5 h-5" />
                                <span className="text-sm font-semibold">Saved successfully!</span>
                            </div>
                        ) : (
                            <>
                                <div className="space-y-3">
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1">Question</label>
                                        <input
                                            type="text"
                                            value={saveQuestionText}
                                            onChange={e => setSaveQuestionText(e.target.value)}
                                            placeholder="e.g., Top 10 products by revenue"
                                            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-violet-100"
                                            style={{ color: '#0f172a', backgroundColor: '#f8fafc' }}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1">Category</label>
                                        <select
                                            value={saveCategory}
                                            onChange={e => setSaveCategory(e.target.value)}
                                            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 outline-none"
                                            style={{ color: '#0f172a', backgroundColor: '#f8fafc' }}
                                        >
                                            <option value="Custom Questions">Custom Questions</option>
                                            {existingCategories.filter(c => c !== 'Custom Questions').map(c => (
                                                <option key={c} value={c}>{c}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1">SQL Preview</label>
                                        <pre className="bg-slate-900 text-emerald-300 text-[10px] rounded-lg p-2 overflow-x-auto font-mono max-h-24">
                                            {showSaveModal}
                                        </pre>
                                    </div>
                                </div>
                                <div className="flex justify-end gap-2 mt-4">
                                    <button
                                        onClick={() => { setSaveModal(null); setSaveQuestionText(''); }}
                                        className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                    >Cancel</button>
                                    <button
                                        onClick={handleSave}
                                        disabled={!saveQuestionText.trim()}
                                        className="px-3 py-1.5 text-xs bg-violet-500 text-white rounded-lg hover:bg-violet-600 disabled:opacity-50 transition-colors font-semibold"
                                    >Save Question</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
