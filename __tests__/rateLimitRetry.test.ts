import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithFallback, getRateLimitRetryDelayMs } from '../services/ai-sql/modelConfig';

afterEach(() => {
  vi.useRealTimers();
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

  it('retries a transient benchmark provider failure after a ten-second quiet period', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => 'test-jwt' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary outage' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'SELECT 1' } }],
        usage: { total_tokens: 12 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchWithFallback(
      [{ role: 'user', content: 'benchmark transient retry' }],
      { requestPurpose: 'benchmark' },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toMatchObject({ model: 'openai/gpt-5.6-luna' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
