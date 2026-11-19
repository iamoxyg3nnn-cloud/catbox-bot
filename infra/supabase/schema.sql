-- Cloned Supabase/Postgres metadata schema for the Discord-backed Catbox clone.
-- This is a SEPARATE stack from any existing self-hosted Supabase instance.
-- Apply to the cloned project's Postgres database.

create extension if not exists "pgcrypto";

-- PostgREST anonymous role. RLS is enabled below, so it receives no rows.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$$;
grant usage on schema public to anon;

-- Accounts -----------------------------------------------------------------
create table if not exists users (
  id            bigint generated always as identity primary key,
  username      text not null unique,
  email         text not null unique,
  password_hash text not null,
  userhash      text not null unique,
  created_at    bigint not null,
  role          text not null default 'user' check (role in ('user', 'admin'))
);
-- Idempotent upgrade for databases created before roles existed.
alter table users add column if not exists role text not null default 'user';

create table if not exists sessions (
  token      text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  expires_at bigint not null
);
create index if not exists idx_sessions_user on sessions(user_id);

-- Files --------------------------------------------------------------------
-- Discord metadata columns are nullable: a row may briefly exist with status
-- 'queued'/'uploading' before the Discord write completes.
create table if not exists files (
  name           text primary key,
  owner_hash     text,
  original_name  text not null,
  mime           text not null,
  size           bigint not null,
  sha256         text,
  uploaded_at    bigint not null,
  expires_at     bigint,
  bot_id         text,
  channel_id     text,
  message_id     text,
  attachment_id  text,
  cdn_url        text,
  cdn_expires_at bigint,
  status         text not null default 'ready'
    check (status in ('queued','uploading','ready','failed'))
);
create index if not exists idx_files_owner on files(owner_hash);
create index if not exists idx_files_expiry on files(expires_at) where expires_at is not null;
create index if not exists idx_files_bot on files(bot_id);

-- Albums -------------------------------------------------------------------
create table if not exists albums (
  short       text primary key,
  owner_hash  text,
  title       text not null,
  description text not null default '',
  created_at  bigint not null
);
create index if not exists idx_albums_owner on albums(owner_hash);

create table if not exists album_files (
  album_short text not null references albums(short) on delete cascade,
  file_name   text not null references files(name) on delete cascade,
  position    integer not null default 0,
  primary key (album_short, file_name)
);

create table if not exists messages (
  id         bigint generated always as identity primary key,
  name       text not null,
  email      text,
  body       text not null,
  created_at bigint not null
);

-- Upload orchestration -----------------------------------------------------
create table if not exists upload_jobs (
  job_id      text primary key,
  node_id     text not null,
  bot_id      text,
  channel_id  text,
  staged_path text not null,
  status      text not null default 'queued'
    check (status in ('queued','uploading','ready','failed','dead')),
  attempts    integer not null default 0,
  last_error  text,
  created_at  bigint not null,
  updated_at  bigint not null
);
-- Fields carried from the accepted upload request through to the node worker.
-- (Required by src/adapters/supabase.js createJob; kept nullable for old rows.)
alter table upload_jobs add column if not exists owner_hash text;
alter table upload_jobs add column if not exists original_name text;
alter table upload_jobs add column if not exists mime text;
alter table upload_jobs add column if not exists size bigint;
alter table upload_jobs add column if not exists expires_at bigint;
alter table upload_jobs add column if not exists file_name text;

create index if not exists idx_jobs_status on upload_jobs(status);
create index if not exists idx_jobs_node on upload_jobs(node_id);

create table if not exists discord_bots (
  bot_id       text primary key,
  channel_id   text not null unique,
  enabled      boolean not null default true,
  health       text not null default 'unknown',
  last_used_at bigint
);

create table if not exists nodes (
  node_id        text primary key,
  hostname       text not null,
  web_url        text not null,
  status         text not null default 'unknown',
  pending        integer not null default 0,
  active         integer not null default 0,
  draining       boolean not null default false,
  staged_bytes   bigint not null default 0,
  staged_files   integer not null default 0,
  last_heartbeat bigint
);
-- Idempotent upgrade for node tables created by older builds.
alter table nodes add column if not exists staged_bytes bigint not null default 0;
alter table nodes add column if not exists staged_files integer not null default 0;

create table if not exists upload_journal (
  id         bigint generated always as identity primary key,
  job_id     text not null,
  file_name  text,
  stage      text not null,
  error      text,
  metadata   jsonb,
  attempts   integer not null default 0,
  resolved   boolean not null default false,
  created_at bigint not null
);
create index if not exists idx_journal_unresolved on upload_journal(resolved) where resolved = false;

-- Atomic job claim used by the Supabase adapter ---------------------------
-- Skips rows whose exponential-backoff timestamp is still in the future.
create or replace function claim_upload_job()
returns setof upload_jobs
language sql
volatile
security definer
set search_path = public
as $$
  update upload_jobs
     set status = 'uploading',
         attempts = attempts + 1,
         updated_at = extract(epoch from now()) * 1000
   where job_id in (
     select job_id from upload_jobs
      where status = 'queued' and updated_at <= extract(epoch from now()) * 1000
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
$$;

-- Row Level Security -------------------------------------------------------
-- The Express control plane uses the service-role key and bypasses RLS.
-- Enable RLS so an accidental anon key cannot read metadata.
alter table users          enable row level security;
alter table sessions       enable row level security;
alter table files          enable row level security;
alter table albums         enable row level security;
alter table album_files    enable row level security;
alter table messages       enable row level security;
alter table upload_jobs    enable row level security;
alter table discord_bots   enable row level security;
alter table nodes          enable row level security;
alter table upload_journal enable row level security;

-- Seed helper (run manually with real IDs; never store tokens in this table):
-- insert into discord_bots (bot_id, channel_id) values
--   ('bot-01','111111111111111111'), ... ('bot-20','222222222222222220');
