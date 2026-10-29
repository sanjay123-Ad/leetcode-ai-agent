/**
 * Reconstructs the runs that were never saved (2026-10-15 .. 2026-10-28).
 *
 * What was investigated, and what each source actually preserves:
 *
 *   GitHub Actions logs  - still present for all 14 runs. They give the problem title,
 *                          difficulty, the old pass/fail claim and the attempt count.
 *                          They do NOT contain the Java code: the previous solver never
 *                          printed it.
 *   Run artifacts        - none exist. The old workflow had no upload step.
 *   Success emails       - the ONLY place those 14 solutions survive in full.
 *
 * So this tool reads whichever of those you can supply and writes honest rows: a record
 * recovered from a log has no `solution_code`, and every recovered row is marked with a
 * `recovery_note`, `source = recovered-*` and `verification_status = legacy_unverified`.
 * Nothing is re-solved and nothing is invented — a missing solution stays missing.
 *
 *   # 1. metadata from logs
 *   gh run view <run-id> --log > oct20.log
 *   node scripts/recover-history.ts --from-logs oct20.log
 *
 *   # 2. full solutions from saved emails (File > Save as, or .eml export)
 *   node scripts/recover-history.ts --from-email ./saved-emails
 *
 *   # add --write to actually upsert; without it the tool only reports.
 */

import { htmlToText, decodeEntities } from '../src/lib/html.ts';
import { saveRun, type AgentRunRecord } from '../src/lib/persistence.ts';
import { configStatus } from '../src/lib/config.ts';

export type RecoveredRun = {
  date?: string;
  title: string;
  difficulty?: string;
  attempts?: number;
  legacyClaimedPass?: boolean;
  solutionCode?: string;
  sourceLabel: 'recovered-from-logs' | 'recovered-from-email';
  sourceFile: string;
};

/* ------------------------------------------------------------------ *
 * Parsers (pure, so they are unit-testable)                           *
 * ------------------------------------------------------------------ */

/** Extracts what a pre-upgrade workflow log preserves. Returns undefined if it is not one. */
export function parseLegacyLog(text: string, sourceFile = 'log'): RecoveredRun | undefined {
  const problem = /Today's problem:\s*(.+?)\s*\(([A-Za-z]+)\)/.exec(text);
  if (!problem) return undefined;

  const attempts = /Attempts\s*:\s*(\d+)/.exec(text);
  const passed = /Status\s*:\s*[^\n]*PASSED/.test(text);
  const failed = /Status\s*:\s*[^\n]*FAILED/.test(text);
  // Log lines are timestamped `2026-10-20T07:50:02.123Z <text>`.
  const date = /(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(text);

  return {
    date: date?.[1],
    title: problem[1].trim(),
    difficulty: problem[2].trim(),
    attempts: attempts ? Number(attempts[1]) : undefined,
    legacyClaimedPass: passed ? true : failed ? false : undefined,
    sourceLabel: 'recovered-from-logs',
    sourceFile,
  };
}

/**
 * Extracts a run from a saved success email. The old template put the problem on a
 * `<strong>Problem:</strong> …` line and the Java inside a single `<pre>` block.
 */
export function parseLegacyEmail(html: string, sourceFile = 'email'): RecoveredRun | undefined {
  const problem =
    /Problem:\s*<\/strong>\s*([^<(]+?)\s*\(([A-Za-z]+)\)/.exec(html) ??
    /Problem:\s*([^<(\n]+?)\s*\(([A-Za-z]+)\)/.exec(htmlToText(html));
  if (!problem) return undefined;

  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  const code = pre ? decodeEntities(pre[1].replace(/<[^>]+>/g, '')).trim() : undefined;

  const date = /Date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(html);

  return {
    date: date?.[1],
    title: problem[1].trim(),
    difficulty: problem[2].trim(),
    // A solution that is not actually in the file must not be invented.
    solutionCode: code && /class\s+\w+/.test(code) ? code : undefined,
    sourceLabel: 'recovered-from-email',
    sourceFile,
  };
}

/** Turns a recovered run into a row. Deliberately conservative about what it claims. */
export function toRecoveredRecord(run: RecoveredRun): AgentRunRecord {
  const slug = run.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = run.date ?? 'unknown-date';

  return {
    execution_id: `recovered-${stamp}-${slug}`.slice(0, 160),
    source: run.sourceLabel,
    title: run.title,
    title_slug: slug || undefined,
    difficulty: run.difficulty,
    problem_url: slug ? `https://leetcode.com/problems/${slug}/` : undefined,
    solution_code: run.solutionCode,
    // The old pipeline's verdict came from a harness the model wrote for itself, so it
    // cannot be promoted to any rung of the verification ladder.
    verification_status: 'legacy_unverified',
    attempts: run.attempts,
    email_status: 'sent',
    recovery_note:
      `Reconstructed from ${run.sourceLabel === 'recovered-from-logs' ? 'GitHub Actions logs' : 'the success email'} ` +
      `(${run.sourceFile}). The original run was never saved because Supabase was unreachable. ` +
      (run.solutionCode ? 'Solution text is the one that was emailed at the time. ' : 'No solution text was available in this source. ') +
      (run.legacyClaimedPass === undefined
        ? ''
        : `The old pipeline reported ${run.legacyClaimedPass ? 'PASSED' : 'FAILED'}, which was self-certified and is not a verification result.`),
  };
}

/* ------------------------------------------------------------------ *
 * CLI                                                                 *
 * ------------------------------------------------------------------ */

async function collect(path: string, mode: 'logs' | 'email'): Promise<RecoveredRun[]> {
  const [fs, nodePath] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  const stat = await fs.stat(path);
  const files = stat.isDirectory()
    ? (await fs.readdir(path)).map((name) => nodePath.join(path, name))
    : [path];

  const out: RecoveredRun[] = [];
  for (const file of files) {
    if (!/\.(log|txt|html|htm|eml)$/i.test(file)) continue;
    const text = await fs.readFile(file, 'utf8');
    const parsed = mode === 'logs' ? parseLegacyLog(text, nodePath.basename(file)) : parseLegacyEmail(text, nodePath.basename(file));
    if (parsed) out.push(parsed);
    else console.warn(`[recover] could not parse ${nodePath.basename(file)} - skipped`);
  }
  return out;
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const write = argv.includes('--write');
  const logsIndex = argv.indexOf('--from-logs');
  const emailIndex = argv.indexOf('--from-email');

  if (logsIndex < 0 && emailIndex < 0) {
    console.error('Usage: recover-history.ts (--from-logs <file|dir> | --from-email <file|dir>) [--write]');
    return 1;
  }

  const runs: RecoveredRun[] = [];
  if (logsIndex >= 0) runs.push(...(await collect(argv[logsIndex + 1], 'logs')));
  if (emailIndex >= 0) runs.push(...(await collect(argv[emailIndex + 1], 'email')));

  if (runs.length === 0) {
    console.log('[recover] Nothing recoverable was found in the supplied files.');
    return 0;
  }

  console.log(`[recover] ${runs.length} run(s) found:`);
  for (const r of runs) {
    console.log(
      `  ${r.date ?? '????-??-??'}  ${r.title} (${r.difficulty ?? '?'})  ` +
        `${r.solutionCode ? `solution: ${r.solutionCode.length} chars` : 'solution: NOT AVAILABLE'}`,
    );
  }

  if (!write) {
    console.log('\n[recover] Dry run. Re-run with --write to upsert these rows.');
    return 0;
  }

  if (!configStatus().supabaseWritable) {
    console.error('[recover] No server-side Supabase key configured; refusing to write.');
    return 1;
  }

  let saved = 0;
  for (const r of runs) {
    const outcome = await saveRun(toRecoveredRecord(r));
    console.log(`  ${outcome.ok ? 'saved  ' : 'FAILED '} ${r.title}: ${outcome.detail}`);
    if (outcome.ok) saved++;
  }
  console.log(`[recover] ${saved}/${runs.length} recovered row(s) written. The 37 original records were not touched.`);
  return saved === runs.length ? 0 : 1;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url.endsWith(entry.replace(/\\/g, '/')));
}

if (isEntryPoint()) {
  process.exitCode = await run();
}
