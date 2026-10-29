import { NextResponse } from 'next/server';
import { readHistory } from '@/lib/persistence.ts';
import { config } from '@/lib/config.ts';

export const maxDuration = 30;

/** Length-independent comparison, so the token cannot be probed by timing. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Recent runs, for programmatic access.
 *
 * Solution history is private, so this endpoint is **deny by default**: without
 * `HISTORY_API_TOKEN` configured it serves nobody, and with it configured it requires
 * `Authorization: Bearer <token>` (or `x-history-token`). There is no loopback exemption —
 * an unauthenticated request from localhost is refused like any other.
 *
 * The dashboard does not use this route: its panel is rendered by a server component that
 * reads the database directly, so no token is ever sent to the browser.
 */
export async function GET(req: Request) {
  const expected = config.historyApiToken();

  if (!expected) {
    return NextResponse.json(
      {
        success: false,
        error:
          'History access is not configured. Set HISTORY_API_TOKEN to enable this endpoint; until then it serves no one.',
      },
      { status: 503 },
    );
  }

  const header = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-history-token');
  if (!tokenMatches(header, expected)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const requested = Number(new URL(req.url).searchParams.get('limit') ?? 20);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;

  return NextResponse.json({ success: true, data: await readHistory(limit) });
}
