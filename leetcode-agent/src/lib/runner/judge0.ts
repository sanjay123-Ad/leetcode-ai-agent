/**
 * Judge0 (RapidAPI) runner.
 *
 * Two changes from the original call site: the HTTP response is actually checked before
 * its body is treated as an execution result (previously a 429 quota message was parsed
 * as a failed test run, which then triggered two pointless "self-healing" rounds — audit
 * finding C8), and infrastructure failures are reported as such so the pipeline never
 * blames the solution for them.
 */

import { config } from '../config.ts';
import { requestJson } from '../http.ts';
import { parseHarnessOutput } from '../java/harness.ts';
import { emptyOutcome, type JavaRunner, type RunRequest } from './types.ts';
import type { ExecutionOutcome } from '../types.ts';

const JAVA_LANGUAGE_ID = 62; // Java (OpenJDK 13.0.1) on judge0-ce

type Judge0Submission = {
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  status?: { id: number; description: string };
};

const decode = (value: string | null | undefined): string => {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return value;
  }
};

let submissions = 0;

export function judge0SubmissionCount(): number {
  return submissions;
}

export const judge0Runner: JavaRunner = {
  name: 'judge0',

  async available(): Promise<boolean> {
    return Boolean(config.judge0ApiKey());
  },

  async run({ source, timeoutMs = 60_000, signal }: RunRequest): Promise<ExecutionOutcome> {
    const apiKey = config.judge0ApiKey();
    if (!apiKey) {
      return emptyOutcome({
        kind: 'infrastructure_error',
        runner: 'judge0',
        message: 'JUDGE0_API_KEY is not configured, so the solution could not be compiled or executed.',
      });
    }

    const host = config.judge0Host();
    submissions++;

    const res = await requestJson<Judge0Submission>(
      `https://${host}/submissions?base64_encoded=true&wait=true`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': host,
        },
        body: JSON.stringify({
          language_id: JAVA_LANGUAGE_ID,
          source_code: Buffer.from(source, 'utf8').toString('base64'),
          cpu_time_limit: 10,
          wall_time_limit: 15,
        }),
        timeoutMs,
        // 429 means the daily allowance is gone; retrying burns more of it, so retry only
        // on transport errors and 5xx.
        retries: 3,
        retryOn: [500, 502, 503, 504],
        signal,
      },
    );

    if (res.transportError) {
      return emptyOutcome({
        kind: 'infrastructure_error',
        runner: 'judge0',
        message: `Judge0 unreachable: ${res.transportError}`,
      });
    }

    if (!res.ok || !res.data) {
      const hint =
        res.status === 401 || res.status === 403
          ? 'Judge0 rejected the API key (check JUDGE0_API_KEY and your RapidAPI subscription).'
          : res.status === 429
            ? 'Judge0 rate limit or daily quota reached.'
            : `Judge0 returned HTTP ${res.status}.`;
      return emptyOutcome({
        kind: 'infrastructure_error',
        runner: 'judge0',
        message: `${hint} ${res.body.slice(0, 200)}`.trim(),
      });
    }

    const result = res.data;
    const stdout = decode(result.stdout);
    const stderr = decode(result.stderr);
    const compileOutput = decode(result.compile_output);
    const statusId = result.status?.id ?? 0;
    const timeMs = result.time ? Math.round(Number(result.time) * 1000) : undefined;

    // 6 = Compilation Error, 5 = Time Limit Exceeded, 7..12 = runtime errors,
    // 13/14 = Judge0 internal problems.
    if (statusId === 6) {
      return emptyOutcome({ kind: 'compile_error', runner: 'judge0', compileOutput, stderr, message: 'Compilation failed', timeMs });
    }
    if (statusId === 5) {
      return emptyOutcome({ kind: 'timeout', runner: 'judge0', stdout, stderr, message: 'Judge0 time limit exceeded', timeMs });
    }
    if (statusId >= 13) {
      return emptyOutcome({
        kind: 'infrastructure_error',
        runner: 'judge0',
        stdout,
        stderr,
        message: `Judge0 internal error: ${result.status?.description ?? 'unknown'} ${decode(result.message)}`.trim(),
      });
    }

    const report = parseHarnessOutput(stdout);

    if (statusId >= 7 && statusId <= 12) {
      return emptyOutcome({
        kind: 'runtime_error',
        runner: 'judge0',
        stdout,
        stderr,
        cases: report.cases,
        message: `${result.status?.description ?? 'Runtime error'}${report.exception ? `: ${report.exception}` : ''}`,
        timeMs,
      });
    }

    if (!report.ran) {
      return emptyOutcome({
        kind: report.exception ? 'runtime_error' : 'runtime_error',
        runner: 'judge0',
        stdout,
        stderr,
        cases: report.cases,
        message: report.exception ?? 'The harness produced no RESULT line',
        timeMs,
      });
    }

    return emptyOutcome({
      kind: report.passed ? 'passed' : 'wrong_answer',
      runner: 'judge0',
      stdout,
      stderr,
      compileOutput,
      cases: report.cases,
      message: `${report.passedCount}/${report.total} checks passed`,
      timeMs,
    });
  },
};
