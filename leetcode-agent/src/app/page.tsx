import { cookies } from 'next/headers';
import AgentConsole from './agent-console.tsx';
import { readHistory } from '@/lib/persistence.ts';
import { evaluateHistoryAccess, HISTORY_COOKIE } from '@/lib/history-auth.ts';

// The run history changes between requests, so this page must not be prerendered at build
// time (that would bake in whatever history existed when the build ran).
export const dynamic = 'force-dynamic';

/**
 * Server component for the agent console.
 *
 * Stored solutions are private, so the history panel is gated by the same token the API
 * uses, checked here against an HttpOnly cookie. Without it the page still works — you can
 * solve problems — it just does not read or render anyone's history. `next dev` listens on
 * every interface, so an unauthenticated visitor on the same network would otherwise see
 * the lot.
 *
 * Unlock a browser once with /api/history/session?token=<HISTORY_API_TOKEN>.
 */
export default async function Home() {
  const jar = await cookies();
  const access = evaluateHistoryAccess(jar.get(HISTORY_COOKIE)?.value);

  // readHistory is not even called when access is denied: no privileged query is issued
  // and nothing private crosses into the client component.
  const initialHistory = access.allowed
    ? await readHistory(10)
    : { source: 'locked', entries: [], detail: access.reason };

  return <AgentConsole initialHistory={initialHistory} />;
}
