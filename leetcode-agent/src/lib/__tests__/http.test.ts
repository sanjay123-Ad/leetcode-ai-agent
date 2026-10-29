import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, requestJson } from '../http.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponses(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let index = 0;

  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    // Clone, so the same scripted response can be served to more than one attempt
    // (a Response body can only be consumed once).
    return next.clone();
  }) as unknown as typeof fetch;

  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('backoffDelay', () => {
  it('grows with the attempt number and stays under the cap', () => {
    const first = backoffDelay(1);
    const later = backoffDelay(5);
    expect(first).toBeGreaterThan(0);
    expect(later).toBeGreaterThanOrEqual(first);
    expect(backoffDelay(50)).toBeLessThanOrEqual(8000);
  });
});

describe('requestJson', () => {
  it('parses a successful JSON response', async () => {
    mockResponses([json({ hello: 'world' })]);
    const result = await requestJson<{ hello: string }>('https://example.test/x');
    expect(result).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(result.data).toEqual({ hello: 'world' });
  });

  it('retries a 503 and then succeeds — the failure mode that killed the old pipeline', async () => {
    const retries: number[] = [];
    mockResponses([json({ error: 'overloaded' }, 503), json({ ok: true })]);

    const result = await requestJson('https://example.test/x', {
      retries: 3,
      onRetry: ({ attempt }) => retries.push(attempt),
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(retries).toEqual([1]);
  });

  it('retries a 429 up to the limit and reports the last response', async () => {
    mockResponses([json({ message: 'rate limited' }, 429)]);
    const result = await requestJson('https://example.test/x', { retries: 2 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(2);
  });

  it('does not retry a 400', async () => {
    mockResponses([json({ message: 'bad request' }, 400)]);
    const result = await requestJson('https://example.test/x', { retries: 4 });
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(400);
  });

  it('honours a custom retryOn list', async () => {
    mockResponses([json({ message: 'quota' }, 429)]);
    const result = await requestJson('https://example.test/x', { retries: 3, retryOn: [500] });
    expect(result.attempts).toBe(1);
  });

  it('reports a transport error instead of throwing', async () => {
    mockResponses([new TypeError('fetch failed')]);
    const result = await requestJson('https://example.test/x', { retries: 1 });
    expect(result.ok).toBe(false);
    expect(result.transportError).toContain('fetch failed');
    expect(result.status).toBe(0);
  });

  it('keeps a non-JSON body available for diagnostics', async () => {
    mockResponses([new Response('<html>nope</html>', { status: 502 })]);
    const result = await requestJson('https://example.test/x', { retries: 1 });
    expect(result.data).toBeUndefined();
    expect(result.body).toContain('nope');
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    mockResponses([new DOMException('Aborted', 'AbortError')]);

    const result = await requestJson('https://example.test/x', { retries: 5, signal: controller.signal });
    expect(result.attempts).toBe(1);
    expect(result.transportError).toContain('Abort');
  });

  it('passes a timeout signal on every attempt', async () => {
    const calls = mockResponses([json({ ok: true })]);
    await requestJson('https://example.test/x', { timeoutMs: 1234 });
    expect(calls[0].init?.signal).toBeDefined();
  });
});
