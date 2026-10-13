begin;

-- Human questions share the same admission rules for owned and colleague AIs.
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

commit;
