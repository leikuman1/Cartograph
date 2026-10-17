-- Evaluate each JWT accessor once per statement, matching Supabase's init-plan
-- guidance while keeping the same current-organization authorization rule.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'analyses', 'files', 'edges',
    'routes', 'explanations', 'file_roles', 'insights'
  ] loop
    execute format(
      'alter policy organization_read on public.%I using (
        organization_id = coalesce(
          nullif((select auth.jwt()) #>> ''{o,id}'', ''''),
          nullif((select auth.jwt()) ->> ''org_id'', '''')
        )
      )', table_name
    );
  end loop;
end;
$$;
