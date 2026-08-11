import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithFallback, getRateLimitRetryDelayMs } from '../services/ai-sql/modelConfig';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI rate-limit retry timing', () => {
  it('honours Retry-After seconds from the backend', () => {
    const response = { headers: new Headers({ 'Retry-After': '42' }) };
    expect(getRateLimitRetryDelayMs(response)).toBe(42_250);
  });

  it('falls back to a safe delay when timing headers are absent', () => {
    const response = { headers: new Headers() };
    expect(getRateLimitRetryDelayMs(response)).toBe(3_000);
  });

  it('marks only explicit Benchmark Lab model calls with the admin benchmark purpose', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'test-jwt' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: 'SELECT 1' } }],
      usage: { total_tokens: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithFallback(
      [{ role: 'user', content: 'benchmark test' }],
      { requestPurpose: 'benchmark' },
    );

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect((request.headers as Record<string, string>)['X-QuickInsight-AI-Purpose']).toBe('benchmark');
  });
});
