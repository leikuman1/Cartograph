-- Legacy graphs have no framework evidence or recoverable route declaration
-- lines. Keep that absence explicit; do not assign invented source locations.
alter table public.analyses
  add column framework text not null default 'generic'
    check (framework in ('nextjs', 'nestjs', 'react', 'generic'));
alter table public.routes
  add column source_line integer check (source_line > 0);

-- Validate and replace framework metadata inside the same locked transaction as
-- the graph. Only a wholly absent metadata block is a legacy phase 7 payload.
create or replace function public.store_analysis(p_analysis_id uuid, p_run_id uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id text;
  v_framework text := 'generic';
  v_roles jsonb := '[]'::jsonb;
  v_routes jsonb := '[]'::jsonb;
  v_allowed_roles text[];
  v_file jsonb;
  v_edge jsonb;
  v_role jsonb;
  v_route jsonb;
  v_file_id uuid;
  v_line_count integer;
  v_source_id uuid;
  v_target_id uuid;
begin
  select analyses.organization_id into v_organization_id
  from public.analyses
  where analyses.id = p_analysis_id and analyses.run_id = p_run_id and analyses.status = 'running'
  for update;
  if v_organization_id is null then
    return false;
  end if;
  if p_result is null
    or jsonb_typeof(p_result) is distinct from 'object'
    or p_result -> 'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_result -> 'files') is distinct from 'array'
    or jsonb_typeof(p_result -> 'edges') is distinct from 'array'
    or jsonb_typeof(p_result -> 'imports') is distinct from 'array'
    or jsonb_typeof(p_result -> 'coverage') is distinct from 'object' then
    raise exception 'Analysis result does not match schema version 1' using errcode = '22023';
  end if;

  if p_result ?| array['framework', 'fileRoles', 'routes'] then
    if not (p_result ?& array['framework', 'fileRoles', 'routes'])
      or jsonb_typeof(p_result -> 'framework') is distinct from 'string'
      or p_result ->> 'framework' not in ('nextjs', 'nestjs', 'react', 'generic')
      or jsonb_typeof(p_result -> 'fileRoles') is distinct from 'array'
      or jsonb_typeof(p_result -> 'routes') is distinct from 'array' then
      raise exception 'Framework metadata must contain a supported framework, fileRoles and routes' using errcode = '22023';
    end if;
    v_framework := p_result ->> 'framework';
    v_roles := p_result -> 'fileRoles';
    v_routes := p_result -> 'routes';
  end if;

  v_allowed_roles := case v_framework
    when 'nextjs' then array['page', 'api', 'action', 'layout', 'component', 'hook']
    when 'nestjs' then array['controller', 'service', 'module', 'entity']
    when 'react' then array['component', 'hook']
    else array[]::text[]
  end;
  if v_framework = 'generic' and (jsonb_array_length(v_roles) <> 0 or jsonb_array_length(v_routes) <> 0)
    or v_framework = 'react' and jsonb_array_length(v_routes) <> 0 then
    raise exception 'This framework has no supported route or role metadata' using errcode = '22023';
  end if;

  for v_role in select value from jsonb_array_elements(v_roles) loop
    if jsonb_typeof(v_role) is distinct from 'object'
      or jsonb_typeof(v_role -> 'file') is distinct from 'string'
      or nullif(btrim(v_role ->> 'file'), '') is null
      or jsonb_typeof(v_role -> 'role') is distinct from 'string'
      or not (v_role ->> 'role' = any(v_allowed_roles))
      or v_role - array['file', 'role'] <> '{}'::jsonb then
      raise exception 'Invalid framework file role' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(v_roles) entry
    group by entry ->> 'file' having count(*) > 1
  ) then
    raise exception 'Duplicate framework file role' using errcode = '22023';
  end if;

  for v_route in select value from jsonb_array_elements(v_routes) loop
    if jsonb_typeof(v_route) is distinct from 'object'
      or jsonb_typeof(v_route -> 'file') is distinct from 'string'
      or nullif(btrim(v_route ->> 'file'), '') is null
      or jsonb_typeof(v_route -> 'method') is distinct from 'string'
      or v_route ->> 'method' not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE')
      or jsonb_typeof(v_route -> 'path') is distinct from 'string'
      or left(v_route ->> 'path', 1) <> '/'
      or (v_route ->> 'path') collate "C" ~ '[[:cntrl:]]'
      or jsonb_typeof(v_route -> 'line') is distinct from 'number'
      or v_route - array['file', 'method', 'path', 'line'] <> '{}'::jsonb then
      raise exception 'Invalid framework route' using errcode = '22023';
    end if;
    if (v_route ->> 'line')::numeric < 1
      or (v_route ->> 'line')::numeric > 2147483647
      or trunc((v_route ->> 'line')::numeric) <> (v_route ->> 'line')::numeric then
      raise exception 'Route source line must be a positive integer' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(v_routes) entry
    group by entry ->> 'file', entry ->> 'method', entry ->> 'path' having count(*) > 1
  ) then
    raise exception 'Duplicate framework route' using errcode = '22023';
  end if;

  delete from public.edges
  where edges.organization_id = v_organization_id and edges.analysis_id = p_analysis_id;
  delete from public.routes
  where routes.organization_id = v_organization_id and routes.analysis_id = p_analysis_id;
  delete from public.file_roles
  where file_roles.organization_id = v_organization_id and file_roles.analysis_id = p_analysis_id;
  delete from public.explanations
  where explanations.organization_id = v_organization_id and explanations.analysis_id = p_analysis_id;
  delete from public.insights
  where insights.organization_id = v_organization_id and insights.analysis_id = p_analysis_id;
  delete from public.files
  where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id;

  for v_file in select value from jsonb_array_elements(p_result -> 'files') loop
    insert into public.files (
      organization_id, analysis_id, path, folder, module, line_count, content_hash, fan_in, fan_out
    ) values (
      v_organization_id, p_analysis_id, v_file ->> 'path', v_file ->> 'folder',
      v_file ->> 'module', (v_file ->> 'lineCount')::integer,
      v_file ->> 'contentHash', (v_file ->> 'fanIn')::integer,
      (v_file ->> 'fanOut')::integer
    );
  end loop;

  for v_edge in select value from jsonb_array_elements(p_result -> 'edges') loop
    select files.id into v_source_id from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = v_edge ->> 'source';
    select files.id into v_target_id from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = v_edge ->> 'target';
    if v_source_id is null or v_target_id is null then
      raise exception 'Stored edge has a missing endpoint' using errcode = '23503';
    end if;
    insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id, kinds)
    values (
      v_organization_id, p_analysis_id, v_source_id, v_target_id,
      array(select jsonb_array_elements_text(v_edge -> 'kinds'))
    );
  end loop;

  for v_role in select value from jsonb_array_elements(v_roles) loop
    select files.id into v_file_id from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = v_role ->> 'file';
    if v_file_id is null then
      raise exception 'Stored file role has a missing file' using errcode = '23503';
    end if;
    insert into public.file_roles (organization_id, analysis_id, file_id, role)
    values (v_organization_id, p_analysis_id, v_file_id, v_role ->> 'role');
  end loop;

  for v_route in select value from jsonb_array_elements(v_routes) loop
    select files.id, files.line_count into v_file_id, v_line_count from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = v_route ->> 'file';
    if v_file_id is null then
      raise exception 'Stored route has a missing file' using errcode = '23503';
    end if;
    if (v_route ->> 'line')::numeric > v_line_count then
      raise exception 'Route source line exceeds its parsed file' using errcode = '22023';
    end if;
    insert into public.routes (organization_id, analysis_id, file_id, method, path, source_line)
    values (
      v_organization_id, p_analysis_id, v_file_id, v_route ->> 'method',
      v_route ->> 'path', (v_route ->> 'line')::numeric::integer
    );
  end loop;

  update public.analyses
  set status = 'completed', stage = 'store', stage_message = 'Stored the dependency map',
      updated_at = now(), completed_at = now(), failed_stage = null, error_message = null,
      coverage = p_result -> 'coverage', import_records = p_result -> 'imports',
      schema_version = 1, framework = v_framework
  where analyses.id = p_analysis_id;
  return true;
end;
$$;
revoke all on function public.store_analysis(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.store_analysis(uuid, uuid, jsonb) to service_role;

-- One SQL statement keeps graph and metadata in the same run/RLS snapshot.
-- Unsupported legacy roles and routes with unknown lines are absent on reads.
create or replace function public.read_analysis_result(p_analysis_id uuid, p_run_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', a.schema_version,
    'framework', a.framework,
    'fileRoles', coalesce((
      select jsonb_agg(jsonb_build_object('file', f.path, 'role', r.role)
        order by f.path collate "C", r.role collate "C")
      from public.file_roles r
      join public.files f on f.organization_id = r.organization_id
        and f.analysis_id = r.analysis_id and f.id = r.file_id
      where r.organization_id = a.organization_id and r.analysis_id = a.id
        and r.role = any(case a.framework
          when 'nextjs' then array['page', 'api', 'action', 'layout', 'component', 'hook']
          when 'nestjs' then array['controller', 'service', 'module', 'entity']
          when 'react' then array['component', 'hook']
          else array[]::text[]
        end)
    ), '[]'::jsonb),
    'routes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file', f.path, 'method', r.method, 'path', r.path, 'line', r.source_line
      ) order by f.path collate "C", r.method collate "C", r.path collate "C")
      from public.routes r
      join public.files f on f.organization_id = r.organization_id
        and f.analysis_id = r.analysis_id and f.id = r.file_id
      where r.organization_id = a.organization_id and r.analysis_id = a.id
        and a.framework in ('nextjs', 'nestjs') and r.source_line is not null
    ), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'path', f.path,
        'folder', f.folder,
        'module', f.module,
        'lineCount', f.line_count,
        'contentHash', f.content_hash,
        'fanIn', f.fan_in,
        'fanOut', f.fan_out
      ) order by f.path collate "C")
      from public.files f
      where f.organization_id = a.organization_id and f.analysis_id = a.id
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source', source.path,
        'target', target.path,
        'kinds', e.kinds
      ) order by source.path collate "C", target.path collate "C")
      from public.edges e
      join public.files source on source.organization_id = e.organization_id
        and source.analysis_id = e.analysis_id and source.id = e.source_file_id
      join public.files target on target.organization_id = e.organization_id
        and target.analysis_id = e.analysis_id and target.id = e.target_file_id
      where e.organization_id = a.organization_id and e.analysis_id = a.id
    ), '[]'::jsonb),
    'imports', a.import_records,
    'coverage', a.coverage
  )
  from public.analyses a
  where a.id = p_analysis_id and a.run_id = p_run_id
    and a.status = 'completed' and a.schema_version = 1;
$$;
revoke all on function public.read_analysis_result(uuid, uuid) from public, anon, authenticated;
grant execute on function public.read_analysis_result(uuid, uuid) to authenticated;
