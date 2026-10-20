-- Run as the migration owner with pnpm db:verify.
-- Every fixture, probe row and message rolls back. This file runs after
-- phase02.sql, which still checks the original tenancy and read-only RLS.

begin;

-- Schema contracts the application relies on. A missing column or check would
-- surface later as a silent empty map, so fail here instead.
do $$
declare
  v_column_name text;
begin
  foreach v_column_name in array array[
    'stage', 'stage_message', 'updated_at', 'failed_stage', 'commit_sha',
    'run_id', 'coverage', 'import_records', 'schema_version'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'analyses' and columns.column_name = v_column_name
    ) then
      raise exception 'analyses is missing %', v_column_name;
    end if;
  end loop;

  foreach v_column_name in array array[
    'folder', 'module', 'line_count', 'content_hash', 'fan_in', 'fan_out'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'files' and columns.column_name = v_column_name
    ) then
      raise exception 'files is missing %', v_column_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.analyses'::regclass
      and conname = 'analyses_organization_project_key'
  ) then
    raise exception 'One-analysis-per-project constraint is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass
      and conname = 'projects_organization_canonical_repository_key'
  ) then
    raise exception 'Canonical repository uniqueness is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass
      and conname = 'projects_canonical_repository_url_check'
  ) then
    raise exception 'Canonical repository URL check is missing';
  end if;

  -- Progress triggers belong to our table, never to Realtime internals.
  if (select count(*) from pg_trigger
      where tgrelid = 'public.analyses'::regclass and not tgisinternal
        and tgname in ('analyses_publish_progress', 'analyses_publish_progress_insert')) <> 2 then
    raise exception 'Progress triggers are missing from public.analyses';
  end if;
  if exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where n.nspname = 'realtime' and c.relname in ('messages', 'subscription')
      and not t.tgisinternal and pn.nspname in ('public', 'private')
  ) then
    raise exception 'A progress trigger was attached to a Realtime table';
  end if;

  -- The channel is declared in the migration, not implied by application code.
  if (select count(*) from private.realtime_channel_patterns
      where name = 'analysis_progress' and pattern = 'analysis:%:progress'
        and event = 'progress' and private) <> 1 then
    raise exception 'The analysis progress channel is not registered';
  end if;

  if (select count(*) from pg_policies
      where schemaname = 'realtime' and tablename = 'messages'
        and policyname = 'analysis_progress_read' and cmd = 'SELECT') <> 1 then
    raise exception 'Progress subscription policy is missing';
  end if;

  if not has_function_privilege('authenticated', 'public.start_analysis(text,text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.rerun_analysis(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.start_analysis(text,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.rerun_analysis(uuid)', 'EXECUTE') then
    raise exception 'Analysis RPC privileges are incorrect';
  end if;

  -- Pipeline writes are service-role only.
  if has_function_privilege('authenticated', 'public.set_analysis_stage(uuid,uuid,text,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.fail_analysis(uuid,uuid,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.set_analysis_stage(uuid,uuid,text,text,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.fail_analysis(uuid,uuid,text,text)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE') then
    raise exception 'Pipeline RPC privileges are incorrect';
  end if;

  if has_function_privilege('authenticated', 'private.analysis_progress_topic(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'private.publish_analysis_progress()', 'EXECUTE')
    or has_table_privilege('authenticated', 'private.realtime_channel_patterns', 'SELECT') then
    raise exception 'Private progress internals are reachable by authenticated users';
  end if;

  if private.analysis_progress_topic('20000000-0000-4000-8000-000000000001')
      <> 'analysis:20000000-0000-4000-8000-000000000001:progress' then
    raise exception 'Progress topic composition does not follow the registered pattern';
  end if;
end;
$$;

-- Result builder for the storage checks. The caller chooses the second file
-- and the edge target so one call can be valid and another can be broken.
create function private.phase07_result(p_second_path text, p_target text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'files', jsonb_build_array(
      jsonb_build_object(
        'path', 'src/a.ts', 'folder', 'src', 'module', '.', 'lineCount', 10,
        'contentHash', repeat('a', 64), 'fanIn', 0, 'fanOut', 1
      ),
      jsonb_build_object(
        'path', p_second_path, 'folder', 'src', 'module', '.', 'lineCount', 20,
        'contentHash', repeat('b', 64), 'fanIn', 1, 'fanOut', 0
      )
    ),
    'edges', jsonb_build_array(jsonb_build_object(
      'source', 'src/a.ts', 'target', p_target, 'kinds', jsonb_build_array('import')
    )),
    'imports', jsonb_build_array(jsonb_build_object(
      'source', 'src/a.ts', 'specifier', './second', 'kind', 'import', 'line', 1,
      'resolution', jsonb_build_object('status', 'internal', 'target', p_target)
    )),
    'coverage', jsonb_build_object(
      'files', jsonb_build_object(
        'discovered', 2, 'parsed', 2, 'skipped', 0,
        'skippedFiles', jsonb_build_array(), 'excludedDirectories', jsonb_build_array()
      ),
      'imports', jsonb_build_object(
        'discovered', 1, 'internal', 1, 'external', 0, 'excluded', 0, 'unresolved', 0
      )
    )
  );
$$;
revoke all on function private.phase07_result(text, text) from public, anon, authenticated;
-- This grant is only for the test result builder and rolls back with it.
-- Production pipeline RPCs access private internals through SECURITY DEFINER.
grant usage on schema private to service_role;
grant execute on function private.phase07_result(text, text) to service_role;

select public.sync_organization('org_phase07_fixture_a', false);
select public.sync_organization('org_phase07_fixture_b', false);

-- Starting is idempotent and never reruns an existing repository.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  first_call record;
  second_call record;
  existing_status text;
begin
  select * into first_call
  from public.start_analysis('https://github.com/Example/Repo.git', 'Example/Repo');
  if not first_call.started or first_call.run_id is null then
    raise exception 'The first analysis did not start';
  end if;

  select * into second_call
  from public.start_analysis('https://github.com/example/repo', 'example/repo');
  if second_call.analysis_id <> first_call.analysis_id then
    raise exception 'Submitting the same repository created a second analysis';
  end if;
  if second_call.started or second_call.run_id <> first_call.run_id then
    raise exception 'Submitting the same repository started a second run';
  end if;

  select status into existing_status from public.analyses where id = first_call.analysis_id;
  if existing_status <> 'running' then
    raise exception 'The first analysis is not running: %', existing_status;
  end if;
end;
$$;

-- A run that is still active cannot be rerun from the page either.
do $$
declare
  target uuid;
  active_run uuid;
  rerun record;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into rerun from public.rerun_analysis(target);
  if rerun.started or rerun.run_id <> active_run then
    raise exception 'An active run was replaced by a rerun';
  end if;
end;
$$;

-- Invalid input is rejected before any row is created.
do $$
begin
  begin
    perform public.start_analysis('https://gitlab.com/owner/repo', 'owner/repo');
    raise exception 'A non-GitHub URL was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.start_analysis('https://github.com/owner/repo/tree/main', 'owner/repo');
    raise exception 'A subdirectory URL was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.start_analysis('https://github.com/owner/repo', '  ');
    raise exception 'An empty repository name was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

reset role;

-- Simulate an interrupted process: the row is still running but has not been
-- touched for longer than the stale window. Mark it as sample data too, so the
-- rerun below can prove the label is cleared by a real run.
update public.analyses a
set updated_at = now() - interval '10 minutes', is_seed = true
from public.projects p
where p.organization_id = a.organization_id and p.id = a.project_id
  and a.organization_id = 'org_phase07_fixture_a'
  and p.canonical_repository_url = 'https://github.com/example/repo';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  target uuid;
  stale_run uuid;
  rerun record;
  cleared boolean;
begin
  select a.id, a.run_id into target, stale_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into rerun from public.rerun_analysis(target);
  if not rerun.started or rerun.run_id = stale_run then
    raise exception 'A stale run was not replaced';
  end if;

  select not is_seed into cleared from public.analyses where id = target;
  if not cleared then
    raise exception 'Rerunning a sample row left it labeled as sample data';
  end if;
end;
$$;
reset role;

-- Stage updates are fenced by the run that owns the row.
set local role service_role;
do $$
declare
  target uuid;
  active_run uuid;
  applied boolean;
  refused boolean;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select public.set_analysis_stage(
    target, active_run, 'parse', 'Parsing imports and resolving paths',
    '0123456789abcdef0123456789abcdef01234567'
  ) into applied;
  select public.set_analysis_stage(
    target, gen_random_uuid(), 'store', 'Should not be recorded'
  ) into refused;
  if not applied or refused then
    raise exception 'Run fencing did not protect the stage update';
  end if;

  begin
    perform public.set_analysis_stage(target, active_run, 'deploy', 'Invalid stage');
    raise exception 'An unknown stage name was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.set_analysis_stage(target, active_run, 'parse', '   ');
    raise exception 'An empty stage message was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

-- A malformed result is rejected before any stored graph is touched.
do $$
declare
  target uuid;
  active_run uuid;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';
  begin
    perform public.store_analysis(target, active_run, jsonb_build_object('schemaVersion', 2));
    raise exception 'A result with an unknown schema version was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;

-- Store the first graph.
set local role service_role;
do $$
declare
  target uuid;
  active_run uuid;
  stored boolean;
  rejected boolean;
  file_count integer;
  edge_count integer;
  stored_paths text[];
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select public.store_analysis(target, active_run, private.phase07_result('src/b.ts', 'src/b.ts'))
    into stored;
  if not stored then
    raise exception 'A valid graph was not stored';
  end if;

  select public.store_analysis(target, active_run, private.phase07_result('src/b.ts', 'src/b.ts'))
    into rejected;
  if rejected then
    raise exception 'A completed analysis accepted a second graph for the same run';
  end if;

  select count(*) into file_count from public.files where analysis_id = target;
  select count(*) into edge_count from public.edges where analysis_id = target;
  select array_agg(path order by path) into stored_paths
  from public.files where analysis_id = target;
  if file_count <> 2 or edge_count <> 1 or stored_paths <> array['src/a.ts', 'src/b.ts'] then
    raise exception 'The stored graph does not match the result: % files, % edges, % paths',
      file_count, edge_count, stored_paths;
  end if;

  if (select fan_out from public.files where analysis_id = target and path = 'src/a.ts') <> 1
    or (select fan_in from public.files where analysis_id = target and path = 'src/b.ts') <> 1 then
    raise exception 'Fan-in and fan-out were not stored';
  end if;
end;
$$;
reset role;

-- Derived rows exist for the first graph; the next store must remove them.
insert into public.routes (organization_id, analysis_id, file_id, method, path)
select 'org_phase07_fixture_a', a.id, f.id, 'GET', '/fixture'
from public.analyses a
join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
join public.files f on f.analysis_id = a.id and f.path = 'src/a.ts'
where a.organization_id = 'org_phase07_fixture_a'
  and p.canonical_repository_url = 'https://github.com/example/repo';

insert into public.explanations (organization_id, analysis_id, file_id, content)
select 'org_phase07_fixture_a', a.id, f.id, 'Old graph explanation.'
from public.analyses a
join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
join public.files f on f.analysis_id = a.id and f.path = 'src/a.ts'
where a.organization_id = 'org_phase07_fixture_a'
  and p.canonical_repository_url = 'https://github.com/example/repo';

insert into public.file_roles (organization_id, analysis_id, file_id, role)
select 'org_phase07_fixture_a', a.id, f.id, 'entry'
from public.analyses a
join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
join public.files f on f.analysis_id = a.id and f.path = 'src/a.ts'
where a.organization_id = 'org_phase07_fixture_a'
  and p.canonical_repository_url = 'https://github.com/example/repo';

insert into public.insights (organization_id, analysis_id, content)
select 'org_phase07_fixture_a', a.id, 'Old graph insight.'
from public.analyses a
join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
where a.organization_id = 'org_phase07_fixture_a'
  and p.canonical_repository_url = 'https://github.com/example/repo';

-- Pasting an already analyzed URL never reruns it, even after a failure.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  target uuid;
  existing_run uuid;
  again record;
begin
  select a.id, a.run_id into target, existing_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into again from public.start_analysis('https://github.com/example/repo', 'example/repo');
  if again.started or again.analysis_id <> target or again.run_id <> existing_run then
    raise exception 'Submitting a completed repository started another run';
  end if;
end;
$$;

-- A rerun is explicit and clears the previous result metadata.
do $$
declare
  target uuid;
  previous_run uuid;
  rerun record;
begin
  select a.id, a.run_id into target, previous_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into rerun from public.rerun_analysis(target);
  if not rerun.started or rerun.run_id = previous_run then
    raise exception 'A completed analysis could not be rerun';
  end if;
  if (select commit_sha from public.analyses where id = target) is not null
    or (select coverage from public.analyses where id = target) is not null
    or (select schema_version from public.analyses where id = target) is not null
    or (select status from public.analyses where id = target) <> 'running' then
    raise exception 'A rerun kept the previous run result metadata';
  end if;
end;
$$;
reset role;

-- A broken replacement aborts atomically; a valid one replaces the old graph
-- and removes everything derived from it.
set local role service_role;
do $$
declare
  target uuid;
  active_run uuid;
  file_count integer;
  stored_status text;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  perform public.set_analysis_stage(target, active_run, 'store', 'Storing the dependency map');

  begin
    perform public.store_analysis(target, active_run, private.phase07_result('src/c.ts', 'src/missing.ts'));
    raise exception 'A graph with a missing edge endpoint was stored';
  exception when foreign_key_violation then null;
  end;

  select count(*) into file_count from public.files where analysis_id = target;
  select a.status into stored_status from public.analyses a where a.id = target;
  if file_count <> 2 or stored_status <> 'running' then
    raise exception 'A rejected store changed the stored graph (% files, status %)', file_count, stored_status;
  end if;

  if not public.store_analysis(target, active_run, private.phase07_result('src/c.ts', 'src/c.ts')) then
    raise exception 'The replacement graph was not stored';
  end if;
end;
$$;
reset role;

do $$
declare
  target uuid;
begin
  select a.id into target
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  if (select array_agg(path order by path) from public.files where analysis_id = target)
      <> array['src/a.ts', 'src/c.ts'] then
    raise exception 'The replacement graph did not replace the old files';
  end if;
  if (select count(*) from public.edges where analysis_id = target) <> 1 then
    raise exception 'The replacement graph did not replace the old edges';
  end if;
  if exists (select 1 from public.routes where analysis_id = target)
    or exists (select 1 from public.explanations where analysis_id = target)
    or exists (select 1 from public.file_roles where analysis_id = target)
    or exists (select 1 from public.insights where analysis_id = target) then
    raise exception 'A rerun kept rows derived from the previous graph';
  end if;
  if (select status from public.analyses where id = target) <> 'completed'
    or (select stage from public.analyses where id = target) <> 'store'
    or (select schema_version from public.analyses where id = target) <> 1
    or (select coverage #>> '{files,parsed}' from public.analyses where id = target) <> '2'
    or (select import_records -> 0 ->> 'source' from public.analyses where id = target) <> 'src/a.ts' then
    raise exception 'Completion metadata was not stored';
  end if;
end;
$$;

-- Read a completed graph larger than PostgREST's default 1,000-row limit.
-- Mixed case and punctuation make an accidental locale sort observable too.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
select * from public.start_analysis('https://github.com/example/snapshot', 'example/snapshot');
reset role;
set local role service_role;
do $$
declare
  target uuid;
  active_run uuid;
  result jsonb;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/snapshot';

  select jsonb_build_object(
    'schemaVersion', 1,
    'files', (
      select jsonb_agg(jsonb_build_object(
        'path', paths.path, 'folder', 'src', 'module', '.', 'lineCount', 1,
        'contentHash', repeat('a', 64),
        'fanIn', case when paths.path like 'src/f%' then 1 else 0 end,
        'fanOut', case when paths.path = 'src/Z.ts' then 1001 else 0 end
      ) order by paths.path collate "C")
      from (
        select 'src/f' || lpad(i::text, 4, '0') || '.ts' as path
        from generate_series(1, 1001) i
        union all select 'src/Z.ts'
        union all select 'src/_a.ts'
      ) paths
    ),
    'edges', (
      select jsonb_agg(jsonb_build_object(
        'source', 'src/Z.ts', 'target', 'src/f' || lpad(i::text, 4, '0') || '.ts',
        'kinds', jsonb_build_array('import')
      ) order by i)
      from generate_series(1, 1001) i
    ),
    'imports', (
      select jsonb_agg(jsonb_build_object(
        'source', 'src/Z.ts', 'specifier', './f' || lpad(i::text, 4, '0'),
        'kind', 'import', 'line', i, 'resolution', jsonb_build_object(
          'status', 'internal', 'target', 'src/f' || lpad(i::text, 4, '0') || '.ts'
        )
      ) order by i)
      from generate_series(1, 1001) i
    ),
    'coverage', jsonb_build_object(
      'files', jsonb_build_object(
        'discovered', 1003, 'parsed', 1003, 'skipped', 0,
        'skippedFiles', jsonb_build_array(), 'excludedDirectories', jsonb_build_array()
      ),
      'imports', jsonb_build_object(
        'discovered', 1001, 'internal', 1001, 'external', 0, 'excluded', 0, 'unresolved', 0
      )
    )
  ) into result;
  if not public.store_analysis(target, active_run, result) then
    raise exception 'The large snapshot fixture was not stored';
  end if;
end;
$$;
reset role;

select set_config('cartograph.phase07_snapshot_id', (
  select a.id::text from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/snapshot'
), true);
select set_config('cartograph.phase07_snapshot_run', (
  select run_id::text from public.analyses
  where id = current_setting('cartograph.phase07_snapshot_id')::uuid
), true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  target uuid := current_setting('cartograph.phase07_snapshot_id')::uuid;
  active_run uuid := current_setting('cartograph.phase07_snapshot_run')::uuid;
  result jsonb;
  rerun record;
begin
  result := public.read_analysis_result(target, active_run);
  if result is null or jsonb_array_length(result -> 'files') <> 1003
    or jsonb_array_length(result -> 'edges') <> 1001
    or jsonb_array_length(result -> 'imports') <> 1001 then
    raise exception 'A stored snapshot was missing or truncated';
  end if;
  if result #>> '{files,0,path}' <> 'src/Z.ts'
    or result #>> '{files,1,path}' <> 'src/_a.ts'
    or result #>> '{files,1002,path}' <> 'src/f1001.ts'
    or result #>> '{edges,1000,target}' <> 'src/f1001.ts'
    or result #>> '{coverage,files,parsed}' <> '1003' then
    raise exception 'The snapshot lost ordering or parser metadata';
  end if;
  if public.read_analysis_result(target, gen_random_uuid()) is not null then
    raise exception 'A snapshot was returned for the wrong run';
  end if;
  if public.read_analysis_result(gen_random_uuid(), active_run) is not null then
    raise exception 'A snapshot was returned for a missing analysis';
  end if;

  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_b"}}', true);
  if public.read_analysis_result(target, active_run) is not null then
    raise exception 'A stored snapshot leaked to another organization';
  end if;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase07"}', true);
  if public.read_analysis_result(target, active_run) is not null then
    raise exception 'A stored snapshot was visible without an organization';
  end if;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}', true);

  select * into rerun from public.rerun_analysis(target);
  if not rerun.started then raise exception 'The snapshot fixture could not be rerun'; end if;
  if public.read_analysis_result(target, active_run) is not null
    or public.read_analysis_result(target, rerun.run_id) is not null then
    raise exception 'A rerun exposed an old or unfinished graph';
  end if;
end;
$$;
reset role;
do $$
begin
  if not has_function_privilege('authenticated', 'public.read_analysis_result(uuid,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.read_analysis_result(uuid,uuid)', 'EXECUTE') then
    raise exception 'Snapshot RPC privileges are incorrect';
  end if;
end;
$$;

-- A failure records the reason and the stage it happened in.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  target uuid;
  rerun record;
begin
  select a.id into target
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into rerun from public.rerun_analysis(target);
  if not rerun.started then
    raise exception 'A completed analysis could not be rerun for the failure check';
  end if;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  target uuid;
  active_run uuid;
  failed boolean;
begin
  select a.id, a.run_id into target, active_run
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  perform public.set_analysis_stage(target, active_run, 'parse', 'Parsing imports');
  select public.fail_analysis(target, active_run, 'parse', 'That repository does not exist or is not public.')
    into failed;
  if not failed then
    raise exception 'The failure was not recorded';
  end if;

  if (select status from public.analyses where id = target) <> 'failed'
    or (select failed_stage from public.analyses where id = target) <> 'parse'
    or (select error_message from public.analyses where id = target) <> 'That repository does not exist or is not public.'
    or (select stage_message from public.analyses where id = target) <> 'That repository does not exist or is not public.'
    or (select completed_at from public.analyses where id = target) is null then
    raise exception 'Failure metadata is incomplete';
  end if;

  -- A superseded run cannot mark the row failed.
  if public.fail_analysis(target, gen_random_uuid(), 'parse', 'Late failure') then
    raise exception 'A superseded run recorded a failure';
  end if;
end;
$$;
reset role;

-- Pasting the failed repository still does not rerun it.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
declare
  again record;
  target uuid;
begin
  select a.id into target
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';

  select * into again from public.start_analysis('https://github.com/example/repo', 'example/repo');
  if again.started or again.analysis_id <> target then
    raise exception 'Submitting a failed repository started another run';
  end if;
end;
$$;
reset role;

-- Keep the real foreign ID before switching roles: an RLS-hidden lookup would
-- pass NULL and test a missing analysis instead of a cross-organization rerun.
select set_config('cartograph.phase07_analysis_a', (
  select a.id::text from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo'
), true);

-- The same repository in another organization is a separate project, and one
-- organization cannot rerun another's analysis.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_b"}}',
  true
);
do $$
declare
  other record;
begin
  select * into other
  from public.start_analysis('https://github.com/example/repo', 'example/repo');
  if not other.started then
    raise exception 'Another organization could not analyze the same repository';
  end if;
  if not exists (
    select 1 from public.analyses
    where id = other.analysis_id and organization_id = 'org_phase07_fixture_b'
  ) then
    raise exception 'The second organization analysis is not in its own organization';
  end if;

  begin
    perform public.rerun_analysis(current_setting('cartograph.phase07_analysis_a')::uuid);
    raise exception 'Another organization reran an analysis';
  exception when no_data_found then null;
  end;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.projects
      where canonical_repository_url = 'https://github.com/example/repo') <> 2 then
    raise exception 'One repository did not create exactly one project per organization';
  end if;
  if (select count(*) from public.analyses a
      join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
      where p.canonical_repository_url = 'https://github.com/example/repo') <> 2 then
    raise exception 'One repository did not keep exactly one analysis per organization';
  end if;
end;
$$;

-- Every stage update published a minimal, private progress message.
do $$
declare
  target uuid;
  progress_topic text;
  message_count integer;
  payload_keys text[];
begin
  select a.id into target
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';
  progress_topic := private.analysis_progress_topic(target);

  select count(*) into message_count from realtime.messages m where m.topic = progress_topic;
  if message_count = 0 then
    raise exception 'No progress message was published';
  end if;
  if exists (select 1 from realtime.messages m where m.topic = progress_topic and (not m.private or m.event <> 'progress')) then
    raise exception 'A progress message was public or used the wrong event';
  end if;

  select array_agg(key order by key) into payload_keys
  from realtime.messages m, jsonb_object_keys(m.payload) key
  where m.topic = progress_topic and m.event = 'progress'
  group by m.id
  order by m.id desc
  limit 1;
  if payload_keys <> array[
    'analysisId', 'completedAt', 'failedStage', 'id', 'message', 'runId', 'stage', 'status', 'updatedAt'
  ] then
    raise exception 'The progress payload contains unexpected fields: %', payload_keys;
  end if;

  if exists (
    select 1 from realtime.messages m
    where m.topic like 'analysis:%' and m.topic <> progress_topic
      and split_part(m.topic, ':', 2) = target::text
  ) then
    raise exception 'Progress was published to more than one topic for an analysis';
  end if;
end;
$$;

-- Subscriptions follow the same organization rule as the rows.
do $$
declare
  target uuid;
  progress_topic text;
  own boolean[];
  other_org boolean[];
  unknown boolean[];
  unrelated boolean[];
  writes boolean[];
begin
  select a.id into target
  from public.analyses a
  join public.projects p on p.organization_id = a.organization_id and p.id = a.project_id
  where a.organization_id = 'org_phase07_fixture_a'
    and p.canonical_repository_url = 'https://github.com/example/repo';
  progress_topic := private.analysis_progress_topic(target);

  select read_allowed into own from realtime.authorize(
    'authenticated', progress_topic,
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
    'user_phase07', '{}', array['broadcast'], array[]::text[]
  );
  select read_allowed into other_org from realtime.authorize(
    'authenticated', progress_topic,
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_b"}}',
    'user_phase07', '{}', array['broadcast'], array[]::text[]
  );
  select read_allowed into unknown from realtime.authorize(
    'authenticated', private.analysis_progress_topic(gen_random_uuid()),
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
    'user_phase07', '{}', array['broadcast'], array[]::text[]
  );
  select read_allowed into unrelated from realtime.authorize(
    'authenticated', 'room-1',
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
    'user_phase07', '{}', array['broadcast'], array[]::text[]
  );
  select write_allowed into writes from realtime.authorize(
    'authenticated', progress_topic,
    '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
    'user_phase07', '{}', array[]::text[], array['broadcast']
  );

  if own <> array[true] then raise exception 'The owning organization could not subscribe'; end if;
  if other_org <> array[false] then raise exception 'Another organization subscribed to the topic'; end if;
  if unknown <> array[false] then raise exception 'A missing analysis exposed its topic'; end if;
  if unrelated <> array[false] then raise exception 'An unrelated topic was readable'; end if;
  if writes <> array[false] then raise exception 'A browser could publish progress'; end if;
end;
$$;

-- Browsers cannot write pipeline rows or call the pipeline RPCs.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase07","o":{"id":"org_phase07_fixture_a"}}',
  true
);
do $$
begin
  begin
    update public.analyses set stage_message = 'browser write' where false;
    raise exception 'Authenticated users can update analyses';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_analysis_stage(gen_random_uuid(), gen_random_uuid(), 'parse', 'browser');
    raise exception 'Authenticated users can call set_analysis_stage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.store_analysis(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'Authenticated users can call store_analysis';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from private.realtime_channel_patterns;
    raise exception 'Authenticated users can read the channel registry';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform 1 from public.analyses;
    raise exception 'Anonymous users can read analyses';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.start_analysis('https://github.com/owner/repo', 'owner/repo');
    raise exception 'Anonymous users can start an analysis';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from realtime.messages) then
    raise exception 'Anonymous users can read progress messages';
  end if;
end;
$$;
reset role;

rollback;
select 'Phase 7 database checks passed; fixtures rolled back.' as result;
