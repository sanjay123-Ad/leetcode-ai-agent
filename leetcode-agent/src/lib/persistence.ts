/**
 * Optional run history.
 *
 * The Supabase project configured in `.env.local` no longer resolves (audit finding C1),
 * and the old code treated that as a warning buried in a log line while reporting success.
 * Persistence is now explicitly optional: Supabase when it is reachable, a local JSON file
 * otherwise, and nothing at all on a serverless host where the filesystem is ephemeral.
 * Whatever happens is reported back to the caller instead of being swallowed.
 */

import { config } from './config.ts';
import { requestJson } from './http.ts';
import type { SolveResult } from './types.ts';

export type PersistenceResult = { target: 'supabase' | 'local-file' | 'none'; ok: boolean; detail: string };

export type HistoryRecord = {
  title: string;
  titleSlug: string;
  difficulty: string;
  questionFrontendId?: string;
  code: string;
  attempts: number;
  passed: boolean;
  status: string;
  submissionReady: boolean;
  solvedAt: string;
};

export function toHistoryRecord(result: SolveResult): HistoryRecord {
  return {
    title: result.problem.title,
    titleSlug: result.problem.titleSlug,
    difficulty: result.problem.difficulty,
    questionFrontendId: result.problem.questionFrontendId,
    code: result.finalCode,
    attempts: result.attempts.length,
    // `passed` keeps its original meaning for the existing table: the examples passed.
    passed: result.checks.exampleTestsPassed,
    status: result.status,
    submissionReady: result.submissionReady,
    solvedAt: new Date().toISOString(),
  };
}

const LEGACY_COLUMNS = ['title', 'difficulty', 'code', 'attempts', 'passed'] as const;

async function insertSupabase(record: HistoryRecord): Promise<PersistenceResult> {
  const url = config.supabaseUrl();
  const key = config.supabaseKey();
  if (!url || !key) return { target: 'none', ok: false, detail: 'Supabase is not configured.' };

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/problem_history`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'return=representation',
  };

  const extended = {
    title: record.title,
    difficulty: record.difficulty,
    code: record.code,
    attempts: record.attempts,
    passed: record.passed,
    status: record.status,
    submission_ready: record.submissionReady,
    title_slug: record.titleSlug,
  };

  let res = await requestJson<unknown[]>(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify([extended]),
    timeoutMs: 15_000,
    retries: 2,
  });

  // Older deployments of this table only have the five original columns; fall back rather
  // than lose the record.
  if (!res.ok && /column|schema/i.test(res.body)) {
    const legacy = Object.fromEntries(LEGACY_COLUMNS.map((column) => [column, record[column]]));
    res = await requestJson<unknown[]>(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify([legacy]),
      timeoutMs: 15_000,
      retries: 2,
    });
  }

  if (res.transportError) {
    return { target: 'supabase', ok: false, detail: `Supabase unreachable: ${res.transportError}` };
  }
  if (!res.ok) {
    return { target: 'supabase', ok: false, detail: `Supabase rejected the insert (HTTP ${res.status}): ${res.body.slice(0, 200)}` };
  }
  return { target: 'supabase', ok: true, detail: 'Saved to Supabase.' };
}

async function appendLocal(record: HistoryRecord): Promise<PersistenceResult> {
  if (config.isServerless()) {
    return {
      target: 'none',
      ok: false,
      detail: 'Running on a serverless host with an ephemeral filesystem, so the local history file was skipped.',
    };
  }

  try {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const file = process.env.AGENT_HISTORY_FILE ?? path.join(process.cwd(), 'history.json');

    let existing: HistoryRecord[] = [];
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as HistoryRecord[];
    } catch {
      // No history yet, or it was unreadable: start a fresh list rather than fail the run.
    }

    existing.push(record);
    // Keep the file bounded; this is a convenience log, not an archive.
    const trimmed = existing.slice(-200);
    await fs.writeFile(file, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');

    return { target: 'local-file', ok: true, detail: `Appended to ${file}` };
  } catch (error) {
    return {
      target: 'local-file',
      ok: false,
      detail: `Could not write the local history file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Persists a run, preferring Supabase and degrading gracefully. Never throws. */
export async function persistRun(result: SolveResult): Promise<PersistenceResult> {
  const record = toHistoryRecord(result);

  if (config.supabaseUrl() && config.supabaseKey()) {
    const supabase = await insertSupabase(record);
    if (supabase.ok) return supabase;

    const local = await appendLocal(record);
    return {
      target: local.ok ? 'local-file' : 'none',
      ok: local.ok,
      detail: `${supabase.detail} ${local.detail}`.trim(),
    };
  }

  return appendLocal(record);
}

/** Reads back recent runs for the history panel. Supabase first, then the local file. */
export async function readHistory(limit = 20): Promise<{ source: string; records: HistoryRecord[]; detail?: string }> {
  const url = config.supabaseUrl();
  const key = config.supabaseKey();

  if (url && key) {
    // A page render waits on this, so it gets a short budget and no retries: a slow or
    // dead history source must not hold up the UI.
    const res = await requestJson<Record<string, unknown>[]>(
      `${url.replace(/\/$/, '')}/rest/v1/problem_history?select=*&order=id.desc&limit=${limit}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, timeoutMs: 5_000, retries: 1 },
    );
    if (res.ok && Array.isArray(res.data)) {
      return { source: 'supabase', records: res.data as unknown as HistoryRecord[] };
    }
  }

  if (!config.isServerless()) {
    try {
      const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
      const file = process.env.AGENT_HISTORY_FILE ?? path.join(process.cwd(), 'history.json');
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) {
        return { source: 'local-file', records: (parsed as HistoryRecord[]).slice(-limit).reverse() };
      }
    } catch {
      // fall through to the empty result below
    }
  }

  return { source: 'none', records: [], detail: 'No history source is available.' };
}
