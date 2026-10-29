-- 0001_agent_runs.sql
--
-- Creates the table the agent writes one row to per execution.
--
-- Additive only. It does not read, alter, or drop `problem_history`; those 37 historical
-- records (2026-09-10 .. 2026-10-14) are left exactly as they are.
--
-- Run this in the Supabase SQL Editor. Safe to run more than once.

create extension if not exists "pgcrypto";

create table if not exists public.agent_runs (
  id                   uuid primary key default gen_random_uuid(),

  -- Stable identity for idempotent upserts. A retry or a re-run of the same GitHub
  -- Actions attempt updates its row instead of inserting a duplicate.
  execution_id         text        not null unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  source               text        not null default 'github-actions',

  -- Problem identity
  question_id          text,
  title                text        not null,
  title_slug           text,
  difficulty           text,
  problem_url          text,

  -- What the agent produced
  java_signature       text,
  solution_code        text,
  explanation          jsonb,
  time_complexity      text,
  space_complexity     text,

  -- What was actually proven. `verification_status` is the ladder value; `checks` holds
  -- the individual rungs exactly as the agent reported them.
  verification_status  text        not null,
  checks               jsonb,
  tests_total          integer,
  tests_passed         integer,
  compiled             boolean,
  runner               text,
  attempts             integer,
  repairs              integer,

  -- Cost and provenance
  model                text,
  prompt_tokens        integer,
  output_tokens        integer,
  judge0_submissions   integer,
  duration_ms          integer,
  gh_run_id            text,
  gh_run_url           text,
  gh_run_attempt       integer,

  -- Notification outcome, written back after the mail step
  email_status         text        not null default 'pending',
  email_sent_at        timestamptz,

  -- Populated only when the pipeline itself failed
  failure_component    text,
  failure_message      text,

  -- THE line between "we checked what we could" and "LeetCode accepted it".
  -- The agent never sets these; only a human with authoritative confirmation does.
  leetcode_accepted    boolean     not null default false,
  leetcode_accepted_at timestamptz,

  -- Set on rows reconstructed from logs or emails rather than produced by a live run.
  recovery_note        text,

  constraint agent_runs_email_status_check
    check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  constraint agent_runs_accepted_needs_timestamp
    check (leetcode_accepted = false or leetcode_accepted_at is not null)
);

create index if not exists agent_runs_created_at_idx on public.agent_runs (created_at desc);
create index if not exists agent_runs_title_slug_idx on public.agent_runs (title_slug);
create index if not exists agent_runs_status_idx     on public.agent_runs (verification_status);

comment on table  public.agent_runs is
  'One row per agent execution. Solutions are stored even when unverified.';
comment on column public.agent_runs.execution_id is
  'Idempotency key: gha-<run_id>-<attempt> in CI, local-<iso>-<slug> otherwise.';
comment on column public.agent_runs.verification_status is
  'What was proven locally: signature_valid | compiled | example_tests_passed | additional_tests_passed | ... Never implies LeetCode acceptance.';
comment on column public.agent_runs.leetcode_accepted is
  'True only with authoritative confirmation from LeetCode. The agent never sets this.';

-- Keep updated_at honest on upserts.
create or replace function public.agent_runs_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists agent_runs_set_updated_at on public.agent_runs;
create trigger agent_runs_set_updated_at
  before update on public.agent_runs
  for each row execute function public.agent_runs_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- RLS is enabled with NO policies, which denies every request made with the
-- anon or authenticated role. The agent writes with a server-side secret key
-- (service_role / sb_secret_*), which bypasses RLS by design.
--
-- The effect: the publishable key cannot read or write this table at all.
-- ---------------------------------------------------------------------------

alter table public.agent_runs enable row level security;
alter table public.agent_runs force row level security;

revoke all on public.agent_runs from anon, authenticated;
