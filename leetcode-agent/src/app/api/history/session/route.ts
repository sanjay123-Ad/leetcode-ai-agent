import { NextResponse } from 'next/server';
import { config } from '@/lib/config.ts';
import { credentialAccepted, mintSession, sessionTtlMs, HISTORY_COOKIE } from '@/lib/history-auth.ts';

export const maxDuration = 15;

/**
 * Sign-in and sign-out for the dashboard's history panel.
 *
 * **POST only.** The token never travels in a URL: query strings are written to server and
 * proxy access logs, kept in browser history, and leak through the Referer header on any
 * outbound link. It arrives as form data instead, and what comes back is a signed session
 * rather than the token itself.
 *
 *   POST /api/history/session   token=<HISTORY_API_TOKEN>   → sets the session cookie
 *   POST /api/history/session   intent=logout               → clears it
 *
 * A server component cannot set cookies, which is why this lives in a route handler.
 */
export async function POST(req: Request) {
  const home = new URL('/', new URL(req.url).origin);
  const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ success: false, error: 'Expected a form submission.' }, { status: 400 });
  }

  if (String(form.get('intent') ?? '') === 'logout') {
    const response = NextResponse.redirect(home, { status: 303 });
    response.cookies.set({ name: HISTORY_COOKIE, value: '', httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 });
    return response;
  }

  const token = config.historyApiToken();
  if (!token) {
    return NextResponse.json(
      { success: false, error: 'History access is not configured. Set HISTORY_API_TOKEN to enable it.' },
      { status: 503 },
    );
  }

  if (!credentialAccepted(String(form.get('token') ?? ''))) {
    // The message never echoes what was submitted or expected.
    return NextResponse.json({ success: false, error: 'Invalid credential.' }, { status: 401 });
  }

  const response = NextResponse.redirect(home, { status: 303 });
  response.cookies.set({
    name: HISTORY_COOKIE,
    value: mintSession(token),
    httpOnly: true,       // unreadable from client JavaScript
    sameSite: 'lax',      // not sent on cross-site POSTs
    secure,               // https only, when the request arrived over https
    path: '/',
    maxAge: Math.floor(sessionTtlMs() / 1000),
  });
  return response;
}

/** The token must never appear in a URL, so there is no GET sign-in. */
export async function GET() {
  return NextResponse.json(
    { success: false, error: 'Use POST with form data. Credentials must not travel in a URL.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
