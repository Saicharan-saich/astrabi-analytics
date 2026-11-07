/**
 * "What does that mean?" about the last answer: explained here, from the
 * answer itself (its sentences were worked out on this computer from the
 * result), so the numbers are included and nothing is sent to the AI.
 */
import type { ChatAnswer } from './chatStore';

export function explainAnswer(answer: ChatAnswer): string {
    const lines: string[] = [];
    const summary = (answer.summary || '').trim();
    lines.push(summary ? `Here's what it means. ${summary}` : `This answer shows ${answer.title}.`);
    const points = (answer.insights || []).filter(point => point && point !== summary).slice(0, 3);
    if (points.length) lines.push(['What stands out:', ...points.map(point => `- ${point}`)].join('\n'));
    if (answer.cautions?.length) lines.push(['Keep in mind:', ...answer.cautions.map(point => `- ${point}`)].join('\n'));
    if (answer.explanation && !/worked out on your computer/i.test(answer.explanation)) lines.push(`How it was worked out: ${answer.explanation}`);
    return lines.join('\n\n');
}
