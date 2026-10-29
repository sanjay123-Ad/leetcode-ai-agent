import { NextResponse } from 'next/server';
import { evaluateHistoryAccess, HISTORY_COOKIE } from '@/lib/history-auth.ts';
import { config } from '@/lib/config.ts';

export const maxDuration = 15;

/**
 * Unlocks the dashboard's history panel for this browser.
 *
 *   /api/history/session?token=<HISTORY_API_TOKEN>   → sets the cookie, redirects to /
 *   /api/history/session?logout=1                    → clears it
 *
 * The cookie is HttpOnly, so the token is never readable from client JavaScript, and
 * SameSite=Lax so another site cannot cause it to be sent. It is set `secure` whenever the
 * request arrived over HTTPS.
 *
 * A server component cannot set cookies, which is why this lives in a route handler.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const home = new URL('/', url.origin);

  if (url.searchParams.get('logout') !== null) {
    const response = NextResponse.redirect(home);
    response.cookies.delete(HISTORY_COOKIE);
    return response;
  }

  const token = url.searchParams.get('token');
  const access = evaluateHistoryAccess(token);

  if (!access.allowed) {
    // The reason never echoes the presented value.
    return NextResponse.json({ success: false, error: access.reason }, { status: access.unconfigured ? 503 : 401 });
  }

  const response = NextResponse.redirect(home);
  response.cookies.set({
    name: HISTORY_COOKIE,
    value: config.historyApiToken() as string,
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
