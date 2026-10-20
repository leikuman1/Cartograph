-- A sample row that has been rerun is no longer sample data: it now belongs to
-- a real run, even if that run fails. Clearing the label when the rerun starts
-- keeps "Sample data" from sitting beside a real stored graph later.
-- store_analysis only ever runs for rows that start_analysis created or
-- rerun_analysis reset, so this is the only place the label must be cleared.

create or replace function public.rerun_analysis(p_analysis_id uuid)
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
      commit_sha = null, coverage = null, import_records = null, schema_version = null,
      is_seed = false
  where analyses.id = v_analysis.id;
  return query select v_analysis.id, v_run, true;
end;
$$;
revoke all on function public.rerun_analysis(uuid) from public, anon, authenticated;
grant execute on function public.rerun_analysis(uuid) to authenticated;
