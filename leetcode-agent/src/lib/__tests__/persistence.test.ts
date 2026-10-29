/**
 * Persistence behaviour.
 *
 * The properties that matter: a save is idempotent, a failed save is never reported as a
 * success, a failure parks the record rather than losing it, email status is a separate
 * write that cannot block or be blocked by the save, and the publishable key is never
 * accepted for writes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRunRecord,
  executionId,
  persistRun,
  readHistory,
  readPendingRecords,
  replayPendingRecords,
  saveRun,
  updateEmailStatus,
  type AgentRunRecord,
} from '../persistence.ts';
import type { SolveResult } from '../types.ts';

const originalFetch = globalThis.fetch;
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-persist-'));
  process.env.AGENT_PENDING_DIR = join(dir, 'pending');
  // Keep retry backoff out of the test runtime; the retry logic itself is still exercised.
  process.env.HTTP_RETRY_BASE_MS = '1';
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_testvalue';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ATTEMPT;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.AGENT_PENDING_DIR;
  delete process.env.HTTP_RETRY_BASE_MS;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  await rm(dir, { recursive: true, force: true });
});

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Scripts fetch responses and records what was sent. */
function mockFetch(responses: (number | Error)[]) {
  const calls: Call[] = [];
  let i = 0;

  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses[Math.min(i++, responses.length - 1)];
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (next instanceof Error) throw next;
    return new Response(next === 204 ? null : '[]', { status: next });
  }) as unknown as typeof fetch;

  return calls;
}

function solveResult(overrides: Partial<SolveResult> = {}): SolveResult {
  return {
    problem: {
      titleSlug: 'two-sum',
      title: 'Two Sum',
      questionFrontendId: '1',
      difficulty: 'Easy',
      link: 'https://leetcode.com/problems/two-sum/',
      statement: '',
      constraints: '',
      topicTags: [],
      exampleTestcases: [],
      exampleOutputs: [],
      javaSnippet: 'class Solution { public int[] twoSum(int[] n, int t) {} }',
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
    attempts: [
      {
        attempt: 1,
        code: 'class Solution {}',
        signature: { valid: true, violations: [], observed: { methods: [] } },
        status: 'example_tests_passed',
        execution: {
          kind: 'passed',
          stdout: '',
          stderr: '',
          compileOutput: '',
          runner: 'local-jdk',
          cases: [
            { index: 0, passed: true },
            { index: 1, passed: false },
          ],
        },
      },
    ],
    submissionReady: true,
    readinessReason: '',
    logs: [],
    events: [],
    usage: { geminiCalls: 3, promptTokens: 100, outputTokens: 50, judge0Submissions: 0, elapsedMs: 12_000 },
    ...overrides,
  };
}

describe('executionId', () => {
  it('derives a stable id from the GitHub run and attempt', () => {
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_RUN_ATTEMPT = '2';
    expect(executionId('two-sum')).toBe('gha-123-2');
    // Same run, same id: a retry updates the row rather than inserting a new one.
    expect(executionId('anything-else')).toBe('gha-123-2');
  });

  it('falls back to a timestamped local id', () => {
    const id = executionId('two-sum', new Date('2026-10-29T09:00:00Z'));
    expect(id).toBe('local-2026-10-29T09-00-00-000Z-two-sum');
  });
});

describe('buildRunRecord', () => {
  it('captures the verification metadata, cost and test counts', () => {
    const record = buildRunRecord(solveResult(), { source: 'github-actions', executionId: 'gha-1-1' });

    expect(record).toMatchObject({
      execution_id: 'gha-1-1',
      source: 'github-actions',
      question_id: '1',
      title: 'Two Sum',
      title_slug: 'two-sum',
      difficulty: 'Easy',
      verification_status: 'example_tests_passed',
      compiled: true,
      runner: 'local-jdk',
      attempts: 1,
      repairs: 0,
      tests_total: 2,
      tests_passed: 1,
      duration_ms: 12_000,
      email_status: 'pending',
    });
  });

  it('records the generation model supplied by the caller', () => {
    expect(buildRunRecord(solveResult(), { model: 'gemini-3.5-flash-lite' }).model).toBe('gemini-3.5-flash-lite');
  });

  it('stores the solution even when the run is unverified', () => {
    const record = buildRunRecord(
      solveResult({
        status: 'signature_invalid',
        submissionReady: false,
        finalCode: 'class Solution { /* wrong name */ }',
      }),
    );
    expect(record.verification_status).toBe('signature_invalid');
    expect(record.solution_code).toContain('class Solution');
  });

  it('never claims LeetCode acceptance', () => {
    const record = buildRunRecord(solveResult()) as AgentRunRecord & { leetcode_accepted?: unknown };
    expect(record.leetcode_accepted).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('leetcode_accepted');
  });
});

describe('saveRun', () => {
  it('upserts idempotently on execution_id', async () => {
    const calls = mockFetch([201]);
    const result = await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-9-1' }));

    expect(result).toMatchObject({ target: 'supabase', ok: true, executionId: 'gha-9-1' });
    expect(calls[0].url).toContain('/rest/v1/agent_runs?on_conflict=execution_id');
    expect(calls[0].headers.Prefer).toContain('resolution=merge-duplicates');
    expect(calls[0].method).toBe('POST');
  });

  it('sends the privileged key, not the publishable one', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    const calls = mockFetch([201]);
    await saveRun(buildRunRecord(solveResult()));

    expect(calls[0].headers.apikey).toBe('sb_secret_testvalue');
    expect(JSON.stringify(calls[0].headers)).not.toContain('anon-key-value');
  });

  it('refuses to write with only a publishable key, and says why', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-value';
    const calls = mockFetch([201]);

    const result = await saveRun(buildRunRecord(solveResult()));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/No server-side Supabase key/);
    expect(calls).toHaveLength(0);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const calls = mockFetch([503, 201]);
    const result = await saveRun(buildRunRecord(solveResult()));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    const calls = mockFetch([400]);
    const result = await saveRun(buildRunRecord(solveResult()));
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('explains a missing table instead of a bare HTTP code', async () => {
    mockFetch([404]);
    const result = await saveRun(buildRunRecord(solveResult()));
    expect(result.detail).toMatch(/0001_agent_runs\.sql/);
  });

  it('parks the record and reports failure when Supabase is unreachable', async () => {
    mockFetch([new TypeError('fetch failed')]);
    const result = await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-7-1' }));

    expect(result.ok).toBe(false);
    expect(result.target).toBe('local-file');
    expect(result.detail).toMatch(/unreachable/);
    expect(result.pendingFile).toBeDefined();

    const parked = await readPendingRecords();
    expect(parked).toHaveLength(1);
    expect(parked[0].record.execution_id).toBe('gha-7-1');
    expect(parked[0].record.solution_code).toBe('class Solution {}');
  });

  it('never reports a save that did not happen', async () => {
    mockFetch([500]);
    const result = await saveRun(buildRunRecord(solveResult()));
    expect(result.ok).toBe(false);
    expect(result.target).not.toBe('supabase');
  });
});

describe('replayPendingRecords', () => {
  it('upserts parked records and removes them once saved', async () => {
    mockFetch([new TypeError('fetch failed')]);
    await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-5-1' }));
    expect(await readdir(process.env.AGENT_PENDING_DIR!)).toHaveLength(1);

    const calls = mockFetch([201]);
    const outcome = await replayPendingRecords();

    expect(outcome).toMatchObject({ attempted: 1, saved: 1 });
    expect(calls[0].url).toContain('on_conflict=execution_id');
    expect(await readdir(process.env.AGENT_PENDING_DIR!)).toHaveLength(0);
  });

  it('keeps the record parked when the replay also fails', async () => {
    mockFetch([new TypeError('fetch failed')]);
    await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-6-1' }));

    mockFetch([503]);
    const outcome = await replayPendingRecords();
    expect(outcome).toMatchObject({ attempted: 1, saved: 0 });
    expect(await readdir(process.env.AGENT_PENDING_DIR!)).toHaveLength(1);
  });

  it('ignores a corrupt parked file rather than aborting', async () => {
    const pending = process.env.AGENT_PENDING_DIR!;
    await rm(pending, { recursive: true, force: true });
    mockFetch([new TypeError('fetch failed')]);
    await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-8-1' }));
    await writeFile(join(pending, 'broken.json'), '{ not json', 'utf8');

    mockFetch([201]);
    const outcome = await replayPendingRecords();
    expect(outcome.attempted).toBe(1);
    expect(outcome.saved).toBe(1);
  });
});

describe('updateEmailStatus', () => {
  it('patches the row by execution_id', async () => {
    const calls = mockFetch([204]);
    const outcome = await updateEmailStatus('gha-1-1', 'sent');

    expect(outcome.ok).toBe(true);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('execution_id=eq.gha-1-1');
    expect(calls[0].body).toMatchObject({ email_status: 'sent' });
  });

  it('clears the timestamp for a non-sent status', async () => {
    const calls = mockFetch([204]);
    await updateEmailStatus('gha-1-1', 'failed');
    expect(calls[0].body).toMatchObject({ email_status: 'failed', email_sent_at: null });
  });

  it('reports a failure without throwing, so the workflow is unaffected', async () => {
    mockFetch([new TypeError('fetch failed')]);
    const outcome = await updateEmailStatus('gha-1-1', 'sent');
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/unreachable/);
  });

  it('is a no-op without credentials', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const calls = mockFetch([204]);
    const outcome = await updateEmailStatus('gha-1-1', 'sent');
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('persistence is independent of email', () => {
  it('a successful save followed by a failed email leaves the record intact', async () => {
    const calls = mockFetch([201, new TypeError('smtp down')]);
    const saved = await persistRun(solveResult(), { executionId: 'gha-4-1' });
    const emailed = await updateEmailStatus('gha-4-1', 'failed');

    expect(saved.ok).toBe(true);
    expect(emailed.ok).toBe(false);
    // The save call happened first and was not retried or undone by the email failure.
    expect(calls[0].method).toBe('POST');
  });

  it('a failed save does not prevent the caller from sending email', async () => {
    mockFetch([new TypeError('fetch failed')]);
    const saved = await persistRun(solveResult());
    // saveRun resolves rather than throwing, so the caller reaches its email step.
    expect(saved.ok).toBe(false);
    expect(saved.pendingFile).toBeDefined();
  });
});

describe('readHistory', () => {
  it('reads agent_runs and maps the metrics', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            execution_id: 'gha-1-1',
            title: 'Two Sum',
            title_slug: 'two-sum',
            difficulty: 'Easy',
            created_at: '2026-10-29T09:00:00Z',
            verification_status: 'additional_tests_passed',
            attempts: 2,
            repairs: 1,
            runner: 'local-jdk',
            tests_passed: 4,
            tests_total: 4,
            duration_ms: 61_000,
            email_status: 'sent',
            leetcode_accepted: false,
            solution_code: 'class Solution {}',
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const history = await readHistory(10);
    expect(history.source).toBe('agent_runs');
    expect(history.entries[0]).toMatchObject({
      title: 'Two Sum',
      verificationStatus: 'additional_tests_passed',
      attempts: 2,
      repairs: 1,
      testsPassed: 4,
      emailStatus: 'sent',
      leetcodeAccepted: false,
      source: 'agent_runs',
    });
  });

  it('falls back to the legacy table so the original records stay visible', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return new Response('[]', { status: 200 });
      return new Response(
        JSON.stringify([{ title: 'Old Problem', difficulty: 'Hard', passed: true, attempts: 1, code: 'class Solution {}', created_at: '2026-10-14T07:00:00Z' }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const history = await readHistory(5);
    expect(history.source).toBe('problem_history');
    expect(history.entries[0]).toMatchObject({ title: 'Old Problem', source: 'problem_history' });
    // A self-certified legacy pass must not be dressed up as a verification level.
    expect(history.entries[0].verificationStatus).toBe('legacy_reported_pass');
    expect(history.entries[0].leetcodeAccepted).toBe(false);
  });

  it('surfaces locally parked records when the database is unavailable', async () => {
    mockFetch([new TypeError('fetch failed')]);
    await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-3-1' }));

    mockFetch([new TypeError('fetch failed')]);
    const history = await readHistory(5);
    expect(history.source).toBe('pending-persist');
    expect(history.entries[0].executionId).toBe('gha-3-1');
    expect(history.detail).toMatch(/parked locally/);
  });

  it('reports no source rather than failing when nothing is configured', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const history = await readHistory();
    expect(history.entries).toEqual([]);
    expect(history.source).toBe('none');
  });
});

describe('parked records on disk', () => {
  it('are plain JSON that a human or the replay tool can read', async () => {
    mockFetch([new TypeError('fetch failed')]);
    const result = await saveRun(buildRunRecord(solveResult(), { executionId: 'gha-2-1' }));
    const parsed = JSON.parse(await readFile(result.pendingFile!, 'utf8'));
    expect(parsed.execution_id).toBe('gha-2-1');
    expect(parsed.verification_status).toBe('example_tests_passed');
  });
});

describe('failure rows', () => {
  it('records the failing component and a redacted message', async () => {
    const calls = mockFetch([201]);
    const result = await saveRun({
      execution_id: 'gha-fail-1',
      source: 'github-actions',
      title: 'Unknown problem',
      verification_status: 'failed',
      failure_component: 'Gemini',
      failure_message: 'Gemini 503: overloaded',
      email_status: 'pending',
    });

    expect(result.ok).toBe(true);
    const [row] = calls[0].body as Record<string, unknown>[];
    expect(row).toMatchObject({
      verification_status: 'failed',
      failure_component: 'Gemini',
      failure_message: 'Gemini 503: overloaded',
    });
    // A failed run has no solution to store, and none must be invented.
    expect(row.solution_code).toBeUndefined();
  });

  it('parks a failure row too, so a bad day is not an unexplained gap', async () => {
    mockFetch([new TypeError('fetch failed')]);
    const result = await saveRun({
      execution_id: 'gha-fail-2',
      source: 'github-actions',
      title: 'Unknown problem',
      verification_status: 'failed',
      failure_component: 'LeetCode API',
      email_status: 'pending',
    });

    expect(result.ok).toBe(false);
    const parked = await readPendingRecords();
    expect(parked[0].record.failure_component).toBe('LeetCode API');
  });
});
