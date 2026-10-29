/**
 * Replays records that could not reach Supabase at the time of the run.
 *
 * When a save fails, the record is parked as `pending-persist/<execution_id>.json` and
 * uploaded as a workflow artifact. Download that artifact into the project (or point
 * AGENT_PENDING_DIR at it) and run:
 *
 *   node scripts/replay-persistence.ts
 *
 * Upserts are keyed by execution_id, so replaying is idempotent: a record that already
 * landed is updated in place rather than duplicated, and running this twice is harmless.
 */

import { replayPendingRecords } from '../src/lib/persistence.ts';
import { configStatus } from '../src/lib/config.ts';

export async function run(): Promise<number> {
  if (!configStatus().supabaseWritable) {
    console.error(
      '[replay] No server-side Supabase key is configured. Set SUPABASE_SECRET_KEY (or ' +
        'SUPABASE_SERVICE_ROLE_KEY) and SUPABASE_URL, then run this again.',
    );
    return 1;
  }

  const { attempted, saved, details } = await replayPendingRecords();

  if (attempted === 0) {
    console.log('[replay] Nothing to replay: no parked records found.');
    return 0;
  }

  for (const line of details) console.log(`  ${line}`);
  console.log(`[replay] ${saved}/${attempted} record(s) saved; the rest remain parked for a later attempt.`);

  // A partial replay is not a failure of this command - the records are still safe on disk.
  return saved === attempted ? 0 : 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url.endsWith(entry.replace(/\\/g, '/')));
}

if (isEntryPoint()) {
  process.exitCode = await run();
}
