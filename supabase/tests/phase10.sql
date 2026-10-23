-- Run as the migration owner with pnpm db:verify. All fixtures roll back.
begin;

do $$
declare
  v_table text;
  v_writer text;
begin
  foreach v_table in array array['ai_cache', 'ai_run_roles'] loop
    if not (select relrowsecurity from pg_class where oid = format('public.%I', v_table)::regclass)
      or not exists (
        select 1 from pg_constraint where conrelid = format('public.%I', v_table)::regclass
          and contype = 'f' and confrelid = 'private.organizations'::regclass and confdeltype = 'c'
      ) then
      raise exception 'AI table % lacks RLS or its direct organization cascade', v_table;
    end if;
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT')
      or not has_table_privilege('service_role', format('public.%I', v_table), 'SELECT')
      or has_table_privilege('authenticated', format('public.%I', v_table), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('service_role', format('public.%I', v_table), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('anon', format('public.%I', v_table), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'AI table % does not restrict writes to RPCs', v_table;
    end if;
  end loop;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.ai_cache'::regclass and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (organization_id, cache_key)'
  ) or exists (
    select 1 from pg_constraint where conrelid = 'public.ai_cache'::regclass and contype = 'f'
      and confrelid <> 'private.organizations'::regclass
  ) or not exists (
    select 1 from pg_constraint where conrelid = 'public.ai_run_roles'::regclass and contype = 'p'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (organization_id, analysis_id, run_id, model)'
  ) or not exists (
    select 1 from pg_constraint where conrelid = 'public.ai_run_roles'::regclass and contype = 'f'
      and confrelid = 'public.analyses'::regclass and confdeltype = 'c'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.ai_run_roles'::regclass and attname = 'organization_id'),
        (select attnum from pg_attribute where attrelid = 'public.ai_run_roles'::regclass and attname = 'analysis_id')
      ]::smallint[]
      and confkey = array[
        (select attnum from pg_attribute where attrelid = 'public.analyses'::regclass and attname = 'organization_id'),
        (select attnum from pg_attribute where attrelid = 'public.analyses'::regclass and attname = 'id')
      ]::smallint[]
  ) then
    raise exception 'AI cache independence or run-role primary/composite foreign key changed';
  end if;
  foreach v_writer in array array[
    'public.write_ai_cache(text,text,text,text,jsonb)',
    'public.write_ai_roles(uuid,uuid,text,jsonb)',
    'public.store_analysis_with_ai(uuid,uuid,jsonb,text,jsonb)'
  ] loop
    if not exists (
      select 1 from pg_proc where oid = v_writer::regprocedure and prosecdef
        and proconfig @> array['search_path=""']
    ) or not has_function_privilege('service_role', v_writer, 'EXECUTE')
      or has_function_privilege('authenticated', v_writer, 'EXECUTE')
      or has_function_privilege('anon', v_writer, 'EXECUTE')
      or exists (
        select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) permission
        where p.oid = v_writer::regprocedure and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
      ) then
      raise exception 'AI writer % lacks restricted definer security', v_writer;
    end if;
  end loop;
  if not exists (
    select 1 from pg_proc where oid = 'public.read_ai_roles(uuid,uuid,text)'::regprocedure
      and not prosecdef and provolatile = 's' and proconfig @> array['search_path=""']
  ) or not has_function_privilege('authenticated', 'public.read_ai_roles(uuid,uuid,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.read_ai_roles(uuid,uuid,text)', 'EXECUTE')
    or exists (
      select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) permission
      where p.oid = 'public.read_ai_roles(uuid,uuid,text)'::regprocedure
        and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
    ) then
    raise exception 'AI role reader lost stable invoker security or restricted grants';
  end if;
end;
$$;

create function private.phase10_result()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'framework', 'express', 'frameworkEntries', '[]'::jsonb,
    'fileRoles', '[{"file":"adapter.ts","role":"controller"}]'::jsonb, 'routes', '[]'::jsonb,
    'files', (select jsonb_agg(jsonb_build_object(
      'path', f.path, 'folder', case when strpos(f.path, '/') > 0 then regexp_replace(f.path, '/[^/]+$', '') else '.' end,
      'module', '.', 'lineCount', 10, 'contentHash', repeat('a', 64),
      'fanIn', 0, 'fanOut', 0, 'exports', '[]'::jsonb
    ) order by f.path collate "C") from unnest(array[
      'adapter.ts', 'config.ts', 'data.ts', 'domain.ts', 'helper.ts', 'logic.ts',
      'use-data.ts', 'view.tsx', 'helper.test.ts', 'tests/helper.ts', 'types.d.ts',
      '__mocks__/helper.ts', 'fixtures/helper.ts', 'runtime-tests/helper.ts', 'helper.spec.custom'
    ]) f(path)),
    'edges', '[]'::jsonb, 'imports', '[]'::jsonb,
    'coverage', '{"files":{"discovered":15,"parsed":15,"skipped":0,"skippedFiles":[],"excludedDirectories":[]},
      "imports":{"discovered":0,"internal":0,"external":0,"excluded":0,"unresolved":0}}'::jsonb
  );
$$;
-- Mocks and fixtures are Source candidates under genericCategoryForPath.
create function private.phase10_roles()
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('file', r.file, 'role', r.role, 'contentHash', repeat('a', 64))
    order by r.file collate "C") from (values
    ('config.ts', 'config'), ('data.ts', 'repository'), ('domain.ts', 'model'),
    ('helper.ts', 'util'), ('logic.ts', 'service'), ('use-data.ts', 'hook'), ('view.tsx', 'component'),
    ('__mocks__/helper.ts', 'util'), ('fixtures/helper.ts', 'util')
  ) r(file, role);
$$;
create function private.phase10_snapshot(p_analysis_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'analysis', to_jsonb(a),
    'files', (select jsonb_agg(to_jsonb(f) order by f.id) from public.files f
      where f.organization_id = a.organization_id and f.analysis_id = a.id),
    'adapterRoles', (select jsonb_agg(to_jsonb(r) order by r.id) from public.file_roles r
      where r.organization_id = a.organization_id and r.analysis_id = a.id),
    'aiRoles', (select jsonb_agg(to_jsonb(r) order by r.run_id, r.model) from public.ai_run_roles r
      where r.organization_id = a.organization_id and r.analysis_id = a.id)
  ) from public.analyses a where a.id = p_analysis_id;
$$;
create function private.phase10_reject_roles(p_analysis_id uuid, p_run_id uuid, p_model text, p_roles jsonb,
  p_state text default '22023')
returns void language plpgsql as $$
declare
  v_before jsonb := private.phase10_snapshot(p_analysis_id);
  v_state text;
begin
  begin
    perform public.write_ai_roles(p_analysis_id, p_run_id, p_model, p_roles);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> p_state then raise exception 'Expected SQLSTATE %, got %: %', p_state, v_state, sqlerrm; end if;
  end;
  if v_state is null then raise exception 'Invalid AI roles were accepted: %', p_roles; end if;
  if private.phase10_snapshot(p_analysis_id) is distinct from v_before then
    raise exception 'Rejected AI roles changed the stored graph or annotations';
  end if;
end;
$$;
revoke all on function private.phase10_result() from public, anon, authenticated;
revoke all on function private.phase10_roles() from public, anon, authenticated;
revoke all on function private.phase10_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.phase10_reject_roles(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant usage on schema private to service_role, authenticated;
grant execute on function private.phase10_result(), private.phase10_roles(), private.phase10_snapshot(uuid),
  private.phase10_reject_roles(uuid, uuid, text, jsonb, text) to service_role;
grant execute on function private.phase10_roles() to authenticated;

select public.sync_organization('org_phase10_a', false);
select public.sync_organization('org_phase10_b', false);
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10","o":{"id":"org_phase10_a"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase10/repo', 'phase10/repo');
  perform set_config('cartograph.phase10_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase10_run', v_start.run_id::text, true);
  if public.read_ai_roles(v_start.analysis_id, v_start.run_id, 'model-2026-10-01') is not null then
    raise exception 'A running analysis exposed AI roles';
  end if;
  select * into v_start from public.start_analysis('https://github.com/phase10/neighbor', 'phase10/neighbor');
  perform set_config('cartograph.phase10_neighbor_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase10_neighbor_run', v_start.run_id::text, true);
end;
$$;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10","o":{"id":"org_phase10_b"}}', true);
do $$
declare v_start record;
begin
  select * into v_start from public.start_analysis('https://github.com/phase10/repo', 'phase10/repo');
  perform set_config('cartograph.phase10_other_id', v_start.analysis_id::text, true);
  perform set_config('cartograph.phase10_other_run', v_start.run_id::text, true);
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase10_id')::uuid;
  v_run uuid := current_setting('cartograph.phase10_run')::uuid;
  v_bad jsonb;
  v_before jsonb;
  v_key text;
  v_model text;
  v_operation text;
begin
  if public.write_ai_roles(v_id, v_run, 'model-2026-10-01', '[]') is distinct from false
    or public.write_ai_roles(gen_random_uuid(), v_run, 'model-2026-10-01', '[]') is distinct from false then
    raise exception 'AI role writer accepted an incomplete or missing analysis';
  end if;
  perform public.write_ai_cache('org_phase10_a', repeat('a', 64), 'model-2026-10-01', 'file', '{"document":{"blocks":[]}}');
  select to_jsonb(c) into v_before from public.ai_cache c
  where c.organization_id = 'org_phase10_a' and c.cache_key = repeat('a', 64);
  perform public.write_ai_cache('org_phase10_a', repeat('a', 64), 'other-model', 'classify', '{"roles":[]}');
  if (select to_jsonb(c) from public.ai_cache c where c.organization_id = 'org_phase10_a'
      and c.cache_key = repeat('a', 64)) is distinct from v_before then
    raise exception 'Cache conflict changed the original result, model, operation or timestamp';
  end if;
  perform public.write_ai_cache('org_phase10_b', repeat('a', 64), 'model-2026-10-01', 'file', '{"neighbor":true}');
  perform public.write_ai_cache('org_phase10_a', repeat('b', 64), 'model-2026-10-01', 'folder', '{"document":{"blocks":[]}}');
  perform public.write_ai_cache('org_phase10_a', repeat('c', 64), 'model-2026-10-01', 'classify', '{"roles":[]}');
  for v_bad in select value from jsonb_array_elements('[null,{},[],"text",1,true]'::jsonb) loop
    begin
      perform public.write_ai_cache('org_phase10_a', repeat('d', 64), 'model-2026-10-01', 'file', v_bad);
      raise exception 'Malformed cache result was accepted: %', v_bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.write_ai_cache('org_phase10_a', repeat('d', 64), 'model-2026-10-01', 'file', null);
    raise exception 'SQL NULL cache result was accepted';
  exception when invalid_parameter_value then null;
  end;
  foreach v_key in array array[null, '', repeat('A', 64), repeat('a', 63), repeat('g', 64)] loop
    begin
      perform public.write_ai_cache('org_phase10_a', v_key, 'model-2026-10-01', 'file', '{"ok":true}');
      raise exception 'Invalid cache key was accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  foreach v_model in array array[null, '', '   '] loop
    begin
      perform public.write_ai_cache('org_phase10_a', repeat('d', 64), v_model, 'file', '{"ok":true}');
      raise exception 'Blank cache model was accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  foreach v_operation in array array[null, '', 'route'] loop
    begin
      perform public.write_ai_cache('org_phase10_a', repeat('d', 64), 'model-2026-10-01', v_operation, '{"ok":true}');
      raise exception 'Invalid cache operation was accepted';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.write_ai_cache('org_phase10_missing', repeat('d', 64), 'model-2026-10-01', 'file', '{"ok":true}');
    raise exception 'Cache accepted a missing organization';
  exception when foreign_key_violation then null;
  end;
  if public.store_analysis_with_ai(v_id, gen_random_uuid(), private.phase10_result(), 'model-2026-10-01', private.phase10_roles())
      is distinct from false
    or public.store_analysis_with_ai(v_id, v_run, private.phase10_result(), 'model-2026-10-01', private.phase10_roles())
      is distinct from true then
    raise exception 'Graph-and-roles wrapper did not fence and store its run';
  end if;
  if public.write_ai_roles(v_id, gen_random_uuid(), 'model-2026-10-01', private.phase10_roles()) is distinct from false then
    raise exception 'AI roles accepted a stale run';
  end if;
  v_before := private.phase10_snapshot(v_id);
  if public.store_analysis_with_ai(v_id, v_run, '{}'::jsonb, 'model-2026-10-01', private.phase10_roles()) is distinct from false
    or private.phase10_snapshot(v_id) is distinct from v_before then
    raise exception 'Completed graph accepted another wrapped write';
  end if;
  if (select count(*) from public.file_roles where organization_id = 'org_phase10_a' and analysis_id = v_id) <> 1 then
    raise exception 'AI roles changed structural adapter metadata';
  end if;
  if not public.write_ai_roles(v_id, v_run, 'model-2026-10-02', '[]') then
    raise exception 'A second model could not store its independent role result';
  end if;
  if not public.store_analysis_with_ai(current_setting('cartograph.phase10_neighbor_id')::uuid,
      current_setting('cartograph.phase10_neighbor_run')::uuid, private.phase10_result(), null, '[]')
    or not public.store_analysis_with_ai(current_setting('cartograph.phase10_other_id')::uuid,
      current_setting('cartograph.phase10_other_run')::uuid, private.phase10_result(), 'model-2026-10-01', private.phase10_roles()) then
    raise exception 'Neighbor or no-model graph could not be stored';
  end if;
  foreach v_key in array array['ai_cache', 'ai_run_roles'] loop
    begin
      execute format('insert into public.%I select * from public.%I where false', v_key, v_key);
      raise exception 'Service role bypassed the AI write RPC for %', v_key;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

-- Invalid labels cannot change the existing annotation or any parsed fact.
do $$
declare
  v_id uuid := current_setting('cartograph.phase10_id')::uuid;
  v_run uuid := current_setting('cartograph.phase10_run')::uuid;
  v_roles jsonb := private.phase10_roles();
  v_bad jsonb;
  v_role text;
  v_file text;
  v_model text;
begin
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01', null);
  for v_bad in select value from jsonb_array_elements('[null,{},"roles",1,true,[null],[{}],[[]],["util"]]'::jsonb) loop
    perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01', v_bad);
  end loop;
  foreach v_model in array array[null, '', '   '] loop
    perform private.phase10_reject_roles(v_id, v_run, v_model, v_roles);
  end loop;
  foreach v_role in array array['page', 'route', 'controller', 'api', 'layout', 'action', 'module', 'entity', 'middleware', 'unknown'] loop
    perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01', jsonb_set(v_roles, '{0,role}', to_jsonb(v_role)));
  end loop;
  foreach v_file in array array['adapter.ts', 'helper.test.ts', 'tests/helper.ts', 'types.d.ts',
      'runtime-tests/helper.ts', 'helper.spec.custom'] loop
    perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01', jsonb_set(v_roles, '{0,file}', to_jsonb(v_file)));
  end loop;
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01',
    jsonb_set(v_roles, '{0,file}', '"missing.ts"'), '23503');
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01', v_roles || jsonb_build_array(v_roles -> 0));
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01',
    jsonb_set(v_roles, '{0,contentHash}', to_jsonb(repeat('b', 64))));
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01',
    jsonb_set(v_roles, '{0,contentHash}', '"bad-hash"'));
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01',
    jsonb_set(v_roles, '{0}', (v_roles -> 0) - 'contentHash'));
  perform private.phase10_reject_roles(v_id, v_run, 'model-2026-10-01',
    jsonb_set(v_roles, '{0}', (v_roles -> 0) || '{"extra":true}'));
end;
$$;
reset role;

-- The cache's application query filters only its key; organization comes from RLS.
set local role authenticated;
do $$
declare
  v_id uuid := current_setting('cartograph.phase10_id')::uuid;
  v_run uuid := current_setting('cartograph.phase10_run')::uuid;
  v_graph jsonb;
  v_rerun record;
  v_claim jsonb;
  v_table text;
  v_statement text;
begin
  for v_claim in select value from jsonb_array_elements('[
    {"role":"authenticated","sub":"user_phase10","o":{"id":"org_phase10_a"}},
    {"role":"authenticated","sub":"user_phase10","org_id":"org_phase10_a"},
    {"role":"authenticated","sub":"user_phase10","o":{"id":"org_phase10_a"},"org_id":"org_phase10_b"}
  ]'::jsonb) loop
    perform set_config('request.jwt.claims', v_claim::text, true);
    if (select result from public.ai_cache where cache_key = repeat('a', 64))
        is distinct from '{"document":{"blocks":[]}}'::jsonb
      or public.read_ai_roles(v_id, v_run, 'model-2026-10-01') is distinct from private.phase10_roles()
      or public.read_ai_roles(v_id, v_run, 'model-2026-10-02') is distinct from '[]'::jsonb
      or public.read_ai_roles(v_id, v_run, 'missing-model') is not null
      or public.read_ai_roles(v_id, gen_random_uuid(), 'model-2026-10-01') is not null
      or public.read_ai_roles(gen_random_uuid(), v_run, 'model-2026-10-01') is not null
      or public.read_ai_roles(current_setting('cartograph.phase10_neighbor_id')::uuid,
        current_setting('cartograph.phase10_neighbor_run')::uuid, 'model-2026-10-01') is not null then
      raise exception 'Own-organization cache or run/model-scoped role read failed';
    end if;
    if exists (select 1 from public.ai_cache where organization_id <> 'org_phase10_a')
      or exists (select 1 from public.ai_run_roles where organization_id <> 'org_phase10_a') then
      raise exception 'Direct table reads leaked AI data across organizations';
    end if;
  end loop;
  v_graph := public.read_analysis_result_v3(v_id, v_run);
  if v_graph ?| array['aiRoles', 'model', 'explanations']
    or v_graph -> 'fileRoles' is distinct from '[{"file":"adapter.ts","role":"controller"}]'::jsonb
    or (select count(*) from jsonb_object_keys(public.read_analysis_result(v_id, v_run))) <> 5 then
    raise exception 'AI metadata expanded a legacy graph contract';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10","o":{"id":"org_phase10_b"}}', true);
  if (select result from public.ai_cache where cache_key = repeat('a', 64)) is distinct from '{"neighbor":true}'::jsonb
    or public.read_ai_roles(v_id, v_run, 'model-2026-10-01') is not null
    or exists (select 1 from public.ai_run_roles where analysis_id = v_id) then
    raise exception 'AI cache keys or roles leaked between organizations';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10"}', true);
  if exists (select 1 from public.ai_cache) or exists (select 1 from public.ai_run_roles)
    or public.read_ai_roles(v_id, v_run, 'model-2026-10-01') is not null then
    raise exception 'AI rows are visible without an organization claim';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10","org_id":"org_phase10_a"}', true);
  foreach v_table in array array['ai_cache', 'ai_run_roles'] loop
    foreach v_statement in array array[
      format('insert into public.%I select * from public.%I where false', v_table, v_table),
      format('update public.%I set organization_id = organization_id where false', v_table),
      format('delete from public.%I where false', v_table)
    ] loop
      begin
        execute v_statement;
        raise exception 'Authenticated direct AI write was permitted: %', v_statement;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;
  begin
    perform public.write_ai_cache('org_phase10_a', repeat('d', 64), 'model-2026-10-01', 'file', '{"ok":true}');
    raise exception 'Authenticated user called AI cache writer';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.write_ai_roles(v_id, v_run, 'model-2026-10-01', '[]');
    raise exception 'Authenticated user called AI role writer';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.store_analysis_with_ai(v_id, v_run, '{}', null, '[]');
    raise exception 'Authenticated user called graph-and-roles writer';
  exception when insufficient_privilege then null;
  end;
  select * into v_rerun from public.rerun_analysis(v_id);
  if not v_rerun.started then raise exception 'AI fixture could not be rerun'; end if;
  perform set_config('cartograph.phase10_old_run', v_run::text, true);
  perform set_config('cartograph.phase10_run', v_rerun.run_id::text, true);
  if public.read_ai_roles(v_id, v_run, 'model-2026-10-01') is not null
    or public.read_ai_roles(v_id, v_rerun.run_id, 'model-2026-10-01') is not null then
    raise exception 'A rerun exposed old AI roles';
  end if;
end;
$$;
reset role;

-- A label failure rolls back the graph replacement and its completed outbox row.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase10_id')::uuid;
  v_run uuid := current_setting('cartograph.phase10_run')::uuid;
  v_before jsonb := private.phase10_snapshot(v_id);
  v_model text;
  v_bad jsonb;
begin
  for v_bad in select value from jsonb_array_elements('[null,[{}]]'::jsonb) loop
    begin
      perform public.store_analysis_with_ai(v_id, v_run, private.phase10_result(), null, v_bad);
      raise exception 'No-model wrapper accepted nonempty or null roles';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  foreach v_model in array array['', 'model-2026-10-01'] loop
    begin
      perform public.store_analysis_with_ai(v_id, v_run, private.phase10_result(), v_model,
        jsonb_set(private.phase10_roles(), '{6,role}', '"controller"'));
      raise exception 'Invalid AI roles completed a graph replacement';
    exception when invalid_parameter_value then null;
    end;
    if private.phase10_snapshot(v_id) is distinct from v_before then
      raise exception 'Rejected graph-and-roles write changed persisted rows';
    end if;
  end loop;
end;
$$;
reset role;
do $$
begin
  if exists (select 1 from realtime.messages where topic = 'analysis:' || current_setting('cartograph.phase10_id') || ':progress'
      and payload ->> 'runId' = current_setting('cartograph.phase10_run') and payload ->> 'status' = 'completed') then
    raise exception 'Rejected graph-and-roles write left a completed progress message';
  end if;
end;
$$;

-- The legacy writer still works, and replacing its files never removes cache.
set local role service_role;
do $$
declare
  v_id uuid := current_setting('cartograph.phase10_id')::uuid;
  v_run uuid := current_setting('cartograph.phase10_run')::uuid;
begin
  if public.write_ai_roles(v_id, current_setting('cartograph.phase10_old_run')::uuid,
      'model-2026-10-01', private.phase10_roles()) is distinct from false
    or not public.store_analysis(v_id, v_run, private.phase10_result()) then
    raise exception 'Rerun fencing or legacy graph replacement failed';
  end if;
  if (select count(*) from public.ai_cache where organization_id = 'org_phase10_a') <> 3
    or not exists (select 1 from public.ai_run_roles where organization_id = 'org_phase10_a'
      and analysis_id = v_id and run_id = current_setting('cartograph.phase10_old_run')::uuid) then
    raise exception 'Replacing parsed files deleted independent cache or historical annotations';
  end if;
  if not public.write_ai_roles(v_id, v_run, 'model-2026-10-01', private.phase10_roles()) then
    raise exception 'Completed legacy writer could not receive AI roles';
  end if;
end;
$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"user_phase10","org_id":"org_phase10_a"}', true);
do $$
begin
  if public.read_ai_roles(current_setting('cartograph.phase10_id')::uuid,
      current_setting('cartograph.phase10_run')::uuid, 'model-2026-10-01') is distinct from private.phase10_roles()
    or public.read_ai_roles(current_setting('cartograph.phase10_id')::uuid,
      current_setting('cartograph.phase10_old_run')::uuid, 'model-2026-10-01') is not null then
    raise exception 'Completed rerun did not replace role visibility with its current run';
  end if;
end;
$$;
reset role;

-- Cross-organization analysis references and missing orgs fail even for the owner.
do $$
begin
  begin
    insert into public.ai_run_roles (organization_id, analysis_id, run_id, model, roles)
    values ('org_phase10_a', current_setting('cartograph.phase10_other_id')::uuid,
      gen_random_uuid(), 'model-2026-10-01', '[]');
    raise exception 'AI roles accepted an analysis in another organization';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.ai_run_roles (organization_id, analysis_id, run_id, model, roles)
    values ('org_phase10_a', gen_random_uuid(), gen_random_uuid(), 'model-2026-10-01', '[]');
    raise exception 'AI roles accepted a missing analysis';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.ai_cache (organization_id, cache_key, model, operation, result)
    values ('org_phase10_missing', repeat('a', 64), 'model-2026-10-01', 'file', '{"ok":true}');
    raise exception 'AI cache has no organization foreign key';
  exception when foreign_key_violation then null;
  end;
end;
$$;

set local role anon;
do $$
declare v_table text;
begin
  foreach v_table in array array['ai_cache', 'ai_run_roles'] loop
    begin
      execute format('select count(*) from public.%I', v_table);
      raise exception 'Anonymous user read AI table %', v_table;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.read_ai_roles(gen_random_uuid(), gen_random_uuid(), 'model-2026-10-01');
    raise exception 'Anonymous user called AI role reader';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.write_ai_cache('org_phase10_a', repeat('d', 64), 'model-2026-10-01', 'file', '{"ok":true}');
    raise exception 'Anonymous user called AI cache writer';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.write_ai_roles(gen_random_uuid(), gen_random_uuid(), 'model-2026-10-01', '[]');
    raise exception 'Anonymous user called AI role writer';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.store_analysis_with_ai(gen_random_uuid(), gen_random_uuid(), '{}', null, '[]');
    raise exception 'Anonymous user called graph-and-roles writer';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- Analysis deletion removes its annotations; only organization deletion removes
-- content-addressed cache. A neighboring organization must survive both.
delete from public.analyses where organization_id = 'org_phase10_a'
  and id = current_setting('cartograph.phase10_id')::uuid;
do $$
begin
  if exists (select 1 from public.ai_run_roles where organization_id = 'org_phase10_a'
      and analysis_id = current_setting('cartograph.phase10_id')::uuid)
    or (select count(*) from public.ai_cache where organization_id = 'org_phase10_a') <> 3 then
    raise exception 'Analysis cascade deleted cache or retained run roles';
  end if;
end;
$$;
select public.sync_organization('org_phase10_b', true);
do $$
begin
  if exists (select 1 from public.ai_cache where organization_id = 'org_phase10_b')
    or exists (select 1 from public.ai_run_roles where organization_id = 'org_phase10_b')
    or (select count(*) from public.ai_cache where organization_id = 'org_phase10_a') <> 3 then
    raise exception 'Organization cascade retained AI data or deleted a neighbor';
  end if;
end;
$$;

rollback;
select 'Phase 10 database checks passed; fixtures rolled back.' as result;
