import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistRun, readHistory, toHistoryRecord } from '../persistence.ts';
import type { SolveResult } from '../types.ts';

const originalFetch = globalThis.fetch;
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-history-'));
  process.env.AGENT_HISTORY_FILE = join(dir, 'history.json');
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.VERCEL;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.AGENT_HISTORY_FILE;
  delete process.env.VERCEL;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function result(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    problem: {
      titleSlug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'Easy',
      link: '',
      statement: '',
      constraints: '',
      topicTags: [],
      exampleTestcases: [],
      exampleOutputs: [],
      questionFrontendId: '1',
      provenance: { dailySource: 't', detailSource: 't', hasJavaSnippet: true, hasMetaData: true, consistent: true, warnings: [] },
    },
    finalCode: 'class Solution {}',
    status: 'example_tests_passed',
    statusDetail: '',
    checks: {
      officialMetadata: true,
      signatureValid: true,
      compiled: true,
      exampleTestsPassed: true,
      additionalTestsPassed: false,
      verifiedByLeetCode: false,
    },
    attempts: [],
    submissionReady: true,
    readinessReason: '',
    logs: [],
    events: [],
    usage: { geminiCalls: 2, promptTokens: 1, outputTokens: 1, judge0Submissions: 1, elapsedMs: 10 },
    ...overrides,
  };
}

describe('toHistoryRecord', () => {
  it('keeps `passed` meaning "the official examples passed"', () => {
    expect(toHistoryRecord(result())).toMatchObject({
      title: 'Two Sum',
      passed: true,
      status: 'example_tests_passed',
      submissionReady: true,
    });

    const unverified = result({
      status: 'signature_valid',
      checks: { ...result().checks, exampleTestsPassed: false },
      submissionReady: false,
    });
    expect(toHistoryRecord(unverified).passed).toBe(false);
  });
});

describe('persistRun', () => {
  it('writes to the local file when Supabase is not configured', async () => {
    const outcome = await persistRun(result());
    expect(outcome).toMatchObject({ target: 'local-file', ok: true });

    const saved = JSON.parse(await readFile(process.env.AGENT_HISTORY_FILE!, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe('Two Sum');
  });

  it('appends rather than overwriting', async () => {
    await persistRun(result());
    await persistRun(result({ problem: { ...result().problem, title: 'Three Sum' } }));
    const saved = JSON.parse(await readFile(process.env.AGENT_HISTORY_FILE!, 'utf8'));
    expect(saved.map((r: { title: string }) => r.title)).toEqual(['Two Sum', 'Three Sum']);
  });

  it('falls back to the local file when the Supabase host is unreachable', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://dead-project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const outcome = await persistRun(result());
    expect(outcome.target).toBe('local-file');
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/unreachable/);
  });

  it('retries with the legacy column set when the table is older', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';

    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ message: "column 'status' does not exist" }), { status: 400 });
      }
      return new Response(JSON.stringify([{ id: 1 }]), { status: 201 });
    }) as unknown as typeof fetch;

    const outcome = await persistRun(result());
    expect(outcome).toMatchObject({ target: 'supabase', ok: true });
    expect(bodies[0]).toContain('submission_ready');
    expect(bodies[1]).not.toContain('submission_ready');
  });

  it('skips the local file on a serverless host', async () => {
    process.env.VERCEL = '1';
    const outcome = await persistRun(result());
    expect(outcome.target).toBe('none');
    expect(outcome.detail).toMatch(/serverless/);
  });

  it('never throws, whatever happens', async () => {
    process.env.AGENT_HISTORY_FILE = join(dir, 'missing-dir', 'nested', 'history.json');
    const outcome = await persistRun(result());
    expect(outcome.ok).toBe(false);
  });
});

describe('readHistory', () => {
  it('reads back what was written, newest first', async () => {
    await persistRun(result());
    await persistRun(result({ problem: { ...result().problem, title: 'Three Sum' } }));

    const history = await readHistory(10);
    expect(history.source).toBe('local-file');
    expect(history.records[0].title).toBe('Three Sum');
  });

  it('reports no source instead of failing when there is nothing to read', async () => {
    const history = await readHistory();
    expect(history.records).toEqual([]);
    expect(history.source).toBe('none');
  });
});
