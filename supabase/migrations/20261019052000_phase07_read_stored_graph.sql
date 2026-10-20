-- Return one consistent graph snapshot. PostgREST's row limit would truncate
-- files/edges fetched as lists; separate requests could also span two reruns.
-- SECURITY INVOKER keeps all row visibility under the existing RLS policies.
create function public.read_analysis_result(p_analysis_id uuid, p_run_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'schemaVersion', a.schema_version,
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
