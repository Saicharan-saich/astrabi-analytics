import React, { useState, useEffect } from 'react';
import { Lightbulb, TrendingUp, BarChart2, Trophy, PieChart, ArrowRight, Search, Sparkles, Database, Rows3, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Dataset } from '../types';
import { generateQuestions, type SmartQuestion, type QuestionCategory, type QuestionSet } from '../services/questionGenerator';

interface SmartQuestionsViewProps {
    dataset: Dataset;
    onAskQuestion: (question: string) => void;
}

const categoryConfig: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
    trends: { label: 'Trends', icon: <TrendingUp className="w-4 h-4" />, color: 'text-blue-400' },
    comparisons: { label: 'Comparisons', icon: <BarChart2 className="w-4 h-4" />, color: 'text-violet-400' },
    rankings: { label: 'Rankings', icon: <Trophy className="w-4 h-4" />, color: 'text-amber-400' },
    distributions: { label: 'Distributions', icon: <PieChart className="w-4 h-4" />, color: 'text-emerald-400' },
};

export const SmartQuestionsView: React.FC<SmartQuestionsViewProps> = ({ dataset, onAskQuestion }) => {
    const [activeCategory, setActiveCategory] = useState<string>('trends');
    const [customQuery, setCustomQuery] = useState('');
    const [questionSet, setQuestionSet] = useState<QuestionSet | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // Generate questions when dataset changes
    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setQuestionSet(null);

        generateQuestions(dataset).then(qs => {
            if (!cancelled) {
                setQuestionSet(qs);
                setIsLoading(false);
            }
        }).catch(err => {
            console.error('[SmartQ] Generation failed:', err);
            if (!cancelled) setIsLoading(false);
        });

        return () => { cancelled = true; };
    }, [dataset.id, dataset.version]);

    const domain = dataset.domainProfile?.domain || 'General';
    const grain = dataset.semanticModel?.grain || dataset.domainProfile?.grain || 'Record';

    // Filter out empty categories for tabs
    const availableCategories = questionSet
        ? Object.entries(questionSet.categories)
            .filter(([, qs]) => qs.length > 0)
            .map(([key]) => key)
        : [];

    const effectiveCategory = availableCategories.includes(activeCategory)
        ? activeCategory
        : (availableCategories[0] || 'trends');

    const categoryQuestions = questionSet ? (questionSet.categories as any)[effectiveCategory] || [] : [];

    const handleCustomSubmit = () => {
        if (customQuery.trim()) {
            onAskQuestion(customQuery.trim());
            setCustomQuery('');
        }
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">

                {/* ═══ Section 1: Dataset Header ═══ */}
                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-center gap-4"
                >
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-500/20">
                        <Sparkles className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-white">{dataset.name}</h1>
                        <div className="flex items-center gap-3 mt-1">
                            <span className="flex items-center gap-1.5 text-xs text-gray-400">
                                <Rows3 className="w-3.5 h-3.5" />
                                {dataset.totalRows.toLocaleString()} rows
                            </span>
                            <span className="text-gray-600">·</span>
                            <span className="flex items-center gap-1.5 text-xs text-gray-400">
                                <Database className="w-3.5 h-3.5" />
                                {dataset.columns.length} columns
                            </span>
                            <span className="text-gray-600">·</span>
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/15 text-violet-400 border border-violet-500/25">
                                {domain}
                            </span>
                            {grain && (
                                <>
                                    <span className="text-gray-600">·</span>
                                    <span className="text-xs text-gray-500">1 row = 1 {grain}</span>
                                </>
                            )}
                        </div>
                    </div>
                </motion.div>

                {/* ═══ Loading State ═══ */}
                {isLoading && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="flex flex-col items-center justify-center py-20"
                    >
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600/20 to-purple-700/20 border border-violet-500/20 flex items-center justify-center mb-5">
                            <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
                        </div>
                        <h3 className="text-base font-semibold text-white mb-2">AI is analyzing your dataset</h3>
                        <p className="text-sm text-gray-500 text-center max-w-md">
                            Reading all {dataset.columns.length} columns and generating tailored questions for your {domain} data...
                        </p>
                    </motion.div>
                )}

                {/* ═══ Section 2: Primary Insights ═══ */}
                {!isLoading && questionSet && (
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.1 }}
                    >
                        <div className="flex items-center gap-2.5 mb-4">
                            <Lightbulb className="w-5 h-5 text-amber-400" />
                            <h2 className="text-base font-bold text-white">Start with these insights</h2>
                            <span className="text-xs text-gray-500 ml-1">({questionSet.primary.length} curated)</span>
                            {questionSet.source === 'ai' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 ml-auto">
                                    <Sparkles className="w-3 h-3" /> AI Generated
                                </span>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {questionSet.primary.map((q, i) => (
                                <QuestionCard key={q.id} question={q} index={i} onClick={() => onAskQuestion(q.question)} />
                            ))}
                        </div>

                        {questionSet.primary.length === 0 && (
                            <div className="text-center py-10 text-gray-500 text-sm">
                                <Lightbulb className="w-8 h-8 mx-auto mb-2 text-gray-600" />
                                No insights available — try uploading a dataset with more columns.
                            </div>
                        )}
                    </motion.div>
                )}

                {/* ═══ Section 3: Explore by Category ═══ */}
                {!isLoading && questionSet && availableCategories.length > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.2 }}
                    >
                        <div className="flex items-center gap-2.5 mb-4">
                            <Search className="w-5 h-5 text-blue-400" />
                            <h2 className="text-base font-bold text-white">Explore by category</h2>
                        </div>

                        {/* Tab bar */}
                        <div className="flex items-center gap-1 p-1 bg-white/[0.03] rounded-xl border border-white/[0.06] mb-4 w-fit">
                            {availableCategories.map(cat => {
                                const cfg = categoryConfig[cat];
                                const isActive = effectiveCategory === cat;
                                return (
                                    <button
                                        key={cat}
                                        onClick={() => setActiveCategory(cat)}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${isActive
                                            ? 'bg-white/[0.08] text-white shadow-sm'
                                            : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]'
                                            }`}
                                    >
                                        {cfg?.icon}
                                        {cfg?.label || cat}
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white/10 text-gray-300' : 'bg-white/[0.03] text-gray-600'}`}>
                                            {((questionSet.categories as any)[cat] || []).length}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Category questions grid */}
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={effectiveCategory}
                                initial={{ opacity: 0, x: 8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -8 }}
                                transition={{ duration: 0.15 }}
                                className="grid grid-cols-1 md:grid-cols-2 gap-3"
                            >
                                {categoryQuestions.map((q: SmartQuestion, i: number) => (
                                    <QuestionCard key={q.id} question={q} index={i} onClick={() => onAskQuestion(q.question)} compact />
                                ))}
                            </motion.div>
                        </AnimatePresence>
                    </motion.div>
                )}

                {/* ═══ Section 4: Ask Your Own ═══ */}
                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: isLoading ? 0.1 : 0.3 }}
                    className="bg-[#1c2033] border border-white/[0.06] rounded-2xl p-5"
                >
                    <div className="flex items-center gap-2.5 mb-3">
                        <Sparkles className="w-5 h-5 text-violet-400" />
                        <h2 className="text-base font-bold text-white">Ask your own question</h2>
                    </div>
                    <p className="text-xs text-gray-500 mb-4">
                        Type any question about your data — the AI will generate and execute the query automatically.
                    </p>
                    <div className="flex items-center gap-3">
                        <input
                            type="text"
                            value={customQuery}
                            onChange={e => setCustomQuery(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
                            placeholder={`e.g. "What is the average billing amount by medical condition?"`}
                            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
                        />
                        <button
                            onClick={handleCustomSubmit}
                            disabled={!customQuery.trim()}
                            className="flex items-center gap-2 px-5 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white text-sm font-semibold shadow-lg shadow-violet-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            Ask
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    </div>
                </motion.div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════
// QuestionCard sub-component
// ═══════════════════════════════════════════════════════════════════

interface QuestionCardProps {
    question: SmartQuestion;
    index: number;
    onClick: () => void;
    compact?: boolean;
}

const QuestionCard: React.FC<QuestionCardProps> = ({ question, index, onClick, compact }) => {
    const catColor: Record<QuestionCategory, string> = {
        trend: 'from-blue-600/10 to-blue-700/5 border-blue-500/15 hover:border-blue-500/30',
        comparison: 'from-violet-600/10 to-violet-700/5 border-violet-500/15 hover:border-violet-500/30',
        ranking: 'from-amber-600/10 to-amber-700/5 border-amber-500/15 hover:border-amber-500/30',
        distribution: 'from-emerald-600/10 to-emerald-700/5 border-emerald-500/15 hover:border-emerald-500/30',
        overview: 'from-cyan-600/10 to-cyan-700/5 border-cyan-500/15 hover:border-cyan-500/30',
        correlation: 'from-rose-600/10 to-rose-700/5 border-rose-500/15 hover:border-rose-500/30',
    };

    return (
        <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15, delay: index * 0.04 }}
            onClick={onClick}
            className={`group w-full text-left bg-gradient-to-br ${catColor[question.category] || catColor.overview} border rounded-xl ${compact ? 'p-3.5' : 'p-4'} transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-black/10`}
        >
            <div className="flex items-start gap-3">
                <span className={`${compact ? 'text-lg' : 'text-xl'} shrink-0 mt-0.5`}>{question.icon}</span>
                <div className="flex-1 min-w-0">
                    <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-semibold text-white group-hover:text-violet-200 transition-colors leading-snug`}>
                        {question.question}
                    </h3>
                    <p className={`${compact ? 'text-[10px]' : 'text-xs'} text-gray-500 mt-1 leading-relaxed`}>
                        {question.description}
                    </p>
                </div>
                <ArrowRight className={`w-4 h-4 text-gray-600 group-hover:text-violet-400 group-hover:translate-x-0.5 transition-all shrink-0 ${compact ? 'mt-0' : 'mt-1'}`} />
            </div>
        </motion.button>
    );
};
