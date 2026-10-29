/**
 * Dashboard and API access control.
 *
 * The property under test: stored solutions are never served to a visitor who has not
 * presented the token — including one arriving from localhost, because `next dev` listens
 * on every interface and "it's local" is not a security boundary on a shared network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateHistoryAccess, tokensMatch, HISTORY_COOKIE } from '../history-auth.ts';
import { GET as sessionRoute } from '../../app/api/history/session/route.ts';

const TOKEN = 'correct-horse-battery-staple';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.HISTORY_API_TOKEN;
});

describe('tokensMatch', () => {
  it('accepts an exact match and rejects everything else', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('correct-horse-battery-stapl3', TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
    expect(tokensMatch(null, TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
  });

  it('rejects a prefix of the right token', () => {
    expect(tokensMatch(TOKEN.slice(0, -1), TOKEN)).toBe(false);
  });
});

describe('evaluateHistoryAccess', () => {
  it('denies everyone when no token is configured', () => {
    const access = evaluateHistoryAccess(TOKEN);
    expect(access).toMatchObject({ allowed: false, unconfigured: true });
    expect(access.reason).toMatch(/HISTORY_API_TOKEN is not configured/);
  });

  it('denies a visitor with no credential', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess(undefined).allowed).toBe(false);
  });

  it('denies a wrong credential', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess('nope-nope-nope-nope-nope-nop').allowed).toBe(false);
  });

  it('allows the right credential', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess(TOKEN).allowed).toBe(true);
  });

  it('never echoes either value in the reason shown to a visitor', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    for (const presented of [undefined, 'some-wrong-value-entirely-xx']) {
      const { reason } = evaluateHistoryAccess(presented);
      expect(reason).not.toContain(TOKEN);
      if (presented) expect(reason).not.toContain(presented);
    }
  });
});

describe('GET /api/history/session', () => {
  const request = (query: string) => new Request(`http://localhost:3000/api/history/session${query}`);

  it('refuses to issue a cookie when no token is configured', async () => {
    const res = await sessionRoute(request(`?token=${TOKEN}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a wrong token and sets nothing', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionRoute(request('?token=wrong-value-wrong-value-xx'));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('issues an HttpOnly, SameSite=Lax cookie for the right token', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionRoute(request(`?token=${TOKEN}`));

    expect(res.status).toBe(307);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${HISTORY_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    // Plain http in this test, so the secure flag must not be set spuriously.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('marks the cookie secure over https', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionRoute(new Request(`https://example.test/api/history/session?token=${TOKEN}`));
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Secure/i);
  });

  it('clears the cookie on logout', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionRoute(request('?logout=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/history_token=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('does not leak the token in an error body', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionRoute(request('?token=wrong-value-wrong-value-xx'));
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });
});
