/**
 * Run persistence.
 *
 * Every execution is written to Supabase as one row in `agent_runs`, keyed by a stable
 * `execution_id` so a retry updates rather than duplicates. Three properties matter:
 *
 *  - **Saving never depends on email, and email never depends on saving.** The save
 *    happens first; the notification goes out regardless; the delivery outcome is written
 *    back afterwards by a separate call.
 *  - **A failed save is never reported as a success.** When Supabase cannot be reached the
 *    record is written to a durable artifact and the failure is reported to the caller,
 *    which surfaces it in the run log, the workflow summary and the email.
 *  - **Nothing here ever sets `leetcode_accepted`.** Only authoritative confirmation from
 *    LeetCode does, and this code has none.
 *
 * The legacy `problem_history` table (37 rows, 2026-09-10 .. 2026-10-14) is never written
 * to or altered; it is still read so the dashboard keeps showing that history.
 */

import { config } from './config.ts';
import { requestJson } from './http.ts';
import type { SolveResult } from './types.ts';

export type EmailStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export type PersistenceTarget = 'supabase' | 'local-file' | 'none';

export type PersistenceResult = {
  target: PersistenceTarget;
  ok: boolean;
  detail: string;
  executionId: string;
  /** Set when the record could not reach Supabase and was parked for replay. */
  pendingFile?: string;
};

/** One row of `agent_runs`. Column names match the migration exactly. */
export type AgentRunRecord = {
  execution_id: string;
  source: string;

  question_id?: string;
  title: string;
  title_slug?: string;
  difficulty?: string;
  problem_url?: string;

  java_signature?: string;
  solution_code?: string;
  explanation?: unknown;
  time_complexity?: string;
  space_complexity?: string;

  verification_status: string;
  checks?: unknown;
  tests_total?: number;
  tests_passed?: number;
  compiled?: boolean;
  runner?: string;
  attempts?: number;
  repairs?: number;

  model?: string;
  prompt_tokens?: number;
  output_tokens?: number;
  judge0_submissions?: number;
  duration_ms?: number;

  gh_run_id?: string;
  gh_run_url?: string;
  gh_run_attempt?: number;

  email_status?: EmailStatus;
  email_sent_at?: string;

  failure_component?: string;
  failure_message?: string;
  recovery_note?: string;
};

const TABLE = 'agent_runs';
const LEGACY_TABLE = 'problem_history';

/* ------------------------------------------------------------------ *
 * Execution identity                                                  *
 * ------------------------------------------------------------------ */

/**
 * Stable per-execution key. In GitHub Actions it is derived from the run, so re-running a
 * failed attempt updates that attempt's row and a brand-new run gets its own.
 */
export function executionId(slug?: string, now: Date = new Date()): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (runId) return `gha-${runId}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  return `local-${now.toISOString().replace(/[:.]/g, '-')}-${slug ?? 'run'}`;
}

function githubRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/* ------------------------------------------------------------------ *
 * Building the record                                                 *
 * ------------------------------------------------------------------ */

export type BuildOptions = {
  source?: string;
  executionId?: string;
  emailStatus?: EmailStatus;
  failure?: { component: string; message: string };
  recoveryNote?: string;
};

export function buildRunRecord(result: SolveResult, options: BuildOptions = {}): AgentRunRecord {
  const lastExecution = [...result.attempts].reverse().find((attempt) => attempt.execution)?.execution;
  const cases = lastExecution?.cases ?? [];
  const explanation = (result as SolveResult & { explanation?: unknown }).explanation;
  const contract = (result as SolveResult & { contract?: string }).contract;

  return {
    execution_id: options.executionId ?? executionId(result.problem.titleSlug),
    source: options.source ?? 'web',

    question_id: result.problem.questionFrontendId,
    title: result.problem.title,
    title_slug: result.problem.titleSlug,
    difficulty: result.problem.difficulty,
    problem_url: result.problem.link || undefined,

    java_signature: contract ?? result.problem.javaSnippet,
    // Stored even when the run is unverified: an unverified solution is still the output.
    solution_code: result.finalCode || undefined,
    explanation: explanation ?? undefined,
    time_complexity:
      (explanation as { timeComplexity?: string } | undefined)?.timeComplexity ??
      result.analysis?.expectedTimeComplexity,
    space_complexity:
      (explanation as { spaceComplexity?: string } | undefined)?.spaceComplexity ??
      result.analysis?.expectedSpaceComplexity,

    verification_status: result.status,
    checks: result.checks,
    tests_total: cases.length || undefined,
    tests_passed: cases.length ? cases.filter((testCase) => testCase.passed).length : undefined,
    compiled: result.checks.compiled,
    runner: lastExecution?.runner,
    attempts: result.attempts.length,
    repairs: Math.max(0, result.attempts.length - 1),

    model: (result as SolveResult & { model?: string }).model,
    prompt_tokens: result.usage.promptTokens,
    output_tokens: result.usage.outputTokens,
    judge0_submissions: result.usage.judge0Submissions,
    duration_ms: result.usage.elapsedMs,

    gh_run_id: process.env.GITHUB_RUN_ID,
    gh_run_url: githubRunUrl(),
    gh_run_attempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined,

    email_status: options.emailStatus ?? 'pending',
    failure_component: options.failure?.component,
    failure_message: options.failure?.message,
    recovery_note: options.recoveryNote,
  };
}

/* ------------------------------------------------------------------ *
 * Supabase I/O                                                        *
 * ------------------------------------------------------------------ */

function restHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

/**
 * Idempotent upsert on `execution_id`. Bounded retries cover transient failures; a 4xx is
 * not retried, because repeating a rejected request only wastes time.
 */
async function upsertAgentRun(record: AgentRunRecord): Promise<{ ok: boolean; detail: string }> {
  const url = config.supabaseUrl();
  const key = config.supabaseSecretKey();

  if (!url) return { ok: false, detail: 'SUPABASE_URL is not configured.' };
  if (!key) {
    return {
      ok: false,
      detail:
        'No server-side Supabase key is configured (SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY). ' +
        'agent_runs denies the publishable key by design, so the record was not written.',
    };
  }

  const res = await requestJson(`${url.replace(/\/$/, '')}/rest/v1/${TABLE}?on_conflict=execution_id`, {
    method: 'POST',
    headers: restHeaders(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([record]),
    timeoutMs: 20_000,
    retries: 4,
  });

  if (res.transportError) return { ok: false, detail: `Supabase unreachable: ${res.transportError}` };
  if (!res.ok) {
    const hint =
      res.status === 404
        ? ` The "${TABLE}" table does not exist — apply supabase/migrations/0001_agent_runs.sql.`
        : res.status === 401 || res.status === 403
          ? ' The key was rejected; check SUPABASE_SECRET_KEY.'
          : '';
    return { ok: false, detail: `Supabase rejected the upsert (HTTP ${res.status}).${hint} ${res.body.slice(0, 200)}`.trim() };
  }

  return { ok: true, detail: `Saved to ${TABLE} (execution_id ${record.execution_id}).` };
}

/** Writes back the notification outcome. Never throws; never blocks anything. */
export async function updateEmailStatus(
  id: string,
  status: EmailStatus,
  sentAt: string = new Date().toISOString(),
): Promise<{ ok: boolean; detail: string }> {
  const url = config.supabaseUrl();
  const key = config.supabaseSecretKey();
  if (!url || !key) return { ok: false, detail: 'Supabase is not configured for writes; email status not recorded.' };

  const res = await requestJson(
    `${url.replace(/\/$/, '')}/rest/v1/${TABLE}?execution_id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: restHeaders(key, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ email_status: status, email_sent_at: status === 'sent' ? sentAt : null }),
      timeoutMs: 15_000,
      retries: 3,
    },
  );

  if (res.transportError) return { ok: false, detail: `Supabase unreachable: ${res.transportError}` };
  if (!res.ok) return { ok: false, detail: `Supabase rejected the update (HTTP ${res.status}).` };
  return { ok: true, detail: `Recorded email status "${status}" for ${id}.` };
}

/* ------------------------------------------------------------------ *
 * Durable fallback                                                    *
 * ------------------------------------------------------------------ */

const PENDING_DIR = 'pending-persist';

/** Parks a record on disk so it can be replayed once Supabase is reachable again. */
export async function writePendingRecord(record: AgentRunRecord): Promise<string | undefined> {
  try {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const dir = process.env.AGENT_PENDING_DIR ?? path.join(process.cwd(), PENDING_DIR);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.execution_id.replace(/[^\w.-]/g, '_')}.json`);
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

export async function readPendingRecords(): Promise<{ file: string; record: AgentRunRecord }[]> {
  try {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const dir = process.env.AGENT_PENDING_DIR ?? path.join(process.cwd(), PENDING_DIR);
    const names = await fs.readdir(dir);
    const out: { file: string; record: AgentRunRecord }[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const file = path.join(dir, name);
      try {
        out.push({ file, record: JSON.parse(await fs.readFile(file, 'utf8')) as AgentRunRecord });
      } catch {
        // A corrupt file must not stop the rest from being replayed.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Replays parked records. Upserts are idempotent, so this is safe to run repeatedly. */
export async function replayPendingRecords(): Promise<{ attempted: number; saved: number; details: string[] }> {
  const pending = await readPendingRecords();
  const details: string[] = [];
  let saved = 0;

  for (const { file, record } of pending) {
    const outcome = await upsertAgentRun(record);
    details.push(`${record.execution_id}: ${outcome.ok ? 'saved' : outcome.detail}`);
    if (!outcome.ok) continue;
    saved++;
    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(file);
    } catch {
      details.push(`${record.execution_id}: saved, but the pending file could not be removed`);
    }
  }

  return { attempted: pending.length, saved, details };
}

/* ------------------------------------------------------------------ *
 * Entry points                                                        *
 * ------------------------------------------------------------------ */

/**
 * Saves one run. Returns what actually happened — the caller is expected to report it
 * rather than assume success.
 */
export async function saveRun(record: AgentRunRecord): Promise<PersistenceResult> {
  const outcome = await upsertAgentRun(record);
  if (outcome.ok) {
    return { target: 'supabase', ok: true, detail: outcome.detail, executionId: record.execution_id };
  }

  const pendingFile = await writePendingRecord(record);
  return {
    target: pendingFile ? 'local-file' : 'none',
    ok: false,
    detail: pendingFile
      ? `${outcome.detail} Record parked at ${pendingFile} for replay.`
      : `${outcome.detail} The record could not be parked locally either.`,
    executionId: record.execution_id,
    pendingFile,
  };
}

/** Convenience wrapper used by the web routes. */
export async function persistRun(result: SolveResult, options: BuildOptions = {}): Promise<PersistenceResult> {
  return saveRun(buildRunRecord(result, options));
}

/* ------------------------------------------------------------------ *
 * Reading history                                                     *
 * ------------------------------------------------------------------ */

export type HistoryEntry = {
  executionId?: string;
  title: string;
  titleSlug?: string;
  difficulty: string;
  questionId?: string;
  solvedAt?: string;
  verificationStatus?: string;
  attempts?: number;
  repairs?: number;
  runner?: string;
  testsPassed?: number;
  testsTotal?: number;
  durationMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  emailStatus?: string;
  leetcodeAccepted?: boolean;
  javaSignature?: string;
  code?: string;
  source: 'agent_runs' | 'problem_history';
};

type AgentRunRow = Record<string, unknown>;

function toHistoryEntry(row: AgentRunRow): HistoryEntry {
  const str = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : undefined);
  const num = (k: string) => (typeof row[k] === 'number' ? (row[k] as number) : undefined);

  return {
    executionId: str('execution_id'),
    title: str('title') ?? '(untitled)',
    titleSlug: str('title_slug'),
    difficulty: str('difficulty') ?? 'Unknown',
    questionId: str('question_id'),
    solvedAt: str('created_at'),
    verificationStatus: str('verification_status'),
    attempts: num('attempts'),
    repairs: num('repairs'),
    runner: str('runner'),
    testsPassed: num('tests_passed'),
    testsTotal: num('tests_total'),
    durationMs: num('duration_ms'),
    promptTokens: num('prompt_tokens'),
    outputTokens: num('output_tokens'),
    emailStatus: str('email_status'),
    leetcodeAccepted: row.leetcode_accepted === true,
    javaSignature: str('java_signature'),
    code: str('solution_code'),
    source: 'agent_runs',
  };
}

/** Maps a legacy `problem_history` row onto the same shape. */
function legacyToHistoryEntry(row: AgentRunRow): HistoryEntry {
  return {
    title: typeof row.title === 'string' ? row.title : '(untitled)',
    difficulty: typeof row.difficulty === 'string' ? row.difficulty : 'Unknown',
    solvedAt: typeof row.created_at === 'string' ? row.created_at : undefined,
    // The legacy table recorded only a boolean, which cannot be promoted to a verification
    // level: it came from a harness the model wrote for itself.
    verificationStatus: row.passed === true ? 'legacy_reported_pass' : 'legacy_reported_fail',
    attempts: typeof row.attempts === 'number' ? row.attempts : undefined,
    code: typeof row.code === 'string' ? row.code : undefined,
    leetcodeAccepted: false,
    source: 'problem_history',
  };
}

export type HistoryResult = {
  source: string;
  entries: HistoryEntry[];
  detail?: string;
};

/**
 * Reads recent runs, newest first: `agent_runs` first, then the legacy table so the 37
 * historical records stay visible, then anything parked locally.
 */
export async function readHistory(limit = 20): Promise<HistoryResult> {
  const url = config.supabaseUrl();
  const key = config.supabaseKey();
  const notes: string[] = [];

  if (url && key) {
    // A page render waits on this, so it gets a short budget and few retries.
    const res = await requestJson<AgentRunRow[]>(
      `${url.replace(/\/$/, '')}/rest/v1/${TABLE}?select=*&order=created_at.desc&limit=${limit}`,
      { headers: restHeaders(key), timeoutMs: 8_000, retries: 2 },
    );

    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return { source: TABLE, entries: res.data.map(toHistoryEntry) };
    }
    if (!res.ok) notes.push(`agent_runs unavailable (HTTP ${res.status || res.transportError}).`);

    const legacy = await requestJson<AgentRunRow[]>(
      `${url.replace(/\/$/, '')}/rest/v1/${LEGACY_TABLE}?select=*&order=created_at.desc&limit=${limit}`,
      { headers: restHeaders(key), timeoutMs: 8_000, retries: 1 },
    );
    if (legacy.ok && Array.isArray(legacy.data) && legacy.data.length > 0) {
      return {
        source: LEGACY_TABLE,
        entries: legacy.data.map(legacyToHistoryEntry),
        detail: `${notes.join(' ')} Showing legacy history.`.trim(),
      };
    }
  } else {
    notes.push('Supabase is not configured.');
  }

  const pending = await readPendingRecords();
  if (pending.length > 0) {
    return {
      source: 'pending-persist',
      entries: pending
        .map(({ record }) => toHistoryEntry(record as unknown as AgentRunRow))
        .slice(0, limit),
      detail: `${notes.join(' ')} Showing records parked locally after a failed save.`.trim(),
    };
  }

  return { source: 'none', entries: [], detail: notes.join(' ') || 'No history source is available.' };
}
