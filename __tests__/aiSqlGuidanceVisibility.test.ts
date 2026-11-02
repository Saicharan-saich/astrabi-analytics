import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'components', 'AISQLView.tsx'), 'utf8');

describe('AI SQL chat layout', () => {
  it('scrolls the conversation, not the page, and keeps the composer in view', () => {
    const thread = source.match(/className="qi-chat-thread"/)?.[0];
    expect(thread).toBeTruthy();
    const css = readFileSync(join(process.cwd(), 'index.css'), 'utf8');
    expect(css).toMatch(/\.qi-chat-thread \{[^}]*overflow-y: auto/);
    expect(source.indexOf('qi-chat-thread')).toBeLessThan(source.indexOf('qi-chat-composer-wrap'));
  });

  it('shows example questions from the user\'s columns in an empty chat', () => {
    expect(source).toContain('qi-chat-examples');
    expect(source).toContain('buildQuestionExamples');
  });

  it('tells the user how each message is sent', () => {
    expect(source).toContain('New question · no history sent');
    expect(source).toContain('Follow-up');
    expect(source).toContain('Answered instantly');
  });
});
