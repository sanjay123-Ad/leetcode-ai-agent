/**
 * Pipeline gate ordering.
 *
 * These tests pin the behaviour the audit was about: the signature gate runs before any
 * execution, the model never certifies itself, infrastructure failures are not blamed on
 * the solution, repairs are bounded and category-specific, and the reported status never
 * claims more than was proven.
 */

import { describe, expect, it } from 'vitest';
import { solveProblem, type GeminiLike } from '../pipeline.ts';
import type { ExecutionOutcome, Problem } from '../types.ts';

const JAVA_SNIPPET = `class Solution {
    public int[] twoSum(int[] nums, int target) {

    }
}`;

const CORRECT = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        return new int[]{0, 1};
    }
}`;

const RENAMED = `class Solution {
    public int[] findTwoSum(int[] nums, int target) {
        return new int[]{0, 1};
    }
}`;

function problem(overrides: Partial<Problem> = {}): Problem {
  return {
    titleSlug: 'two-sum',
    title: 'Two Sum',
    questionFrontendId: '1',
    difficulty: 'Easy',
    link: 'https://leetcode.com/problems/two-sum/',
    statement: 'Return indices of the two numbers such that they add up to target.\n\nOutput: [0,1]',
    constraints: '2 <= nums.length <= 10^4',
    topicTags: ['Array'],
    exampleTestcases: ['[2,7,11,15]\n9'],
    exampleOutputs: ['[0,1]'],
    javaSnippet: JAVA_SNIPPET,
    metaData: {
      name: 'twoSum',
      params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
      return: { type: 'integer[]' },
    },
    provenance: {
      dailySource: 'test',
      detailSource: 'test',
      hasJavaSnippet: true,
      hasMetaData: true,
      consistent: true,
      warnings: [],
    },
    ...overrides,
  };
}

/** A Gemini stand-in that replays scripted responses and records the prompts it saw. */
function fakeGemini(responses: string[]) {
  const prompts: string[] = [];
  let index = 0;

  const client: GeminiLike = {
    model: 'fake-model',
    usage: () => ({ geminiCalls: prompts.length, promptTokens: 100 * prompts.length, outputTokens: 50 * prompts.length }),
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      const text = responses[Math.min(index++, responses.length - 1)];
      return { text, finishReason: 'STOP', truncated: false, promptTokens: 100, outputTokens: 50, durationMs: 1, attempts: 1 };
    },
  };

  return { client, prompts };
}

const outcome = (partial: Partial<ExecutionOutcome> & Pick<ExecutionOutcome, 'kind'>): ExecutionOutcome => ({
  stdout: '',
  stderr: '',
  compileOutput: '',
  cases: [],
  runner: 'local-jdk',
  ...partial,
});

const EXPLANATION = JSON.stringify({
  summary: 'Hash map lookup',
  steps: ['scan once'],
  timeComplexity: 'O(n)',
  spaceComplexity: 'O(n)',
  edgeCases: [],
});

const ANALYSIS = JSON.stringify({
  task: 'Find two indices summing to target',
  algorithm: 'hash map',
  approach: 'single pass',
  expectedTimeComplexity: 'O(n)',
  expectedSpaceComplexity: 'O(n)',
  edgeCases: ['duplicate values'],
  insights: ['complement lookup'],
});

describe('solveProblem — happy path', () => {
  it('reaches the top rung only when examples and extra checks pass', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    const executed: string[] = [];

    const result = await solveProblem(problem(), {
      gemini: client,
      execute: async ({ source }) => {
        executed.push(source);
        return outcome({ kind: 'passed', message: '2/2 checks passed' });
      },
    });

    expect(result.status).toBe('additional_tests_passed');
    expect(result.submissionReady).toBe(true);
    expect(result.checks).toMatchObject({
      officialMetadata: true,
      signatureValid: true,
      compiled: true,
      exampleTestsPassed: true,
      verifiedByLeetCode: false,
    });
    expect(result.finalCode).toBe(CORRECT);
    expect(result.explanation?.timeComplexity).toBe('O(n)');
    // The official template must be handed to the model verbatim.
    expect(prompts[1]).toContain(JAVA_SNIPPET);
    // The harness, not the model, contains the expectations.
    expect(executed[0]).toContain('__check("1", "[0,1]"');
    expect(result.usage.geminiCalls).toBe(3);
  });

  it('never claims LeetCode verification', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    const result = await solveProblem(problem(), {
      gemini: client,
      execute: async () => outcome({ kind: 'passed' }),
    });
    expect(result.checks.verifiedByLeetCode).toBe(false);
    expect(result.readinessReason).toMatch(/hidden tests are still unproven/i);
  });
});

describe('solveProblem — signature gate', () => {
  it('does not execute code that fails the interface check', async () => {
    const { client } = fakeGemini([ANALYSIS, RENAMED, RENAMED, RENAMED, EXPLANATION]);
    let executions = 0;

    const result = await solveProblem(problem(), {
      gemini: client,
      maxSignatureRepairs: 1,
      maxAttempts: 2,
      execute: async () => {
        executions++;
        return outcome({ kind: 'passed' });
      },
    });

    expect(executions).toBe(0);
    expect(result.status).toBe('signature_invalid');
    expect(result.submissionReady).toBe(false);
    expect(result.readinessReason).toMatch(/would be rejected/);
  });

  it('repairs a renamed method and then proceeds', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, RENAMED, CORRECT, EXPLANATION]);

    const result = await solveProblem(problem(), {
      gemini: client,
      execute: async () => outcome({ kind: 'passed' }),
    });

    expect(result.status).toBe('additional_tests_passed');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].status).toBe('signature_invalid');
    expect(result.attempts[0].signature.violations[0].code).toBe('wrong_method_name');
    // The repair prompt must restate the official contract so it cannot be changed.
    expect(prompts[2]).toContain(JAVA_SNIPPET);
    expect(prompts[2]).toContain('wrong_method_name');
  });

  it('stops after the signature repair budget and reports honestly', async () => {
    const { client } = fakeGemini([ANALYSIS, RENAMED, RENAMED, RENAMED, RENAMED, EXPLANATION]);
    const result = await solveProblem(problem(), { gemini: client, maxSignatureRepairs: 2, execute: async () => outcome({ kind: 'passed' }) });

    expect(result.status).toBe('signature_invalid');
    expect(result.attempts.length).toBeLessThanOrEqual(3);
  });
});

describe('solveProblem — execution categories', () => {
  it('repairs a compile error with the compiler output', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, CORRECT, CORRECT, EXPLANATION]);
    let call = 0;

    const result = await solveProblem(problem(), {
      gemini: client,
      execute: async () => {
        call++;
        return call === 1
          ? outcome({ kind: 'compile_error', compileOutput: 'Main.java:3: error: cannot find symbol' })
          : outcome({ kind: 'passed' });
      },
    });

    expect(result.status).toBe('additional_tests_passed');
    expect(prompts[2]).toContain('cannot find symbol');
    expect(prompts[2]).toContain('does not compile');
  });

  it('repairs a wrong answer with the failing case values', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, CORRECT, CORRECT, EXPLANATION]);
    let call = 0;

    await solveProblem(problem(), {
      gemini: client,
      execute: async () => {
        call++;
        return call === 1
          ? outcome({ kind: 'wrong_answer', cases: [{ index: 0, label: '1', passed: false, expected: '[0,1]', actual: '[1,0]' }] })
          : outcome({ kind: 'passed' });
      },
    });

    expect(prompts[2]).toContain('expected [0,1]');
    expect(prompts[2]).toContain('your code produced [1,0]');
  });

  it('asks for a better complexity after a timeout', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, CORRECT, CORRECT, EXPLANATION]);
    let call = 0;

    await solveProblem(problem(), {
      gemini: client,
      execute: async () => {
        call++;
        return call === 1 ? outcome({ kind: 'timeout', message: 'time limit exceeded' }) : outcome({ kind: 'passed' });
      },
    });

    expect(prompts[2]).toMatch(/complexity fits the stated constraints/);
  });

  it('never blames the solution for an infrastructure failure', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    let executions = 0;

    const result = await solveProblem(problem(), {
      gemini: client,
      execute: async () => {
        executions++;
        return outcome({ kind: 'infrastructure_error', runner: 'judge0', message: 'Judge0 rate limit or daily quota reached.' });
      },
    });

    expect(executions).toBe(1);
    expect(result.status).toBe('signature_valid');
    expect(result.submissionReady).toBe(false);
    expect(result.readinessReason).toMatch(/quota/i);
    expect(result.finalCode).toBe(CORRECT);
  });

  it('keeps the best candidate rather than the last one', async () => {
    // Attempt 1 compiles and fails examples; attempt 2 does not even compile.
    const WORSE = CORRECT.replace('return new int[]{0, 1};', 'return new int[]{0, 1}');
    const { client } = fakeGemini([ANALYSIS, CORRECT, WORSE, WORSE, EXPLANATION]);
    let call = 0;

    const result = await solveProblem(problem(), {
      gemini: client,
      maxAttempts: 3,
      execute: async () => {
        call++;
        return call === 1 ? outcome({ kind: 'wrong_answer' }) : outcome({ kind: 'compile_error', compileOutput: 'error' });
      },
    });

    expect(result.status).toBe('compiled');
    expect(result.finalCode).toBe(CORRECT);
  });

  it('respects the execution budget', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, CORRECT, CORRECT, CORRECT, EXPLANATION]);
    let executions = 0;

    await solveProblem(problem(), {
      gemini: client,
      maxAttempts: 4,
      maxExecutions: 2,
      execute: async () => {
        executions++;
        return outcome({ kind: 'wrong_answer' });
      },
    });

    expect(executions).toBe(2);
  });
});

describe('solveProblem — missing contract', () => {
  it('refuses to guess a signature when LeetCode gave no template', async () => {
    const { client, prompts } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);

    const result = await solveProblem(
      problem({ javaSnippet: undefined, provenance: { ...problem().provenance, hasJavaSnippet: false } }),
      { gemini: client, execute: async () => outcome({ kind: 'passed' }) },
    );

    expect(result.status).toBe('unverified');
    expect(result.submissionReady).toBe(false);
    expect(result.readinessReason).toMatch(/Refusing to guess/);
    expect(prompts).toHaveLength(0);
  });

  it('falls back to a compile-only check when examples cannot be verified', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    const sources: string[] = [];

    const result = await solveProblem(problem({ exampleTestcases: [], exampleOutputs: [] }), {
      gemini: client,
      execute: async ({ source }) => {
        sources.push(source);
        return outcome({ kind: 'passed' });
      },
    });

    expect(sources[0]).toContain('Class<?> required = Solution.class;');
    expect(result.status).toBe('compiled');
    expect(result.checks.exampleTestsPassed).toBe(false);
    expect(result.submissionReady).toBe(false);
  });

  it('marks a run unverified when the sources disagree about the problem', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    const result = await solveProblem(
      problem({ provenance: { ...problem().provenance, consistent: false, warnings: ['pointer said a different title'] } }),
      { gemini: client, execute: async () => outcome({ kind: 'passed' }) },
    );

    // The examples passed, but the problem identity is in doubt, so it is not ready.
    expect(result.checks.exampleTestsPassed).toBe(true);
    expect(result.submissionReady).toBe(false);
  });
});

describe('solveProblem — model failures', () => {
  it('reports a model failure instead of pretending to have code', async () => {
    const failing: GeminiLike = {
      model: 'fake-model',
      usage: () => ({ geminiCalls: 1, promptTokens: 0, outputTokens: 0 }),
      generate: async () => {
        throw new Error('Gemini 503: overloaded');
      },
    };

    const result = await solveProblem(problem(), { gemini: failing, execute: async () => outcome({ kind: 'passed' }) });
    expect(result.status).toBe('unverified');
    expect(result.finalCode).toBe('');
    expect(result.statusDetail).toMatch(/503/);
  });

  it('continues without the analysis when only that call fails', async () => {
    let call = 0;
    const flaky: GeminiLike = {
      model: 'fake-model',
      usage: () => ({ geminiCalls: call, promptTokens: 0, outputTokens: 0 }),
      generate: async () => {
        call++;
        if (call === 1) throw new Error('Gemini 500: analysis blew up');
        return { text: call === 2 ? CORRECT : EXPLANATION, truncated: false, promptTokens: 0, outputTokens: 0, durationMs: 1, attempts: 1 };
      },
    };

    const result = await solveProblem(problem(), { gemini: flaky, execute: async () => outcome({ kind: 'passed' }) });
    expect(result.analysis).toBeUndefined();
    expect(result.status).toBe('additional_tests_passed');
  });

  it('emits progress events for the UI', async () => {
    const { client } = fakeGemini([ANALYSIS, CORRECT, EXPLANATION]);
    const stages: string[] = [];

    await solveProblem(problem(), {
      gemini: client,
      onEvent: (entry) => stages.push(entry.stage),
      execute: async () => outcome({ kind: 'passed' }),
    });

    expect(stages).toContain('contract');
    expect(stages).toContain('generate');
    expect(stages).toContain('signature');
    expect(stages).toContain('execute');
    expect(stages).toContain('done');
  });
});
