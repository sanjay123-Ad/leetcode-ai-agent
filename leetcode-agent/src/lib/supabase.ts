/**
 * Deprecated: kept so any existing import keeps working.
 *
 * The previous version called `createClient` at module load with `!` non-null assertions,
 * so a missing or unreachable Supabase configuration became an import-time crash inside
 * whatever route imported it (audit finding C11). Persistence now lives in
 * `./persistence.ts`, which is optional, non-throwing and reports what happened.
 *
 * @deprecated Use `persistRun` / `readHistory` from `./persistence.ts`.
 */

export { persistRun, readHistory, toHistoryRecord } from './persistence.ts';
export type { HistoryRecord, PersistenceResult } from './persistence.ts';
