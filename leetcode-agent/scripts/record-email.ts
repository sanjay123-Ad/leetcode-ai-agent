/**
 * Records the outcome of the notification step.
 *
 * Runs after the mail steps in CI, so the database says whether the email actually went
 * out. It is deliberately a separate process from the solve: if this fails, the solution
 * is already saved and the email has already been sent — only the status field is stale.
 *
 *   node scripts/record-email.ts <sent|failed|skipped> [execution-id]
 *
 * The id defaults to $EXECUTION_ID, then to the same value the solver would have derived
 * from the GitHub run, so the two always agree.
 */

import { executionId, updateEmailStatus, type EmailStatus } from '../src/lib/persistence.ts';
import { isEntryPoint } from './entry-point.ts';

const VALID: EmailStatus[] = ['sent', 'failed', 'skipped', 'pending'];

export function parseArgs(argv: string[]): { status: EmailStatus; id: string } | { error: string } {
  const [rawStatus, rawId] = argv;
  const status = (rawStatus ?? '').trim() as EmailStatus;

  if (!VALID.includes(status)) {
    return { error: `Usage: record-email.ts <${VALID.join('|')}> [execution-id]` };
  }

  const id = (rawId ?? process.env.EXECUTION_ID ?? '').trim() || executionId();
  return { status, id };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(`[record-email] ${parsed.error}`);
    return 1;
  }

  const { status, id } = parsed;
  const outcome = await updateEmailStatus(id, status);

  // A stale status is not worth failing the workflow over: the run itself succeeded and
  // the email was already delivered or not, independently of this call.
  console.log(`[record-email] ${outcome.ok ? 'ok' : 'warning'}: ${outcome.detail}`);
  if (!outcome.ok && process.env.GITHUB_ACTIONS) {
    console.log(`::warning::Email status for ${id} was not recorded: ${outcome.detail}`);
  }
  return 0;
}


if (isEntryPoint(import.meta.url)) {
  process.exitCode = await run();
}
