/**
 * Access control for solution history.
 *
 * Shared by the API route and the server-rendered dashboard so both answer the same
 * question the same way. Deny by default: with no `HISTORY_API_TOKEN` configured, neither
 * surface serves history to anyone, and there is no loopback exemption — `next dev` binds
 * to every interface, so "it's only localhost" is not true on a shared network.
 */

import { config } from './config.ts';

/** Cookie the dashboard uses once a visitor has presented the token once. */
export const HISTORY_COOKIE = 'history_token';

/** Length-independent comparison, so the token cannot be recovered by timing. */
export function tokensMatch(presented: string | null | undefined, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export type HistoryAccess = {
  allowed: boolean;
  /** Safe to show a visitor: never repeats the presented or expected value. */
  reason: string;
  /** True when the deployment has no token at all, which is a configuration state, not a rejection. */
  unconfigured: boolean;
};

export function evaluateHistoryAccess(presented: string | null | undefined): HistoryAccess {
  const expected = config.historyApiToken();

  if (!expected) {
    return {
      allowed: false,
      unconfigured: true,
      reason:
        'History is locked: HISTORY_API_TOKEN is not configured, so stored solutions are not served to anyone.',
    };
  }

  if (!presented) {
    return { allowed: false, unconfigured: false, reason: 'History is locked: no credential presented.' };
  }

  return tokensMatch(presented, expected)
    ? { allowed: true, unconfigured: false, reason: 'Authenticated.' }
    : { allowed: false, unconfigured: false, reason: 'History is locked: the credential did not match.' };
}
