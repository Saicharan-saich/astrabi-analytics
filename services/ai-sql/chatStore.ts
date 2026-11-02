/**
 * AI SQL chat history, kept in this browser only (per user and dataset).
 * Nothing here is sent to the AI: follow-ups send just the last few
 * questions and their SQL, chosen by chatContext.ts.
 */
import type { AnalysisResult, FormattingConfig } from '../../types';
import type { ClarificationOption } from './leanPipeline';
import type { TurnKind } from './chatContext';

export interface ChatAnswer {
    title: string;
    /** The complete question that was answered, readable on its own. */
    standaloneQuestion: string;
    summary?: string;
    insights?: string[];
    explanation?: string;
    sql: string;
    dimensions?: string[];
    measures?: string[];
    rowCount: number;
    /** What the inline chart draws (rows capped). */
    analysis: AnalysisResult;
    formatting: FormattingConfig;
    /** True when the result is a plain list (no measure), shown as a table. */
    listOnly?: boolean;
    tokens: number;
    executionTimeMs?: number;
}

export interface ChatTurn {
    id: string;
    role: 'user' | 'assistant';
    createdAt: number;
    text?: string;
    /** user turns: how the message was sent */
    kind?: TurnKind;
    /** user turns: earlier answers sent with it (0 = none) */
    contextTurns?: number;
    status?: 'pending' | 'done' | 'error' | 'stopped';
    progress?: string;
    answer?: ChatAnswer;
    clarify?: { question: string; options: ClarificationOption[]; original: string };
    reply?: { title: string; message: string; suggestions?: string[] };
    error?: { title: string; message: string; retryText?: string };
    noData?: { message: string; sql?: string };
}

export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    turns: ChatTurn[];
    /** AI tokens used by this chat. */
    tokens: number;
}

const KEY_PREFIX = 'QuickInsight-ai-sql-chats-v1:';
const MAX_CONVERSATIONS = 30;
const MAX_TURNS = 80;
const MAX_ROWS_SAVED = 200;

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function chatStorageKey(userId: string | undefined, datasetKey: string): string {
    return `${KEY_PREFIX}${userId || 'anonymous'}:${datasetKey}`;
}

export function newConversation(): Conversation {
    const now = Date.now();
    return { id: newId(), title: 'New chat', createdAt: now, updatedAt: now, turns: [], tokens: 0 };
}

/** A short title from the first question. */
export function titleFrom(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
    if (!clean) return 'New chat';
    const short = clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
    return short.charAt(0).toUpperCase() + short.slice(1);
}

export function loadConversations(key: string): Conversation[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item: any) => item && typeof item.id === 'string' && Array.isArray(item.turns))
            // A request that was running when the page closed did not finish.
            .map((item: Conversation) => ({
                ...item,
                turns: item.turns.map(turn => turn.status === 'pending'
                    ? { ...turn, status: 'stopped' as const, progress: undefined }
                    : turn),
            }));
    } catch {
        return [];
    }
}

/** Slim copy for storage: chart rows are capped; nothing else is dropped. */
function forStorage(conversation: Conversation): Conversation {
    return {
        ...conversation,
        turns: conversation.turns.slice(-MAX_TURNS).map(turn => turn.answer
            ? { ...turn, answer: { ...turn.answer, analysis: { ...turn.answer.analysis, data: (turn.answer.analysis.data || []).slice(0, MAX_ROWS_SAVED) } } }
            : turn),
    };
}

export function saveConversations(key: string, conversations: Conversation[]): void {
    const kept = conversations
        .filter(conversation => conversation.turns.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CONVERSATIONS)
        .map(forStorage);
    try {
        localStorage.setItem(key, JSON.stringify(kept));
    } catch {
        // Storage full or blocked: keep the most recent few instead.
        try { localStorage.setItem(key, JSON.stringify(kept.slice(0, 5))); } catch { /* the chat still works for this visit */ }
    }
}

/** Answered turns, oldest first, as context for a follow-up. */
export function answeredTurns(conversation: Conversation | undefined): { question: string; sql: string }[] {
    if (!conversation) return [];
    return conversation.turns
        .filter(turn => turn.role === 'assistant' && turn.status === 'done' && turn.answer?.sql)
        .map(turn => ({ question: turn.answer!.standaloneQuestion, sql: turn.answer!.sql }));
}

/** Group label for the chat list. */
export function whenLabel(timestamp: number, now = Date.now()): string {
    const day = 86_400_000;
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    if (timestamp >= startOfToday.getTime()) return 'Today';
    if (timestamp >= startOfToday.getTime() - day) return 'Yesterday';
    if (timestamp >= startOfToday.getTime() - 6 * day) return 'Previous 7 days';
    return 'Older';
}
