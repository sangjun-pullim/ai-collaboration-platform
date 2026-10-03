begin;

-- Additive upgrade. A rollback must revoke the new ask/cancel wrappers in a
-- forward migration, retaining every question, attempt, receipt and event.
alter table workflow_private.cycles
  add column mode text not null default 'AI_PAIR',
  alter column origin_agent_id drop not null,
  alter column origin_epoch drop not null,
  add constraint workflow_cycle_mode check (
    (mode = 'AI_PAIR' and origin_agent_id is not null and origin_epoch is not null
      and origin_agent_id <> peer_agent_id)
    or (mode = 'DIRECT' and origin_agent_id is null and origin_epoch is null
      and generation = 1 and runs_reserved between 0 and 1 and peer_rounds_reserved = 0)
  );
alter table workflow_private.generations alter column origin_epoch drop not null;
alter table workflow_private.questions
  add column source text not null default 'AI',
  add column requester_user_id uuid,
  alter column origin_request_id drop not null,
  alter column origin_epoch drop not null,
  add constraint workflow_question_source check (
    (source = 'AI' and origin_request_id is not null and origin_epoch is not null and requester_user_id is null)
    or (source = 'HUMAN' and origin_request_id is null and origin_epoch is null and requester_user_id is not null)
  );
create unique index workflow_one_human_question
  on workflow_private.questions(cycle_id) where source = 'HUMAN';

-- Historical requester identity deliberately has no Auth FK, like SQL006 actors.
create function workflow_private.direct_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cy workflow_private.cycles;
begin
  if tg_table_name = 'cycles' then
    if new.mode is distinct from old.mode or
      (old.mode = 'DIRECT' and row(new.room_id, new.origin_owner_id, new.origin_agent_id,
        new.origin_epoch, new.peer_agent_id, new.peer_epoch, new.generation, new.revision)
        is distinct from row(old.room_id, old.origin_owner_id, old.origin_agent_id,
        old.origin_epoch, old.peer_agent_id, old.peer_epoch, old.generation, old.revision)) then
      raise exception using message = 'CONFLICT', errcode = 'P0001';
    end if;
  else
    select * into cy from workflow_private.cycles where id = old.cycle_id;
    if cy.mode = 'DIRECT' then
      if tg_table_name = 'requests' then
        if row(new.id, new.cycle_id, new.room_id, new.generation, new.device_id, new.agent_id,
          new.owner_id, new.binding_epoch, new.revision, new.kind, new.question_id,
          new.public_text, new.reply_text, new.deadline)
        is distinct from row(old.id, old.cycle_id, old.room_id, old.generation, old.device_id,
          old.agent_id, old.owner_id, old.binding_epoch, old.revision, old.kind,
          old.question_id, old.public_text, old.reply_text, old.deadline) then
        raise exception using message = 'CONFLICT', errcode = 'P0001';
        end if;
      elsif tg_table_name = 'questions' then
        if row(new.id, new.cycle_id, new.source, new.requester_user_id, new.origin_request_id,
          new.origin_epoch, new.peer_epoch, new.generation, new.revision, new.public_text, new.deadline)
        is distinct from row(old.id, old.cycle_id, old.source, old.requester_user_id,
          old.origin_request_id, old.origin_epoch, old.peer_epoch, old.generation,
          old.revision, old.public_text, old.deadline) then
        raise exception using message = 'CONFLICT', errcode = 'P0001';
        end if;
      elsif tg_table_name = 'generations' and new is distinct from old then
        raise exception using message = 'CONFLICT', errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger workflow_cycle_identity before update on workflow_private.cycles
  for each row execute function workflow_private.direct_identity();
create trigger workflow_direct_request_identity before update on workflow_private.requests
  for each row execute function workflow_private.direct_identity();
create trigger workflow_direct_question_identity before update on workflow_private.questions
  for each row execute function workflow_private.direct_identity();
create trigger workflow_direct_generation_identity before update on workflow_private.generations
  for each row execute function workflow_private.direct_identity();

-- Validate the complete graph at commit, allowing the atomic admission to insert
-- cycle, generation, question and request in that order without temporary fakes.
create function workflow_private.direct_graph() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cid uuid; cy workflow_private.cycles; q workflow_private.questions;
begin
  if tg_table_name = 'cycles' then
    cid := coalesce(new.id, old.id);
  else
    cid := coalesce(new.cycle_id, old.cycle_id);
  end if;
  select * into cy from workflow_private.cycles where id = cid;
  if cy.id is null then return null; end if; -- Exact room cascade remains possible.
  if exists(select 1 from workflow_private.generations g where g.cycle_id = cid
      and (g.generation < 1 or g.revision < 1 or g.peer_epoch < 1
        or (cy.mode = 'AI_PAIR' and (g.origin_epoch is null or g.origin_epoch < 1))
        or (cy.mode = 'DIRECT' and (g.origin_epoch is not null or g.generation <> 1))))
    or exists(select 1 from workflow_private.questions x where x.cycle_id = cid
      and ((cy.mode = 'AI_PAIR' and x.source <> 'AI') or (cy.mode = 'DIRECT' and x.source <> 'HUMAN'))) then
    raise exception using message = 'CONFLICT', errcode = 'P0001';
  end if;
  if cy.mode <> 'DIRECT' then return null; end if;
  select * into q from workflow_private.questions where cycle_id = cid;
  if cy.runs_reserved <> 1 or cy.peer_rounds_reserved <> 0 or cy.generation <> 1
    or (select count(*) from workflow_private.generations where cycle_id = cid) <> 1
    or not exists(select 1 from workflow_private.generations g where g.cycle_id = cid
      and g.generation = 1 and g.revision = cy.revision and g.origin_epoch is null
      and g.peer_epoch = cy.peer_epoch and g.public_text = q.public_text)
    or (select count(*) from workflow_private.questions where cycle_id = cid) <> 1
    or q.source is distinct from 'HUMAN' or q.requester_user_id is distinct from cy.origin_owner_id
    or q.origin_request_id is not null or q.origin_epoch is not null
    or q.generation <> 1 or q.revision <> cy.revision or q.peer_epoch <> cy.peer_epoch
    or (select count(*) from workflow_private.requests where cycle_id = cid) <> 1
    or not exists(select 1 from workflow_private.requests r where r.cycle_id = cid
      and r.room_id = cy.room_id and r.generation = 1 and r.kind = 'PEER'
      and r.agent_id = cy.peer_agent_id and r.binding_epoch = cy.peer_epoch
      and r.revision = cy.revision and r.question_id = q.id
      and r.public_text = q.public_text and r.reply_text is null and r.deadline = q.deadline) then
    raise exception using message = 'CONFLICT', errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger workflow_direct_cycle_graph after insert or update or delete on workflow_private.cycles
  deferrable initially deferred for each row execute function workflow_private.direct_graph();
create constraint trigger workflow_direct_generation_graph after insert or update or delete on workflow_private.generations
  deferrable initially deferred for each row execute function workflow_private.direct_graph();
create constraint trigger workflow_direct_question_graph after insert or update or delete on workflow_private.questions
  deferrable initially deferred for each row execute function workflow_private.direct_graph();
create constraint trigger workflow_direct_request_graph after insert or update or delete on workflow_private.requests
  deferrable initially deferred for each row execute function workflow_private.direct_graph();

create function workflow_private.cycle_scope_live(c workflow_private.cycles) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(workflow_private.binding_live(c.peer_agent_id, c.peer_epoch, c.room_id)
    and case when c.mode = 'DIRECT' then exists(
      select 1 from public.rooms r where r.id = c.room_id
        and device_binding_private.live(c.origin_owner_id, r.organization_id, r.id, true))
    else workflow_private.binding_live(c.origin_agent_id, c.origin_epoch, c.room_id) end, false);
$$;

create function workflow_private.direct_can_cancel(c workflow_private.cycles, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from workflow_private.requests r
    join public.rooms room on room.id = r.room_id
    join device_binding_private.agents a on a.id = r.agent_id and a.room_id = r.room_id
      and a.binding_epoch = r.binding_epoch and a.owner_user_id = r.owner_id
    where c.mode = 'DIRECT' and c.retired_at is null and r.cycle_id = c.id
      and r.agent_id = c.peer_agent_id and r.binding_epoch = c.peer_epoch and r.kind = 'PEER'
      and r.state in ('QUEUED','LEASED','RUNNING','UNKNOWN')
      and device_binding_private.live(u, room.organization_id, room.id, true)
      and (u = c.origin_owner_id or u = r.owner_id));
$$;

-- Keep every existing event alternative; add only the HUMAN -> PEER question.
-- coalesce rejects SQL NULL rather than allowing an incomplete event CHECK.
do $$
declare constraint_name text;
begin
  select conname into strict constraint_name from pg_catalog.pg_constraint
    where conrelid = 'public.workflow_events'::regclass and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%sender_kind%'
      and pg_catalog.pg_get_constraintdef(oid) like '%RUN_STATE%';
  execute format('alter table public.workflow_events drop constraint %I', constraint_name);
end;
$$;
alter table public.workflow_events add constraint workflow_event_shape check (coalesce(
(kind='RUN_STATE' and sender_kind='AGENT' and adoption='NONE' and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and run_state is not null and question_id is null and reply_to is null and room_mode is null and public_text='' and terminal is not distinct from case when run_state in ('COMPLETED','FAILED','INTERRUPTED') then run_state else null end)
 or (kind in ('QUESTION','ANSWER') and sender_kind='AGENT' and ((kind='QUESTION' and request_kind in ('ORIGIN','CONTINUATION','RESUME') and adoption='PENDING' and public_text<>'') or (kind='ANSWER' and request_kind='PEER' and adoption<>'NONE')) and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and question_id is not null and reply_to is not distinct from case when kind='ANSWER' then question_id else null end and run_state is null and terminal is null and room_mode is null)
 or (kind like 'ROOM_%' and room_mode=case when kind='ROOM_PAUSE_REQUESTED' then 'PAUSING' when kind='ROOM_PAUSED' then 'PAUSED' else 'ACTIVE' end and sender_kind=case when kind='ROOM_PAUSED' then 'SYSTEM' else 'HUMAN' end and adoption='NONE' and public_text='' and room_mode=case when kind='ROOM_PAUSE_REQUESTED' then 'PAUSING' when kind='ROOM_PAUSED' then 'PAUSED' else 'ACTIVE' end and cycle_id is null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null)
 or (kind='SPEECH' and sender_kind='HUMAN' and adoption='NONE' and public_text<>'' and cycle_id is null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind='SPEECH' and sender_kind='AGENT' and adoption in ('ACCEPTED','HISTORICAL') and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind in ('ORIGIN','CONTINUATION','RESUME') and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null and public_text<>'')
 or (kind in ('INVESTIGATION_STARTED','INVESTIGATION_RESUMED') and sender_kind='HUMAN' and adoption='NONE' and public_text<>'' and cycle_id is not null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind in ('INTERRUPT_REQUESTED','INTERRUPT_ACKNOWLEDGED') and sender_kind='AGENT' and adoption='NONE' and public_text='' and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind='HUMAN_INPUT_REQUIRED' and sender_kind='SYSTEM' and adoption='HUMAN_INPUT_REQUIRED' and public_text='' and cycle_id is not null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind = 'QUESTION' and sender_kind = 'HUMAN' and adoption = 'PENDING'
    and public_text <> '' and cycle_id is not null and request_id is not null
    and agent_id is not null and binding_epoch is not null and request_kind = 'PEER'
    and question_id is not null and reply_to is null and run_state is null
    and terminal is null and room_mode is null), false));

-- Preserve the SQL006 paired branches and their wire/receipt semantics. All new
-- wrappers retain empty search_path and private execution privileges below.
alter function workflow_private.validate(text,jsonb) rename to validate_006;
alter function workflow_private.human(text,jsonb) rename to human_006;
alter function workflow_private.reserve(uuid,uuid,text,text,uuid,text) rename to reserve_006;
alter function workflow_private.advance(uuid) rename to advance_006;
alter function workflow_private.history(uuid,bigint,uuid) rename to history_006;
alter function workflow_private.restore(text,jsonb) rename to restore_006;

create function workflow_private.validate(action text, b jsonb) returns void
language plpgsql set search_path = '' as $$
declare keys text[]; key text; value text;
begin
  if action not in ('ask','cancel') then
    perform workflow_private.validate_006(action, b);
    return;
  end if;
  if b is null or jsonb_typeof(b) <> 'object' then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  if octet_length(b::text) > 16384 then
    raise exception using message = 'BODY_TOO_LARGE', errcode = 'P0001';
  end if;
  keys := case when action = 'ask' then
    array['roomId','operationId','targetAgentId','targetEpoch','expectedRoomRevision','publicText','confirmed']
    else array['roomId','operationId','requestId','expectedRoomRevision'] end;
  if b->'protocol' is distinct from '1'::jsonb or not b ?& keys
    or (select count(*) from jsonb_object_keys(b)) <> cardinality(keys) + 1 then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  foreach key in array keys loop
    value := b->>key;
    if value is null then
      raise exception using message = 'INVALID_BODY', errcode = 'P0001';
    end if;
    if key like '%Id' and (jsonb_typeof(b->key) <> 'string'
      or value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception using message = 'INVALID_BODY', errcode = 'P0001';
    end if;
    if key in ('targetEpoch','expectedRoomRevision') then
      if jsonb_typeof(b->key) <> 'number' or value !~ '^\d+$' then
        raise exception using message = 'INVALID_BODY', errcode = 'P0001';
      end if;
      if value::numeric < 1 or value::numeric > 9007199254740991 then
        raise exception using message = 'INVALID_BODY', errcode = 'P0001';
      end if;
    end if;
  end loop;
  if action = 'ask' and (b->'confirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(b->'publicText') <> 'string' or octet_length(b->>'publicText') > 8192
    or char_length(b->>'publicText') > 4000 or workflow_private.text_trim(b->>'publicText') = '') then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
end;
$$;

create function workflow_private.reserve(c uuid, a uuid, k text, txt text, q uuid default null, reply text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cy workflow_private.cycles;
begin
  select * into cy from workflow_private.cycles where id = c;
  if cy.mode = 'DIRECT' and (k <> 'PEER' or a <> cy.peer_agent_id or reply is not null
    or cy.runs_reserved <> 0 or not workflow_private.cycle_scope_live(cy)
    or not exists(select 1 from workflow_private.questions x where x.id = q and x.cycle_id = c
      and x.source = 'HUMAN' and x.requester_user_id = cy.origin_owner_id
      and x.generation = 1 and x.revision = cy.revision and x.peer_epoch = cy.peer_epoch
      and x.public_text = txt and x.deadline > clock_timestamp())) then
    raise exception using message = 'CONFLICT', errcode = 'P0001';
  end if;
  return workflow_private.reserve_006(c, a, k, txt, q, reply);
end;
$$;

create function workflow_private.advance(c uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cy workflow_private.cycles; q workflow_private.questions; peer workflow_private.requests;
begin
  select * into cy from workflow_private.cycles where id = c;
  if cy.mode <> 'DIRECT' then return workflow_private.advance_006(c); end if;
  if cy.state <> 'ACTIVE' then return null; end if;
  select * into q from workflow_private.questions where cycle_id = c and source = 'HUMAN';
  select * into peer from workflow_private.requests where cycle_id = c and question_id = q.id and kind = 'PEER';
  if not workflow_private.cycle_scope_live(cy) or q.generation <> cy.generation
    or q.revision <> cy.revision or q.peer_epoch <> cy.peer_epoch
    or q.deadline <= clock_timestamp() or cy.deadline <= clock_timestamp()
    or not exists(select 1 from workflow_private.rooms where room_id = cy.room_id
      and revision = cy.revision and mode = 'ACTIVE')
    or peer.state in ('FAILED','INTERRUPTED','UNKNOWN','CANCELLED') then
    perform workflow_private.human_required(c);
    return null;
  end if;
  if peer.state = 'COMPLETED' and q.adoption = 'PENDING' and q.answer_text is not null
    and exists(select 1 from workflow_private.attempts a where a.request_id = peer.id
      and a.fence = peer.fence and a.state = 'COMPLETED' and a.start_intent_at is not null
      and a.adoption = 'PENDING')
    and not exists(select 1 from workflow_private.requests where cycle_id = c
      and state in ('QUEUED','LEASED','RUNNING','UNKNOWN'))
    and not exists(select 1 from workflow_private.attempts a join workflow_private.requests r on r.id = a.request_id
      where r.cycle_id = c and a.state in ('LEASED','EXECUTING','UNKNOWN')) then
    update workflow_private.questions set adoption = 'ACCEPTED' where id = q.id;
    update workflow_private.attempts set adoption = 'ACCEPTED' where request_id = peer.id and fence = peer.fence;
    perform workflow_private.event(cy.room_id, 'ANSWER', c, peer.id, q.answer_text, q.id, 'ACCEPTED');
    update workflow_private.cycles set state = 'COMPLETED' where id = c;
  end if;
  -- A direct answer never reserves an origin or continuation.
  return null;
end;
$$;

create function workflow_private.history(r uuid, afterseq bigint, u uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; cy workflow_private.cycles;
begin
  result := workflow_private.history_006(r, afterseq, u);
  select * into cy from workflow_private.cycles where room_id = r and retired_at is null;
  if cy.mode = 'DIRECT' then
    result := result || jsonb_build_object('cycle', jsonb_build_object(
      'cycleId', cy.id, 'mode', 'DIRECT', 'targetAgentId', cy.peer_agent_id,
      'targetEpoch', cy.peer_epoch, 'generation', cy.generation, 'roomRevision', cy.revision,
      'state', cy.state, 'runsReserved', cy.runs_reserved, 'peerRoundsReserved', cy.peer_rounds_reserved,
      'deadline', cy.deadline, 'canInterrupt', workflow_private.direct_can_cancel(cy, u)));
  end if;
  return result;
end;
$$;

create function workflow_private.restore(action text, result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cy workflow_private.cycles; rq workflow_private.requests; at workflow_private.attempts;
begin
  if action = 'ask' then
    select * into cy from workflow_private.cycles where id = (result->>'cycleId')::uuid;
    return result || jsonb_build_object('cycleState', cy.state);
  end if;
  if action in ('complete','observe') then
    select * into at from workflow_private.attempts where id = (result->>'attemptId')::uuid;
    select * into rq from workflow_private.requests where id = at.request_id;
    select * into cy from workflow_private.cycles where id = rq.cycle_id;
    if cy.mode = 'DIRECT' and (not workflow_private.cycle_scope_live(cy)
      or rq.generation <> cy.generation or rq.revision <> cy.revision
      or rq.binding_epoch <> cy.peer_epoch or cy.deadline <= clock_timestamp()
      or rq.deadline <= clock_timestamp()
      or not exists(select 1 from workflow_private.rooms where room_id = cy.room_id and revision = rq.revision)) then
      if at.adoption <> 'HISTORICAL' then
        update workflow_private.attempts set adoption = 'HISTORICAL' where id = at.id;
        update workflow_private.questions set adoption = 'HISTORICAL' where id = rq.question_id;
        perform workflow_private.event(rq.room_id, 'ANSWER', cy.id, rq.id, at.terminal_text, rq.question_id, 'HISTORICAL');
      end if;
      perform workflow_private.human_required(cy.id);
    end if;
  end if;
  return workflow_private.restore_006(action, result);
end;
$$;

create function workflow_private.human(action text, b jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); r uuid; organization uuid; rm workflow_private.rooms;
  cy workflow_private.cycles; target device_binding_private.agents; rq workflow_private.requests;
  q workflow_private.questions; prev workflow_private.receipts; op uuid; ph text; result jsonb; rid uuid; cid uuid;
begin
  if action not in ('ask','cancel') and not (action = 'resume' and b->>'mode' = 'cycle') then
    return workflow_private.human_006(action, b);
  end if;
  perform workflow_private.validate(action, b);
  if b ? 'publicText' then b := b || jsonb_build_object('publicText', workflow_private.text_trim(b->>'publicText')); end if;
  perform device_binding_private.guard();
  if u is null then raise exception using message = 'UNAUTHENTICATED', errcode = 'P0001'; end if;
  r := (b->>'roomId')::uuid;
  select organization_id into organization from public.rooms where id = r;
  if organization is null then raise exception using message = 'NOT_FOUND', errcode = 'P0001'; end if;
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
    if cy.id is null or cy.mode <> 'DIRECT' or cy.retired_at is not null or rq.kind <> 'PEER'
      or rq.agent_id <> cy.peer_agent_id or rq.binding_epoch <> cy.peer_epoch
      or (u <> cy.origin_owner_id and u <> rq.owner_id) then
      raise exception using message = 'FORBIDDEN', errcode = 'P0001';
    end if;
    if target.id is null or target.binding_epoch <> rq.binding_epoch or target.owner_user_id <> rq.owner_id then
      raise exception using message = 'CONFLICT', errcode = 'P0001';
    end if;
  end if;
  op := (b->>'operationId')::uuid;
  ph := encode(extensions.digest(b::text, 'sha256'), 'hex');
  select * into prev from workflow_private.receipts where room_id = r and actor_kind = 'human' and actor_id = u and operation_id = op;
  if found then
    if prev.action <> action or prev.payload_hash <> ph then raise exception using message = 'CONFLICT', errcode = 'P0001'; end if;
    return workflow_private.restore(action, prev.result);
  end if;
  if (b->>'expectedRoomRevision')::bigint <> rm.revision then
    raise exception using message = 'CONFLICT', errcode = 'P0001';
  end if;
  if action = 'ask' then
    if rm.mode <> 'ACTIVE'
      or exists(select 1 from workflow_private.cycles where room_id = r and retired_at is null and state = 'ACTIVE')
      or exists(select 1 from workflow_private.requests where room_id = r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN'))
      or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id = a.request_id
        where x.room_id = r and a.state in ('LEASED','EXECUTING','UNKNOWN'))
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
    if rid is null then raise exception using message = 'CONFLICT', errcode = 'P0001'; end if;
    perform workflow_private.event(r, 'QUESTION', cy.id, rid, q.public_text, q.id, 'PENDING', u);
    result := jsonb_build_object('cycleId', cy.id, 'requestId', rid, 'accepted', true,
      'roomRevision', rm.revision, 'cycleState', 'ACTIVE');
  else
    if rq.state not in ('QUEUED','LEASED','RUNNING','UNKNOWN') then
      result := jsonb_build_object('controlId', null, 'requestId', null, 'state', 'NO_ACTIVE_RUN');
    else
      -- control() pins the current attempt/fence and never treats its ACK as terminal.
      perform workflow_private.human_required(cy.id, rq.agent_id);
      if rq.state <> 'QUEUED' then cid := workflow_private.control(rq.id); end if;
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
 for rq in select * from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') order by id loop
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

 for c in select * from workflow_private.cycles where room_id=r and state='ACTIVE' order by id loop
 if c.deadline<=clock_timestamp() or not workflow_private.cycle_scope_live(c) or c.revision<>(select revision from workflow_private.rooms where room_id=r)
 or exists(select 1 from workflow_private.questions where cycle_id=c.id and adoption='PENDING' and deadline<=clock_timestamp()) then
 perform workflow_private.human_required(c.id);
end if;

 end loop;

 select mode into rm from workflow_private.rooms where room_id=r;

 if rm='PAUSING' and not exists(select 1 from workflow_private.requests where room_id=r and state in ('LEASED','RUNNING','UNKNOWN')) then
 update workflow_private.rooms set mode='PAUSED' where room_id=r;
perform workflow_private.event(r,'ROOM_PAUSED');
end if;

end;
$$;


create or replace function workflow_private.device(action text,b jsonb,secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare h text;
cred device_binding_private.credentials;
d device_binding_private.devices;
ag device_binding_private.agents;
rm workflow_private.rooms;
rd workflow_private.readiness;
rq workflow_private.requests;
at workflow_private.attempts;
cy workflow_private.cycles;
q workflow_private.questions;
ctl workflow_private.controls;
prev workflow_private.receipts;
op uuid;
ph text;
result jsonb;
rid uuid;
aid uuid;
ad text;
queued uuid;
peerid uuid;
wasunknown boolean;

begin
 perform workflow_private.validate(action,b);
if b ? 'publicText' then
 b:=b||jsonb_build_object('publicText',workflow_private.text_trim(b->>'publicText'));
end if;
perform device_binding_private.guard();

 if secret is null or secret !~ '^[a-f0-9]{64}$' then
 raise exception using message='UNAUTHENTICATED',errcode='P0001';
end if;

 h:=encode(extensions.digest(secret,'sha256'),'hex');
select * into cred from device_binding_private.credentials where hash=h;

 if cred.device_id is null then
 raise exception using message='UNAUTHENTICATED',errcode='P0001';
end if;

 select * into d from device_binding_private.devices where id=cred.device_id;
perform device_binding_private.lock_scope(d.organization_id,d.room_id);

 select * into cred from device_binding_private.credentials where hash=h;
select * into d from device_binding_private.devices where id=cred.device_id;

 if d.id is null or d.state<>'active' or d.current_hash<>h or cred.revoked_at is not null or cred.expires_at<=clock_timestamp() or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then
 raise exception using message='UNAUTHENTICATED',errcode='P0001';
end if;

 select * into ag from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;

 if ag.id is null or ag.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(ag.id,ag.binding_epoch,d.room_id) then
 raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 perform workflow_private.lock_room(d.room_id);
perform workflow_private.reconcile(d.room_id);
select * into rm from workflow_private.rooms where room_id=d.room_id;

 if action not in ('ready','poll') then
 select * into rq from workflow_private.requests where id=(b->>'requestId')::uuid and device_id=d.id and agent_id=ag.id and binding_epoch=ag.binding_epoch and room_id=d.room_id;

 if rq.id is null then
 raise exception using message='FORBIDDEN',errcode='P0001';
end if;

 if action<>'claim' then
 select * into at from workflow_private.attempts where id=(b->>'attemptId')::uuid and request_id=rq.id and fence=(b->>'fence')::bigint and fence=rq.fence;

 if at.id is null then
 raise exception using message='CONFLICT',errcode='P0001';
end if;
end if;

 end if;

 select * into rd from workflow_private.readiness where agent_id=ag.id;

 if action='poll' then
 select id into queued from workflow_private.requests where agent_id=ag.id and device_id=d.id and binding_epoch=ag.binding_epoch and state='QUEUED' order by created_at,id limit 1;

 select a.* into at from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.agent_id=ag.id and x.device_id=d.id and x.binding_epoch=ag.binding_epoch and a.state in ('LEASED','EXECUTING','UNKNOWN') order by x.created_at,a.fence desc limit 1;

 select * into ctl from workflow_private.controls where attempt_id=at.id;

 return jsonb_build_object('roomId',d.room_id,'roomRevision',rm.revision,'roomMode',rm.mode,'agentId',ag.id,'bindingEpoch',ag.binding_epoch,'reportedReady',coalesce(rd.reported_ready and rd.binding_epoch=ag.binding_epoch and rd.valid_until>clock_timestamp(),false),'validUntil',case when rd.binding_epoch=ag.binding_epoch then
 rd.valid_until end,'queuedRequest',workflow_private.payload(queued),'attempt',workflow_private.attempt(at.id),'control',case when ctl.id is null then
 null else
 jsonb_build_object('controlId',ctl.id,'requestId',ctl.request_id,'attemptId',ctl.attempt_id,'fence',ctl.fence,'state',ctl.state) end);

 end if;

 op:=(b->>'operationId')::uuid;
ph:=encode(extensions.digest(b::text,'sha256'),'hex');
select * into prev from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=op;

 if found then
 if prev.action<>action or prev.payload_hash<>ph then
 raise exception using message='CONFLICT',errcode='P0001';
end if;
return workflow_private.restore(action,prev.result);
end if;

 if action='ready' then
 insert into workflow_private.readiness values(ag.id,d.room_id,d.id,ag.binding_epoch,(b->>'reportedReady')::boolean,case when (b->>'reportedReady')::boolean then
 clock_timestamp()+interval '60 seconds' end) on conflict(agent_id) do update set device_id=excluded.device_id,binding_epoch=excluded.binding_epoch,reported_ready=excluded.reported_ready,valid_until=excluded.valid_until returning * into rd;

 result:=jsonb_build_object('agentId',ag.id,'bindingEpoch',ag.binding_epoch,'reportedReady',rd.reported_ready,'validUntil',rd.valid_until,'verification','reported');

 elsif action='claim' then
 if rm.mode<>'ACTIVE' or rq.state<>'QUEUED' or rq.deadline<=clock_timestamp() or rq.revision<>rm.revision or not coalesce(rd.reported_ready and rd.binding_epoch=ag.binding_epoch and rd.valid_until>clock_timestamp(),false) or (select state from workflow_private.cycles where id=rq.cycle_id)<>'ACTIVE'
 or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.device_id=d.id and x.agent_id=ag.id and a.state in ('LEASED','EXECUTING','UNKNOWN')) then
 raise exception using message='CONFLICT',errcode='P0001';
end if;

 update workflow_private.requests set fence=fence+1 where id=rq.id returning * into rq;

 insert into workflow_private.attempts(request_id,fence,state,lease_expires_at) values(rq.id,rq.fence,'LEASED',clock_timestamp()+interval '30 seconds') returning id into aid;

 perform workflow_private.state(rq.id,'LEASED');
result:=workflow_private.attempt(aid);

 elsif action in ('start-intent','lease') then
 if at.state not in ('LEASED','EXECUTING') or at.lease_expires_at<=clock_timestamp() or rq.revision<>rm.revision or rm.mode<>'ACTIVE' or (select state from workflow_private.cycles where id=rq.cycle_id)<>'ACTIVE' then
 raise exception using message='CONFLICT',errcode='P0001';
end if;

 if action='start-intent' then
 if at.state<>'LEASED' then
 raise exception using message='CONFLICT',errcode='P0001';
end if;
update workflow_private.attempts set state='EXECUTING',start_intent_at=clock_timestamp() where id=at.id;
perform workflow_private.state(rq.id,'RUNNING');

 else
 update workflow_private.attempts set lease_expires_at=clock_timestamp()+interval '30 seconds' where id=at.id;
end if;

 result:=workflow_private.attempt(at.id);

 elsif action='question' then
 select * into cy from workflow_private.cycles where id=rq.cycle_id;

 if at.state<>'EXECUTING' or at.start_intent_at is null or at.lease_expires_at<=clock_timestamp() or cy.mode='DIRECT' or rq.kind='PEER' or rq.agent_id<>cy.origin_agent_id or rq.generation<>cy.generation or cy.state<>'ACTIVE' or rq.revision<>rm.revision or rm.mode<>'ACTIVE' or not workflow_private.binding_live(cy.origin_agent_id,cy.origin_epoch,d.room_id) or not workflow_private.binding_live(cy.peer_agent_id,cy.peer_epoch,d.room_id) or exists(select 1 from workflow_private.questions where origin_request_id=rq.id or cycle_id=cy.id and adoption='PENDING') then
 raise exception using message='CONFLICT',errcode='P0001';
end if;

 if cy.peer_rounds_reserved>=5 or cy.runs_reserved>=11 or cy.deadline<=clock_timestamp() then
 perform workflow_private.human_required(cy.id);
result:=jsonb_build_object('cycleId',cy.id,'questionId',null,'peerRequestId',null,'accepted',false,'cycleState','HUMAN_INPUT_REQUIRED');

 else
 update workflow_private.cycles set peer_rounds_reserved=peer_rounds_reserved+1 where id=cy.id;

 insert into workflow_private.questions(cycle_id,origin_request_id,generation,revision,origin_epoch,peer_epoch,public_text,deadline) values(cy.id,rq.id,cy.generation,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText',least(cy.deadline,clock_timestamp()+interval '120 seconds')) returning * into q;

 peerid:=workflow_private.reserve(cy.id,cy.peer_agent_id,'PEER',q.public_text,q.id);
if peerid is not null then
 perform workflow_private.event(d.room_id,'QUESTION',cy.id,rq.id,q.public_text,q.id,'PENDING');
end if;
result:=jsonb_build_object('cycleId',cy.id,'questionId',case when peerid is not null then
 q.id end,'peerRequestId',peerid,'accepted',peerid is not null,'cycleState',(select state from workflow_private.cycles where id=cy.id));
end if;

 elsif action in ('complete','observe') then
 wasunknown:=at.state='UNKNOWN';

 if action='complete' and (at.state<>'EXECUTING' or at.start_intent_at is null or at.lease_expires_at<=clock_timestamp()) or action='observe' and at.state<>'UNKNOWN' then
 raise exception using message='CONFLICT',errcode='P0001';
end if;

 select * into cy from workflow_private.cycles where id=rq.cycle_id;
ad:=case when wasunknown then
 'HISTORICAL' when cy.state='ACTIVE' and rq.generation=cy.generation and rq.revision=rm.revision and workflow_private.cycle_scope_live(cy) and cy.deadline>clock_timestamp() then
 case when rq.kind='PEER' then
 'PENDING' else
 'ACCEPTED' end else
 'HISTORICAL' end;

 if b->>'terminal'<>'COMPLETED' then
 ad:=case when ad='HISTORICAL' then
 'HISTORICAL' else
 'HUMAN_INPUT_REQUIRED' end;
end if;

 update workflow_private.attempts set state=b->>'terminal',terminal_text=b->>'publicText',adoption=ad where id=at.id;
perform workflow_private.state(rq.id,b->>'terminal');

 if rq.kind='PEER' then
 select * into q from workflow_private.questions where id=rq.question_id;

 if q.adoption<>'PENDING' or q.deadline<=clock_timestamp() then
 ad:='HISTORICAL';
update workflow_private.attempts set adoption=ad where id=at.id;
end if;

 update workflow_private.questions set answer_text=b->>'publicText',adoption=case when ad='PENDING' and b->>'terminal'='COMPLETED' then
 'PENDING' else
 'HISTORICAL' end where id=q.id;

 perform workflow_private.event(d.room_id,'ANSWER',cy.id,rq.id,b->>'publicText',q.id,ad);

 end if;

 if wasunknown or b->>'terminal'<>'COMPLETED' or ad='HISTORICAL' then
 perform workflow_private.human_required(cy.id);
else rid:=workflow_private.advance(cy.id);
end if;

 perform workflow_private.reconcile(d.room_id);
select adoption into ad from workflow_private.attempts where id=at.id;

 if rq.kind in ('ORIGIN','CONTINUATION','RESUME') and b->>'terminal'='COMPLETED' and b->>'publicText'<>'' then
 perform workflow_private.event(d.room_id,'SPEECH',cy.id,rq.id,b->>'publicText',null,case when ad='ACCEPTED' then
 'ACCEPTED' else
 'HISTORICAL' end);
end if;

 result:=jsonb_build_object('requestId',rq.id,'attemptId',at.id,'terminal',b->>'terminal','adoption',ad,'continuationRequestId',rid);

 elsif action='interrupt-ack' then
 select * into ctl from workflow_private.controls where id=(b->>'controlId')::uuid and request_id=rq.id and attempt_id=at.id and fence=at.fence;

 if ctl.id is null then
 raise exception using message='CONFLICT',errcode='P0001';
end if;

 if ctl.state<>'ACKNOWLEDGED' then
 update workflow_private.controls set state='ACKNOWLEDGED' where id=ctl.id;
perform workflow_private.event(d.room_id,'INTERRUPT_ACKNOWLEDGED',rq.cycle_id,rq.id);
end if;
result:=jsonb_build_object('controlId',ctl.id,'requestId',rq.id,'attemptId',at.id,'fence',at.fence,'state','ACKNOWLEDGED');

 else
 raise exception using message='NOT_FOUND',errcode='P0001';
end if;

 insert into workflow_private.receipts values(d.room_id,'device',d.id,op,action,ph,result);
return result;

end;
$$;


create function public.workflow_human_ask(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('ask', p_body);
$$;
create function public.workflow_human_cancel(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('cancel', p_body);
$$;
revoke all on function public.workflow_human_ask(jsonb), public.workflow_human_cancel(jsonb)
  from public, anon, authenticated;
grant execute on function public.workflow_human_ask(jsonb), public.workflow_human_cancel(jsonb) to authenticated;

-- Rebind the SQL wrappers after the private function renames. Existing names,
-- signatures and grants remain unchanged; no new device API or PEER DTO exists.
create or replace function public.workflow_human_read(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('read', p_body);
$$;
create or replace function public.workflow_human_speak(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('speak', p_body);
$$;
create or replace function public.workflow_human_start(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('start', p_body);
$$;
create or replace function public.workflow_human_interrupt(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('interrupt', p_body);
$$;
create or replace function public.workflow_human_pause(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('pause', p_body);
$$;
create or replace function public.workflow_human_resume(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human('resume', p_body);
$$;

revoke all on all tables in schema workflow_private from public, anon, authenticated;
revoke all on all functions in schema workflow_private from public, anon, authenticated;
commit;
