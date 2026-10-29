/**
 * Access control for solution history.
 *
 * Shared by the API route and the server-rendered dashboard so both answer the same
 * question the same way. Deny by default: with no `HISTORY_API_TOKEN` configured, neither
 * surface serves history to anyone, and there is no loopback exemption — `next dev` binds
 * to every interface, so "it's only localhost" is not true on a shared network.
 *
 * The cookie is a signed session, not the token itself:
 *
 *     <issued-at-ms>.<hmac-sha256(issued-at, token)>
 *
 * Two reasons. A cookie that leaks (a proxy log, a shared browser profile) does not hand
 * over the token that also authenticates the API. And the signed timestamp gives real
 * server-side expiry — clearing the browser's copy is not what ends the session, the
 * server refusing a stale one is.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

/** Cookie holding the signed session. */
export const HISTORY_COOKIE = 'history_session';

/** Sessions expire this long after they are issued. Override with HISTORY_SESSION_HOURS. */
export function sessionTtlMs(): number {
  const hours = Number(process.env.HISTORY_SESSION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

/** Length-independent comparison, so a credential cannot be recovered by timing. */
export function constantTimeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on differing lengths, which would itself leak length; compare a
  // fixed-size digest instead so every input takes the same path.
  const leftDigest = createHmac('sha256', 'compare').update(left).digest();
  const rightDigest = createHmac('sha256', 'compare').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sign(issuedAt: string, token: string): string {
  return createHmac('sha256', token).update(issuedAt).digest('hex');
}

/** Issues a session for a caller that has already proven it knows the token. */
export function mintSession(token: string, now: number = Date.now()): string {
  const issuedAt = String(now);
  return `${issuedAt}.${sign(issuedAt, token)}`;
}

export type HistoryAccess = {
  allowed: boolean;
  /** Safe to show a visitor: never repeats a presented or expected credential. */
  reason: string;
  /** True when the deployment has no token at all — a configuration state, not a rejection. */
  unconfigured: boolean;
  /** True when the session was valid but too old, so the UI can say "sign in again". */
  expired: boolean;
};

const deny = (reason: string, extra: Partial<HistoryAccess> = {}): HistoryAccess => ({
  allowed: false,
  unconfigured: false,
  expired: false,
  reason,
  ...extra,
});

/** Validates a session cookie. */
export function evaluateHistoryAccess(cookieValue: string | null | undefined, now: number = Date.now()): HistoryAccess {
  const token = config.historyApiToken();

  if (!token) {
    return deny(
      'History is locked: HISTORY_API_TOKEN is not configured, so stored solutions are not served to anyone.',
      { unconfigured: true },
    );
  }

  if (!cookieValue) return deny('History is locked: sign in to view stored solutions.');

  const separator = cookieValue.lastIndexOf('.');
  if (separator <= 0) return deny('History is locked: the session is malformed.');

  const issuedAt = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);

  if (!/^\d+$/.test(issuedAt) || !constantTimeEquals(signature, sign(issuedAt, token))) {
    return deny('History is locked: the session could not be verified.');
  }

  const age = now - Number(issuedAt);
  if (age < 0 || age > sessionTtlMs()) {
    return deny('History is locked: the session has expired. Sign in again.', { expired: true });
  }

  return { allowed: true, unconfigured: false, expired: false, reason: 'Authenticated.' };
}

/** Checks a submitted password against the configured token. */
export function credentialAccepted(submitted: string | null | undefined): boolean {
  const token = config.historyApiToken();
  return Boolean(token) && constantTimeEquals(submitted, token);
}
