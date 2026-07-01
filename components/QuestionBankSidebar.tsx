/**
 * QuestionBankSidebar.tsx — Extracted from Workbench.tsx (Phase 6).
 *
 * Renders the left sidebar containing domain-specific pre-built questions
 * organized by category. Includes search, Default/All toggle, and
 * grey-out logic for questions that can't be resolved against the dataset.
 */
import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, HelpCircle, Search, X } from 'lucide-react';
import { Dataset } from '../types';
import { getFullQuestionBankForDomain, getFullRegistry } from '../services/analysisEngine';
import { canResolveTemplate } from '../services/sqlTemplateResolver';
import { Tooltip as InfoTooltip } from './Tooltip';

interface QuestionBankSidebarProps {
    dataset: Dataset;
    isOpen: boolean;
    onToggle: () => void;
    currentQuestionLabel: string;
    defaultQuestionIds: Set<string>;
    onQuestionClick: (q: { label: string; intent: { questionId: string } }) => void;
}

export const QuestionBankSidebar: React.FC<QuestionBankSidebarProps> = ({
    dataset,
    isOpen,
    onToggle,
    currentQuestionLabel,
    defaultQuestionIds,
    onQuestionClick,
}) => {
    const [activeCategory, setActiveCategory] = useState<string | null>(null);
    const [questionSearch, setQuestionSearch] = useState('');
    const [showAllQuestions, setShowAllQuestions] = useState(false);

    // Pre-compute which questions can be resolved against the current dataset
    const resolvableQuestionIds = useMemo(() => {
        const registry = getFullRegistry();
        const ids = new Set<string>();
        for (const q of registry) {
            if (!q.sqlTemplate) { ids.add(q.id); continue; }
            if (canResolveTemplate(dataset, q.sqlTemplate)) ids.add(q.id);
        }
        return ids;
    }, [dataset]);

    return (
        <>
            {/* Sidebar Toggle Button */}
            <div className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 transition-all duration-300 ${isOpen ? 'left-64' : 'left-0'}`}>
                <button
                    onClick={onToggle}
                    className="bg-indigo-600 border border-indigo-700 shadow-lg p-1.5 rounded-r-lg hover:bg-indigo-700 text-white transition-colors"
                    title={isOpen ? "Collapse Sidebar" : "Expand Sidebar"}
                >
                    {isOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                </button>
            </div>

            {/* Sidebar Panel */}
            <div className={`${isOpen ? 'w-64' : 'w-0'} transition-all duration-300 bg-white border-r border-slate-200 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden`}>
                <div className="p-4 border-b border-slate-100 bg-slate-50 min-w-[16rem]">
                    <InfoTooltip text="Pre-built questions organized by category. Click any question to instantly run it against your data. Questions auto-adapt to your column names." position="right">
                        <h3 className="font-bold text-slate-800 flex items-center text-sm">
                            <HelpCircle className="w-4 h-4 mr-2 text-indigo-500" />
                            Question Bank
                        </h3>
                    </InfoTooltip>
                    {/* Search */}
                    <div className="relative mt-3">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                            type="text"
                            value={questionSearch}
                            onChange={(e) => setQuestionSearch(e.target.value)}
                            placeholder="Search questions..."
                            className="w-full pl-8 pr-7 py-2 text-xs text-slate-800 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition-colors placeholder:text-slate-400"
                        />
                        {questionSearch && (
                            <button onClick={() => setQuestionSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                    {/* Default / All Toggle */}
                    <div className="flex items-center mt-2">
                        <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 w-full">
                            <button
                                onClick={() => setShowAllQuestions(false)}
                                className={`flex-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${!showAllQuestions
                                    ? 'bg-white text-indigo-700 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-600'
                                    }`}
                            >
                                Default (10)
                            </button>
                            <button
                                onClick={() => setShowAllQuestions(true)}
                                className={`flex-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${showAllQuestions
                                    ? 'bg-white text-indigo-700 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-600'
                                    }`}
                            >
                                All
                            </button>
                        </div>
                    </div>
                </div>
                <div className="p-2 space-y-1 min-w-[16rem]">
                    {getFullQuestionBankForDomain(dataset?.domainProfile?.domain).map((cat) => {
                        const searchLower = questionSearch.toLowerCase();
                        let filteredQs = questionSearch
                            ? cat.questions.filter(q => q.label.toLowerCase().includes(searchLower))
                            : cat.questions;
                        if (!showAllQuestions && !questionSearch) {
                            filteredQs = filteredQs.filter(q => defaultQuestionIds.has(q.intent.questionId));
                        }
                        if (filteredQs.length === 0) return null;
                        const isExpanded = questionSearch ? true : activeCategory === cat.category;
                        return (
                            <div key={cat.category} className="border border-slate-100 rounded-lg overflow-hidden mb-2">
                                <button onClick={() => setActiveCategory(activeCategory === cat.category ? null : cat.category)} className="w-full flex items-center justify-between p-3 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 uppercase tracking-wider">
                                    <span>{cat.category}</span>
                                    <span className="flex items-center gap-1.5">
                                        <span className="text-[10px] text-slate-400 font-normal normal-case">{filteredQs.length}</span>
                                        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                    </span>
                                </button>
                                {isExpanded && (
                                    <div className="bg-slate-50 p-2 space-y-1 border-t border-slate-100">
                                        {filteredQs.map((q, i) => {
                                            const isResolvable = resolvableQuestionIds.has(q.intent.questionId);
                                            return (
                                                <button
                                                    key={i}
                                                    onClick={() => isResolvable ? onQuestionClick(q) : undefined}
                                                    disabled={!isResolvable}
                                                    title={!isResolvable ? 'This question requires columns not found in your dataset' : q.label}
                                                    className={`w-full text-left p-2 text-xs rounded transition-colors ${!isResolvable
                                                            ? 'text-slate-300 cursor-not-allowed line-through'
                                                            : currentQuestionLabel === q.label
                                                                ? 'bg-indigo-100 text-indigo-700 font-medium'
                                                                : 'hover:bg-indigo-50 text-slate-600'
                                                        }`}
                                                >
                                                    {q.label}
                                                    {!isResolvable && <span className="ml-1 text-[9px] text-slate-300">⚠</span>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    );
};
