import { describe, expect, it } from 'vitest';
import { buildContract } from '../java/contract.ts';
import { buildCompileOnlyHarness, buildHarness, canonicalJson, hoistImports, parseHarnessOutput } from '../java/harness.ts';
import type { Problem, ProblemMetaData } from '../types.ts';

function problem(overrides: Partial<Problem>): Problem {
  return {
    titleSlug: 'test-problem',
    title: 'Test Problem',
    difficulty: 'Easy',
    link: '',
    statement: '',
    constraints: '',
    topicTags: [],
    exampleTestcases: [],
    exampleOutputs: [],
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

const twoSumMeta: ProblemMetaData = {
  name: 'twoSum',
  params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
  return: { type: 'integer[]' },
};
const twoSum = buildContract('class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        \n    }\n}', twoSumMeta);
const twoSumCode = 'class Solution { public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; } }';

describe('canonicalJson', () => {
  it('matches the Java serializer formatting rules', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([[1, 2], [3]])).toBe('[[1,2],[3]]');
    expect(canonicalJson('abc')).toBe('"abc"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([null, 1])).toBe('[null,1]');
  });

  it('normalises numeric formatting so 6, 6.0 and 6.00000 agree', () => {
    expect(canonicalJson(6)).toBe('6');
    expect(canonicalJson(6.0)).toBe('6');
    expect(canonicalJson(6.00000)).toBe('6');
    expect(canonicalJson(2.5)).toBe('2.5');
    expect(canonicalJson(1 / 3)).toBe('0.33333');
  });
});

describe('hoistImports', () => {
  it('moves imports out of the solution body', () => {
    const { imports, body } = hoistImports('import java.util.PriorityQueue;\nclass Solution { }');
    expect(imports).toEqual(['import java.util.PriorityQueue;']);
    expect(body).toBe('class Solution { }');
  });

  it('drops wildcard imports the harness already emits', () => {
    expect(hoistImports('import java.util.*;\nclass Solution {}').imports).toEqual([]);
  });
});

describe('buildHarness — algorithm problems', () => {
  it('injects the solution verbatim and embeds the official expectations', () => {
    const build = buildHarness(
      problem({ exampleTestcases: ['[2,7,11,15]\n9', '[3,2,4]\n6'], exampleOutputs: ['[0,1]', '[1,2]'] }),
      twoSum,
      twoSumCode,
    );

    expect(build.supported).toBe(true);
    if (!build.supported) return;

    expect(build.source).toContain(twoSumCode);
    expect(build.source).toContain('new int[]{2, 7, 11, 15}');
    expect(build.source).toContain('__check("1", "[0,1]"');
    expect(build.source).toContain('import java.util.*;');
    expect(build.verifiableCases).toBe(2);
    // The model writes no assertions: every expected value is embedded by this code.
    expect(build.source).not.toContain('ALL_TESTS_PASSED');
  });

  it('adds a shared-instance replay to catch state leaking between cases', () => {
    const build = buildHarness(problem({ exampleTestcases: ['[2,7]\n9'], exampleOutputs: ['[0,1]'] }), twoSum, twoSumCode);
    expect(build.supported && build.extraChecks.length).toBeGreaterThan(0);
    expect(build.supported && build.source).toContain('shared-instance');
  });

  it('checks the mutated argument for a void method', () => {
    const contract = buildContract('class Solution {\n    public void moveZeroes(int[] nums) {\n        \n    }\n}', {
      name: 'moveZeroes',
      params: [{ name: 'nums', type: 'integer[]' }],
      return: { type: 'void' },
    });
    const build = buildHarness(
      problem({ exampleTestcases: ['[0,1,0,3,12]'], exampleOutputs: ['[1,3,12,0,0]'] }),
      contract,
      'class Solution { public void moveZeroes(int[] nums) { } }',
    );

    expect(build.supported).toBe(true);
    if (!build.supported) return;
    expect(build.source).toContain('__check("1", "[1,3,12,0,0]", __ser(a0_0))');
  });

  it('builds ListNode and TreeNode inputs from the official array form', () => {
    const listContract = buildContract('class Solution {\n    public ListNode mergeTwoLists(ListNode a, ListNode b) {\n        \n    }\n}');
    const build = buildHarness(
      problem({ exampleTestcases: ['[1,2,4]\n[1,3,4]'], exampleOutputs: ['[1,1,2,3,4,4]'] }),
      listContract,
      'class Solution { public ListNode mergeTwoLists(ListNode a, ListNode b) { return a; } }',
    );

    expect(build.supported).toBe(true);
    if (!build.supported) return;
    expect(build.source).toContain('__toListNode(new Integer[]{1, 2, 4})');
    expect(build.source).toContain('class ListNode');
    // A null list must serialise as [], the way LeetCode prints it.
    expect(build.source).toContain('__serNode');
  });

  it('refuses to invent an expectation when the statement has no matching Output', () => {
    const build = buildHarness(problem({ exampleTestcases: ['[2,7]\n9'], exampleOutputs: [] }), twoSum, twoSumCode);
    expect(build.supported).toBe(false);
    if (build.supported) return;
    expect(build.cases[0].reason).toMatch(/no matching Output/);
  });

  it('skips only the unsupported cases and keeps the rest', () => {
    const build = buildHarness(
      problem({ exampleTestcases: ['[2,7]\n9', '[3,2]\n6'], exampleOutputs: ['[0,1]', 'any valid pair'] }),
      twoSum,
      twoSumCode,
    );
    expect(build.supported).toBe(true);
    if (!build.supported) return;
    expect(build.verifiableCases).toBe(1);
    expect(build.notes.join(' ')).toMatch(/could not be checked deterministically/);
  });

  it('reports unsupported helper types instead of guessing', () => {
    const contract = buildContract('class Solution {\n    public Node cloneGraph(Node node) {\n        \n    }\n}');
    const build = buildHarness(problem({ exampleTestcases: ['[[2,4]]'], exampleOutputs: ['[[2,4]]'] }), contract, 'class Solution { public Node cloneGraph(Node node) { return node; } }');
    expect(build.supported).toBe(false);
    if (build.supported) return;
    expect(build.reason).toMatch(/Node/);
  });

  it('reports when LeetCode gave no example cases at all', () => {
    const build = buildHarness(problem({}), twoSum, twoSumCode);
    expect(build.supported).toBe(false);
  });
});

describe('buildHarness — design problems', () => {
  const lfu = buildContract(
    'class LFUCache {\n public LFUCache(int capacity) { }\n public int get(int key) { }\n public void put(int key, int value) { }\n}',
    {
      classname: 'LFUCache',
      constructor: { params: [{ name: 'capacity', type: 'integer' }] },
      methods: [
        { name: 'get', params: [{ name: 'key', type: 'integer' }], return: { type: 'integer' } },
        { name: 'put', params: [{ name: 'key', type: 'integer' }, { name: 'value', type: 'integer' }] },
      ],
    },
  );

  const code = `class LFUCache {
    public LFUCache(int capacity) { }
    public int get(int key) { return -1; }
    public void put(int key, int value) { int ignored = key + value; }
  }`;

  it('replays the official operation sequence in order', () => {
    const build = buildHarness(
      problem({
        exampleTestcases: ['["LFUCache","put","get"]\n[[2],[1,1],[1]]'],
        exampleOutputs: ['[null,null,1]'],
      }),
      lfu,
      code,
    );

    expect(build.supported).toBe(true);
    if (!build.supported) return;
    expect(build.source).toContain('LFUCache obj0 = new LFUCache(2);');
    expect(build.source).toContain('obj0.put(1, 1);');
    expect(build.source).toContain('__check("1.3 get", "1"');
  });

  it('rejects an operation that is not in the official contract', () => {
    const build = buildHarness(
      problem({ exampleTestcases: ['["LFUCache","evict"]\n[[2],[1]]'], exampleOutputs: ['[null,null]'] }),
      lfu,
      code,
    );
    expect(build.supported).toBe(false);
    if (build.supported) return;
    expect(build.reason).toMatch(/not in the official contract/);
  });

  it('rejects mismatched operation and expectation lengths', () => {
    const build = buildHarness(
      problem({ exampleTestcases: ['["LFUCache","get"]\n[[2],[1]]'], exampleOutputs: ['[null]'] }),
      lfu,
      code,
    );
    expect(build.supported).toBe(false);
  });
});

describe('buildCompileOnlyHarness', () => {
  it('references the required class so javac type-checks it', () => {
    const source = buildCompileOnlyHarness(twoSum, twoSumCode);
    expect(source).toContain('Class<?> required = Solution.class;');
    expect(source).toContain('RESULT PASSED 1/1');
    expect(source).toContain(twoSumCode);
  });
});

describe('parseHarnessOutput', () => {
  it('parses a passing run', () => {
    const report = parseHarnessOutput('CASE 1 PASS\nCASE 2 PASS\nRESULT PASSED 2/2\n');
    expect(report).toMatchObject({ ran: true, passed: true, total: 2, passedCount: 2 });
    expect(report.cases).toHaveLength(2);
  });

  it('parses a failing case with expected and actual values', () => {
    const report = parseHarnessOutput('CASE 1 FAIL expected=[0,1] actual=[1,0]\nRESULT FAILED 0/1\n');
    expect(report.passed).toBe(false);
    expect(report.cases[0]).toMatchObject({ passed: false, expected: '[0,1]', actual: '[1,0]' });
  });

  it('surfaces a harness exception', () => {
    const report = parseHarnessOutput('HARNESS_EXCEPTION java.lang.NullPointerException: boom\nRESULT FAILED 0/1\n');
    expect(report.exception).toContain('NullPointerException');
  });

  it('treats missing output as "did not run"', () => {
    expect(parseHarnessOutput('').ran).toBe(false);
  });
});
