/**
 * Judge0 response classification.
 *
 * The original code never checked the HTTP status, so a quota message was parsed as a
 * failed test run and the "self-healing" loop then spent two more model calls fixing code
 * that had never executed (audit finding C8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { judge0Runner } from '../runner/judge0.ts';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.JUDGE0_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.JUDGE0_API_KEY;
  vi.restoreAllMocks();
});

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

function mockJudge0(payload: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

const SOURCE = 'public class Main { public static void main(String[] a) { } }';

describe('judge0Runner', () => {
  it('reports availability from the API key', async () => {
    expect(await judge0Runner.available()).toBe(true);
    delete process.env.JUDGE0_API_KEY;
    expect(await judge0Runner.available()).toBe(false);
  });

  it('classifies a passing run', async () => {
    mockJudge0({ status: { id: 3, description: 'Accepted' }, stdout: b64('CASE 1 PASS\nRESULT PASSED 1/1\n'), time: '0.1' });
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('passed');
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.timeMs).toBe(100);
  });

  it('classifies a wrong answer with per-case detail', async () => {
    mockJudge0({
      status: { id: 3, description: 'Accepted' },
      stdout: b64('CASE 1 FAIL expected=[0,1] actual=[1,0]\nRESULT FAILED 0/1\n'),
    });
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('wrong_answer');
    expect(outcome.cases[0]).toMatchObject({ passed: false, expected: '[0,1]', actual: '[1,0]' });
  });

  it('classifies a compile error and keeps the compiler output', async () => {
    mockJudge0({ status: { id: 6, description: 'Compilation Error' }, compile_output: b64('Main.java:3: error: ;') });
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('compile_error');
    expect(outcome.compileOutput).toContain('error');
  });

  it('classifies a timeout', async () => {
    mockJudge0({ status: { id: 5, description: 'Time Limit Exceeded' } });
    expect((await judge0Runner.run({ source: SOURCE })).kind).toBe('timeout');
  });

  it('classifies a runtime error', async () => {
    mockJudge0({ status: { id: 11, description: 'Runtime Error (NZEC)' }, stderr: b64('Exception in thread "main"') });
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('runtime_error');
  });

  it('treats a 429 as infrastructure, not as a failing solution', async () => {
    mockJudge0({ message: 'You have exceeded the DAILY quota' }, 429);
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('infrastructure_error');
    expect(outcome.message).toMatch(/quota/i);
  });

  it('treats a rejected key as infrastructure', async () => {
    mockJudge0({ message: 'invalid key' }, 401);
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('infrastructure_error');
    expect(outcome.message).toMatch(/API key/);
  });

  it('treats a Judge0 internal error as infrastructure', async () => {
    mockJudge0({ status: { id: 13, description: 'Internal Error' } });
    expect((await judge0Runner.run({ source: SOURCE })).kind).toBe('infrastructure_error');
  });

  it('reports an unreachable host as infrastructure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('infrastructure_error');
    expect(outcome.message).toMatch(/unreachable/);
  });

  it('explains a missing API key instead of failing silently', async () => {
    delete process.env.JUDGE0_API_KEY;
    const outcome = await judge0Runner.run({ source: SOURCE });
    expect(outcome.kind).toBe('infrastructure_error');
    expect(outcome.message).toMatch(/JUDGE0_API_KEY/);
  });

  it('submits base64 so unusual characters cannot corrupt the payload', async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ status: { id: 3 }, stdout: b64('RESULT PASSED 1/1\n') }), { status: 200 });
    }) as unknown as typeof fetch;

    await judge0Runner.run({ source: 'class Main { String s = "héllo"; }' });
    const payload = JSON.parse(bodies[0]);
    expect(Buffer.from(payload.source_code, 'base64').toString('utf8')).toContain('héllo');
    expect(payload.language_id).toBe(62);
  });
});
