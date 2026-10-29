/**
 * Regression test for a bug this would otherwise hide well: the scripts compared
 * `import.meta.url` (a percent-encoded URL) against `process.argv[1]` (a filesystem
 * path). Any path containing a space — such as this project's own
 * `C:\Users\...\Leetcode AI\...` — never matched, so running a script printed nothing
 * and exited 0, looking like a successful no-op.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from './entry-point.ts';

const originalArgv = process.argv[1];

afterEach(() => {
  process.argv[1] = originalArgv;
});

describe('isEntryPoint', () => {
  it('matches the file Node was asked to run', () => {
    const path = '/home/runner/work/agent/scripts/daily-solve.ts';
    process.argv[1] = path;
    expect(isEntryPoint(pathToFileURL(path).href)).toBe(true);
  });

  it('matches a path containing spaces', () => {
    const path = 'C:\\Users\\sanja\\Downloads\\Leetcode AI\\leetcode-agent\\scripts\\daily-solve.ts';
    process.argv[1] = path;
    expect(isEntryPoint(pathToFileURL(path).href)).toBe(true);
  });

  it('does not match a different module', () => {
    process.argv[1] = '/home/runner/work/agent/scripts/daily-solve.ts';
    expect(isEntryPoint(pathToFileURL('/home/runner/work/agent/scripts/bench.ts').href)).toBe(false);
  });

  it('does not match when the module is merely imported by the entry file', () => {
    // standalone-solver.mjs imports daily-solve.ts; only the .mjs is the entry point.
    process.argv[1] = '/app/leetcode-agent/standalone-solver.mjs';
    expect(isEntryPoint(pathToFileURL('/app/leetcode-agent/scripts/daily-solve.ts').href)).toBe(false);
  });

  it('is false when there is no entry argument', () => {
    process.argv[1] = '';
    expect(isEntryPoint('file:///anything.ts')).toBe(false);
  });
});
