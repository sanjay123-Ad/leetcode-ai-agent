-- 0002_lock_down_problem_history.sql
--
-- SECURITY MIGRATION. Run this ONLY after 0001 is applied, SUPABASE_SECRET_KEY is set as
-- a GitHub secret, and a run has been observed writing successfully with that key.
--
-- Why: `anon` currently holds SELECT and INSERT on public.problem_history. That role's key
-- is published to browsers by design, so today anyone holding it can read the whole
-- solution history and insert rows into it. Verified on 2026-10-29:
--
--     OPTIONS /rest/v1/problem_history  ->  Allow: GET, HEAD, POST
--     POST    /rest/v1/problem_history  []  ->  201   (zero-row probe, wrote nothing)
--
-- Safety check performed before writing this file: the only code touching
-- problem_history is src/lib/persistence.ts (server-side), it authenticates with
-- config.supabaseKey() which prefers the secret key, and the anon key is not present in
-- the client bundle (.next/static scanned, no match). No dashboard endpoint, workflow step
-- or frontend component depends on anon access.
--
-- NOTHING IS DELETED. This changes grants only. All 37 rows remain, readable by the
-- server-side key.

-- 1. Remove the public role's access.
revoke all on public.problem_history from anon;
revoke all on public.problem_history from authenticated;

-- 2. Turn on RLS with no policies, so even a future grant cannot expose rows to those
--    roles without an explicit policy being added.
alter table public.problem_history enable row level security;
alter table public.problem_history force row level security;

-- 3. Confirmation query — run this afterwards; it should return no rows for anon.
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name = 'problem_history'
--      and grantee in ('anon', 'authenticated');
--
-- And the data is still there:
--
--   select count(*) from public.problem_history;   -- expect 37
--
-- ---------------------------------------------------------------------------
-- ROLLBACK (database): restores exactly what was in place before.
--
--   alter table public.problem_history disable row level security;
--   grant select, insert on public.problem_history to anon;
--
-- ---------------------------------------------------------------------------
