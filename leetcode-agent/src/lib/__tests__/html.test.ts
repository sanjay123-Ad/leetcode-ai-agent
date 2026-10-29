import { describe, expect, it } from 'vitest';
import { decodeEntities, extractConstraints, extractExampleOutputs, htmlToText } from '../html.ts';

describe('decodeEntities', () => {
  it('decodes the entities LeetCode actually uses', () => {
    expect(decodeEntities('a &rarr; b')).toBe('a -> b');
    expect(decodeEntities('1 &le; n &le; 10')).toBe('1 <= n <= 10');
    expect(decodeEntities('&quot;abc&quot;')).toBe('"abc"');
    expect(decodeEntities('&amp;&lt;&gt;')).toBe('&<>');
    expect(decodeEntities('it&#39;s')).toBe("it's");
    expect(decodeEntities('&#x41;&#66;')).toBe('AB');
  });

  it('drops zero-width characters that only add token cost', () => {
    expect(decodeEntities('1023&#8203;')).toBe('1023');
  });

  it('leaves unknown entities untouched rather than mangling them', () => {
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });

  it('leaves no entity residue on a realistic statement', () => {
    const text = decodeEntities('(0, 0) &rarr; (0, 1) with 0 &le; grid[i][j] &le; 1023&#8203;');
    expect(text).not.toMatch(/&[a-z#0-9]+;/i);
  });
});

describe('htmlToText', () => {
  it('preserves block structure instead of gluing lines together', () => {
    const html = '<p>First.</p><p>Second.</p><ul><li>one</li><li>two</li></ul>';
    expect(htmlToText(html)).toBe('First.\n\nSecond.\n\n- one\n- two');
  });

  it('keeps example blocks on separate lines', () => {
    const html = '<pre><strong>Input:</strong> nums = [1,2]\n<strong>Output:</strong> 3\n</pre>';
    const text = htmlToText(html);
    expect(text).toContain('Input: nums = [1,2]');
    expect(text).toContain('Output: 3');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('strips scripts and styles', () => {
    expect(htmlToText('<style>p{color:red}</style><p>hi</p><script>alert(1)</script>')).toBe('hi');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('extractExampleOutputs', () => {
  it('reads inline outputs in document order', () => {
    const statement = 'Example 1:\nInput: nums = [1]\nOutput: [0,1]\n\nExample 2:\nInput: nums = [2]\nOutput: 7';
    expect(extractExampleOutputs(statement)).toEqual(['[0,1]', '7']);
  });

  it('reads the design-problem layout where the value sits under the label', () => {
    const statement = 'Input\n["LRUCache","get"]\n[[2],[1]]\nOutput\n[null, -1]\n\nExplanation\n...';
    expect(extractExampleOutputs(statement)).toEqual(['[null, -1]']);
  });

  it('joins a matrix split across lines', () => {
    const statement = 'Output: [[1,2],\n[3,4]]\n\nExplanation: ...';
    expect(extractExampleOutputs(statement)).toEqual(['[[1,2], [3,4]]']);
  });

  it('returns nothing when the statement has no outputs', () => {
    expect(extractExampleOutputs('Just a description.')).toEqual([]);
  });
});

describe('extractConstraints', () => {
  it('pulls out the constraints block', () => {
    const statement = 'Body text.\n\nConstraints:\n- 1 <= n <= 100\n- 0 <= v <= 9\n\nFollow-up: do it in O(n).';
    expect(extractConstraints(statement)).toBe('- 1 <= n <= 100\n- 0 <= v <= 9');
  });

  it('returns an empty string when there is no constraints block', () => {
    expect(extractConstraints('No constraints here.')).toBe('');
  });
});
