/**
 * OnboardingTour — step-by-step tooltip overlay for first-time users
 *
 * Shows 5 focused steps explaining key features. Auto-triggers on first visit
 * (checks localStorage). User can skip at any time.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface TourStep {
    title: string;
    description: string;
    target?: string; // CSS selector to highlight
    position: 'center' | 'bottom-right' | 'bottom-left' | 'top-right';
}

const TOUR_STEPS: TourStep[] = [
    {
        title: 'Welcome to QuickInsight',
        description: 'Your all-in-one analytics workbench. Upload data, ask questions, and get instant visual insights — no SQL required.',
        position: 'center',
    },
    {
        title: 'Upload Your Data',
        description: 'Start by uploading a CSV or Excel file, connecting to a SQL database, or using the built-in sample dataset.',
        position: 'center',
    },
    {
        title: 'Review Data Quality',
        description: 'The ETL tab shows how your data was automatically cleaned — headers normalized, dates standardized, nulls handled, and quality scored.',
        position: 'center',
    },
    {
        title: 'Dataset Time Anchor',
        description: 'The "As of" date acts as a time machine for your data. It defines what "today" means — so "yesterday", "last 7 days", and "MTD" all work correctly even with historical datasets. You can also choose which date column drives the anchor.',
        position: 'center',
    },
    {
        title: 'Ask Questions',
        description: 'Use the natural-language Question Builder to query your data. Select metrics, dimensions, filters, and time periods — results update instantly.',
        position: 'center',
    },
    {
        title: 'Pin & Customize',
        description: 'Save any analysis to your dashboard. Drag, resize, and rearrange cards. Export charts as PNG or style them with custom colors and labels.',
        position: 'center',
    },
];

const STORAGE_KEY = 'QuickInsight-onboarding-complete';

interface OnboardingTourProps {
    forceShow?: boolean;
    onComplete?: () => void;
}

export const OnboardingTour: React.FC<OnboardingTourProps> = ({ forceShow, onComplete }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [step, setStep] = useState(0);
    const mountRef = useRef(false);

    useEffect(() => {
        if (mountRef.current) return;
        mountRef.current = true;
        if (forceShow) { setIsVisible(true); return; }
        const done = localStorage.getItem(STORAGE_KEY);
        if (!done) setIsVisible(true);
    }, [forceShow]);

    const close = useCallback(() => {
        setIsVisible(false);
        localStorage.setItem(STORAGE_KEY, 'true');
        onComplete?.();
    }, [onComplete]);

    const next = () => {
        if (step < TOUR_STEPS.length - 1) setStep(s => s + 1);
        else close();
    };
    const prev = () => { if (step > 0) setStep(s => s - 1); };

    if (!isVisible) return null;

    const current = TOUR_STEPS[step];
    const isLast = step === TOUR_STEPS.length - 1;

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[200] flex items-center justify-center">
                {/* Backdrop */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    onClick={close}
                />

                {/* Tooltip Card */}
                <motion.div
                    key={step}
                    initial={{ opacity: 0, scale: 0.92, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -10 }}
                    transition={{ duration: 0.25 }}
                    className="relative z-10 w-full max-w-md mx-4"
                >
                    <div className="bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                        {/* Header gradient band */}
                        <div className="h-1.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />

                        <div className="p-6">
                            {/* Step indicator + close */}
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                                        <Sparkles className="w-4 h-4 text-white" />
                                    </div>
                                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                                        Step {step + 1} / {TOUR_STEPS.length}
                                    </span>
                                </div>
                                <button
                                    onClick={close}
                                    className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            <h3 className="text-lg font-bold text-white mb-2">{current.title}</h3>
                            <p className="text-slate-400 text-sm leading-relaxed mb-6">{current.description}</p>

                            {/* Progress dots */}
                            <div className="flex items-center justify-center gap-1.5 mb-5">
                                {TOUR_STEPS.map((_, i) => (
                                    <div
                                        key={i}
                                        className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-6 bg-indigo-500' : i < step ? 'w-1.5 bg-indigo-400' : 'w-1.5 bg-slate-700'}`}
                                    />
                                ))}
                            </div>

                            {/* Navigation */}
                            <div className="flex items-center justify-between">
                                <button
                                    onClick={close}
                                    className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    Skip tour
                                </button>
                                <div className="flex items-center gap-2">
                                    {step > 0 && (
                                        <button
                                            onClick={prev}
                                            className="flex items-center gap-1 px-4 py-2 text-sm font-medium text-slate-300 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-colors"
                                        >
                                            <ChevronLeft className="w-4 h-4" /> Back
                                        </button>
                                    )}
                                    <button
                                        onClick={next}
                                        className="flex items-center gap-1 px-5 py-2 text-sm font-bold text-white bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 rounded-lg shadow-lg shadow-indigo-500/20 transition-all"
                                    >
                                        {isLast ? 'Get Started' : 'Next'} <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
