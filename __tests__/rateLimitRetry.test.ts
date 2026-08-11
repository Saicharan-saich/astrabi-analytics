import { describe, expect, it } from 'vitest';
import { getRateLimitRetryDelayMs } from '../services/ai-sql/modelConfig';

describe('AI rate-limit retry timing', () => {
  it('honours Retry-After seconds from the backend', () => {
    const response = { headers: new Headers({ 'Retry-After': '42' }) };
    expect(getRateLimitRetryDelayMs(response)).toBe(42_250);
  });

  it('falls back to a safe delay when timing headers are absent', () => {
    const response = { headers: new Headers() };
    expect(getRateLimitRetryDelayMs(response)).toBe(3_000);
  });
});
