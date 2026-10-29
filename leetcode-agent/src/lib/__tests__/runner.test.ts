/**
 * Runner selection.
 *
 * In CI a JDK is installed, so the local runner is used and Judge0 quota is untouched.
 * On a machine without one, Judge0 takes over. With neither, the pipeline must say so
 * plainly instead of reporting an untested solution as working.
 *
 * These assertions avoid depending on whether *this* machine has a JDK, so they hold both
 * locally and on the GitHub Actions runner.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { judge0Runner, localRunner, runJava, selectRunner } from '../runner/index.ts';

beforeEach(() => {
  delete process.env.JUDGE0_API_KEY;
});

afterEach(() => {
  delete process.env.JUDGE0_API_KEY;
});

describe('selectRunner', () => {
  it('returns nothing when execution is explicitly disabled', async () => {
    expect(await selectRunner('none')).toBeUndefined();
  });

  it('picks Judge0 when asked for it and a key is configured', async () => {
    process.env.JUDGE0_API_KEY = 'test-key';
    expect(await selectRunner('judge0')).toBe(judge0Runner);
  });

  it('refuses Judge0 when no key is configured', async () => {
    expect(await selectRunner('judge0')).toBeUndefined();
  });

  it('exposes both runners with stable names', () => {
    expect(localRunner.name).toBe('local-jdk');
    expect(judge0Runner.name).toBe('judge0');
  });

  it('prefers the local JDK over Judge0 when one is available', async () => {
    process.env.JUDGE0_API_KEY = 'test-key';
    const chosen = await selectRunner('auto');
    // Whichever machine this runs on, "auto" must never pick Judge0 while a JDK is present.
    expect(chosen === localRunner || chosen === judge0Runner).toBe(true);
    if (await localRunner.available()) {
      expect(chosen).toBe(localRunner);
    } else {
      expect(chosen).toBe(judge0Runner);
    }
  });
});

describe('runJava with no runner available', () => {
  it('reports an infrastructure error rather than a passing or failing solution', async () => {
    const outcome = await runJava({ source: 'public class Main {}' }, 'none');
    expect(outcome.kind).toBe('infrastructure_error');
    expect(outcome.runner).toBe('none');
    expect(outcome.message).toMatch(/no JDK on PATH and no JUDGE0_API_KEY/i);
    expect(outcome.message).toMatch(/cannot be verified/i);
  });
});
