-- Run as the migration owner with pnpm db:verify after phase02 and phase07.
-- All fixtures, helper functions, grants and progress messages roll back.
begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'analyses' and column_name = 'framework'
      and data_type = 'text' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'routes' and column_name = 'source_line'
      and data_type = 'integer' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'Framework or nullable legacy route source-line storage is missing';
  end if;
  if not has_function_privilege('service_role', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.read_analysis_result_v2(uuid,uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.read_analysis_result_v2(uuid,uuid)', 'EXECUTE') then
    raise exception 'Framework RPC privileges are incorrect';
  end if;
  if not exists (
    select 1 from pg_proc where oid = 'public.store_analysis(uuid,uuid,jsonb)'::regprocedure
      and prosecdef and proconfig @> array['search_path=""']
  ) or not exists (
    select 1 from pg_proc where oid = 'public.read_analysis_result_v2(uuid,uuid)'::regprocedure
      and not prosecdef and provolatile = 's' and proconfig @> array['search_path=""']
  ) then
    raise exception 'Storage definer or stable RLS snapshot security changed';
  end if;
  if has_table_privilege('authenticated', 'public.routes', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.file_roles', 'INSERT,UPDATE,DELETE') then
    raise exception 'Browser roles can write framework metadata';
  end if;
end;
$$;

create function private.phase08_result()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'framework', 'nextjs',
    'fileRoles', '[
      {"file":"src/z.ts","role":"page"},
      {"file":"src/_route.ts","role":"api"},
      {"file":"src/A.ts","role":"component"}
    ]'::jsonb,
    'routes', '[
      {"file":"src/z.ts","method":"GET","path":"/z","line":9},
      {"file":"src/_route.ts","method":"POST","path":"/z","line":8},
      {"file":"src/_route.ts","method":"GET","path":"/z","line":6},
      {"file":"src/_route.ts","method":"GET","path":"/A","line":7}
    ]'::jsonb,
    'files', (
      select jsonb_agg(jsonb_build_object(
        'path', f.path, 'folder', 'src', 'module', '.', 'lineCount', 12,
        'contentHash', repeat('a', 64), 'fanIn', f.fan_in, 'fanOut', f.fan_out
      ) order by f.path collate "C")
      from (values ('src/A.ts', 0, 1), ('src/_route.ts', 1, 0), ('src/z.ts', 0, 0))
        f(path, fan_in, fan_out)
    ),
    'edges', '[{"source":"src/A.ts","target":"src/_route.ts","kinds":["import"]}]'::jsonb,
    'imports', '[{
      "source":"src/A.ts","specifier":"./_route","kind":"import","line":1,
      "resolution":{"status":"internal","target":"src/_route.ts"}
    }]'::jsonb,
    'coverage', '{
      "files":{"discovered":3,"parsed":3,"skipped":0,"skippedFiles":[],"excludedDirectories":[]},
      "imports":{"discovered":1,"internal":1,"external":0,"excluded":0,"unresolved":0}
    }'::jsonb
  );
$$;

-- Full rows, including IDs and completion metadata, reveal partial replacement.
create function private.phase08_snapshot(p_analysis_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'analysis', to_jsonb(a),
    'files', (select jsonb_agg(to_jsonb(f) order by f.id) from public.files f
      where f.organization_id = a.organization_id and f.analysis_id = a.id),
    'edges', (select jsonb_agg(to_jsonb(e) order by e.id) from public.edges e
      where e.organization_id = a.organization_id and e.analysis_id = a.id),
    'roles', (select jsonb_agg(to_jsonb(r) order by r.id) from public.file_roles r
      where r.organization_id = a.organization_id and r.analysis_id = a.id),
    'routes', (select jsonb_agg(to_jsonb(r) order by r.id) from public.routes r
      where r.organization_id = a.organization_id and r.analysis_id = a.id),
    'explanations', (select jsonb_agg(to_jsonb(e) order by e.id) from public.explanations e
      where e.organization_id = a.organization_id and e.analysis_id = a.id),
    'insights', (select jsonb_agg(to_jsonb(i) order by i.id) from public.insights i
      where i.organization_id = a.organization_id and i.analysis_id = a.id)
  ) from public.analyses a where a.id = p_analysis_id;
$$;

create function private.phase08_reject(
  p_analysis_id uuid, p_run_id uuid, p_result jsonb, p_state text default '22023'
)
returns void
language plpgsql
as $$
declare
  v_before jsonb := private.phase08_snapshot(p_analysis_id);
  v_state text;
begin
  begin
    perform public.store_analysis(p_analysis_id, p_run_id, p_result);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> p_state then
      raise exception 'Expected SQLSTATE %, got %: %', p_state, v_state, sqlerrm;
    end if;
  end;
  if v_state is null then raise exception 'Malformed metadata was accepted: %', p_result; end if;
  if private.phase08_snapshot(p_analysis_id) is distinct from v_before then
    raise exception 'Rejected metadata changed persisted rows';
  end if;
end;
$$;
revoke all on function private.phase08_result() from public, anon, authenticated;
revoke all on function private.phase08_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.phase08_reject(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.phase08_result() to service_role;
grant execute on function private.phase08_snapshot(uuid) to service_role;
grant execute on function private.phase08_reject(uuid, uuid, jsonb, text) to service_role;

select public.sync_organization('org_phase08_fixture_a', false);
select public.sync_organization('org_phase08_fixture_b', false);
set local role authenticated;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08","o":{"id":"org_phase08_fixture_a"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase08/repo', 'phase08/repo');
  perform set_config('cartograph.phase08_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase08_run', v_start.run_id::text, true);
  select * into v_start from public.start_analysis('https://github.com/phase08/neighbor', 'phase08/neighbor');
  perform set_config('cartograph.phase08_same_org_id', v_start.analysis_id::text, true);
end;
$$;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08","o":{"id":"org_phase08_fixture_b"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase08/repo', 'phase08/repo');
  perform set_config('cartograph.phase08_neighbor_id', v_start.analysis_id::text, true);
end;
$$;
reset role;

-- Overlapping paths in both another organization and another analysis must
-- survive storage and replacements. The service keeps organization B's JWT.
set local role service_role;
do $$
declare
  v_id uuid;
  v_run uuid;
begin
  foreach v_id in array array[
    current_setting('cartograph.phase08_same_org_id')::uuid,
    current_setting('cartograph.phase08_neighbor_id')::uuid
  ] loop
    select run_id into strict v_run from public.analyses where id = v_id;
    if public.store_analysis(v_id, v_run, private.phase08_result()) is distinct from true then
      raise exception 'Neighbor framework graph was not stored';
    end if;
    perform set_config('cartograph.phase08_neighbor_' || replace(v_id::text, '-', '_'),
      private.phase08_snapshot(v_id)::text, true);
  end loop;
  v_id := current_setting('cartograph.phase08_id')::uuid;
  v_run := current_setting('cartograph.phase08_run')::uuid;
  if (select framework from public.analyses where id = v_id) <> 'generic' then
    raise exception 'A new analysis did not default to generic';
  end if;
  if public.store_analysis(v_id, gen_random_uuid(), private.phase08_result()) is distinct from false then
    raise exception 'A superseded run stored framework metadata';
  end if;
  if public.store_analysis(v_id, v_run, private.phase08_result()) is distinct from true then
    raise exception 'Framework graph was not stored';
  end if;
  if public.store_analysis(v_id, v_run, private.phase08_result()) is distinct from false then
    raise exception 'A completed run accepted a second store';
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08","o":{"id":"org_phase08_fixture_a"}}', true);
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_run')::uuid;
  v_result jsonb := public.read_analysis_result_v2(v_id, v_run);
  v_rerun record;
begin
  if v_result is null or v_result ->> 'framework' <> 'nextjs' or v_result -> 'schemaVersion' <> '1'::jsonb
    or v_result -> 'fileRoles' is distinct from '[
      {"file":"src/A.ts","role":"component"},
      {"file":"src/_route.ts","role":"api"},
      {"file":"src/z.ts","role":"page"}
    ]'::jsonb or v_result -> 'routes' is distinct from '[
      {"file":"src/_route.ts","method":"GET","path":"/A","line":7},
      {"file":"src/_route.ts","method":"GET","path":"/z","line":6},
      {"file":"src/_route.ts","method":"POST","path":"/z","line":8},
      {"file":"src/z.ts","method":"GET","path":"/z","line":9}
    ]'::jsonb then
    raise exception 'Framework round trip lost metadata or deterministic ordering: %', v_result;
  end if;
  if jsonb_array_length(v_result -> 'files') <> 3 or jsonb_array_length(v_result -> 'edges') <> 1
    or v_result #>> '{imports,0,resolution,target}' <> 'src/_route.ts'
    or v_result #>> '{coverage,files,parsed}' <> '3' then
    raise exception 'Framework storage lost graph data';
  end if;
  if public.read_analysis_result_v2(v_id, gen_random_uuid()) is not null then
    raise exception 'Framework metadata was exposed for a wrong run';
  end if;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase08","o":{"id":"org_phase08_fixture_b"}}', true);
  if public.read_analysis_result_v2(v_id, v_run) is not null then
    raise exception 'Framework metadata leaked across organizations';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase08"}', true);
  if public.read_analysis_result_v2(v_id, v_run) is not null then
    raise exception 'Framework metadata was exposed without an organization';
  end if;
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase08","o":{"id":"org_phase08_fixture_a"}}', true);
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'Framework fixture could not be rerun'; end if;
  perform set_config('cartograph.phase08_run', v_rerun.run_id::text, true);
  if public.read_analysis_result_v2(v_id, v_run) is not null
    or public.read_analysis_result_v2(v_id, v_rerun.run_id) is not null then
    raise exception 'A rerun exposed old or unfinished framework metadata';
  end if;
end;
$$;
reset role;

-- Malformed metadata fails without changing the old graph, even for errors
-- discovered only after inserting fresh files and edges.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_run')::uuid;
  v_result jsonb := private.phase08_result();
  v_bad jsonb;
  v_key text;
  v_value jsonb;
  v_other uuid;
begin
  -- Every proper subset of the three keys must reject, including present nulls.
  foreach v_key in array array['framework', 'fileRoles', 'routes'] loop
    perform private.phase08_reject(v_id, v_run, v_result - v_key);
    perform private.phase08_reject(v_id, v_run,
      (v_result - 'framework' - 'fileRoles' - 'routes') || jsonb_build_object(v_key, v_result -> v_key));
    perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, array[v_key], 'null'));
  end loop;
  for v_bad in select value from jsonb_array_elements('[
    {"framework":"unknown-framework"}, {"framework":1}, {"framework":{}},
    {"fileRoles":{}}, {"fileRoles":"[]"}, {"routes":{}}, {"routes":"[]"},
    {"framework":"generic"}, {"framework":"react"}
  ]'::jsonb) loop
    perform private.phase08_reject(v_id, v_run, v_result || v_bad);
  end loop;
  for v_value in select value from jsonb_array_elements('[
    null, 1, "api", {}, {"file":"src/A.ts"}, {"file":1,"role":"api"},
    {"file":"","role":"api"}, {"file":"src/A.ts","role":null},
    {"file":"src/A.ts","role":1}, {"file":"src/A.ts","role":"entry"},
    {"file":"src/A.ts","role":"controller"},
    {"file":"src/A.ts","role":"component","extra":true}
  ]'::jsonb) loop
    perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles}', jsonb_build_array(v_value)));
  end loop;
  perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles}', '[
    {"file":"src/A.ts","role":"component"},{"file":"src/A.ts","role":"component"}
  ]'));
  perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles}', '[
    {"file":"src/A.ts","role":"component"},{"file":"src/A.ts","role":"hook"}
  ]'));
  for v_value in select value from jsonb_array_elements('[null,1,"GET",{}]'::jsonb) loop
    perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, '{routes}', jsonb_build_array(v_value)));
  end loop;
  foreach v_key in array array['file', 'method', 'path', 'line'] loop
    perform private.phase08_reject(v_id, v_run,
      jsonb_set(v_result, '{routes}', jsonb_build_array((v_result #> '{routes,0}') - v_key)));
    perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, array['routes','0',v_key], 'null'));
  end loop;
  for v_bad in select value from jsonb_array_elements('[
    {"file":1}, {"file":""}, {"method":1}, {"method":"get"}, {"method":"ALL"},
    {"method":"BREW"}, {"path":1}, {"path":""}, {"path":"relative"},
    {"line":"1"}, {"line":true}, {"line":[]}, {"line":0}, {"line":-1},
    {"line":1.5}, {"line":2147483648}, {"line":13},
    {"path":"/line\nbreak"}, {"path":"/tab\tpath"}, {"path":"/delete\u007fpath"}, {"extra":true}
  ]'::jsonb) loop
    perform private.phase08_reject(v_id, v_run,
      jsonb_set(v_result, '{routes,0}', (v_result #> '{routes,0}') || v_bad));
  end loop;
  perform private.phase08_reject(v_id, v_run, jsonb_set(v_result, '{routes}',
    (v_result -> 'routes') || jsonb_build_array(jsonb_set(v_result #> '{routes,0}', '{line}', '10'))));
  perform private.phase08_reject(v_id, v_run,
    jsonb_set(v_result, '{fileRoles,0,file}', '"src/missing.ts"'), '23503');
  perform private.phase08_reject(v_id, v_run,
    jsonb_set(v_result, '{routes,0,file}', '"src/missing.ts"'), '23503');

  -- The missing path exists in both neighbors, but not in this new file list.
  v_bad := jsonb_set(v_result, '{files}', (v_result -> 'files') - 2);
  perform private.phase08_reject(v_id, v_run, v_bad, '23503');
  v_bad := jsonb_set(v_bad, '{fileRoles}', (v_bad -> 'fileRoles') - 0);
  perform private.phase08_reject(v_id, v_run, v_bad, '23503');

  -- Empty explicit metadata is valid for an undetected framework too.
  begin
    if public.store_analysis(v_id, v_run,
      v_result || '{"framework":"generic","fileRoles":[],"routes":[]}'::jsonb) is distinct from true then
      raise exception 'Explicit generic metadata was rejected';
    end if;
    raise exception using errcode = 'P8008', message = 'generic metadata rollback';
  exception when sqlstate 'P8008' then
    if sqlerrm <> 'generic metadata rollback' then raise; end if;
  end;
  perform private.phase08_reject(v_id, v_run,
    v_result || '{"framework":"generic","fileRoles":[]}'::jsonb);
  perform private.phase08_reject(v_id, v_run,
    v_result || '{"framework":"generic","routes":[]}'::jsonb);
  perform private.phase08_reject(v_id, v_run,
    v_result || '{"framework":"react","fileRoles":[{"file":"src/A.ts","role":"component"}]}'::jsonb);
  perform private.phase08_reject(v_id, v_run,
    v_result || '{"framework":"nestjs","fileRoles":[{"file":"src/A.ts","role":"page"}]}'::jsonb);
  perform private.phase08_reject(v_id, v_run,
    v_result || '{"framework":"react","routes":[],"fileRoles":[{"file":"src/A.ts","role":"page"}]}'::jsonb);

  -- Every role allowed by the taxonomy can be stored by its own framework.
  for v_value in select value from jsonb_array_elements('[
    {"framework":"nextjs","roles":["page","api","action","layout","component","hook"]},
    {"framework":"nestjs","roles":["controller","service","module","entity"]},
    {"framework":"react","roles":["component","hook"]}
  ]'::jsonb) loop
    for v_key in select jsonb_array_elements_text(v_value -> 'roles') loop
      v_bad := (v_result || jsonb_build_object('framework', v_value -> 'framework', 'routes', '[]'::jsonb,
        'fileRoles', jsonb_build_array(jsonb_build_object('file', 'src/A.ts', 'role', v_key))));
      -- A raised sentinel rolls back the successful probe without ending the run.
      begin
        if public.store_analysis(v_id, v_run, v_bad) is distinct from true then
          raise exception 'Supported framework role was rejected: %', v_bad;
        end if;
        raise exception using errcode = 'P8008', message = 'supported role rollback';
      exception when sqlstate 'P8008' then
        if sqlerrm <> 'supported role rollback' then raise; end if;
      end;
    end loop;
  end loop;
  -- All supported concrete HTTP methods retain their literal method value.
  select jsonb_agg(jsonb_build_object(
    'file', 'src/_route.ts', 'method', method, 'path', '/methods', 'line', 1
  ) order by method collate "C") into v_value
  from unnest(array['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','CONNECT','TRACE']) method;
  v_result := jsonb_set(v_result, '{routes}', v_value) || '{"framework":"nestjs","fileRoles":[
    {"file":"src/_route.ts","role":"controller"},{"file":"src/A.ts","role":"service"}
  ]}'::jsonb;
  if public.store_analysis(v_id, v_run, v_result) is distinct from true then
    raise exception 'Replacement NestJS framework graph was not stored';
  end if;
  perform set_config('cartograph.phase08_methods', v_value::text, true);

  foreach v_other in array array[
    current_setting('cartograph.phase08_same_org_id')::uuid,
    current_setting('cartograph.phase08_neighbor_id')::uuid
  ] loop
    if private.phase08_snapshot(v_other) is distinct from current_setting(
      'cartograph.phase08_neighbor_' || replace(v_other::text, '-', '_'))::jsonb then
      raise exception 'Replacing framework metadata changed a neighboring graph';
    end if;
  end loop;
end;
$$;
reset role;

-- Legacy direct fixtures omit source_line and use free-form roles. They remain
-- valid rows but must not turn into invented source locations or generic roles.
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_file_id uuid;
begin
  select id into strict v_file_id from public.files
  where organization_id = 'org_phase08_fixture_a' and analysis_id = v_id and path = 'src/_route.ts';
  insert into public.routes (organization_id, analysis_id, file_id, method, path)
  values ('org_phase08_fixture_a', v_id, v_file_id, 'GET', '/legacy');
  insert into public.file_roles (organization_id, analysis_id, file_id, role)
  values ('org_phase08_fixture_a', v_id, v_file_id, 'fixture');
  if (select source_line from public.routes where organization_id = 'org_phase08_fixture_a'
      and analysis_id = v_id and path = '/legacy') is not null then
    raise exception 'A legacy route received an invented source line';
  end if;
  begin
    update public.routes set source_line = 0
    where organization_id = 'org_phase08_fixture_a' and analysis_id = v_id and path = '/legacy';
    raise exception 'A zero source line was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.routes set source_line = -1
    where organization_id = 'org_phase08_fixture_a' and analysis_id = v_id and path = '/legacy';
    raise exception 'A negative source line was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.analyses set framework = 'unknown-framework' where id = v_id;
    raise exception 'An unsupported stored framework was accepted';
  exception when check_violation then null;
  end;
end;
$$;
set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_run')::uuid;
  v_result jsonb := public.read_analysis_result_v2(v_id, v_run);
  v_rerun record;
begin
  if v_result ->> 'framework' <> 'nestjs'
    or v_result -> 'routes' is distinct from current_setting('cartograph.phase08_methods')::jsonb
    or v_result -> 'fileRoles' is distinct from '[
      {"file":"src/A.ts","role":"service"},{"file":"src/_route.ts","role":"controller"}
    ]'::jsonb then
    raise exception 'Framework replacement or legacy-line omission failed: %', v_result;
  end if;
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'Legacy compatibility fixture could not be rerun'; end if;
  perform set_config('cartograph.phase08_run', v_rerun.run_id::text, true);
end;
$$;
reset role;

-- A complete phase 7 payload still stores, explicitly replacing old metadata
-- with generic/empty output rather than carrying evidence into another run.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_run')::uuid;
  v_result jsonb := private.phase08_result() - 'framework' - 'fileRoles' - 'routes';
begin
  if public.store_analysis(v_id, v_run, v_result) is distinct from true then
    raise exception 'A complete legacy phase 7 result was rejected';
  end if;
  if (select framework from public.analyses where id = v_id) <> 'generic'
    or exists (select 1 from public.routes where organization_id = 'org_phase08_fixture_a' and analysis_id = v_id)
    or exists (select 1 from public.file_roles where organization_id = 'org_phase08_fixture_a' and analysis_id = v_id) then
    raise exception 'Legacy storage retained framework metadata from a prior run';
  end if;
end;
$$;
reset role;
set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_run')::uuid;
  v_result jsonb := public.read_analysis_result_v2(v_id, v_run);
begin
  if v_result is null or v_result ->> 'framework' <> 'generic'
    or v_result -> 'fileRoles' is distinct from '[]'::jsonb
    or v_result -> 'routes' is distinct from '[]'::jsonb then
    raise exception 'A legacy snapshot did not normalize to empty generic metadata';
  end if;
  begin
    perform public.store_analysis(v_id, v_run, '{}'::jsonb);
    raise exception 'An authenticated user called the metadata writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.read_analysis_result_v2(gen_random_uuid(), gen_random_uuid());
    raise exception 'An anonymous user called the snapshot reader';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.store_analysis(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'An anonymous user called the metadata writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
select 'Phase 8 database checks passed; fixtures rolled back.' as result;
