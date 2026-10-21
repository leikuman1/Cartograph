-- Run as the migration owner with pnpm db:verify after the phase 8 suite.
-- Real roles exercise both reader contracts; every fixture and grant rolls back.
begin;

do $$
declare
  v_reader text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'analyses' and column_name = 'framework_entries'
      and data_type = 'jsonb' and is_nullable = 'NO' and column_default = '''[]''::jsonb'
  ) then
    raise exception 'Framework entry storage or its empty default is missing';
  end if;
  foreach v_reader in array array['read_analysis_result', 'read_analysis_result_v2'] loop
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
    or has_function_privilege('anon', 'public.store_analysis(uuid,uuid,jsonb)', 'EXECUTE') then
    raise exception 'Framework entry storage changed writer security';
  end if;
end;
$$;

create function private.phase08_review_result()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'framework', 'nextjs',
    'frameworkEntries', '["src/app/A/error.tsx","src/app/_shell/layout.tsx","src/app/z/not-found.tsx"]'::jsonb,
    'fileRoles', '[
      {"file":"src/app/_shell/layout.tsx","role":"layout"},
      {"file":"src/app/page.tsx","role":"page"}
    ]'::jsonb,
    'routes', '[{"file":"src/app/page.tsx","method":"GET","path":"/","line":2}]'::jsonb,
    'files', (
      select jsonb_agg(jsonb_build_object(
        'path', f.path, 'folder', f.folder, 'module', '.', 'lineCount', 10,
        'contentHash', repeat('a', 64), 'fanIn', f.fan_in, 'fanOut', f.fan_out
      ) order by f.path collate "C")
      from (values
        ('src/app/A/error.tsx', 'src/app/A', 0, 0),
        ('src/app/_shell/layout.tsx', 'src/app/_shell', 0, 0),
        ('src/app/page.tsx', 'src/app', 0, 1),
        ('src/app/z/not-found.tsx', 'src/app/z', 0, 0),
        ('src/helper.ts', 'src', 1, 0)
      ) f(path, folder, fan_in, fan_out)
    ),
    'edges', '[{"source":"src/app/page.tsx","target":"src/helper.ts","kinds":["import"]}]'::jsonb,
    'imports', '[{
      "source":"src/app/page.tsx","specifier":"../helper","kind":"import","line":1,
      "resolution":{"status":"internal","target":"src/helper.ts"}
    }]'::jsonb,
    'coverage', '{
      "files":{"discovered":5,"parsed":5,"skipped":0,"skippedFiles":[],"excludedDirectories":[]},
      "imports":{"discovered":1,"internal":1,"external":0,"excluded":0,"unresolved":0}
    }'::jsonb
  );
$$;

-- Include physical row IDs and completion fields, so replacement followed by a
-- similar-looking graph cannot conceal a partial write after rejection.
create function private.phase08_review_snapshot(p_analysis_id uuid)
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

create function private.phase08_review_reject(
  p_analysis_id uuid, p_run_id uuid, p_result jsonb, p_state text default '22023'
)
returns void
language plpgsql
as $$
declare
  v_before jsonb := private.phase08_review_snapshot(p_analysis_id);
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
  if v_state is null then raise exception 'Malformed framework entries were accepted: %', p_result; end if;
  if private.phase08_review_snapshot(p_analysis_id) is distinct from v_before then
    raise exception 'Rejected framework entries changed persisted rows';
  end if;
end;
$$;

-- Invoker helpers only remove repetition; visibility still comes from the
-- authenticated role and its active organization, exactly as in the app.
create function private.phase08_review_projection(p_analysis_id uuid, p_run_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_legacy jsonb := public.read_analysis_result(p_analysis_id, p_run_id);
  v_full jsonb := public.read_analysis_result_v2(p_analysis_id, p_run_id);
begin
  if v_legacy is null or v_full is null then
    raise exception 'A completed visible graph was not returned by both readers';
  end if;
  if (select array_agg(key order by key collate "C") from jsonb_object_keys(v_legacy) root(key))
      is distinct from array['coverage', 'edges', 'files', 'imports', 'schemaVersion']
    or (select array_agg(key order by key collate "C") from jsonb_object_keys(v_full) root(key))
      is distinct from array['coverage', 'edges', 'fileRoles', 'files', 'framework', 'frameworkEntries', 'imports', 'routes', 'schemaVersion']
    or v_legacy is distinct from v_full - array['framework', 'fileRoles', 'routes', 'frameworkEntries']
    or v_legacy -> 'schemaVersion' is distinct from '1'::jsonb then
    raise exception 'Legacy response keys or projection equivalence changed: %', v_legacy;
  end if;
end;
$$;

create function private.phase08_review_readers_null(p_analysis_id uuid, p_run_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if public.read_analysis_result(p_analysis_id, p_run_id) is not null
    or public.read_analysis_result_v2(p_analysis_id, p_run_id) is not null then
    raise exception 'A reader returned an invisible, wrong-run or incomplete graph';
  end if;
end;
$$;

revoke all on function private.phase08_review_result() from public, anon, authenticated;
revoke all on function private.phase08_review_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.phase08_review_reject(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.phase08_review_projection(uuid, uuid) from public, anon, authenticated;
revoke all on function private.phase08_review_readers_null(uuid, uuid) from public, anon, authenticated;
-- Temporary helper access rolls back; no production helper or policy is changed.
grant usage on schema private to service_role, authenticated;
grant execute on function private.phase08_review_result() to service_role;
grant execute on function private.phase08_review_snapshot(uuid) to service_role;
grant execute on function private.phase08_review_reject(uuid, uuid, jsonb, text) to service_role;
grant execute on function private.phase08_review_projection(uuid, uuid) to authenticated;
grant execute on function private.phase08_review_readers_null(uuid, uuid) to authenticated;

select public.sync_organization('org_phase08_review_a', false);
select public.sync_organization('org_phase08_review_b', false);
set local role authenticated;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08_review","o":{"id":"org_phase08_review_a"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase08-review/repo', 'phase08-review/repo');
  perform set_config('cartograph.phase08_review_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase08_review_run', v_start.run_id::text, true);
  perform private.phase08_review_readers_null(v_start.analysis_id, v_start.run_id);
  select * into v_start from public.start_analysis('https://github.com/phase08-review/neighbor', 'phase08-review/neighbor');
  perform set_config('cartograph.phase08_review_same_org_id', v_start.analysis_id::text, true);
end;
$$;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08_review","o":{"id":"org_phase08_review_b"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase08-review/repo', 'phase08-review/repo');
  perform set_config('cartograph.phase08_review_neighbor_id', v_start.analysis_id::text, true);
end;
$$;
reset role;

-- Both neighboring analyses contain the same entry paths. Membership must be
-- checked against the current replacement, not one of those other graphs.
set local role service_role;
do $$
declare
  v_id uuid;
  v_run uuid;
  v_before jsonb;
begin
  foreach v_id in array array[
    current_setting('cartograph.phase08_review_same_org_id')::uuid,
    current_setting('cartograph.phase08_review_neighbor_id')::uuid
  ] loop
    select run_id into strict v_run from public.analyses where id = v_id;
    if public.store_analysis(v_id, v_run, private.phase08_review_result()) is distinct from true then
      raise exception 'Neighbor framework entry graph was not stored';
    end if;
    perform set_config('cartograph.phase08_review_neighbor_' || replace(v_id::text, '-', '_'),
      private.phase08_review_snapshot(v_id)::text, true);
  end loop;
  v_id := current_setting('cartograph.phase08_review_id')::uuid;
  v_run := current_setting('cartograph.phase08_review_run')::uuid;
  if (select framework_entries from public.analyses where id = v_id) is distinct from '[]'::jsonb then
    raise exception 'A new analysis did not default to empty framework entries';
  end if;
  v_before := private.phase08_review_snapshot(v_id);
  if public.store_analysis(v_id, gen_random_uuid(), private.phase08_review_result()) is distinct from false
    or private.phase08_review_snapshot(v_id) is distinct from v_before then
    raise exception 'A superseded run changed framework entries';
  end if;
  if public.store_analysis(v_id, v_run, private.phase08_review_result()) is distinct from true then
    raise exception 'Framework entries were not stored';
  end if;
  v_before := private.phase08_review_snapshot(v_id);
  if public.store_analysis(v_id, v_run, '{}'::jsonb) is distinct from false
    or private.phase08_review_snapshot(v_id) is distinct from v_before then
    raise exception 'A completed run accepted another write';
  end if;
  perform set_config('cartograph.phase08_review_expected', private.phase08_review_result()::text, true);
end;
$$;
reset role;

-- The column itself refuses SQL NULL, JSON null and nonarrays, including writes
-- outside the RPC. Each failed probe must retain the successfully stored entries.
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_bad jsonb;
begin
  begin
    update public.analyses set framework_entries = null where id = v_id;
    raise exception 'SQL NULL framework entries were accepted';
  exception when not_null_violation then null;
  end;
  for v_bad in select value from jsonb_array_elements('[null,{},"[]",1]'::jsonb) loop
    begin
      update public.analyses set framework_entries = v_bad where id = v_id;
      raise exception 'Nonarray framework entry storage was accepted';
    exception when check_violation then null;
    end;
  end loop;
  if (select framework_entries from public.analyses where id = v_id)
      is distinct from current_setting('cartograph.phase08_review_expected')::jsonb -> 'frameworkEntries' then
    raise exception 'Column constraint probes changed framework entries';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"user_phase08_review","o":{"id":"org_phase08_review_a"}}', true);
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_review_run')::uuid;
  v_full jsonb := public.read_analysis_result_v2(v_id, v_run);
  v_rerun record;
begin
  if v_full is distinct from current_setting('cartograph.phase08_review_expected')::jsonb then
    raise exception 'Framework entries or graph did not round trip in strict C order: %', v_full;
  end if;
  perform private.phase08_review_projection(v_id, v_run);
  perform private.phase08_review_readers_null(v_id, gen_random_uuid());
  perform private.phase08_review_readers_null(gen_random_uuid(), v_run);
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase08_review","o":{"id":"org_phase08_review_b"}}', true);
  perform private.phase08_review_readers_null(v_id, v_run);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase08_review"}', true);
  perform private.phase08_review_readers_null(v_id, v_run);
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase08_review","org_id":"org_phase08_review_a"}', true);
  perform private.phase08_review_projection(v_id, v_run);
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'Framework entry graph could not be rerun'; end if;
  perform set_config('cartograph.phase08_review_run', v_rerun.run_id::text, true);
  perform private.phase08_review_readers_null(v_id, v_run);
  perform private.phase08_review_readers_null(v_id, v_rerun.run_id);
end;
$$;
reset role;

-- Shape/order failures and failures discovered after replacing the files all
-- leave the prior graph and its entry evidence intact under the pending run.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_review_run')::uuid;
  v_result jsonb := private.phase08_review_result();
  v_bad jsonb;
  v_value jsonb;
  v_key text;
  v_other uuid;
  v_stored boolean;
  v_entries jsonb;
begin
  for v_value in select value from jsonb_array_elements('[
    null, {}, "[]", 1, true,
    [null], [1], [true], [{}], [[]], [""], ["   "],
    ["/src/app/A/error.tsx"], ["C:/src/app/A/error.tsx"], ["src\\app\\A\\error.tsx"],
    ["."], [".."], ["./src/app/A/error.tsx"], ["src/../app/A/error.tsx"],
    ["src//app/A/error.tsx"], ["src/app/A/error.tsx/"],
    ["src/app/A/error\n.tsx"], ["src/app/A/error\t.tsx"], ["src/app/A/error\u007f.tsx"],
    ["src/app/A/error.tsx","src/app/A/error.tsx"],
    ["src/app/z/not-found.tsx","src/app/A/error.tsx"],
    ["src/app/_shell/layout.tsx","src/app/A/error.tsx"],
    ["src/app/A/error.tsx","src/app/z/not-found.tsx","src/app/_shell/layout.tsx"]
  ]'::jsonb) loop
    perform private.phase08_review_reject(v_id, v_run, jsonb_set(v_result, '{frameworkEntries}', v_value));
  end loop;
  perform private.phase08_review_reject(v_id, v_run,
    jsonb_set(v_result, '{frameworkEntries}', '["src/app/missing.tsx"]'), '23503');
  -- A path that existed in the prior run and both neighbors is still missing
  -- when it is absent from the replacement's parsed file list.
  perform private.phase08_review_reject(v_id, v_run,
    jsonb_set(v_result, '{files}', (v_result -> 'files') - 0), '23503');
  foreach v_key in array array['framework', 'fileRoles', 'routes'] loop
    perform private.phase08_review_reject(v_id, v_run, v_result - v_key);
    perform private.phase08_review_reject(v_id, v_run,
      jsonb_set(v_result - v_key, '{frameworkEntries}', '[]'));
    perform private.phase08_review_reject(v_id, v_run, jsonb_set(v_result, array[v_key], 'null'));
    perform private.phase08_review_reject(v_id, v_run,
      (v_result - 'framework' - 'fileRoles' - 'routes') || jsonb_build_object(v_key, v_result -> v_key));
  end loop;
  perform private.phase08_review_reject(v_id, v_run, v_result - 'framework' - 'fileRoles' - 'routes');
  perform private.phase08_review_reject(v_id, v_run,
    jsonb_set(v_result - 'framework' - 'fileRoles' - 'routes', '{frameworkEntries}', '[]'));
  foreach v_key in array array['generic', 'react', 'nestjs'] loop
    perform private.phase08_review_reject(v_id, v_run,
      v_result || jsonb_build_object('framework', v_key, 'fileRoles', '[]'::jsonb, 'routes', '[]'::jsonb));
    -- Empty entries are valid for every framework when the whole block exists.
    begin
      v_bad := v_result || jsonb_build_object('framework', v_key,
        'fileRoles', '[]'::jsonb, 'routes', '[]'::jsonb, 'frameworkEntries', '[]'::jsonb);
      if public.store_analysis(v_id, v_run, v_bad) is distinct from true then
        raise exception 'Empty entries were rejected for %', v_key;
      end if;
      raise exception using errcode = 'P8009', message = 'empty framework entries rollback';
    exception when sqlstate 'P8009' then
      if sqlerrm <> 'empty framework entries rollback' then raise; end if;
    end;
  end loop;
  -- A later metadata error also cannot commit an otherwise valid entries list.
  perform private.phase08_review_reject(v_id, v_run,
    jsonb_set(v_result, '{routes,0,line}', '11'));
  if (select framework_entries from public.analyses where id = v_id)
      is distinct from v_result -> 'frameworkEntries' then
    raise exception 'Rejected payloads cleared the prior framework entries';
  end if;
  -- A phase 8 writer predating entries is valid and clears stale evidence.
  -- The write and the read must be separate statements: a scalar subquery inside
  -- the same IF becomes an InitPlan that runs before store_analysis, so it would
  -- compare against the entries this call is meant to clear.
  v_stored := public.store_analysis(v_id, v_run, v_result - 'frameworkEntries');
  select framework_entries into v_entries from public.analyses where id = v_id;
  if v_stored is distinct from true or v_entries is distinct from '[]'::jsonb then
    raise exception 'Older phase 8 storage did not normalize and clear entries';
  end if;
  foreach v_other in array array[
    current_setting('cartograph.phase08_review_same_org_id')::uuid,
    current_setting('cartograph.phase08_review_neighbor_id')::uuid
  ] loop
    if private.phase08_review_snapshot(v_other) is distinct from current_setting(
      'cartograph.phase08_review_neighbor_' || replace(v_other::text, '-', '_'))::jsonb then
      raise exception 'Replacing entries changed a neighboring graph';
    end if;
  end loop;
end;
$$;
reset role;

set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_review_run')::uuid;
  v_full jsonb := public.read_analysis_result_v2(v_id, v_run);
  v_rerun record;
begin
  if v_full is distinct from jsonb_set(current_setting('cartograph.phase08_review_expected')::jsonb,
      '{frameworkEntries}', '[]') then
    raise exception 'Older phase 8 output did not normalize to empty entries';
  end if;
  perform private.phase08_review_projection(v_id, v_run);
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'Older phase 8 fixture could not be rerun'; end if;
  perform set_config('cartograph.phase08_review_run', v_rerun.run_id::text, true);
  perform private.phase08_review_readers_null(v_id, v_run);
  perform private.phase08_review_readers_null(v_id, v_rerun.run_id);
end;
$$;
reset role;

-- Repopulate entries so the phase 7 compatibility check proves clearing an
-- actual list, rather than merely writing an already-empty field again.
set local role service_role;
do $$
begin
  if public.store_analysis(current_setting('cartograph.phase08_review_id')::uuid,
    current_setting('cartograph.phase08_review_run')::uuid, private.phase08_review_result()) is distinct from true then
    raise exception 'Entries could not be restored before the phase 7 write';
  end if;
end;
$$;
reset role;
set local role authenticated;
do $$
declare v_rerun record;
begin
  select * into v_rerun from public.rerun_analysis(current_setting('cartograph.phase08_review_id')::uuid);
  if not v_rerun.started then raise exception 'Phase 7 compatibility fixture could not be rerun'; end if;
  perform set_config('cartograph.phase08_review_run', v_rerun.run_id::text, true);
end;
$$;
reset role;
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_review_run')::uuid;
  v_legacy jsonb := private.phase08_review_result() - array['framework', 'fileRoles', 'routes', 'frameworkEntries'];
begin
  if public.store_analysis(v_id, v_run, v_legacy) is distinct from true then
    raise exception 'A phase 7 writer was rejected by the upgraded database';
  end if;
  if (select framework_entries from public.analyses where id = v_id) is distinct from '[]'::jsonb
    or (select framework from public.analyses where id = v_id) is distinct from 'generic'
    or exists (select 1 from public.file_roles where organization_id = 'org_phase08_review_a' and analysis_id = v_id)
    or exists (select 1 from public.routes where organization_id = 'org_phase08_review_a' and analysis_id = v_id) then
    raise exception 'A phase 7 writer retained framework metadata from the prior run';
  end if;
end;
$$;
reset role;
set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase08_review_id')::uuid;
  v_run uuid := current_setting('cartograph.phase08_review_run')::uuid;
  v_full jsonb := public.read_analysis_result_v2(v_id, v_run);
  v_legacy jsonb := current_setting('cartograph.phase08_review_expected')::jsonb
    - array['framework', 'fileRoles', 'routes', 'frameworkEntries'];
begin
  perform private.phase08_review_projection(v_id, v_run);
  if public.read_analysis_result(v_id, v_run) is distinct from v_legacy
    or v_full is distinct from v_legacy || '{"framework":"generic","fileRoles":[],"routes":[],"frameworkEntries":[]}'::jsonb then
    raise exception 'Legacy graph readback or new-reader normalization changed';
  end if;
  perform private.phase08_review_readers_null(v_id, gen_random_uuid());
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"user_phase08_review","o":{"id":"org_phase08_review_b"}}', true);
  perform private.phase08_review_readers_null(v_id, v_run);
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase08_review"}', true);
  perform private.phase08_review_readers_null(v_id, v_run);
  begin
    perform public.store_analysis(v_id, v_run, '{}'::jsonb);
    raise exception 'An authenticated user called the entry writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
declare v_reader text;
begin
  foreach v_reader in array array['read_analysis_result', 'read_analysis_result_v2'] loop
    begin
      execute format('select public.%I($1, $2)', v_reader) using gen_random_uuid(), gen_random_uuid();
      raise exception 'An anonymous user called reader %', v_reader;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.store_analysis(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb);
    raise exception 'An anonymous user called the entry writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;
select 'Phase 8 review database checks passed; fixtures rolled back.' as result;
