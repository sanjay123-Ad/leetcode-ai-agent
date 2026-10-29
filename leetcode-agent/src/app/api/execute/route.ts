import { NextResponse } from 'next/server';
import { buildContract, validateSignature } from '@/lib/java/contract.ts';
import { buildCompileOnlyHarness, buildHarness } from '@/lib/java/harness.ts';
import { runJava } from '@/lib/runner/index.ts';
import { resolveProblem, type ProblemRequest } from '@/lib/problem-input.ts';

export const maxDuration = 120;

type ExecuteRequest = ProblemRequest & { code?: string };

/**
 * Compiles and runs a solution against LeetCode's own example cases.
 *
 * The harness is generated here, from the official examples — the model is not involved,
 * so "tests passed" means the solution reproduced LeetCode's published outputs. The
 * response distinguishes a compile error, a wrong answer, a crash and an infrastructure
 * failure instead of reporting one undifferentiated failure.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ExecuteRequest;
    const code = body.code?.trim();

    if (!code) {
      return NextResponse.json({ success: false, error: 'code is required' }, { status: 400 });
    }

    const resolved = await resolveProblem(body, req.signal);
    if (!resolved) {
      return NextResponse.json(
        { success: false, error: 'problemText, titleSlug or url is required' },
        { status: 400 },
      );
    }

    const { problem } = resolved;

    if (!problem.javaSnippet) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Without the official Java template this endpoint cannot build a trustworthy harness. Pass `titleSlug` or `url` to verify against LeetCode\'s real examples.',
        },
        { status: 422 },
      );
    }

    const contract = buildContract(problem.javaSnippet, problem.metaData);
    const signature = validateSignature(code, contract);

    // Signature validation is free; running code that LeetCode would reject wastes quota.
    if (!signature.valid) {
      return NextResponse.json({
        success: true,
        data: {
          signature,
          executed: false,
          verification: 'signature_invalid',
          reason: 'The code does not match the official interface, so it was not executed.',
        },
      });
    }

    const harness = buildHarness(problem, contract, code);
    const source = harness.supported ? harness.source : buildCompileOnlyHarness(contract, code);
    const outcome = await runJava({ source, signal: req.signal });

    return NextResponse.json({
      success: true,
      data: {
        signature,
        executed: true,
        compileOnly: !harness.supported,
        harnessReason: harness.supported ? undefined : harness.reason,
        verifiableCases: harness.supported ? harness.verifiableCases : 0,
        extraChecks: harness.supported ? harness.extraChecks : [],
        verification: harness.supported
          ? outcome.kind === 'passed'
            ? 'example_tests_passed'
            : outcome.kind
          : outcome.kind === 'passed'
            ? 'compiled'
            : outcome.kind,
        execution: outcome,
        // Kept for compatibility with the original response shape.
        testCode: source,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute';
    console.error('[execute]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
