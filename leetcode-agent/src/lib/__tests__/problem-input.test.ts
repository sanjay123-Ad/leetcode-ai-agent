import { describe, expect, it } from 'vitest';
import { problemFromText, slugFrom } from '../problem-input.ts';

describe('slugFrom', () => {
  it('accepts a bare slug', () => {
    expect(slugFrom({ titleSlug: 'two-sum' })).toBe('two-sum');
  });

  it('extracts a slug from a problem URL', () => {
    expect(slugFrom({ url: 'https://leetcode.com/problems/minimum-xor-path-in-a-grid/description/' })).toBe(
      'minimum-xor-path-in-a-grid',
    );
  });

  it('reads the slug from the legacy challengeInfo body', () => {
    expect(slugFrom({ challengeInfo: { link: 'https://leetcode.com/problems/lru-cache/' } })).toBe('lru-cache');
  });

  it('reads the slug from the legacy problem body', () => {
    expect(slugFrom({ problem: { titleSlug: 'valid-parentheses' } })).toBe('valid-parentheses');
  });

  it('lowercases a slug given in mixed case', () => {
    expect(slugFrom({ titleSlug: 'Two-Sum' })).toBe('two-sum');
  });

  it('returns undefined when there is nothing slug-like', () => {
    expect(slugFrom({ problemText: 'Given an array of integers…' })).toBeUndefined();
    expect(slugFrom({})).toBeUndefined();
  });
});

describe('problemFromText', () => {
  it('marks a pasted problem as having no official interface', () => {
    const problem = problemFromText('Given an array…\nOutput: [0,1]');
    expect(problem.provenance.hasJavaSnippet).toBe(false);
    expect(problem.provenance.hasMetaData).toBe(false);
    expect(problem.exampleTestcases).toEqual([]);
    expect(problem.provenance.warnings[0]).toMatch(/official interface/);
  });

  it('converts pasted HTML and still finds the outputs', () => {
    const problem = problemFromText('<p>Given an array&hellip;</p><pre>Output: [0,1]</pre>');
    expect(problem.statement).toContain('Given an array...');
    expect(problem.exampleOutputs).toEqual(['[0,1]']);
  });

  it('keeps plain text as-is', () => {
    const problem = problemFromText('Return the sum.');
    expect(problem.statement).toBe('Return the sum.');
  });

  it('uses the supplied title and difficulty', () => {
    const problem = problemFromText('text', { title: 'Custom', difficulty: 'Hard' });
    expect(problem.title).toBe('Custom');
    expect(problem.difficulty).toBe('Hard');
  });
});
