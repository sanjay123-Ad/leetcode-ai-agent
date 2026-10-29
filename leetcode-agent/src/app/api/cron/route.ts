import { NextResponse } from 'next/server';
import { fetchDailyChallenge } from '@/lib/leetcode.ts';
import { solveProblem } from '@/lib/pipeline.ts';
import { persistRun } from '@/lib/persistence.ts';
import { config } from '@/lib/config.ts';

export const maxDuration = 300;

/** Constant-time comparison, so the secret cannot be probed by timing. */
function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Daily trigger: fetch today's official challenge, solve it, persist the result.
 *
 * The secret is read from the `Authorization: Bearer` header or the `x-cron-secret`
 * header; the old `?secret=` query parameter still works but is deprecated, because query
 * strings end up in server and proxy logs. The route now calls the pipeline in-process
 * instead of making HTTP calls back to itself.
 */
export async function GET(req: Request) {
  const expected = config.cronSecret();
  if (!expected) {
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET is not configured, so the scheduled endpoint is disabled.' },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const header = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-cron-secret');
  const provided = header ?? url.searchParams.get('secret');

  if (!secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const problem = await fetchDailyChallenge(req.signal);
    const result = await solveProblem(problem, { signal: req.signal });
    const persistence = await persistRun(result);

    return NextResponse.json({
      success: true,
      title: problem.title,
      titleSlug: problem.titleSlug,
      difficulty: problem.difficulty,
      questionFrontendId: problem.questionFrontendId,
      status: result.status,
      checks: result.checks,
      submissionReady: result.submissionReady,
      readinessReason: result.readinessReason,
      attempts: result.attempts.length,
      usage: result.usage,
      persistence,
      // `allPassed` is kept for anything already consuming this endpoint.
      allPassed: result.checks.exampleTestsPassed,
      message: `${problem.title}: ${result.status}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cron run failed';
    console.error('[cron]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
