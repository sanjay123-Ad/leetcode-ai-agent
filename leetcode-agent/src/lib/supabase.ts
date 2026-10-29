/**
 * Deprecated: kept so any existing import keeps working.
 *
 * The original version called `createClient` at module load with `!` non-null assertions,
 * so a missing or unreachable Supabase configuration became an import-time crash inside
 * whatever route imported it (audit finding C11). Persistence now lives in
 * `./persistence.ts`, which is optional, non-throwing and reports what happened.
 *
 * @deprecated Use `persistRun` / `readHistory` from `./persistence.ts`.
 */

export { persistRun, saveRun, readHistory, buildRunRecord, updateEmailStatus } from './persistence.ts';
export type { AgentRunRecord, HistoryEntry, HistoryResult, PersistenceResult } from './persistence.ts';
