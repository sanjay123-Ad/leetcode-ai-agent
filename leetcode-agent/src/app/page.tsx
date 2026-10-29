import AgentConsole from './agent-console.tsx';
import { readHistory } from '@/lib/persistence.ts';

// The run history changes between requests, so this page must not be prerendered at build
// time (that would bake in whatever history existed when the build ran).
export const dynamic = 'force-dynamic';

/**
 * Server component: reads the run history directly (no client fetch, no effect) and hands
 * it to the interactive console.
 */
export default async function Home() {
  const initialHistory = await readHistory(10);
  return <AgentConsole initialHistory={initialHistory} />;
}
