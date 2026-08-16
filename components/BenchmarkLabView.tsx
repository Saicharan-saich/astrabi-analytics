import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Beaker,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  Download,
  FileJson,
  Gauge,
  Loader2,
  PauseCircle,
  Play,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import type { Dataset } from '../types';
import { UserRole } from '../types';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';
import { useTheme } from './ThemeProvider';
import { runAISQLPipeline } from '../services/ai-sql';
import type { PrivacyMode } from '../services/ai-sql/privacyMode';
import { ensureDuckDBReady, executeSQLViaDuckDB, reloadIsolatedBenchmarkData, resetDuckDB } from '../services/duckdbEngine';
import {
  ALL_BENCHMARK_SUITES,
  BENCHMARK_SUITES,
  clearBenchmarkRun,
  getBenchmarkResumeIndex,
  loadBenchmarkRun,
  loadResearchBenchmarkDataset,
  runBenchmark,
  saveBenchmarkRun,
  type BenchmarkCaseResult,
  type BenchmarkCaseStatus,
  type BenchmarkRun,
  type BenchmarkSuiteId,
} from '../services/benchmark';

interface BenchmarkLabViewProps {
  activeDataset?: Dataset | null;
}

type LabView = 'overview' | 'results' | 'methodology';

const STATUS_LABELS: Record<BenchmarkCaseStatus, string> = {
  pass: 'Pass',
  wrong_result: 'Wrong result',
  withheld: 'Withheld',
  invalid_sql: 'Invalid SQL',
  llm_unavailable: 'LLM unavailable',
  execution_error: 'Execution error',
  fixture_error: 'Fixture error',
};

const STATUS_CLASSES: Record<BenchmarkCaseStatus, string> = {
  pass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  wrong_result: 'bg-rose-500/15 text-rose-400 border-rose-500/25',
  withheld: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  invalid_sql: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
  llm_unavailable: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  execution_error: 'bg-red-500/15 text-red-400 border-red-500/25',
  fixture_error: 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/25',
};

const SUITE_ACCENTS = {
  violet: {
    ring: 'border-violet-500/35',
    icon: 'bg-violet-500/15 text-violet-400',
    badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  },
  cyan: {
    ring: 'border-cyan-500/35',
    icon: 'bg-cyan-500/15 text-cyan-400',
    badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  },
  amber: {
    ring: 'border-amber-500/35',
    icon: 'bg-amber-500/15 text-amber-400',
    badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
} as const;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const milliseconds = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';

async function verifyBenchmarkInfrastructure(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('You are offline. Reconnect before starting the benchmark because model calls require the QuickInsight API.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API_BASE}/ready`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`QuickInsight API readiness check returned ${response.status}.`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('QuickInsight API readiness check timed out. Check the connection and try again.');
    }
    throw new Error(`QuickInsight API is currently unreachable. ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  await ensureDuckDBReady();
}

function downloadFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function runToCsv(run: BenchmarkRun): string {
  const headers = [
    'run_id', 'case_id', 'source_id', 'suite', 'question', 'benchmark_context', 'category', 'difficulty', 'status', 'passed',
    'valid_sql', 'safe_to_display', 'latency_ms', 'tokens', 'engine', 'strategy', 'model',
    'privacy_mode', 'confidence', 'repairs', 'failure_reason', 'gold_sql', 'candidate_sql',
  ];
  const rows = run.results.map(result => [
    run.id, result.caseId, result.sourceId, result.suiteId, result.question, result.context, result.category, result.difficulty,
    result.status, result.passed, result.validSql, result.safeToDisplay, result.pipelineLatencyMs,
    result.tokenUsage.total, result.engine, result.strategy, result.model, run.privacyMode || 'strict', result.confidence,
    result.repairAttempts, result.failureReason, result.goldSql, result.candidateSql,
  ]);
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

export function canAccessBenchmark(role?: UserRole): boolean {
  return role === UserRole.ADMIN;
}

const MetricCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: 'violet' | 'emerald' | 'cyan' | 'amber';
  isDark: boolean;
}> = ({ icon, label, value, detail, tone, isDark }) => {
  const tones = {
    violet: 'from-violet-500/15 to-indigo-500/5 text-violet-400 border-violet-500/20',
    emerald: 'from-emerald-500/15 to-teal-500/5 text-emerald-400 border-emerald-500/20',
    cyan: 'from-cyan-500/15 to-blue-500/5 text-cyan-400 border-cyan-500/20',
    amber: 'from-amber-500/15 to-orange-500/5 text-amber-400 border-amber-500/20',
  };
  return (
    <div className={`rounded-2xl border p-4 bg-gradient-to-br ${tones[tone]} ${isDark ? '' : 'shadow-sm'}`}>
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] opacity-80">{icon}{label}</div>
      <div className={`mt-2 text-2xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</div>
      <div className={`mt-1 text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{detail}</div>
    </div>
  );
};

export const BenchmarkLabView: React.FC<BenchmarkLabViewProps> = ({ activeDataset }) => {
  const { currentUser } = useAuthStore();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [activeView, setActiveView] = useState<LabView>('overview');
  const [selectedSuites, setSelectedSuites] = useState<Set<BenchmarkSuiteId>>(
    () => new Set(BENCHMARK_SUITES.map(suite => suite.id))
  );
  const [scope, setScope] = useState<'smoke' | 'full'>('smoke');
  const [benchmarkPrivacyMode, setBenchmarkPrivacyMode] = useState<PrivacyMode>('strict');
  const [confirmed, setConfirmed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, question: '' });
  const [latestRun, setLatestRun] = useState<BenchmarkRun | null>(() => loadBenchmarkRun());
  const [liveResults, setLiveResults] = useState<BenchmarkCaseResult[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | BenchmarkCaseStatus>('all');
  const [suiteFilter, setSuiteFilter] = useState<'all' | BenchmarkSuiteId>('all');
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  React.useEffect(() => () => {
    // A route change cannot abort an in-flight model request, but it prevents
    // another benchmark case from starting after the current one completes.
    cancelRef.current = true;
  }, []);

  const accessible = canAccessBenchmark(currentUser?.role);
  const selectedSuiteObjects = useMemo(
    () => ALL_BENCHMARK_SUITES.filter(suite => selectedSuites.has(suite.id)),
    [selectedSuites],
  );
  const selectedQuestionCount = selectedSuiteObjects.reduce(
    (total, suite) => total + (scope === 'full' ? suite.cases.length : Math.min(5, suite.cases.length)),
    0,
  );
  const displayedRun = latestRun;
  const latestResumeIndex = latestRun ? getBenchmarkResumeIndex(latestRun) : 0;
  const displayedResults = isRunning ? liveResults : (displayedRun?.results || []);
  const filteredResults = useMemo(() => displayedResults.filter(result =>
    (statusFilter === 'all' || result.status === statusFilter)
    && (suiteFilter === 'all' || result.suiteId === suiteFilter)
  ), [displayedResults, statusFilter, suiteFilter]);

  const panel = isDark ? 'bg-[#111722] border-white/[0.08]' : 'bg-white border-slate-200 shadow-sm';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-white' : 'text-slate-900';
  const softSurface = isDark ? 'bg-white/[0.035] border-white/[0.07]' : 'bg-slate-50 border-slate-200';

  const toggleSuite = (id: BenchmarkSuiteId) => {
    if (isRunning) return;
    setSelectedSuites(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setConfirmed(false);
  };

  const handleRun = async (resumeRun?: BenchmarkRun) => {
    const isResume = Boolean(resumeRun);
    if (!accessible || isRunning || (!isResume && (!confirmed || selectedSuiteObjects.length === 0))) return;
    // Freeze the configuration at the instant Start is pressed. React state may
    // re-render during a long run, but the benchmark manifest must never drift.
    const runSuites = resumeRun
      ? resumeRun.selectedSuiteIds
        .map(id => ALL_BENCHMARK_SUITES.find(suite => suite.id === id))
        .filter((suite): suite is (typeof ALL_BENCHMARK_SUITES)[number] => Boolean(suite))
      : [...selectedSuiteObjects];
    const runScope = resumeRun?.scope || scope;
    const runPrivacyMode = resumeRun?.privacyMode || benchmarkPrivacyMode;
    const plannedQuestions = runSuites.reduce(
      (total, suite) => total + (runScope === 'full' ? suite.cases.length : Math.min(5, suite.cases.length)),
      0,
    );
    cancelRef.current = false;
    setIsRunning(true);
    setRunError(null);
    const resumeIndex = resumeRun ? getBenchmarkResumeIndex(resumeRun) : 0;
    setLiveResults(resumeRun ? resumeRun.results.slice(0, resumeIndex) : []);
    setProgress({ completed: resumeIndex, total: plannedQuestions, question: '' });
    setActiveView('results');
    console.info(`[Benchmark] Starting ${runScope} run: ${runSuites.length} suite(s), ${plannedQuestions} planned question(s)`);

    let benchmarkTouchedDuckDB = false;
    try {
      setProgress({ completed: resumeIndex, total: plannedQuestions, question: 'Checking API and local DuckDB engine…' });
      await verifyBenchmarkInfrastructure();
      benchmarkTouchedDuckDB = true;
      const run = await runBenchmark(
        runSuites,
        {
          loadDataset: loadResearchBenchmarkDataset,
          reloadDataset: reloadIsolatedBenchmarkData,
          executeGoldSql: async (rows, sql, timeContext, relatedTables) => executeSQLViaDuckDB(rows, sql, timeContext, relatedTables),
          runPipeline: async (question, dataset) => runAISQLPipeline(
            question,
            dataset,
            undefined,
            undefined,
            undefined,
            true,
            { requestPurpose: 'benchmark', privacyModeOverride: runPrivacyMode },
          ),
        },
        {
          scope: runScope,
          privacyMode: runPrivacyMode,
          appVersion: (import.meta as any).env?.VITE_APP_VERSION || '3.0',
          shouldCancel: () => cancelRef.current,
          onCaseStart: (testCase, index, total) => {
            setProgress({ completed: index, total, question: testCase.question });
          },
          onCaseComplete: (result, index, total) => {
            setLiveResults(current => [...current, result]);
            setProgress({ completed: index + 1, total, question: result.question });
          },
          minimumCaseIntervalMs: 3250,
          // Tolerate one-off provider errors, then pause a sustained outage so
          // the rest of a long run is not mislabelled as local-only evidence.
          stopOnLlmUnavailable: false,
          maxConsecutiveLlmUnavailable: 3,
          resumeRun,
        },
      );
      console.info(`[Benchmark] Finished ${run.scope} run: ${run.metrics.completed}/${run.metrics.total} completed${run.cancelled ? ' (cancelled)' : ''}`);
      setLatestRun(run);
      saveBenchmarkRun(run);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      // Restore the user's active data table so running a benchmark can never
      // alter the next answer they ask in Question Builder or AI SQL.
      if (benchmarkTouchedDuckDB) {
        try {
          const currentDataset = useAppStore.getState().dataset || activeDataset;
          if (currentDataset?.rows?.length) await reloadIsolatedBenchmarkData(currentDataset.rows);
          else resetDuckDB();
        } catch (restoreError) {
          resetDuckDB();
          console.warn('[Benchmark] Active dataset restore failed:', restoreError);
        }
      } else {
        resetDuckDB();
      }
      setIsRunning(false);
      setConfirmed(false);
    }
  };

  const handleClear = () => {
    if (isRunning) return;
    clearBenchmarkRun();
    setLatestRun(null);
    setLiveResults([]);
    setExpandedCase(null);
  };

  if (!accessible) {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center">
        <div className={`max-w-lg w-full rounded-3xl border p-8 text-center ${panel}`}>
          <div className="mx-auto w-14 h-14 rounded-2xl bg-rose-500/12 text-rose-400 flex items-center justify-center">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className={`mt-5 text-xl font-black ${strong}`}>Admin access required</h1>
          <p className={`mt-2 text-sm ${muted}`}>Benchmark runs can consume model tokens and expose internal evaluation evidence, so this lab is restricted to administrators.</p>
        </div>
      </div>
    );
  }

  const metrics = displayedRun?.metrics;

  return (
    <div className={`h-full overflow-auto ${isDark ? 'bg-[#090d14]' : 'bg-[#f4f7fb]'}`}>
      <div className="max-w-[1500px] mx-auto px-4 md:px-7 py-6 space-y-5">
        <section className={`relative overflow-hidden rounded-3xl border ${panel}`}>
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-cyan-400 to-amber-400" />
          <div className="absolute -right-16 -top-20 w-72 h-72 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
          <div className="relative p-5 md:p-7 flex flex-col xl:flex-row xl:items-center gap-5 justify-between">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-violet-500/20 shrink-0">
                <Beaker className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className={`text-xl md:text-2xl font-black tracking-tight ${strong}`}>AI SQL Benchmark Lab</h1>
                  <span className="px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/20">Admin only</span>
                  <span className="px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Data runs locally</span>
                </div>
                <p className={`mt-2 max-w-3xl text-sm leading-6 ${muted}`}>
                  Run repeatable, execution-based evaluation against 150 product-regression questions or 400 official public development questions. Every candidate answer uses the production AI SQL pipeline; gold SQL and verification run in the same in-browser DuckDB engine.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(['overview', 'results', 'methodology'] as LabView[]).map(view => (
                <button key={view} onClick={() => setActiveView(view)} className={`px-3.5 py-2 rounded-xl text-xs font-bold capitalize border transition-all ${activeView === view ? 'bg-violet-600 text-white border-violet-500 shadow-md shadow-violet-500/20' : `${softSurface} ${muted} hover:text-violet-400`}`}>
                  {view}
                </button>
              ))}
            </div>
          </div>
        </section>

        {runError && (
          <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 flex items-start gap-3 text-rose-400">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div><div className="text-sm font-bold">Benchmark run stopped</div><div className="text-xs mt-1">{runError}</div></div>
          </div>
        )}

        {activeView === 'overview' && (
          <>
            <section>
              <div className="flex items-end justify-between gap-4 mb-3">
                <div><h2 className={`text-sm font-black ${strong}`}>Product regression suites</h2><p className={`text-[11px] mt-1 ${muted}`}>The existing 150-case synthetic compatibility baseline. Selected by default.</p></div>
                <span className={`text-[10px] font-black uppercase tracking-wider ${muted}`}>150 questions</span>
              </div>
              <div className="grid md:grid-cols-3 gap-4">
              {BENCHMARK_SUITES.map(suite => {
                const selected = selectedSuites.has(suite.id);
                const accent = SUITE_ACCENTS[suite.accent];
                return (
                  <button
                    type="button"
                    key={suite.id}
                    disabled={isRunning}
                    onClick={() => toggleSuite(suite.id)}
                    className={`text-left rounded-2xl border p-5 transition-all ${panel} ${selected ? `${accent.ring} ring-1 ring-inset ring-current/10` : 'opacity-70 hover:opacity-100'} disabled:cursor-not-allowed`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${accent.icon}`}>
                        {suite.id === 'bird-compatible' ? <Sparkles className="w-5 h-5" /> : suite.id === 'spider2-compatible' ? <Database className="w-5 h-5" /> : <BarChart3 className="w-5 h-5" />}
                      </div>
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${selected ? 'bg-violet-600 border-violet-500 text-white' : isDark ? 'border-white/20' : 'border-slate-300'}`}>
                        {selected && <Check className="w-3.5 h-3.5" />}
                      </div>
                    </div>
                    <h2 className={`mt-4 text-base font-black ${strong}`}>{suite.name}</h2>
                    <p className={`mt-2 text-xs leading-5 ${muted}`}>{suite.description}</p>
                    <div className="mt-4 flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-black ${accent.badge}`}>{suite.cases.length} questions</span>
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${softSurface} ${muted}`}>v{suite.version}</span>
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${softSurface} ${muted}`}>Frozen outputs</span>
                    </div>
                  </button>
                );
              })}
              </div>
            </section>

            <section>
              <div className="flex items-end justify-between gap-4 mb-3">
                <div><h2 className={`text-sm font-black ${strong}`}>Research evaluation</h2><p className={`text-[11px] mt-1 ${muted}`}>Original public development questions, official gold SQL, frozen outputs, and lazy-loaded source tables. Opt in deliberately.</p></div>
                <span className="text-[10px] font-black uppercase tracking-wider text-cyan-400">400 questions</span>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
              {ALL_BENCHMARK_SUITES.filter(suite => suite.evaluationClass === 'official-public-subset').map(suite => {
                const selected = selectedSuites.has(suite.id);
                const accent = SUITE_ACCENTS[suite.accent];
                return (
                  <button
                    type="button"
                    key={suite.id}
                    disabled={isRunning}
                    onClick={() => toggleSuite(suite.id)}
                    className={`text-left rounded-2xl border p-5 transition-all ${panel} ${selected ? `${accent.ring} ring-1 ring-inset ring-current/10` : 'opacity-70 hover:opacity-100'} disabled:cursor-not-allowed`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${accent.icon}`}><Database className="w-5 h-5" /></div>
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${selected ? 'bg-violet-600 border-violet-500 text-white' : isDark ? 'border-white/20' : 'border-slate-300'}`}>{selected && <Check className="w-3.5 h-3.5" />}</div>
                    </div>
                    <div className="mt-4 flex items-center gap-2 flex-wrap"><h2 className={`text-base font-black ${strong}`}>{suite.name}</h2><span className="px-2 py-0.5 rounded-md border border-cyan-500/25 bg-cyan-500/10 text-[9px] font-black uppercase tracking-wider text-cyan-400">Official-source subset</span></div>
                    <p className={`mt-2 text-xs leading-5 ${muted}`}>{suite.description}</p>
                    <div className="mt-4 flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-black ${accent.badge}`}>{suite.cases.length} questions</span>
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${softSurface} ${muted}`}>v{suite.version}</span>
                      <span className={`px-2 py-1 rounded-lg border text-[10px] font-bold ${softSurface} ${muted}`}>Public dev split</span>
                    </div>
                  </button>
                );
              })}
              </div>
            </section>

            <section className={`rounded-3xl border p-5 md:p-6 ${panel}`}>
              <div className="flex flex-col xl:flex-row xl:items-end gap-5 justify-between">
                <div className="space-y-4 flex-1">
                  <div>
                    <h2 className={`text-base font-black ${strong}`}>Run configuration</h2>
                    <p className={`text-xs mt-1 ${muted}`}>Runs are sequential to protect the shared local DuckDB session and produce reproducible evidence.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button disabled={isRunning} onClick={() => { setScope('smoke'); setConfirmed(false); }} className={`px-4 py-2.5 rounded-xl border text-xs font-bold transition-all ${scope === 'smoke' ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-400' : `${softSurface} ${muted}`}`}>
                      <Zap className="w-3.5 h-3.5 inline mr-1.5" />Smoke · 5 per suite
                    </button>
                    <button disabled={isRunning} onClick={() => { setScope('full'); setConfirmed(false); }} className={`px-4 py-2.5 rounded-xl border text-xs font-bold transition-all ${scope === 'full' ? 'bg-violet-500/15 border-violet-500/30 text-violet-400' : `${softSurface} ${muted}`}`}>
                      <Gauge className="w-3.5 h-3.5 inline mr-1.5" />Full · all selected questions
                    </button>
                  </div>
                  <div>
                    <div className={`text-[11px] font-black uppercase tracking-[0.14em] ${muted}`}>AI data access</div>
                    <div className="mt-2 grid sm:grid-cols-2 gap-2 max-w-2xl">
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => { setBenchmarkPrivacyMode('strict'); setConfirmed(false); }}
                        className={`text-left rounded-xl border p-3 transition-all disabled:cursor-not-allowed ${benchmarkPrivacyMode === 'strict' ? 'bg-emerald-500/12 border-emerald-500/35 ring-1 ring-emerald-500/15' : softSurface}`}
                      >
                        <span className={`flex items-center gap-2 text-xs font-black ${benchmarkPrivacyMode === 'strict' ? 'text-emerald-400' : strong}`}>
                          <ShieldCheck className="w-4 h-4" />Private
                        </span>
                        <span className={`block mt-1 text-[11px] leading-5 ${muted}`}>Metadata and governed analysis plan only. No fixture category values are sent.</span>
                      </button>
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => { setBenchmarkPrivacyMode('enhanced'); setConfirmed(false); }}
                        className={`text-left rounded-xl border p-3 transition-all disabled:cursor-not-allowed ${benchmarkPrivacyMode === 'enhanced' ? 'bg-cyan-500/12 border-cyan-500/35 ring-1 ring-cyan-500/15' : softSurface}`}
                      >
                        <span className={`flex items-center gap-2 text-xs font-black ${benchmarkPrivacyMode === 'enhanced' ? 'text-cyan-400' : strong}`}>
                          <Shield className="w-4 h-4" />Better answers
                        </span>
                        <span className={`block mt-1 text-[11px] leading-5 ${muted}`}>Also sends bounded, policy-screened category values from the selected benchmark fixtures. Never complete rows, IDs, or personal data.</span>
                      </button>
                    </div>
                  </div>
                  <label className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer ${softSurface}`}>
                    <input type="checkbox" checked={confirmed} disabled={isRunning || selectedQuestionCount === 0} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5 accent-violet-600" />
                    <span>
                      <span className={`block text-xs font-bold ${strong}`}>I understand this run will submit {selectedQuestionCount} isolated AI SQL questions.</span>
                      <span className={`block text-[11px] mt-1 ${muted}`}>This run uses <strong className={strong}>{benchmarkPrivacyMode === 'enhanced' ? 'Better answers' : 'Private'}</strong> mode for every case. Gold outputs and raw fixture rows are never sent to the model.</span>
                    </span>
                  </label>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 xl:justify-end">
                  <button
                    onClick={() => void handleRun()}
                    disabled={!confirmed || !selectedQuestionCount || isRunning}
                    className="px-5 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-sm font-black shadow-lg shadow-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all"
                  >
                    {isRunning ? <Loader2 className="w-4 h-4 inline mr-2 animate-spin" /> : <Play className="w-4 h-4 inline mr-2" />}
                    Run {selectedQuestionCount} questions
                  </button>
                  {latestRun && (
                    <button onClick={() => setActiveView('results')} className={`px-4 py-3 rounded-xl border text-sm font-bold ${softSurface} ${strong}`}>
                      View latest run <ChevronRight className="w-4 h-4 inline ml-1" />
                    </button>
                  )}
                </div>
              </div>
            </section>

            {latestRun && metrics && (
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div><h2 className={`text-base font-black ${strong}`}>Latest evidence</h2><p className={`text-xs ${muted}`}>{new Date(latestRun.startedAt).toLocaleString()} · {latestRun.methodologyLabel} · {latestRun.privacyMode === 'enhanced' ? 'Better answers' : 'Private'}</p></div>
                </div>
                <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
                  <MetricCard icon={<Gauge className="w-4 h-4" />} label="Execution accuracy" value={percent(metrics.executionAccuracy)} detail={`${metrics.passed}/${metrics.completed} correct outputs`} tone="violet" isDark={isDark} />
                  <MetricCard icon={<ShieldCheck className="w-4 h-4" />} label="Safe answer rate" value={percent(metrics.safeAnswerRate)} detail="Passed the display contract" tone="emerald" isDark={isDark} />
                  <MetricCard icon={<Clock3 className="w-4 h-4" />} label="P95 latency" value={milliseconds(metrics.p95LatencyMs)} detail={`Median ${milliseconds(metrics.medianLatencyMs)}`} tone="cyan" isDark={isDark} />
                  <MetricCard icon={<Sparkles className="w-4 h-4" />} label="Model tokens" value={metrics.totalTokens.toLocaleString()} detail={`${percent(metrics.llmBackedRate || 0)} LLM-backed · ${percent(metrics.validSqlRate)} valid SQL`} tone="amber" isDark={isDark} />
                </div>
              </section>
            )}
          </>
        )}

        {activeView === 'results' && (
          <section className="space-y-4">
            {isRunning && (
              <div className={`rounded-2xl border p-4 ${panel}`}>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className={`text-sm font-black ${strong}`}>Running case {Math.min(progress.completed + 1, progress.total)} of {progress.total}</div>
                    <div className={`text-xs mt-1 truncate ${muted}`}>{progress.question || 'Preparing benchmark fixtures…'}</div>
                  </div>
                  <button onClick={() => { cancelRef.current = true; }} className="shrink-0 px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs font-bold">
                    <PauseCircle className="w-4 h-4 inline mr-1.5" />Stop after this case
                  </button>
                </div>
                <div className={`mt-4 h-2 rounded-full overflow-hidden ${isDark ? 'bg-white/[0.06]' : 'bg-slate-100'}`}>
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-all duration-500" style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%` }} />
                </div>
              </div>
            )}

            {!isRunning && latestRun && (
              <>
              <div className={`rounded-2xl border px-4 py-3 flex flex-wrap items-center justify-between gap-2 ${latestRun.metrics.completed === latestRun.metrics.total ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10'}`}>
                <div className={`text-sm font-black ${latestRun.metrics.completed === latestRun.metrics.total ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {latestRun.methodologyLabel} · {latestRun.scope === 'full' ? 'Full run' : 'Smoke run'} · {latestRun.privacyMode === 'enhanced' ? 'Better answers' : 'Private'} · {latestRun.metrics.total} planned · {latestRun.metrics.completed} completed
                </div>
                <div className={`text-xs ${muted}`}>{latestRun.selectedSuiteIds.length} suite{latestRun.selectedSuiteIds.length === 1 ? '' : 's'} · {latestRun.cancelled ? 'Stopped by user' : latestRun.metrics.completed === latestRun.metrics.total ? 'Run complete' : 'Run incomplete'}</div>
              </div>
              <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <MetricCard icon={<Gauge className="w-4 h-4" />} label="Execution accuracy" value={percent(latestRun.metrics.executionAccuracy)} detail={`${latestRun.metrics.passed}/${latestRun.metrics.completed} correct outputs`} tone="violet" isDark={isDark} />
                <MetricCard icon={<ShieldCheck className="w-4 h-4" />} label="Safe answer rate" value={percent(latestRun.metrics.safeAnswerRate)} detail={`${percent(latestRun.metrics.validSqlRate)} valid SQL`} tone="emerald" isDark={isDark} />
                <MetricCard icon={<Clock3 className="w-4 h-4" />} label="P95 latency" value={milliseconds(latestRun.metrics.p95LatencyMs)} detail={`Median ${milliseconds(latestRun.metrics.medianLatencyMs)}`} tone="cyan" isDark={isDark} />
                <MetricCard icon={<Sparkles className="w-4 h-4" />} label="Model tokens" value={latestRun.metrics.totalTokens.toLocaleString()} detail={`${percent(latestRun.metrics.llmBackedRate || 0)} LLM-backed · confidence ${latestRun.metrics.averageConfidence.toFixed(0)}/100`} tone="amber" isDark={isDark} />
              </div>
              </>
            )}

            {!isRunning && latestRun && (latestRun.metrics.failuresByType.llm_unavailable || 0) > 0 && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div><strong>{latestRun.metrics.failuresByType.llm_unavailable} model-unavailable case(s) recorded.</strong> They remain visible as failures and are excluded from LLM-backed evidence.</div>
              </div>
            )}

            {!isRunning && latestRun && latestResumeIndex < latestRun.metrics.total && (
              <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-300 flex flex-wrap items-start gap-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-[260px]"><strong>Run paused to protect benchmark validity.</strong> {latestRun.interruptionReason || 'The previous run ended before every planned case received an LLM response.'} Resolve the provider issue, then resume without rerunning successful cases.</div>
                <button
                  type="button"
                  onClick={() => void handleRun(latestRun)}
                  className="px-3 py-2 rounded-xl border border-sky-400/30 bg-sky-400/10 text-sky-200 text-xs font-black hover:bg-sky-400/20"
                >
                  <Play className="w-3.5 h-3.5 inline mr-1.5" />Resume failed cases
                </button>
              </div>
            )}

            <div className={`rounded-2xl border overflow-hidden ${panel}`}>
              <div className="p-4 border-b border-inherit flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
                <div>
                  <h2 className={`text-sm font-black ${strong}`}>Case-level evidence</h2>
                  <p className={`text-[11px] mt-1 ${muted}`}>{displayedResults.length} completed · candidate SQL is compared with frozen gold output, not SQL text.</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <select value={suiteFilter} onChange={event => setSuiteFilter(event.target.value as 'all' | BenchmarkSuiteId)} className={`px-3 py-2 rounded-xl border text-xs font-bold outline-none ${softSurface} ${strong}`}>
                    <option value="all">All suites</option>
                    {ALL_BENCHMARK_SUITES.map(suite => <option key={suite.id} value={suite.id}>{suite.shortName}</option>)}
                  </select>
                  <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as 'all' | BenchmarkCaseStatus)} className={`px-3 py-2 rounded-xl border text-xs font-bold outline-none ${softSurface} ${strong}`}>
                    <option value="all">All outcomes</option>
                    {Object.entries(STATUS_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
                  </select>
                  {latestRun && !isRunning && (
                    <>
                      <button onClick={() => downloadFile(`${latestRun.id}.json`, JSON.stringify(latestRun, null, 2), 'application/json')} className={`px-3 py-2 rounded-xl border text-xs font-bold ${softSurface} ${strong}`} title="Export reproducible JSON evidence"><FileJson className="w-4 h-4 inline mr-1.5" />JSON</button>
                      <button onClick={() => downloadFile(`${latestRun.id}.csv`, runToCsv(latestRun), 'text/csv')} className={`px-3 py-2 rounded-xl border text-xs font-bold ${softSurface} ${strong}`} title="Export case-level CSV"><Download className="w-4 h-4 inline mr-1.5" />CSV</button>
                      <button onClick={handleClear} className="px-3 py-2 rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400 text-xs font-bold"><Trash2 className="w-4 h-4 inline mr-1.5" />Clear</button>
                    </>
                  )}
                </div>
              </div>

              {!displayedResults.length ? (
                <div className="p-12 text-center">
                  <div className={`mx-auto w-12 h-12 rounded-2xl flex items-center justify-center ${softSurface}`}><Beaker className={`w-6 h-6 ${muted}`} /></div>
                  <div className={`mt-4 text-sm font-bold ${strong}`}>No benchmark evidence yet</div>
                  <div className={`mt-1 text-xs ${muted}`}>Select suites on Overview, acknowledge the model calls, then start a smoke or full run.</div>
                  <button onClick={() => setActiveView('overview')} className="mt-4 px-4 py-2 rounded-xl bg-violet-600 text-white text-xs font-bold">Configure a run</button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1050px] text-left">
                    <thead className={isDark ? 'bg-white/[0.025]' : 'bg-slate-50'}>
                      <tr className={`text-[10px] uppercase tracking-wider ${muted}`}>
                        <th className="px-4 py-3 w-10" />
                        <th className="px-3 py-3">Case</th>
                        <th className="px-3 py-3">Question</th>
                        <th className="px-3 py-3">Outcome</th>
                        <th className="px-3 py-3">Engine / model</th>
                        <th className="px-3 py-3 text-right">Latency</th>
                        <th className="px-3 py-3 text-right">Tokens</th>
                        <th className="px-3 py-3 text-right">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredResults.map(result => {
                        const expanded = expandedCase === result.caseId;
                        return (
                          <React.Fragment key={result.caseId}>
                            <tr className={`border-t ${isDark ? 'border-white/[0.06] hover:bg-white/[0.025]' : 'border-slate-100 hover:bg-slate-50'}`}>
                              <td className="pl-4 py-3"><button onClick={() => setExpandedCase(expanded ? null : result.caseId)} className={`p-1 rounded-lg ${muted}`}>{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
                              <td className="px-3 py-3"><div className={`text-xs font-mono font-bold ${strong}`}>{result.caseId}</div><div className={`text-[10px] mt-1 ${muted}`}>{result.category} · {result.difficulty}</div><div className={`text-[9px] mt-1 font-mono ${muted}`}>{result.sourceId}</div></td>
                              <td className={`px-3 py-3 text-xs max-w-md ${strong}`}>{result.question}</td>
                              <td className="px-3 py-3">
                                <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-black ${STATUS_CLASSES[result.status]}`}>{result.passed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}{STATUS_LABELS[result.status]}</span>
                                {result.passed && (!result.safeToDisplay || !result.validSql) && <div className="mt-1 text-[9px] font-bold text-amber-400">{[!result.safeToDisplay && 'Safety warning', !result.validSql && 'SQL warning'].filter(Boolean).join(' · ')}</div>}
                              </td>
                              <td className="px-3 py-3"><div className={`text-[11px] font-bold ${strong}`}>{result.engine || result.strategy || '—'}</div><div className={`text-[10px] mt-1 ${muted}`}>{result.status === 'llm_unavailable' ? 'No LLM response' : (result.model || 'Deterministic/local')}</div></td>
                              <td className={`px-3 py-3 text-xs text-right font-mono ${strong}`}>{milliseconds(result.pipelineLatencyMs || result.latencyMs)}</td>
                              <td className={`px-3 py-3 text-xs text-right font-mono ${strong}`}>{result.tokenUsage.total.toLocaleString()}</td>
                              <td className={`px-3 py-3 text-xs text-right font-mono ${strong}`}>{typeof result.confidence === 'number' ? `${result.confidence}/100` : '—'}</td>
                            </tr>
                            {expanded && (
                              <tr className={`border-t ${isDark ? 'border-white/[0.05] bg-black/20' : 'border-slate-100 bg-slate-50/80'}`}>
                                <td colSpan={8} className="p-4 md:p-5">
                                  {result.failureReason && <div className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-400"><AlertTriangle className="w-4 h-4 inline mr-1.5" />{result.failureReason}</div>}
                                  {result.context && <div className={`mb-4 rounded-xl border p-3 text-xs leading-5 ${softSurface} ${strong}`}><span className={`block text-[10px] uppercase tracking-wider font-black mb-1 ${muted}`}>Official benchmark evidence</span>{result.context}</div>}
                                  <div className="grid xl:grid-cols-2 gap-4">
                                    <div>
                                      <div className={`text-[10px] uppercase tracking-wider font-black mb-2 ${muted}`}>Gold SQL</div>
                                      <pre className={`rounded-xl border p-3 text-[11px] leading-5 overflow-auto max-h-64 whitespace-pre-wrap ${softSurface} ${strong}`}>{result.goldSql}</pre>
                                    </div>
                                    <div>
                                      <div className={`text-[10px] uppercase tracking-wider font-black mb-2 ${muted}`}>Candidate SQL</div>
                                      <pre className={`rounded-xl border p-3 text-[11px] leading-5 overflow-auto max-h-64 whitespace-pre-wrap ${softSurface} ${strong}`}>{result.candidateSql || 'No candidate SQL was produced.'}</pre>
                                    </div>
                                    <div>
                                      <div className={`text-[10px] uppercase tracking-wider font-black mb-2 ${muted}`}>Frozen gold output</div>
                                      <pre className={`rounded-xl border p-3 text-[11px] leading-5 overflow-auto max-h-64 ${softSurface} ${strong}`}>{JSON.stringify(result.expectedRows, null, 2)}</pre>
                                    </div>
                                    <div>
                                      <div className={`text-[10px] uppercase tracking-wider font-black mb-2 ${muted}`}>Candidate output</div>
                                      <pre className={`rounded-xl border p-3 text-[11px] leading-5 overflow-auto max-h-64 ${softSurface} ${strong}`}>{JSON.stringify(result.actualRows, null, 2)}</pre>
                                    </div>
                                  </div>
                                  {result.comparison && <div className={`mt-3 text-[11px] ${muted}`}>Comparator: {result.comparison.reason} · mapped columns {JSON.stringify(result.comparison.columnMapping)} · safety {result.safeToDisplay ? 'passed' : 'warning'} · SQL validation {result.validSql ? 'passed' : 'warning'}</div>}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {activeView === 'methodology' && (
          <section className="grid xl:grid-cols-[1.25fr_0.75fr] gap-4">
            <div className={`rounded-3xl border p-5 md:p-7 ${panel}`}>
              <h2 className={`text-lg font-black ${strong}`}>What this score means</h2>
              <p className={`mt-2 text-sm leading-6 ${muted}`}>
                “Curated Subset Execution Accuracy” is the percentage of completed questions whose locally executed candidate result is equivalent to the frozen gold result. SQL text is deliberately not compared: two different read-only SQL queries may be equally correct.
              </p>
              <div className="mt-6 space-y-3">
                {[
                  ['1', 'Fixture integrity', 'Gold SQL is executed against the embedded dataset and must reproduce the frozen output before AI SQL is scored.'],
                  ['2', 'Production pipeline', 'The same runAISQLPipeline entry point used by the product receives one isolated question with cache bypass enabled and the run-scoped privacy mode selected by the administrator.'],
                  ['3', 'Local execution', 'Candidate SQL and gold SQL run inside DuckDB-WASM. Dataset rows are not submitted to the gold evaluator or model.'],
                  ['4', 'Value-set equivalence', 'Aliases, harmless column naming differences, row order, nulls, and numeric tolerance are normalized. Sorting never changes execution correctness.'],
                  ['5', 'Independent diagnostics', 'Matching values count as correct. Safety and SQL-validation warnings remain visible and continue to affect their own rates without overriding execution accuracy.'],
                ].map(([number, title, description]) => (
                  <div key={number} className={`rounded-2xl border p-4 flex gap-4 ${softSurface}`}>
                    <div className="w-8 h-8 rounded-xl bg-violet-500/15 text-violet-400 flex items-center justify-center font-black text-sm shrink-0">{number}</div>
                    <div><div className={`text-sm font-black ${strong}`}>{title}</div><div className={`text-xs leading-5 mt-1 ${muted}`}>{description}</div></div>
                  </div>
                ))}
              </div>
              <div className="mt-6 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-amber-400">
                <div className="text-sm font-black flex items-center gap-2"><AlertTriangle className="w-4 h-4" />Research reporting rule</div>
                <p className="text-xs leading-5 mt-1">Use the run's exact methodology label and report every suite separately with its version, app version, model route, date, privacy mode, completed count, and exported evidence. Public-development subsets are not full-set or official leaderboard scores.</p>
              </div>
            </div>
            <div className="space-y-4">
              {ALL_BENCHMARK_SUITES.map(suite => (
                <div key={suite.id} className={`rounded-2xl border p-5 ${panel}`}>
                  <div className="flex items-center justify-between gap-3"><h3 className={`text-sm font-black ${strong}`}>{suite.name}</h3><span className={`text-[10px] font-bold ${muted}`}>v{suite.version}</span></div>
                  <p className={`mt-2 text-xs leading-5 ${muted}`}>{suite.methodology}</p>
                  <a href={suite.attribution.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-violet-400 hover:text-violet-300">{suite.evaluationClass === 'official-public-subset' ? 'Public source' : 'Source inspiration'}: {suite.attribution.benchmark}<ChevronRight className="w-3.5 h-3.5" /></a>
                  <div className={`mt-3 pt-3 border-t text-[10px] leading-4 ${isDark ? 'border-white/[0.06] text-slate-500' : 'border-slate-100 text-slate-400'}`}>{suite.attribution.notice}</div>
                </div>
              ))}
              <div className={`rounded-2xl border p-5 ${panel}`}>
                <h3 className={`text-sm font-black ${strong}`}>Exported evidence includes</h3>
                <ul className={`mt-3 space-y-2 text-xs ${muted}`}>
                  {['Suite and fixture versions', 'Question, gold SQL, and candidate SQL', 'Frozen and candidate result previews', 'Outcome taxonomy and mismatch reason', 'Latency, tokens, model route, confidence, repairs', 'Run timestamp, scope, privacy mode, and cancellation state'].map(item => <li key={item} className="flex items-start gap-2"><Check className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" />{item}</li>)}
                </ul>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
