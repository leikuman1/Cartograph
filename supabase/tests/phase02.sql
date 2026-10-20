-- Run as the migration owner with pnpm db:verify.
-- All fixtures, the policy-free probe table, and cascading deletes roll back.
begin;

do $$
declare
  table_name text;
  table_oid oid;
begin
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    table_oid := to_regclass(format('public.%I', table_name));
    if table_oid is null or not (
      select relrowsecurity from pg_class where oid = table_oid
    ) then
      raise exception 'RLS is missing on %', table_name;
    end if;
    if not exists (
      select 1 from pg_constraint
      where conrelid = table_oid and contype = 'f'
        and confrelid = 'private.organizations'::regclass and confdeltype = 'c'
    ) then
      raise exception 'Direct organization cascade FK is missing on %', table_name;
    end if;
    if not has_table_privilege('authenticated', table_oid, 'SELECT')
      or has_table_privilege('authenticated', table_oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      or has_table_privilege('anon', table_oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'Unexpected API privileges on %', table_name;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.sync_organization(text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.sync_organization(text,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.sync_organization(text,boolean)', 'EXECUTE') then
    raise exception 'Organization RPC privileges are incorrect';
  end if;
end;
$$;

select public.sync_organization('org_phase02_fixture_a', false);
select public.sync_organization('org_phase02_fixture_a', false);
select public.sync_organization('org_phase02_fixture_b', false);

-- Registration derives identity from the token, with no caller-supplied ID.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_phase02","o":{"id":"org_phase02_registered"}}', true);
select public.ensure_organization();
select public.ensure_organization();
select set_config('request.jwt.claims', '{"sub":"user_phase02"}', true);
do $$
begin
  begin
    perform public.ensure_organization();
    raise exception 'Registration without an organization was permitted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.list_organization_ids('');
    raise exception 'Authenticated user listed the private organization registry';
  exception when insufficient_privilege then null;
  end;
end;
$$;
select set_config('request.jwt.claims', '{"o":{"id":"org_phase02_no_user"}}', true);
do $$
begin
  begin
    perform public.ensure_organization();
    raise exception 'Registration without a user was permitted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from private.organizations where id = 'org_phase02_registered') <> 1
    or exists (select 1 from private.organizations where id = 'org_phase02_no_user') then
    raise exception 'Organization registration was not constrained and idempotent';
  end if;
end;
$$;

insert into public.projects (id, organization_id, name, repository_url, canonical_repository_url) values
  ('10000000-0000-4000-8000-000000000001', 'org_phase02_fixture_a', 'RLS fixture A', 'https://github.com/fixture/a', 'https://github.com/fixture/a'),
  ('10000000-0000-4000-8000-000000000002', 'org_phase02_fixture_b', 'RLS fixture B', 'https://github.com/fixture/b', 'https://github.com/fixture/b'),
  -- Phase 7 allows one analysis per project, so the second analysis in
  -- organization A needs its own project to keep the visibility counts below.
  ('10000000-0000-4000-8000-000000000003', 'org_phase02_fixture_a', 'RLS fixture A second', 'https://github.com/fixture/a2', 'https://github.com/fixture/a2');

insert into public.analyses (id, organization_id, project_id, status, is_seed) values
  ('20000000-0000-4000-8000-000000000001', 'org_phase02_fixture_a', '10000000-0000-4000-8000-000000000001', 'completed', true),
  ('20000000-0000-4000-8000-000000000002', 'org_phase02_fixture_b', '10000000-0000-4000-8000-000000000002', 'queued', true),
  ('20000000-0000-4000-8000-000000000003', 'org_phase02_fixture_a', '10000000-0000-4000-8000-000000000003', 'running', true);

insert into public.files (id, organization_id, analysis_id, path) values
  ('30000000-0000-4000-8000-000000000001', 'org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', 'fixture-a.ts'),
  ('30000000-0000-4000-8000-000000000002', 'org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', 'fixture-b.ts'),
  ('30000000-0000-4000-8000-000000000003', 'org_phase02_fixture_a', '20000000-0000-4000-8000-000000000003', 'fixture-a-second-analysis.ts');

-- A real self-import is representable; an edge must not impose a no-self rule.
insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id) values
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
  ('org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002');

insert into public.routes (organization_id, analysis_id, file_id, method, path) values
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'GET', '/fixture-a'),
  ('org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'GET', '/fixture-b'),
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'GET', '/fixture-a-second');

insert into public.explanations (organization_id, analysis_id, file_id, content) values
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Test fixture A, not a parsed result.'),
  ('org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Test fixture B, not a parsed result.'),
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'Test fixture A second, not a parsed result.');

insert into public.file_roles (organization_id, analysis_id, file_id, role) values
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'fixture'),
  ('org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'fixture'),
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'fixture');

insert into public.insights (organization_id, analysis_id, content) values
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000001', 'Test fixture A, not an analysis insight.'),
  ('org_phase02_fixture_b', '20000000-0000-4000-8000-000000000002', 'Test fixture B, not an analysis insight.'),
  ('org_phase02_fixture_a', '20000000-0000-4000-8000-000000000003', 'Test fixture A second, not an analysis insight.');

-- Test both Clerk claim versions using the same unfiltered queries on all tables.
set local role authenticated;
do $$
declare
  claim jsonb;
  table_name text;
  visible_count bigint;
  unexpected_count bigint;
  expected_count bigint;
  organization text;
begin
  for claim in select value from jsonb_array_elements('[
    {"role":"authenticated","sub":"user_phase02","o":{"id":"org_phase02_fixture_a"}},
    {"role":"authenticated","sub":"user_phase02","org_id":"org_phase02_fixture_b"},
    {"role":"authenticated","sub":"user_phase02"}
  ]'::jsonb) loop
    perform set_config('request.jwt.claims', claim::text, true);
    organization := coalesce(claim #>> '{o,id}', claim ->> 'org_id');
    foreach table_name in array array[
      'projects', 'analyses', 'files', 'edges',
      'routes', 'explanations', 'file_roles', 'insights'
    ] loop
      execute format('select count(*) from public.%I', table_name) into visible_count;
      expected_count := case
        when organization is null then 0
        when organization = 'org_phase02_fixture_a'
          and table_name in ('projects', 'analyses', 'files', 'routes', 'explanations', 'file_roles', 'insights') then 2
        else 1
      end;
      if visible_count <> expected_count then
        raise exception 'Unexpected visibility on % for %: expected %, got %',
          table_name, coalesce(organization, 'no organization'), expected_count, visible_count;
      end if;
      execute format(
        'select count(*) from public.%I where organization_id is distinct from $1', table_name
      ) into unexpected_count using organization;
      if unexpected_count <> 0 then
        raise exception 'Cross-organization rows leaked from %', table_name;
      end if;
    end loop;
  end loop;
end;
$$;

-- Read-only means writes are denied even if the statement would affect no rows.
select set_config('request.jwt.claims', '{"role":"authenticated","o":{"id":"org_phase02_fixture_a"}}', true);
do $$
declare
  table_name text;
  statement text;
begin
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    foreach statement in array array[
      format('insert into public.%I select * from public.%I where false', table_name, table_name),
      format('update public.%I set organization_id = organization_id where false', table_name),
      format('delete from public.%I where false', table_name)
    ] loop
      begin
        execute statement;
        raise exception 'Authenticated write was permitted: %', statement;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;

  begin
    perform public.sync_organization('org_phase02_fixture_a', true);
    raise exception 'Authenticated user invoked the organization RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from private.organizations;
    raise exception 'Authenticated user read the private organization registry';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    begin
      execute format('select count(*) from public.%I', table_name);
      raise exception 'Anonymous reads were permitted on %', table_name;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.sync_organization('org_phase02_fixture_a', true);
    raise exception 'Anonymous user invoked the organization RPC';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- Run FK checks as the migration owner, so privilege/RLS errors cannot mask a
-- missing tenant or analysis constraint in a future privileged write path.
do $$
declare
  foreign_analysis uuid := '20000000-0000-4000-8000-000000000002';
  foreign_file uuid;
  table_name text;
  statement text;
begin
  -- Use a foreign project without an analysis so uniqueness cannot mask its FK.
  insert into public.projects (id, organization_id, name, repository_url, canonical_repository_url)
  values ('10000000-0000-4000-8000-000000000004', 'org_phase02_fixture_b',
    'Foreign project probe', 'https://github.com/fixture/foreign', 'https://github.com/fixture/foreign');
  begin
    insert into public.analyses (organization_id, project_id)
    values ('org_phase02_fixture_a', '10000000-0000-4000-8000-000000000004');
    raise exception 'Cross-organization project reference was permitted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.analyses (organization_id, project_id)
    values ('org_phase02_fixture_a', '10000000-0000-4000-8000-000000000001');
    raise exception 'A second analysis for one project was permitted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.files (organization_id, analysis_id, path)
    values ('org_phase02_fixture_a', foreign_analysis, 'invalid.ts');
    raise exception 'Cross-organization analysis reference was permitted for files';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.insights (organization_id, analysis_id, content)
    values ('org_phase02_fixture_a', foreign_analysis, 'invalid');
    raise exception 'Cross-organization analysis reference was permitted for insights';
  exception when foreign_key_violation then null;
  end;

  foreach foreign_file in array array[
    '30000000-0000-4000-8000-000000000002'::uuid,
    '30000000-0000-4000-8000-000000000003'::uuid
  ] loop
    foreach statement in array array[
      format('insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id)
        values (''org_phase02_fixture_a'', ''20000000-0000-4000-8000-000000000001'', %L, ''30000000-0000-4000-8000-000000000001'')', foreign_file),
      format('insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id)
        values (''org_phase02_fixture_a'', ''20000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000001'', %L)', foreign_file),
      format('insert into public.routes (organization_id, analysis_id, file_id, method, path)
        values (''org_phase02_fixture_a'', ''20000000-0000-4000-8000-000000000001'', %L, ''GET'', ''/invalid'')', foreign_file),
      format('insert into public.explanations (organization_id, analysis_id, file_id, content)
        values (''org_phase02_fixture_a'', ''20000000-0000-4000-8000-000000000001'', %L, ''invalid'')', foreign_file),
      format('insert into public.file_roles (organization_id, analysis_id, file_id, role)
        values (''org_phase02_fixture_a'', ''20000000-0000-4000-8000-000000000001'', %L, ''invalid'')', foreign_file)
    ] loop
      begin
        execute statement;
        raise exception 'Cross-organization or cross-analysis file reference was permitted: %', statement;
      exception when foreign_key_violation then null;
      end;
    end loop;
  end loop;
end;
$$;

-- A future public table, with SELECT explicitly granted but no policy, is hidden.
create table public.phase02_rls_probe (secret text not null);
insert into public.phase02_rls_probe values ('must never be visible');
grant select on public.phase02_rls_probe to authenticated;
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.phase02_rls_probe'::regclass)
    or exists (select 1 from pg_policy where polrelid = 'public.phase02_rls_probe'::regclass) then
    raise exception 'New table does not have policy-free RLS enabled by default';
  end if;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","o":{"id":"org_phase02_fixture_a"}}', true);
do $$
begin
  if exists (select 1 from public.phase02_rls_probe) then
    raise exception 'A table without a policy exposed rows';
  end if;
end;
$$;
reset role;

-- The administrative script can synchronize IDs and trigger cascading deletion.
set local role service_role;
select public.sync_organization('org_phase02_fixture_service', false);
select public.sync_organization('org_phase02_fixture_b', true);
select public.sync_organization('org_phase02_fixture_b', true);
reset role;
do $$
declare
  table_name text;
  row_count bigint;
begin
  if not exists (select 1 from private.organizations where id = 'org_phase02_fixture_service')
    or exists (select 1 from private.organizations where id = 'org_phase02_fixture_b') then
    raise exception 'Service role organization synchronization failed';
  end if;
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    execute format('select count(*) from public.%I where organization_id = $1', table_name)
      into row_count using 'org_phase02_fixture_b';
    if row_count <> 0 then
      raise exception 'Organization deletion left orphan rows in %', table_name;
    end if;
    execute format('select count(*) from public.%I where organization_id = $1', table_name)
      into row_count using 'org_phase02_fixture_a';
    if row_count = 0 then
      raise exception 'Organization deletion removed another organization from %', table_name;
    end if;
  end loop;
end;
$$;

rollback;
select 'Phase 2 database checks passed; fixtures rolled back.' as result;
