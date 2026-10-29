/**
 * Runner selection: a local JDK first (free, fast, no quota), Judge0 second.
 */

import { localRunner } from './local.ts';
import { judge0Runner } from './judge0.ts';
import { emptyOutcome, type JavaRunner, type RunRequest } from './types.ts';
import type { ExecutionOutcome } from '../types.ts';

export { localRunner, judge0Runner };
export { judge0SubmissionCount } from './judge0.ts';
export type { JavaRunner, RunRequest };

export type RunnerChoice = 'auto' | 'local' | 'judge0' | 'none';

export async function selectRunner(choice: RunnerChoice = 'auto'): Promise<JavaRunner | undefined> {
  if (choice === 'none') return undefined;
  if (choice === 'local') return (await localRunner.available()) ? localRunner : undefined;
  if (choice === 'judge0') return (await judge0Runner.available()) ? judge0Runner : undefined;

  if (await localRunner.available()) return localRunner;
  if (await judge0Runner.available()) return judge0Runner;
  return undefined;
}

export async function runJava(request: RunRequest, choice: RunnerChoice = 'auto'): Promise<ExecutionOutcome> {
  const runner = await selectRunner(choice);
  if (!runner) {
    return emptyOutcome({
      kind: 'infrastructure_error',
      runner: 'none',
      message:
        'No Java runner is available: no JDK on PATH and no JUDGE0_API_KEY configured. The solution could not be compiled, so it cannot be verified.',
    });
  }
  return runner.run(request);
}
