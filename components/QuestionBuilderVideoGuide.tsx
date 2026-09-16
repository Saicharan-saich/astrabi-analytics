import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { BookOpen, CirclePlay, Keyboard, X } from 'lucide-react';

const VIDEO_SRC = '/tutorials/question-builder-guide.webm';
const POSTER_SRC = '/tutorials/question-builder-guide-poster.svg';

export const QuestionBuilderVideoGuide: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', onKeyDown);
            triggerRef.current?.focus();
        };
    }, [isOpen]);

    const recoverRecordedVideoDuration = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) return;

        // Chromium MediaRecorder WebM files can omit a finite duration header.
        // Seeking once asks the browser to index the final cluster so native
        // controls show a usable duration and seek bar without re-encoding.
        const restoreStart = () => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            video.removeEventListener('durationchange', restoreStart);
            video.currentTime = 0;
        };
        video.addEventListener('durationchange', restoreStart);
        video.currentTime = Number.MAX_SAFE_INTEGER;
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setIsOpen(true)}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-extrabold text-indigo-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                aria-haspopup="dialog"
                aria-label="Watch how Question Builder works"
                title="Watch the narrated Question Builder walkthrough"
            >
                <CirclePlay className="h-4 w-4" aria-hidden="true" />
                Watch guide
            </button>

            {isOpen && ReactDOM.createPortal(
                <div
                    className="fixed inset-0 z-[10050] flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-sm sm:p-6"
                    role="presentation"
                    onMouseDown={event => {
                        if (event.target === event.currentTarget) setIsOpen(false);
                    }}
                >
                    <section
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="question-builder-video-title"
                        aria-describedby="question-builder-video-description"
                        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950 text-white shadow-2xl"
                    >
                        <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
                            <div>
                                <div className="mb-1 flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-indigo-300">
                                    <BookOpen className="h-4 w-4" aria-hidden="true" /> Guided walkthrough
                                </div>
                                <h2 id="question-builder-video-title" className="text-lg font-black sm:text-xl">
                                    Build a useful visual in about 70 seconds
                                </h2>
                                <p id="question-builder-video-description" className="mt-1 text-sm text-slate-300">
                                    Follow the visible cursor with narration and captions as a complete visual is built and pinned.
                                </p>
                            </div>
                            <button
                                ref={closeButtonRef}
                                type="button"
                                onClick={() => setIsOpen(false)}
                                className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
                                aria-label="Close Question Builder video"
                            >
                                <X className="h-5 w-5" aria-hidden="true" />
                            </button>
                        </header>

                        <div className="min-h-0 overflow-y-auto bg-slate-900 px-3 py-3 sm:px-6 sm:py-5">
                            <div className="overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">
                                <video
                                    className="aspect-video w-full bg-black"
                                    controls
                                    autoPlay
                                    playsInline
                                    preload="metadata"
                                    poster={POSTER_SRC}
                                    onLoadedMetadata={recoverRecordedVideoDuration}
                                    aria-label="Question Builder guided walkthrough video"
                                >
                                    <source src={VIDEO_SRC} type="video/webm" />
                                    <track
                                        kind="captions"
                                        src="/tutorials/question-builder-guide.vtt"
                                        srcLang="en"
                                        label="English"
                                        default
                                    />
                                    Your browser cannot play this video. Use the written steps below instead.
                                </video>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                    <div className="text-xs font-black text-indigo-300">1. Choose the calculation</div>
                                    <p className="mt-1 text-xs leading-relaxed text-slate-300">Select what to measure and how to aggregate it, such as Sum of sales.</p>
                                </div>
                                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                    <div className="text-xs font-black text-cyan-300">2. Shape the answer</div>
                                    <p className="mt-1 text-xs leading-relaxed text-slate-300">Add dimensions, filters, sorting and limits. Each choice updates the result.</p>
                                </div>
                                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                                    <div className="text-xs font-black text-emerald-300">3. Finish and share</div>
                                    <p className="mt-1 text-xs leading-relaxed text-slate-300">Switch visual type, enable labels, export the data or pin the result.</p>
                                </div>
                            </div>
                        </div>

                        <footer className="flex flex-col gap-2 border-t border-white/10 px-5 py-3 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                            <span className="inline-flex items-center gap-1.5"><Keyboard className="h-3.5 w-3.5" aria-hidden="true" /> Press Esc to close at any time.</span>
                            <span>The walkthrough uses example trade data; your available fields will match your dataset.</span>
                        </footer>
                    </section>
                </div>,
                document.body,
            )}
        </>
    );
};
