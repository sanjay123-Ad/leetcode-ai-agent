/**
 * Structured pipeline logging. Every stage pushes an entry so the same record can
 * be printed to the server console, streamed to the browser and stored with the run.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEntry = {
  at: string;
  level: LogLevel;
  stage: string;
  message: string;
  detail?: unknown;
};

export class RunLogger {
  private readonly entries: LogEntry[] = [];
  private readonly onEntry?: (entry: LogEntry) => void;
  private readonly prefix: string;

  constructor(options: { prefix?: string; onEntry?: (entry: LogEntry) => void } = {}) {
    this.prefix = options.prefix ?? 'agent';
    this.onEntry = options.onEntry;
  }

  log(level: LogLevel, stage: string, message: string, detail?: unknown): LogEntry {
    const entry: LogEntry = { at: new Date().toISOString(), level, stage, message, detail };
    this.entries.push(entry);
    const line = `[${this.prefix}:${stage}] ${message}`;
    if (level === 'error') console.error(line, detail ?? '');
    else if (level === 'warn') console.warn(line, detail ?? '');
    else console.log(line);
    this.onEntry?.(entry);
    return entry;
  }

  info(stage: string, message: string, detail?: unknown) { return this.log('info', stage, message, detail); }
  warn(stage: string, message: string, detail?: unknown) { return this.log('warn', stage, message, detail); }
  error(stage: string, message: string, detail?: unknown) { return this.log('error', stage, message, detail); }

  /** Human-readable lines, kept for backwards compatibility with the previous `logs: string[]` field. */
  lines(): string[] {
    return this.entries.map((e) => `[${e.stage}] ${e.message}`);
  }

  all(): LogEntry[] {
    return [...this.entries];
  }
}
