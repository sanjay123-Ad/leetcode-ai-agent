import { NextResponse } from 'next/server';
import { GeminiClient, extractJavaCode } from '@/lib/gemini.ts';
import { generationPrompt, signatureRepairPrompt } from '@/lib/prompts.ts';
import { buildContract, describeContract, describeViolationsForRepair, validateSignature } from '@/lib/java/contract.ts';
import { resolveProblem, type ProblemRequest } from '@/lib/problem-input.ts';
import { configStatus } from '@/lib/config.ts';
import type { ProblemAnalysis, SignatureValidation } from '@/lib/types.ts';

export const maxDuration = 180;

type GenerateRequest = ProblemRequest & { analysis?: ProblemAnalysis };

/**
 * Generation step of the pipeline, exposed on its own for the manual mode.
 *
 * When the problem is named by slug the official Java template is used as the interface and
 * the result is signature-checked (and repaired once) before it is returned, so the caller
 * never receives code that LeetCode would reject on a renamed method. With pasted text
 * there is no official template, and the response says so.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as GenerateRequest;

    if (!configStatus().gemini) {
      return NextResponse.json({ success: false, error: 'GEMINI_API_KEY is not configured.' }, { status: 503 });
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
            'No official Java template is available for this input, so the required method signature is unknown. Pass `titleSlug` or `url` (for example "two-sum") to generate against LeetCode\'s real interface.',
        },
        { status: 422 },
      );
    }

    const contract = buildContract(problem.javaSnippet, problem.metaData);
    const gemini = new GeminiClient();

    const first = await gemini.generate({
      prompt: generationPrompt(problem, contract, body.analysis),
      maxOutputTokens: 3000,
      temperature: 0.1,
      signal: req.signal,
    });

    let code = extractJavaCode(first.text);
    let signature: SignatureValidation = validateSignature(code, contract);
    let repaired = false;

    if (!signature.valid) {
      const repair = await gemini.generate({
        prompt: signatureRepairPrompt(code, describeViolationsForRepair(signature, contract)),
        maxOutputTokens: 3000,
        temperature: 0.2,
        signal: req.signal,
      });
      const candidate = extractJavaCode(repair.text);
      const revalidated = validateSignature(candidate, contract);
      repaired = true;
      // Keep the repair only if it actually improved the interface match.
      if (revalidated.valid || revalidated.violations.length < signature.violations.length) {
        code = candidate;
        signature = revalidated;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        code,
        contract: describeContract(contract),
        javaSnippet: contract.source,
        signature: { valid: signature.valid, violations: signature.violations },
        signatureRepairAttempted: repaired,
        // Generating code proves nothing about correctness; the caller must still execute it.
        verified: false,
        usage: gemini.usage(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate code';
    console.error('[generate]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
