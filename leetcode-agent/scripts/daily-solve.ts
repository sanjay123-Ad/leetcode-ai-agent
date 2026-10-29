/**
 * Daily solver for CI and the local scheduler.
 *
 * This is the same pipeline the web app uses — imported, not re-implemented. The previous
 * `standalone-solver.mjs` carried its own copy of every prompt and its own Judge0 call, so
 * the two code paths drifted apart (audit finding: four copies of the same four prompts).
 *
 * Runs on Node's native TypeScript support (Node 22.18+ / 24+), so no build step is needed.
 */

import { fetchDailyChallenge, fetchProblemBySlug } from '../src/lib/leetcode.ts';
import { solveProblem, type SolveOutput } from '../src/lib/pipeline.ts';
import { buildRunRecord, executionId, saveRun, type PersistenceResult } from '../src/lib/persistence.ts';
import { configStatus } from '../src/lib/config.ts';
import { selectRunner } from '../src/lib/runner/index.ts';
import { STATUS_LABELS } from '../src/lib/api-types.ts';
import { isEntryPoint } from './entry-point.ts';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmail(result: SolveOutput, persistence: PersistenceResult): string {
  const checks = Object.entries(result.checks)
    .map(([key, value]) => `<li>${value ? '✅' : '⬜'} ${escapeHtml(key)}</li>`)
    .join('\n');

  const banner = result.submissionReady
    ? { color: '#059669', text: 'Verified against LeetCode&rsquo;s official examples' }
    : { color: '#b45309', text: `Not verified: ${escapeHtml(result.status)}` };

  return `<div style="font-family: sans-serif; max-width: 820px; margin: 0 auto; color: #333;">
  <h2 style="color: ${banner.color};">${banner.text}</h2>
  <p><strong>Problem:</strong> ${escapeHtml(result.problem.questionFrontendId ?? '')}. ${escapeHtml(result.problem.title)} (${escapeHtml(result.problem.difficulty)})</p>
  <p><strong>Verification status:</strong> ${escapeHtml(STATUS_LABELS[result.status])}</p>
  <p><strong>Why:</strong> ${escapeHtml(result.readinessReason)}</p>
  <ul style="list-style: none; padding-left: 0;">${checks}</ul>
  <p><strong>Required interface:</strong> <code>${escapeHtml(result.contract ?? 'unknown')}</code></p>
  <p><strong>Time complexity:</strong> <code>${escapeHtml(result.explanation?.timeComplexity ?? result.analysis?.expectedTimeComplexity ?? 'n/a')}</code><br/>
     <strong>Space complexity:</strong> <code>${escapeHtml(result.explanation?.spaceComplexity ?? result.analysis?.expectedSpaceComplexity ?? 'n/a')}</code></p>
  <h3 style="border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">Java solution</h3>
  <pre style="background:#1f2937;color:#f3f4f6;padding:16px;border-radius:8px;font-family:monospace;overflow-x:auto;">
${escapeHtml(result.finalCode || '// no code was produced')}
  </pre>
  <p style="color:#6b7280;font-style:italic;">
    ${
      result.submissionReady
        ? 'Signature matches the official template and every official example passes. Hidden LeetCode tests are still unproven.'
        : 'Do not submit this without reading the status above.'
    }
  </p>
  <p style="color:#6b7280;font-size:12px;">
    ${result.usage.geminiCalls} model call(s), ${result.usage.judge0Submissions} Judge0 submission(s),
    ${result.usage.promptTokens + result.usage.outputTokens} tokens, ${Math.round(result.usage.elapsedMs / 1000)}s.
  </p>
  <p style="color:${persistence.ok ? '#6b7280' : '#b91c1c'};font-size:12px;">
    <strong>Database:</strong> ${escapeHtml(persistence.detail)}
  </p>
</div>`;
}

async function main() {
  const slugArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

  const status = configStatus();
  if (!status.gemini) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const runner = await selectRunner('auto');
  console.log(`[daily] runner: ${runner?.name ?? 'none available'} | model: ${status.model}`);
  if (!runner) {
    console.warn('[daily] No JDK on PATH and no JUDGE0_API_KEY: solutions can be signature-checked but not executed.');
  }

  const problem = slugArg ? await fetchProblemBySlug(slugArg) : await fetchDailyChallenge();
  if (!problem) throw new Error(`No LeetCode problem record for "${slugArg}"`);
  knownProblem = problem;

  console.log(`[daily] ${problem.questionFrontendId ?? '?'}. ${problem.title} (${problem.difficulty})`);
  if (!problem.provenance.hasJavaSnippet) {
    console.warn('[daily] No official Java template: the result cannot be called submission-ready.');
  }

  const result = await solveProblem(problem);

  // Save BEFORE the notification: persistence must never depend on email delivery, and
  // email must never depend on persistence. The email status is written back afterwards
  // by scripts/record-email.ts, keyed by this same execution id.
  const id = executionId(problem.titleSlug);
  currentExecutionId = id;
  const persistence = await saveRun(
    buildRunRecord(result, {
      source: process.env.GITHUB_RUN_ID ? 'github-actions' : 'cli',
      executionId: id,
      model: status.model,
    }),
  );

  if (persistence.ok) {
    console.log(`[daily] database: ${persistence.detail}`);
  } else {
    // Never claim a save that did not happen.
    console.error(`[daily] database: NOT SAVED - ${persistence.detail}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::warning::Run was not saved to Supabase: ${persistence.detail}`);
    }
  }

  console.log('\n==============================================');
  console.log('RESULT');
  console.log(`Problem        : ${problem.title}`);
  console.log(`Difficulty     : ${problem.difficulty}`);
  console.log(`Status         : ${result.status} (${STATUS_LABELS[result.status]})`);
  console.log(`Submission-ready: ${result.submissionReady ? 'yes' : 'no'} — ${result.readinessReason}`);
  console.log(`Attempts       : ${result.attempts.length}`);
  console.log(`Execution id   : ${id}`);
  console.log(`Database       : ${persistence.ok ? 'saved' : 'NOT SAVED - ' + persistence.detail}`);
  console.log(
    `Cost           : ${result.usage.geminiCalls} model call(s), ${result.usage.judge0Submissions} Judge0 submission(s), ` +
      `${result.usage.promptTokens + result.usage.outputTokens} tokens, ${Math.round(result.usage.elapsedMs / 1000)}s`,
  );
  console.log('==============================================\n');

  const [fs] = await Promise.all([import('node:fs/promises')]);
  await fs.writeFile('email_success.html', buildEmail(result, persistence), 'utf8');

  if (process.env.GITHUB_OUTPUT) {
    const subjectPrefix = result.submissionReady ? 'VERIFIED' : `UNVERIFIED (${result.status})`;
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `PROBLEM_TITLE=${problem.title}`,
        `PROBLEM_ID=${problem.questionFrontendId ?? ''}`,
        `VERIFICATION_STATUS=${result.status}`,
        `SUBMISSION_READY=${result.submissionReady ? 'true' : 'false'}`,
        `SUBJECT_PREFIX=${subjectPrefix}`,
        `EXECUTION_ID=${id}`,
        `PERSISTED=${persistence.ok ? 'true' : 'false'}`,
        '',
      ].join('\n'),
    );
  }

  if (!result.finalCode) {
    throw new Error('The pipeline produced no code.');
  }
}

/* ------------------------------------------------------------------ *
 * Failure reporting                                                   *
 *                                                                     *
 * A solution that fails validation is NOT a failure here: it is still  *
 * emailed, marked UNVERIFIED. This path is only for the pipeline       *
 * itself not finishing, and it names which component gave out so the   *
 * notification is actionable without opening the run log.              *
 * ------------------------------------------------------------------ */

/** Known at module scope so the failure handler can name the problem if we got that far. */
let knownProblem: Awaited<ReturnType<typeof fetchProblemBySlug>>;

/** Set once the run has an identity, so the failure report can reference it. */
let currentExecutionId: string | undefined;

type FailureComponent = 'configuration' | 'LeetCode API' | 'Gemini' | 'Java execution' | 'pipeline';

export function classifyFailure(error: unknown): { component: FailureComponent; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'ConfigError' || /not set|not configured|API key/i.test(message)) {
    return { component: 'configuration', message };
  }
  if (name === 'LeetCodeUnavailableError' || /leetcode/i.test(message)) {
    return { component: 'LeetCode API', message };
  }
  if (name === 'GeminiError' || /gemini/i.test(message)) {
    return { component: 'Gemini', message };
  }
  if (/judge0|javac|compil/i.test(message)) {
    return { component: 'Java execution', message };
  }
  return { component: 'pipeline', message };
}

/** Removes any configured secret value from text before it leaves the process. */
export function redact(text: string): string {
  let safe = text;
  for (const name of [
    'GEMINI_API_KEY',
    'JUDGE0_API_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CRON_SECRET',
    'MAIL_PASSWORD',
  ]) {
    const value = process.env[name]?.trim();
    if (value && value.length >= 8) safe = safe.split(value).join(`<${name} redacted>`);
  }
  // Belt and braces: strip anything that looks like a key in a query string.
  return safe.replace(/([?&](?:key|token|api[_-]?key)=)[^&\s]+/gi, '$1<redacted>');
}

async function reportFailure(error: unknown) {
  const { component, message } = classifyFailure(error);
  const safeMessage = redact(message);
  const title = knownProblem?.title ?? '';

  console.error(`[daily] FAILED in ${component}: ${safeMessage}`);

  // Record the failure too, so a day the pipeline fell over is visible in the history
  // rather than being an unexplained gap. The message has already been through redact().
  // This is best-effort: it must not interfere with the failure email.
  const id = currentExecutionId ?? executionId(knownProblem?.titleSlug);
  const stored = await saveRun({
    execution_id: id,
    source: process.env.GITHUB_RUN_ID ? 'github-actions' : 'cli',
    title: title || 'Unknown problem',
    title_slug: knownProblem?.titleSlug,
    difficulty: knownProblem?.difficulty,
    question_id: knownProblem?.questionFrontendId,
    verification_status: 'failed',
    failure_component: component,
    failure_message: safeMessage.slice(0, 2000),
    gh_run_id: process.env.GITHUB_RUN_ID,
    email_status: 'pending',
  });
  console.log(`[daily] database: ${stored.ok ? stored.detail : `NOT SAVED - ${stored.detail}`}`);

  try {
    const fs = await import('node:fs/promises');

    await fs.writeFile(
      'email_failure.html',
      `<div style="font-family: sans-serif; max-width: 820px; margin: 0 auto; color: #333;">
  <h2 style="color: #b91c1c;">Daily run did not complete</h2>
  <p><strong>Failing component:</strong> ${escapeHtml(component)}</p>
  <p><strong>Problem:</strong> ${escapeHtml(title || 'not reached')}</p>
  <p><strong>Error:</strong></p>
  <pre style="background:#1f2937;color:#f3f4f6;padding:16px;border-radius:8px;white-space:pre-wrap;">${escapeHtml(safeMessage)}</pre>
  <p style="color:#6b7280;font-style:italic;">
    A solution that fails validation is not reported here &mdash; it is still emailed and marked
    UNVERIFIED. This message means the pipeline itself could not finish.
  </p>
  <p style="color:#6b7280;font-size:12px;">
    Run log: ${escapeHtml(
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : 'local run',
    )}
  </p>
</div>`,
      'utf8',
    );

    if (process.env.GITHUB_OUTPUT) {
      await fs.appendFile(
        process.env.GITHUB_OUTPUT,
        [
          `FAILURE_COMPONENT=${component}`,
          // GITHUB_OUTPUT is line-based, so the message must stay on one line.
          `FAILURE_MESSAGE=${safeMessage.replace(/[\r\n]+/g, ' ').slice(0, 400)}`,
          `PROBLEM_TITLE=${title}`,
          `EXECUTION_ID=${id}`,
          '',
        ].join('\n'),
      );
    }
  } catch (writeError) {
    console.error('[daily] could not write the failure report:', writeError);
  }
}

/**
 * Runs one daily solve and reports a failure the way CI expects.
 *
 * Sets `process.exitCode` rather than calling `process.exit`, so the process still flushes
 * its output and so importing this module (for tests, or from standalone-solver.mjs)
 * cannot tear down the host process.
 */
export async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    await reportFailure(error);
    process.exitCode = 1;
  }
}


if (isEntryPoint(import.meta.url)) {
  void run();
}
