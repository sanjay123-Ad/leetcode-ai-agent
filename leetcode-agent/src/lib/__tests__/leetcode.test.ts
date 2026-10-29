import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDailyChallenge, fetchProblemBySlug, splitExampleTestcases, toLegacyChallengeShape } from '../leetcode.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const QUESTION = {
  title: 'Two Sum',
  titleSlug: 'two-sum',
  questionId: '1',
  questionFrontendId: '1',
  difficulty: 'Easy',
  content: '<p>Given an array…</p><pre><strong>Input:</strong> nums = [2,7,11,15], target = 9\n<strong>Output:</strong> [0,1]\n</pre><p>Constraints:</p><ul><li>2 &lt;= nums.length &lt;= 10<sup>4</sup></li></ul>',
  metaData: '{"name":"twoSum","params":[{"name":"nums","type":"integer[]"},{"name":"target","type":"integer"}],"return":{"type":"integer[]"}}',
  exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
  topicTags: [{ name: 'Array' }, { name: 'Hash Table' }],
  codeSnippets: [
    { lang: 'Python3', langSlug: 'python3', code: 'class Solution:\n    pass' },
    { lang: 'Java', langSlug: 'java', code: 'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        \n    }\n}' },
  ],
};

/** Routes GraphQL calls by operation name so the daily and detail queries can differ. */
function mockGraphql(handlers: { daily?: unknown; question?: unknown; mirror?: unknown }) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);

    if (target.includes('alfa-leetcode-api')) {
      if (!handlers.mirror) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(handlers.mirror), { status: 200 });
    }

    const body = String(init?.body ?? '');
    const payload = body.includes('questionOfToday') ? handlers.daily : handlers.question;
    if (!payload) return new Response(JSON.stringify({ data: null }), { status: 200 });
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('splitExampleTestcases', () => {
  it('groups lines by the number of parameters', () => {
    expect(splitExampleTestcases('[1]\n2\n[3]\n4', 2)).toEqual(['[1]\n2', '[3]\n4']);
  });

  it('treats each line as a case for a single parameter', () => {
    expect(splitExampleTestcases('"abc"\n"de"', 1)).toEqual(['"abc"', '"de"']);
  });

  it('drops a trailing partial group rather than inventing arguments', () => {
    expect(splitExampleTestcases('[1]\n2\n[3]', 2)).toEqual(['[1]\n2']);
  });

  it('handles an empty blob', () => {
    expect(splitExampleTestcases('', 2)).toEqual([]);
  });
});

describe('fetchProblemBySlug', () => {
  it('returns the official contract, examples and constraints', async () => {
    mockGraphql({ question: { data: { question: QUESTION } } });
    const problem = await fetchProblemBySlug('two-sum');

    expect(problem).toBeDefined();
    expect(problem!.javaSnippet).toContain('public int[] twoSum(int[] nums, int target)');
    expect(problem!.metaData).toMatchObject({ name: 'twoSum' });
    expect(problem!.exampleTestcases).toEqual(['[2,7,11,15]\n9', '[3,2,4]\n6']);
    expect(problem!.exampleOutputs).toEqual(['[0,1]']);
    expect(problem!.constraints).toContain('2 <= nums.length');
    expect(problem!.topicTags).toEqual(['Array', 'Hash Table']);
    expect(problem!.provenance).toMatchObject({ hasJavaSnippet: true, hasMetaData: true, consistent: true });
  });

  it('flags a missing Java snippet instead of pretending it has one', async () => {
    mockGraphql({ question: { data: { question: { ...QUESTION, codeSnippets: [] } } } });
    const problem = await fetchProblemBySlug('two-sum');
    expect(problem!.provenance.hasJavaSnippet).toBe(false);
    expect(problem!.provenance.warnings.join(' ')).toMatch(/no Java code snippet/);
  });

  it('flags unparseable metaData', async () => {
    mockGraphql({ question: { data: { question: { ...QUESTION, metaData: 'not json' } } } });
    const problem = await fetchProblemBySlug('two-sum');
    expect(problem!.provenance.hasMetaData).toBe(false);
  });

  it('flags a slug mismatch so a different problem cannot be served silently', async () => {
    mockGraphql({ question: { data: { question: { ...QUESTION, titleSlug: 'three-sum' } } } });
    const problem = await fetchProblemBySlug('two-sum');
    expect(problem!.provenance.consistent).toBe(false);
    expect(problem!.provenance.warnings.join(' ')).toMatch(/does not match/);
  });

  it('returns undefined when LeetCode has no record', async () => {
    mockGraphql({});
    expect(await fetchProblemBySlug('nope')).toBeUndefined();
  });
});

describe('fetchDailyChallenge', () => {
  const daily = {
    data: {
      activeDailyCodingChallengeQuestion: {
        date: new Date().toISOString().slice(0, 10),
        link: '/problems/two-sum/',
        question: { title: 'Two Sum', titleSlug: 'two-sum', questionId: '1', questionFrontendId: '1', difficulty: 'Easy' },
      },
    },
  };

  it('resolves the slug then fetches the full official record', async () => {
    mockGraphql({ daily, question: { data: { question: QUESTION } } });
    const problem = await fetchDailyChallenge();
    expect(problem.titleSlug).toBe('two-sum');
    expect(problem.provenance.dailySource).toBe('leetcode-graphql');
    expect(problem.javaSnippet).toBeDefined();
  });

  it('uses the community mirror only as a pointer, taking every field from LeetCode', async () => {
    mockGraphql({
      question: { data: { question: QUESTION } },
      mirror: { titleSlug: 'two-sum', questionTitle: 'Two Sum', date: new Date().toISOString().slice(0, 10) },
    });

    const problem = await fetchDailyChallenge();
    expect(problem.provenance.dailySource).toContain('pointer only');
    expect(problem.provenance.detailSource).toBe('leetcode-graphql');
    expect(problem.javaSnippet).toBeDefined();
  });

  it('warns when the pointer disagrees with the fetched problem', async () => {
    mockGraphql({
      question: { data: { question: QUESTION } },
      mirror: { titleSlug: 'two-sum', questionTitle: 'Some Other Problem', date: new Date().toISOString().slice(0, 10) },
    });

    const problem = await fetchDailyChallenge();
    expect(problem.provenance.consistent).toBe(false);
  });

  it('warns about a stale daily date', async () => {
    mockGraphql({
      daily: {
        data: {
          activeDailyCodingChallengeQuestion: {
            ...daily.data.activeDailyCodingChallengeQuestion,
            date: '2020-01-01',
          },
        },
      },
      question: { data: { question: QUESTION } },
    });

    const problem = await fetchDailyChallenge();
    expect(problem.provenance.warnings.join(' ')).toMatch(/days from today/);
  });

  it('throws a clear error when no source can name today\'s problem', async () => {
    mockGraphql({});
    await expect(fetchDailyChallenge()).rejects.toThrow(/daily challenge/i);
  });
});

describe('toLegacyChallengeShape', () => {
  it('keeps the original response fields and adds the contract', async () => {
    mockGraphql({ question: { data: { question: QUESTION } } });
    const problem = await fetchProblemBySlug('two-sum');
    const legacy = toLegacyChallengeShape(problem!);

    for (const key of ['date', 'link', 'title', 'titleSlug', 'difficulty', 'content', 'tags', 'exampleTestcases']) {
      expect(legacy).toHaveProperty(key);
    }
    expect(legacy.javaSnippet).toBeDefined();
    expect(legacy.constraints).toContain('nums.length');
  });
});
