/**
 * The signature gate is the highest-priority guarantee in this project: a correct
 * algorithm with the wrong method name must fail. These tests include deliberately
 * malformed solutions for every failure mode the audit listed.
 */

import { describe, expect, it } from 'vitest';
import { buildContract, describeContract, describeViolationsForRepair, validateSignature } from '../java/contract.ts';
import type { ProblemMetaData } from '../types.ts';

const TWO_SUM_SNIPPET = `class Solution {
    public int[] twoSum(int[] nums, int target) {

    }
}`;

const TWO_SUM_META: ProblemMetaData = {
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]' },
};

const LFU_SNIPPET = `class LFUCache {

    public LFUCache(int capacity) {

    }

    public int get(int key) {

    }

    public void put(int key, int value) {

    }
}`;

const LFU_META: ProblemMetaData = {
  classname: 'LFUCache',
  constructor: { params: [{ name: 'capacity', type: 'integer' }] },
  methods: [
    { name: 'get', params: [{ name: 'key', type: 'integer' }], return: { type: 'integer' } },
    { name: 'put', params: [{ name: 'key', type: 'integer' }, { name: 'value', type: 'integer' }] },
  ],
};

const TREE_SNIPPET = `/**
 * Definition for a binary tree node.
 * public class TreeNode {
 *     int val;
 *     TreeNode left;
 *     TreeNode right;
 * }
 */
class Solution {
    public List<List<Integer>> levelOrder(TreeNode root) {

    }
}`;

const twoSum = buildContract(TWO_SUM_SNIPPET, TWO_SUM_META);
const lfu = buildContract(LFU_SNIPPET, LFU_META);
const tree = buildContract(TREE_SNIPPET);

const CORRECT_TWO_SUM = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            if (seen.containsKey(target - nums[i])) return new int[]{seen.get(target - nums[i]), i};
            seen.put(nums[i], i);
        }
        return new int[0];
    }
}`;

describe('buildContract', () => {
  it('reads the algorithm contract from the official snippet', () => {
    expect(twoSum.className).toBe('Solution');
    expect(twoSum.kind).toBe('algorithm');
    expect(twoSum.methods).toHaveLength(1);
    expect(twoSum.methods[0]).toMatchObject({ name: 'twoSum', returnType: 'int[]', paramTypes: ['int[]', 'int'] });
    expect(describeContract(twoSum)).toBe('algorithm class Solution: int[] twoSum(int[], int)');
  });

  it('reads a design contract, including the constructor', () => {
    expect(lfu.className).toBe('LFUCache');
    expect(lfu.kind).toBe('design');
    expect(lfu.methods.find((m) => m.isConstructor)?.paramTypes).toEqual(['int']);
    expect(lfu.methods.find((m) => m.name === 'put')?.returnType).toBe('void');
  });

  it('detects helper classes referenced through nested generics', () => {
    expect(tree.requiredHelpers).toEqual(['TreeNode']);
    expect(tree.methods[0].returnType).toBe('List<List<Integer>>');
  });

  it('refuses a snippet with no class', () => {
    expect(() => buildContract('// nothing here')).toThrow();
  });
});

describe('validateSignature — accepted solutions', () => {
  it('accepts a correct solution', () => {
    expect(validateSignature(CORRECT_TWO_SUM, twoSum).valid).toBe(true);
  });

  it('accepts private helper methods alongside the required one', () => {
    const code = `class Solution {
      public int[] twoSum(int[] nums, int target) { return helper(nums, target); }
      private int[] helper(int[] nums, int target) { return new int[0]; }
    }`;
    expect(validateSignature(code, twoSum).valid).toBe(true);
  });

  it('accepts a C-style array declarator, which is the same type', () => {
    const code = 'class Solution { public int[] twoSum(int nums[], int target) { return new int[0]; } }';
    expect(validateSignature(code, twoSum).valid).toBe(true);
  });

  it('accepts fully-qualified JDK types', () => {
    const code = `class Solution {
      public java.util.List<java.util.List<Integer>> levelOrder(TreeNode root) { return null; }
    }`;
    expect(validateSignature(code, tree).valid).toBe(true);
  });

  it('accepts a design solution with the exact interface', () => {
    const code = `class LFUCache {
      public LFUCache(int capacity) { }
      public int get(int key) { return -1; }
      public void put(int key, int value) { int x = key + value; }
    }`;
    expect(validateSignature(code, lfu).valid).toBe(true);
  });

  it('ignores declarations that only appear inside comments', () => {
    const code = `class Solution {
      // public int[] renamedThing(int[] a) { }
      /* public void nope() {} */
      public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }
    }`;
    expect(validateSignature(code, twoSum).valid).toBe(true);
  });
});

describe('validateSignature — rejected solutions', () => {
  const codes = (violation: string, code: string) => ({ violation, code });

  const cases = [
    codes('wrong_method_name', 'class Solution { public int[] findTwoSum(int[] nums, int target) { return new int[0]; } }'),
    codes('wrong_return_type', 'class Solution { public List<Integer> twoSum(int[] nums, int target) { return null; } }'),
    codes('wrong_param_types', 'class Solution { public int[] twoSum(int target, int[] nums) { return new int[0]; } }'),
    codes('wrong_param_types', 'class Solution { public int[] twoSum(Integer[] nums, int target) { return new int[0]; } }'),
    codes('wrong_param_count', 'class Solution { public int[] twoSum(int[] nums) { return new int[0]; } }'),
    codes('wrong_param_count', 'class Solution { public int[] twoSum(int[] nums, int target, int k) { return new int[0]; } }'),
    codes('wrong_class_name', 'class TwoSum { public int[] twoSum(int[] nums, int target) { return new int[0]; } }'),
    codes('not_public', 'class Solution { int[] twoSum(int[] nums, int target) { return new int[0]; } }'),
    codes('empty_body', 'class Solution { public int[] twoSum(int[] nums, int target) { } }'),
    codes('package_declaration', 'package com.x;\nclass Solution { public int[] twoSum(int[] nums, int target) { return new int[0]; } }'),
    codes('missing_method', 'class Solution { public int somethingElse(String s) { return 0; } }'),
  ];

  for (const { violation, code } of cases) {
    it(`rejects with ${violation}: ${code.slice(0, 58).replace(/\s+/g, ' ')}…`, () => {
      const result = validateSignature(code, twoSum);
      expect(result.valid).toBe(false);
      expect(result.violations.map((v) => v.code)).toContain(violation);
    });
  }

  it('names the renamed method in the violation, so the repair prompt can be specific', () => {
    const result = validateSignature('class Solution { public int[] findTwoSum(int[] nums, int target) { return new int[0]; } }', twoSum);
    const violation = result.violations.find((v) => v.code === 'wrong_method_name')!;
    expect(violation.expected).toBe('twoSum');
    expect(violation.actual).toBe('findTwoSum');
    expect(violation.message).toContain('findTwoSum');
  });

  it('rejects an unnecessary main method', () => {
    const code = `${CORRECT_TWO_SUM.slice(0, -1)}
      public static void main(String[] args) { System.out.println(1); }
    }`;
    expect(validateSignature(code, twoSum).violations.map((v) => v.code)).toContain('unexpected_main');
  });

  it('rejects redefining a judge-provided helper class', () => {
    const code = `class TreeNode { int val; TreeNode left, right; }
    class Solution { public List<List<Integer>> levelOrder(TreeNode root) { return null; } }`;
    expect(validateSignature(code, tree).violations.map((v) => v.code)).toContain('redefines_helper');
  });

  it('rejects two public top-level classes, which cannot compile in one file', () => {
    const code = `public class Helper { }
    public class Solution { public int[] twoSum(int[] nums, int target) { return new int[0]; } }`;
    expect(validateSignature(code, twoSum).violations.map((v) => v.code)).toContain('extra_public_class');
  });

  it('rejects a design solution missing the required constructor', () => {
    const code = 'class LFUCache { public int get(int key) { return -1; } public void put(int key, int value) { int x = key; } }';
    expect(validateSignature(code, lfu).violations.map((v) => v.code)).toContain('missing_constructor');
  });

  it('rejects a design solution that returns a value from a void operation', () => {
    const code = `class LFUCache {
      public LFUCache(int capacity) { }
      public int get(int key) { return -1; }
      public int put(int key, int value) { return 0; }
    }`;
    expect(validateSignature(code, lfu).violations.map((v) => v.code)).toContain('wrong_return_type');
  });

  it('rejects prose or empty output', () => {
    expect(validateSignature('Here is the solution you asked for.', twoSum).valid).toBe(false);
    expect(validateSignature('', twoSum).violations[0].code).toBe('unparseable');
  });

  it('picks the matching overload rather than the first same-named method', () => {
    const code = `class Solution {
      public int[] twoSum(int[] nums, long target) { return new int[0]; }
      public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }
    }`;
    expect(validateSignature(code, twoSum).valid).toBe(true);
  });
});

describe('describeViolationsForRepair', () => {
  it('includes the official snippet verbatim so a repair cannot change the contract', () => {
    const validation = validateSignature('class Solution { public int[] findTwoSum(int[] n, int t) { return new int[0]; } }', twoSum);
    const report = describeViolationsForRepair(validation, twoSum);
    expect(report).toContain(twoSum.source);
    expect(report).toContain('wrong_method_name');
  });
});
