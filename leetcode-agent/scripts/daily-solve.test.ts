/**
 * Failure reporting for the GitHub Actions run.
 *
 * Two properties matter here: the notification must name the component that actually gave
 * out, and nothing it carries may contain a secret value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { classifyFailure, redact } from './daily-solve.ts';

class NamedError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.JUDGE0_API_KEY;
  delete process.env.MAIL_PASSWORD;
});

describe('classifyFailure', () => {
  it('names a configuration problem', () => {
    expect(classifyFailure(new NamedError('ConfigError', 'Missing configuration: GEMINI_API_KEY.')).component).toBe(
      'configuration',
    );
  });

  it('names the LeetCode API', () => {
    expect(
      classifyFailure(new NamedError('LeetCodeUnavailableError', "Could not determine today's daily challenge")).component,
    ).toBe('LeetCode API');
  });

  it('names Gemini', () => {
    expect(classifyFailure(new NamedError('GeminiError', 'Gemini 503: overloaded')).component).toBe('Gemini');
  });

  it('names Java execution for compiler and Judge0 failures', () => {
    expect(classifyFailure(new Error('Judge0 rate limit or daily quota reached.')).component).toBe('Java execution');
    expect(classifyFailure(new Error('javac timed out')).component).toBe('Java execution');
  });

  it('falls back to the pipeline for anything else', () => {
    expect(classifyFailure(new Error('The pipeline produced no code.')).component).toBe('pipeline');
    expect(classifyFailure('a thrown string').component).toBe('pipeline');
  });

  it('preserves the original message', () => {
    expect(classifyFailure(new Error('something specific')).message).toBe('something specific');
  });
});

describe('redact', () => {
  it('removes configured secret values from text', () => {
    process.env.GEMINI_API_KEY = 'AIzaSyFAKEKEYVALUE123456';
    const text = 'request failed with key AIzaSyFAKEKEYVALUE123456 attached';
    const safe = redact(text);
    expect(safe).not.toContain('AIzaSyFAKEKEYVALUE123456');
    expect(safe).toContain('<GEMINI_API_KEY redacted>');
  });

  it('removes several secrets at once', () => {
    process.env.GEMINI_API_KEY = 'gemini-secret-value-1234';
    process.env.JUDGE0_API_KEY = 'judge0-secret-value-5678';
    const safe = redact('gemini-secret-value-1234 and judge0-secret-value-5678');
    expect(safe).not.toMatch(/secret-value/);
  });

  it('strips key-like query parameters even when the value is unknown', () => {
    const safe = redact('GET https://example.test/v1/models?key=unknown-value-here&x=1');
    expect(safe).toContain('key=<redacted>');
    expect(safe).not.toContain('unknown-value-here');
    // Unrelated parameters are left alone.
    expect(safe).toContain('x=1');
  });

  it('ignores short values that would mangle ordinary text', () => {
    process.env.GEMINI_API_KEY = 'abc';
    expect(redact('abc is part of the alphabet')).toBe('abc is part of the alphabet');
  });

  it('leaves clean text untouched', () => {
    expect(redact('Gemini 503: the model is overloaded')).toBe('Gemini 503: the model is overloaded');
  });
});
