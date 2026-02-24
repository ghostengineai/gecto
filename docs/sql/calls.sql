-- Call transcript logging tables for Supabase/Postgres
--
-- Usage:
--   - Apply in Supabase SQL Editor (or via migrations tooling).
--   - Backend writes using SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).
--
-- Notes:
--   - This stores ONLY text metadata (transcripts + assistant responses).
--   - Do NOT store any raw audio.

-- Enable pgcrypto for gen_random_uuid() if you prefer UUID PKs.
-- create extension if not exists "pgcrypto";

create table if not exists public.calls (
  call_sid text primary key,
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  ended_at timestamptz null,
  trace_id text null,
  stream_sid text null,
  session_id text null,
  relay_input_sample_rate int null,
  relay_output_sample_rate int null
);

create index if not exists calls_created_at_idx on public.calls (created_at desc);
create index if not exists calls_trace_id_idx on public.calls (trace_id);

create table if not exists public.call_turns (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  call_sid text not null references public.calls(call_sid) on delete cascade,
  turn_index int not null,
  trace_id text null,
  stream_sid text null,
  session_id text null,
  response_id text null,
  -- Text only. Truncated server-side.
  user_text text null,
  assistant_text text null,
  instructions text null
);

create unique index if not exists call_turns_call_sid_turn_index_uniq
  on public.call_turns (call_sid, turn_index);

create index if not exists call_turns_call_sid_created_at_idx
  on public.call_turns (call_sid, created_at desc);

create index if not exists call_turns_response_id_idx
  on public.call_turns (response_id);

-- OPTIONAL: Row Level Security (RLS)
--
-- If you enable RLS, your backend can still write using the service role key.
-- The listen-in UI can either:
--   (a) read via Next.js server routes using the service role key, or
--   (b) read via anon key with explicit RLS policies.
--
-- Example (strict) approach: only allow reads when authenticated as a Supabase user.
-- alter table public.calls enable row level security;
-- alter table public.call_turns enable row level security;
--
-- -- Allow authenticated users to read (adjust to your auth model).
-- create policy "read calls" on public.calls
--   for select to authenticated
--   using (true);
--
-- create policy "read call_turns" on public.call_turns
--   for select to authenticated
--   using (true);
--
-- Writes should generally be done server-side with service role.
