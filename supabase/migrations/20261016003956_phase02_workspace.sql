-- Clerk owns identity; this private registry supplies real organization FKs.
-- Some hosted projects include this event-trigger helper in the exposed schema.
-- It is DDL infrastructure and must not be callable through the Data API.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke all on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.organizations (
  id text primary key check (btrim(id) <> ''),
  created_at timestamptz not null default now()
);
alter table private.organizations enable row level security;
revoke all on private.organizations from public, anon, authenticated;

-- A forgotten policy must hide a new table, never expose it. DDL failures abort
-- the migration instead of leaving a table without row-level security.
create function private.enable_public_table_rls()
returns event_trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  command record;
begin
  for command in
    select object_identity
    from pg_catalog.pg_event_trigger_ddl_commands()
    where schema_name = 'public' and object_type = 'table'
  loop
    execute pg_catalog.format(
      'alter table %s enable row level security', command.object_identity
    );
  end loop;
end;
$$;
revoke all on function private.enable_public_table_rls() from public, anon, authenticated;

create event trigger cartograph_enable_public_table_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function private.enable_public_table_rls();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  repository_url text not null check (btrim(repository_url) <> ''),
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  project_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  unique (organization_id, id),
  constraint analyses_organization_id_project_id_fkey
    foreign key (organization_id, project_id)
    references public.projects(organization_id, id) on delete cascade
);
create index analyses_organization_created_at_idx
  on public.analyses (organization_id, created_at desc, id desc);
create index analyses_organization_project_idx
  on public.analyses (organization_id, project_id);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  path text not null check (btrim(path) <> ''),
  created_at timestamptz not null default now(),
  unique (organization_id, analysis_id, id),
  unique (organization_id, analysis_id, path),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade
);

create table public.edges (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  source_file_id uuid not null,
  target_file_id uuid not null,
  created_at timestamptz not null default now(),
  unique (organization_id, analysis_id, source_file_id, target_file_id),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade,
  foreign key (organization_id, analysis_id, source_file_id)
    references public.files(organization_id, analysis_id, id) on delete cascade,
  foreign key (organization_id, analysis_id, target_file_id)
    references public.files(organization_id, analysis_id, id) on delete cascade
);
create index edges_organization_analysis_target_idx
  on public.edges (organization_id, analysis_id, target_file_id);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  file_id uuid not null,
  method text not null check (btrim(method) <> ''),
  path text not null check (btrim(path) <> ''),
  created_at timestamptz not null default now(),
  unique (organization_id, analysis_id, file_id, method, path),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade,
  foreign key (organization_id, analysis_id, file_id)
    references public.files(organization_id, analysis_id, id) on delete cascade
);

create table public.explanations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  file_id uuid not null,
  content text not null check (btrim(content) <> ''),
  created_at timestamptz not null default now(),
  unique (organization_id, analysis_id, file_id),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade,
  foreign key (organization_id, analysis_id, file_id)
    references public.files(organization_id, analysis_id, id) on delete cascade
);

create table public.file_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  file_id uuid not null,
  role text not null check (btrim(role) <> ''),
  created_at timestamptz not null default now(),
  unique (organization_id, analysis_id, file_id, role),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade,
  foreign key (organization_id, analysis_id, file_id)
    references public.files(organization_id, analysis_id, id) on delete cascade
);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references private.organizations(id) on delete cascade,
  analysis_id uuid not null,
  content text not null check (btrim(content) <> ''),
  created_at timestamptz not null default now(),
  foreign key (organization_id, analysis_id)
    references public.analyses(organization_id, id) on delete cascade
);
create index insights_organization_analysis_idx
  on public.insights (organization_id, analysis_id);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    -- Supabase defaults may grant more than this read-only phase needs.
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format(
      'create policy organization_read on public.%I for select to authenticated
       using (organization_id = (select coalesce(
         nullif(auth.jwt() #>> ''{o,id}'', ''''),
         nullif(auth.jwt() ->> ''org_id'', '''')
       )))',
      table_name
    );
  end loop;
end;
$$;

-- The authenticated caller can register only the organization in its signed JWT.
-- No organization ID parameter is accepted, and no business writes are granted.
create function public.ensure_organization()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  organization_id text := coalesce(
    nullif(claims #>> '{o,id}', ''), nullif(claims ->> 'org_id', '')
  );
begin
  if nullif(claims ->> 'sub', '') is null or organization_id is null then
    raise exception 'A signed-in user with an active organization is required'
      using errcode = '42501';
  end if;
  insert into private.organizations (id) values (organization_id)
  on conflict (id) do nothing;
end;
$$;
revoke all on function public.ensure_organization() from public, anon, authenticated;
grant execute on function public.ensure_organization() to authenticated;

-- Administrative synchronization is separate from request-time authorization.
create function public.sync_organization(p_organization_id text, p_deleted boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_organization_id is null or pg_catalog.btrim(p_organization_id) = '' then
    raise exception 'Organization ID is required' using errcode = '22023';
  end if;
  if p_deleted is null then
    raise exception 'Organization deletion flag is required' using errcode = '22023';
  end if;

  if p_deleted then
    delete from private.organizations where id = p_organization_id;
  else
    insert into private.organizations (id) values (p_organization_id)
    on conflict (id) do nothing;
  end if;
end;
$$;
revoke all on function public.sync_organization(text, boolean) from public, anon, authenticated;
grant execute on function public.sync_organization(text, boolean) to service_role;

-- Bounded registry access for the local synchronization command, never users.
create function public.list_organization_ids(p_after_id text default '')
returns table (id text)
language sql
stable
security definer
set search_path = ''
as $$
  select organizations.id from private.organizations
  where organizations.id > p_after_id
  order by organizations.id
  limit 100;
$$;
revoke all on function public.list_organization_ids(text) from public, anon, authenticated;
grant execute on function public.list_organization_ids(text) to service_role;
