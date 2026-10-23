-- Cached model output belongs to the organization, not a replaceable file row.
-- The first successful write wins even when concurrent requests fill one key.
create table public.ai_cache (
  organization_id text not null references private.organizations(id) on delete cascade,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  model text not null check (btrim(model) <> ''),
  operation text not null check (operation in ('file', 'folder', 'classify')),
  result jsonb not null check (jsonb_typeof(result) = 'object' and result <> '{}'::jsonb),
  created_at timestamptz not null default now(),
  primary key (organization_id, cache_key)
);

-- AI labels never enter the adapter's structural file_roles table. Content
-- hashes tie each label to the exact parsed bytes of its completed run.
create table public.ai_run_roles (
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  run_id uuid not null,
  model text not null check (btrim(model) <> ''),
  roles jsonb not null check (jsonb_typeof(roles) = 'array'),
  primary key (organization_id, analysis_id, run_id, model),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade
);

alter table public.ai_cache enable row level security;
alter table public.ai_run_roles enable row level security;
-- Revoke Supabase's default service grants too: validation must happen at RPCs.
revoke all on public.ai_cache, public.ai_run_roles from public, anon, authenticated, service_role;
grant select on public.ai_cache, public.ai_run_roles to authenticated, service_role;

create policy organization_read on public.ai_cache for select to authenticated
using (
  organization_id = coalesce(
    nullif((select auth.jwt()) #>> '{o,id}', ''),
    nullif((select auth.jwt()) ->> 'org_id', '')
  )
);
create policy organization_read on public.ai_run_roles for select to authenticated
using (
  organization_id = coalesce(
    nullif((select auth.jwt()) #>> '{o,id}', ''),
    nullif((select auth.jwt()) ->> 'org_id', '')
  )
);

create function public.write_ai_cache(
  p_organization_id text, p_cache_key text, p_model text, p_operation text, p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(p_organization_id), '') is null
    or p_cache_key is null or p_cache_key !~ '^[0-9a-f]{64}$'
    or nullif(btrim(p_model), '') is null
    or p_operation is null or p_operation not in ('file', 'folder', 'classify')
    or jsonb_typeof(p_result) is distinct from 'object' or p_result = '{}'::jsonb then
    raise exception 'Invalid AI cache entry' using errcode = '22023';
  end if;
  -- Explanation rendering validates its structured document on read; cached
  -- classifications must also pass write_ai_roles against the current graph.
  insert into public.ai_cache (organization_id, cache_key, model, operation, result)
  values (p_organization_id, p_cache_key, p_model, p_operation, p_result)
  on conflict (organization_id, cache_key) do nothing;
end;
$$;
revoke all on function public.write_ai_cache(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.write_ai_cache(text, text, text, text, jsonb) to service_role;

create function public.write_ai_roles(
  p_analysis_id uuid, p_run_id uuid, p_model text, p_roles jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id text;
  v_role jsonb;
  v_file_id uuid;
  v_content_hash text;
begin
  -- Share the writer's row lock so a rerun cannot swap the graph between the
  -- run check, file/hash validation and annotation write.
  select a.organization_id into v_organization_id
  from public.analyses a
  where a.id = p_analysis_id and a.run_id = p_run_id and a.status = 'completed'
  for update;
  if v_organization_id is null then return false; end if;

  if nullif(btrim(p_model), '') is null or jsonb_typeof(p_roles) is distinct from 'array' then
    raise exception 'AI roles require a model and an array' using errcode = '22023';
  end if;
  for v_role in select value from jsonb_array_elements(p_roles) loop
    if jsonb_typeof(v_role) is distinct from 'object'
      or jsonb_typeof(v_role -> 'file') is distinct from 'string'
      or nullif(btrim(v_role ->> 'file'), '') is null
      or jsonb_typeof(v_role -> 'role') is distinct from 'string'
      or v_role ->> 'role' not in ('service', 'repository', 'model', 'util', 'config', 'component', 'hook')
      or jsonb_typeof(v_role -> 'contentHash') is distinct from 'string'
      or (v_role ->> 'contentHash') !~ '^[0-9a-f]{64}$'
      or v_role - array['file', 'role', 'contentHash'] <> '{}'::jsonb then
      raise exception 'Invalid nonstructural AI file role' using errcode = '22023';
    end if;
    if (v_role ->> 'file') ~ '(^|/)(__tests__|tests?|runtime-tests)(/|$)'
      or (v_role ->> 'file') ~ '\.(test|spec)\.[^.]+$'
      or (v_role ->> 'file') ~ '\.d\.[cm]?ts$' then
      raise exception 'Tests and declarations cannot receive AI roles' using errcode = '22023';
    end if;
    select f.id, f.content_hash into v_file_id, v_content_hash
    from public.files f
    where f.organization_id = v_organization_id and f.analysis_id = p_analysis_id
      and f.path = v_role ->> 'file';
    if v_file_id is null then
      raise exception 'AI role references a missing parsed file' using errcode = '23503';
    end if;
    if v_content_hash is distinct from v_role ->> 'contentHash' then
      raise exception 'AI role content hash does not match its parsed file' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.file_roles r
      where r.organization_id = v_organization_id and r.analysis_id = p_analysis_id
        and r.file_id = v_file_id
    ) then
      raise exception 'An adapter-assigned file cannot receive an AI role' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_roles) entry(value)
    group by entry.value ->> 'file' having count(*) > 1
  ) then
    raise exception 'Duplicate AI file role' using errcode = '22023';
  end if;

  insert into public.ai_run_roles (organization_id, analysis_id, run_id, model, roles)
  values (v_organization_id, p_analysis_id, p_run_id, p_model, p_roles)
  on conflict (organization_id, analysis_id, run_id, model) do update
  set roles = excluded.roles;
  return true;
end;
$$;
revoke all on function public.write_ai_roles(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.write_ai_roles(uuid, uuid, text, jsonb) to service_role;

-- Keep every legacy writer and reader untouched. Realtime's transactional
-- outbox becomes visible only when this entire graph-and-roles write commits.
create function public.store_analysis_with_ai(
  p_analysis_id uuid, p_run_id uuid, p_result jsonb, p_model text, p_roles jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_model is null and p_roles is distinct from '[]'::jsonb then
    raise exception 'AI roles must be empty when no model is configured' using errcode = '22023';
  end if;
  if not public.store_analysis(p_analysis_id, p_run_id, p_result) then return false; end if;
  if p_model is not null and not public.write_ai_roles(p_analysis_id, p_run_id, p_model, p_roles) then
    raise exception 'Completed analysis could not receive its AI roles' using errcode = '22023';
  end if;
  return true;
end;
$$;
revoke all on function public.store_analysis_with_ai(uuid, uuid, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.store_analysis_with_ai(uuid, uuid, jsonb, text, jsonb) to service_role;

create function public.read_ai_roles(p_analysis_id uuid, p_run_id uuid, p_model text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select r.roles
  from public.analyses a
  join public.ai_run_roles r on r.organization_id = a.organization_id
    and r.analysis_id = a.id and r.run_id = a.run_id
  where a.id = p_analysis_id and a.run_id = p_run_id and a.status = 'completed'
    and r.model = p_model;
$$;
revoke all on function public.read_ai_roles(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.read_ai_roles(uuid, uuid, text) to authenticated;
