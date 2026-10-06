-- Desired input admission is agent-scoped. Existing attempts retain their authority.
create schema own_input_private;

revoke all on schema own_input_private from public,anon,authenticated;

create table own_input_private.states (
  agent_id uuid primary key references device_binding_private.agents(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  paused boolean not null default false,
  applied_revision bigint,
  applied_epoch bigint,
  applied_at timestamptz,
  check (
    (applied_revision is null and applied_epoch is null and applied_at is null)
    or (
      applied_revision is not null
      and applied_epoch is not null
      and applied_revision between 1 and 9007199254740991
      and applied_epoch between 1 and 9007199254740991
      and applied_at is not null
    )
  )
);

revoke all on own_input_private.states from public,anon,authenticated;

create function own_input_private.validate(action text,b jsonb)
returns void
language plpgsql
set search_path=''
as $$
declare
  ks text[];
  k text;
  v text;
begin
  ks:=case action when 'input-state' then array['roomId']
  when 'input-control' then array['roomId','expectedUserId','operationId','agentId','bindingEpoch','expectedRevision','paused']
  when 'admission' then array['agentId','bindingEpoch']
  when 'admission-ack' then array['agentId','bindingEpoch','revision','paused'] end;
  if ks is null or not runtime_settings_private.keys(b,array['protocol']||ks) or b->'protocol'<>'1'::jsonb then
    perform runtime_settings_private.fail('INVALID_BODY');
  end if;
  if octet_length(b::text)>16384 then
    perform runtime_settings_private.fail('BODY_TOO_LARGE');
  end if;
  foreach k in array ks loop
    v:=b->>k;
    if v is null then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
    if k like '%Id' and (jsonb_typeof(b->k)<>'string' or not coalesce(runtime_settings_private.id_ok(v),false)) then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
    if k in ('bindingEpoch','revision','expectedRevision') then
      if jsonb_typeof(b->k)<>'number' or v !~ '^\d+$' then
        perform runtime_settings_private.fail('INVALID_BODY');
      end if;
      if v::numeric<1 or v::numeric>9007199254740991 then
        perform runtime_settings_private.fail('INVALID_BODY');
      end if;
    end if;
    if k='paused' and jsonb_typeof(b->k)<>'boolean' then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  end loop;
end;
$$;

create function own_input_private.projection(a device_binding_private.agents)
returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  s own_input_private.states;
  applied boolean;
begin
  select * into s from own_input_private.states where agent_id=a.id and room_id=a.room_id;
  applied:=coalesce(s.applied_revision=s.revision and s.applied_epoch=a.binding_epoch,false);
  return jsonb_build_object('agentId',a.id,'bindingEpoch',a.binding_epoch,'revision',coalesce(s.revision,1),'paused',coalesce(s.paused,false),
  'appliedRevision',case when applied then s.applied_revision end,'appliedEpoch',case when applied then s.applied_epoch end,'appliedAt',case when applied then s.applied_at end);
end;
$$;

create function own_input_private.human(action text,b jsonb)
returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  u uuid;
  r uuid;
  org uuid;
  a device_binding_private.agents;
  s own_input_private.states;
  prev workflow_private.receipts;
  ph text;
  result jsonb;
begin
  perform device_binding_private.guard();
  perform own_input_private.validate(action,b);
  u:=room_access_private.actor();
  r:=(b->>'roomId')::uuid;
  select organization_id into org from public.rooms where id=r;
  if org is null then
    perform runtime_settings_private.fail('NOT_FOUND');
  end if;
  perform device_binding_private.lock_scope(org,r);
  u:=room_access_private.actor();
  if not device_binding_private.live(u,org,r) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  perform workflow_private.lock_room(r);
  if action='input-state' then
    select coalesce(jsonb_agg(own_input_private.projection(x) order by x.id),'[]'::jsonb) into result
    from device_binding_private.agents x where x.room_id=r and x.owner_user_id=u and workflow_private.binding_live(x.id,x.binding_epoch,r);
    return jsonb_build_object('roomId',r,'bindings',result);
  end if;
  if (b->>'expectedUserId')::uuid<>u then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and room_id=r and owner_user_id=u;
  if a.id is null or not workflow_private.binding_live(a.id,a.binding_epoch,r) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  -- Check current ownership before replay. Old receipts are not current projections.
  ph:=encode(extensions.digest(b::text,'sha256'),'hex');
  select * into prev from workflow_private.receipts where room_id=r and actor_kind='human' and actor_id=u and operation_id=(b->>'operationId')::uuid;
  if found then
    if prev.action<>action or prev.payload_hash<>ph then
      perform runtime_settings_private.fail('CONFLICT');
    end if;
    return prev.result;
  end if;
  if a.binding_epoch<>(b->>'bindingEpoch')::bigint then
    perform runtime_settings_private.fail('CONFLICT');
  end if;
  insert into own_input_private.states(agent_id,room_id) values(a.id,r) on conflict do nothing;
  select * into s from own_input_private.states where agent_id=a.id for update;
  if s.revision<>(b->>'expectedRevision')::bigint then
    perform runtime_settings_private.fail('CONFLICT');
  end if;
  if s.paused<>(b->>'paused')::boolean then
    if s.revision=9007199254740991 then
      perform runtime_settings_private.fail('CONFLICT');
    end if;
    update own_input_private.states set revision=revision+1,paused=(b->>'paused')::boolean,applied_revision=null,applied_epoch=null,applied_at=null where agent_id=a.id;
  end if;
  result:=own_input_private.projection(a);
  insert into workflow_private.receipts values(r,'human',u,(b->>'operationId')::uuid,action,ph,result);
  return result;
end;
$$;

create function own_input_private.device(action text,b jsonb,secret text)
returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  d device_binding_private.devices;
  a device_binding_private.agents;
  s own_input_private.states;
begin
  perform own_input_private.validate(action,b);
  d:=runtime_settings_private.live_device(secret);
  select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;
  if a.id is null or a.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(a.id,a.binding_epoch,d.room_id) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  if action='admission-ack' then
    insert into own_input_private.states(agent_id,room_id) values(a.id,d.room_id) on conflict do nothing;
    select * into s from own_input_private.states where agent_id=a.id for update;
    if s.revision<>(b->>'revision')::bigint or s.paused<>(b->>'paused')::boolean then
      perform runtime_settings_private.fail('CONFLICT');
    end if;
    if s.applied_revision is distinct from s.revision or s.applied_epoch is distinct from a.binding_epoch then
      update own_input_private.states set applied_revision=revision,applied_epoch=a.binding_epoch,applied_at=clock_timestamp() where agent_id=a.id;
    end if;
  end if;
  return own_input_private.projection(a);
end;
$$;

-- Preserve the original restore implementation, including DIRECT/adoption branches.
alter function workflow_private.restore(text,jsonb) rename to restore_011_original;

create function workflow_private.restore(action text,result jsonb)
returns jsonb
language plpgsql security definer
set search_path=''
as $$
begin
  if result ? 'claimDenied' then
    if action='claim' and result='{"claimDenied":"INPUT_PAUSED"}'::jsonb then
      return result;
    end if;
    perform runtime_settings_private.fail('UNAVAILABLE');
  end if;
  return workflow_private.restore_011_original(action,result);
end;
$$;

create function own_input_private.claim(b jsonb,secret text)
returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  d device_binding_private.devices;
  a device_binding_private.agents;
  q workflow_private.requests;
  prev workflow_private.receipts;
  ph text;
  marker jsonb:='{"claimDenied":"INPUT_PAUSED"}'::jsonb;
begin
  perform workflow_private.validate('claim',b);
  d:=runtime_settings_private.live_device(secret);
  select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;
  if a.id is null or a.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(a.id,a.binding_epoch,d.room_id) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  select * into q from workflow_private.requests where id=(b->>'requestId')::uuid and device_id=d.id and agent_id=a.id and binding_epoch=a.binding_epoch and room_id=d.room_id;
  if q.id is null then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  ph:=encode(extensions.digest(b::text,'sha256'),'hex');
  select * into prev from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=(b->>'operationId')::uuid;
  if found then
    if prev.action<>'claim' or prev.payload_hash<>ph then
      perform runtime_settings_private.fail('CONFLICT');
    end if;
    if prev.result ? 'claimDenied' then
      if prev.result<>marker then
        perform runtime_settings_private.fail('UNAVAILABLE');
      end if;
      return marker;
    end if;
    return workflow_private.device('claim',b,secret);
  end if;
  if exists(select 1 from own_input_private.states where agent_id=a.id and room_id=d.room_id and paused) then
    insert into workflow_private.receipts values(d.room_id,'device',d.id,(b->>'operationId')::uuid,'claim',ph,marker);
    return marker;
  end if;
  return workflow_private.device('claim',b,secret);
end;
$$;

create function own_input_private.attempt_guard()
returns trigger
language plpgsql security definer
set search_path=''
as $$
declare
  q workflow_private.requests;
  org uuid;
begin
  select * into q from workflow_private.requests where id=new.request_id;
  select organization_id into org from public.rooms where id=q.room_id;
  perform device_binding_private.lock_scope(org,q.room_id);
  perform workflow_private.lock_room(q.room_id);
  if exists(select 1 from own_input_private.states where agent_id=q.agent_id and room_id=q.room_id and paused) then
    perform runtime_settings_private.fail('INPUT_PAUSED');
  end if;
  return new;
end;
$$;

create trigger own_input_attempt_admission before insert on workflow_private.attempts for each row execute function own_input_private.attempt_guard();

create function public.workflow_human_input_state(p_body jsonb)
returns jsonb
language sql security definer
set search_path=''
as $$
select own_input_private.human('input-state',p_body);
$$;

create function public.workflow_human_input_control(p_body jsonb)
returns jsonb
language sql security definer
set search_path=''
as $$
select own_input_private.human('input-control',p_body);
$$;

create function public.workflow_device_admission(p_body jsonb,p_secret text)
returns jsonb
language sql security definer
set search_path=''
as $$
select own_input_private.device('admission',p_body,p_secret);
$$;

create function public.workflow_device_admission_ack(p_body jsonb,p_secret text)
returns jsonb
language sql security definer
set search_path=''
as $$
select own_input_private.device('admission-ack',p_body,p_secret);
$$;

create or replace function public.workflow_device_claim(p_body jsonb,p_secret text)
returns jsonb
language sql security definer
set search_path=''
as $$
select own_input_private.claim(p_body,p_secret);
$$;

revoke all on all functions in schema own_input_private from public,anon,authenticated;

revoke all on function workflow_private.restore_011_original(text,jsonb),workflow_private.restore(text,jsonb) from public,anon,authenticated;

revoke all on function public.workflow_human_input_state(jsonb),public.workflow_human_input_control(jsonb),public.workflow_device_admission(jsonb,text),public.workflow_device_admission_ack(jsonb,text),public.workflow_device_claim(jsonb,text) from public,anon,authenticated;

grant execute on function public.workflow_human_input_state(jsonb),public.workflow_human_input_control(jsonb) to authenticated;

grant execute on function public.workflow_device_admission(jsonb,text),public.workflow_device_admission_ack(jsonb,text),public.workflow_device_claim(jsonb,text) to anon;
