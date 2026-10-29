/**
 * Authoritative problem retrieval.
 *
 * LeetCode's GraphQL API is the preferred source because it is the only one that returns
 * `metaData` and `codeSnippets` — the official Java interface contract. The previous code
 * used two community mirrors first (one of which now returns HTTP 404) and never asked
 * for the contract at all, so the model had to guess method names (audit findings C3, C4, C9).
 *
 * Two rules are enforced here:
 *  - every field must belong to the same problem (the daily pointer and the detail record
 *    are cross-checked on titleSlug);
 *  - nothing is invented. A problem whose Java snippet or metaData could not be retrieved
 *    is returned with `provenance.hasJavaSnippet === false` so the pipeline can refuse to
 *    call it submission-ready.
 */

import { requestJson } from './http.ts';
import { htmlToText, extractExampleOutputs, extractConstraints } from './html.ts';
import { isDesignMetaData, type Problem, type ProblemMetaData } from './types.ts';

const GRAPHQL_URL = 'https://leetcode.com/graphql';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DAILY_QUERY = `query questionOfToday {
  activeDailyCodingChallengeQuestion {
    date
    link
    question { title titleSlug questionId questionFrontendId difficulty }
  }
}`;

const DETAIL_QUERY = `query questionDetail($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    title
    titleSlug
    questionId
    questionFrontendId
    difficulty
    content
    metaData
    exampleTestcases
    topicTags { name }
    codeSnippets { lang langSlug code }
  }
}`;

type GraphQLDaily = {
  data?: {
    activeDailyCodingChallengeQuestion?: {
      date: string;
      link: string;
      question: {
        title: string;
        titleSlug: string;
        questionId: string;
        questionFrontendId: string;
        difficulty: string;
      };
    };
  };
};

type GraphQLDetail = {
  data?: {
    question?: {
      title: string;
      titleSlug: string;
      questionId: string;
      questionFrontendId: string;
      difficulty: string;
      content: string;
      metaData: string;
      exampleTestcases: string;
      topicTags: { name: string }[];
      codeSnippets: { lang: string; langSlug: string; code: string }[];
    } | null;
  };
};

async function graphql<T>(query: string, variables?: Record<string, unknown>, signal?: AbortSignal) {
  return requestJson<T>(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_UA,
      Referer: 'https://leetcode.com/problemset/',
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs: 20_000,
    retries: 3,
    signal,
  });
}

/** Splits LeetCode's `exampleTestcases` blob into one entry per case. */
export function splitExampleTestcases(blob: string, paramCount: number): string[] {
  const lines = blob.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  if (paramCount <= 1) return lines;

  const cases: string[] = [];
  for (let i = 0; i + paramCount <= lines.length; i += paramCount) {
    cases.push(lines.slice(i, i + paramCount).join('\n'));
  }
  return cases;
}

function parseMetaData(raw: string | undefined, warnings: string[]): ProblemMetaData | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ProblemMetaData;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('metaData is not an object');
    return parsed;
  } catch (error) {
    warnings.push(`Could not parse metaData: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Fetches the full official record for one problem by slug.
 * Returns `undefined` only when LeetCode produced no usable record at all.
 */
export async function fetchProblemBySlug(
  titleSlug: string,
  context: { date?: string; link?: string; dailySource?: string } = {},
  signal?: AbortSignal,
): Promise<Problem | undefined> {
  const warnings: string[] = [];
  const res = await graphql<GraphQLDetail>(DETAIL_QUERY, { titleSlug }, signal);
  const question = res.data?.data?.question;

  if (!question) {
    return undefined;
  }

  if (question.titleSlug !== titleSlug) {
    // Never silently serve a different problem than the one asked for.
    warnings.push(`Detail record slug "${question.titleSlug}" does not match requested "${titleSlug}"`);
  }

  const metaData = parseMetaData(question.metaData, warnings);
  const javaSnippet = question.codeSnippets?.find((s) => s.langSlug === 'java')?.code?.trim();
  if (!javaSnippet) warnings.push('LeetCode returned no Java code snippet for this problem');

  const statement = htmlToText(question.content ?? '');
  if (!statement) warnings.push('Problem statement was empty after HTML conversion');

  // A design problem's example case is always two lines (the operation list and the
  // argument list). Some design problems happen to carry a two-element `params` array and
  // some carry none at all, so the class shape decides, not `params`.
  const paramCount = metaData
    ? isDesignMetaData(metaData)
      ? 2
      : 'params' in metaData
        ? metaData.params.length
        : 1
    : 1;

  return {
    titleSlug: question.titleSlug ?? titleSlug,
    title: question.title,
    questionId: question.questionId,
    questionFrontendId: question.questionFrontendId,
    difficulty: question.difficulty,
    link: context.link ?? `https://leetcode.com/problems/${titleSlug}/`,
    date: context.date,
    statement,
    constraints: extractConstraints(statement),
    topicTags: question.topicTags?.map((t) => t.name) ?? [],
    exampleTestcases: splitExampleTestcases(question.exampleTestcases ?? '', paramCount),
    exampleOutputs: extractExampleOutputs(statement),
    javaSnippet,
    metaData,
    provenance: {
      dailySource: context.dailySource ?? 'by-slug',
      detailSource: 'leetcode-graphql',
      hasJavaSnippet: Boolean(javaSnippet),
      hasMetaData: Boolean(metaData),
      consistent: question.titleSlug === titleSlug,
      warnings,
    },
  };
}

/** Finds today's daily-challenge slug. GraphQL first, community mirror as a pointer-only fallback. */
async function resolveDailySlug(
  signal?: AbortSignal,
): Promise<{ titleSlug: string; date?: string; link?: string; source: string; expectedTitle?: string } | undefined> {
  const viaGraphql = await graphql<GraphQLDaily>(DAILY_QUERY, undefined, signal);
  const daily = viaGraphql.data?.data?.activeDailyCodingChallengeQuestion;
  if (daily?.question?.titleSlug) {
    return {
      titleSlug: daily.question.titleSlug,
      date: daily.date,
      link: daily.link ? `https://leetcode.com${daily.link}` : undefined,
      source: 'leetcode-graphql',
      expectedTitle: daily.question.title,
    };
  }

  // Fallback: the community mirror is used only to learn *which* problem today is. Every
  // field still comes from LeetCode itself, so a stale mirror cannot swap in a different
  // problem's statement or contract.
  const mirror = await requestJson<{ titleSlug?: string; date?: string; questionLink?: string; questionTitle?: string }>(
    'https://alfa-leetcode-api.onrender.com/daily',
    { timeoutMs: 25_000, retries: 2, signal },
  );
  if (mirror.ok && mirror.data?.titleSlug) {
    return {
      titleSlug: mirror.data.titleSlug,
      date: mirror.data.date,
      link: mirror.data.questionLink,
      source: 'alfa-leetcode-api (pointer only)',
      expectedTitle: mirror.data.questionTitle,
    };
  }

  return undefined;
}

export class LeetCodeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeetCodeUnavailableError';
  }
}

/** Today's official daily challenge, with its interface contract. */
export async function fetchDailyChallenge(signal?: AbortSignal): Promise<Problem> {
  const pointer = await resolveDailySlug(signal);
  if (!pointer) {
    throw new LeetCodeUnavailableError(
      'Could not determine today\'s LeetCode daily challenge from any source. Try again in a few minutes.',
    );
  }

  const problem = await fetchProblemBySlug(
    pointer.titleSlug,
    { date: pointer.date, link: pointer.link, dailySource: pointer.source },
    signal,
  );

  if (!problem) {
    throw new LeetCodeUnavailableError(
      `Resolved today's challenge as "${pointer.titleSlug}" but LeetCode returned no problem record for it.`,
    );
  }

  // Cross-check the title we were pointed at against the record we fetched.
  if (pointer.expectedTitle && pointer.expectedTitle !== problem.title) {
    problem.provenance.consistent = false;
    problem.provenance.warnings.push(
      `Daily pointer said "${pointer.expectedTitle}" but the problem record is "${problem.title}"`,
    );
  }

  // A daily date far from today means the pointer source is stale.
  if (problem.date) {
    const today = new Date().toISOString().slice(0, 10);
    const driftDays = Math.abs(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${problem.date}T00:00:00Z`)) / 86_400_000,
    );
    if (Number.isFinite(driftDays) && driftDays > 1) {
      problem.provenance.warnings.push(
        `Daily challenge date ${problem.date} is ${driftDays} days from today (${today}); the source may be stale`,
      );
    }
  }

  return problem;
}

/** Shape kept for the existing `/api/daily-challenge` response contract. */
export function toLegacyChallengeShape(problem: Problem) {
  return {
    date: problem.date ?? new Date().toISOString().slice(0, 10),
    link: problem.link,
    title: problem.title,
    titleSlug: problem.titleSlug,
    difficulty: problem.difficulty,
    content: problem.statement,
    tags: problem.topicTags,
    exampleTestcases: problem.exampleTestcases.join('\n'),
    // Added fields: the official contract, so clients no longer have to guess.
    questionId: problem.questionId,
    questionFrontendId: problem.questionFrontendId,
    constraints: problem.constraints,
    javaSnippet: problem.javaSnippet,
    metaData: problem.metaData,
    exampleOutputs: problem.exampleOutputs,
    provenance: problem.provenance,
  };
}
