import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, ChevronLeft, ChevronRight, LayoutDashboard, TrendingUp, Zap, ArrowUpDown, PieChart, Crown, Percent, Scale, Link2, ShieldAlert, Loader2,
} from 'lucide-react';
import type { Dataset } from '../types';
import { buildDataStory, type DataStory, type StoryKind } from '../services/dataStory';
import { storyChartToAnalysis } from '../services/ai-sql/datasetOverview';
import { ChartVisualization } from './ChartVisualization';

interface DataStoryViewProps {
  dataset: Dataset;
  question?: string;
  onClose: () => void;
}

const ICONS: Record<StoryKind, React.ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard, trend: TrendingUp, anomaly: Zap, movers: ArrowUpDown, breakdown: PieChart,
  concentration: Crown, margin: Percent, contrast: Scale, relationship: Link2, quality: ShieldAlert,
};

/**
 * The data story: findings worked out on this computer from every row (see
 * services/dataStory.ts). No AI call; nothing is sent anywhere.
 */
export const DataStoryView: React.FC<DataStoryViewProps> = ({ dataset, question, onClose }) => {
  const [story, setStory] = useState<DataStory | null>(null);
  const [index, setIndex] = useState(0);

  // Let the overlay paint first; large files take a moment.
  useEffect(() => {
    setStory(null);
    setIndex(0);
    const timer = window.setTimeout(() => setStory(buildDataStory(dataset, question || '')), 30);
    return () => window.clearTimeout(timer);
  }, [dataset, question]);

  const findings = story?.findings || [];
  const total = findings.length;
  const go = useCallback((next: number) => setIndex(Math.max(0, Math.min(total - 1, next))), [total]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(index + 1);
      if (event.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, onClose]);

  const finding = findings[index];
  const chart = useMemo(() => (finding?.chart ? storyChartToAnalysis(finding.chart, finding.headline) : null), [finding]);
  const Icon = finding ? ICONS[finding.kind] : LayoutDashboard;

  return (
    <div className="qi-story" role="dialog" aria-modal="true" aria-label="Data story">
      <header className="qi-story-head">
        <div className="qi-story-head-text">
          <span className="qi-story-tag">Data story</span>
          <h1>{story?.title || dataset.name.replace(/\.[^.]+$/, '')}</h1>
          {story && <p>{story.subtitle} · worked out on your computer, no AI</p>}
        </div>
        <button type="button" className="qi-story-close" onClick={onClose} aria-label="Close the data story">
          <X className="h-5 w-5" aria-hidden />
        </button>
      </header>

      <main className="qi-story-body">
        {!story && (
          <div className="qi-story-loading"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /> Reading all {(dataset.rows?.length || 0).toLocaleString('en-GB')} rows…</div>
        )}
        {story && !finding && (
          <div className="qi-story-loading">There is nothing to measure in this file yet: it has no number columns.</div>
        )}
        {finding && (
          <article key={finding.id} className={`qi-story-slide is-${finding.kind}`}>
            <div className="qi-story-copy">
              <p className="qi-story-eyebrow"><Icon className="h-4 w-4" aria-hidden /> {finding.eyebrow}</p>
              <h2 className="qi-story-headline">{finding.headline}</h2>
              {finding.points.length > 0 && (
                <ul className="qi-story-points">{finding.points.map(point => <li key={point}>{point}</li>)}</ul>
              )}
            </div>

            {finding.kind === 'overview' ? (
              <div className="qi-story-overview">
                {finding.kpis && (
                  <div className="qi-story-kpis">
                    {finding.kpis.map(kpi => (
                      <div key={kpi.label} className="qi-story-kpi">
                        <span>{kpi.label}</span>
                        <strong>{kpi.value}</strong>
                        {kpi.note && <small>{kpi.note}</small>}
                      </div>
                    ))}
                  </div>
                )}
                {total > 1 && (
                  <div className="qi-story-toc">
                    <h3>The short version</h3>
                    <ol>
                      {findings.slice(1).map((item, i) => {
                        const ItemIcon = ICONS[item.kind];
                        return (
                          <li key={item.id}>
                            <button type="button" onClick={() => go(i + 1)}>
                              <ItemIcon className="h-4 w-4" aria-hidden />
                              <span>{item.headline}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </div>
            ) : chart ? (
              <figure className="qi-story-chart">
                <figcaption>{finding.chart!.yLabel}</figcaption>
                <div className="qi-story-chart-area">
                  <ChartVisualization
                    data={chart.analysis.data}
                    xKey={chart.analysis.xKey}
                    yKey={chart.analysis.yKey}
                    yLabel={chart.analysis.yLabel}
                    config={chart.analysis.config}
                    chartType={chart.analysis.vis as any}
                    onChartTypeChange={() => {}}
                    formatting={chart.formatting}
                    hideControls
                    disableAutoSeries
                  />
                </div>
              </figure>
            ) : null}
          </article>
        )}
      </main>

      {total > 0 && (
        <footer className="qi-story-foot">
          <button type="button" className="qi-story-nav" onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </button>
          <div className="qi-story-dots" role="tablist" aria-label="Findings">
            {findings.map((item, i) => (
              <button key={item.id} type="button" role="tab" aria-selected={i === index} aria-label={`${i + 1}. ${item.eyebrow}`}
                className={i === index ? 'is-active' : ''} onClick={() => go(i)} />
            ))}
            <span className="qi-story-count">{index + 1} / {total}</span>
          </div>
          {index < total - 1 ? (
            <button type="button" className="qi-story-nav is-primary" onClick={() => go(index + 1)}>
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <button type="button" className="qi-story-nav is-primary" onClick={onClose}>Done</button>
          )}
        </footer>
      )}
    </div>
  );
};
