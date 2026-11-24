-- Sky Remote relay (2026-11-24): Pi/laptop bridges on site <-> hosted page on apps.sonor.co.uk.
-- Bridges never get table rights: they act only through the token-checked RPCs below.
-- The page (anon / authenticated) reads v_sky_bridges and inserts + reads sky_commands.
-- Idempotent.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sky_bridges (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'Sky bridge',
  token_hash  text not null,
  version     text,
  state       jsonb not null default '{}'::jsonb,   -- { boxes:[...], scan:{...}, subnets:[...] }
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.sky_bridges enable row level security;
revoke all on public.sky_bridges from anon, authenticated;

create table if not exists public.sky_commands (
  id          bigint generated always as identity primary key,
  bridge_id   uuid not null references public.sky_bridges(id) on delete cascade,
  action      text not null check (action in ('boxes','scan','add','rename','remove','status','key')),
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending','running','done','expired')),
  code        int,
  result      jsonb,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists sky_commands_pending_idx on public.sky_commands (bridge_id, created_at) where status = 'pending';
alter table public.sky_commands enable row level security;

drop policy if exists sky_commands_insert on public.sky_commands;
create policy sky_commands_insert on public.sky_commands for insert to anon, authenticated
  with check (status = 'pending' and code is null and result is null);
drop policy if exists sky_commands_select on public.sky_commands;
create policy sky_commands_select on public.sky_commands for select to anon, authenticated
  using (created_at > now() - interval '1 hour');
grant select, insert on public.sky_commands to anon, authenticated;

-- What the page sees of a bridge (never the token hash).
create or replace view public.v_sky_bridges as
  select id, name, version, state, last_seen,
         (last_seen > now() - interval '30 seconds') as online
  from public.sky_bridges;
grant select on public.v_sky_bridges to anon, authenticated;

create or replace function public.sky__check(p_id uuid, p_token text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from sky_bridges where id = p_id
                 and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')) then
    raise exception 'invalid bridge' using errcode = '28000';
  end if;
end $$;
revoke all on function public.sky__check(uuid, text) from public, anon, authenticated;

create or replace function public.sky_bridge_register(p_name text, p_version text default null)
returns table (id uuid, token text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := encode(extensions.gen_random_bytes(24), 'hex'); v_id uuid;
begin
  insert into sky_bridges (name, token_hash, version, last_seen)
  values (left(coalesce(nullif(trim(p_name), ''), 'Sky bridge'), 60),
          encode(extensions.digest(v_token, 'sha256'), 'hex'), left(p_version, 20), now())
  returning sky_bridges.id into v_id;
  return query select v_id, v_token;
end $$;

create or replace function public.sky_bridge_heartbeat(p_id uuid, p_token text, p_name text, p_version text, p_state jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform sky__check(p_id, p_token);
  update sky_bridges set name = left(coalesce(nullif(trim(p_name), ''), name), 60), version = left(p_version, 20),
         state = coalesce(p_state, '{}'::jsonb), last_seen = now()
   where id = p_id;
end $$;

create or replace function public.sky_bridge_claim(p_id uuid, p_token text)
returns setof public.sky_commands language plpgsql security definer set search_path = public, extensions as $$
begin
  perform sky__check(p_id, p_token);
  update sky_bridges set last_seen = now() where id = p_id;
  -- a key press older than 20 s is stale: never fire it late
  update sky_commands set status = 'expired', done_at = now()
   where bridge_id = p_id and status = 'pending' and created_at < now() - interval '20 seconds';
  return query
    update sky_commands set status = 'running'
     where id in (select c.id from sky_commands c where c.bridge_id = p_id and c.status = 'pending'
                  order by c.created_at, c.id limit 10 for update skip locked)
    returning *;
end $$;

create or replace function public.sky_bridge_finish(p_id uuid, p_token text, p_cmd bigint, p_code int, p_result jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform sky__check(p_id, p_token);
  update sky_commands set status = 'done', code = p_code, result = p_result, done_at = now()
   where id = p_cmd and bridge_id = p_id;
  -- housekeeping: keep a day of history
  delete from sky_commands where bridge_id = p_id and created_at < now() - interval '1 day';
end $$;

grant execute on function public.sky_bridge_register(text, text) to anon, authenticated;
grant execute on function public.sky_bridge_heartbeat(uuid, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.sky_bridge_claim(uuid, text) to anon, authenticated;
grant execute on function public.sky_bridge_finish(uuid, text, bigint, int, jsonb) to anon, authenticated;

-- No sonor_audit trigger (§53): heartbeats update sky_bridges every few seconds and are not human edits.
