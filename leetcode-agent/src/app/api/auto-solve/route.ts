import { NextResponse } from 'next/server';
import { solveProblem, type SolveOutput } from '@/lib/pipeline.ts';
import { resolveProblem, type ProblemRequest } from '@/lib/problem-input.ts';
import { persistRun } from '@/lib/persistence.ts';
import { configStatus } from '@/lib/config.ts';
import type { LogEntry } from '@/lib/log.ts';

// The pipeline makes several model calls plus a compile-and-run step; the measured
// end-to-end time is tens of seconds, which needs an explicit limit on serverless hosts.
export const maxDuration = 300;

/**
 * Runs the full solve pipeline for one problem.
 *
 * Accepts `{ titleSlug }` or `{ url }` (authoritative: the official interface, examples and
 * constraints come from LeetCode) and still accepts the original `{ problemText }` /
 * `{ problem: { content } }` bodies. Pass `?stream=1` to receive newline-delimited progress
 * events while the pipeline runs, instead of waiting for the final JSON.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const wantsStream = searchParams.get('stream') === '1';

  let body: ProblemRequest;
  try {
    body = (await req.json()) as ProblemRequest;
  } catch {
    return NextResponse.json({ success: false, error: 'Request body must be JSON.' }, { status: 400 });
  }

  if (!configStatus().gemini) {
    return NextResponse.json(
      { success: false, error: 'GEMINI_API_KEY is not configured. Add it to .env.local and restart the server.' },
      { status: 503 },
    );
  }

  const resolved = await resolveProblem(body);
  if (!resolved) {
    return NextResponse.json(
      {
        success: false,
        error:
          'Provide a LeetCode problem: `titleSlug`, `url`, or `problemText`. A slug or URL is strongly preferred, because only LeetCode supplies the official Java interface.',
      },
      { status: 400 },
    );
  }

  if (!wantsStream) {
    try {
      const result = await solveProblem(resolved.problem, { signal: req.signal });
      const persistence = await persistRun(result);
      return NextResponse.json({ success: true, data: shapeResponse({ ...result, persistence }, resolved.resolvedBy) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Auto-solve failed';
      console.error('[auto-solve]', message);
      return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          // The client went away; the pipeline's own abort signal will stop the work.
        }
      };

      send({ type: 'problem', data: { title: resolved.problem.title, difficulty: resolved.problem.difficulty, titleSlug: resolved.problem.titleSlug } });

      try {
        const result = await solveProblem(resolved.problem, {
          signal: req.signal,
          onEvent: (entry: LogEntry) => send({ type: 'event', data: entry }),
        });
        const persistence = await persistRun(result);
        send({ type: 'result', data: shapeResponse({ ...result, persistence }, resolved.resolvedBy) });
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : 'Auto-solve failed' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Keeps the fields the previous API returned (so the existing client contract holds) and
 * adds the verification ladder.
 */
function shapeResponse(result: SolveOutput, resolvedBy: 'slug' | 'text') {
  const lastExecution = [...result.attempts].reverse().find((a) => a.execution)?.execution;

  return {
    // --- original shape ---
    analysis: result.analysis,
    finalCode: result.finalCode,
    allPassed: result.checks.exampleTestsPassed,
    attempts: result.attempts.length,
    execution: lastExecution,
    logs: result.logs,
    steps: result.attempts.map((attempt) => ({
      step: `attempt_${attempt.attempt}`,
      status: attempt.status === 'example_tests_passed' || attempt.status === 'additional_tests_passed' ? 'passed' : 'failed',
    })),

    // --- verification ladder, reported honestly ---
    status: result.status,
    statusDetail: result.statusDetail,
    checks: result.checks,
    submissionReady: result.submissionReady,
    readinessReason: result.readinessReason,

    // --- provenance and explanation ---
    problem: {
      title: result.problem.title,
      titleSlug: result.problem.titleSlug,
      difficulty: result.problem.difficulty,
      questionFrontendId: result.problem.questionFrontendId,
      link: result.problem.link,
      tags: result.problem.topicTags,
      constraints: result.problem.constraints,
      javaSnippet: result.problem.javaSnippet,
      exampleTestcases: result.problem.exampleTestcases,
      exampleOutputs: result.problem.exampleOutputs,
      provenance: result.problem.provenance,
    },
    contract: result.contract,
    explanation: result.explanation,
    resolvedBy,
    attemptDetails: result.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      signatureValid: attempt.signature.valid,
      violations: attempt.signature.violations,
      execution: attempt.execution
        ? {
            kind: attempt.execution.kind,
            runner: attempt.execution.runner,
            message: attempt.execution.message,
            cases: attempt.execution.cases,
          }
        : undefined,
      repairReason: attempt.repairReason,
    })),
    events: result.events,
    usage: result.usage,
    persistence: result.persistence,
  };
}
