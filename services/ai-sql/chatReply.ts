/**
 * Conversation in the AI SQL chat: replies in plain English to messages that
 * are not data questions ("how does this work?", "how do you know if my
 * question is a follow-up?", "what does median mean?", "why a line chart?").
 *
 * What the AI is sent: the column names and types, the recent questions and
 * answer titles of this chat, and the last answer's SQL. Never rows, values,
 * counts, summaries or key points. When the message turns out to be a data
 * question after all, the AI hands it back as `analyze` and the app runs it.
 */
import type { Dataset } from '../../types';
import { fetchWithFallback, LUNA_MODEL } from './modelConfig';
import { resolveAISQLSemanticModel } from './semanticLayer';
import { describeColumnsOnly } from './leanPipeline';
import { AISQLPipelineError } from './pipelineError';

export interface ChatHistoryItem {
    role: 'user' | 'assistant';
    /** User words, or the assistant's reply / answer title (never numbers from the data). */
    text: string;
}

export interface ChatReply {
    message: string;
    suggestions: string[];
    /** A data question to run as analysis, when the message asked for one. */
    analyze?: string;
    /** The user asked for a summary of the whole dataset. */
    overview?: boolean;
    tokens: number;
}

export const CHAT_SYSTEM_PROMPT = `You are the assistant in QuickInsight's AI SQL chat. Talk with the user naturally, in friendly, plain British English, and help them get answers from their data.

What you can see: the names and types of the dataset's columns (below) and this conversation's recent messages. You never see the data's rows or values.

How QuickInsight works — answer questions about it from these facts only:
- Data questions: an AI reads only the question and the column names and types, and writes one read-only SQL query. The query runs in the user's own browser on every row. The chart, summary and key points are calculated there too, so the AI never writes the numbers. Each answer can show its SQL.
- Follow-up or new question: before anything is sent, the app reads the wording in the browser. A message that builds on the last answer ("now by month", "what about profit?", "only 2024", "show it as a pie", words like "it" or "that") is a follow-up: it is sent with the last question and its SQL, never the results. A complete question is sent on its own, with no history, which saves tokens. The label under each message says which it was; the label in the message box shows it before sending, and tapping it switches.
- Memory (top right of the chat): Off, Last answer, Last 2 or Last 3 answers — how many earlier questions a follow-up carries.
- Vague questions ("best product") get a quick follow-up with choices before answering.
- Conversations like this one are answered by the AI with the column names only.
- Chats are saved in this browser only. "Full screen" opens a bigger view of an answer.
- Data cleaning is in Dataset Workspace → Cleaning: automatic fixes with an undo, flagged problems to decide on, and the user's own rules.

Rules:
- Keep replies short: at most 120 words, no headings. Use the user's terms.
- Never state numbers or facts about the data's contents — you have not seen them. You may say which columns exist and what can be asked.
- If the message asks for an analysis of the data (a total, average, count, ranking, trend, comparison, list or chart), do not answer it yourself: put the complete question to run in "analyze" (written so it makes sense on its own, using the recent conversation) and a one-line lead-in in "message".
- If the message asks for a summary, overview or description of the whole dataset, set "overview": true and a one-line lead-in in "message"; the app works the overview out on the user's computer.
- You may use short paragraphs and simple "- " bullet lists. No headings, no tables.
- When helpful, offer 2 or 3 short example questions in "suggestions", built from the real column names.

Return only JSON: {"message": "...", "suggestions": ["..."], "analyze": null, "overview": false}`;

export function buildChatMessages(message: string, dataset: Dataset, history: ChatHistoryItem[], lastSql?: string) {
    const { model } = resolveAISQLSemanticModel(dataset);
    const columns = describeColumnsOnly(model);
    const recent = history.slice(-8).map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    const content = [
        `DATASET: ${dataset.name}`,
        columns,
        recent ? `\nRECENT CONVERSATION\n${recent}` : '',
        lastSql ? `\nLAST ANSWER'S SQL\n${lastSql.replace(/\s+/g, ' ').slice(0, 1200)}` : '',
        `\nNEW MESSAGE\n${message}`,
    ].filter(Boolean).join('\n');
    return [
        { role: 'system' as const, content: CHAT_SYSTEM_PROMPT },
        { role: 'user' as const, content },
    ];
}

export function parseChatReply(content: string): Omit<ChatReply, 'tokens'> {
    const text = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let raw: any = null;
    if (start >= 0 && end > start) { try { raw = JSON.parse(text.slice(start, end + 1)); } catch { raw = null; } }
    if (!raw || typeof raw !== 'object') {
        // A plain-text reply is still a reply.
        if (text) return { message: text.slice(0, 1200), suggestions: [] };
        throw new AISQLPipelineError('ai_sql_unavailable', 'The AI reply could not be read. Please try again.');
    }
    const message = String(raw.message || '').trim().slice(0, 1200);
    const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 3);
    const analyze = typeof raw.analyze === 'string' && raw.analyze.trim() ? raw.analyze.trim().slice(0, 300) : undefined;
    const overview = raw.overview === true;
    if (!message && !analyze && !overview) throw new AISQLPipelineError('ai_sql_unavailable', 'The AI sent an empty reply. Please try again.');
    return { message, suggestions, analyze, ...(overview ? { overview } : {}) };
}

/** One conversational AI call, on the lighter model. */
export async function chatWithAI(message: string, dataset: Dataset, history: ChatHistoryItem[], lastSql?: string): Promise<ChatReply> {
    const reply = await fetchWithFallback(buildChatMessages(message, dataset, history, lastSql), {
        model: LUNA_MODEL, temperature: 0.3, max_tokens: 700, timeout: 30_000,
    });
    const parsed = parseChatReply(reply.data?.choices?.[0]?.message?.content || '');
    return { ...parsed, tokens: Number(reply.data?.usage?.total_tokens) || 0 };
}
