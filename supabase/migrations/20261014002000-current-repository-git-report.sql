begin;

-- Current repository observations are separate from immutable registration metadata.
create table runtime_settings_private.git_reports (
  agent_id uuid primary key references device_binding_private.agents(id) on delete cascade,
  workspace_id uuid not null references device_binding_private.workspaces(id) on delete cascade,
  binding_epoch bigint not null check(binding_epoch between 1 and 9007199254740991),
  config_revision bigint not null check(config_revision between 1 and 9007199254740991),
  branch text not null,
  commit_hash text not null check(
    commit_hash = 'unknown' or commit_hash ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  observed_at timestamptz not null,
  received_at timestamptz not null
);
alter table runtime_settings_private.git_reports enable row level security;
revoke all on table runtime_settings_private.git_reports from public, anon, authenticated;

create function public.connector_git_report(p_body jsonb, p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d device_binding_private.devices;
  a device_binding_private.agents;
  previous runtime_settings_private.git_reports;
  observed timestamptz;
  revision bigint;
  k text;
  t timestamptz;
begin
  if not runtime_settings_private.keys(p_body, array[
    'agentId', 'workspaceId', 'bindingEpoch', 'configRevision', 'branch', 'commit', 'observedAt'
  ]) then
    perform runtime_settings_private.fail('INVALID_BODY');
  end if;
  foreach k in array array['agentId', 'workspaceId'] loop
    if jsonb_typeof(p_body->k) <> 'string'
      or not runtime_settings_private.id_ok(p_body->>k) then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  end loop;
  foreach k in array array['bindingEpoch', 'configRevision'] loop
    if jsonb_typeof(p_body->k) <> 'number' or p_body->>k !~ '^[1-9][0-9]{0,15}$' then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
    if (p_body->>k)::numeric > 9007199254740991 then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  end loop;
  if jsonb_typeof(p_body->'branch') <> 'string'
    or jsonb_typeof(p_body->'commit') <> 'string'
    or not coalesce(device_binding_private.metadata_ok(jsonb_build_object(
      'repositoryAlias', 'Git', 'branch', p_body->'branch', 'commit', 'unknown', 'dirty', 'unknown'
    )), false)
    or (p_body->>'commit' <> 'unknown' and p_body->>'commit' !~ '^([a-f0-9]{40}|[a-f0-9]{64})$')
    or jsonb_typeof(p_body->'observedAt') <> 'string'
    or p_body->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    perform runtime_settings_private.fail('INVALID_BODY');
  end if;
  begin
    observed := (p_body->>'observedAt')::timestamptz;
    if to_char(observed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_body->>'observedAt' then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  exception when invalid_datetime_format or datetime_field_overflow then
    perform runtime_settings_private.fail('INVALID_BODY');
  end;

  -- This acquires the same scope and room locks as settings changes.
  d := runtime_settings_private.live_device(p_secret);
  if not exists (
    select 1 from device_binding_private.credentials c
    where c.hash = d.current_hash and c.device_id = d.id
      and c.owner_user_id = d.owner_user_id
      and c.organization_id = d.organization_id and c.room_id = d.room_id
  ) then
    perform runtime_settings_private.fail('UNAUTHENTICATED');
  end if;
  select * into a from device_binding_private.agents
  where id = (p_body->>'agentId')::uuid
    and workspace_id = (p_body->>'workspaceId')::uuid
    and device_id = d.id and owner_user_id = d.owner_user_id
    and organization_id = d.organization_id and room_id = d.room_id and state = 'active'
  for update;
  if a.id is null or not exists (
    select 1 from device_binding_private.workspaces w
    where w.id = a.workspace_id and w.device_id = d.id and w.owner_user_id = d.owner_user_id
      and w.organization_id = d.organization_id and w.room_id = d.room_id and w.state = 'active'
  ) then
    perform runtime_settings_private.fail('NOT_FOUND');
  end if;
  select c.revision into revision from runtime_settings_private.configurations c
  where c.device_id = d.id
    and c.applied->>'agentId' = a.id::text
    and c.applied->>'workspaceId' = a.workspace_id::text
    and c.applied->'bindingEpoch' = to_jsonb(a.binding_epoch)
    and c.applied->'configRevision' = to_jsonb(c.revision);
  if a.binding_epoch <> (p_body->>'bindingEpoch')::bigint
    or revision is distinct from (p_body->>'configRevision')::bigint
    or exists (
      select 1 from runtime_settings_private.operations o where o.device_id = d.id
        and (o.state not in ('APPLIED', 'CANCELLED') or (o.state = 'CANCELLED' and o.applied_receipt is null))
    ) then
    perform runtime_settings_private.fail('CONFLICT');
  end if;
  t := clock_timestamp();
  if observed < t - interval '5 minutes' or observed > t + interval '1 minute' then
    perform runtime_settings_private.fail('CONFLICT');
  end if;
  select * into previous from runtime_settings_private.git_reports where agent_id = a.id for update;
  if previous.agent_id is not null and previous.binding_epoch = a.binding_epoch then
    if observed < previous.observed_at then
      perform runtime_settings_private.fail('CONFLICT');
    end if;
    if observed = previous.observed_at then
      if previous.workspace_id <> a.workspace_id or previous.config_revision <> revision
        or previous.branch <> p_body->>'branch' or previous.commit_hash <> p_body->>'commit' then
        perform runtime_settings_private.fail('CONFLICT');
      end if;
      return jsonb_build_object('protocol', 1, 'reported', true);
    end if;
  end if;
  insert into runtime_settings_private.git_reports(
    agent_id, workspace_id, binding_epoch, config_revision, branch, commit_hash, observed_at, received_at
  ) values (
    a.id, a.workspace_id, a.binding_epoch, revision, p_body->>'branch', p_body->>'commit', observed, t
  ) on conflict(agent_id) do update set
    workspace_id = excluded.workspace_id,
    binding_epoch = excluded.binding_epoch,
    config_revision = excluded.config_revision,
    branch = excluded.branch,
    commit_hash = excluded.commit_hash,
    observed_at = excluded.observed_at,
    received_at = excluded.received_at;
  return jsonb_build_object('protocol', 1, 'reported', true);
end;$$;

create function public.connection_room_git_bindings(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  bindings jsonb;
  result jsonb;
  queried timestamptz;
begin
  -- Reuse the authenticated participant check and original public projection.
  bindings := public.connection_room_bindings(p_room_id);
  perform workflow_private.lock_room(p_room_id);
  queried := clock_timestamp();
  select coalesce(jsonb_agg(
    b.value || jsonb_build_object('gitReport', case when g.agent_id is null then null else
      jsonb_build_object(
        'branch', g.branch, 'commit', g.commit_hash,
        'observedAt', to_char(g.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'receivedAt', to_char(g.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) end
    ) order by b.ordinality
  ), '[]'::jsonb) into result
  from jsonb_array_elements(bindings) with ordinality b(value, ordinality)
  left join device_binding_private.agents a on a.id = (b.value->>'agentId')::uuid
  left join runtime_settings_private.configurations c on c.device_id = a.device_id
    and c.applied->>'agentId' = a.id::text
    and c.applied->>'workspaceId' = a.workspace_id::text
    and c.applied->'bindingEpoch' = to_jsonb(a.binding_epoch)
    and c.applied->'configRevision' = to_jsonb(c.revision)
  left join runtime_settings_private.git_reports g on g.agent_id = a.id
    and g.workspace_id = a.workspace_id and g.binding_epoch = a.binding_epoch
    and g.config_revision = c.revision;
  return jsonb_build_object(
    'bindings', result,
    'queriedAt', to_char(queried at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;$$;

revoke all on function public.connector_git_report(jsonb,text), public.connection_room_git_bindings(uuid)
  from public, anon, authenticated;
grant execute on function public.connector_git_report(jsonb,text) to anon;
grant execute on function public.connection_room_git_bindings(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
