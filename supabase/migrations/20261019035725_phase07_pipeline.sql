-- Phase 7: one analysis per repository, a run-scoped pipeline, atomic graph
-- storage, and database-published progress. Browser clients stay read-only.

-- Existing sample rows predate one-analysis-per-project. Collapse only rows the
-- seed command created; unexpected duplicates fail the migration before any
-- change, rather than silently deleting a real result.
do $$
declare
  duplicate record;
  survivor uuid;
  sample record;
begin
  for duplicate in
    select organization_id, project_id
    from public.analyses
    group by organization_id, project_id
    having count(*) > 1
  loop
    if exists (
      select 1 from public.analyses
      where organization_id = duplicate.organization_id
        and project_id = duplicate.project_id
        and not is_seed
    ) or (
      select count(*) from public.analyses
      where organization_id = duplicate.organization_id
        and project_id = duplicate.project_id
    ) > 2 then
      raise exception 'Multiple analyses exist for organization % project %; resolve them before applying phase 7.',
        duplicate.organization_id, duplicate.project_id;
    end if;

    -- Keep the completed row when there is one so its identity survives.
    select id into survivor
    from public.analyses
    where organization_id = duplicate.organization_id
      and project_id = duplicate.project_id
    order by (status = 'completed') desc, created_at desc, id desc
    limit 1;

    for sample in
      select id from public.analyses
      where organization_id = duplicate.organization_id
        and project_id = duplicate.project_id
        and id <> survivor
    loop
      delete from public.analyses where id = sample.id;
    end loop;
  end loop;
end;
$$;

alter table public.projects
  add column canonical_repository_url text;
update public.projects
set canonical_repository_url = lower(regexp_replace(btrim(repository_url), '\.git$', '', 'i'));
-- Sample URLs are real GitHub repositories. A future non-GitHub project would
-- fail loudly here instead of being assigned a guessed canonical identity.
alter table public.projects
  alter column canonical_repository_url set not null;
alter table public.projects
  add constraint projects_canonical_repository_url_check
  check (canonical_repository_url ~ '^https://github\.com/[a-z0-9_.-]+/[a-z0-9_.-]+$');
alter table public.projects
  add constraint projects_organization_canonical_repository_key
  unique (organization_id, canonical_repository_url);

alter table public.analyses
  add column stage text
    check (stage in ('fetch', 'select', 'parse', 'store')),
  add column stage_message text not null default '',
  add column updated_at timestamptz not null default now(),
  add column failed_stage text
    check (failed_stage in ('fetch', 'select', 'parse', 'store')),
  add column commit_sha text,
  add column run_id uuid,
  add column coverage jsonb,
  add column import_records jsonb,
  add column schema_version integer
    check (schema_version is null or schema_version = 1);
alter table public.analyses
  add constraint analyses_organization_project_key unique (organization_id, project_id);

-- Sample rows have no stored graph, so a completed label would be a lie.
update public.analyses
set status = 'failed',
    started_at = null,
    completed_at = null,
    error_message = 'Sample data has no stored graph. Run the analysis from this page.',
    stage = null,
    stage_message = '',
    failed_stage = null
where is_seed;

alter table public.files
  add column folder text not null default '.',
  add column module text not null default '.',
  add column line_count integer not null default 0 check (line_count >= 0),
  add column content_hash text not null default repeat('0', 64)
    check (content_hash ~ '^[0-9a-f]{64}$'),
  add column fan_in integer not null default 0 check (fan_in >= 0),
  add column fan_out integer not null default 0 check (fan_out >= 0);

alter table public.edges
  add column kinds text[] not null default array['import']::text[]
    check (
      cardinality(kinds) > 0
      and kinds <@ array['import', 're-export', 'dynamic-import']::text[]
    );

create index analyses_organization_project_status_idx
  on public.analyses (organization_id, project_id, status);

-- A declaration, not a comment: progress cannot be published to a topic that
-- is not registered here, and the subscription policy reads the same rows.
create table private.realtime_channel_patterns (
  name text primary key,
  pattern text not null,
  event text not null,
  private boolean not null default true,
  created_at timestamptz not null default now()
);
insert into private.realtime_channel_patterns (name, pattern, event)
values ('analysis_progress', 'analysis:%:progress', 'progress');
revoke all on private.realtime_channel_patterns from public, anon, authenticated;

-- One topic per analysis. The registered template must contain exactly one %;
-- the composed topic is checked against it before realtime.send, which
-- swallows its own errors and would otherwise fail silently.
create function private.analysis_progress_topic(p_analysis_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  registered text;
  prefix text;
  suffix text;
  topic text;
begin
  if p_analysis_id is null then
    raise exception 'Analysis ID is required to compose a progress topic';
  end if;
  select realtime_channel_patterns.pattern into registered
  from private.realtime_channel_patterns
  where realtime_channel_patterns.name = 'analysis_progress'
    and realtime_channel_patterns.event = 'progress'
    and realtime_channel_patterns.private;
  if registered is null or length(registered) - length(replace(registered, '%', '')) <> 1 then
    raise exception 'Progress channel pattern is not registered exactly once';
  end if;
  prefix := split_part(registered, '%', 1);
  suffix := split_part(registered, '%', 2);
  topic := prefix || p_analysis_id::text || suffix;
  if topic <> replace(registered, '%', p_analysis_id::text) then
    raise exception 'Progress topic does not match its registered pattern';
  end if;
  return topic;
end;
$$;
revoke all on function private.analysis_progress_topic(uuid) from public, anon, authenticated;

-- The trigger publishes only what the progress UI needs. Never to_jsonb(NEW):
-- the row includes storage-only columns.
create function private.publish_analysis_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic text;
begin
  topic := private.analysis_progress_topic(new.id);
  perform realtime.send(
    jsonb_build_object(
      'analysisId', new.id,
      'runId', new.run_id,
      'status', new.status,
      'stage', new.stage,
      'message', new.stage_message,
      'updatedAt', new.updated_at,
      'failedStage', new.failed_stage,
      'completedAt', new.completed_at
    ),
    'progress',
    topic,
    true
  );
  return new;
end;
$$;
revoke all on function private.publish_analysis_progress() from public, anon, authenticated;

create trigger analyses_publish_progress
after update of status, stage, stage_message, updated_at, run_id, failed_stage, completed_at
on public.analyses
for each row
execute function private.publish_analysis_progress();

-- A new analysis row is the first visible progress event for its run.
create trigger analyses_publish_progress_insert
after insert on public.analyses
for each row
execute function private.publish_analysis_progress();

-- Subscription authorization mirrors row authorization: the topic must be the
-- registered shape and its analysis must be visible under the same org claim.
-- Do not require messages.private here: Realtime authorizes a subscription by
-- inserting probe rows without that column, so requiring it denies every join.
create policy analysis_progress_read on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and topic like 'analysis:%:progress'
  and exists (
    select 1 from public.analyses
    where analyses.id::text = split_part(topic, ':', 2)
      and analyses.organization_id = coalesce(
        nullif((select auth.jwt()) #>> '{o,id}', ''),
        nullif((select auth.jwt()) ->> 'org_id', '')
      )
  )
);

-- start_analysis returns the existing analysis untouched when the repository is
-- already known. A rerun is a separate, explicit call.
create function public.start_analysis(p_repository_url text, p_name text)
returns table (analysis_id uuid, run_id uuid, started boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_organization_id text := coalesce(
    nullif(v_claims #>> '{o,id}', ''), nullif(v_claims ->> 'org_id', '')
  );
  v_canonical text;
  v_project uuid;
  v_existing public.analyses%rowtype;
  v_run uuid := gen_random_uuid();
begin
  if nullif(v_claims ->> 'sub', '') is null or v_organization_id is null then
    raise exception 'A signed-in user with an active organization is required' using errcode = '42501';
  end if;
  v_canonical := lower(regexp_replace(btrim(p_repository_url), '\.git$', '', 'i'));
  if v_canonical !~ '^https://github\.com/[a-z0-9_.-]+/[a-z0-9_.-]+$' then
    raise exception 'Only a public GitHub repository URL is accepted' using errcode = '22023';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Repository name is required' using errcode = '22023';
  end if;

  insert into public.projects (organization_id, name, repository_url, canonical_repository_url)
  values (v_organization_id, p_name, p_repository_url, v_canonical)
  on conflict (organization_id, canonical_repository_url) do nothing;

  select projects.id into v_project
  from public.projects
  where projects.organization_id = v_organization_id
    and projects.canonical_repository_url = v_canonical;

  insert into public.analyses (organization_id, project_id, status, run_id, stage, stage_message, updated_at)
  values (v_organization_id, v_project, 'running', v_run, 'fetch', 'Fetching the repository archive', now())
  on conflict on constraint analyses_organization_project_key do nothing
  returning * into v_existing;

  if v_existing.id is not null then
    return query select v_existing.id, v_run, true;
    return;
  end if;

  select * into v_existing
  from public.analyses
  where analyses.organization_id = v_organization_id
    and analyses.project_id = v_project;
  return query select v_existing.id, v_existing.run_id, false;
end;
$$;
revoke all on function public.start_analysis(text, text) from public, anon, authenticated;
grant execute on function public.start_analysis(text, text) to authenticated;

create function public.rerun_analysis(p_analysis_id uuid)
returns table (analysis_id uuid, run_id uuid, started boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_organization_id text := coalesce(
    nullif(v_claims #>> '{o,id}', ''), nullif(v_claims ->> 'org_id', '')
  );
  v_analysis public.analyses%rowtype;
  v_run uuid := gen_random_uuid();
begin
  if nullif(v_claims ->> 'sub', '') is null or v_organization_id is null then
    raise exception 'A signed-in user with an active organization is required' using errcode = '42501';
  end if;
  select * into v_analysis
  from public.analyses
  where analyses.id = p_analysis_id
    and analyses.organization_id = v_organization_id
  for update;
  if v_analysis.id is null then
    raise exception 'Analysis not found' using errcode = 'P0002';
  end if;
  if v_analysis.status in ('queued', 'running')
    and v_analysis.updated_at > now() - interval '5 minutes' then
    return query select v_analysis.id, v_analysis.run_id, false;
    return;
  end if;

  update public.analyses
  set status = 'running', run_id = v_run, stage = 'fetch',
      stage_message = 'Fetching the repository archive', failed_stage = null,
      error_message = null, started_at = now(), completed_at = null, updated_at = now(),
      commit_sha = null, coverage = null, import_records = null, schema_version = null
  where analyses.id = v_analysis.id;
  return query select v_analysis.id, v_run, true;
end;
$$;
revoke all on function public.rerun_analysis(uuid) from public, anon, authenticated;
grant execute on function public.rerun_analysis(uuid) to authenticated;

-- Pipeline writes are service-role only and fenced by the run that claimed them.
create function public.set_analysis_stage(
  p_analysis_id uuid, p_run_id uuid, p_stage text, p_message text, p_commit_sha text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_stage not in ('fetch', 'select', 'parse', 'store') or nullif(btrim(p_message), '') is null then
    raise exception 'Invalid stage update' using errcode = '22023';
  end if;
  update public.analyses
  set stage = p_stage, stage_message = p_message, updated_at = now(),
      commit_sha = coalesce(p_commit_sha, commit_sha)
  where analyses.id = p_analysis_id and analyses.run_id = p_run_id and analyses.status = 'running';
  return found;
end;
$$;
revoke all on function public.set_analysis_stage(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_analysis_stage(uuid, uuid, text, text, text) to service_role;

create function public.fail_analysis(
  p_analysis_id uuid, p_run_id uuid, p_stage text, p_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_stage not in ('fetch', 'select', 'parse', 'store') or nullif(btrim(p_message), '') is null then
    raise exception 'Invalid failure update' using errcode = '22023';
  end if;
  update public.analyses
  set status = 'failed', failed_stage = p_stage, error_message = p_message,
      stage_message = p_message, updated_at = now(), completed_at = now()
  where analyses.id = p_analysis_id and analyses.run_id = p_run_id and analyses.status = 'running';
  return found;
end;
$$;
revoke all on function public.fail_analysis(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_analysis(uuid, uuid, text, text) to service_role;

-- Graph replacement happens in one transaction. Paths map to freshly inserted
-- file IDs; no edge is accepted unless both endpoints came from this result.
create function public.store_analysis(p_analysis_id uuid, p_run_id uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  organization_id text;
  file_entry jsonb;
  edge_entry jsonb;
  file_id uuid;
  source_id uuid;
  target_id uuid;
  inserted_files integer := 0;
  inserted_edges integer := 0;
begin
  select analyses.organization_id into organization_id
  from public.analyses
  where analyses.id = p_analysis_id and analyses.run_id = p_run_id and analyses.status = 'running'
  for update;
  if organization_id is null then
    return false;
  end if;
  if p_result is null
    or jsonb_typeof(p_result -> 'schemaVersion') is distinct from 'number'
    or (p_result ->> 'schemaVersion')::integer <> 1
    or jsonb_typeof(p_result -> 'files') is distinct from 'array'
    or jsonb_typeof(p_result -> 'edges') is distinct from 'array'
    or jsonb_typeof(p_result -> 'imports') is distinct from 'array'
    or jsonb_typeof(p_result -> 'coverage') is distinct from 'object' then
    raise exception 'Analysis result does not match schema version 1' using errcode = '22023';
  end if;

  delete from public.edges where edges.analysis_id = p_analysis_id;
  delete from public.files where files.analysis_id = p_analysis_id;
  delete from public.routes where routes.analysis_id = p_analysis_id;
  delete from public.file_roles where file_roles.analysis_id = p_analysis_id;
  delete from public.explanations where explanations.analysis_id = p_analysis_id;
  delete from public.insights where insights.analysis_id = p_analysis_id;

  for file_entry in select value from jsonb_array_elements(p_result -> 'files') loop
    insert into public.files (
      organization_id, analysis_id, path, folder, module, line_count, content_hash, fan_in, fan_out
    ) values (
      organization_id, p_analysis_id, file_entry ->> 'path', file_entry ->> 'folder',
      file_entry ->> 'module', (file_entry ->> 'lineCount')::integer,
      file_entry ->> 'contentHash', (file_entry ->> 'fanIn')::integer,
      (file_entry ->> 'fanOut')::integer
    );
    inserted_files := inserted_files + 1;
  end loop;

  for edge_entry in select value from jsonb_array_elements(p_result -> 'edges') loop
    select files.id into source_id from public.files
    where files.analysis_id = p_analysis_id and files.path = edge_entry ->> 'source';
    select files.id into target_id from public.files
    where files.analysis_id = p_analysis_id and files.path = edge_entry ->> 'target';
    if source_id is null or target_id is null then
      raise exception 'Stored edge has a missing endpoint' using errcode = '23503';
    end if;
    insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id, kinds)
    values (
      organization_id, p_analysis_id, source_id, target_id,
      array(select jsonb_array_elements_text(edge_entry -> 'kinds'))
    );
    inserted_edges := inserted_edges + 1;
  end loop;

  update public.analyses
  set status = 'completed', stage = 'store', stage_message = 'Stored the dependency map',
      updated_at = now(), completed_at = now(), failed_stage = null, error_message = null,
      coverage = p_result -> 'coverage', import_records = p_result -> 'imports',
      schema_version = 1
  where analyses.id = p_analysis_id;
  return true;
end;
$$;
revoke all on function public.store_analysis(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.store_analysis(uuid, uuid, jsonb) to service_role;
