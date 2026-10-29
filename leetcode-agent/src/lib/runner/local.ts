/**
 * Local JDK runner.
 *
 * Judge0's free tier is a small daily allowance, so when a JDK is present (CI runners get
 * one for free via `actions/setup-java`, and most development machines have one) the whole
 * compile-and-run step costs nothing. The pipeline prefers this runner and falls back to
 * Judge0 only when no JDK is on PATH.
 */

import { emptyOutcome, type JavaRunner, type RunRequest } from './types.ts';
import { parseHarnessOutput } from '../java/harness.ts';
import type { ExecutionOutcome } from '../types.ts';

let availability: Promise<boolean> | undefined;

async function node() {
  const [childProcess, fs, os, path] = await Promise.all([
    import('node:child_process'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  return { childProcess, fs, os, path };
}

function exec(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
  spawn: typeof import('node:child_process').spawn,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export const localRunner: JavaRunner = {
  name: 'local-jdk',

  async available(): Promise<boolean> {
    availability ??= (async () => {
      try {
        const { childProcess } = await node();
        const javac = await exec('javac', ['-version'], { timeoutMs: 15_000 }, childProcess.spawn);
        const java = await exec('java', ['-version'], { timeoutMs: 15_000 }, childProcess.spawn);
        return javac.code === 0 && java.code === 0;
      } catch {
        return false;
      }
    })();
    return availability;
  },

  async run({ source, timeoutMs = 20_000, signal }: RunRequest): Promise<ExecutionOutcome> {
    const { childProcess, fs, os, path } = await node();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leetcode-agent-'));

    try {
      await fs.writeFile(path.join(dir, 'Main.java'), source, 'utf8');

      const started = Date.now();
      const compile = await exec(
        'javac',
        ['-nowarn', '-d', dir, path.join(dir, 'Main.java')],
        { cwd: dir, timeoutMs, signal },
        childProcess.spawn,
      );

      if (compile.code !== 0) {
        return emptyOutcome({
          kind: 'compile_error',
          runner: 'local-jdk',
          compileOutput: `${compile.stdout}${compile.stderr}`.trim(),
          message: compile.timedOut ? 'javac timed out' : 'Compilation failed',
          timeMs: Date.now() - started,
        });
      }

      const run = await exec('java', ['-cp', dir, 'Main'], { cwd: dir, timeoutMs, signal }, childProcess.spawn);
      const report = parseHarnessOutput(run.stdout);

      if (run.timedOut) {
        return emptyOutcome({
          kind: 'timeout',
          runner: 'local-jdk',
          stdout: run.stdout,
          stderr: run.stderr,
          message: `Execution exceeded ${timeoutMs} ms`,
          timeMs: Date.now() - started,
        });
      }

      return emptyOutcome({
        kind: report.exception
          ? 'runtime_error'
          : !report.ran
            ? 'runtime_error'
            : report.passed
              ? 'passed'
              : 'wrong_answer',
        runner: 'local-jdk',
        stdout: run.stdout,
        stderr: run.stderr,
        cases: report.cases,
        message: report.exception ?? (report.ran ? `${report.passedCount}/${report.total} checks passed` : 'The harness produced no RESULT line'),
        timeMs: Date.now() - started,
      });
    } catch (error) {
      return emptyOutcome({
        kind: 'infrastructure_error',
        runner: 'local-jdk',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};
