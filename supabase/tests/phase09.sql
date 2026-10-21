-- Run as the migration owner with pnpm db:verify after the phase 8 suites.
-- Real database roles exercise all three read contracts; fixtures roll back.
begin;

do $$
declare v_reader text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'files' and column_name = 'export_names'
      and data_type = 'jsonb' and is_nullable = 'NO' and column_default = '''[]''::jsonb'
  ) then
    raise exception 'Export-name storage or its empty legacy default is missing';
  end if;
  foreach v_reader in array array['read_analysis_result', 'read_analysis_result_v2', 'read_analysis_result_v3'] loop
    if not exists (
      select 1 from pg_proc
      where oid = format('public.%I(uuid,uuid)', v_reader)::regprocedure
        and not prosecdef and provolatile = 's' and proconfig @> array['search_path=""']
    ) or not has_function_privilege('authenticated', format('public.%I(uuid,uuid)', v_reader), 'EXECUTE')
      or has_function_privilege('anon', format('public.%I(uuid,uuid)', v_reader), 'EXECUTE')
      or exists (
        select 1 from pg_proc p,
          lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) permission
        where p.oid = format('public.%I(uuid,uuid)', v_reader)::regprocedure
          and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
      ) then
      raise exception 'Reader % lost stable invoker security, its empty search path or restricted grants', v_reader;
    end if;
  end loop;
  if not exists (
    select 1 from pg_proc where oid = 'public.store_analysis(uuid,uuid,jsonb)'::regprocedure
      and prosecdef and proconfig @> array['search_path=""']
  ) or not has_function_privilege('service_role', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE')
    or exists (
      select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) permission
      where p.oid = 'public.store_analysis(uuid,uuid,jsonb)'::regprocedure
        and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Phase 9 changed writer security';
  end if;
  if has_table_privilege('authenticated', 'public.files', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.edges', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.file_roles', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.routes', 'INSERT,UPDATE,DELETE') then
    raise exception 'Browser roles can write graph metadata';
  end if;
end;
$$;

create function private.phase09_result()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'framework', 'express', 'frameworkEntries', '[]'::jsonb, 'routes', '[]'::jsonb,
    'fileRoles', '[
      {"file":"controllers/users.js","role":"controller"},
      {"file":"middleware/auth.js","role":"middleware"},
      {"file":"models/user.js","role":"model"},
      {"file":"routes/users.js","role":"route"},
      {"file":"services/users.js","role":"service"}
    ]'::jsonb,
    'files', (
      select jsonb_agg(jsonb_build_object(
        'path', f.path, 'folder', f.folder, 'module', '.', 'lineCount', 12,
        'contentHash', repeat('a', 64), 'fanIn', f.fan_in, 'fanOut', f.fan_out,
        'exports', f.exports
      ) order by f.path collate "C")
      from (values
        ('controllers/users.js', 'controllers', 1, 1, '["","A","_","default","find","z","","𐀀"]'::jsonb),
        ('middleware/auth.js', 'middleware', 0, 0, '["default"]'::jsonb),
        ('models/user.js', 'models', 1, 0, '["User"]'::jsonb),
        ('routes/users.js', 'routes', 0, 1, '[]'::jsonb),
        ('services/users.js', 'services', 1, 1, '["find","save"]'::jsonb)
      ) f(path, folder, fan_in, fan_out, exports)
    ),
    'edges', '[
      {"source":"controllers/users.js","target":"services/users.js","kinds":["require"]},
      {"source":"routes/users.js","target":"controllers/users.js","kinds":["import","require"]},
      {"source":"services/users.js","target":"models/user.js","kinds":["require"]}
    ]'::jsonb,
    'imports', '[
      {"source":"controllers/users.js","specifier":"../services/users","kind":"require","line":1,
        "resolution":{"status":"internal","target":"services/users.js"}},
      {"source":"routes/users.js","specifier":"../controllers/users","kind":"import","line":1,
        "resolution":{"status":"internal","target":"controllers/users.js"}},
      {"source":"routes/users.js","specifier":"../controllers/users","kind":"require","line":2,
        "resolution":{"status":"internal","target":"controllers/users.js"}},
      {"source":"services/users.js","specifier":"../models/user","kind":"require","line":1,
        "resolution":{"status":"internal","target":"models/user.js"}}
    ]'::jsonb,
    'coverage', '{
      "files":{"discovered":5,"parsed":5,"skipped":0,"skippedFiles":[],"excludedDirectories":[]},
      "imports":{"discovered":4,"internal":4,"external":0,"excluded":0,"unresolved":0}
    }'::jsonb
  );
$$;

create function private.phase09_snapshot(p_analysis_id uuid)
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

create function private.phase09_reject(p_analysis_id uuid, p_run_id uuid, p_result jsonb, p_state text default '22023')
returns void
language plpgsql
as $$
declare
  v_before jsonb := private.phase09_snapshot(p_analysis_id);
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
  if v_state is null then raise exception 'Malformed phase 9 data was accepted: %', p_result; end if;
  if private.phase09_snapshot(p_analysis_id) is distinct from v_before then
    raise exception 'Rejected phase 9 data changed persisted rows';
  end if;
end;
$$;

-- Compare exact root and file shapes as well as graph projection equality.
create function private.phase09_projection(p_analysis_id uuid, p_run_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_v1 jsonb := public.read_analysis_result(p_analysis_id, p_run_id);
  v_v2 jsonb := public.read_analysis_result_v2(p_analysis_id, p_run_id);
  v_v3 jsonb := public.read_analysis_result_v3(p_analysis_id, p_run_id);
  v_files jsonb;
  v_file jsonb;
begin
  if v_v1 is null or v_v2 is null or v_v3 is null then
    raise exception 'A visible completed graph was not returned by every reader';
  end if;
  if (select array_agg(key order by key collate "C") from jsonb_object_keys(v_v1) root(key))
      is distinct from array['coverage', 'edges', 'files', 'imports', 'schemaVersion']
    or (select array_agg(key order by key collate "C") from jsonb_object_keys(v_v2) root(key))
      is distinct from array['coverage', 'edges', 'fileRoles', 'files', 'framework', 'frameworkEntries', 'imports', 'routes', 'schemaVersion']
    or (select array_agg(key order by key collate "C") from jsonb_object_keys(v_v3) root(key))
      is distinct from array['coverage', 'edges', 'fileRoles', 'files', 'framework', 'frameworkEntries', 'imports', 'routes', 'schemaVersion'] then
    raise exception 'A reader root contract changed';
  end if;
  for v_file in select value from jsonb_array_elements(v_v3 -> 'files') loop
    if (select array_agg(key order by key collate "C") from jsonb_object_keys(v_file) file_key(key))
        is distinct from array['contentHash', 'exports', 'fanIn', 'fanOut', 'folder', 'lineCount', 'module', 'path'] then
      raise exception 'V3 did not return the complete file contract';
    end if;
  end loop;
  for v_file in select value from jsonb_array_elements(v_v2 -> 'files') loop
    if (select array_agg(key order by key collate "C") from jsonb_object_keys(v_file) file_key(key))
        is distinct from array['contentHash', 'fanIn', 'fanOut', 'folder', 'lineCount', 'module', 'path'] then
      raise exception 'V2 expanded its legacy file contract';
    end if;
  end loop;
  select coalesce(jsonb_agg(entry.value - 'exports' order by entry.ordinal), '[]'::jsonb) into v_files
  from jsonb_array_elements(v_v3 -> 'files') with ordinality entry(value, ordinal);
  if v_v2 is distinct from jsonb_set(v_v3, '{files}', v_files)
    or v_v1 is distinct from v_v2 - array['framework', 'fileRoles', 'routes', 'frameworkEntries'] then
    raise exception 'Versioned reader graph projections differ';
  end if;
end;
$$;

create function private.phase09_readers_null(p_analysis_id uuid, p_run_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if public.read_analysis_result(p_analysis_id, p_run_id) is not null
    or public.read_analysis_result_v2(p_analysis_id, p_run_id) is not null
    or public.read_analysis_result_v3(p_analysis_id, p_run_id) is not null then
    raise exception 'A reader returned an invisible, wrong-run or incomplete graph';
  end if;
end;
$$;
revoke all on function private.phase09_result() from public, anon, authenticated;
revoke all on function private.phase09_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.phase09_reject(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.phase09_projection(uuid, uuid) from public, anon, authenticated;
revoke all on function private.phase09_readers_null(uuid, uuid) from public, anon, authenticated;
-- Test helpers are invokers; these temporary grants do not change row policies.
grant usage on schema private to service_role, authenticated;
grant execute on function private.phase09_result() to service_role;
grant execute on function private.phase09_snapshot(uuid) to service_role;
grant execute on function private.phase09_reject(uuid, uuid, jsonb, text) to service_role;
grant execute on function private.phase09_projection(uuid, uuid) to authenticated;
grant execute on function private.phase09_readers_null(uuid, uuid) to authenticated;

select public.sync_organization('org_phase09_a', false);
select public.sync_organization('org_phase09_b', false);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","o":{"id":"org_phase09_a"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase09/repo', 'phase09/repo');
  perform set_config('cartograph.phase09_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase09_run', v_start.run_id::text, true);
  perform private.phase09_readers_null(v_start.analysis_id, v_start.run_id);
  select * into v_start from public.start_analysis('https://github.com/phase09/neighbor', 'phase09/neighbor');
  perform set_config('cartograph.phase09_same_org_id', v_start.analysis_id::text, true);
end;
$$;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","o":{"id":"org_phase09_b"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase09/repo', 'phase09/repo');
  perform set_config('cartograph.phase09_neighbor_id', v_start.analysis_id::text, true);
end;
$$;
reset role;

-- Direct legacy inserts receive the same empty default as older RPC writers.
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_exports jsonb;
begin
  insert into public.files (organization_id, analysis_id, path)
  values ('org_phase09_a', v_id, 'legacy-default.js') returning export_names into v_exports;
  if v_exports is distinct from '[]'::jsonb then raise exception 'Legacy file default is not empty'; end if;
  delete from public.files where organization_id = 'org_phase09_a' and analysis_id = v_id;
end;
$$;

-- Overlapping paths in another analysis and organization must remain untouched.
set local role service_role;
do $$
declare
  v_id uuid;
  v_run uuid;
  v_before jsonb;
begin
  foreach v_id in array array[current_setting('cartograph.phase09_same_org_id')::uuid,
      current_setting('cartograph.phase09_neighbor_id')::uuid] loop
    select run_id into strict v_run from public.analyses where id = v_id;
    if public.store_analysis(v_id, v_run, private.phase09_result()) is distinct from true then
      raise exception 'Neighbor CommonJS graph was not stored';
    end if;
    perform set_config('cartograph.phase09_neighbor_' || replace(v_id::text, '-', '_'),
      private.phase09_snapshot(v_id)::text, true);
  end loop;
  v_id := current_setting('cartograph.phase09_id')::uuid;
  v_run := current_setting('cartograph.phase09_run')::uuid;
  v_before := private.phase09_snapshot(v_id);
  if public.store_analysis(v_id, gen_random_uuid(), private.phase09_result()) is distinct from false
    or private.phase09_snapshot(v_id) is distinct from v_before then
    raise exception 'A stale run changed CommonJS data';
  end if;
  if public.store_analysis(v_id, v_run, private.phase09_result()) is distinct from true then
    raise exception 'CommonJS and Express data were not stored';
  end if;
  v_before := private.phase09_snapshot(v_id);
  if public.store_analysis(v_id, v_run, '{}'::jsonb) is distinct from false
    or private.phase09_snapshot(v_id) is distinct from v_before then
    raise exception 'A completed CommonJS graph accepted another write';
  end if;
  perform set_config('cartograph.phase09_expected', private.phase09_result()::text, true);
end;
$$;
reset role;

-- The column enforces the contract even when a privileged writer bypasses RPCs.
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_bad jsonb;
begin
  begin
    update public.files set export_names = null
    where organization_id = 'org_phase09_a' and analysis_id = v_id;
    raise exception 'SQL NULL export names were accepted';
  exception when not_null_violation then null;
  end;
  for v_bad in select value from jsonb_array_elements('[
    null, {}, "[]", 1, true, [null], [1], [true], [{}], [[]], ["find","find"], ["z","A"], ["_","A"], ["",""]
  ]'::jsonb) loop
    begin
      update public.files set export_names = v_bad
      where organization_id = 'org_phase09_a' and analysis_id = v_id;
      raise exception 'Invalid stored export names were accepted: %', v_bad;
    exception when check_violation then null;
    end;
  end loop;
  if (select export_names from public.files where organization_id = 'org_phase09_a'
      and analysis_id = v_id and path = 'controllers/users.js') is distinct from '["","A","_","default","find","z","","𐀀"]'::jsonb then
    raise exception 'Column rejection changed existing export names';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","o":{"id":"org_phase09_a"}}', true);
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_run uuid := current_setting('cartograph.phase09_run')::uuid;
  v_full jsonb := public.read_analysis_result_v3(v_id, v_run);
  v_rerun record;
begin
  if v_full is distinct from current_setting('cartograph.phase09_expected')::jsonb then
    raise exception 'CommonJS exports, require edges or Express roles did not round trip: %', v_full;
  end if;
  if v_full -> 'routes' is distinct from '[]'::jsonb
    or v_full -> 'frameworkEntries' is distinct from '[]'::jsonb then
    raise exception 'Express invented routes or framework entries';
  end if;
  perform private.phase09_projection(v_id, v_run);
  perform private.phase09_readers_null(v_id, gen_random_uuid());
  perform private.phase09_readers_null(gen_random_uuid(), v_run);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","o":{"id":"org_phase09_b"}}', true);
  perform private.phase09_readers_null(v_id, v_run);
  if exists (select 1 from public.files where analysis_id = v_id) then
    raise exception 'File exports leaked through direct table access across organizations';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09"}', true);
  perform private.phase09_readers_null(v_id, v_run);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","org_id":"org_phase09_a"}', true);
  perform private.phase09_projection(v_id, v_run);
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'CommonJS fixture could not be rerun'; end if;
  perform set_config('cartograph.phase09_run', v_rerun.run_id::text, true);
  perform private.phase09_readers_null(v_id, v_run);
  perform private.phase09_readers_null(v_id, v_rerun.run_id);
end;
$$;
reset role;

-- Export failures on the final file prove that partially replaced files roll
-- back. Metadata and endpoint failures must retain the complete prior snapshot.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_run uuid := current_setting('cartograph.phase09_run')::uuid;
  v_result jsonb := private.phase09_result();
  v_value jsonb;
  v_bad jsonb;
  v_role text;
  v_other uuid;
  v_exports jsonb;
begin
  for v_value in select value from jsonb_array_elements('[
    null, {}, "[]", 1, true, [null], [1], [true], [{}], [[]],
    ["find","find"], ["z","A"], ["_","A"], ["find","default"], ["", ""],
    ["𐀀",""]
  ]'::jsonb) loop
    perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{files,4,exports}', v_value));
  end loop;
  for v_value in select value from jsonb_array_elements('[[],["unknown-kind"],["require","unknown-kind"]]'::jsonb) loop
    perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{edges,0,kinds}', v_value), '23514');
  end loop;
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{edges,0,target}', '"missing.js"'), '23503');
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{framework}', '"unknown-framework"'));
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{routes}',
    '[{"file":"routes/users.js","method":"GET","path":"/users","line":1}]'));
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{frameworkEntries}', '["routes/users.js"]'));
  foreach v_role in array array['page', 'api', 'module', 'entity', 'component', 'hook', 'unknown-role'] loop
    perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles,0,role}', to_jsonb(v_role)));
  end loop;
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles,0,file}', '"missing.js"'), '23503');
  perform private.phase09_reject(v_id, v_run, jsonb_set(v_result, '{fileRoles}',
    (v_result -> 'fileRoles') || jsonb_build_array(v_result #> '{fileRoles,0}')));

  -- One omitted exports field defaults independently of every other file.
  begin
    v_bad := jsonb_set(v_result, '{files,0}', (v_result #> '{files,0}') - 'exports');
    if public.store_analysis(v_id, v_run, v_bad) is distinct from true then
      raise exception 'An individually absent exports field was rejected';
    end if;
    select export_names into v_exports from public.files where organization_id = 'org_phase09_a'
      and analysis_id = v_id and path = 'controllers/users.js';
    if v_exports is distinct from '[]'::jsonb
      or (select export_names from public.files where organization_id = 'org_phase09_a'
        and analysis_id = v_id and path = 'services/users.js') is distinct from '["find","save"]'::jsonb then
      raise exception 'Absent exports did not default independently';
    end if;
    raise exception using errcode = 'P9009', message = 'per-file export default rollback';
  exception when sqlstate 'P9009' then
    if sqlerrm <> 'per-file export default rollback' then raise; end if;
  end;

  foreach v_other in array array[current_setting('cartograph.phase09_same_org_id')::uuid,
      current_setting('cartograph.phase09_neighbor_id')::uuid] loop
    if private.phase09_snapshot(v_other) is distinct from current_setting(
        'cartograph.phase09_neighbor_' || replace(v_other::text, '-', '_'))::jsonb then
      raise exception 'CommonJS replacement changed a neighboring graph';
    end if;
  end loop;
  -- Older phase 8 writers have metadata but no per-file exports. They must clear
  -- actual previous names, including after all rejected probes above.
  select jsonb_agg(entry.value - 'exports' order by entry.ordinal) into v_value
  from jsonb_array_elements(v_result -> 'files') with ordinality entry(value, ordinal);
  v_result := jsonb_set(v_result, '{files}', v_value)
    || '{"framework":"generic","fileRoles":[],"routes":[],"frameworkEntries":[]}'::jsonb;
  if public.store_analysis(v_id, v_run, v_result) is distinct from true then
    raise exception 'An older phase 8 writer was rejected';
  end if;
  if exists (select 1 from public.files where organization_id = 'org_phase09_a'
      and analysis_id = v_id and export_names <> '[]'::jsonb) then
    raise exception 'An older writer retained CommonJS export evidence';
  end if;
  perform set_config('cartograph.phase09_legacy', v_result::text, true);
end;
$$;
reset role;

set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_run uuid := current_setting('cartograph.phase09_run')::uuid;
  v_full jsonb := public.read_analysis_result_v3(v_id, v_run);
  v_rerun record;
begin
  perform private.phase09_projection(v_id, v_run);
  if public.read_analysis_result_v2(v_id, v_run) is distinct from current_setting('cartograph.phase09_legacy')::jsonb
    or exists (select 1 from jsonb_array_elements(v_full -> 'files') entry where entry -> 'exports' <> '[]'::jsonb) then
    raise exception 'Older phase 8 readback or V3 export normalization changed';
  end if;
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'Legacy phase 8 fixture could not be rerun'; end if;
  perform set_config('cartograph.phase09_run', v_rerun.run_id::text, true);
end;
$$;
reset role;

-- Restore nonempty names before proving a phase 7 writer clears them as well.
set local role service_role;
do $$
begin
  if public.store_analysis(current_setting('cartograph.phase09_id')::uuid,
      current_setting('cartograph.phase09_run')::uuid, private.phase09_result()) is distinct from true then
    raise exception 'Export evidence could not be restored before the phase 7 writer';
  end if;
end;
$$;
reset role;
set local role authenticated;
do $$
declare v_rerun record;
begin
  select * into v_rerun from public.rerun_analysis(current_setting('cartograph.phase09_id')::uuid);
  if not v_rerun.started then raise exception 'Phase 7 compatibility fixture could not be rerun'; end if;
  perform set_config('cartograph.phase09_run', v_rerun.run_id::text, true);
end;
$$;
reset role;
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_run uuid := current_setting('cartograph.phase09_run')::uuid;
  v_result jsonb := current_setting('cartograph.phase09_legacy')::jsonb
    - array['framework', 'fileRoles', 'routes', 'frameworkEntries'];
begin
  if public.store_analysis(v_id, v_run, v_result) is distinct from true then
    raise exception 'An older phase 7 writer was rejected';
  end if;
  if exists (select 1 from public.files where organization_id = 'org_phase09_a'
      and analysis_id = v_id and export_names <> '[]'::jsonb) then
    raise exception 'A phase 7 writer retained export names from the prior run';
  end if;
end;
$$;
reset role;

set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase09_id')::uuid;
  v_run uuid := current_setting('cartograph.phase09_run')::uuid;
  v_full jsonb := public.read_analysis_result_v3(v_id, v_run);
begin
  perform private.phase09_projection(v_id, v_run);
  if public.read_analysis_result(v_id, v_run) is distinct from current_setting('cartograph.phase09_legacy')::jsonb
      - array['framework', 'fileRoles', 'routes', 'frameworkEntries']
    or v_full ->> 'framework' is distinct from 'generic'
    or v_full -> 'fileRoles' is distinct from '[]'::jsonb
    or v_full -> 'routes' is distinct from '[]'::jsonb
    or v_full -> 'frameworkEntries' is distinct from '[]'::jsonb
    or exists (select 1 from jsonb_array_elements(v_full -> 'files') entry where entry -> 'exports' <> '[]'::jsonb) then
    raise exception 'Legacy phase 7 graph or export normalization changed';
  end if;
  perform private.phase09_readers_null(v_id, gen_random_uuid());
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09","o":{"id":"org_phase09_b"}}', true);
  perform private.phase09_readers_null(v_id, v_run);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase09"}', true);
  perform private.phase09_readers_null(v_id, v_run);
  begin
    perform public.store_analysis(v_id, v_run, '{}'::jsonb);
    raise exception 'An authenticated user called the CommonJS writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
declare v_reader text;
begin
  foreach v_reader in array array['read_analysis_result', 'read_analysis_result_v2', 'read_analysis_result_v3'] loop
    begin
      execute format('select public.%I($1, $2)', v_reader) using gen_random_uuid(), gen_random_uuid();
      raise exception 'An anonymous user called reader %', v_reader;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.store_analysis(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'An anonymous user called the CommonJS writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
select 'Phase 9 database checks passed; fixtures rolled back.' as result;
