import React from 'react';
import { CheckCircle2, Database, GitBranch, ListChecks } from 'lucide-react';
import type { TraceStory } from '../services/ai-sql/types';
import { useTheme } from './ThemeProvider';

interface TraceStoryPanelProps {
  story: TraceStory;
  question?: string;
}

export const TraceStoryPanel: React.FC<TraceStoryPanelProps> = ({ story, question }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className={`rounded-2xl border p-5 sm:p-6 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-slate-200 bg-white shadow-sm'}`}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-violet-500/15 p-2.5 text-violet-500"><GitBranch className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h2 className="text-base font-black">How this insight was produced</h2>
            {question && <p className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{question}</p>}
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-500">
              <CheckCircle2 className="h-3 w-3" /> Verified from executed SQL and returned result
            </div>
          </div>
        </div>

        <ol className="mt-6 space-y-0">
          {story.steps.map((step, index) => (
            <li key={`${step.kind}-${index}`} className="relative grid grid-cols-[2.25rem_1fr] gap-3 pb-5 last:pb-0">
              {index < story.steps.length - 1 && <div className={`absolute left-[1.08rem] top-9 h-[calc(100%-1.25rem)] w-px ${isDark ? 'bg-white/10' : 'bg-slate-200'}`} />}
              <div className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border text-xs font-black ${isDark ? 'border-violet-500/30 bg-[#151929] text-violet-300' : 'border-violet-200 bg-violet-50 text-violet-700'}`}>
                {index + 1}
              </div>
              <div className={`rounded-xl border p-4 ${isDark ? 'border-white/[0.07] bg-black/10' : 'border-slate-100 bg-slate-50/70'}`}>
                <div className="flex items-center gap-2">
                  {step.kind === 'source' || step.kind === 'result'
                    ? <Database className="h-4 w-4 text-cyan-500" />
                    : step.kind === 'filter' || step.kind === 'qualify'
                      ? <ListChecks className="h-4 w-4 text-amber-500" />
                      : <GitBranch className="h-4 w-4 text-violet-500" />}
                  <h3 className="text-sm font-black">{step.title}</h3>
                </div>
                <p className={`mt-1.5 text-sm leading-6 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{step.description}</p>
                <p className={`mt-2 break-words font-mono text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Evidence: {step.evidence}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className={`mt-6 border-t pt-4 text-[11px] leading-5 ${isDark ? 'border-white/[0.07] text-slate-500' : 'border-slate-100 text-slate-500'}`}>
          This story is generated from the SQL that actually executed locally and the result DuckDB returned. Unsupported interpretations are omitted rather than invented.
        </p>
      </div>
    </div>
  );
};

export default TraceStoryPanel;

