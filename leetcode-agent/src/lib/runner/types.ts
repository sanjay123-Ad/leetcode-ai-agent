import type { ExecutionOutcome } from '../types.ts';

export type RunRequest = {
  /** Complete Java source containing a `public class Main`. */
  source: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type JavaRunner = {
  name: ExecutionOutcome['runner'];
  /** Cheap check so the pipeline can prefer a free local JDK over Judge0 quota. */
  available(): Promise<boolean>;
  run(request: RunRequest): Promise<ExecutionOutcome>;
};

export function emptyOutcome(partial: Partial<ExecutionOutcome> & Pick<ExecutionOutcome, 'kind' | 'runner'>): ExecutionOutcome {
  return {
    stdout: '',
    stderr: '',
    compileOutput: '',
    cases: [],
    ...partial,
  };
}
