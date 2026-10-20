begin;

-- Additive observation data: existing deadlines and UNKNOWN rows are not backfilled.
alter table workflow_private.requests
 add column stop_reason text,
 add column stop_observed_at timestamptz,
 add column stop_attempt_id uuid,
 add column stop_fence bigint,
 add constraint workflow_stop_observation check (
  (stop_reason is null and stop_observed_at is null and stop_attempt_id is null and stop_fence is null)
  or (stop_reason in ('RESPONSE_TIMEOUT','EXECUTION_LEASE_EXPIRED','BINDING_CHANGED','CONTEXT_CHANGED')
   and stop_reason is not null and stop_observed_at is not null
   and ((stop_attempt_id is null and stop_fence is null)
    or (stop_attempt_id is not null and stop_fence between 1 and 9007199254740991 and stop_fence is not null)))
 );

create function workflow_private.immutable_stop_observation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.stop_reason is not null and row(new.stop_reason,new.stop_observed_at,new.stop_attempt_id,new.stop_fence)
   is distinct from row(old.stop_reason,old.stop_observed_at,old.stop_attempt_id,old.stop_fence) then
  raise exception using message='CONFLICT',errcode='P0001';
 end if;
 return new;
end;$$;
create trigger workflow_stop_observation_identity before update on workflow_private.requests
 for each row execute function workflow_private.immutable_stop_observation();

create function workflow_private.observe_stop(q uuid,a workflow_private.attempts,reason text,observed timestamptz) returns void
language sql security definer set search_path='' as $$
 update workflow_private.requests set stop_reason=reason,stop_observed_at=observed,
  stop_attempt_id=(a).id,stop_fence=(a).fence
 where id=q and state in ('QUEUED','LEASED','RUNNING') and stop_reason is null;
$$;

-- Replace only the latest admission body. Actor/image/recovery wrappers stay intact.
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

    if target.id is null then
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
        b->>'publicText', least(cy.deadline, clock_timestamp() + interval '10 minutes')) returning * into q;

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

-- Keep the previous state/control/receipt rules and lock order. Observations do not
-- update run.updated_at, emit events, or prove that an executing process stopped.
create or replace function workflow_private.reconcile(r uuid) returns void
language plpgsql security definer set search_path='' as $$
declare rq workflow_private.requests; a workflow_private.attempts; c workflow_private.cycles;
 rm text; observed timestamptz; boundary timestamptz; reason text; requeued uuid[]:='{}'::uuid[];
begin
 for rq in select * from workflow_private.requests where room_id=r
   and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') and not workflow_private.request_retired(id) order by id loop
  select * into a from workflow_private.attempts where request_id=rq.id
   and state in ('LEASED','EXECUTING','UNKNOWN') order by fence desc limit 1;
  select * into c from workflow_private.cycles where id=rq.cycle_id;
  observed:=clock_timestamp();
  boundary:=least(rq.deadline,c.deadline);
  if not workflow_private.binding_live(rq.agent_id,rq.binding_epoch,r) then
   perform workflow_private.observe_stop(rq.id,a,'BINDING_CHANGED',observed);
   if a.id is not null and (a.start_intent_at is not null or a.state='UNKNOWN') then
    update workflow_private.attempts set state='UNKNOWN',adoption='HISTORICAL' where id=a.id;
    if rq.state<>'UNKNOWN' then perform workflow_private.state(rq.id,'UNKNOWN');end if;
    perform workflow_private.control(rq.id);
   else
    if a.id is not null then update workflow_private.attempts set state='ABANDONED' where id=a.id;end if;
    perform workflow_private.state(rq.id,'CANCELLED');
   end if;
   perform workflow_private.human_required(rq.cycle_id);
  elsif a.id is not null and a.lease_expires_at<=observed and a.state in ('LEASED','EXECUTING') then
   -- A paired unstarted attempt is retried without consuming the first stop reason.
   if a.start_intent_at is not null or c.mode='DIRECT' then
    reason:=case when boundary<=observed and boundary<a.lease_expires_at then 'RESPONSE_TIMEOUT' else 'EXECUTION_LEASE_EXPIRED' end;
    perform workflow_private.observe_stop(rq.id,a,reason,observed);
   end if;
   if a.start_intent_at is null then
    update workflow_private.attempts set state='ABANDONED' where id=a.id;
    if c.mode='DIRECT' then
     perform workflow_private.state(rq.id,'CANCELLED');
     perform workflow_private.human_required(rq.cycle_id);
    else
     requeued:=array_append(requeued,rq.id);
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
  observed:=clock_timestamp();
  if c.deadline<=observed or not workflow_private.cycle_scope_live(c)
    or c.revision<>(select revision from workflow_private.rooms where room_id=r)
    or exists(select 1 from workflow_private.questions where cycle_id=c.id and adoption='PENDING' and deadline<=observed) then
   for rq in select * from workflow_private.requests where cycle_id=c.id
     and state in ('QUEUED','LEASED','RUNNING') and not (id=any(requeued)) order by id loop
    select * into a from workflow_private.attempts where request_id=rq.id
     and state in ('LEASED','EXECUTING','UNKNOWN') order by fence desc limit 1;
    boundary:=least(rq.deadline,c.deadline,(select min(deadline) from workflow_private.questions where cycle_id=c.id and adoption='PENDING'));
    reason:=case
     when not workflow_private.cycle_scope_live(c) then 'BINDING_CHANGED'
     when c.revision<>(select revision from workflow_private.rooms where room_id=r) then 'CONTEXT_CHANGED'
     when a.id is not null and a.state in ('LEASED','EXECUTING') and a.lease_expires_at<=observed and a.lease_expires_at<=boundary then 'EXECUTION_LEASE_EXPIRED'
     else 'RESPONSE_TIMEOUT' end;
    perform workflow_private.observe_stop(rq.id,a,reason,observed);
   end loop;
   perform workflow_private.human_required(c.id);
  end if;
 end loop;
 select mode into rm from workflow_private.rooms where room_id=r;
 if rm='PAUSING' and not workflow_private.has_blocking_runs(r) then
  update workflow_private.rooms set mode='PAUSED' where room_id=r;
  perform workflow_private.event(r,'ROOM_PAUSED');
 end if;
end;$$;

-- A statement snapshot validates membership and every ID together. No mutation,
-- reconcile, advisory lock, or workflow room lock is acquired by this read.
create function public.workflow_human_run_diagnostics(p_body jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r uuid; u uuid:=auth.uid(); ids uuid[]; result jsonb; organization uuid;
begin
 if p_body is null or jsonb_typeof(p_body) is distinct from 'object' then
  raise exception using message='INVALID_BODY',errcode='P0001';
 end if;
 if octet_length(p_body::text)>16384 then raise exception using message='BODY_TOO_LARGE',errcode='P0001';end if;
 if not runtime_settings_private.keys(p_body,array['protocol','expectedUserId','roomId','requestIds'])
  or p_body->'protocol' is distinct from '1'::jsonb
  or jsonb_typeof(p_body->'expectedUserId') is distinct from 'string'
  or jsonb_typeof(p_body->'roomId') is distinct from 'string'
  or not runtime_settings_private.id_ok(p_body->>'expectedUserId')
  or not runtime_settings_private.id_ok(p_body->>'roomId')
  or jsonb_typeof(p_body->'requestIds') is distinct from 'array' then
  raise exception using message='INVALID_BODY',errcode='P0001';
 end if;
 if jsonb_array_length(p_body->'requestIds') not between 1 and 40
  or exists(select 1 from jsonb_array_elements(p_body->'requestIds') x
    where jsonb_typeof(x) is distinct from 'string' or not runtime_settings_private.id_ok(x#>>'{}')) then
  raise exception using message='INVALID_BODY',errcode='P0001';
 end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_body->'requestIds');
 if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then
  raise exception using message='INVALID_BODY',errcode='P0001';
 end if;
 if u is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 if (p_body->>'expectedUserId')::uuid<>u then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 r:=(p_body->>'roomId')::uuid;
 select organization_id into organization from public.rooms where id=r;
 if organization is null or not device_binding_private.live(u,organization,r,false) then
  raise exception using message='FORBIDDEN',errcode='P0001';
 end if;
 if (select count(*) from workflow_private.requests where room_id=r and id=any(ids))<>cardinality(ids) then
  raise exception using message='FORBIDDEN',errcode='P0001';
 end if;
 select jsonb_agg(jsonb_build_object('requestId',q.id,'deadline',q.deadline,
   'stopReason',q.stop_reason,'stopObservedAt',q.stop_observed_at) order by input.ordinality) into result
 from unnest(ids) with ordinality input(id,ordinality)
 join workflow_private.requests q on q.id=input.id and q.room_id=r;
 return jsonb_build_object('protocol',1,'roomId',r,'diagnostics',result);
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception using message='INVALID_BODY',errcode='P0001';
end;$$;

revoke all on function workflow_private.immutable_stop_observation(),
 workflow_private.observe_stop(uuid,workflow_private.attempts,text,timestamptz) from public,anon,authenticated;
revoke all on function public.workflow_human_run_diagnostics(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_run_diagnostics(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
