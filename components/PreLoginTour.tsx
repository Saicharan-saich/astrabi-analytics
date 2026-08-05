import React, { useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    BarChart2,
    Brain,
    Check,
    ChevronRight,
    Database,
    LockKeyhole,
    Sparkles,
    Upload,
} from 'lucide-react';

interface PreLoginTourProps {
    onComplete: () => void;
}

const TOUR_STEPS = [
    {
        eyebrow: 'Step 01 · Bring your data',
        title: 'From file to clarity in a few moments.',
        description: 'Drop in a spreadsheet or connect a data source. QuickInsight helps you see what is useful before you ask a single question.',
        icon: Upload,
        accent: 'from-cyan-400 to-indigo-500',
    },
    {
        eyebrow: 'Step 02 · Your data stays yours',
        title: 'Understand the structure without exposing the dataset.',
        description: 'QuickInsight creates a local semantic layer, so the analytical work happens next to your data—not inside a generic AI chat.',
        icon: LockKeyhole,
        accent: 'from-emerald-400 to-cyan-500',
    },
    {
        eyebrow: 'Step 03 · Ask naturally',
        title: 'Turn a business question into an answer you can trust.',
        description: 'Ask in plain English. The guided AI SQL experience plans, validates, and runs the final query locally with chart-ready results.',
        icon: Brain,
        accent: 'from-violet-400 to-fuchsia-500',
    },
    {
        eyebrow: 'Step 04 · Make it useful',
        title: 'Move from a number to a decision.',
        description: 'Explore calculations, refine the visual, and pin only the insights that matter to a shareable dashboard.',
        icon: BarChart2,
        accent: 'from-amber-300 to-rose-500',
    },
] as const;

const MiniChart: React.FC = () => (
    <div className="relative h-40 rounded-2xl border border-white/10 bg-slate-950/65 overflow-hidden">
        <div className="absolute inset-x-5 top-5 flex items-center justify-between text-[10px] text-slate-500">
            <span>Monthly sales</span>
            <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-emerald-300">+18.4%</span>
        </div>
        <div className="absolute inset-x-5 bottom-5 top-14 flex items-end gap-2">
            {[32, 45, 40, 62, 57, 76, 69, 92].map((height, index) => (
                <div
                    key={index}
                    className="flex-1 rounded-t-md bg-gradient-to-t from-indigo-600/85 to-cyan-300/90 shadow-[0_0_18px_rgba(99,102,241,0.22)]"
                    style={{ height: `${height}%` }}
                />
            ))}
        </div>
    </div>
);

const VisualStage: React.FC<{ step: number }> = ({ step }) => {
    if (step === 0) {
        return (
            <div className="relative rounded-[28px] border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-indigo-950/40">
                <div className="mb-5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span className="text-xs font-semibold text-slate-200">Dataset workspace</span>
                    </div>
                    <span className="rounded-full bg-indigo-400/10 px-2 py-1 text-[10px] text-indigo-200">Private by default</span>
                </div>
                <div className="rounded-2xl border border-dashed border-indigo-300/35 bg-indigo-500/[0.07] px-6 py-9 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 to-cyan-400 shadow-lg shadow-indigo-500/30">
                        <Upload className="h-5 w-5 text-white" />
                    </div>
                    <p className="text-sm font-bold text-white">Amazon Retail Sales.xlsx</p>
                    <p className="mt-1 text-[11px] text-slate-400">9,994 rows · 23 columns</p>
                    <div className="mx-auto mt-5 h-1.5 max-w-[180px] overflow-hidden rounded-full bg-white/10">
                        <div className="h-full w-[78%] rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500" />
                    </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                    {['Cleaned', 'Mapped', 'Ready'].map((label) => (
                        <div key={label} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-2 text-center">
                            <Check className="mx-auto h-3.5 w-3.5 text-emerald-300" />
                            <span className="mt-1 block text-[10px] text-slate-300">{label}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (step === 1) {
        return (
            <div className="relative rounded-[28px] border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-emerald-950/30">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-cyan-300" />
                        <span className="text-xs font-semibold text-slate-200">Semantic model</span>
                    </div>
                    <span className="text-[10px] text-emerald-300">Local processing</span>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.06] p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-200">Dimensions</p>
                        {['Order date', 'Region', 'Ship mode'].map((field) => (
                            <div key={field} className="mt-2 rounded-lg bg-slate-950/55 px-2.5 py-2 text-xs text-slate-200">{field}</div>
                        ))}
                    </div>
                    <div className="rounded-2xl border border-violet-300/15 bg-violet-400/[0.06] p-4">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-200">Measures</p>
                        {['Sales', 'Profit', 'Quantity'].map((field) => (
                            <div key={field} className="mt-2 rounded-lg bg-slate-950/55 px-2.5 py-2 text-xs text-slate-200">{field}</div>
                        ))}
                    </div>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] px-3 py-2.5 text-[11px] text-emerald-100">
                    <LockKeyhole className="h-3.5 w-3.5 text-emerald-300" />
                    Field names and safe metadata guide the experience.
                </div>
            </div>
        );
    }

    if (step === 2) {
        return (
            <div className="relative rounded-[28px] border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-violet-950/30">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Sparkles className="h-4 w-4 text-violet-300" />
                    AI SQL workspace
                </div>
                <div className="mt-5 rounded-2xl border border-violet-300/20 bg-violet-400/[0.07] p-4">
                    <p className="text-[10px] uppercase tracking-wider text-violet-200">Ask a question</p>
                    <p className="mt-2 text-sm font-semibold leading-relaxed text-white">“Which region has the highest profit margin?”</p>
                </div>
                <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400">
                    <span className="h-2 w-2 rounded-full bg-cyan-300" />
                    Plan validated · Query runs locally
                </div>
                <div className="mt-4">
                    <MiniChart />
                </div>
            </div>
        );
    }

    return (
        <div className="relative rounded-[28px] border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-amber-950/25">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <BarChart2 className="h-4 w-4 text-amber-300" />
                    Executive dashboard
                </div>
                <span className="rounded-md bg-amber-300/10 px-2 py-1 text-[10px] text-amber-200">Live insight</span>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-2">
                {[
                    ['Revenue', '£2.3M'],
                    ['Margin', '18.4%'],
                    ['Orders', '9,994'],
                ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/[0.08] bg-slate-950/55 p-3">
                        <p className="text-[10px] text-slate-500">{label}</p>
                        <p className="mt-1 text-sm font-extrabold text-white">{value}</p>
                    </div>
                ))}
            </div>
            <div className="mt-4">
                <MiniChart />
            </div>
            <div className="mt-4 flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2.5 text-[11px]">
                <span className="text-slate-400">Ready for your next decision</span>
                <span className="font-semibold text-cyan-300">Pinned to dashboard</span>
            </div>
        </div>
    );
};

export const PreLoginTour: React.FC<PreLoginTourProps> = ({ onComplete }) => {
    const [activeStep, setActiveStep] = useState(0);
    const step = TOUR_STEPS[activeStep];
    const Icon = step.icon;
    const isLastStep = activeStep === TOUR_STEPS.length - 1;

    const next = () => {
        if (isLastStep) {
            onComplete();
            return;
        }
        setActiveStep(current => current + 1);
    };

    return (
        <div className="min-h-screen overflow-hidden bg-[#080b14] text-white">
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -left-40 -top-32 h-[34rem] w-[34rem] rounded-full bg-indigo-600/20 blur-[120px]" />
                <div className="absolute -bottom-36 -right-24 h-[30rem] w-[30rem] rounded-full bg-cyan-500/15 blur-[120px]" />
                <div className="absolute inset-0 bg-dot-grid opacity-40" />
            </div>

            <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
                <div className="flex items-center gap-3">
                    <img src="/logo.jpg" alt="QuickInsight" className="h-10 w-10 rounded-xl object-cover ring-1 ring-white/15" />
                    <div>
                        <p className="text-sm font-extrabold tracking-tight">QuickInsight</p>
                        <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Data intelligence, privately</p>
                    </div>
                </div>
                <button onClick={onComplete} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white">
                    Skip tour
                </button>
            </header>

            <main className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-10 px-6 pb-10 pt-6 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16 lg:pb-20 lg:pt-14">
                <section className="max-w-xl">
                    <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-slate-300">
                        <span className={`flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br ${step.accent}`}>
                            <Icon className="h-3.5 w-3.5 text-white" />
                        </span>
                        A quick tour before you begin
                    </div>

                    <div key={activeStep} className="animate-fadeIn">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">{step.eyebrow}</p>
                        <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">{step.title}</h1>
                        <p className="mt-6 max-w-lg text-base leading-7 text-slate-300 sm:text-lg">{step.description}</p>
                    </div>

                    <div className="mt-8 grid gap-3 sm:grid-cols-2">
                        {[
                            ['Privacy-led', 'Work locally with your data'],
                            ['Built for people', 'No SQL knowledge required'],
                        ].map(([title, detail]) => (
                            <div key={title} className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3.5">
                                <Check className="mb-2 h-4 w-4 text-emerald-300" />
                                <p className="text-xs font-bold text-white">{title}</p>
                                <p className="mt-1 text-[11px] text-slate-400">{detail}</p>
                            </div>
                        ))}
                    </div>

                    <div className="mt-9 flex items-center gap-3">
                        <button
                            onClick={() => setActiveStep(current => Math.max(0, current - 1))}
                            disabled={activeStep === 0}
                            className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-slate-300 transition-colors hover:border-white/25 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label="Previous tour step"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                        <button
                            onClick={next}
                            className="btn-shimmer flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 px-5 text-sm font-bold shadow-lg shadow-indigo-500/25 transition-transform hover:scale-[1.02]"
                        >
                            {isLastStep ? 'Open QuickInsight' : 'Continue'}
                            {isLastStep ? <ChevronRight className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
                        </button>
                        <span className="ml-1 text-xs text-slate-500">{activeStep + 1} / {TOUR_STEPS.length}</span>
                    </div>

                    <div className="mt-6 flex gap-2" aria-label="Tour progress">
                        {TOUR_STEPS.map((tourStep, index) => (
                            <button
                                key={tourStep.eyebrow}
                                onClick={() => setActiveStep(index)}
                                className={`h-1.5 rounded-full transition-all ${index === activeStep ? 'w-9 bg-cyan-300' : 'w-4 bg-white/15 hover:bg-white/30'}`}
                                aria-label={`Go to step ${index + 1}`}
                            />
                        ))}
                    </div>
                </section>

                <section key={activeStep} className="relative mx-auto w-full max-w-xl animate-fadeIn">
                    <div className="absolute -inset-5 rounded-[36px] bg-gradient-to-br from-indigo-500/15 via-transparent to-cyan-400/15 blur-2xl" />
                    <VisualStage step={activeStep} />
                </section>
            </main>
        </div>
    );
};
