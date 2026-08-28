import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    BrainCircuit,
    Check,
    Cpu,
    Database,
    GitBranch,
    KeyRound,
    Loader2,
    Lock,
    Power,
    RefreshCw,
    Save,
    ShieldCheck,
    Sparkles,
    WandSparkles,
} from 'lucide-react';
import { UserRole } from '../types';
import { useAuthStore } from '../store/useAuthStore';
import { useTheme } from './ThemeProvider';
import {
    AI_SQL_ENGINE_PRESETS,
    AI_SQL_ENGINE_IDS,
    fetchAISQLEngineConfig,
    getAISQLEngineConfig,
    saveAISQLEngineConfig,
    type AISQLEngineConfig,
    type AISQLEngineId,
} from '../services/ai-sql/engineConfig';

type EngineCard = {
    id: AISQLEngineId;
    name: string;
    description: string;
    group: 'Understanding' | 'Reasoning' | 'SQL quality' | 'Result quality';
};

const CONFIGURABLE_ENGINES: EngineCard[] = [
    { id: 'timeResolver', name: 'Time resolver', group: 'Understanding', description: 'Resolves this month, previous period, YTD and other relative dates against the dataset reporting date.' },
    { id: 'valueGrounding', name: 'Value grounding', group: 'Understanding', description: 'Maps user-typed literals to real fields and locally observed values without inventing or exposing values.' },
    { id: 'ambiguityResolver', name: 'Ambiguity resolver', group: 'Reasoning', description: 'Evaluates competing interpretations and records explicit assumptions when the question has more than one plausible meaning.' },
    { id: 'derivedMetricGuardrails', name: 'Derived metric guardrails', group: 'Reasoning', description: 'Checks ratios, margins, percentages and scoped calculations before SQL synthesis.' },
    { id: 'planVerification', name: 'Plan verifier', group: 'Reasoning', description: 'Checks whether the compact plan preserves the requested fields, filters, grain, ranking and comparison.' },
    { id: 'canonicalAudit', name: 'Canonical IR audit', group: 'Reasoning', description: 'Audits the shared analytical representation for missing or conflicting operators. It does not author SQL.' },
    { id: 'llmReviewer', name: 'Independent LLM reviewer', group: 'SQL quality', description: 'Uses a second model pass to review projection, grain, joins, ranking, scoped aggregates and table calculations.' },
    { id: 'contractRepair', name: 'Contract-guided SQL repair', group: 'SQL quality', description: 'Offers the model one focused repair when its read-only SQL conflicts with the requested answer contract.' },
    { id: 'sqlExecutionRepair', name: 'Execution repair', group: 'SQL quality', description: 'Retries fixable DuckDB syntax, identifier and type errors while preserving read-only safety.' },
    { id: 'semanticResultRepair', name: 'Semantic result repair', group: 'Result quality', description: 'Replans empty or clearly wrong-cardinality results using local execution evidence.' },
    { id: 'resultContractValidation', name: 'Result contract validation', group: 'Result quality', description: 'Checks returned fields, grain, cardinality and analytical invariants against the requested answer.' },
    { id: 'answerContractValidation', name: 'Answer contract validation', group: 'Result quality', description: 'Runs the final answer-shape and display-safety verification before presenting the result.' },
];

const CORE_ENGINES: Array<{ id: AISQLEngineId; name: string; icon: React.FC<any>; description: string; failClosed?: boolean }> = [
    { id: 'semanticLayer', name: 'Semantic layer', icon: BrainCircuit, description: 'When off, the LLM receives only physical column names/types; dependent local plan context is also withheld.' },
    { id: 'intentPlanner', name: 'Intent & GAFS plan', icon: GitBranch, description: 'When off, the local plan and analytical contract are withheld from the LLM for a true schema-only ablation.' },
    { id: 'relationshipGraph', name: 'Relationship graph', icon: Database, description: 'When off, table relationships, cardinality and join-path guidance are withheld from the LLM.' },
    { id: 'privacyGateway', name: 'Privacy gateway', icon: KeyRound, description: 'Turning this off pauses model calls; it never permits ungoverned row sharing.', failClosed: true },
    { id: 'llmSqlWriter', name: 'LLM plan & SQL writer', icon: Sparkles, description: 'Turning this off pauses AI SQL synthesis because the current architecture assigns SQL authorship to the LLM.', failClosed: true },
    { id: 'readOnlySafety', name: 'Read-only SQL safety', icon: ShieldCheck, description: 'Turning this off pauses execution; unsafe or write SQL is never allowed through.', failClosed: true },
    { id: 'duckdbExecution', name: 'Local DuckDB-WASM', icon: Cpu, description: 'Turning this off stops before local execution, allowing controlled pipeline-ablation checks.', failClosed: true },
];

const sameEngines = (left: Record<AISQLEngineId, boolean>, right: Record<AISQLEngineId, boolean>) =>
    AI_SQL_ENGINE_IDS.every(id => left[id] === right[id]);

export const AISQLEngineControlView: React.FC = () => {
    const { currentUser } = useAuthStore();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const [saved, setSaved] = useState<AISQLEngineConfig>(getAISQLEngineConfig());
    const [draft, setDraft] = useState<AISQLEngineConfig>(getAISQLEngineConfig());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        let mounted = true;
        setLoading(true);
        fetchAISQLEngineConfig().then(config => {
            if (!mounted) return;
            setSaved(config);
            setDraft(config);
            setLoading(false);
        });
        return () => { mounted = false; };
    }, []);

    const dirty = !sameEngines(saved.engines, draft.engines);
    const enabledCount = AI_SQL_ENGINE_IDS.filter(id => draft.engines[id]).length;
    const selectedPreset = useMemo(() => {
        if (sameEngines(draft.engines, AI_SQL_ENGINE_PRESETS.production)) return 'production';
        if (sameEngines(draft.engines, AI_SQL_ENGINE_PRESETS.llmLed)) return 'llmLed';
        return 'custom';
    }, [draft]);

    if (currentUser?.role !== UserRole.ADMIN) {
        return <div className="h-full flex items-center justify-center text-sm text-slate-400">Admin access required.</div>;
    }

    const applyPreset = (preset: 'production' | 'llmLed') => {
        setDraft(current => ({ ...current, engines: { ...AI_SQL_ENGINE_PRESETS[preset] } }));
        setNotice(null);
    };

    const toggleEngine = (id: AISQLEngineId) => {
        setDraft(current => ({
            ...current,
            engines: { ...current.engines, [id]: !current.engines[id] },
        }));
        setNotice(null);
    };

    const save = async () => {
        setSaving(true);
        setNotice(null);
        const result = await saveAISQLEngineConfig(draft);
        setSaving(false);
        if (!result.ok) {
            setNotice({ kind: 'error', text: result.error || 'Could not save the configuration.' });
            return;
        }
        setSaved(result.config);
        setDraft(result.config);
        setNotice({ kind: 'success', text: 'Global AI SQL configuration saved. New questions use it immediately.' });
    };

    const panel = isDark ? 'bg-[#121a2b] border-white/10' : 'bg-white border-slate-200';
    const muted = isDark ? 'text-slate-400' : 'text-slate-600';

    return (
        <div className={`h-full overflow-y-auto ${isDark ? 'bg-[#0b1220] text-white' : 'bg-slate-50 text-slate-900'}`}>
            <div className="mx-auto max-w-7xl px-5 py-6 lg:px-8 lg:py-8">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-violet-500">
                            <Lock className="h-3.5 w-3.5" /> Admin only
                        </div>
                        <h1 className="text-2xl font-black tracking-tight lg:text-3xl">AI SQL Engines</h1>
                        <p className={`mt-2 max-w-3xl text-sm leading-6 ${muted}`}>
                            Control every AI SQL stage for all users. Safety-critical stages fail closed: switching them off pauses the pipeline instead of bypassing protection.
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => { setDraft(saved); setNotice(null); }}
                            disabled={!dirty || saving}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-500/25 px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            <RefreshCw className="h-4 w-4" /> Undo changes
                        </button>
                        <button
                            type="button"
                            onClick={save}
                            disabled={!dirty || saving || loading}
                            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save globally
                        </button>
                    </div>
                </div>

                <div className={`mt-6 rounded-2xl border p-4 ${panel}`}>
                    <div className="flex flex-wrap items-center gap-3">
                        <span className={`text-xs font-bold uppercase tracking-wider ${muted}`}>Operating profile</span>
                        <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selectedPreset === 'production' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-500/20'}`}>
                            <input type="radio" checked={selectedPreset === 'production'} onChange={() => applyPreset('production')} />
                            <span><strong>Production</strong> <span className={muted}>— all accuracy stages on</span></span>
                        </label>
                        <label className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selectedPreset === 'llmLed' ? 'border-violet-500 bg-violet-500/10' : 'border-slate-500/20'}`}>
                            <input type="radio" checked={selectedPreset === 'llmLed'} onChange={() => applyPreset('llmLed')} />
                            <span><strong>LLM-led study</strong> <span className={muted}>— reduced deterministic intervention</span></span>
                        </label>
                        <label className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${selectedPreset === 'custom' ? 'border-amber-500 bg-amber-500/10' : 'border-slate-500/20'}`}>
                            <input type="radio" checked={selectedPreset === 'custom'} readOnly />
                            <span><strong>Custom</strong></span>
                        </label>
                        <span className="ml-auto rounded-full bg-slate-500/10 px-3 py-1.5 text-xs font-bold">{enabledCount}/{AI_SQL_ENGINE_IDS.length} stages on</span>
                    </div>
                </div>

                {(selectedPreset !== 'production' || notice) && (
                    <div className={`mt-4 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${notice?.kind === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' : notice?.kind === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-500' : 'border-amber-500/30 bg-amber-500/10 text-amber-500'}`}>
                        {notice?.kind === 'success' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                        <span>{notice?.text || 'A non-production profile can reduce answer correctness. Use it for controlled experiments or diagnosis, then restore Production.'}</span>
                    </div>
                )}

                <section className="mt-7">
                    <div className="mb-3 flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-black">Core stages</h2>
                            <p className={`mt-1 text-xs ${muted}`}>Admin-controlled. Safety-critical stages stop safely when disabled.</p>
                        </div>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-500"><ShieldCheck className="h-3.5 w-3.5" /> Fail closed</span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {CORE_ENGINES.map(engine => {
                            const enabled = draft.engines[engine.id];
                            return (
                            <button type="button" role="switch" aria-checked={enabled} onClick={() => toggleEngine(engine.id)} key={engine.name} className={`rounded-2xl border p-4 text-left transition ${panel} ${enabled ? 'ring-1 ring-emerald-500/20' : 'opacity-60'}`}>
                                <div className="flex items-center justify-between">
                                    <engine.icon className={`h-5 w-5 ${enabled ? 'text-emerald-500' : 'text-slate-500'}`} />
                                    <span className={`inline-flex h-6 w-11 items-center rounded-full p-0.5 transition ${enabled ? 'bg-emerald-500' : 'bg-slate-500/35'}`}>
                                        <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </span>
                                </div>
                                <h3 className="mt-3 flex items-center gap-2 text-sm font-black">{engine.name}<span className={`text-[10px] uppercase ${enabled ? 'text-emerald-500' : 'text-slate-500'}`}>{enabled ? 'On' : 'Off'}</span></h3>
                                <p className={`mt-1.5 text-xs leading-5 ${muted}`}>{engine.description}</p>
                                {engine.failClosed && <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-500"><Power className="h-3 w-3" /> Off pauses pipeline</span>}
                            </button>
                        );})}
                    </div>
                </section>

                <section className="mt-8 pb-10">
                    <div className="mb-3">
                        <h2 className="text-base font-black">Configurable stages</h2>
                        <p className={`mt-1 text-xs ${muted}`}>Changes apply globally to new AI SQL questions after you save.</p>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                        {(['Understanding', 'Reasoning', 'SQL quality', 'Result quality'] as const).map(group => (
                            <div key={group} className={`rounded-2xl border p-4 ${panel}`}>
                                <div className="mb-3 flex items-center gap-2">
                                    <WandSparkles className="h-4 w-4 text-violet-500" />
                                    <h3 className="text-sm font-black uppercase tracking-wider">{group}</h3>
                                </div>
                                <div className="space-y-2">
                                    {CONFIGURABLE_ENGINES.filter(engine => engine.group === group).map(engine => {
                                        const enabled = draft.engines[engine.id];
                                        return (
                                            <button
                                                key={engine.id}
                                                type="button"
                                                role="switch"
                                                aria-checked={enabled}
                                                onClick={() => toggleEngine(engine.id)}
                                                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${enabled ? 'border-violet-500/25 bg-violet-500/[0.07]' : 'border-slate-500/15 opacity-65 hover:opacity-90'}`}
                                            >
                                                <span className={`mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition ${enabled ? 'bg-violet-600' : 'bg-slate-500/35'}`}>
                                                    <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                                </span>
                                                <span className="min-w-0">
                                                    <span className="flex items-center gap-2 text-sm font-bold">
                                                        {engine.name}
                                                        <span className={`text-[10px] font-black uppercase ${enabled ? 'text-emerald-500' : 'text-slate-500'}`}>{enabled ? 'On' : 'Off'}</span>
                                                    </span>
                                                    <span className={`mt-1 block text-xs leading-5 ${muted}`}>{engine.description}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                    {(saved.updatedAt || saved.updatedBy) && (
                        <p className={`mt-4 text-right text-xs ${muted}`}>
                            Last saved{saved.updatedBy ? ` by ${saved.updatedBy}` : ''}{saved.updatedAt ? ` · ${new Date(saved.updatedAt).toLocaleString()}` : ''}
                        </p>
                    )}
                </section>
            </div>
        </div>
    );
};

export default AISQLEngineControlView;
