import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight, ArrowLeft, X, RotateCcw, Check, Lightbulb,
  Sparkles, BookOpen, Wheat,
} from 'lucide-react';
import {
  CHAPTERS, LANE_INFO, FARMER, runQuery, formatMoney,
  type GAFSLane, type Chapter, type StoryChip, type AnswerRow, type AnswerSpec,
} from './farmStory';
import { FarmScene, SamAvatar, FARM } from './FarmScenes';

// ═══════════════════════════════════════════════════════════════════
// Story mode lives in its own warm world — cream paper on a lamp-lit
// dark ground, so the illustrations carry the page.
// ═══════════════════════════════════════════════════════════════════

const INK = '#2E2318';
const INK_SOFT = '#6B5A48';
const INK_FAINT = '#9A8770';
const PAPER = '#FFF8EC';
const PAPER_EDGE = '#E8D9BF';

const LANE_COLOR: Record<GAFSLane, string> = {
  G: '#4E7C3E',
  A: '#D98324',
  F: '#2E6F8E',
  S: '#C0563E',
};

const PROGRESS_KEY = 'qi.gafsStory.furthestChapter';

type Phase = 'cover' | 'story' | 'puzzle' | 'payoff' | 'finale';

interface Placement { chipId: string | null; verdict: 'right' | 'wrong' | null; note?: string }

// ── Charts ─────────────────────────────────────────────────────────

const money = (v: number) => formatMoney(v);

const BarList: React.FC<{ rows: AnswerRow[]; measure: 'revenue' | 'quantity'; accent?: string; dense?: boolean }> = ({
  rows, measure, accent = FARM.honey, dense = false,
}) => {
  const max = Math.max(...rows.map(r => r.value), 1);
  return (
    <div className={dense ? 'space-y-1.5' : 'space-y-2.5'}>
      {rows.map((row, i) => (
        <motion.div
          key={row.label}
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.05 + i * 0.06 }}
          className="flex items-center gap-3"
        >
          <span
            className={`shrink-0 text-right font-semibold ${dense ? 'w-24 text-[11px]' : 'w-32 text-xs'}`}
            style={{ color: INK_SOFT }}
          >
            {row.label}
          </span>
          <div className="flex-1 h-6 rounded-md overflow-hidden" style={{ background: '#00000010' }}>
            <motion.div
              className="h-full rounded-md"
              style={{ background: i === 0 ? accent : `${accent}99` }}
              initial={{ width: 0 }}
              animate={{ width: `${(row.value / max) * 100}%` }}
              transition={{ delay: 0.12 + i * 0.06, duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <span
            className={`shrink-0 font-bold tabular-nums ${dense ? 'w-24 text-[11px]' : 'w-28 text-xs'}`}
            style={{ color: INK }}
          >
            {measure === 'revenue' ? money(row.value) : `${row.value.toLocaleString()}${row.unit ? ' ' + row.unit : ''}`}
          </span>
        </motion.div>
      ))}
    </div>
  );
};

const ColumnChart: React.FC<{ rows: AnswerRow[] }> = ({ rows }) => {
  const max = Math.max(...rows.map(r => r.value), 1);
  const peak = rows.reduce((a, b) => (b.value > a.value ? b : a), rows[0]);
  const trough = rows.reduce((a, b) => (b.value < a.value ? b : a), rows[0]);
  return (
    <div className="flex items-end gap-1.5 sm:gap-2.5 h-56">
      {rows.map((row, i) => {
        const isPeak = row.label === peak.label;
        const isTrough = row.label === trough.label;
        return (
          <div key={row.label} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end">
            <span
              className="text-[10px] font-bold tabular-nums"
              style={{ color: isPeak || isTrough ? INK : INK_FAINT }}
            >
              {money(row.value)}
            </span>
            <motion.div
              className="w-full rounded-t-md"
              style={{ background: isPeak ? FARM.honey : isTrough ? '#9FB3C8' : `${FARM.leaf}CC` }}
              initial={{ height: 0 }}
              animate={{ height: `${(row.value / max) * 100}%` }}
              transition={{ delay: 0.1 + i * 0.05, duration: 0.5, ease: 'easeOut' }}
            />
            <span className="text-[11px] font-semibold" style={{ color: INK_SOFT }}>{row.label}</span>
          </div>
        );
      })}
    </div>
  );
};

const GroupPills: React.FC<{ rows: AnswerRow[] }> = ({ rows }) => (
  <div className="flex flex-wrap gap-2">
    {rows.map((row, i) => (
      <motion.span
        key={row.label}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.06 * i }}
        className="px-3.5 py-2 rounded-lg text-sm font-semibold border"
        style={{ background: '#00000008', borderColor: PAPER_EDGE, color: INK }}
      >
        {row.label}
      </motion.span>
    ))}
  </div>
);

const Payoff: React.FC<{ chapter: Chapter }> = ({ chapter }) => {
  const { kind, spec, compareWith, caption } = chapter.payoff;
  const rows = useMemo(() => runQuery(spec), [spec]);
  const compareRows = useMemo(() => (compareWith ? runQuery(compareWith) : null), [compareWith]);

  return (
    <div>
      {spec.filter && (
        <p className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: LANE_COLOR.F }}>
          Filtered to: {spec.filter.label}
        </p>
      )}

      {kind === 'groups' && <GroupPills rows={rows} />}
      {kind === 'bars' && <BarList rows={rows} measure={spec.measure} />}
      {kind === 'columns' && <ColumnChart rows={rows} />}
      {kind === 'compare' && compareRows && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold mb-3" style={{ color: FARM.honey }}>Adding up the money</p>
            <BarList rows={rows} measure={spec.measure} accent={FARM.honey} dense />
          </div>
          <div>
            <p className="text-xs font-bold mb-3" style={{ color: FARM.leaf }}>Adding up how many sold</p>
            <BarList rows={compareRows} measure={compareWith!.measure} accent={FARM.leaf} dense />
          </div>
        </div>
      )}

      <p className="text-xs italic mt-4" style={{ color: INK_FAINT }}>{caption}</p>
    </div>
  );
};

// ── Main ───────────────────────────────────────────────────────────

interface StoryModeProps {
  onExit?: () => void;
  onNavigateToBuilder?: () => void;
}

export const StoryMode: React.FC<StoryModeProps> = ({ onExit, onNavigateToBuilder }) => {
  const [phase, setPhase] = useState<Phase>('cover');
  const [index, setIndex] = useState(0);
  /** Beats are revealed one line at a time; === beats.length means Sam speaks. */
  const [beat, setBeat] = useState(0);
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [dragLane, setDragLane] = useState<GAFSLane | null>(null);
  const [checked, setChecked] = useState(false);
  const [firstTry, setFirstTry] = useState<Set<number>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [furthest, setFurthest] = useState(0);

  const chapter = CHAPTERS[index];

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(PROGRESS_KEY) ?? '0');
      if (Number.isFinite(saved) && saved > 0) setFurthest(Math.min(saved, CHAPTERS.length - 1));
    } catch { /* storage unavailable — the story just starts from the top */ }
  }, []);

  const remember = useCallback((chapterIndex: number) => {
    setFurthest(prev => {
      const next = Math.max(prev, chapterIndex);
      try { localStorage.setItem(PROGRESS_KEY, String(next)); } catch { /* non-fatal */ }
      return next;
    });
  }, []);

  const resetChapter = useCallback(() => {
    setBeat(0);
    setPlacements({});
    setSelectedChip(null);
    setDragLane(null);
    setChecked(false);
    setAttempted(false);
  }, []);

  const goToChapter = useCallback((i: number) => {
    setIndex(i);
    resetChapter();
    setPhase('story');
    remember(i);
  }, [resetChapter, remember]);

  const placedChipIds = useMemo(
    () => new Set(Object.values(placements).map(p => p.chipId).filter(Boolean) as string[]),
    [placements],
  );

  const poolChips = useMemo(
    () => chapter.chips.filter(c => !placedChipIds.has(c.id)),
    [chapter, placedChipIds],
  );

  const place = useCallback((chipId: string, lane: GAFSLane) => {
    setPlacements(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key]?.chipId === chipId) next[key] = { chipId: null, verdict: null };
      }
      next[lane] = { chipId, verdict: null };
      return next;
    });
    setSelectedChip(null);
    setDragLane(null);
    setChecked(false);
  }, []);

  const clearLane = useCallback((lane: GAFSLane) => {
    setPlacements(prev => ({ ...prev, [lane]: { chipId: null, verdict: null } }));
    setChecked(false);
  }, []);

  const allFilled = chapter.lanes.every(l => placements[l]?.chipId);

  const check = useCallback(() => {
    const next: Record<string, Placement> = { ...placements };
    let allRight = true;

    for (const lane of chapter.lanes) {
      const chipId = placements[lane]?.chipId;
      const chip = chapter.chips.find(c => c.id === chipId);
      if (!chip) { allRight = false; continue; }

      if (chip.lane !== lane) {
        next[lane] = {
          chipId: chip.id,
          verdict: 'wrong',
          note: `That is a ${LANE_INFO[chip.lane].name.toLowerCase()} answer, not a ${LANE_INFO[lane].name.toLowerCase()} one. ${LANE_INFO[lane].asks}`,
        };
        allRight = false;
      } else if (!chip.correct) {
        next[lane] = { chipId: chip.id, verdict: 'wrong', note: chip.whyNot };
        allRight = false;
      } else {
        next[lane] = { chipId: chip.id, verdict: 'right' };
      }
    }

    setPlacements(next);
    setChecked(true);

    if (allRight) {
      if (!attempted) setFirstTry(prev => new Set(prev).add(chapter.id));
      setTimeout(() => setPhase('payoff'), 900);
    } else {
      setAttempted(true);
    }
  }, [placements, chapter, attempted]);

  const nudge = useCallback(() => {
    const lane = chapter.lanes.find(l => {
      const p = placements[l];
      if (!p?.chipId) return true;
      const chip = chapter.chips.find(c => c.id === p.chipId);
      return !chip || chip.lane !== l || !chip.correct;
    });
    if (!lane) return;
    const answer = chapter.chips.find(c => c.lane === lane && c.correct);
    if (answer) {
      setAttempted(true);
      place(answer.id, lane);
    }
  }, [chapter, placements, place]);

  const next = useCallback(() => {
    if (index + 1 >= CHAPTERS.length) {
      setPhase('finale');
    } else {
      goToChapter(index + 1);
    }
  }, [index, goToChapter]);

  // ── Cover ────────────────────────────────────────────────────────

  if (phase === 'cover') {
    return (
      <div className="h-full overflow-auto" style={{ background: '#171310' }}>
        <div className="relative">
          <div className="absolute inset-0">
            <FarmScene scene="sunrise-farm" className="w-full h-full" />
          </div>
          <div
            className="relative h-[300px] sm:h-[380px]"
            style={{ background: 'linear-gradient(to bottom, rgba(23,19,16,0) 35%, rgba(23,19,16,0.86) 82%, #171310 100%)' }}
          />
          {onExit && (
            <button
              onClick={onExit}
              className="absolute top-4 right-4 p-2 rounded-lg text-white/80 hover:text-white hover:bg-black/30 transition-colors"
              aria-label="Leave the story"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="max-w-2xl mx-auto px-6 -mt-24 relative pb-16">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
            <p className="text-xs font-bold uppercase tracking-[0.18em] mb-3" style={{ color: FARM.honey }}>
              6 short chapters · about 15 minutes
            </p>
            <h1 className="text-4xl sm:text-5xl font-black text-white leading-[1.05] tracking-tight mb-4">
              Sam sells 8 things.<br />Which one makes<br />the money?
            </h1>
            <p className="text-base leading-relaxed mb-8" style={{ color: '#C9BBA8' }}>
              Sam sells 8 things in 3 places. He has a year of sales on paper and no idea which of it
              makes money. Help him find out, and you will learn the 4 steps behind every chart you
              will ever build. They are the same 4 steps as Question Builder.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-8">
              {(['G', 'A', 'F', 'S'] as GAFSLane[]).map(lane => (
                <div
                  key={lane}
                  className="rounded-xl p-3 border"
                  style={{ background: `${LANE_COLOR[lane]}1A`, borderColor: `${LANE_COLOR[lane]}44` }}
                >
                  <span className="font-black text-xl" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
                  <p className="text-xs font-semibold text-white mt-0.5">{LANE_INFO[lane].name}</p>
                  <p className="text-[11px] mt-0.5 text-white/70">{LANE_INFO[lane].asks}</p>
                  <p className="text-[11px] mt-1" style={{ color: '#9A8770' }}>{LANE_INFO[lane].plain}</p>
                </div>
              ))}
            </div>

            <button
              onClick={() => goToChapter(0)}
              className="w-full py-4 rounded-xl font-bold text-lg text-white shadow-xl transition-transform hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-3"
              style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
            >
              <BookOpen className="w-5 h-5" />
              Start at chapter one
            </button>

            {furthest > 0 && (
              <button
                onClick={() => goToChapter(furthest)}
                className="w-full mt-3 py-3 rounded-xl font-semibold text-sm border transition-colors hover:bg-white/5"
                style={{ borderColor: '#3A302710', background: '#FFFFFF08', color: '#C9BBA8' }}
              >
                Or pick up where you left off — chapter {furthest + 1}, {CHAPTERS[furthest].title}
              </button>
            )}
          </motion.div>
        </div>
      </div>
    );
  }

  // ── Finale ───────────────────────────────────────────────────────

  if (phase === 'finale') {
    return (
      <div className="h-full overflow-auto" style={{ background: '#171310' }}>
        <div className="relative h-[240px]">
          <div className="absolute inset-0"><FarmScene scene="year-panorama" className="w-full h-full" /></div>
          <div
            className="relative h-full"
            style={{ background: 'linear-gradient(to bottom, rgba(23,19,16,0) 40%, rgba(23,19,16,0.9) 88%, #171310 100%)' }}
          />
        </div>

        <div className="max-w-2xl mx-auto px-6 -mt-16 relative pb-16">
          <p className="text-xs font-bold uppercase tracking-[0.18em] mb-3" style={{ color: FARM.honey }}>
            The end of the story
          </p>
          <h1 className="text-3xl sm:text-4xl font-black text-white leading-tight tracking-tight mb-4">
            Sam kept the box.
          </h1>
          <p className="text-base leading-relaxed mb-6" style={{ color: '#C9BBA8' }}>
            It is on a shelf in the barn now. He does not open it, because a question that used to take
            him a whole evening now takes about a minute.
          </p>
          <p className="text-base leading-relaxed mb-8" style={{ color: '#C9BBA8' }}>
            You got {firstTry.size} of {CHAPTERS.length} chapters right first time. More importantly,
            you now know the only 4 steps there are:
          </p>

          <div className="space-y-2.5 mb-8">
            {(['G', 'A', 'F', 'S'] as GAFSLane[]).map(lane => (
              <div
                key={lane}
                className="rounded-xl p-4 border flex gap-4 items-start"
                style={{ background: `${LANE_COLOR[lane]}14`, borderColor: `${LANE_COLOR[lane]}3A` }}
              >
                <span className="font-black text-2xl w-7 shrink-0" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
                <div>
                  <p className="text-sm font-bold text-white">{LANE_INFO[lane].name} — {LANE_INFO[lane].asks}</p>
                  <p className="text-xs mt-1" style={{ color: '#9A8770' }}>
                    {lane === 'G' && 'Chapter 1. One bar per product. Get this wrong and every number after it is answering a different question.'}
                    {lane === 'A' && 'Chapter 2. Add up money, not units. Potatoes win on units, honey wins on money.'}
                    {lane === 'F' && 'Chapters 3 and 5. Keep only some rows: winter months, or café orders.'}
                    {lane === 'S' && 'Chapters 4 and 6. Biggest first when ranking. Date order when the bars are months.'}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div
            className="rounded-2xl p-5 mb-8 border"
            style={{ background: `${FARM.honey}12`, borderColor: `${FARM.honey}33` }}
          >
            <p className="text-sm font-bold text-white mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4" style={{ color: FARM.honey }} />
              Now try it on your own data
            </p>
            <p className="text-xs leading-relaxed" style={{ color: '#C9BBA8' }}>
              Question Builder has these same 4 boxes, in this same order: split by, add up, filter,
              sort. That is the whole tool. You have just used it 6 times.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => { setIndex(0); resetChapter(); setFirstTry(new Set()); setPhase('cover'); }}
              className="flex-1 py-3 rounded-xl font-semibold text-sm border transition-colors hover:bg-white/5 flex items-center justify-center gap-2"
              style={{ borderColor: '#FFFFFF1A', background: '#FFFFFF08', color: '#C9BBA8' }}
            >
              <RotateCcw className="w-4 h-4" /> Read it again
            </button>
            {onNavigateToBuilder && (
              <button
                onClick={onNavigateToBuilder}
                className="flex-1 py-3 rounded-xl font-bold text-sm text-white transition-transform hover:scale-[1.01] flex items-center justify-center gap-2"
                style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
              >
                <Wheat className="w-4 h-4" /> Open Question Builder
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Chapter pages ────────────────────────────────────────────────

  return (
    <div className="h-full overflow-auto" style={{ background: '#171310' }}>
      {/* chapter rail */}
      <div
        className="sticky top-0 z-20 px-4 sm:px-6 py-3 flex items-center gap-4 backdrop-blur-md"
        style={{ background: 'rgba(23,19,16,0.88)', borderBottom: '1px solid #FFFFFF12' }}
      >
        <button
          onClick={() => (phase === 'story' && index === 0 ? setPhase('cover') : phase === 'story' ? goToChapter(index - 1) : setPhase('story'))}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-white/10"
          style={{ color: '#9A8770' }}
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>

        <div className="flex-1 flex items-center gap-1.5">
          {CHAPTERS.map((c, i) => (
            <button
              key={c.id}
              onClick={() => i <= furthest && goToChapter(i)}
              disabled={i > furthest}
              title={i <= furthest ? `Chapter ${c.id} — ${c.title}` : 'Not reached yet'}
              className="flex-1 h-1.5 rounded-full transition-all disabled:cursor-not-allowed"
              style={{
                background: i < index ? FARM.honey : i === index ? FARM.barn : '#FFFFFF1A',
                opacity: i > furthest ? 0.35 : 1,
              }}
            />
          ))}
        </div>

        <span className="text-xs font-semibold tabular-nums shrink-0" style={{ color: '#9A8770' }}>
          {index + 1} / {CHAPTERS.length}
        </span>
        {onExit && (
          <button
            onClick={onExit}
            className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
            style={{ color: '#9A8770' }}
            aria-label="Leave the story"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* the scene */}
      <div className="relative">
        <motion.div
          key={chapter.scene + phase}
          initial={{ opacity: 0, scale: 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6 }}
          className={`w-full overflow-hidden transition-all duration-500 ${phase === 'story' ? 'h-[320px] sm:h-[420px]' : 'h-[150px] sm:h-[180px]'}`}
        >
          <FarmScene
            scene={chapter.scene}
            beat={phase === 'story' ? beat : chapter.beats.length - 1}
            className="w-full h-full"
            anchor="ground"
          />
        </motion.div>
        {/* During the story the scene is the stage, so it only gets a thin blend
            at the bottom edge — Sam stands down there and must stay lit. In the
            puzzle and payoff phases it drops back to a dimmed decorative band. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: phase === 'story'
              ? 'linear-gradient(to bottom, rgba(23,19,16,0) 88%, #171310 100%)'
              : 'linear-gradient(to bottom, rgba(23,19,16,0.38) 0%, rgba(23,19,16,0.84) 48%, #171310 92%)',
          }}
        />
      </div>

      <div
        className={`max-w-3xl mx-auto px-4 sm:px-6 pb-20 relative ${phase === 'story' ? 'mt-5' : '-mt-10'}`}
      >
        {/* chapter heading */}
        <div className="mb-5">
          <div className="flex items-center gap-2.5 mb-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: FARM.honey }}>
              Chapter {chapter.id}
            </span>
            <span className="w-1 h-1 rounded-full" style={{ background: '#6B5A48' }} />
            <span className="text-xs font-semibold" style={{ color: '#9A8770' }}>{chapter.subtitle}</span>
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: `${FARM.leaf}22`, color: '#9FC98A' }}
            >
              Teaches: {chapter.teaches}
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">{chapter.title}</h1>
        </div>

        <AnimatePresence mode="wait">
          {/* ── narrative: one line at a time, never a wall of text ── */}
          {phase === 'story' && (
            <motion.div
              key="story"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            >
              <div className="min-h-[132px] flex items-start">
                <AnimatePresence mode="wait">
                  {beat < chapter.beats.length ? (
                    <motion.div
                      key={`beat-${beat}`}
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.28 }}
                      className="rounded-2xl px-6 py-5 w-full"
                      style={{ background: PAPER, color: INK }}
                    >
                      <p className="text-lg sm:text-xl leading-snug font-medium">{chapter.beats[beat]}</p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="quote"
                      initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
                      className="w-full flex items-start gap-3"
                    >
                      <div className="shrink-0 mt-1 rounded-full overflow-hidden" style={{ background: PAPER }}>
                        <SamAvatar size={52} />
                      </div>
                      <div className="relative flex-1 rounded-2xl px-6 py-5" style={{ background: PAPER, color: INK }}>
                        {/* speech tail, pointing back at Sam's face */}
                        <div
                          className="absolute top-5 -left-1.5 w-4 h-4 rotate-45"
                          style={{ background: PAPER }}
                        />
                        <p className="text-xl sm:text-2xl font-bold italic leading-snug relative">
                          “{chapter.quote}”
                        </p>
                        <footer className="text-xs mt-2 font-semibold relative" style={{ color: INK_FAINT }}>
                          — {FARMER.full}, {FARMER.farm}
                        </footer>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* beat progress */}
              <div className="flex items-center gap-1.5 mt-4 mb-3">
                {chapter.beats.map((_, i) => (
                  <span
                    key={i}
                    className="h-1 rounded-full transition-all duration-300"
                    style={{
                      width: i === beat ? 22 : 10,
                      background: i <= beat ? FARM.honey : '#FFFFFF24',
                    }}
                  />
                ))}
                <span
                  className="h-1 rounded-full transition-all duration-300"
                  style={{
                    width: beat >= chapter.beats.length ? 22 : 10,
                    background: beat >= chapter.beats.length ? FARM.barn : '#FFFFFF24',
                  }}
                />
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => setBeat(b => Math.max(0, b - 1))}
                  disabled={beat === 0}
                  className="px-5 py-3.5 rounded-xl font-semibold border transition-colors hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{ borderColor: '#FFFFFF1F', background: '#FFFFFF0A', color: '#C9BBA8' }}
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>

                {beat < chapter.beats.length ? (
                  <button
                    onClick={() => setBeat(b => b + 1)}
                    className="flex-1 py-3.5 rounded-xl font-bold text-white transition-transform hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2"
                    style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
                  >
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    onClick={() => setPhase('puzzle')}
                    className="flex-1 py-3.5 rounded-xl font-bold text-white transition-transform hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2.5"
                    style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
                  >
                    Help him work it out <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>

              {beat > 0 && beat < chapter.beats.length && (
                <button
                  onClick={() => setBeat(chapter.beats.length)}
                  className="w-full mt-2 py-2 text-xs font-semibold transition-colors hover:text-white"
                  style={{ color: '#6B5A48' }}
                >
                  Skip to the question
                </button>
              )}
            </motion.div>
          )}

          {/* ── puzzle ── */}
          {phase === 'puzzle' && (
            <motion.div
              key="puzzle"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="space-y-4"
            >
              <div className="rounded-2xl p-5 sm:p-6" style={{ background: PAPER, color: INK }}>
                <p className="text-base leading-relaxed">{chapter.task}</p>
              </div>

              {/* lanes */}
              <div className="space-y-2.5">
                {chapter.lanes.map(lane => {
                  const info = LANE_INFO[lane];
                  const placement = placements[lane];
                  const chip = chapter.chips.find(c => c.id === placement?.chipId);
                  const color = LANE_COLOR[lane];
                  const verdict = placement?.verdict;

                  return (
                    <div key={lane}>
                      <div
                        onClick={() => (selectedChip ? place(selectedChip, lane) : chip && clearLane(lane))}
                        onDragOver={e => { e.preventDefault(); setDragLane(lane); }}
                        onDragLeave={() => setDragLane(null)}
                        onDrop={e => {
                          e.preventDefault();
                          const id = e.dataTransfer.getData('chipId');
                          if (id) place(id, lane);
                        }}
                        className="rounded-xl px-4 py-3.5 border-2 flex items-center gap-4 cursor-pointer transition-all"
                        style={{
                          background: verdict === 'right' ? '#4E7C3E1F' : verdict === 'wrong' ? '#C0563E1A' : `${color}12`,
                          borderColor: verdict === 'right' ? '#4E7C3E' : verdict === 'wrong' ? FARM.barn
                            : dragLane === lane ? color : `${color}44`,
                        }}
                      >
                        <div className="w-28 sm:w-36 shrink-0">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-lg" style={{ color }}>{info.letter}</span>
                            <span className="text-sm font-bold text-white">{info.name}</span>
                          </div>
                          <p className="text-[11px] mt-0.5" style={{ color: '#9A8770' }}>{info.asks}</p>
                        </div>

                        <div className="flex-1 min-h-[38px] flex items-center">
                          {chip ? (
                            <span
                              className="px-3.5 py-2 rounded-lg text-sm font-semibold border"
                              style={{ background: `${color}26`, borderColor: `${color}66`, color: '#F5EDE0' }}
                            >
                              {chip.label}
                            </span>
                          ) : (
                            <span className="text-sm italic" style={{ color: '#6B5A48' }}>
                              {selectedChip ? 'Click here to drop it in' : 'Pick an answer below'}
                            </span>
                          )}
                        </div>

                        {verdict === 'right' && <Check className="w-5 h-5 shrink-0" style={{ color: '#7FB069' }} />}
                        {verdict === 'wrong' && <X className="w-5 h-5 shrink-0" style={{ color: FARM.barn }} />}
                      </div>

                      <AnimatePresence>
                        {verdict === 'wrong' && placement?.note && (
                          <motion.p
                            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                            className="text-xs leading-relaxed px-4 pt-2"
                            style={{ color: '#D9A08E' }}
                          >
                            {placement.note}
                          </motion.p>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>

              {/* chips */}
              <div className="rounded-xl p-4 border" style={{ background: '#FFFFFF06', borderColor: '#FFFFFF12' }}>
                <p className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: '#6B5A48' }}>
                  Pick an answer for each row above
                </p>
                <div className="flex flex-wrap gap-2">
                  {poolChips.map((c: StoryChip) => (
                    <motion.button
                      key={c.id}
                      layout
                      draggable
                      onDragStart={(e: any) => e.dataTransfer.setData('chipId', c.id)}
                      onClick={() => setSelectedChip(selectedChip === c.id ? null : c.id)}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      className="px-3.5 py-2.5 rounded-lg text-sm font-semibold border cursor-grab active:cursor-grabbing text-left"
                      style={
                        selectedChip === c.id
                          ? { background: `${FARM.honey}2E`, borderColor: FARM.honey, color: '#FFF3DC' }
                          : { background: '#FFFFFF0A', borderColor: '#FFFFFF1F', color: '#D9CDBB' }
                      }
                    >
                      {c.label}
                    </motion.button>
                  ))}
                  {poolChips.length === 0 && (
                    <p className="text-sm italic" style={{ color: '#6B5A48' }}>
                      Everything is placed. Check it when you are ready.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={nudge}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold border transition-colors hover:bg-white/5 flex items-center gap-2"
                  style={{ borderColor: `${FARM.honey}44`, color: FARM.honey, background: `${FARM.honey}10` }}
                >
                  <Lightbulb className="w-4 h-4" /> Show me one
                </button>
                <button
                  onClick={check}
                  disabled={!allFilled}
                  className="px-6 py-2.5 rounded-xl text-sm font-bold text-white transition-transform hover:scale-[1.02] disabled:opacity-30 disabled:hover:scale-100 disabled:cursor-not-allowed flex items-center gap-2"
                  style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
                >
                  <Check className="w-4 h-4" />
                  {checked && attempted ? 'Check again' : 'Check the answer'}
                </button>
              </div>
            </motion.div>
          )}

          {/* ── payoff ── */}
          {phase === 'payoff' && (
            <motion.div
              key="payoff"
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="space-y-4"
            >
              <div className="rounded-2xl p-6 sm:p-8" style={{ background: PAPER, color: INK }}>
                <p className="text-[11px] font-bold uppercase tracking-wider mb-4" style={{ color: INK_FAINT }}>
                  The answer
                </p>
                <Payoff chapter={chapter} />
              </div>

              <div className="rounded-2xl p-6" style={{ background: '#FFFFFF08', border: '1px solid #FFFFFF12' }}>
                {chapter.outcome.map((para, i) => (
                  <p key={i} className={`text-sm leading-relaxed ${i > 0 ? 'mt-3' : ''}`} style={{ color: '#C9BBA8' }}>
                    {para}
                  </p>
                ))}
              </div>

              <div className="rounded-2xl p-5 space-y-3" style={{ background: '#FFFFFF06', border: '1px solid #FFFFFF12' }}>
                <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: '#6B5A48' }}>
                  Why each step is right
                </p>
                {chapter.lanes.map(lane => (
                  <div key={lane} className="flex gap-3 text-sm">
                    <span className="font-black w-5 shrink-0" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
                    <p className="leading-relaxed" style={{ color: '#C9BBA8' }}>{chapter.explanation[lane]}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-2xl p-5" style={{ background: `${FARM.honey}12`, border: `1px solid ${FARM.honey}2E` }}>
                <p className="text-xs font-bold mb-1.5 flex items-center gap-2" style={{ color: FARM.honey }}>
                  <Wheat className="w-3.5 h-3.5" /> How to do this yourself
                </p>
                <p className="text-sm leading-relaxed" style={{ color: '#C9BBA8' }}>{chapter.builderBridge}</p>
              </div>

              <button
                onClick={next}
                className="w-full py-4 rounded-xl font-bold text-white transition-transform hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-2.5"
                style={{ background: `linear-gradient(90deg, ${FARM.barn}, ${FARM.amber})` }}
              >
                {index + 1 >= CHAPTERS.length ? 'Finish the story' : `Chapter ${chapter.id + 1} — ${CHAPTERS[index + 1].title}`}
                <ArrowRight className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default StoryMode;
