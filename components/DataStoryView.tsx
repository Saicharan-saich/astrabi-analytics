import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';
import { Dataset, AnalysisResult, AnalysisType, AggregationType, TimeGrain, FormattingConfig } from '../types';
import { runAISQLPipeline, AISQLPipelineResult } from '../services/ai-sql';
import { ChartVisualization } from './ChartVisualization';

interface DataStoryViewProps {
  dataset: Dataset;
  onClose: () => void;
}

interface StorySlide {
  id: string;
  question: string;
  title: string;
  icon: string;
  status: 'pending' | 'loading' | 'done' | 'error';
  pipeline?: AISQLPipelineResult;
  result?: AnalysisResult;
  chartType?: string;
}

const CHART_MAP: Record<string, string> = {
  kpiCard: 'kpiCard', line: 'line', bar: 'bar', horizontalBar: 'horizontalBar',
  groupedBar: 'groupedBar', stackedBar: 'stackedBar', area: 'area',
  dualAxisCombo: 'combo', multiLine: 'line', donut: 'doughnut', heatmap: 'bar', table: 'bar',
};

const STORY_FORMATTING: FormattingConfig = {
  colorMode: 'vibrant',
  numberFormat: 'auto',
  fontSize: 'md',
  headerSize: 'lg',
  headerBold: true,
  showLabels: true,
  showDataLabels: true,
  tableCalculations: [],
};

const SLIDE_DEFS = [
  { id: 'overview', question: 'What is the total revenue?', title: 'The Big Picture', icon: '\u{1F4B0}' },
  { id: 'trend', question: 'Show the revenue trend over time', title: 'The Journey Over Time', icon: '\u{1F4C8}' },
  { id: 'ranking', question: 'Which category generates the most revenue?', title: 'The Champions', icon: '\u{1F3C6}' },
  { id: 'share', question: 'What percentage does each category contribute?', title: 'Share of the Pie', icon: '\u{1F967}' },
  { id: 'growth', question: 'Show year-over-year growth', title: 'Growth Story', icon: '\u{1F680}' },
  { id: 'seasonality', question: 'Which month historically performs best?', title: 'Seasonal Patterns', icon: '\u{1F4C5}' },
];

export const DataStoryView: React.FC<DataStoryViewProps> = ({ dataset, onClose }) => {
  const [slides, setSlides] = useState<StorySlide[]>(
    SLIDE_DEFS.map(d => ({ ...d, status: 'pending' as const }))
  );
  const [currentSlide, setCurrentSlide] = useState(-1);
  const [phase, setPhase] = useState<'loading' | 'presenting'>('loading');
  const [animClass, setAnimClass] = useState('opacity-0 translate-y-4');
  const [autoPlay, setAutoPlay] = useState(false);
  const autoPlayRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    async function runStory() {
      for (let i = 0; i < SLIDE_DEFS.length; i++) {
        if (cancelled) return;
        setSlides(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'loading' } : s));

        try {
          const res = await runAISQLPipeline(SLIDE_DEFS[i].question, dataset);
          if (cancelled) return;

          const ct = CHART_MAP[res.chart.chartType] || 'bar';
          const result: AnalysisResult = {
            data: res.chartData, xKey: res.chart.xKey, yKey: res.chart.yKey,
            yLabel: SLIDE_DEFS[i].question, insight: res.explanation, sql: res.sql,
            config: {
              metric: res.plan.metrics[0]?.field || res.chart.yKey,
              dimension: res.plan.dimensions[0]?.field || res.chart.xKey,
              aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW,
              analysisType: AnalysisType.STANDARD, questionId: `story_${SLIDE_DEFS[i].id}`,
              questionLabel: SLIDE_DEFS[i].question,
              secondaryMetrics: res.chart.secondaryYKeys,
              axisMode: res.chart.useDualAxis ? 'dual' : 'auto',
              limit: res.plan.limit || 0, sort: res.plan.sort?.[0]?.dir || 'desc',
            },
            vis: ct as any,
            kpi: res.chart.chartType === 'kpiCard' && res.chartData.length > 0
              ? res.chartData[0][res.chart.yKey] : undefined,
            growth: res.chart.growth
              ? { diff: res.chart.growth.diff, pct: res.chart.growth.pct } : undefined,
          };

          setSlides(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: 'done', pipeline: res, result, chartType: ct } : s
          ));
        } catch {
          if (cancelled) return;
          setSlides(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: 'error' } : s
          ));
        }
      }

      if (!cancelled) {
        setTimeout(() => {
          if (!cancelled) {
            setPhase('presenting');
            setCurrentSlide(0);
            setTimeout(() => setAnimClass('opacity-100 translate-y-0'), 50);
          }
        }, 800);
      }
    }

    runStory();
    return () => { cancelled = true; mountedRef.current = false; };
  }, [dataset]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext(); }
      if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  useEffect(() => {
    if (autoPlay && phase === 'presenting') {
      autoPlayRef.current = setInterval(() => {
        setCurrentSlide(prev => {
          if (prev >= doneSlides.length - 1) { setAutoPlay(false); return prev; }
          setAnimClass('opacity-0 translate-y-4');
          setTimeout(() => setAnimClass('opacity-100 translate-y-0'), 50);
          return prev + 1;
        });
      }, 6000);
    }
    return () => { if (autoPlayRef.current) clearInterval(autoPlayRef.current); };
  }, [autoPlay, phase]);

  const doneSlides = slides.filter(s => s.status === 'done');
  const completedCount = slides.filter(s => s.status === 'done' || s.status === 'error').length;

  const goNext = useCallback(() => {
    if (currentSlide < doneSlides.length - 1) {
      setAnimClass('opacity-0 translate-y-4');
      setTimeout(() => {
        setCurrentSlide(prev => prev + 1);
        setTimeout(() => setAnimClass('opacity-100 translate-y-0'), 50);
      }, 300);
    }
  }, [currentSlide, doneSlides.length]);

  const goPrev = useCallback(() => {
    if (currentSlide > 0) {
      setAnimClass('opacity-0 -translate-y-4');
      setTimeout(() => {
        setCurrentSlide(prev => prev - 1);
        setTimeout(() => setAnimClass('opacity-100 translate-y-0'), 50);
      }, 300);
    }
  }, [currentSlide]);

  const activeSlide = doneSlides[currentSlide];

  return (
    <div className="fixed inset-0 z-50 bg-gradient-to-br from-slate-950 via-[#0a0f1a] to-indigo-950 flex flex-col overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '2s' }} />
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-cyan-500/3 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '4s' }} />
      </div>

      {/* Close button */}
      <button onClick={onClose}
        className="absolute top-5 right-5 z-50 p-2 rounded-full bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all border border-white/10">
        <X className="w-5 h-5" />
      </button>

      {/* Loading Phase */}
      {phase === 'loading' && (
        <div className="flex-1 flex flex-col items-center justify-center relative z-10">
          <div className="text-5xl mb-6 animate-bounce">{'\u{1F4CA}'}</div>
          <h2 className="text-3xl font-bold text-white mb-2">Crafting Your Data Story</h2>
          <p className="text-white/40 text-sm mb-8">Analyzing patterns across your dataset...</p>

          <div className="w-80 mb-8">
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 rounded-full transition-all duration-700 ease-out"
                style={{ width: `${(completedCount / SLIDE_DEFS.length) * 100}%` }} />
            </div>
          </div>

          <div className="space-y-2 w-72">
            {slides.map((slide) => (
              <div key={slide.id}
                className={`flex items-center gap-3 py-1.5 text-sm transition-all duration-500 ${
                  slide.status === 'done' ? 'text-emerald-400'
                  : slide.status === 'loading' ? 'text-white'
                  : slide.status === 'error' ? 'text-red-400'
                  : 'text-white/25'
                }`}>
                <span className="w-5 text-center">
                  {slide.status === 'done' ? '\u2713' :
                   slide.status === 'loading' ? <Loader2 className="w-4 h-4 animate-spin inline" /> :
                   slide.status === 'error' ? '\u2717' : '\u25CB'}
                </span>
                <span className="text-lg mr-1">{slide.icon}</span>
                <span>{slide.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Presenting Phase */}
      {phase === 'presenting' && activeSlide && (
        <>
          {/* Slide indicator dots */}
          <div className="flex items-center justify-between px-8 pt-6 pb-2 relative z-10">
            <div className="flex items-center gap-2">
              {doneSlides.map((_, i) => (
                <button key={i}
                  onClick={() => {
                    setAnimClass('opacity-0');
                    setTimeout(() => { setCurrentSlide(i); setTimeout(() => setAnimClass('opacity-100 translate-y-0'), 50); }, 200);
                  }}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === currentSlide ? 'w-8 bg-indigo-400' : 'w-1.5 bg-white/20 hover:bg-white/40'
                  }`} />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-white/30 text-xs font-mono">{currentSlide + 1} / {doneSlides.length}</span>
              <button onClick={() => setAutoPlay(!autoPlay)}
                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-all">
                {autoPlay ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Main slide content */}
          <div className={`flex-1 flex flex-col items-center justify-center px-8 relative z-10 transition-all duration-500 ease-out ${animClass}`}>
            <div className="text-center mb-6">
              <span className="text-4xl mb-3 block">{activeSlide.icon}</span>
              <h1 className="text-3xl font-bold text-white mb-2">{activeSlide.title}</h1>
              <p className="text-white/40 text-sm max-w-lg mx-auto">
                {activeSlide.pipeline?.explanation || activeSlide.question}
              </p>
            </div>

            <div className="w-full max-w-4xl h-[50vh] bg-white/[0.03] backdrop-blur-sm rounded-2xl border border-white/[0.06] p-6 overflow-hidden">
              {activeSlide.result && (
                <ChartVisualization
                  data={activeSlide.result.data} xKey={activeSlide.result.xKey}
                  yKey={activeSlide.result.yKey} yLabel={activeSlide.result.yLabel}
                  chartType={(activeSlide.chartType || 'bar') as any}
                  onChartTypeChange={() => {}}
                  formatting={{
                    ...STORY_FORMATTING,
                    ...activeSlide.result.formatting,
                    showDataLabels: true,
                  }}
                />
              )}
            </div>

            {activeSlide.result?.kpi !== undefined && (
              <div className="mt-4 text-center">
                <span className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-orange-400">
                  {typeof activeSlide.result.kpi === 'number'
                    ? activeSlide.result.kpi.toLocaleString(undefined, { maximumFractionDigits: 0 })
                    : activeSlide.result.kpi}
                </span>
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center justify-between px-8 pb-6 relative z-10">
            <button onClick={goPrev} disabled={currentSlide === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-all disabled:opacity-20 disabled:cursor-not-allowed border border-white/5">
              <ChevronLeft className="w-4 h-4" /> Previous
            </button>
            <p className="text-white/20 text-xs">
              Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-[10px] font-mono">{'\u2190'}</kbd>{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/40 text-[10px] font-mono">{'\u2192'}</kbd> to navigate
            </p>
            <button onClick={currentSlide === doneSlides.length - 1 ? onClose : goNext}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all border ${
                currentSlide === doneSlides.length - 1
                  ? 'bg-indigo-500 hover:bg-indigo-600 text-white border-indigo-400/30'
                  : 'bg-white/5 hover:bg-white/10 text-white/60 hover:text-white border-white/5'
              }`}>
              {currentSlide === doneSlides.length - 1 ? 'Finish' : 'Next'} <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
};
