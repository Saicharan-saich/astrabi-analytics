import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'components', 'AISQLView.tsx'), 'utf8');

describe('AI SQL question guidance visibility', () => {
  it('keeps the fixed-height workspace vertically scrollable', () => {
    const workspace = source.match(/className="qi-ai-workspace[^"]+"/)?.[0] || '';
    expect(workspace).toContain('h-full');
    expect(workspace).toContain('overflow-y-auto');
    expect(workspace).not.toContain('overflow-hidden');
  });

  it('does not allow the question guidance section to collapse out of view', () => {
    const guidance = source.match(/\{\/\* Example Suggestions \*\/\}[\s\S]*?A useful question usually includes/)?.[0] || '';
    expect(guidance).toContain('min-h-[220px]');
    expect(guidance).toContain('shrink-0');
  });
});
