import React from 'react';
import { FileText } from 'lucide-react';
import { Dataset } from '../types';
import { Finding } from '../services/insightDiscoveryEngine';
import { generateExecutiveSummary } from '../services/executiveSummaryEngine';

/**
 * ExecutiveSummary — turns the ranked findings into a few sentences of plain
 * business English. Business owners want a conclusion, not just charts. Every
 * clause is grounded in a computed finding, so there are no invented numbers.
 */
export const ExecutiveSummary: React.FC<{ findings: Finding[]; dataset: Dataset }> = ({ findings, dataset }) => {
    if (!dataset) return null;
    const summary = generateExecutiveSummary(findings, dataset);
    // Render even when nothing material was found, so "Discover" always shows the
    // scan ran (an empty page reads as "broken", not "all clear").

    return (
        <div className="mb-6 rounded-2xl border border-indigo-200/60 dark:border-indigo-500/20 bg-gradient-to-br from-indigo-50 to-white dark:from-indigo-500/[0.07] dark:to-slate-800/40 p-5">
            <div className="flex items-center gap-2 mb-2.5">
                <FileText className="w-4 h-4 text-indigo-500" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
                    Executive Summary
                </h3>
            </div>
            <p className="text-[15px] leading-relaxed text-gray-800 dark:text-slate-100">
                {summary.sentences.join(' ')}
            </p>
            <p className="mt-2.5 text-[11px] text-gray-400 dark:text-slate-500">
                {summary.basedOn > 0
                    ? `Synthesized from ${summary.basedOn} detected ${summary.basedOn === 1 ? 'finding' : 'findings'} · exact figures, computed on your data`
                    : 'Automatic scan · deterministic checks for material changes, concentration, and data quality'}
            </p>
        </div>
    );
};
