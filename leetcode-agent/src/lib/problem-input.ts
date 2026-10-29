/**
 * Turning a request body into a `Problem`.
 *
 * The UI and the cron job can name a problem by slug or URL, in which case everything —
 * statement, constraints, examples and the official Java interface — comes from LeetCode.
 * Pasted text is still accepted (that was the original manual mode), but a problem built
 * from text alone has no interface contract, so the pipeline will say so rather than
 * pretend the result is submission-ready.
 */

import { fetchProblemBySlug } from './leetcode.ts';
import { extractExampleOutputs, extractConstraints, htmlToText } from './html.ts';
import type { Problem } from './types.ts';

export type ProblemRequest = {
  titleSlug?: string;
  /** A full leetcode.com problem URL is accepted in place of a slug. */
  url?: string;
  problemText?: string;
  challengeInfo?: { title?: string; difficulty?: string; titleSlug?: string; link?: string };
  /** Legacy field name used by the original `/api/auto-solve` body. */
  problem?: { title?: string; difficulty?: string; content?: string; titleSlug?: string };
};

export function slugFrom(request: ProblemRequest): string | undefined {
  const candidates = [
    request.titleSlug,
    request.challengeInfo?.titleSlug,
    request.problem?.titleSlug,
    request.url,
    request.challengeInfo?.link,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /leetcode\.com\/problems\/([a-z0-9-]+)/i.exec(candidate);
    if (match) return match[1];
    if (/^[a-z0-9][a-z0-9-]*$/i.test(candidate)) return candidate.toLowerCase();
  }
  return undefined;
}

/** Builds a `Problem` from pasted text, with no interface contract. */
export function problemFromText(text: string, info?: ProblemRequest['challengeInfo']): Problem {
  // Accept either plain text or raw HTML: statements copied from the site carry markup.
  const statement = /<[a-z][\s\S]*>/i.test(text) ? htmlToText(text) : text.trim();

  return {
    titleSlug: info?.titleSlug ?? 'pasted-problem',
    title: info?.title ?? 'Pasted problem',
    difficulty: info?.difficulty ?? 'Unknown',
    link: info?.link ?? '',
    statement,
    constraints: extractConstraints(statement),
    topicTags: [],
    exampleTestcases: [],
    exampleOutputs: extractExampleOutputs(statement),
    provenance: {
      dailySource: 'request body',
      detailSource: 'pasted text',
      hasJavaSnippet: false,
      hasMetaData: false,
      consistent: true,
      warnings: ['Problem was supplied as text, so LeetCode\'s official interface and example cases are unavailable.'],
    },
  };
}

export type ResolvedProblem = { problem: Problem; resolvedBy: 'slug' | 'text' };

/** Resolves a request to a problem, preferring the authoritative source. */
export async function resolveProblem(request: ProblemRequest, signal?: AbortSignal): Promise<ResolvedProblem | undefined> {
  const slug = slugFrom(request);

  if (slug) {
    const problem = await fetchProblemBySlug(slug, {}, signal);
    if (problem) return { problem, resolvedBy: 'slug' };
  }

  const text = request.problemText ?? request.problem?.content;
  if (text && text.trim().length > 0) {
    return {
      problem: problemFromText(text, {
        ...request.challengeInfo,
        ...request.problem,
        titleSlug: slug ?? request.challengeInfo?.titleSlug,
      }),
      resolvedBy: 'text',
    };
  }

  return undefined;
}
