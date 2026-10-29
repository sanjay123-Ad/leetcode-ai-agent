/**
 * Dashboard and API access control.
 *
 * The properties under test: stored solutions are never served to a visitor who has not
 * signed in — including one arriving from localhost, because `next dev` listens on every
 * interface — the credential never travels in a URL, and a session really does expire
 * server-side rather than only in the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  constantTimeEquals,
  credentialAccepted,
  evaluateHistoryAccess,
  mintSession,
  sessionTtlMs,
  HISTORY_COOKIE,
} from '../history-auth.ts';
import { GET as sessionGet, POST as sessionPost } from '../../app/api/history/session/route.ts';

const TOKEN = 'correct-horse-battery-staple';
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.HISTORY_API_TOKEN;
  delete process.env.HISTORY_SESSION_HOURS;
});

const login = (body: Record<string, string>, url = 'http://localhost:3000/api/history/session') => {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.append(k, v);
  return new Request(url, { method: 'POST', body: form });
};

describe('constantTimeEquals', () => {
  it('accepts an exact match and rejects everything else', () => {
    expect(constantTimeEquals(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEquals('correct-horse-battery-stapl3', TOKEN)).toBe(false);
    expect(constantTimeEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(constantTimeEquals('', TOKEN)).toBe(false);
    expect(constantTimeEquals(null, TOKEN)).toBe(false);
    expect(constantTimeEquals(TOKEN, null)).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    expect(() => constantTimeEquals('short', 'a much longer value entirely')).not.toThrow();
    expect(constantTimeEquals('short', 'a much longer value entirely')).toBe(false);
  });
});

describe('evaluateHistoryAccess', () => {
  it('denies everyone when no token is configured', () => {
    const access = evaluateHistoryAccess(mintSession(TOKEN));
    expect(access).toMatchObject({ allowed: false, unconfigured: true });
    expect(access.reason).toMatch(/HISTORY_API_TOKEN is not configured/);
  });

  it('denies a visitor with no session', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess(undefined).allowed).toBe(false);
    expect(evaluateHistoryAccess('').allowed).toBe(false);
  });

  it('allows a freshly minted session', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess(mintSession(TOKEN)).allowed).toBe(true);
  });

  it('rejects a session signed with a different token', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(evaluateHistoryAccess(mintSession('some-other-token-entirely')).allowed).toBe(false);
  });

  it('rejects a tampered signature or timestamp', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const session = mintSession(TOKEN);
    const [issued, signature] = session.split('.');

    expect(evaluateHistoryAccess(`${issued}.${'0'.repeat(signature.length)}`).allowed).toBe(false);
    // Moving the timestamp forward invalidates the signature over it.
    expect(evaluateHistoryAccess(`${Number(issued) + 1}.${signature}`).allowed).toBe(false);
    expect(evaluateHistoryAccess('not-a-session').allowed).toBe(false);
    expect(evaluateHistoryAccess(signature).allowed).toBe(false);
  });

  it('expires a session server-side once it is older than the TTL', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const issuedAt = Date.now();
    const session = mintSession(TOKEN, issuedAt);

    expect(evaluateHistoryAccess(session, issuedAt + sessionTtlMs() - 1000).allowed).toBe(true);

    const expired = evaluateHistoryAccess(session, issuedAt + sessionTtlMs() + 1000);
    expect(expired.allowed).toBe(false);
    expect(expired.expired).toBe(true);
    expect(expired.reason).toMatch(/expired/i);
  });

  it('rejects a session dated in the future', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const future = Date.now() + 60_000;
    expect(evaluateHistoryAccess(mintSession(TOKEN, future), Date.now()).allowed).toBe(false);
  });

  it('honours HISTORY_SESSION_HOURS', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    process.env.HISTORY_SESSION_HOURS = '1';
    expect(sessionTtlMs()).toBe(60 * 60 * 1000);

    const issuedAt = Date.now();
    const session = mintSession(TOKEN, issuedAt);
    expect(evaluateHistoryAccess(session, issuedAt + 90 * 60 * 1000).expired).toBe(true);
  });

  it('never echoes a credential in the reason shown to a visitor', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    for (const value of [undefined, 'some-wrong-value-entirely', mintSession('other-token')]) {
      const { reason } = evaluateHistoryAccess(value);
      expect(reason).not.toContain(TOKEN);
      if (value) expect(reason).not.toContain(value);
    }
  });
});

describe('the cookie is a session, not the token', () => {
  it('does not contain the token in any form', () => {
    const session = mintSession(TOKEN);
    expect(session).not.toContain(TOKEN);
    expect(Buffer.from(session, 'utf8').toString('base64')).not.toContain(Buffer.from(TOKEN).toString('base64'));
  });
});

describe('credentialAccepted', () => {
  it('is false when nothing is configured', () => {
    expect(credentialAccepted(TOKEN)).toBe(false);
  });

  it('accepts only the exact token', () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    expect(credentialAccepted(TOKEN)).toBe(true);
    expect(credentialAccepted('nearly-the-right-token-xx')).toBe(false);
    expect(credentialAccepted('')).toBe(false);
  });
});

describe('POST /api/history/session', () => {
  it('refuses to sign anyone in when no token is configured', async () => {
    const res = await sessionPost(login({ token: TOKEN }));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a wrong credential and sets nothing', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(login({ token: 'wrong-value-entirely' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('issues an HttpOnly, SameSite=Lax session for the right credential', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(login({ token: TOKEN }));

    expect(res.status).toBe(303);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${HISTORY_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=43200/); // 12 hours
    // Plain http in this test, so the secure flag must not be set spuriously.
    expect(cookie).not.toMatch(/Secure/i);
    // And the cookie must not carry the token itself.
    expect(cookie).not.toContain(TOKEN);
  });

  it('marks the cookie secure over https, and behind an https proxy', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;

    const direct = await sessionPost(login({ token: TOKEN }, 'https://example.test/api/history/session'));
    expect(direct.headers.get('set-cookie') ?? '').toMatch(/Secure/i);

    const form = new FormData();
    form.append('token', TOKEN);
    const proxied = await sessionPost(
      new Request('http://example.test/api/history/session', {
        method: 'POST',
        body: form,
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(proxied.headers.get('set-cookie') ?? '').toMatch(/Secure/i);
  });

  it('clears the session on logout', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(login({ intent: 'logout' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i);
  });

  it('issues a session that the evaluator then accepts', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(login({ token: TOKEN }));
    const value = (res.headers.get('set-cookie') ?? '').split(';')[0].split('=').slice(1).join('=');
    expect(evaluateHistoryAccess(decodeURIComponent(value)).allowed).toBe(true);
  });

  it('does not leak the token in an error body', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(login({ token: 'wrong-value-entirely' }));
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('rejects a non-form body rather than crashing', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionPost(
      new Request('http://localhost:3000/api/history/session', {
        method: 'POST',
        body: 'not a form',
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/history/session', () => {
  it('is refused, because a credential must never travel in a URL', async () => {
    process.env.HISTORY_API_TOKEN = TOKEN;
    const res = await sessionGet();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
