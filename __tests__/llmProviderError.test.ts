import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseProviderError } = require('../backend/llmProviderError.js') as {
  parseProviderError: (status: number, body: string) => {
    message: string;
    providerErrorType: string;
    category: string;
    retryable: boolean;
  };
};

describe('LLM provider error normalization', () => {
  it('exposes a safe OpenRouter 403 reason without treating it as retryable', () => {
    const result = parseProviderError(403, JSON.stringify({
      error: { message: 'This model is not available for your account.', type: 'permission_denied' },
    }));
    expect(result.message).toBe('This model is not available for your account.');
    expect(result.category).toBe('permission_denied');
    expect(result.retryable).toBe(false);
  });

  it('classifies provider throttling as retryable', () => {
    const result = parseProviderError(429, JSON.stringify({ error: { message: 'Rate limited' } }));
    expect(result.category).toBe('rate_limited');
    expect(result.retryable).toBe(true);
  });

  it('does not echo a body containing credentials', () => {
    const result = parseProviderError(403, JSON.stringify({ error: { message: 'Bearer sk-secret-value-123456789 denied' } }));
    expect(result.message).not.toContain('sk-secret');
  });
});
