/**
 * Access control on the history endpoint.
 *
 * Solution history is private. The endpoint is deny-by-default: unset token means nobody
 * gets in, and there is no loopback exemption — a request from localhost is treated like
 * any other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/history/route.ts';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_testvalue';
  globalThis.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.HISTORY_API_TOKEN;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
});

const request = (headers: Record<string, string> = {}, url = 'http://localhost:3000/api/history') =>
  new Request(url, { headers });

describe('GET /api/history', () => {
  it('denies everyone when no token is configured', async () => {
    const res = await GET(request({ authorization: 'Bearer anything' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/HISTORY_API_TOKEN/);
  });

  it('rejects a request with no credentials', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const res = await GET(request({ authorization: 'Bearer wrong-token-of-same-len!' }));
    expect(res.status).toBe(401);
  });

  it('has no loopback exemption', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    for (const url of ['http://localhost:3000/api/history', 'http://127.0.0.1:3000/api/history']) {
      const res = await GET(request({}, url));
      expect(res.status).toBe(401);
    }
  });

  it('accepts the token as a bearer header', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const res = await GET(request({ authorization: 'Bearer correct-horse-battery-staple' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('accepts the token as x-history-token', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const res = await GET(request({ 'x-history-token': 'correct-horse-battery-staple' }));
    expect(res.status).toBe(200);
  });

  it('never echoes the token or the database key', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const res = await GET(request({ authorization: 'Bearer correct-horse-battery-staple' }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('correct-horse-battery-staple');
    expect(text).not.toContain('sb_secret_testvalue');
  });

  it('clamps the limit to a sane range', async () => {
    process.env.HISTORY_API_TOKEN = 'correct-horse-battery-staple';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await GET(request({ authorization: 'Bearer correct-horse-battery-staple' }, 'http://localhost:3000/api/history?limit=9999'));
    expect(calls[0]).toContain('limit=100');
  });
});
