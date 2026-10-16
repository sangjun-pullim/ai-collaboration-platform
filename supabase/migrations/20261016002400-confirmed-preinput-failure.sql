-- Additive evidence for child-free validation failures. Legacy UNKNOWN rows are untouched.
create table workflow_private.preinput_failures (
  attempt_id uuid primary key references workflow_private.attempts(id) on delete cascade,
  request_id uuid not null references workflow_private.requests(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  device_id uuid not null references device_binding_private.devices(id) on delete cascade,
  agent_id uuid not null references device_binding_private.agents(id) on delete cascade,
  binding_epoch bigint not null,
  fence bigint not null,
  proof_hash text not null check (proof_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check (reason in ('SNAPSHOT_CHANGED','POLICY_REJECTED','LOCAL_VALIDATION_FAILED')),
  receipt jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on workflow_private.preinput_failures from public, anon, authenticated;

create function public.workflow_device_fail_before_input(p_body jsonb, p_secret text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  d device_binding_private.devices;
  ag device_binding_private.agents;
  rq workflow_private.requests;
  at workflow_private.attempts;
  cy workflow_private.cycles;
  rm workflow_private.rooms;
  prev workflow_private.receipts;
  op uuid;
  ph text;
  k text;
  ad text;
  result jsonb;
begin
  if not coalesce(runtime_settings_private.keys(p_body,array['protocol','operationId','agentId','bindingEpoch','requestId','attemptId','fence','proofVersion','proofHash','reason']),false)
    or p_body->'protocol' is distinct from '1'::jsonb or p_body->'proofVersion' is distinct from '1'::jsonb then
    perform runtime_settings_private.fail('INVALID_BODY');
  end if;
  if octet_length(p_body::text)>16384 then perform runtime_settings_private.fail('BODY_TOO_LARGE');end if;
  foreach k in array array['operationId','agentId','requestId','attemptId'] loop
    if jsonb_typeof(p_body->k)<>'string' or not coalesce(runtime_settings_private.id_ok(p_body->>k),false) then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  end loop;
  foreach k in array array['bindingEpoch','fence'] loop
    if jsonb_typeof(p_body->k)<>'number' or (p_body->>k) !~ '^\d+$' then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
    if (p_body->>k)::numeric<1 or (p_body->>k)::numeric>9007199254740991 then
      perform runtime_settings_private.fail('INVALID_BODY');
    end if;
  end loop;
  if jsonb_typeof(p_body->'proofHash')<>'string' or (p_body->>'proofHash') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_body->'reason')<>'string'
    or p_body->>'reason' not in ('SNAPSHOT_CHANGED','POLICY_REJECTED','LOCAL_VALIDATION_FAILED') then
    perform runtime_settings_private.fail('INVALID_BODY');
  end if;
  d:=runtime_settings_private.live_device(p_secret);
  select * into ag from device_binding_private.agents where id=(p_body->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;
  if ag.id is null or ag.binding_epoch<>(p_body->>'bindingEpoch')::bigint or not workflow_private.binding_live(ag.id,ag.binding_epoch,d.room_id) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  perform workflow_private.reconcile(d.room_id);
  select * into rm from workflow_private.rooms where room_id=d.room_id;
  select * into rq from workflow_private.requests where id=(p_body->>'requestId')::uuid and device_id=d.id and agent_id=ag.id and binding_epoch=ag.binding_epoch and room_id=d.room_id;
  if rq.id is null then perform runtime_settings_private.fail('FORBIDDEN');end if;
  select * into at from workflow_private.attempts where id=(p_body->>'attemptId')::uuid and request_id=rq.id and fence=(p_body->>'fence')::bigint and fence=rq.fence;
  if at.id is null then perform runtime_settings_private.fail('CONFLICT');end if;
  op:=(p_body->>'operationId')::uuid;
  ph:=encode(extensions.digest(p_body::text,'sha256'),'hex');
  select * into prev from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=op;
  if found then
    if prev.action<>'fail-before-input' or prev.payload_hash<>ph then perform runtime_settings_private.fail('CONFLICT');end if;
    return prev.result;
  end if;
  if at.state not in ('EXECUTING','UNKNOWN') or at.start_intent_at is null
    or exists(select 1 from workflow_private.preinput_failures where attempt_id=at.id) then
    perform runtime_settings_private.fail('CONFLICT');
  end if;
  select * into cy from workflow_private.cycles where id=rq.cycle_id;
  ad:=case when at.state='EXECUTING' and cy.state='ACTIVE' and rq.generation=cy.generation
    and rq.revision=rm.revision and workflow_private.cycle_scope_live(cy)
    and cy.deadline>clock_timestamp() and rq.deadline>clock_timestamp()
    then 'HUMAN_INPUT_REQUIRED' else 'HISTORICAL' end;
  update workflow_private.attempts set state='FAILED',terminal_text='',adoption=ad where id=at.id;
  perform workflow_private.state(rq.id,'FAILED');
  if rq.kind='PEER' then
    update workflow_private.questions set adoption='HISTORICAL' where id=rq.question_id;
  end if;
  perform workflow_private.human_required(cy.id);
  update workflow_private.readiness set reported_ready=false,valid_until=null where agent_id=ag.id and binding_epoch=ag.binding_epoch;
  perform workflow_private.reconcile(d.room_id);
  select adoption into ad from workflow_private.attempts where id=at.id;
  result:=jsonb_build_object('requestId',rq.id,'attemptId',at.id,'fence',at.fence,
    'bindingEpoch',ag.binding_epoch,'state','FAILED','kind','PREINPUT_REJECTED',
    'proofHash',p_body->>'proofHash','adoption',ad);
  insert into workflow_private.preinput_failures(attempt_id,request_id,room_id,device_id,agent_id,binding_epoch,fence,proof_hash,reason,receipt)
    values(at.id,rq.id,d.room_id,d.id,ag.id,ag.binding_epoch,at.fence,p_body->>'proofHash',p_body->>'reason',result);
  insert into workflow_private.receipts values(d.room_id,'device',d.id,op,'fail-before-input',ph,result);
  return result;
end;
$$;
revoke all on function public.workflow_device_fail_before_input(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_fail_before_input(jsonb,text) to anon;

create function public.connection_execution_status(p_room_id uuid,p_device_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  u uuid;
  d device_binding_private.devices;
  ag device_binding_private.agents;
  failure jsonb;
begin
  perform device_binding_private.guard();
  u:=room_access_private.actor();
  select * into d from device_binding_private.devices where id=p_device_id and room_id=p_room_id;
  if d.id is null then perform runtime_settings_private.fail('FORBIDDEN');end if;
  perform device_binding_private.lock_scope(d.organization_id,d.room_id);
  u:=room_access_private.actor();
  select * into d from device_binding_private.devices where id=p_device_id and room_id=p_room_id;
  if d.id is null or d.owner_user_id<>u or not device_binding_private.live(u,d.organization_id,d.room_id) then
    perform runtime_settings_private.fail('FORBIDDEN');
  end if;
  perform workflow_private.lock_room(d.room_id);
  select a.* into ag from device_binding_private.agents a
    join device_binding_private.workspaces w on w.id=a.workspace_id and w.state='active'
    where a.device_id=d.id and a.room_id=d.room_id and a.state='active';
  if ag.id is null then return null;end if;
  if not exists(select 1 from workflow_private.readiness r where r.agent_id=ag.id
    and r.binding_epoch=ag.binding_epoch and r.reported_ready and r.valid_until>clock_timestamp()) then
    select jsonb_build_object('requestId',p.request_id,'reason',p.reason) into failure
      from workflow_private.preinput_failures p where p.device_id=d.id and p.room_id=d.room_id
      and p.agent_id=ag.id and p.binding_epoch=ag.binding_epoch order by p.created_at desc,p.attempt_id desc limit 1;
  end if;
  return jsonb_build_object('agentId',ag.id,'bindingEpoch',ag.binding_epoch,'failure',failure);
end;
$$;
revoke all on function public.connection_execution_status(uuid,uuid) from public,anon,authenticated;
grant execute on function public.connection_execution_status(uuid,uuid) to authenticated;

-- A historical interruption request is not a remaining settings reservation once the
-- exact attempt has a proved input-free failure. Preserve the original control record.
create or replace function runtime_settings_private.idle(d uuid) returns boolean
language sql stable security definer set search_path='' as $$
 with related as (
 select c.id from workflow_private.cycles c where c.origin_agent_id in (select id from device_binding_private.agents where device_id=d)
 or c.peer_agent_id in (select id from device_binding_private.agents where device_id=d)
 or exists(select 1 from workflow_private.requests q where q.cycle_id=c.id and q.device_id=d)
 )
 select not exists(select 1 from workflow_private.cycles c join related r on r.id=c.id where c.retired_at is null and (c.state='ACTIVE' or (c.mode='AI_PAIR' and c.state='HUMAN_INPUT_REQUIRED' and c.deadline>clock_timestamp() and c.runs_reserved<11 and c.peer_rounds_reserved<5)))
 and not exists(select 1 from workflow_private.requests q join related r on r.id=q.cycle_id where q.state in ('QUEUED','LEASED','RUNNING','UNKNOWN'))
 and not exists(select 1 from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id join related r on r.id=q.cycle_id where a.state in ('LEASED','EXECUTING','UNKNOWN') or (a.adoption='PENDING' and a.state in ('COMPLETED','FAILED','INTERRUPTED')))
 and not exists(select 1 from workflow_private.controls ctl join workflow_private.requests q on q.id=ctl.request_id join related r on r.id=q.cycle_id
   where ctl.state='REQUESTED' and not exists(select 1 from workflow_private.preinput_failures p
     join workflow_private.attempts a on a.id=p.attempt_id and a.state='FAILED'
     where p.attempt_id=ctl.attempt_id and p.request_id=ctl.request_id and p.fence=ctl.fence))
 and not exists(select 1 from workflow_private.questions q join related r on r.id=q.cycle_id where q.adoption='PENDING');
$$;
