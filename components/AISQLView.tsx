import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle, ArrowUp, Check, Code, Copy, CornerDownRight, History, Link2, Loader2, Lock, Maximize2,
    MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pin, RotateCcw, ShieldCheck, Sparkles, Square, Trash2,
} from 'lucide-react';
import { DataKindNote } from './DataKindNote';
import type { AnalysisResult, Dataset, FormattingConfig } from '../types';
import type { AISQLPipelineResult } from '../services/ai-sql';
import { runLeanAISQL, rerunSavedAnswer, AISQLClarificationError, AISQLChatReplyError, AISQLOverviewRequest } from '../services/ai-sql/leanPipeline';
import { explainAnswer } from '../services/ai-sql/explainAnswer';
import { buildDatasetOverview } from '../services/ai-sql/datasetOverview';
import { chatWithAI, type ChatHistoryItem } from '../services/ai-sql/chatReply';
import {
    classifyTurn, contextForFollowUp, estimateTokens, formatContextForPrompt, suggestFollowUps,
} from '../services/ai-sql/chatContext';
import {
    answeredTurns, chatStorageKey, loadConversations, newConversation, newId, saveConversations, titleFrom, whenLabel,
    type ChatAnswer, type ChatTurn, type Conversation,
} from '../services/ai-sql/chatStore';
import { isDimensionOnlyResult } from '../services/ai-sql/resultPresentation';
import { presentLeanAnswer } from '../utils/aiSqlAnswerPresentation';
import { checkAnswer } from '../services/answerCheck/answerCheck';
import { describeDatasetShape } from '../services/datasetShape';
import { executeSQLViaDuckDB } from '../services/duckdbEngine';
import { AnswerCheckStrip } from './AnswerCheckStrip';
import { seriesName } from '../utils/seriesName';
import { ChartVisualization } from './ChartVisualization';
import { ExtremesTable } from './ExtremesTable';
import { checkAiSqlLimit, formatResetTime } from '../services/aiSqlRateLimiter';
import { useAuthStore } from '../store/useAuthStore';
import { buildQuestionExamples } from '../services/ai-sql/scopeIntent';

interface AISQLViewProps {
    dataset: Dataset | null;
    onPin?: (title: string, result: AnalysisResult) => void;
    initialQuery?: string | null;
    onViewFullPage?: (result: AnalysisResult, pipelineResult: AISQLPipelineResult, query: string, formatting: FormattingConfig) => void;
    onOpenDatasetOverview?: () => void;
    onOpenAllRecords?: () => void;
    onOpenSummaryStory?: (question: string) => void;
}

const MEMORY_KEY = 'QuickInsight-ai-sql-memory';
const MEMORY_OPTIONS = [
    { value: 0, label: 'Off', hint: 'Every question is sent on its own' },
    { value: 1, label: 'Last answer', hint: 'Follow-ups include the last question and its SQL' },
    { value: 2, label: 'Last 2 answers', hint: 'Follow-ups include the last 2 questions and their SQL' },
    { value: 3, label: 'Last 3 answers', hint: 'Follow-ups include the last 3 questions and their SQL' },
];
const readMemory = () => {
    try {
        const value = Number(localStorage.getItem(MEMORY_KEY));
        return Number.isInteger(value) && value >= 0 && value <= 3 && localStorage.getItem(MEMORY_KEY) !== null ? value : 1;
    } catch { return 1; }
};

const CURRENCY_OF_FORMAT: Record<string, string> = { currency_gbp: 'GBP', currency_eur: 'EUR', currency_usd: 'USD' };

/** Where a message goes: conversation (words), analysis (a query), or the local overview. */
type Route = 'chat' | 'analysis' | 'summary' | 'explain';

const formatTokens = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** Where a run that is in flight writes its result (or is told to stop). */
interface ActiveRun { turnId: string; conversationId: string; cancelled: boolean }

export const AISQLView: React.FC<AISQLViewProps> = ({ dataset, onPin, initialQuery, onViewFullPage, onOpenSummaryStory }) => {
    const currentUser = useAuthStore(s => s.currentUser);
    const incrementAiSqlUsage = useAuthStore(s => s.incrementAiSqlUsage);
    const limitStatus = checkAiSqlLimit(currentUser);

    const datasetKey = dataset?.name || dataset?.id || '';
    const storageKey = chatStorageKey(currentUser?.id, datasetKey);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeId, setActiveId] = useState<string>('');
    const [draft, setDraft] = useState('');
    const [modeOverride, setModeOverride] = useState<Route | null>(null);
    const [memory, setMemory] = useState<number>(readMemory);
    const [listOpen, setListOpen] = useState<boolean>(() => typeof window === 'undefined' || window.innerWidth >= 1100);
    const [openSql, setOpenSql] = useState<Record<string, boolean>>({});
    const [copied, setCopied] = useState<string | null>(null);
    const [opening, setOpening] = useState<string | null>(null);
    /** Answers whose figures are being worked out a second time. */
    const [checking, setChecking] = useState<Record<string, boolean>>({});
    const activeRun = useRef<ActiveRun | null>(null);
    const pipelines = useRef(new Map<string, AISQLPipelineResult>());
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const threadRef = useRef<HTMLDivElement>(null);
    const loadedKey = useRef<string>('');

    // ── Load and save this dataset's chats ──
    useEffect(() => {
        if (!datasetKey) return;
        const loaded = loadConversations(storageKey);
        loadedKey.current = storageKey;
        const fresh = newConversation();
        setConversations([fresh, ...loaded]);
        setActiveId(fresh.id);
        pipelines.current.clear();
    }, [storageKey, datasetKey]);
    useEffect(() => {
        if (loadedKey.current === storageKey && datasetKey) saveConversations(storageKey, conversations);
    }, [conversations, storageKey, datasetKey]);
    useEffect(() => { try { localStorage.setItem(MEMORY_KEY, String(memory)); } catch { /* per-visit only */ } }, [memory]);
    // The chat list is a side panel on wide screens and an overlay on narrow
    // ones: close it when the window becomes narrow.
    useEffect(() => {
        let wide = window.innerWidth >= 1100;
        const onResize = () => {
            const nowWide = window.innerWidth >= 1100;
            if (wide && !nowWide) setListOpen(false);
            wide = nowWide;
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const active = conversations.find(conversation => conversation.id === activeId);
    const busy = Boolean(active?.turns.some(turn => turn.status === 'pending'));
    const answered = useMemo(() => answeredTurns(active), [active]);
    const examples = useMemo(() => dataset ? buildQuestionExamples(dataset) : [], [dataset]);

    const updateConversation = useCallback((id: string, change: (conversation: Conversation) => Conversation) => {
        setConversations(list => list.map(conversation => conversation.id === id ? change(conversation) : conversation));
    }, []);
    const updateTurn = useCallback((conversationId: string, turnId: string, change: Partial<ChatTurn>) => {
        updateConversation(conversationId, conversation => ({
            ...conversation,
            updatedAt: Date.now(),
            turns: conversation.turns.map(turn => turn.id === turnId ? { ...turn, ...change } : turn),
        }));
    }, [updateConversation]);

    /**
     * The answer check: every figure worked out again from the cleaned rows by
     * a separate calculator, after the answer is drawn (never delays it).
     * Without the query's rows (an answer reopened from history) the query is
     * run again locally first.
     */
    const runAnswerCheck = useCallback((conversationId: string, turnId: string, sql: string, rows?: Record<string, any>[]) => {
        if (!dataset?.rows?.length || !sql) return;
        setChecking(state => ({ ...state, [turnId]: true }));
        window.setTimeout(async () => {
            try {
                let queryRows = rows;
                if (!queryRows) {
                    const tc = dataset.timeContext;
                    const executed = await executeSQLViaDuckDB(dataset.rows, sql, tc ? { minDate: tc.minDate, maxDate: tc.maxDate, primaryDateColumn: tc.anchorDateColumn } : undefined, dataset.relatedTables);
                    if (executed.error) return;
                    queryRows = executed.data;
                }
                const check = checkAnswer({ sql, rows: queryRows, data: dataset.rows, recordWord: describeDatasetShape(dataset).recordWord });
                updateConversation(conversationId, conversation => ({
                    ...conversation,
                    turns: conversation.turns.map(turn => turn.id === turnId && turn.answer ? { ...turn, answer: { ...turn.answer, check } } : turn),
                }));
            } catch (err) {
                console.warn('[answer-check] could not run', err);
            } finally {
                setChecking(state => { const next = { ...state }; delete next[turnId]; return next; });
            }
        }, 60);
    }, [dataset, updateConversation]);

    // Keep the newest message in view.
    const turnCount = active?.turns.length || 0;
    const lastProgress = active?.turns[turnCount - 1]?.progress;
    useEffect(() => {
        const thread = threadRef.current;
        if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
    }, [turnCount, lastProgress, activeId]);

    // ── Where the next message goes (shown live in the composer) ──
    // conversation → the AI replies in words · analysis → the AI writes a query
    // (and decides itself whether it builds on the last answer) · overview →
    // worked out on this computer. The user can switch before sending.
    const detected = useMemo(() => classifyTurn(draft, answered.length > 0, dataset), [draft, answered.length, dataset]);
    const detectedRoute: Route = detected.kind === 'chat' ? 'chat' : detected.kind === 'summary' ? 'summary' : detected.kind === 'explain' ? 'explain' : 'analysis';
    const sendRoute: Route = modeOverride || detectedRoute;
    const pendingContext = sendRoute === 'analysis' ? contextForFollowUp(answered, memory) : [];
    useEffect(() => { if (!draft.trim()) setModeOverride(null); }, [draft]);

    /** The overview of the whole dataset, worked out here: no AI, nothing sent. */
    const overviewAnswer = useCallback((): ChatAnswer | null => {
        if (!dataset) return null;
        const overview = buildDatasetOverview(dataset);
        return {
            title: overview.title, standaloneQuestion: overview.title, summary: overview.summary, insights: overview.insights,
            sql: '', rowCount: overview.rowCount, analysis: overview.analysis, formatting: overview.formatting, tokens: 0, overview: true,
            explanation: 'Worked out on your computer from all the rows. Nothing was sent to the AI.',
        };
    }, [dataset]);

    // ── Send ──
    const send = useCallback(async (rawText: string, forced?: Route) => {
        const text = rawText.replace(/\s+$/g, '').trim();
        if (!text || !dataset || !active || busy) return;
        const conversationId = active.id;
        const hasAnswer = answeredTurns(active).length > 0;
        const decision = classifyTurn(text, hasAnswer, dataset);
        const route: Route = forced || (decision.kind === 'chat' ? 'chat' : decision.kind === 'summary' ? 'summary' : decision.kind === 'explain' ? 'explain' : 'analysis');
        // With an earlier answer (and Memory on), its question and SQL go with
        // every analysis message; the AI decides whether to build on them.
        const context = contextForFollowUp(answeredTurns(active), memory);

        const userId = newId();
        const userTurn: ChatTurn = { id: userId, role: 'user', createdAt: Date.now(), text, kind: route === 'chat' ? 'chat' : route === 'summary' ? 'summary' : route === 'explain' ? 'explain' : 'new', contextTurns: 0 };
        const assistantId = newId();
        const assistantTurn: ChatTurn = { id: assistantId, role: 'assistant', createdAt: Date.now(), status: 'pending', progress: 'Thinking' };
        updateConversation(conversationId, conversation => ({
            ...conversation,
            title: conversation.turns.length ? conversation.title : titleFrom(text),
            updatedAt: Date.now(),
            turns: [...conversation.turns, userTurn, assistantTurn],
        }));
        setDraft('');
        setModeOverride(null);

        const showOverview = (lead?: string) => {
            const answer = overviewAnswer();
            updateTurn(conversationId, userId, { kind: 'summary' });
            updateTurn(conversationId, assistantId, { status: 'done', progress: undefined, ...(lead ? { reply: { message: lead } } : {}), ...(answer ? { answer } : {}) });
        };
        if (route === 'summary') { showOverview(); return; }
        // "What does that mean?": explained here from the last answer, numbers included, no AI.
        if (route === 'explain') {
            const last = [...active.turns].reverse().find(turn => turn.role === 'assistant' && turn.answer);
            if (last?.answer) {
                updateTurn(conversationId, assistantId, {
                    status: 'done', progress: undefined,
                    reply: { message: explainAnswer(last.answer), suggestions: suggestFollowUps(last.answer, dataset).slice(0, 3) },
                });
                return;
            }
        }

        const status = checkAiSqlLimit(currentUser);
        if (!status.allowed) {
            updateTurn(conversationId, assistantId, {
                status: 'error', progress: undefined,
                error: {
                    title: 'AI SQL unavailable',
                    message: status.blocked ? 'Your account role does not have access to AI SQL.' : `You've used all ${status.limit} AI SQL queries. Your limit resets in ${formatResetTime(status.resetsInMs)}.`,
                },
            });
            return;
        }

        const run: ActiveRun = { turnId: assistantId, conversationId, cancelled: false };
        activeRun.current = run;
        // Which call failed matters: a built-in reply only stands in for the conversation AI.
        let phase: 'chat' | 'analysis' = route === 'chat' ? 'chat' : 'analysis';
        let question = text;
        let lead: string | undefined;
        try {
            if (route === 'chat') {
                updateTurn(conversationId, assistantId, { progress: 'Writing a reply' });
                const history: ChatHistoryItem[] = active.turns.flatMap((turn): ChatHistoryItem[] => turn.role === 'user'
                    ? [{ role: 'user', text: turn.text || '' }]
                    : [{ role: 'assistant', text: turn.reply?.message || turn.answer?.title || turn.clarify?.question || '' }]).filter(item => item.text);
                const lastSql = [...active.turns].reverse().find(turn => turn.answer?.sql)?.answer?.sql;
                const chat = await Promise.race([
                    chatWithAI(text, dataset, history, lastSql),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The reply took longer than 30 seconds. Please try again.')), 30_000)),
                ]);
                if (run.cancelled) return;
                updateConversation(conversationId, conversation => ({ ...conversation, tokens: conversation.tokens + chat.tokens }));
                if (chat.overview) { showOverview(chat.message || undefined); return; }
                if (!chat.analyze) {
                    updateTurn(conversationId, assistantId, {
                        status: 'done', progress: undefined,
                        reply: { message: chat.message, suggestions: chat.suggestions.length ? chat.suggestions : (hasAnswer ? [] : examples.slice(0, 3)) },
                    });
                    return;
                }
                // A data question after all: say so, then answer it as analysis.
                lead = chat.message || undefined;
                updateTurn(conversationId, assistantId, { reply: lead ? { message: lead } : undefined, progress: 'Writing the query' });
                question = chat.analyze;
                phase = 'analysis';
            }
            const result = await Promise.race([
                runLeanAISQL(question, dataset, {
                    context,
                    // Chosen as analysis by the user or handed over by the conversation AI: never answered in words.
                    requireAnalysis: forced === 'analysis' || route === 'chat',
                    onProgress: step => { if (!run.cancelled) updateTurn(conversationId, assistantId, { progress: step }); },
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The answer took longer than 60 seconds. Please try again.')), 60_000)),
            ]);
            if (run.cancelled) return;
            incrementAiSqlUsage();
            const tokens = result.tokenUsage?.total || 0;
            const standalone = result.conversation?.standaloneQuestion || question;
            const builtOn = result.conversation?.usedContext ? result.conversation.contextTurns : 0;
            if (route !== 'chat') updateTurn(conversationId, userId, { kind: builtOn ? 'follow_up' : 'new', contextTurns: builtOn, sentContext: context.length });
            if (result.rawData.length === 0) {
                updateTurn(conversationId, assistantId, { status: 'done', progress: undefined, noData: { message: result.explanation || 'No rows matched.', sql: result.sql } });
                updateConversation(conversationId, conversation => ({ ...conversation, tokens: conversation.tokens + tokens }));
                return;
            }
            pipelines.current.set(assistantId, result);
            const { analysis, formatting } = presentLeanAnswer(result, standalone);
            const listOnly = isDimensionOnlyResult(result.profile, result.rawData);
            const answer: ChatAnswer = {
                title: result.narrative?.headline || titleFrom(standalone),
                standaloneQuestion: standalone,
                summary: result.narrative?.summary,
                // Warnings about the numbers get their own box; the rest are key points.
                cautions: result.narrative?.cautions,
                insights: result.narrative?.insights?.filter(item => !result.narrative?.cautions?.includes(item)),
                explanation: result.explanation,
                sql: result.sql,
                dimensions: result.plan.dimensions.map(item => item.field),
                measures: result.plan.metrics.map(item => item.field),
                rowCount: result.rawData.length,
                // A list answer is shown as a table of the rows the query returned.
                analysis: listOnly ? { ...analysis, data: result.rawData.slice(0, 200) } : analysis,
                formatting,
                listOnly,
                tokens,
                executionTimeMs: result.executionTimeMs,
            };
            updateTurn(conversationId, assistantId, { status: 'done', progress: undefined, answer });
            updateConversation(conversationId, conversation => ({ ...conversation, tokens: conversation.tokens + tokens }));
            runAnswerCheck(conversationId, assistantId, result.sql, result.queryRows || result.rawData);
        } catch (err: any) {
            if (run.cancelled) return;
            const message = String(err?.message || 'Something went wrong.');
            if (err instanceof AISQLOverviewRequest) {
                updateConversation(conversationId, conversation => ({ ...conversation, tokens: conversation.tokens + err.tokens }));
                showOverview(lead);
                return;
            }
            if (err instanceof AISQLChatReplyError) {
                // The analysis AI judged it conversation and replied in words.
                updateTurn(conversationId, userId, { kind: 'chat' });
                updateConversation(conversationId, conversation => ({ ...conversation, tokens: conversation.tokens + err.tokens }));
                updateTurn(conversationId, assistantId, { status: 'done', progress: undefined, reply: { message, suggestions: err.suggestions } });
                return;
            }
            if (err instanceof AISQLClarificationError || err?.kind === 'clarification_required') {
                incrementAiSqlUsage();
                updateTurn(conversationId, assistantId, {
                    status: 'done', progress: undefined,
                    ...(lead ? { reply: { message: lead } } : {}),
                    clarify: { question: message, options: (err as AISQLClarificationError).options || [], original: question },
                });
                return;
            }
            if (phase === 'chat' && decision.fallback && !/limit|quota/i.test(message)) {
                // Only when the conversation AI itself could not be reached.
                updateTurn(conversationId, assistantId, { status: 'done', progress: undefined, reply: { ...decision.fallback, suggestions: examples.slice(0, 3) } });
                return;
            }
            const title = err?.kind === 'ai_sql_execution_failed' ? 'The query could not run'
                : err?.kind === 'sql_validation_failed' ? 'Query blocked for safety'
                    : /timed out|longer than|timeout/i.test(message) ? 'That took too long'
                        : /network|failed to fetch|connect|offline/i.test(message) ? 'Connection problem'
                            : /limit|quota/i.test(message) ? 'AI limit reached'
                                : 'Could not answer that';
            updateTurn(conversationId, assistantId, { status: 'error', progress: undefined, error: { title, message, retryText: text } });
        } finally {
            if (activeRun.current === run) activeRun.current = null;
        }
    }, [dataset, active, busy, memory, updateConversation, updateTurn, examples, incrementAiSqlUsage, currentUser, overviewAnswer, runAnswerCheck]);

    const stop = () => {
        const run = activeRun.current;
        if (!run) return;
        run.cancelled = true;
        updateTurn(run.conversationId, run.turnId, { status: 'stopped', progress: undefined });
        activeRun.current = null;
    };

    // Questions sent here from other pages start a fresh chat.
    const handledInitial = useRef<string | null>(null);
    const waitingInitial = useRef<string | null>(null);
    useEffect(() => {
        if (!initialQuery || !dataset || !active || busy || handledInitial.current === initialQuery) return;
        handledInitial.current = initialQuery;
        if (active.turns.length) {
            const fresh = newConversation();
            waitingInitial.current = initialQuery;
            setConversations(list => [fresh, ...list]);
            setActiveId(fresh.id);
            return;
        }
        void send(initialQuery, 'analysis');
    }, [initialQuery, dataset, active, busy, send]);
    // After switching to the fresh chat above, send the waiting question.
    useEffect(() => {
        const waiting = waitingInitial.current;
        if (waiting && active && !active.turns.length && !busy) {
            waitingInitial.current = null;
            void send(waiting, 'analysis');
        }
    }, [active, busy, send]);

    const startNewChat = () => {
        if (busy) stop();
        const empty = conversations.find(conversation => !conversation.turns.length);
        if (empty) { setActiveId(empty.id); } else {
            const fresh = newConversation();
            setConversations(list => [fresh, ...list]);
            setActiveId(fresh.id);
        }
        setDraft('');
        requestAnimationFrame(() => inputRef.current?.focus());
        if (window.innerWidth < 1100) setListOpen(false);
    };
    const deleteChat = (id: string) => {
        setConversations(list => {
            const rest = list.filter(conversation => conversation.id !== id);
            if (id === activeId) {
                const fresh = newConversation();
                setActiveId(fresh.id);
                return [fresh, ...rest];
            }
            return rest;
        });
    };

    const openFullScreen = async (turn: ChatTurn) => {
        if (!turn.answer || !dataset || !onViewFullPage) return;
        let pipeline = pipelines.current.get(turn.id);
        if (!pipeline) {
            // An answer from an earlier visit: re-run its SQL here, no AI call.
            setOpening(turn.id);
            try {
                pipeline = await rerunSavedAnswer({
                    question: turn.answer.standaloneQuestion, sql: turn.answer.sql, title: turn.answer.title,
                    dimensions: turn.answer.dimensions, measures: turn.answer.measures, explanation: turn.answer.explanation,
                }, dataset);
                pipelines.current.set(turn.id, pipeline);
            } catch (err: any) {
                setOpening(null);
                window.alert?.(String(err?.message || 'This answer could not be reopened.'));
                return;
            }
            setOpening(null);
        }
        const { analysis, formatting } = presentLeanAnswer(pipeline, turn.answer.standaloneQuestion);
        onViewFullPage(analysis, pipeline, turn.answer.standaloneQuestion, formatting);
    };

    const copyAnswer = async (turn: ChatTurn) => {
        if (!turn.answer) return;
        const text = [turn.answer.title, turn.answer.summary, ...(turn.answer.cautions || []).map(item => `⚠ ${item}`), ...(turn.answer.insights || []).map(item => `• ${item}`)].filter(Boolean).join('\n');
        try { await navigator.clipboard.writeText(text); setCopied(turn.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ }
    };

    if (!dataset) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-400">
                <Sparkles className="h-16 w-16 text-slate-600" />
                <h3 className="text-xl font-bold text-slate-300">No Dataset Loaded</h3>
                <p className="text-sm text-slate-500">Please load a dataset to use AI SQL.</p>
            </div>
        );
    }

    // Follow-up chips only right after a query answer (not after a reply in
    // words, and not after the overview, which has no query to build on).
    const lastAssistantTurn = [...(active?.turns || [])].reverse().find(turn => turn.role === 'assistant');
    const followUps = lastAssistantTurn?.answer?.sql && !busy ? suggestFollowUps(lastAssistantTurn.answer, dataset) : [];
    const history = conversations.filter(conversation => conversation.turns.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = history.reduce<Record<string, Conversation[]>>((acc, conversation) => {
        const label = whenLabel(conversation.updatedAt);
        (acc[label] ||= []).push(conversation);
        return acc;
    }, {});
    const memoryOption = MEMORY_OPTIONS.find(option => option.value === memory) || MEMORY_OPTIONS[1];
    const contextCost = pendingContext.length ? estimateTokens(formatContextForPrompt(pendingContext)) : 0;
    // Conversation ↔ analysis can always be switched; follow-up ↔ new needs a previous answer.
    // Tap the label to switch: conversation ⇄ analysis (an overview can become analysis).
    const modeCanFlip = Boolean(draft.trim());
    const nextMode: Route = sendRoute === 'analysis' ? 'chat' : 'analysis';

    return (
        <div className="qi-chat h-full">
            {/* ── Chat list ── */}
            <aside className={`qi-chat-list ${listOpen ? 'is-open' : ''}`} aria-label="Your AI SQL chats">
                <div className="qi-chat-list-head">
                    <button type="button" className="qi-chat-new" onClick={startNewChat}>
                        <MessageSquarePlus className="h-4 w-4" aria-hidden /> New chat
                    </button>
                    <button type="button" className="qi-chat-icon-btn qi-chat-list-close" aria-label="Hide chat list" onClick={() => setListOpen(false)}>
                        <PanelLeftClose className="h-4 w-4" />
                    </button>
                </div>
                <div className="qi-chat-list-body">
                    {history.length === 0 && <p className="qi-chat-list-empty">Your chats about {dataset.name} appear here.</p>}
                    {(['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const).filter(label => groups[label]?.length).map(label => (
                        <div key={label} className="qi-chat-list-group">
                            <div className="qi-chat-list-label">{label}</div>
                            {groups[label].map(conversation => (
                                <div key={conversation.id} className={`qi-chat-list-item ${conversation.id === activeId ? 'is-active' : ''}`}>
                                    <button
                                        type="button"
                                        className="qi-chat-list-open"
                                        onClick={() => { setActiveId(conversation.id); if (window.innerWidth < 1100) setListOpen(false); }}
                                        aria-current={conversation.id === activeId ? 'page' : undefined}
                                        title={conversation.title}
                                    >
                                        {conversation.title}
                                    </button>
                                    <button type="button" className="qi-chat-icon-btn qi-chat-list-delete" aria-label={`Delete chat: ${conversation.title}`} onClick={() => deleteChat(conversation.id)}>
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
                <p className="qi-chat-list-foot"><History className="h-3.5 w-3.5" aria-hidden /> Saved in this browser only</p>
            </aside>
            {listOpen && <button type="button" className="qi-chat-scrim" aria-label="Close chat list" onClick={() => setListOpen(false)} />}

            {/* ── Conversation ── */}
            <section className="qi-chat-main" aria-label="AI SQL chat">
                <header className="qi-chat-head">
                    <div className="flex min-w-0 items-center gap-2">
                        {!listOpen && (
                            <button type="button" className="qi-chat-icon-btn" aria-label="Show chat list" onClick={() => setListOpen(true)}>
                                <PanelLeftOpen className="h-4 w-4" />
                            </button>
                        )}
                        <img src="/ai-sql-logo.png" alt="" className="h-6 w-6 rounded-md object-cover" />
                        <div className="min-w-0">
                            <h2 className="qi-chat-title">{active?.turns.length ? active.title : 'AI SQL'}</h2>
                            <div className="qi-chat-subtitle">
                                <span title="The AI receives your question and your column names and types. Never values, counts or rows."><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Column names only</span>
                                {active && active.tokens > 0 && <span title="AI tokens used by this chat">· {formatTokens(active.tokens)} tokens</span>}
                            </div>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <label className="qi-chat-memory" title={memoryOption.hint}>
                            <span>Memory</span>
                            <select aria-label="How much of the chat follow-ups remember" value={memory} onChange={event => setMemory(Number(event.target.value))}>
                                {MEMORY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <button type="button" className="qi-chat-icon-btn" aria-label="New chat" title="New chat" onClick={startNewChat}>
                            <MessageSquarePlus className="h-4 w-4" />
                        </button>
                    </div>
                </header>

                <div ref={threadRef} className="qi-chat-thread" role="log" aria-live="polite" aria-label="Conversation">
                    <div className="qi-chat-thread-inner">
                        {!active?.turns.length && (
                            <div className="qi-chat-empty">
                                <div className="qi-chat-empty-mark"><Sparkles className="h-6 w-6" aria-hidden /></div>
                                <h3>What would you like to know about {dataset.name.replace(/\.[^.]+$/, '')}?</h3>
                                <p>Ask in plain English. The AI sees only your column names and types, writes one query, and the query runs here on your computer. Ask follow-ups like “now by month” — only the last question and its SQL are sent with them.</p>
                                <DataKindNote dataset={dataset} compact />
                                <div className="qi-chat-examples">
                                    {examples.map(example => (
                                        <button key={example} type="button" onClick={() => void send(example, 'analysis')}>{example}</button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {active?.turns.map((turn, index) => turn.role === 'user' ? (
                            <div key={turn.id} className="qi-chat-row is-user">
                                <div className="qi-chat-bubble">{turn.text}</div>
                                <div className="qi-chat-tag" title={turn.kind === 'follow_up' ? 'The AI built on the earlier question and SQL (never results)' : turn.kind === 'new' ? 'The AI answered it on its own' : turn.kind === 'summary' || turn.kind === 'explain' ? 'Worked out on your computer; nothing sent to the AI' : 'The AI replied in words'}>
                                    {turn.kind === 'follow_up' && <><Link2 className="h-3 w-3" aria-hidden /> Follow-up · the AI built on your last answer</>}
                                    {turn.kind === 'new' && index > 0 && <>{turn.sentContext ? 'New question · the AI treated it on its own' : 'New question'}</>}
                                    {turn.kind === 'chat' && <>Conversation · the AI replies in words</>}
                                    {turn.kind === 'summary' && <>Overview · worked out on your computer, no AI</>}
                                    {turn.kind === 'explain' && <>Explained from your last answer · on your computer, no AI</>}
                                </div>
                            </div>
                        ) : (
                            <div key={turn.id} className="qi-chat-row is-assistant">
                                <div className="qi-chat-avatar" aria-hidden><Sparkles className="h-4 w-4" /></div>
                                <div className="qi-chat-assistant">
                                    {turn.status === 'pending' && (
                                        <div className="qi-chat-thinking" role="status">
                                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                            <span>{turn.progress || 'Thinking'}…</span>
                                            <button type="button" className="qi-chat-link" onClick={stop}>Stop</button>
                                        </div>
                                    )}
                                    {turn.status === 'stopped' && <p className="qi-chat-muted">Stopped.</p>}
                                    {turn.reply && (
                                        <div className="qi-chat-reply">
                                            {turn.reply.title && <strong>{turn.reply.title}</strong>}
                                            <RichText text={turn.reply.message} className={turn.reply.title ? '' : 'qi-chat-reply-text'} />
                                            {!!turn.reply.suggestions?.length && (
                                                <div className="qi-chat-chips">
                                                    {turn.reply.suggestions.map(suggestion => <button key={suggestion} type="button" onClick={() => void send(suggestion, 'analysis')}>{suggestion}</button>)}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {turn.clarify && (
                                        <div className="qi-chat-clarify">
                                            <p className="qi-chat-clarify-q">{turn.clarify.question}</p>
                                            <div className="qi-chat-chips">
                                                {turn.clarify.options.map(option => (
                                                    <button key={option.question} type="button" title={option.question} disabled={busy} onClick={() => void send(option.question, 'analysis')}>{option.label}</button>
                                                ))}
                                                <button type="button" className="is-quiet" onClick={() => { setDraft(turn.clarify!.original); requestAnimationFrame(() => inputRef.current?.focus()); }}>
                                                    {turn.clarify.options.length ? 'Something else…' : 'Edit my question'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {turn.noData && (
                                        <div className="qi-chat-reply">
                                            <strong>No rows matched</strong>
                                            <p>{turn.noData.message}</p>
                                            {turn.noData.sql && <pre className="qi-chat-sql">{turn.noData.sql}</pre>}
                                        </div>
                                    )}
                                    {turn.error && (
                                        <div className="qi-chat-error" role="alert">
                                            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                                            <div className="min-w-0">
                                                <strong>{turn.error.title}</strong>
                                                <p>{turn.error.message}</p>
                                                {turn.error.retryText && (
                                                    <button type="button" className="qi-chat-link" disabled={busy} onClick={() => void send(turn.error!.retryText!)}>
                                                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try again
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {turn.answer && (
                                        <article className="qi-chat-answer" aria-label={turn.answer.title}>
                                            <header className="qi-chat-answer-head">
                                                <h4>{turn.answer.title}</h4>
                                                {turn.answer.standaloneQuestion && !turn.answer.overview && turn.answer.standaloneQuestion !== active.turns[index - 1]?.text && (
                                                    <p className="qi-chat-understood" title="The complete question that was answered"><CornerDownRight className="h-3 w-3" aria-hidden /> {turn.answer.standaloneQuestion}</p>
                                                )}
                                            </header>
                                            {turn.answer.summary && <p className="qi-chat-summary">{turn.answer.summary}</p>}
                                            {!!turn.answer.cautions?.length && (
                                                <div className="qi-chat-caution" role="note" aria-label="Check these numbers">
                                                    <AlertTriangle className="h-4 w-4" aria-hidden />
                                                    <div>{turn.answer.cautions.map(item => <p key={item}>{item}</p>)}</div>
                                                </div>
                                            )}
                                            <div className={`qi-chat-figure ${turn.answer.listOnly ? 'is-table' : ''}`}>
                                                {turn.answer.listOnly ? (
                                                    <AnswerTable rows={turn.answer.analysis.data || []} />
                                                ) : (
                                                    <ChartVisualization
                                                        data={turn.answer.analysis.data}
                                                        xKey={turn.answer.analysis.xKey}
                                                        yKey={turn.answer.analysis.yKey}
                                                        yLabel={turn.answer.analysis.yLabel}
                                                        config={turn.answer.analysis.config}
                                                        seriesLabel={seriesName(turn.answer.analysis.yKey)}
                                                        chartType={(turn.answer.analysis.vis as any) || 'bar'}
                                                        onChartTypeChange={() => {}}
                                                        formatting={turn.answer.formatting}
                                                        hideControls
                                                        disableAutoSeries
                                                    />
                                                )}
                                            </div>
                                            {!turn.answer.overview && turn.answer.sql && (
                                                <AnswerCheckStrip
                                                    check={turn.answer.check}
                                                    running={Boolean(checking[turn.id])}
                                                    onRun={() => runAnswerCheck(active.id, turn.id, turn.answer!.sql)}
                                                />
                                            )}
                                            {turn.answer.analysis.config?.pointLabelKeys && (
                                                <ExtremesTable
                                                    rows={turn.answer.analysis.data || []}
                                                    groupKey={turn.answer.analysis.xKey}
                                                    pointLabelKeys={turn.answer.analysis.config.pointLabelKeys}
                                                    currency={CURRENCY_OF_FORMAT[String(turn.answer.formatting.numberFormat)]}
                                                />
                                            )}
                                            {!!turn.answer.insights?.length && (
                                                <ul className="qi-chat-insights" aria-label="Key points">
                                                    {turn.answer.insights.map(insight => <li key={insight}>{insight}</li>)}
                                                </ul>
                                            )}
                                            <footer className="qi-chat-answer-foot">
                                                <div className="qi-chat-actions">
                                                    {turn.answer.overview && onOpenSummaryStory && (
                                                        <button type="button" className="is-primary" onClick={() => onOpenSummaryStory('Give me an overview of my data')}>
                                                            <Maximize2 className="h-3.5 w-3.5" aria-hidden /> Full data story
                                                        </button>
                                                    )}
                                                    {onViewFullPage && turn.answer.sql && (
                                                        <button type="button" className="is-primary" onClick={() => void openFullScreen(turn)} disabled={opening === turn.id}>
                                                            {opening === turn.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />} Full screen
                                                        </button>
                                                    )}
                                                    {turn.answer.sql && (
                                                        <button type="button" aria-expanded={Boolean(openSql[turn.id])} onClick={() => setOpenSql(state => ({ ...state, [turn.id]: !state[turn.id] }))}>
                                                            <Code className="h-3.5 w-3.5" aria-hidden /> SQL
                                                        </button>
                                                    )}
                                                    {onPin && (
                                                        <button type="button" onClick={() => onPin(turn.answer!.title, turn.answer!.analysis)}>
                                                            <Pin className="h-3.5 w-3.5" aria-hidden /> Pin
                                                        </button>
                                                    )}
                                                    <button type="button" onClick={() => void copyAnswer(turn)} aria-label="Copy the answer as text">
                                                        {copied === turn.id ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />} {copied === turn.id ? 'Copied' : 'Copy'}
                                                    </button>
                                                </div>
                                                <span className="qi-chat-meta">
                                                    {turn.answer.overview ? `From all ${turn.answer.rowCount.toLocaleString()} rows · no AI` : `${turn.answer.rowCount.toLocaleString()} row${turn.answer.rowCount === 1 ? '' : 's'}`}
                                                    {turn.answer.tokens ? ` · ${formatTokens(turn.answer.tokens)} tokens` : ''}
                                                </span>
                                            </footer>
                                            {openSql[turn.id] && (
                                                <div className="qi-chat-sql-wrap">
                                                    {turn.answer.explanation && <p className="qi-chat-muted">{turn.answer.explanation}</p>}
                                                    <pre className="qi-chat-sql">{turn.answer.sql}</pre>
                                                </div>
                                            )}
                                        </article>
                                    )}
                                </div>
                            </div>
                        ))}

                        {followUps.length > 0 && (
                            <div className="qi-chat-followups" aria-label="Suggested follow-ups">
                                {followUps.map(suggestion => (
                                    <button key={suggestion} type="button" onClick={() => void send(suggestion, 'analysis')}>
                                        <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> {suggestion}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Composer ── */}
                <div className="qi-chat-composer-wrap">
                    {!limitStatus.allowed && !limitStatus.blocked && (
                        <p className="qi-chat-limit"><Lock className="h-3.5 w-3.5" aria-hidden /> You've used all {limitStatus.limit} AI SQL questions. Resets in {formatResetTime(limitStatus.resetsInMs)}.</p>
                    )}
                    {limitStatus.allowed && limitStatus.limit !== Infinity && (
                        <p className="qi-chat-limit is-quiet">{limitStatus.remaining} of {limitStatus.limit} AI questions left · resets in {formatResetTime(limitStatus.resetsInMs)}</p>
                    )}
                    <div className="qi-chat-composer">
                        <textarea
                            ref={inputRef}
                            aria-label="Ask a question about your data"
                            rows={1}
                            value={draft}
                            placeholder={answered.length ? 'Ask a follow-up, or a new question…' : `Ask about your data… e.g. “${examples[0] || 'Total sales by category'}”`}
                            onChange={event => {
                                setDraft(event.target.value);
                                const element = event.target;
                                element.style.height = 'auto';
                                element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
                            }}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && !event.shiftKey) {
                                    event.preventDefault();
                                    if (!busy) void send(draft, modeOverride || undefined);
                                }
                                if (event.key === 'Escape' && busy) stop();
                            }}
                        />
                        <div className="qi-chat-composer-bar">
                            {draft.trim() ? (
                                <button
                                    type="button"
                                    className={`qi-chat-mode is-${sendRoute}`}
                                    disabled={!modeCanFlip}
                                    onClick={() => setModeOverride(nextMode)}
                                    title={`${modeOverride ? 'Chosen by you.' : detected.reason} Click to switch to ${nextMode === 'chat' ? 'conversation' : 'analysis'}.`}
                                    aria-label={`Will be sent as: ${sendRoute === 'analysis' ? 'analysis' : sendRoute === 'summary' ? 'data overview' : sendRoute === 'explain' ? 'an explanation of the last answer' : 'conversation'}. Click to switch to ${nextMode === 'chat' ? 'conversation' : 'analysis'}.`}
                                >
                                    {sendRoute === 'analysis' && (pendingContext.length
                                        ? <><Link2 className="h-3.5 w-3.5" aria-hidden /> Analysis · the AI checks if it builds on your last answer (~{contextCost} tokens)</>
                                        : <>Analysis · new question</>)}
                                    {sendRoute === 'chat' && <>Conversation · the AI replies in words</>}
                                    {sendRoute === 'summary' && <>Overview · worked out on your computer</>}
                                    {sendRoute === 'explain' && <>Explain the last answer · on your computer</>}
                                </button>
                            ) : (
                                <span className="qi-chat-hint">Enter to send · Shift+Enter for a new line</span>
                            )}
                            {busy ? (
                                <button type="button" className="qi-chat-send is-stop" onClick={stop} aria-label="Stop answering">
                                    <Square className="h-3.5 w-3.5" aria-hidden />
                                </button>
                            ) : (
                                <button type="button" className="qi-chat-send" onClick={() => void send(draft, modeOverride || undefined)} disabled={!draft.trim()} aria-label="Send">
                                    <ArrowUp className="h-4 w-4" aria-hidden />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

/** A plain list answer (no measure): the first rows as a table. */
const AnswerTable: React.FC<{ rows: Record<string, any>[] }> = ({ rows }) => {
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const shown = rows.slice(0, 25);
    return (
        <div className="qi-chat-table-wrap">
            <table className="qi-chat-table">
                <thead><tr>{columns.map(column => <th key={column}>{column.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>
                    {shown.map((row, index) => (
                        <tr key={index}>{columns.map(column => <td key={column}>{String(row[column] ?? '')}</td>)}</tr>
                    ))}
                </tbody>
            </table>
            {rows.length > shown.length && <p className="qi-chat-muted">Showing {shown.length} of {rows.length}. Open full screen for all rows.</p>}
        </div>
    );
};

/**
 * The AI's words, lightly formatted: paragraphs, "- " bullet lists and
 * **bold**. Rendered as text (no HTML from the reply is ever used).
 */
const RichText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
    const bold = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : <React.Fragment key={i}>{part}</React.Fragment>);
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/).map(block => block.split('\n').filter(line => line.trim()));
    return (
        <div className={`qi-chat-rich ${className || ''}`}>
            {blocks.map((lines, index) => lines.length && lines.every(line => /^\s*([-•*]|\d+[.)])\s+/.test(line))
                ? <ul key={index}>{lines.map((line, i) => <li key={i}>{bold(line.replace(/^\s*([-•*]|\d+[.)])\s+/, ''))}</li>)}</ul>
                : <p key={index}>{lines.map((line, i) => <React.Fragment key={i}>{i > 0 && <br />}{bold(line)}</React.Fragment>)}</p>)}
        </div>
    );
};

