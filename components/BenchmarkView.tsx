import React, { useMemo, useState } from 'react';
import {
    Play, Loader2, CheckCircle2, XCircle, Download, ChevronDown, ChevronRight,
    Gauge, Timer, Coins, Database, AlertTriangle, Info, Upload, Trash2, Plus,
    LayoutDashboard, FlaskConical, History, ShieldCheck,
} from 'lucide-react';
import type { Dataset } from '../types';
import { BenchCase, Suite } from '../services/benchmark/spiderCases';
import { SUITES, casesForSuite, builtinCount, suiteMeta } from '../services/benchmark/registry';
import {
    runBenchmark, summarize, resultsToCSV, CaseResult, BenchmarkSummary, BenchmarkProgress,
} from '../services/benchmark/benchmarkRunner';
import { useBenchmarkStore, BenchmarkRun } from '../store/useBenchmarkStore';
import { runToMarkdown, runToJSON } from '../services/benchmark/report';

const ENGINE = 'QuickInsight (Gemini)';
type Nav = Suite | 'dashboard';

const DIFF_COLOR: Record<string, string> = {
    easy: 'text-emerald-600 dark:text-emerald-400',
    medium: 'text-sky-600 dark:text-sky-400',
    hard: 'text-amber-600 dark:text-amber-400',
    extra: 'text-rose-600 dark:text-rose-400',
};

const p1 = (n: number) => `${Math.round(n * 100)}%`;

function download(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
}

// ── Small building blocks ────────────────────────────────────────────

const StatCard: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string }> = ({ icon, label, value, sub }) => (
    <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs font-semibold uppercase tracking-wide">{icon}{label}</div>
        <div className="mt-1.5 text-2xl font-extrabold text-gray-900 dark:text-white">{value}</div>
        {sub && <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{sub}</div>}
    </div>
);

const Bar: React.FC<{ label: string; passed: number; total: number }> = ({ label, passed, total }) => {
    const ratio = total ? passed / total : 0;
    return (
        <div className="flex items-center gap-3 text-sm">
            <div className="w-32 shrink-0 text-gray-600 dark:text-gray-300 truncate">{label}</div>
            <div className="flex-1 h-2.5 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden">
                <div className={`h-full rounded-full ${ratio >= 0.7 ? 'bg-emerald-500' : ratio >= 0.4 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            <div className="w-16 shrink-0 text-right tabular-nums text-gray-700 dark:text-gray-200">{total ? `${passed}/${total}` : '—'}</div>
        </div>
    );
};

const CaseRow: React.FC<{ r: CaseResult }> = ({ r }) => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <tr className="border-t border-gray-100 dark:border-white/[0.06] hover:bg-gray-50 dark:hover:bg-white/[0.03] cursor-pointer" onClick={() => setOpen(o => !o)}>
                <td className="py-2 pl-2 pr-1 w-6 text-gray-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                <td className="py-2 pr-3">{r.match ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-rose-500" />}</td>
                <td className="py-2 pr-3 text-gray-800 dark:text-gray-100">{r.question}</td>
                <td className={`py-2 pr-3 font-semibold ${DIFF_COLOR[r.difficulty]}`}>{r.difficulty}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-gray-500 dark:text-gray-400">{r.match ? '—' : r.failCategory}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500 dark:text-gray-400">{r.latencyMs}ms</td>
                <td className="py-2 pr-3 text-right tabular-nums text-gray-500 dark:text-gray-400">{r.tokens.toLocaleString()}</td>
            </tr>
            {open && (
                <tr className="bg-gray-50/60 dark:bg-white/[0.02]">
                    <td />
                    <td colSpan={6} className="px-3 py-3">
                        <div className="grid gap-3 md:grid-cols-2">
                            <div><div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Gold SQL</div><pre className="text-xs whitespace-pre-wrap rounded-lg bg-gray-900 text-gray-100 p-2.5 overflow-x-auto">{r.goldSQL}</pre></div>
                            <div><div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Generated SQL</div><pre className="text-xs whitespace-pre-wrap rounded-lg bg-gray-900 text-gray-100 p-2.5 overflow-x-auto">{r.predictedSQL || '— (no SQL produced)'}</pre></div>
                            <div><div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Expected ({r.expectedRows} rows)</div><pre className="text-xs whitespace-pre-wrap rounded-lg bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] p-2.5 overflow-x-auto text-gray-700 dark:text-gray-200">{JSON.stringify(r.expectedSample)}</pre></div>
                            <div><div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Actual ({r.actualRows} rows)</div><pre className="text-xs whitespace-pre-wrap rounded-lg bg-white dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.08] p-2.5 overflow-x-auto text-gray-700 dark:text-gray-200">{JSON.stringify(r.actualSample)}</pre></div>
                        </div>
                        <div className={`mt-2 text-xs flex items-center gap-1.5 ${r.error ? 'text-rose-600 dark:text-rose-400' : 'text-gray-500 dark:text-gray-400'}`}>
                            {r.error && <AlertTriangle className="w-3.5 h-3.5" />}
                            <span className="font-semibold">{r.error ? 'Error:' : r.match ? 'Verdict:' : `${r.failCategory}:`}</span> {r.error || r.failDetail || r.reason}
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
};

const ResultsBlock: React.FC<{ results: CaseResult[]; summary: BenchmarkSummary }> = ({ results, summary: s }) => (
    <>
        <div className="mt-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <StatCard icon={<Gauge className="w-3.5 h-3.5" />} label="Accuracy" value={p1(s.accuracy)} sub={`${s.passed}/${s.total} passed`} />
            <StatCard icon={<ShieldCheck className="w-3.5 h-3.5" />} label="Exec success" value={p1(s.executionSuccess)} sub={`repair ${p1(s.repairRate)}`} />
            <StatCard icon={<Timer className="w-3.5 h-3.5" />} label="Avg latency" value={`${s.avgLatencyMs}ms`} sub={`conf ${s.avgConfidence}/100`} />
            <StatCard icon={<Coins className="w-3.5 h-3.5" />} label="Avg tokens" value={s.avgTokens.toLocaleString()} sub={`${s.totalTokens.toLocaleString()} total`} />
        </div>
        <div className="mt-5 grid gap-5 md:grid-cols-3">
            <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-gray-400 mb-3"><Database className="w-3.5 h-3.5" /> By table class</div>
                <div className="space-y-2.5">{s.byTableClass.map(b => <Bar key={b.label} {...b} />)}</div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">By difficulty</div>
                <div className="space-y-2.5">{s.byDifficulty.map(b => <Bar key={b.label} {...b} />)}</div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">Error taxonomy</div>
                {s.failureBreakdown.length === 0
                    ? <div className="text-sm text-gray-400">No failures 🎉</div>
                    : <div className="space-y-1.5">{s.failureBreakdown.map(f => (
                        <div key={f.category} className="flex items-center justify-between text-sm">
                            <span className="text-gray-600 dark:text-gray-300">{f.label}</span>
                            <span className="tabular-nums font-semibold text-rose-600 dark:text-rose-400">{f.count}</span>
                        </div>))}</div>}
            </div>
        </div>
        <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/[0.08] overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 dark:bg-white/[0.03] text-[11px] uppercase tracking-wide text-gray-400">
                    <tr><th /><th className="py-2 pr-3 text-left font-bold">OK</th><th className="py-2 pr-3 text-left font-bold">Question</th><th className="py-2 pr-3 text-left font-bold">Diff</th><th className="py-2 pr-3 text-left font-bold">Failure</th><th className="py-2 pr-3 text-right font-bold">Latency</th><th className="py-2 pr-3 text-right font-bold">Tokens</th></tr>
                </thead>
                <tbody>{results.map(r => <CaseRow key={r.id} r={r} />)}</tbody>
            </table>
        </div>
    </>
);

// ── Main Lab ─────────────────────────────────────────────────────────

export const BenchmarkView: React.FC<{ dataset?: Dataset | null }> = ({ dataset }) => {
    const [nav, setNav] = useState<Nav>('spider');
    const [loaded, setLoaded] = useState<Record<string, BenchCase[]>>({});
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
    const [results, setResults] = useState<CaseResult[] | null>(null);
    const [importMsg, setImportMsg] = useState('');
    // Credit guard: cap how many questions actually run (0 = all). Random sample
    // avoids only ever hitting the first/easiest cases.
    const [limit, setLimit] = useState(10);
    const [randomSample, setRandomSample] = useState(false);
    // User-benchmark authoring
    const [userCases, setUserCases] = useState<{ question: string; goldSQL: string }[]>([]);
    const [uq, setUq] = useState(''); const [ug, setUg] = useState('');

    const { runs, addRun, deleteRun, clearRuns } = useBenchmarkStore();

    const activeSuite = nav !== 'dashboard' ? nav : null;

    const cases = useMemo<BenchCase[]>(() => {
        if (!activeSuite) return [];
        if (activeSuite === 'user') {
            if (!dataset) return [];
            const table = { name: 'user_data', rows: dataset.rows };
            return userCases.map((u, i) => ({
                id: `user-${i}`, suite: 'user' as Suite, db: dataset.name,
                question: u.question, goldSQL: u.goldSQL, difficulty: 'medium' as const,
                tableCount: 1, tables: [table], primaryTable: 'user_data', tags: ['user'],
            }));
        }
        return casesForSuite(activeSuite, loaded);
    }, [activeSuite, loaded, userCases, dataset]);

    // Apply the credit guard: 0/blank = all, else first N (or a random N).
    const casesToRun = useMemo<BenchCase[]>(() => {
        const n = Number.isFinite(limit) && limit > 0 ? limit : cases.length;
        if (n >= cases.length) return cases;
        if (!randomSample) return cases.slice(0, n);
        const shuffled = [...cases];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, n);
    }, [cases, limit, randomSample]);

    const summary = useMemo(() => results ? summarize(results) : null, [results]);

    const runActive = async () => {
        if (!activeSuite || casesToRun.length === 0) return;
        setRunning(true); setResults(null);
        setProgress({ done: 0, total: casesToRun.length, current: 'Starting…' });
        try {
            const res = await runBenchmark(casesToRun, p => setProgress(p));
            setResults(res);
            const s = summarize(res);
            const sampledNote = casesToRun.length < cases.length
                ? `Ran ${casesToRun.length}/${cases.length} cases (${randomSample ? 'random sample' : 'first N'})`
                : undefined;
            const run: BenchmarkRun = {
                id: `run_${Date.now()}`, timestamp: Date.now(), engine: ENGINE,
                suites: [activeSuite], usedOfficial: !!loaded[activeSuite]?.length,
                results: res, summary: s, note: sampledNote,
            };
            addRun(run);
        } catch (e) {
            console.error('[Benchmark] run failed:', e);
            setResults([]);
        } finally {
            setRunning(false); setProgress(null);
        }
    };

    const importOfficial = (suite: Suite, file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result));
                if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Expected a non-empty JSON array of cases');
                // Minimal shape check.
                for (const c of parsed.slice(0, 3)) {
                    if (!c.question || !c.goldSQL || !Array.isArray(c.tables)) throw new Error('Each case needs question, goldSQL, tables[]');
                }
                const withSuite = parsed.map((c: any, i: number) => ({ ...c, suite, id: c.id || `${suite}-official-${i}` }));
                setLoaded(prev => ({ ...prev, [suite]: withSuite }));
                setImportMsg(`Loaded ${withSuite.length} official ${suiteMeta(suite)?.name} cases`);
            } catch (e: any) {
                setImportMsg(`Import failed: ${e.message}`);
            }
            setTimeout(() => setImportMsg(''), 5000);
        };
        reader.readAsText(file);
    };

    // ── Nav tree ─────────────────────────────────────────────
    const NavButton: React.FC<{ id: Nav; label: string; icon: React.ReactNode; badge?: string }> = ({ id, label, icon, badge }) => (
        <button
            onClick={() => { setNav(id); setResults(null); }}
            disabled={running}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${nav === id
                ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.05]'} disabled:opacity-50`}
        >
            {icon}<span className="flex-1 text-left">{label}</span>
            {badge && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-white/[0.08] text-gray-500">{badge}</span>}
        </button>
    );

    return (
        <div className="h-full flex overflow-hidden">
            {/* Left tree */}
            <aside className="w-60 shrink-0 border-r border-gray-200 dark:border-white/[0.08] p-3 overflow-y-auto">
                <div className="flex items-center gap-2 px-2 mb-3">
                    <FlaskConical className="w-5 h-5 text-indigo-500" />
                    <span className="font-extrabold text-gray-900 dark:text-white">Benchmark Lab</span>
                </div>
                <div className="space-y-0.5">
                    {SUITES.map(su => (
                        <NavButton
                            key={su.id} id={su.id} label={su.name}
                            icon={<Database className="w-4 h-4" />}
                            badge={su.id === 'user' ? String(userCases.length || '') : String(builtinCount(su.id) + (loaded[su.id]?.length ? 0 : 0) || (loaded[su.id]?.length ?? ''))}
                        />
                    ))}
                    <div className="my-2 h-px bg-gray-200 dark:bg-white/[0.08]" />
                    <NavButton id="dashboard" label="Results Dashboard" icon={<LayoutDashboard className="w-4 h-4" />} badge={String(runs.length || '')} />
                </div>
            </aside>

            {/* Main */}
            <main className="flex-1 overflow-y-auto px-6 py-6">
                {nav === 'dashboard'
                    ? <DashboardPanel runs={runs} onDelete={deleteRun} onClear={clearRuns} />
                    : activeSuite && (
                        <SuitePanel
                            suite={activeSuite}
                            cases={cases}
                            runCount={casesToRun.length}
                            limit={limit} setLimit={setLimit}
                            randomSample={randomSample} setRandomSample={setRandomSample}
                            hasDataset={!!dataset}
                            running={running}
                            progress={progress}
                            results={results}
                            summary={summary}
                            importMsg={importMsg}
                            onRun={runActive}
                            onImport={importOfficial}
                            // user authoring
                            userCases={userCases} uq={uq} ug={ug} setUq={setUq} setUg={setUg}
                            addUserCase={() => { if (uq.trim() && ug.trim()) { setUserCases(c => [...c, { question: uq.trim(), goldSQL: ug.trim() }]); setUq(''); setUg(''); } }}
                            removeUserCase={(i: number) => setUserCases(c => c.filter((_, j) => j !== i))}
                        />
                    )}
            </main>
        </div>
    );
};

// ── Suite panel ──────────────────────────────────────────────────────

const SuitePanel: React.FC<any> = ({
    suite, cases, runCount, limit, setLimit, randomSample, setRandomSample,
    hasDataset, running, progress, results, summary, importMsg, onRun, onImport,
    userCases, uq, ug, setUq, setUg, addUserCase, removeUserCase,
}) => {
    const meta = suiteMeta(suite)!;
    const single = cases.filter((c: BenchCase) => c.tableCount === 1).length;

    return (
        <div className="max-w-5xl">
            <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">{meta.name}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{meta.blurb}</p>
            <p className="text-xs text-gray-400 mt-0.5">Reference: {meta.reference}</p>

            {/* Provenance banner */}
            <div className="mt-4 rounded-xl border border-indigo-200 dark:border-indigo-500/20 bg-indigo-50/60 dark:bg-indigo-500/[0.06] p-3.5 text-sm text-indigo-900 dark:text-indigo-200 flex gap-2.5">
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                    Evaluation is <strong>execution-based</strong>: gold SQL and generated SQL are each run and their <strong>results</strong> compared (never the SQL text). Multi-table cases are denormalized into one master table first — the app's real path.
                    {meta.kind === 'builtin' && <> These <strong>{cases.length}</strong> cases are <strong>representative</strong> (built-in), not the official split — {meta.officialImportable ? 'import the official dev set below for publishable numbers.' : 'for internal measurement.'}</>}
                </div>
            </div>

            {/* User benchmark authoring */}
            {suite === 'user' && (
                <div className="mt-5 rounded-xl border border-gray-200 dark:border-white/[0.08] p-4">
                    <div className="text-sm font-bold text-gray-800 dark:text-gray-100 mb-2">Add a case against your dataset</div>
                    {!hasDataset
                        ? <div className="text-sm text-amber-600 dark:text-amber-400">Upload a dataset first — user cases run against your active dataset (table name <code>user_data</code>).</div>
                        : <>
                            <input value={uq} onChange={e => setUq(e.target.value)} placeholder="Question (natural language)" className="w-full mb-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.03] text-sm" />
                            <textarea value={ug} onChange={e => setUg(e.target.value)} placeholder="Gold SQL — reference the table as user_data, e.g. SELECT COUNT(*) FROM user_data WHERE ..." rows={2} className="w-full mb-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.03] text-sm font-mono" />
                            <button onClick={addUserCase} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-indigo-500 hover:bg-indigo-400"><Plus className="w-4 h-4" /> Add case</button>
                            {userCases.length > 0 && (
                                <ul className="mt-3 space-y-1">
                                    {userCases.map((u: any, i: number) => (
                                        <li key={i} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                                            <span className="flex-1 truncate">{u.question}</span>
                                            <button onClick={() => removeUserCase(i)} className="text-rose-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>}
                </div>
            )}

            {/* Controls */}
            <div className="mt-5 flex items-center gap-3 flex-wrap">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                    {cases.length} case{cases.length === 1 ? '' : 's'} · {single} single-table · {cases.length - single} multi-table
                </span>
                <div className="flex-1" />

                {/* Credit guard: how many questions to actually run */}
                <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <span className="whitespace-nowrap">Max questions</span>
                    <input
                        type="number" min={0} max={cases.length} step={1}
                        value={limit}
                        onChange={e => setLimit(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        disabled={running}
                        title="How many questions to run this pass. 0 = all. Each question is a live LLM call."
                        className="w-20 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.03] text-sm tabular-nums"
                    />
                </label>
                <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 select-none" title="Sample randomly instead of always taking the first N (avoids only testing the easiest cases).">
                    <input type="checkbox" checked={randomSample} onChange={e => setRandomSample(e.target.checked)} disabled={running} className="rounded border-gray-300 text-indigo-500 focus:ring-indigo-500" />
                    random
                </label>

                {meta.officialImportable && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05] cursor-pointer">
                        <Upload className="w-4 h-4" /> Import official (JSON)
                        <input type="file" accept="application/json,.json" className="hidden" onChange={e => e.target.files?.[0] && onImport(suite, e.target.files[0])} />
                    </label>
                )}
                <button onClick={onRun} disabled={running || runCount === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-b from-indigo-500 to-indigo-600 hover:from-indigo-400 hover:to-indigo-500 shadow-lg shadow-indigo-500/25 disabled:opacity-60 disabled:cursor-not-allowed">
                    {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    {running ? 'Running…' : `Run ${runCount}`}
                </button>
            </div>
            <div className="mt-1.5 text-xs text-gray-400">
                {runCount < cases.length
                    ? <>Will run <strong>{runCount}</strong> of {cases.length} questions this pass{randomSample ? ' (random sample)' : ' (first N)'} — {cases.length - runCount} skipped to save credits.</>
                    : <>Will run all {cases.length} questions — set “Max questions” to cap live LLM calls.</>}
            </div>
            {importMsg && <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{importMsg}</div>}

            {/* Progress */}
            {running && progress && (
                <div className="mt-5">
                    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1.5">
                        <span className="truncate pr-3">{progress.current}</span>
                        <span className="tabular-nums">{progress.done}/{progress.total}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100 dark:bg-white/[0.06] overflow-hidden">
                        <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                    </div>
                    <p className="text-xs text-gray-400 mt-2">Each case makes a live LLM call + DuckDB execution — this can take a minute.</p>
                </div>
            )}

            {results && summary && !running && <ResultsBlock results={results} summary={summary} />}
            {!results && !running && <div className="mt-10 text-center text-gray-400"><Gauge className="w-10 h-10 mx-auto mb-3 opacity-40" /><p className="text-sm">Press <strong>Run</strong> to benchmark this suite. Results are saved to the dashboard.</p></div>}
        </div>
    );
};

// ── Dashboard panel ──────────────────────────────────────────────────

const DashboardPanel: React.FC<{ runs: BenchmarkRun[]; onDelete: (id: string) => void; onClear: () => void }> = ({ runs, onDelete, onClear }) => {
    const [expanded, setExpanded] = useState<string | null>(runs[0]?.id ?? null);
    if (runs.length === 0) {
        return <div className="max-w-4xl"><h1 className="text-2xl font-extrabold text-gray-900 dark:text-white flex items-center gap-2"><LayoutDashboard className="w-6 h-6 text-indigo-500" /> Results Dashboard</h1>
            <div className="mt-10 text-center text-gray-400"><History className="w-10 h-10 mx-auto mb-3 opacity-40" /><p className="text-sm">No runs yet. Run a suite and its report will appear here.</p></div></div>;
    }

    // Accuracy-over-time sparkline (latest N runs, chronological).
    const chrono = [...runs].reverse();
    const acc = chrono.map(r => r.summary.accuracy);
    const w = 320, h = 48, max = 1;
    const pts = acc.map((a, i) => `${(i / Math.max(1, acc.length - 1)) * w},${h - (a / max) * h}`).join(' ');

    return (
        <div className="max-w-5xl">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white flex items-center gap-2"><LayoutDashboard className="w-6 h-6 text-indigo-500" /> Results Dashboard</h1>
                <button onClick={onClear} className="text-xs text-rose-500 hover:text-rose-400 font-semibold">Clear history</button>
            </div>

            <div className="mt-5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-white/[0.03] p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-2">Accuracy over runs (regression view)</div>
                <svg width={w} height={h} className="overflow-visible">
                    <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth={2} />
                    {acc.map((a, i) => <circle key={i} cx={(i / Math.max(1, acc.length - 1)) * w} cy={h - (a / max) * h} r={2.5} fill="#6366f1" />)}
                </svg>
                <div className="text-xs text-gray-400 mt-1">{chrono.length} run(s) · latest {p1(acc[acc.length - 1])}</div>
            </div>

            <div className="mt-5 space-y-3">
                {runs.map(run => (
                    <div key={run.id} className="rounded-xl border border-gray-200 dark:border-white/[0.08]">
                        <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setExpanded(e => e === run.id ? null : run.id)}>
                            {expanded === run.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                            <div className="flex-1">
                                <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{run.suites.join(', ')} · {p1(run.summary.accuracy)} accuracy</div>
                                <div className="text-xs text-gray-400">{new Date(run.timestamp).toLocaleString()} · {run.engine} · {run.summary.total} cases {run.usedOfficial ? '· official' : '· representative'}</div>
                            </div>
                            <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{run.summary.avgLatencyMs}ms · {run.summary.avgTokens} tok</span>
                        </div>
                        {expanded === run.id && (
                            <div className="px-4 pb-4 border-t border-gray-100 dark:border-white/[0.06]">
                                <div className="flex flex-wrap gap-2 my-3">
                                    <button onClick={() => download(`benchmark-${run.id}.md`, runToMarkdown(run), 'text/markdown')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05]"><Download className="w-3.5 h-3.5" /> Report (Markdown)</button>
                                    <button onClick={() => download(`benchmark-${run.id}.csv`, resultsToCSV(run.results), 'text/csv')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05]"><Download className="w-3.5 h-3.5" /> CSV</button>
                                    <button onClick={() => download(`benchmark-${run.id}.json`, runToJSON(run), 'application/json')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/[0.1] hover:bg-gray-50 dark:hover:bg-white/[0.05]"><Download className="w-3.5 h-3.5" /> JSON</button>
                                    <div className="flex-1" />
                                    <button onClick={() => onDelete(run.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
                                </div>
                                <ResultsBlock results={run.results} summary={run.summary} />
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default BenchmarkView;
