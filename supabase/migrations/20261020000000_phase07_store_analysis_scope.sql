-- Keep graph replacement and endpoint lookups on the organization-leading
-- compound indexes. The local name must not collide with table columns.
create or replace function public.store_analysis(p_analysis_id uuid, p_run_id uuid, p_result jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id text;
  file_entry jsonb;
  edge_entry jsonb;
  file_id uuid;
  source_id uuid;
  target_id uuid;
  inserted_files integer := 0;
  inserted_edges integer := 0;
begin
  select analyses.organization_id into v_organization_id
  from public.analyses
  where analyses.id = p_analysis_id and analyses.run_id = p_run_id and analyses.status = 'running'
  for update;
  if v_organization_id is null then
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

  delete from public.edges
  where edges.organization_id = v_organization_id and edges.analysis_id = p_analysis_id;
  delete from public.files
  where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id;
  delete from public.routes
  where routes.organization_id = v_organization_id and routes.analysis_id = p_analysis_id;
  delete from public.file_roles
  where file_roles.organization_id = v_organization_id and file_roles.analysis_id = p_analysis_id;
  delete from public.explanations
  where explanations.organization_id = v_organization_id and explanations.analysis_id = p_analysis_id;
  delete from public.insights
  where insights.organization_id = v_organization_id and insights.analysis_id = p_analysis_id;

  for file_entry in select value from jsonb_array_elements(p_result -> 'files') loop
    insert into public.files (
      organization_id, analysis_id, path, folder, module, line_count, content_hash, fan_in, fan_out
    ) values (
      v_organization_id, p_analysis_id, file_entry ->> 'path', file_entry ->> 'folder',
      file_entry ->> 'module', (file_entry ->> 'lineCount')::integer,
      file_entry ->> 'contentHash', (file_entry ->> 'fanIn')::integer,
      (file_entry ->> 'fanOut')::integer
    );
    inserted_files := inserted_files + 1;
  end loop;

  for edge_entry in select value from jsonb_array_elements(p_result -> 'edges') loop
    select files.id into source_id from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = edge_entry ->> 'source';
    select files.id into target_id from public.files
    where files.organization_id = v_organization_id and files.analysis_id = p_analysis_id
      and files.path = edge_entry ->> 'target';
    if source_id is null or target_id is null then
      raise exception 'Stored edge has a missing endpoint' using errcode = '23503';
    end if;
    insert into public.edges (organization_id, analysis_id, source_file_id, target_file_id, kinds)
    values (
      v_organization_id, p_analysis_id, source_id, target_id,
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
