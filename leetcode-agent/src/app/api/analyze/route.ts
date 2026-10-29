import { NextResponse } from 'next/server';
import { GeminiClient, extractJsonObject } from '@/lib/gemini.ts';
import { analysisPrompt } from '@/lib/prompts.ts';
import { buildContract, describeContract } from '@/lib/java/contract.ts';
import { resolveProblem, type ProblemRequest } from '@/lib/problem-input.ts';
import { configStatus } from '@/lib/config.ts';
import type { ProblemAnalysis } from '@/lib/types.ts';

export const maxDuration = 120;

/**
 * Analysis step of the pipeline, exposed on its own for the manual mode.
 *
 * Response keeps the original `{ task, expectedTimeComplexity, expectedSpaceComplexity,
 * edgeCases, insights }` shape and adds the algorithm choice, the approach and — when the
 * problem was named by slug — the official interface the solution will have to satisfy.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ProblemRequest;

    if (!configStatus().gemini) {
      return NextResponse.json(
        { success: false, error: 'GEMINI_API_KEY is not configured.' },
        { status: 503 },
      );
    }

    const resolved = await resolveProblem(body, req.signal);
    if (!resolved) {
      return NextResponse.json(
        { success: false, error: 'problemText, titleSlug or url is required' },
        { status: 400 },
      );
    }

    const { problem } = resolved;
    const contract = problem.javaSnippet
      ? (() => {
          try {
            return buildContract(problem.javaSnippet!, problem.metaData);
          } catch {
            return undefined;
          }
        })()
      : undefined;

    const gemini = new GeminiClient();
    const response = await gemini.generate({
      prompt: analysisPrompt(problem, contract),
      maxOutputTokens: 1400,
      json: true,
      temperature: 0.2,
      signal: req.signal,
    });

    const analysis = extractJsonObject<ProblemAnalysis>(response.text);
    if (!analysis) {
      return NextResponse.json(
        { success: false, error: 'The model did not return valid JSON for the analysis. Try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        ...analysis,
        problem: {
          title: problem.title,
          titleSlug: problem.titleSlug,
          difficulty: problem.difficulty,
          constraints: problem.constraints,
          javaSnippet: problem.javaSnippet,
          exampleTestcases: problem.exampleTestcases,
          exampleOutputs: problem.exampleOutputs,
        },
        contract: contract ? describeContract(contract) : undefined,
        groundedOnOfficialInterface: Boolean(contract),
        usage: gemini.usage(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to analyze';
    console.error('[analyze]', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
