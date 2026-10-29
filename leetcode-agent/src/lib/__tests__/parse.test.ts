import { describe, expect, it } from 'vitest';
import { isEmptyBody, maskSource, normalizeType, parseJava, parseParams, splitTopLevel } from '../java/parse.ts';

describe('maskSource', () => {
  it('blanks comments but keeps offsets stable', () => {
    const source = 'int a = 1; // class Fake {}\nint b = 2;';
    const masked = maskSource(source);
    expect(masked.length).toBe(source.length);
    expect(masked).not.toContain('class Fake');
    expect(masked).toContain('int b = 2;');
  });

  it('blanks block comments including the ones LeetCode uses for helper definitions', () => {
    const source = '/**\n * public class TreeNode { int val; }\n */\nclass Solution {}';
    expect(maskSource(source)).not.toContain('TreeNode');
  });

  it('blanks string contents so braces inside literals do not affect parsing', () => {
    expect(maskSource('String s = "}{";')).not.toContain('}{');
  });
});

describe('normalizeType', () => {
  it('canonicalises spacing, arrays and generics', () => {
    expect(normalizeType('int [ ]')).toBe('int[]');
    expect(normalizeType('List < List < Integer > >')).toBe('List<List<Integer>>');
    expect(normalizeType('java.util.List<Integer>')).toBe('List<Integer>');
    expect(normalizeType('final String')).toBe('String');
  });
});

describe('splitTopLevel', () => {
  it('ignores commas inside generics', () => {
    expect(splitTopLevel('Map<String, Integer> m, int k')).toEqual(['Map<String, Integer> m', 'int k']);
  });
});

describe('parseParams', () => {
  it('parses plain parameters', () => {
    expect(parseParams('int[] nums, int target')).toEqual([
      { type: 'int[]', name: 'nums', varargs: false },
      { type: 'int', name: 'target', varargs: false },
    ]);
  });

  it('handles C-style array declarators', () => {
    expect(parseParams('int nums[]')[0].type).toBe('int[]');
  });

  it('handles varargs as arrays', () => {
    const [param] = parseParams('int... values');
    expect(param.type).toBe('int[]');
    expect(param.varargs).toBe(true);
  });

  it('handles generics and annotations', () => {
    expect(parseParams('@NonNull final Map<String, List<Integer>> index')).toEqual([
      { type: 'Map<String,List<Integer>>', name: 'index', varargs: false },
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(parseParams('  ')).toEqual([]);
  });
});

describe('parseJava', () => {
  it('finds methods with modifiers, generics and bodies', () => {
    const types = parseJava(`class Solution {
      private int cache;
      private Map<Integer,Integer> seen = new HashMap<>();
      public <T extends Comparable<T>> T biggest(List<T> items) { return null; }
      public int[] twoSum(int[] nums, int target) { return new int[0]; }
    }`);

    expect(types).toHaveLength(1);
    const names = types[0].members.map((m) => m.name);
    expect(names).toContain('twoSum');
    expect(names).toContain('biggest');
    // A field initialiser containing `new HashMap<>()` must not look like a declaration.
    expect(names).not.toContain('HashMap');

    const twoSum = types[0].members.find((m) => m.name === 'twoSum')!;
    expect(twoSum.returnType).toBe('int[]');
    expect(twoSum.modifiers).toContain('public');
    expect(twoSum.params.map((p) => p.type)).toEqual(['int[]', 'int']);
  });

  it('identifies constructors', () => {
    const [type] = parseJava('class LRUCache { public LRUCache(int capacity) { } }');
    expect(type.members[0].kind).toBe('constructor');
    expect(type.members[0].params[0].type).toBe('int');
  });

  it('attributes nested class members to the nested class', () => {
    const types = parseJava(`class Solution {
      public int run() { return 0; }
      class Node { public int value() { return 1; } }
    }`);

    const solution = types.find((t) => t.name === 'Solution')!;
    const node = types.find((t) => t.name === 'Node')!;
    expect(solution.members.map((m) => m.name)).toEqual(['run']);
    expect(node.members.map((m) => m.name)).toEqual(['value']);
    expect(node.depth).toBe(1);
  });

  it('records top-level modifiers', () => {
    const [type] = parseJava('public class Main { }');
    expect(type.modifiers).toContain('public');
  });
});

describe('isEmptyBody', () => {
  it('treats whitespace and comments as empty', () => {
    expect(isEmptyBody('   \n  // todo\n ')).toBe(true);
    expect(isEmptyBody(' return 1; ')).toBe(false);
  });
});
