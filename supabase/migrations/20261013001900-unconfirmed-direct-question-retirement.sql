begin;

-- Retirement is a conversation decision, never a runtime terminal.
create table workflow_private.direct_retirements (
 request_id uuid primary key references workflow_private.requests(id) on delete cascade,
 room_id uuid not null references workflow_private.rooms(room_id) on delete cascade,
 cycle_id uuid not null references workflow_private.cycles(id) on delete cascade,
 attempt_id uuid not null,
 fence bigint not null check(fence between 1 and 9007199254740991),
 device_id uuid not null,
 agent_id uuid not null,
 binding_epoch bigint not null check(binding_epoch between 1 and 9007199254740991),
 owner_id uuid not null,
 retired_by uuid not null,
 retirement_sequence bigint not null check(retirement_sequence between 1 and 9007199254740991),
 room_revision bigint not null check(room_revision between 1 and 9007199254740991),
 retired_at timestamptz not null default clock_timestamp(),
 foreign key(request_id,attempt_id) references workflow_private.attempts(request_id,id) on delete cascade,
 unique(room_id,retirement_sequence),
 check(owner_id=retired_by)
);
alter table workflow_private.direct_retirements enable row level security;
revoke all on workflow_private.direct_retirements from public,anon,authenticated;

create function workflow_private.request_retired(q uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from workflow_private.direct_retirements t
  join workflow_private.requests x on x.id=t.request_id
  join workflow_private.cycles c on c.id=x.cycle_id
  join workflow_private.attempts a on a.request_id=x.id and a.id=t.attempt_id
  where t.request_id=q and c.mode='DIRECT' and c.retired_at is not null
   and x.room_id=t.room_id and x.cycle_id=t.cycle_id and x.kind='PEER'
   and x.device_id=t.device_id and x.agent_id=t.agent_id and x.binding_epoch=t.binding_epoch
   and x.owner_id=t.owner_id and a.fence=t.fence and a.start_intent_at is not null
   and x.state='UNKNOWN' and a.state='UNKNOWN'
   and not exists(select 1 from workflow_private.attempts other
    where other.request_id=x.id and other.id<>t.attempt_id and other.state in ('LEASED','EXECUTING','UNKNOWN'))
 );
$$;

create function workflow_private.has_blocking_runs(r uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from workflow_private.requests x where x.room_id=r
  and x.state in ('QUEUED','LEASED','RUNNING','UNKNOWN') and not workflow_private.request_retired(x.id))
 or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id
  where x.room_id=r and a.state in ('LEASED','EXECUTING','UNKNOWN') and not workflow_private.request_retired(x.id));
$$;

create function workflow_private.retirement_candidate(r uuid,u uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('requestId',x.id,'cycleId',c.id,'attemptId',a.id,'fence',a.fence,
  'agentId',x.agent_id,'bindingEpoch',x.binding_epoch,'roomRevision',rm.revision,
  'deviceRevoked',coalesce(d.state='revoked' and d.owner_user_id=x.owner_id
    and d.room_id=x.room_id and d.organization_id=pr.organization_id,false),
  'canRetire',coalesce(d.state='revoked' and d.owner_user_id=x.owner_id
    and d.room_id=x.room_id and d.organization_id=pr.organization_id,false))
 from workflow_private.rooms rm join public.rooms pr on pr.id=rm.room_id
 join workflow_private.cycles c on c.room_id=rm.room_id and c.retired_at is null
 join workflow_private.requests x on x.cycle_id=c.id and x.room_id=rm.room_id
 join workflow_private.questions q on q.id=x.question_id and q.cycle_id=c.id and q.source='HUMAN'
 join workflow_private.attempts a on a.request_id=x.id and a.state='UNKNOWN'
 left join device_binding_private.devices d on d.id=x.device_id
 where rm.room_id=r and c.mode='DIRECT' and x.kind='PEER'
  and x.agent_id=c.peer_agent_id and x.binding_epoch=c.peer_epoch
  and x.owner_id=u and x.state='UNKNOWN' and a.start_intent_at is not null
  and least(x.deadline,c.deadline)<=clock_timestamp()
  and device_binding_private.live(u,pr.organization_id,r,true)
 order by a.fence desc limit 1;
$$;

create function workflow_private.validate_retirement(action text,b jsonb) returns void
language plpgsql set search_path='' as $$
declare ks text[]; k text; v text;
begin
 if action='read-recovery' then
  ks:=array['protocol','roomId','afterSequence','afterRetirementSequence'];
 elsif action='retire' then
  ks:=array['protocol','roomId','operationId','expectedUserId','expectedRoomRevision','requestId',
   'cycleId','attemptId','fence','agentId','bindingEpoch','confirmed'];
 else raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 if b is null or jsonb_typeof(b)<>'object' then
  raise exception using message='INVALID_BODY',errcode='P0001';end if;
 if octet_length(b::text)>16384 then raise exception using message='BODY_TOO_LARGE',errcode='P0001';end if;
 if not b ?& ks or (select count(*) from jsonb_object_keys(b))<>cardinality(ks)
  or b->'protocol' is distinct from '1'::jsonb then
  raise exception using message='INVALID_BODY',errcode='P0001';end if;
 foreach k in array ks loop
  v:=b->>k;
  if v is null then raise exception using message='INVALID_BODY',errcode='P0001';end if;
  if k like '%Id' and (jsonb_typeof(b->k)<>'string'
   or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
   raise exception using message='INVALID_BODY',errcode='P0001';end if;
  if k in ('afterSequence','afterRetirementSequence','expectedRoomRevision','fence','bindingEpoch') then
   if jsonb_typeof(b->k)<>'number' or v !~ '^\d+$' then
    raise exception using message='INVALID_BODY',errcode='P0001';end if;
   if v::numeric>9007199254740991 or v::numeric<(case when k in ('afterSequence','afterRetirementSequence') then 0 else 1 end) then
    raise exception using message='INVALID_BODY',errcode='P0001';end if;
  end if;
 end loop;
 if action='retire' and b->'confirmed' is distinct from 'true'::jsonb then
  raise exception using message='INVALID_BODY',errcode='P0001';end if;
end;
$$;

create function workflow_private.retire_direct(b jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); r uuid; o uuid; rm workflow_private.rooms;
 rq workflow_private.requests; cy workflow_private.cycles; candidate jsonb;
 op uuid; ph text; prev workflow_private.receipts; saved workflow_private.direct_retirements;
 result jsonb; seq bigint;
begin
 perform workflow_private.validate_retirement('retire',b);
 perform device_binding_private.guard();
 if u is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 if u<>(b->>'expectedUserId')::uuid then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 r:=(b->>'roomId')::uuid;
 select organization_id into o from public.rooms where id=r;
 if o is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 perform device_binding_private.lock_scope(o,r);
 if not device_binding_private.live(u,o,r,true) then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 perform workflow_private.lock_room(r);
 select * into rq from workflow_private.requests where id=(b->>'requestId')::uuid and room_id=r;
 select * into cy from workflow_private.cycles where id=rq.cycle_id;
 if rq.id is null or cy.id is null or cy.mode<>'DIRECT' or rq.kind<>'PEER' or rq.owner_id<>u
  then
  raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if cy.id<>(b->>'cycleId')::uuid or rq.agent_id<>(b->>'agentId')::uuid
  or rq.binding_epoch<>(b->>'bindingEpoch')::bigint then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 op:=(b->>'operationId')::uuid;ph:=encode(extensions.digest(b::text,'sha256'),'hex');
 select * into prev from workflow_private.receipts
  where room_id=r and actor_kind='human' and actor_id=u and operation_id=op;
 if found then
  if prev.action<>'retire' or prev.payload_hash<>ph then raise exception using message='CONFLICT',errcode='P0001';end if;
  return prev.result;
 end if;
 perform workflow_private.reconcile(r);
 select * into rm from workflow_private.rooms where room_id=r;
 if rm.revision<>(b->>'expectedRoomRevision')::bigint then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 candidate:=workflow_private.retirement_candidate(r,u);
 if candidate is null or candidate->>'requestId'<>rq.id::text
  or (candidate->>'attemptId')::uuid<>(b->>'attemptId')::uuid or (candidate->>'fence')::bigint<>(b->>'fence')::bigint
  or candidate->'canRetire'<>'true'::jsonb then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 select coalesce(max(retirement_sequence),0)+1 into seq from workflow_private.direct_retirements where room_id=r;
 if seq>9007199254740991 or rm.revision>=9007199254740991 then
  raise exception using message='CONFLICT',errcode='P0001';end if;
 insert into workflow_private.direct_retirements(request_id,room_id,cycle_id,attempt_id,fence,
  device_id,agent_id,binding_epoch,owner_id,retired_by,retirement_sequence,room_revision)
 values(rq.id,r,cy.id,(b->>'attemptId')::uuid,(b->>'fence')::bigint,
  rq.device_id,rq.agent_id,rq.binding_epoch,rq.owner_id,u,seq,rm.revision+1) returning * into saved;
 update workflow_private.cycles set retired_at=saved.retired_at where id=cy.id;
 update workflow_private.rooms set revision=revision+1 where room_id=r;
 result:=jsonb_build_object('state','RETIRED_UNCONFIRMED','sequence',seq,'requestId',rq.id,
  'cycleId',cy.id,'attemptId',saved.attempt_id,'fence',saved.fence,'agentId',rq.agent_id,
  'bindingEpoch',rq.binding_epoch,'retiredAt',saved.retired_at,'roomRevision',saved.room_revision);
 insert into workflow_private.receipts values(r,'human',u,op,'retire',ph,result);
 perform workflow_private.reconcile(r);
 return result;
end;
$$;

create function public.workflow_human_read_recovery(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare page jsonb; r uuid; cursor bigint; highwater bigint; nextcursor bigint; records jsonb;
begin
 perform workflow_private.validate_retirement('read-recovery',p_body);
 -- The original read retains current Auth/admission and scope/room locks.
 page:=workflow_private.human('read',p_body-'afterRetirementSequence');
 r:=(p_body->>'roomId')::uuid;cursor:=(p_body->>'afterRetirementSequence')::bigint;
 select coalesce(max(retirement_sequence),0) into highwater from workflow_private.direct_retirements where room_id=r;
 if cursor>highwater then raise exception using message='CONFLICT',errcode='P0001';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sequence',retirement_sequence,'requestId',request_id,
  'cycleId',cycle_id,'agentId',agent_id,'bindingEpoch',binding_epoch,'retiredAt',retired_at)
  order by retirement_sequence),'[]'::jsonb),coalesce(max(retirement_sequence),cursor)
 into records,nextcursor from (select * from workflow_private.direct_retirements
  where room_id=r and retirement_sequence>cursor order by retirement_sequence limit 32)t;
 return page||jsonb_build_object('recovery',jsonb_build_object(
  'hasBlockingRuns',workflow_private.has_blocking_runs(r),'candidate',workflow_private.retirement_candidate(r,auth.uid()),
  'retirements',records,'nextRetirementCursor',nextcursor,'highWaterRetirementSequence',highwater,
  'hasMoreRetirements',nextcursor<highwater));
end;
$$;
create function public.workflow_human_retire(p_body jsonb) returns jsonb
language sql security definer set search_path='' as $$
 select workflow_private.retire_direct(p_body);
$$;

-- Existing workflows share the same retirement predicate.
create or replace function workflow_private.human_006(action text,b jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
r uuid;
o uuid;
rm workflow_private.rooms;
cy workflow_private.cycles;
origin device_binding_private.agents;
peer device_binding_private.agents;
rq workflow_private.requests;
ev public.workflow_events;
op uuid;
ph text;
prev workflow_private.receipts;
result jsonb;
rid uuid;
cid uuid;
alias text;

begin
 perform workflow_private.validate(action,b);
if b ? 'publicText' then b:=b||jsonb_build_object('publicText',workflow_private.text_trim(b->>'publicText'));
end if;
perform device_binding_private.guard();

 if u is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';
end if;

 r:=(b->>'roomId')::uuid;
select organization_id into o from public.rooms where id=r;

 if o is null then raise exception using message='NOT_FOUND',errcode='P0001';
end if;

 perform device_binding_private.lock_scope(o,r);

 if not device_binding_private.live(u,o,r,action<>'read') then raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 perform workflow_private.lock_room(r);
perform workflow_private.reconcile(r);
select * into rm from workflow_private.rooms where room_id=r;

 if action='read' then
 if (b->>'afterSequence')::bigint>rm.sequence then raise exception using message='CONFLICT',errcode='P0001';
end if;

 return workflow_private.history(r,(b->>'afterSequence')::bigint,u);
end if;

 if action in ('start','resume') and (action='start' or b->>'mode'='cycle') then
 select * into origin from device_binding_private.agents where id=(b->>'originAgentId')::uuid and room_id=r;

 select * into peer from device_binding_private.agents where id=(b->>'peerAgentId')::uuid and room_id=r;

 if origin.id is null or peer.id is null or origin.owner_user_id<>u or peer.owner_user_id=u then raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 if not workflow_private.binding_live(origin.id,(b->>'originEpoch')::bigint,r) or not workflow_private.binding_live(peer.id,(b->>'peerEpoch')::bigint,r) then raise exception using message='CONFLICT',errcode='P0001';
end if;

 if action='resume' and not exists(select 1 from workflow_private.cycles where id=(b->>'cycleId')::uuid and room_id=r and origin_owner_id=u) then raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 elsif action='interrupt' then
 if not exists(select 1 from device_binding_private.agents where id=(b->>'agentId')::uuid and owner_user_id=u and room_id=r and binding_epoch=(b->>'bindingEpoch')::bigint and state='active') then raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 end if;

 op:=(b->>'operationId')::uuid;
ph:=encode(extensions.digest(b::text,'sha256'),'hex');
select * into prev from workflow_private.receipts where room_id=r and actor_kind='human' and actor_id=u and operation_id=op;

 if found then if prev.action<>action or prev.payload_hash<>ph then raise exception using message='CONFLICT',errcode='P0001';
end if;
return workflow_private.restore(action,prev.result);
end if;

 if action<>'speak' and (b->>'expectedRoomRevision')::bigint<>rm.revision then raise exception using message='CONFLICT',errcode='P0001';
end if;

 if action='speak' then ev:=workflow_private.event(r,'SPEECH',null,null,b->>'publicText',null,'NONE',u);
result:=jsonb_build_object('eventId',ev.event_id,'sequence',ev.sequence);

 elsif action='start' or action='resume' and b->>'mode'='cycle' then
 if workflow_private.has_blocking_runs(r) then raise exception using message='CONFLICT',errcode='P0001';
end if;

 if not exists(select 1 from workflow_private.readiness where agent_id=origin.id and binding_epoch=origin.binding_epoch and reported_ready and valid_until>clock_timestamp()) or not exists(select 1 from workflow_private.readiness where agent_id=peer.id and binding_epoch=peer.binding_epoch and reported_ready and valid_until>clock_timestamp()) then raise exception using message='CONFLICT',errcode='P0001';
end if;

 select * into cy from workflow_private.cycles where room_id=r and retired_at is null;

 if action='start' then
 if rm.mode<>'ACTIVE' or cy.state='ACTIVE' or exists(select 1 from workflow_private.requests where room_id=r and state='QUEUED' and not workflow_private.request_retired(id)) then raise exception using message='CONFLICT',errcode='P0001';
end if;

 if cy.id is not null then update workflow_private.cycles set retired_at=clock_timestamp() where id=cy.id;
end if;

 insert into workflow_private.cycles(room_id,origin_agent_id,peer_agent_id,origin_owner_id,revision,origin_epoch,peer_epoch) values(r,origin.id,peer.id,u,rm.revision,origin.binding_epoch,peer.binding_epoch) returning * into cy;

 insert into workflow_private.generations values(cy.id,1,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText');

 rid:=workflow_private.reserve(cy.id,origin.id,'ORIGIN',b->>'publicText');
perform workflow_private.event(r,'INVESTIGATION_STARTED',cy.id,null,b->>'publicText',null,'NONE',u);

 result:=jsonb_build_object('cycleId',cy.id,'requestId',rid,'accepted',rid is not null,'roomRevision',rm.revision,'cycleState',(select state from workflow_private.cycles where id=cy.id));

 else
 if cy.id is null or cy.id<>(b->>'cycleId')::uuid or cy.origin_owner_id<>u or cy.origin_agent_id<>origin.id or cy.peer_agent_id<>peer.id or cy.state<>'HUMAN_INPUT_REQUIRED' then raise exception using message='CONFLICT',errcode='P0001';
end if;

 if cy.deadline<=clock_timestamp() or cy.runs_reserved>=11 or cy.peer_rounds_reserved>=5 then
 result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode,'cycleId',cy.id,'requestId',null,'accepted',false,'cycleState',cy.state);

 else
 update workflow_private.rooms set mode='ACTIVE' where room_id=r;
update workflow_private.cycles set generation=generation+1,revision=rm.revision,origin_epoch=origin.binding_epoch,peer_epoch=peer.binding_epoch,state='ACTIVE' where id=cy.id returning * into cy;

 insert into workflow_private.generations values(cy.id,cy.generation,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText');
rid:=workflow_private.reserve(cy.id,origin.id,'RESUME',b->>'publicText');
perform workflow_private.event(r,'INVESTIGATION_RESUMED',cy.id,null,b->>'publicText',null,'NONE',u);

 result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode','ACTIVE','cycleId',cy.id,'requestId',rid,'accepted',rid is not null,'cycleState',(select state from workflow_private.cycles where id=cy.id));
end if;

 end if;

 elsif action='interrupt' then
 select * into rq from workflow_private.requests where room_id=r and agent_id=(b->>'agentId')::uuid and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') and not workflow_private.request_retired(id) order by created_at desc limit 1;

 if rq.id is null then result:=jsonb_build_object('controlId',null,'requestId',null,'state','NO_ACTIVE_RUN');
else perform workflow_private.human_required(rq.cycle_id,rq.agent_id);
if rq.state='QUEUED' then perform workflow_private.state(rq.id,'CANCELLED');
else cid:=workflow_private.control(rq.id);
end if;
result:=jsonb_build_object('controlId',cid,'requestId',rq.id,'state','REQUESTED');
end if;

 elsif action='pause' then
 update workflow_private.rooms set mode='PAUSING',revision=revision+1 where room_id=r;

 perform workflow_private.event(r,'ROOM_PAUSE_REQUESTED',null,null,'',null,'NONE',u);

 for cy in select * from workflow_private.cycles where room_id=r and retired_at is null loop perform workflow_private.human_required(cy.id);
end loop;

 for rq in select * from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') and not workflow_private.request_retired(id) order by id loop if rq.state='QUEUED' then perform workflow_private.state(rq.id,'CANCELLED');
else perform workflow_private.control(rq.id);
end if;
end loop;

 perform workflow_private.reconcile(r);
select * into rm from workflow_private.rooms where room_id=r;
result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode);

 elsif action='resume' and b->>'mode'='room' then
 if rm.mode='ACTIVE' or workflow_private.has_blocking_runs(r) then raise exception using message='CONFLICT',errcode='P0001';
end if;

 update workflow_private.rooms set mode='ACTIVE' where room_id=r;
perform workflow_private.event(r,'ROOM_RESUMED',null,null,'',null,'NONE',u);
result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode','ACTIVE','cycleId',null,'requestId',null,'accepted',true,'cycleState',null);

 else raise exception using message='NOT_FOUND',errcode='P0001';
end if;

 insert into workflow_private.receipts values(r,'human',u,op,action,ph,result);
return result;

end;
$$;


create or replace function workflow_private.human(action text, b jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
 r uuid;
 organization uuid;
 rm workflow_private.rooms;

  cy workflow_private.cycles;
 target device_binding_private.agents;
 rq workflow_private.requests;

  q workflow_private.questions;
 prev workflow_private.receipts;
 op uuid;
 ph text;
 result jsonb;
 rid uuid;
 cid uuid;

begin
  if action not in ('ask','cancel') and not (action = 'resume' and b->>'mode' = 'cycle') then
    return workflow_private.human_006(action, b);

  end if;

  perform workflow_private.validate(action, b);

  if b ? 'publicText' then b := b || jsonb_build_object('publicText', workflow_private.text_trim(b->>'publicText'));
 end if;

  perform device_binding_private.guard();

  if u is null then raise exception using message = 'UNAUTHENTICATED', errcode = 'P0001';
 end if;

  r := (b->>'roomId')::uuid;

  select organization_id into organization from public.rooms where id = r;

  if organization is null then raise exception using message = 'NOT_FOUND', errcode = 'P0001';
 end if;

  perform device_binding_private.lock_scope(organization, r);

  if not device_binding_private.live(u, organization, r, true) then
    raise exception using message = 'FORBIDDEN', errcode = 'P0001';

  end if;

  perform workflow_private.lock_room(r);

  perform workflow_private.reconcile(r);

  select * into rm from workflow_private.rooms where room_id = r;

  if action = 'resume' then
    if exists(select 1 from workflow_private.cycles where id = (b->>'cycleId')::uuid and room_id = r and mode = 'DIRECT') then
      raise exception using message = 'CONFLICT', errcode = 'P0001';

    end if;

    return workflow_private.human_006(action, b);

  end if;

  if action = 'ask' then
    select * into target from device_binding_private.agents where id = (b->>'targetAgentId')::uuid and room_id = r;

    if target.id is null or target.owner_user_id = u then
      raise exception using message = 'FORBIDDEN', errcode = 'P0001';

    end if;

    if not workflow_private.binding_live(target.id, (b->>'targetEpoch')::bigint, r) then
      raise exception using message = 'CONFLICT', errcode = 'P0001';

    end if;

  else
    select * into rq from workflow_private.requests where id = (b->>'requestId')::uuid and room_id = r;

    select * into cy from workflow_private.cycles where id = rq.cycle_id;

    select * into target from device_binding_private.agents where id = rq.agent_id and room_id = r;

    if cy.id is null or cy.mode <> 'DIRECT' or rq.kind <> 'PEER'
      or rq.agent_id <> cy.peer_agent_id or rq.binding_epoch <> cy.peer_epoch
      or (u <> cy.origin_owner_id and u <> rq.owner_id) then
      raise exception using message = 'FORBIDDEN', errcode = 'P0001';

    end if;

  end if;

  op := (b->>'operationId')::uuid;

  ph := encode(extensions.digest(b::text, 'sha256'), 'hex');

  select * into prev from workflow_private.receipts where room_id = r and actor_kind = 'human' and actor_id = u and operation_id = op;

  if found then
    if prev.action <> action or prev.payload_hash <> ph then raise exception using message = 'CONFLICT', errcode = 'P0001';
 end if;

    return workflow_private.restore(action, prev.result);

  end if;

  if action='cancel' and (cy.retired_at is not null or target.id is null
    or target.binding_epoch<>rq.binding_epoch or target.owner_user_id<>rq.owner_id) then
    raise exception using message='CONFLICT',errcode='P0001';

  end if;

  if (b->>'expectedRoomRevision')::bigint <> rm.revision then
    raise exception using message = 'CONFLICT', errcode = 'P0001';

  end if;

  if action = 'ask' then
    if rm.mode <> 'ACTIVE'
      or exists(select 1 from workflow_private.cycles where room_id = r and retired_at is null and state = 'ACTIVE')
      or workflow_private.has_blocking_runs(r)
      or not exists(select 1 from workflow_private.readiness rd where rd.agent_id = target.id
        and rd.device_id = target.device_id and rd.room_id = r and rd.binding_epoch = target.binding_epoch
        and rd.reported_ready and rd.valid_until > clock_timestamp()) then
      raise exception using message = 'CONFLICT', errcode = 'P0001';

    end if;

    update workflow_private.cycles set retired_at = clock_timestamp() where room_id = r and retired_at is null;

    insert into workflow_private.cycles(room_id, mode, origin_agent_id, origin_epoch,
      origin_owner_id, peer_agent_id, peer_epoch, revision)
      values(r, 'DIRECT', null, null, u, target.id, target.binding_epoch, rm.revision) returning * into cy;

    insert into workflow_private.generations(cycle_id, generation, revision, origin_epoch, peer_epoch, public_text)
      values(cy.id, 1, cy.revision, null, cy.peer_epoch, b->>'publicText');

    insert into workflow_private.questions(cycle_id, source, requester_user_id, origin_request_id,
      generation, revision, origin_epoch, peer_epoch, public_text, deadline)
      values(cy.id, 'HUMAN', u, null, 1, cy.revision, null, cy.peer_epoch,
        b->>'publicText', least(cy.deadline, clock_timestamp() + interval '120 seconds')) returning * into q;

    rid := workflow_private.reserve(cy.id, cy.peer_agent_id, 'PEER', q.public_text, q.id);

    if rid is null then raise exception using message = 'CONFLICT', errcode = 'P0001';
 end if;

    perform workflow_private.event(r, 'QUESTION', cy.id, rid, q.public_text, q.id, 'PENDING', u);

    result := jsonb_build_object('cycleId', cy.id, 'requestId', rid, 'accepted', true,
      'roomRevision', rm.revision, 'cycleState', 'ACTIVE');

  else
    if rq.state not in ('QUEUED','LEASED','RUNNING','UNKNOWN') then
      result := jsonb_build_object('controlId', null, 'requestId', null, 'state', 'NO_ACTIVE_RUN');

    else
      -- control() pins the current attempt/fence and never treats its ACK as terminal.
      perform workflow_private.human_required(cy.id, rq.agent_id);

      if rq.state <> 'QUEUED' then cid := workflow_private.control(rq.id);
 end if;

      result := jsonb_build_object('controlId', cid, 'requestId', rq.id, 'state', 'REQUESTED');

    end if;

  end if;

  insert into workflow_private.receipts values(r, 'human', u, op, action, ph, result);

  return result;

end;

$$;


create or replace function workflow_private.reconcile(r uuid) returns void language plpgsql security definer set search_path='' as $$
declare rq workflow_private.requests;

a workflow_private.attempts;

c workflow_private.cycles;

rm text;


begin
 for rq in select * from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') and not workflow_private.request_retired(id) order by id loop
 select * into a from workflow_private.attempts where request_id=rq.id and state in ('LEASED','EXECUTING','UNKNOWN') order by fence desc limit 1;


 if not workflow_private.binding_live(rq.agent_id,rq.binding_epoch,r) then
 if a.id is not null and (a.start_intent_at is not null or a.state='UNKNOWN') then
 update workflow_private.attempts set state='UNKNOWN',adoption='HISTORICAL' where id=a.id;

 if rq.state<>'UNKNOWN' then
 perform workflow_private.state(rq.id,'UNKNOWN');

end if;

perform workflow_private.control(rq.id);


 else
 if a.id is not null then
 update workflow_private.attempts set state='ABANDONED' where id=a.id;

end if;

perform workflow_private.state(rq.id,'CANCELLED');

end if;


 perform workflow_private.human_required(rq.cycle_id);


 elsif a.id is not null and a.lease_expires_at<=clock_timestamp() and a.state in ('LEASED','EXECUTING') then
 if a.start_intent_at is null then
 update workflow_private.attempts set state='ABANDONED' where id=a.id;


 if exists(select 1 from workflow_private.cycles where id=rq.cycle_id and mode='DIRECT') then
 perform workflow_private.state(rq.id,'CANCELLED');

perform workflow_private.human_required(rq.cycle_id);


 else
 perform workflow_private.state(rq.id,'QUEUED');

end if;


 else
 update workflow_private.attempts set state='UNKNOWN' where id=a.id;

perform workflow_private.state(rq.id,'UNKNOWN');

perform workflow_private.human_required(rq.cycle_id);

end if;


 end if;


 end loop;


 for c in select * from workflow_private.cycles where room_id=r and state='ACTIVE' and retired_at is null order by id loop
 if c.deadline<=clock_timestamp() or not workflow_private.cycle_scope_live(c) or c.revision<>(select revision from workflow_private.rooms where room_id=r)
 or exists(select 1 from workflow_private.questions where cycle_id=c.id and adoption='PENDING' and deadline<=clock_timestamp()) then
 perform workflow_private.human_required(c.id);

end if;


 end loop;


 select mode into rm from workflow_private.rooms where room_id=r;


 if rm='PAUSING' and not workflow_private.has_blocking_runs(r) then
 update workflow_private.rooms set mode='PAUSED' where room_id=r;

perform workflow_private.event(r,'ROOM_PAUSED');

end if;


end;

$$;

revoke all on function workflow_private.request_retired(uuid),workflow_private.has_blocking_runs(uuid),
 workflow_private.retirement_candidate(uuid,uuid),workflow_private.validate_retirement(text,jsonb),
 workflow_private.retire_direct(jsonb) from public,anon,authenticated;

revoke all on function public.workflow_human_read_recovery(jsonb),public.workflow_human_retire(jsonb) from public,anon,authenticated;

grant execute on function public.workflow_human_read_recovery(jsonb),public.workflow_human_retire(jsonb) to authenticated;

notify pgrst,'reload schema';

commit;
