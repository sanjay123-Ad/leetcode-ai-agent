/**
 * One place for every outbound HTTP call.
 *
 * The original code had neither timeouts nor retries: a single transient Gemini 503
 * (observed live during the audit) aborted a whole run, and Judge0 error bodies were
 * parsed as if they were execution results (audit findings C6, C7, C8).
 */

export type HttpResult<T> = {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON, otherwise undefined. */
  data?: T;
  /** Raw body text, kept (truncated) for diagnostics. */
  body: string;
  /** Set when the request never produced a response (network error / timeout). */
  transportError?: string;
  attempts: number;
  durationMs: number;
};

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts, including the first one. */
  retries?: number;
  /** Status codes worth retrying. */
  retryOn?: number[];
  /** Hook for tests and logging. */
  onRetry?: (info: { attempt: number; status?: number; error?: string; waitMs: number }) => void;
  signal?: AbortSignal;
};

const DEFAULT_RETRY_ON = [408, 409, 425, 429, 500, 502, 503, 504];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter, capped so retries cannot outlive a request budget.
 *
 * `HTTP_RETRY_BASE_MS` shortens the base delay; it exists so test suites and local dry
 * runs do not have to sit through real backoff. Production leaves it unset.
 */
export function backoffDelay(
  attempt: number,
  baseMs = Number(process.env.HTTP_RETRY_BASE_MS) || 700,
  capMs = 8000,
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

export async function requestJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<HttpResult<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 30_000,
    retries = 3,
    retryOn = DEFAULT_RETRY_ON,
    onRetry,
    signal,
  } = options;

  const started = Date.now();
  const maxAttempts = Math.max(1, retries);
  let lastResult: HttpResult<T> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([timeout, signal]) : timeout;

    try {
      const res = await fetch(url, { method, headers, body, signal: composed });
      const text = await res.text();
      let data: T | undefined;
      try {
        data = text ? (JSON.parse(text) as T) : undefined;
      } catch {
        data = undefined;
      }

      lastResult = {
        ok: res.ok,
        status: res.status,
        data,
        body: text.slice(0, 4000),
        attempts: attempt,
        durationMs: Date.now() - started,
      };

      if (res.ok || !retryOn.includes(res.status) || attempt === maxAttempts) return lastResult;

      const waitMs = backoffDelay(attempt);
      onRetry?.({ attempt, status: res.status, waitMs });
      await sleep(waitMs);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastResult = {
        ok: false,
        status: 0,
        body: '',
        transportError: message,
        attempts: attempt,
        durationMs: Date.now() - started,
      };

      // A caller-provided abort is deliberate; never retry it.
      if (signal?.aborted || attempt === maxAttempts) return lastResult;

      const waitMs = backoffDelay(attempt);
      onRetry?.({ attempt, error: message, waitMs });
      await sleep(waitMs);
    }
  }

  return lastResult!;
}
