begin;
create schema workflow_private;
revoke all on schema workflow_private from public,anon,authenticated;
-- Historical actor and binding identifiers deliberately have no Auth/device FK.
create table workflow_private.rooms (
 room_id uuid primary key references public.rooms(id) on delete cascade,
 revision bigint not null default 1 check(revision between 1 and 9007199254740991),
 mode text not null default 'ACTIVE' check(mode in ('ACTIVE','PAUSING','PAUSED')),
 sequence bigint not null default 0 check(sequence between 0 and 9007199254740991)
);
create table workflow_private.cycles (
 id uuid primary key default gen_random_uuid(),room_id uuid not null references workflow_private.rooms(room_id) on delete cascade,
 origin_agent_id uuid not null,peer_agent_id uuid not null,origin_owner_id uuid not null,
 generation bigint not null default 1 check(generation between 1 and 9007199254740991),revision bigint not null check(revision between 1 and 9007199254740991),origin_epoch bigint not null check(origin_epoch between 1 and 9007199254740991),peer_epoch bigint not null check(peer_epoch between 1 and 9007199254740991),
 state text not null default 'ACTIVE' check(state in ('ACTIVE','COMPLETED','HUMAN_INPUT_REQUIRED','CANCELLED')),
 runs_reserved integer not null default 0 check(runs_reserved between 0 and 11),peer_rounds_reserved integer not null default 0 check(peer_rounds_reserved between 0 and 5),
 created_at timestamptz not null default clock_timestamp(),deadline timestamptz not null default clock_timestamp()+interval '10 minutes',retired_at timestamptz,
 unique(room_id,id),check(origin_agent_id<>peer_agent_id)
);
create unique index workflow_one_current_cycle on workflow_private.cycles(room_id) where retired_at is null;
create table workflow_private.generations (
 cycle_id uuid not null references workflow_private.cycles(id) on delete cascade,generation bigint not null,
 revision bigint not null,origin_epoch bigint not null,peer_epoch bigint not null,public_text text not null,
 primary key(cycle_id,generation),check(octet_length(public_text)<=8192 and char_length(public_text)<=4000)
);
create table workflow_private.requests (
 id uuid primary key default gen_random_uuid(),room_id uuid not null,cycle_id uuid not null,generation bigint not null,
 device_id uuid not null,agent_id uuid not null,owner_id uuid not null,owner_alias text not null,session_alias text not null,
 binding_epoch bigint not null,revision bigint not null,kind text not null check(kind in ('ORIGIN','PEER','CONTINUATION','RESUME')),
 question_id uuid,public_text text not null,reply_text text,deadline timestamptz not null,
 state text not null default 'QUEUED' check(state in ('QUEUED','LEASED','RUNNING','UNKNOWN','COMPLETED','FAILED','INTERRUPTED','CANCELLED')),
 fence bigint not null default 0,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(cycle_id,id),foreign key(room_id,cycle_id) references workflow_private.cycles(room_id,id) on delete cascade,
 foreign key(cycle_id,generation) references workflow_private.generations(cycle_id,generation),
 check(octet_length(public_text)<=8192 and char_length(public_text)<=4000 and (reply_text is null or octet_length(reply_text)<=8192 and char_length(reply_text)<=4000))
);
create unique index workflow_one_continuation on workflow_private.requests(question_id) where kind='CONTINUATION';
create unique index workflow_one_peer on workflow_private.requests(question_id) where kind='PEER';
create table workflow_private.attempts (
 id uuid primary key default gen_random_uuid(),request_id uuid not null references workflow_private.requests(id) on delete cascade,
 fence bigint not null check(fence between 1 and 9007199254740991),state text not null check(state in ('LEASED','EXECUTING','UNKNOWN','COMPLETED','FAILED','INTERRUPTED','ABANDONED')),
 lease_expires_at timestamptz not null,start_intent_at timestamptz,terminal_text text,
 adoption text not null default 'PENDING' check(adoption in ('PENDING','ACCEPTED','HISTORICAL','HUMAN_INPUT_REQUIRED')),
 unique(request_id,fence),unique(request_id,id),check(state<>'EXECUTING' or start_intent_at is not null)
);
create unique index workflow_one_open_attempt on workflow_private.attempts(request_id) where state in ('LEASED','EXECUTING','UNKNOWN');
create table workflow_private.questions (
 id uuid primary key default gen_random_uuid(),cycle_id uuid not null references workflow_private.cycles(id) on delete cascade,
 origin_request_id uuid not null unique references workflow_private.requests(id) on delete cascade,
 generation bigint not null,revision bigint not null,origin_epoch bigint not null,peer_epoch bigint not null,
 public_text text not null,deadline timestamptz not null,answer_text text,
 adoption text not null default 'PENDING' check(adoption in ('PENDING','ACCEPTED','HISTORICAL','HUMAN_INPUT_REQUIRED')),
 check(octet_length(public_text)<=8192 and char_length(public_text)<=4000 and (answer_text is null or octet_length(answer_text)<=8192 and char_length(answer_text)<=4000))
);
create unique index workflow_one_pending_question on workflow_private.questions(cycle_id) where adoption='PENDING';
alter table workflow_private.requests add foreign key(question_id) references workflow_private.questions(id) deferrable initially deferred;
create table workflow_private.controls (
 id uuid primary key default gen_random_uuid(),request_id uuid not null,attempt_id uuid not null,fence bigint not null,
 state text not null default 'REQUESTED' check(state in ('REQUESTED','ACKNOWLEDGED')),
 foreign key(request_id,attempt_id) references workflow_private.attempts(request_id,id) on delete cascade,unique(attempt_id)
);
create table workflow_private.readiness (
 agent_id uuid primary key,room_id uuid not null references workflow_private.rooms(room_id) on delete cascade,
 device_id uuid not null,binding_epoch bigint not null,reported_ready boolean not null,valid_until timestamptz
);
create table workflow_private.receipts (
 room_id uuid not null references workflow_private.rooms(room_id) on delete cascade,actor_kind text not null check(actor_kind in ('human','device')),
 actor_id uuid not null,operation_id uuid not null,action text not null,payload_hash text not null,result jsonb not null,
 primary key(room_id,actor_kind,actor_id,operation_id)
);
create table public.workflow_events (
 event_id uuid primary key default gen_random_uuid(),room_id uuid not null references public.rooms(id) on delete cascade,
 sequence bigint not null,created_at timestamptz not null default clock_timestamp(),kind text not null check(kind in ('SPEECH','INVESTIGATION_STARTED','QUESTION','ANSWER','RUN_STATE','INTERRUPT_REQUESTED','INTERRUPT_ACKNOWLEDGED','ROOM_PAUSE_REQUESTED','ROOM_PAUSED','ROOM_RESUMED','INVESTIGATION_RESUMED','HUMAN_INPUT_REQUIRED')),
 sender_kind text not null check(sender_kind in ('HUMAN','AGENT','SYSTEM')),sender_alias text not null,public_text text not null default '',
 cycle_id uuid,request_id uuid,question_id uuid,reply_to uuid,room_revision bigint not null,binding_epoch bigint,agent_id uuid,
 request_kind text check(request_kind in ('ORIGIN','PEER','CONTINUATION','RESUME')),run_state text check(run_state in ('QUEUED','LEASED','RUNNING','UNKNOWN','COMPLETED','FAILED','INTERRUPTED','CANCELLED')),
 terminal text check(terminal in ('COMPLETED','FAILED','INTERRUPTED')),room_mode text check(room_mode in ('ACTIVE','PAUSING','PAUSED')),
 adoption text not null default 'NONE' check(adoption in ('NONE','PENDING','ACCEPTED','HISTORICAL','HUMAN_INPUT_REQUIRED')),
 unique(room_id,sequence),check(octet_length(public_text)<=8192 and char_length(public_text)<=4000),
 check((kind='RUN_STATE' and sender_kind='AGENT' and adoption='NONE' and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and run_state is not null and question_id is null and reply_to is null and room_mode is null and public_text='' and terminal is not distinct from case when run_state in ('COMPLETED','FAILED','INTERRUPTED') then run_state else null end)
 or (kind in ('QUESTION','ANSWER') and sender_kind='AGENT' and ((kind='QUESTION' and request_kind in ('ORIGIN','CONTINUATION','RESUME') and adoption='PENDING' and public_text<>'') or (kind='ANSWER' and request_kind='PEER' and adoption<>'NONE')) and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and question_id is not null and reply_to is not distinct from case when kind='ANSWER' then question_id else null end and run_state is null and terminal is null and room_mode is null)
 or (kind like 'ROOM_%' and room_mode=case when kind='ROOM_PAUSE_REQUESTED' then 'PAUSING' when kind='ROOM_PAUSED' then 'PAUSED' else 'ACTIVE' end and sender_kind=case when kind='ROOM_PAUSED' then 'SYSTEM' else 'HUMAN' end and adoption='NONE' and public_text='' and room_mode=case when kind='ROOM_PAUSE_REQUESTED' then 'PAUSING' when kind='ROOM_PAUSED' then 'PAUSED' else 'ACTIVE' end and cycle_id is null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null)
 or (kind='SPEECH' and sender_kind='HUMAN' and adoption='NONE' and public_text<>'' and cycle_id is null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind='SPEECH' and sender_kind='AGENT' and adoption in ('ACCEPTED','HISTORICAL') and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind in ('ORIGIN','CONTINUATION','RESUME') and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null and public_text<>'')
 or (kind in ('INVESTIGATION_STARTED','INVESTIGATION_RESUMED') and sender_kind='HUMAN' and adoption='NONE' and public_text<>'' and cycle_id is not null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind in ('INTERRUPT_REQUESTED','INTERRUPT_ACKNOWLEDGED') and sender_kind='AGENT' and adoption='NONE' and public_text='' and cycle_id is not null and request_id is not null and agent_id is not null and binding_epoch is not null and request_kind is not null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null)
 or (kind='HUMAN_INPUT_REQUIRED' and sender_kind='SYSTEM' and adoption='HUMAN_INPUT_REQUIRED' and public_text='' and cycle_id is not null and request_id is null and agent_id is null and binding_epoch is null and request_kind is null and question_id is null and reply_to is null and run_state is null and terminal is null and room_mode is null))
);
create table public.workflow_runs (
 request_id uuid primary key references workflow_private.requests(id) on delete cascade,room_id uuid not null references public.rooms(id) on delete cascade,
 cycle_id uuid not null,agent_id uuid not null,owner_alias text not null,session_alias text not null,request_kind text not null,
 room_revision bigint not null,binding_epoch bigint not null,state text not null,question_id uuid,created_at timestamptz not null,updated_at timestamptz not null
);
alter table public.workflow_events enable row level security;
alter table public.workflow_runs enable row level security;
create policy workflow_events_live_read on public.workflow_events for select to authenticated using(room_access_private.in_room(room_id));
create policy workflow_runs_live_read on public.workflow_runs for select to authenticated using(room_access_private.in_room(room_id));
revoke all on public.workflow_events,public.workflow_runs from public,anon,authenticated;
grant select on public.workflow_events,public.workflow_runs to authenticated;
create function workflow_private.text_trim(v text) returns text language sql immutable set search_path='' as $$
 select btrim(v,E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279));
$$;
create function workflow_private.validate(action text,b jsonb) returns void language plpgsql set search_path='' as $$
declare ks text[];k text;v text;
begin
 if b is null or jsonb_typeof(b)<>'object' then raise exception using message='INVALID_BODY',errcode='P0001';end if;
 if octet_length(b::text)>16384 then raise exception using message='BODY_TOO_LARGE',errcode='P0001';end if;
 ks:=case action when 'read' then array['roomId','afterSequence'] when 'speak' then array['roomId','operationId','publicText']
 when 'start' then array['roomId','operationId','originAgentId','peerAgentId','originEpoch','peerEpoch','expectedRoomRevision','publicText','confirmed']
 when 'interrupt' then array['roomId','operationId','agentId','bindingEpoch','expectedRoomRevision'] when 'pause' then array['roomId','operationId','expectedRoomRevision']
 when 'resume' then case when b->>'mode'='room' then array['roomId','operationId','mode','expectedRoomRevision'] else array['roomId','operationId','mode','cycleId','originAgentId','peerAgentId','originEpoch','peerEpoch','expectedRoomRevision','publicText','confirmed'] end
 when 'ready' then array['operationId','agentId','bindingEpoch','reportedReady'] when 'poll' then array['agentId','bindingEpoch'] when 'claim' then array['operationId','agentId','bindingEpoch','requestId']
 when 'question' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence','publicText','confirmed'] when 'complete' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence','terminal','publicText']
 when 'observe' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence','terminal','publicText'] when 'interrupt-ack' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence','controlId']
 when 'lease' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence'] when 'start-intent' then array['operationId','agentId','bindingEpoch','requestId','attemptId','fence'] else null end;
 if ks is null or b->'protocol'<>'1'::jsonb or not b ? 'protocol' or (select count(*) from jsonb_object_keys(b))<>cardinality(ks)+1 or not b ?& ks then raise exception using message='INVALID_BODY',errcode='P0001';end if;
 foreach k in array ks loop
 v:=b->>k;
 if v is null then raise exception using message='INVALID_BODY',errcode='P0001';end if;
 if k like '%Id' and (jsonb_typeof(b->k)<>'string' or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception using message='INVALID_BODY',errcode='P0001';end if;
 if k in ('bindingEpoch','originEpoch','peerEpoch','expectedRoomRevision','fence','afterSequence') and (jsonb_typeof(b->k)<>'number' or v !~ '^\d+$' or v::numeric>9007199254740991 or v::numeric<case when k='afterSequence' then 0 else 1 end) then raise exception using message='INVALID_BODY',errcode='P0001';end if;
 end loop;
 if b ? 'publicText' and (jsonb_typeof(b->'publicText')<>'string' or octet_length(b->>'publicText')>8192 or char_length(b->>'publicText')>4000 or (action in ('speak','start','resume','question') and workflow_private.text_trim(b->>'publicText')=''))
 or b ? 'confirmed' and b->'confirmed'<>'true'::jsonb or b ? 'reportedReady' and jsonb_typeof(b->'reportedReady')<>'boolean'
 or b ? 'terminal' and (b->>'terminal' not in ('COMPLETED','FAILED','INTERRUPTED') or b->>'terminal'<>'COMPLETED' and workflow_private.text_trim(b->>'publicText')<>'')
 or action='resume' and b->>'mode' not in ('room','cycle') or b ? 'originAgentId' and b->>'originAgentId'=b->>'peerAgentId' then raise exception using message='INVALID_BODY',errcode='P0001';end if;
end;$$;
create function workflow_private.lock_room(r uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 insert into workflow_private.rooms(room_id) values(r) on conflict do nothing;
 perform 1 from workflow_private.rooms where room_id=r for update;
 perform 1 from workflow_private.cycles where room_id=r order by id for update;
 perform 1 from workflow_private.requests where room_id=r order by id for update;
 perform 1 from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id where q.room_id=r order by a.id for update of a;
 perform 1 from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id where c.room_id=r order by q.id for update of q;
 perform 1 from workflow_private.controls c join workflow_private.requests q on q.id=c.request_id where q.room_id=r order by c.id for update of c;
 perform 1 from workflow_private.readiness where room_id=r order by agent_id for update;
 perform 1 from workflow_private.receipts where room_id=r order by actor_kind,actor_id,operation_id for update;
end;$$;
create function workflow_private.binding_live(a uuid,e bigint,r uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from device_binding_private.agents x join device_binding_private.devices d on d.id=x.device_id join device_binding_private.workspaces w on w.id=x.workspace_id where x.id=a and x.binding_epoch=e and x.room_id=r and x.state='active' and d.state='active' and w.state='active' and device_binding_private.live(x.owner_user_id,x.organization_id,r));
$$;
create function workflow_private.event(r uuid,k text,c uuid default null,q uuid default null,txt text default '',qid uuid default null,ad text default 'NONE',human uuid default null) returns public.workflow_events language plpgsql security definer set search_path='' as $$
declare s bigint;rv bigint;rm text;rq workflow_private.requests;ev public.workflow_events;sn text:='SYSTEM';sa text:='조정기';
begin
 update workflow_private.rooms set sequence=sequence+1 where room_id=r returning sequence,revision,mode into s,rv,rm;
 if q is not null then select * into rq from workflow_private.requests where id=q;sn:='AGENT';sa:=rq.session_alias;end if;
 if human is not null then sn:='HUMAN';select display_alias into sa from public.room_members where room_id=r and user_id=human;end if;
 insert into public.workflow_events(room_id,sequence,kind,sender_kind,sender_alias,public_text,cycle_id,request_id,question_id,reply_to,room_revision,binding_epoch,agent_id,request_kind,run_state,terminal,room_mode,adoption)
 values(r,s,k,sn,sa,txt,c,q,qid,case when k='ANSWER' then qid end,coalesce(rq.revision,rv),rq.binding_epoch,rq.agent_id,rq.kind,case when k='RUN_STATE' then rq.state end,case when k='RUN_STATE' and rq.state in ('COMPLETED','FAILED','INTERRUPTED') then rq.state end,case when k like 'ROOM_%' then rm end,ad) returning * into ev;return ev;
end;$$;
create function workflow_private.state(q uuid,s text) returns void language plpgsql security definer set search_path='' as $$
declare rq workflow_private.requests;
begin
 update workflow_private.requests set state=s,updated_at=clock_timestamp() where id=q returning * into rq;
 insert into public.workflow_runs values(rq.id,rq.room_id,rq.cycle_id,rq.agent_id,rq.owner_alias,rq.session_alias,rq.kind,rq.revision,rq.binding_epoch,rq.state,rq.question_id,rq.created_at,rq.updated_at)
 on conflict(request_id) do update set state=excluded.state,updated_at=excluded.updated_at;
 perform workflow_private.event(rq.room_id,'RUN_STATE',rq.cycle_id,rq.id);
end;$$;
create function workflow_private.control(q uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare a workflow_private.attempts;rq workflow_private.requests;cid uuid;
begin
 select * into rq from workflow_private.requests where id=q;select * into a from workflow_private.attempts where request_id=q and state in ('LEASED','EXECUTING','UNKNOWN') order by fence desc limit 1;
 if not found then return null;end if;
 if a.start_intent_at is null and a.state='LEASED' then update workflow_private.attempts set state='ABANDONED' where id=a.id;perform workflow_private.state(q,'CANCELLED');return null;end if;
 insert into workflow_private.controls(request_id,attempt_id,fence) values(q,a.id,a.fence) on conflict(attempt_id) do nothing returning id into cid;
 if cid is not null then perform workflow_private.event(rq.room_id,'INTERRUPT_REQUESTED',rq.cycle_id,q);else select id into cid from workflow_private.controls where attempt_id=a.id;end if;return cid;
end;$$;
create function workflow_private.human_required(c uuid,interrupt_agent uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare rq workflow_private.requests;rid uuid;oldstate text;pending workflow_private.questions;peer_request uuid;
begin
 select room_id,state into rid,oldstate from workflow_private.cycles where id=c;
 if oldstate='ACTIVE' then update workflow_private.cycles set state='HUMAN_INPUT_REQUIRED' where id=c;perform workflow_private.event(rid,'HUMAN_INPUT_REQUIRED',c,null,'',null,'HUMAN_INPUT_REQUIRED');end if;
 for pending in select * from workflow_private.questions where cycle_id=c and adoption='PENDING' order by id loop
  if pending.answer_text is not null then select id into peer_request from workflow_private.requests where question_id=pending.id and kind='PEER';perform workflow_private.event(rid,'ANSWER',c,peer_request,pending.answer_text,pending.id,'HISTORICAL');end if;
 end loop;
 update workflow_private.questions set adoption='HISTORICAL' where cycle_id=c and adoption='PENDING';
 update workflow_private.attempts a set adoption='HISTORICAL' from workflow_private.requests q where q.id=a.request_id and q.cycle_id=c and a.adoption='PENDING';
 for rq in select * from workflow_private.requests where cycle_id=c and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') order by id loop
 if rq.state='QUEUED' then perform workflow_private.state(rq.id,'CANCELLED');elsif interrupt_agent is null or rq.agent_id=interrupt_agent then perform workflow_private.control(rq.id);end if;
 end loop;
end;$$;
create function workflow_private.reconcile(r uuid) returns void language plpgsql security definer set search_path='' as $$
declare rq workflow_private.requests;a workflow_private.attempts;c workflow_private.cycles;rm text;
begin
 for rq in select * from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') order by id loop
 select * into a from workflow_private.attempts where request_id=rq.id and state in ('LEASED','EXECUTING','UNKNOWN') order by fence desc limit 1;
 if not workflow_private.binding_live(rq.agent_id,rq.binding_epoch,r) then
 if a.id is not null and (a.start_intent_at is not null or a.state='UNKNOWN') then update workflow_private.attempts set state='UNKNOWN',adoption='HISTORICAL' where id=a.id; if rq.state<>'UNKNOWN' then perform workflow_private.state(rq.id,'UNKNOWN');end if;perform workflow_private.control(rq.id);
 else if a.id is not null then update workflow_private.attempts set state='ABANDONED' where id=a.id;end if;perform workflow_private.state(rq.id,'CANCELLED');end if;
 perform workflow_private.human_required(rq.cycle_id);
 elsif a.id is not null and a.lease_expires_at<=clock_timestamp() and a.state in ('LEASED','EXECUTING') then
 if a.start_intent_at is null then update workflow_private.attempts set state='ABANDONED' where id=a.id;perform workflow_private.state(rq.id,'QUEUED');
 else update workflow_private.attempts set state='UNKNOWN' where id=a.id;perform workflow_private.state(rq.id,'UNKNOWN');perform workflow_private.human_required(rq.cycle_id);end if;
 end if;
 end loop;
 for c in select * from workflow_private.cycles where room_id=r and state='ACTIVE' order by id loop
 if c.deadline<=clock_timestamp() or not workflow_private.binding_live(c.origin_agent_id,c.origin_epoch,r) or not workflow_private.binding_live(c.peer_agent_id,c.peer_epoch,r) or c.revision<>(select revision from workflow_private.rooms where room_id=r)
 or exists(select 1 from workflow_private.questions where cycle_id=c.id and adoption='PENDING' and deadline<=clock_timestamp()) then perform workflow_private.human_required(c.id);end if;
 end loop;
 select mode into rm from workflow_private.rooms where room_id=r;
 if rm='PAUSING' and not exists(select 1 from workflow_private.requests where room_id=r and state in ('LEASED','RUNNING','UNKNOWN')) then update workflow_private.rooms set mode='PAUSED' where room_id=r;perform workflow_private.event(r,'ROOM_PAUSED');end if;
end;$$;
create function workflow_private.reserve(c uuid,a uuid,k text,txt text,q uuid default null,reply text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare cy workflow_private.cycles;ag device_binding_private.agents;owner_label text;rid uuid;dl timestamptz;
begin
 select * into cy from workflow_private.cycles where id=c;
 if cy.state<>'ACTIVE' or cy.runs_reserved>=11 or cy.deadline<=clock_timestamp() then perform workflow_private.human_required(c);return null;end if;
 select * into ag from device_binding_private.agents where id=a;select display_alias into owner_label from public.room_members where room_id=cy.room_id and user_id=ag.owner_user_id;
 if not workflow_private.binding_live(a,case when a=cy.origin_agent_id then cy.origin_epoch else cy.peer_epoch end,cy.room_id) then perform workflow_private.human_required(c);return null;end if;
 dl:=cy.deadline;if k='PEER' then select deadline into dl from workflow_private.questions where id=q;end if;
 update workflow_private.cycles set runs_reserved=runs_reserved+1 where id=c;
 insert into workflow_private.requests(room_id,cycle_id,generation,device_id,agent_id,owner_id,owner_alias,session_alias,binding_epoch,revision,kind,question_id,public_text,reply_text,deadline)
 values(cy.room_id,c,cy.generation,ag.device_id,a,ag.owner_user_id,owner_label,ag.session_alias,ag.binding_epoch,cy.revision,k,q,txt,reply,dl) returning id into rid;
 perform workflow_private.state(rid,'QUEUED');return rid;
end;$$;
create function workflow_private.advance(c uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare cy workflow_private.cycles;q workflow_private.questions;origin workflow_private.requests;peer workflow_private.requests;rid uuid;lastorigin workflow_private.requests;
begin
 select * into cy from workflow_private.cycles where id=c;
 if cy.state<>'ACTIVE' then return null;end if;
 select * into q from workflow_private.questions where cycle_id=c and adoption='PENDING';
 if q.id is not null then
 select * into origin from workflow_private.requests where id=q.origin_request_id;select * into peer from workflow_private.requests where question_id=q.id and kind='PEER';
 if q.generation<>cy.generation or q.revision<>cy.revision or q.deadline<=clock_timestamp() or not workflow_private.binding_live(cy.origin_agent_id,q.origin_epoch,cy.room_id) or not workflow_private.binding_live(cy.peer_agent_id,q.peer_epoch,cy.room_id) or (select revision from workflow_private.rooms where room_id=cy.room_id)<>q.revision then perform workflow_private.human_required(c);return null;end if;
 if origin.state in ('FAILED','INTERRUPTED','UNKNOWN','CANCELLED') or peer.state in ('FAILED','INTERRUPTED','UNKNOWN','CANCELLED') then perform workflow_private.human_required(c);return null;end if;
 if origin.state='COMPLETED' and peer.state='COMPLETED' and q.answer_text is not null and not exists(select 1 from workflow_private.requests where cycle_id=c and state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) then
 rid:=workflow_private.reserve(c,cy.origin_agent_id,'CONTINUATION',q.public_text,q.id,q.answer_text);
 if rid is not null then update workflow_private.questions set adoption='ACCEPTED' where id=q.id;update workflow_private.attempts set adoption='ACCEPTED' where request_id=peer.id;perform workflow_private.event(cy.room_id,'ANSWER',c,peer.id,q.answer_text,q.id,'ACCEPTED');end if;
 return rid;
 end if;return null;
 end if;
 select * into lastorigin from workflow_private.requests where cycle_id=c and generation=cy.generation and kind in ('ORIGIN','CONTINUATION','RESUME') order by created_at desc,id desc limit 1;
 if lastorigin.state='COMPLETED' and not exists(select 1 from workflow_private.requests where cycle_id=c and state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) and not exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.cycle_id=c and a.state in ('LEASED','EXECUTING','UNKNOWN')) then update workflow_private.cycles set state='COMPLETED' where id=c;end if;
 return null;
end;$$;
create function workflow_private.payload(q uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('requestId',id,'cycleId',cycle_id,'agentId',agent_id,'bindingEpoch',binding_epoch,'roomRevision',revision,'requestKind',kind,'questionId',question_id,'publicText',public_text,'replyText',reply_text,'deadline',deadline) from workflow_private.requests where id=q;
$$;
create function workflow_private.attempt(a uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('requestId',q.id,'attemptId',x.id,'agentId',q.agent_id,'bindingEpoch',q.binding_epoch,'fence',x.fence,'state',x.state,'leaseExpiresAt',x.lease_expires_at,'startIntentAt',x.start_intent_at,'payload',workflow_private.payload(q.id)) from workflow_private.attempts x join workflow_private.requests q on q.id=x.request_id where x.id=a;
$$;
create function workflow_private.event_json(e public.workflow_events) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('eventId',e.event_id,'roomId',e.room_id,'sequence',e.sequence,'createdAt',e.created_at,'kind',e.kind,'senderKind',e.sender_kind,'senderAlias',e.sender_alias,'publicText',e.public_text,'cycleId',e.cycle_id,'requestId',e.request_id,'questionId',e.question_id,'replyTo',e.reply_to,'roomRevision',e.room_revision,'bindingEpoch',e.binding_epoch,'agentId',e.agent_id,'requestKind',e.request_kind,'runState',e.run_state,'terminal',e.terminal,'roomMode',e.room_mode,'adoption',e.adoption);
$$;
create function workflow_private.history(r uuid,afterseq bigint,u uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rm workflow_private.rooms;cy workflow_private.cycles;ev jsonb;rr jsonb;bb jsonb;cursor bigint;
begin
 select * into rm from workflow_private.rooms where room_id=r;select * into cy from workflow_private.cycles where room_id=r and retired_at is null;
 select coalesce(jsonb_agg(workflow_private.event_json(x::public.workflow_events) order by x.sequence),'[]'::jsonb),coalesce(max(x.sequence),afterseq) into ev,cursor from (select * from public.workflow_events where room_id=r and sequence>afterseq order by sequence limit 16)x;
 select coalesce(jsonb_agg(jsonb_build_object('requestId',id,'cycleId',cycle_id,'agentId',agent_id,'ownerAlias',owner_alias,'sessionAlias',session_alias,'requestKind',kind,'roomRevision',revision,'bindingEpoch',binding_epoch,'state',state,'questionId',question_id,'createdAt',created_at,'updatedAt',updated_at) order by created_at,id),'[]'::jsonb) into rr from (select * from workflow_private.requests where room_id=r order by (state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) desc,(cycle_id=cy.id) desc,created_at desc,id desc limit 32)x;
 select coalesce(jsonb_agg(jsonb_build_object('agentId',x.id,'ownerAlias',x.display_alias,'sessionAlias',x.session_alias,'repositoryAlias',x.repository_alias,'runtime','codex','bindingEpoch',x.binding_epoch,'owned',x.owner_user_id=u,'reportedReady',coalesce(x.reported_ready and x.ready_epoch=x.binding_epoch and x.valid_until>clock_timestamp(),false),'validUntil',case when x.ready_epoch=x.binding_epoch then x.valid_until end) order by x.id),'[]'::jsonb) into bb
 from (select a.id,a.owner_user_id,a.session_alias,a.binding_epoch,m.display_alias,w.repository_alias,rd.reported_ready,rd.binding_epoch ready_epoch,rd.valid_until
 from device_binding_private.agents a join device_binding_private.workspaces w on w.id=a.workspace_id join public.room_members m on m.room_id=a.room_id and m.user_id=a.owner_user_id left join workflow_private.readiness rd on rd.agent_id=a.id
 where a.room_id=r and workflow_private.binding_live(a.id,a.binding_epoch,r)
 order by (a.id in (cy.origin_agent_id,cy.peer_agent_id)) desc,(a.owner_user_id=u) desc,a.id limit 20)x;
 return jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode,'events',ev,'runs',rr,'bindings',bb,'cycle',case when cy.id is null then null else jsonb_build_object('cycleId',cy.id,'originAgentId',cy.origin_agent_id,'peerAgentId',cy.peer_agent_id,'generation',cy.generation,'roomRevision',cy.revision,'originEpoch',cy.origin_epoch,'peerEpoch',cy.peer_epoch,'state',cy.state,'runsReserved',cy.runs_reserved,'peerRoundsReserved',cy.peer_rounds_reserved,'deadline',cy.deadline) end,'nextCursor',cursor,'highWaterSequence',rm.sequence,'hasMore',cursor<rm.sequence);
end;$$;
create function workflow_private.restore(action text,result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare cy workflow_private.cycles;a workflow_private.attempts;rid uuid;qid uuid;rm workflow_private.rooms;
begin
 if action in ('claim','start-intent','lease') then return workflow_private.attempt((result->>'attemptId')::uuid);end if;
 if action in ('complete','observe') then select * into a from workflow_private.attempts where id=(result->>'attemptId')::uuid;select question_id into qid from workflow_private.requests where id=a.request_id and kind='PEER';if qid is null then select id into qid from workflow_private.questions where origin_request_id=a.request_id;end if;select id into rid from workflow_private.requests where question_id=qid and kind='CONTINUATION';return result||jsonb_build_object('adoption',a.adoption,'continuationRequestId',rid);end if;
 if action in ('start','question') or action='resume' and result->>'cycleId' is not null then select * into cy from workflow_private.cycles where id=(result->>'cycleId')::uuid;return result||jsonb_build_object('cycleState',cy.state);end if;
 if action in ('pause','resume') then select * into rm from workflow_private.rooms where room_id=(result->>'roomId')::uuid;return result||jsonb_build_object('roomRevision',rm.revision,'roomMode',rm.mode);end if;
 if action='interrupt-ack' then return result||jsonb_build_object('state',(select state from workflow_private.controls where id=(result->>'controlId')::uuid));end if;
 return result;
end;$$;
create function workflow_private.human(action text,b jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();r uuid;o uuid;rm workflow_private.rooms;cy workflow_private.cycles;origin device_binding_private.agents;peer device_binding_private.agents;rq workflow_private.requests;ev public.workflow_events;op uuid;ph text;prev workflow_private.receipts;result jsonb;rid uuid;cid uuid;alias text;
begin
 perform workflow_private.validate(action,b);if b ? 'publicText' then b:=b||jsonb_build_object('publicText',workflow_private.text_trim(b->>'publicText'));end if;perform device_binding_private.guard();
 if u is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 r:=(b->>'roomId')::uuid;select organization_id into o from public.rooms where id=r;
 if o is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 perform device_binding_private.lock_scope(o,r);
 if not device_binding_private.live(u,o,r,action<>'read') then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 perform workflow_private.lock_room(r);perform workflow_private.reconcile(r);select * into rm from workflow_private.rooms where room_id=r;
 if action='read' then
 if (b->>'afterSequence')::bigint>rm.sequence then raise exception using message='CONFLICT',errcode='P0001';end if;
 return workflow_private.history(r,(b->>'afterSequence')::bigint,u);end if;
 if action in ('start','resume') and (action='start' or b->>'mode'='cycle') then
 select * into origin from device_binding_private.agents where id=(b->>'originAgentId')::uuid and room_id=r;
 select * into peer from device_binding_private.agents where id=(b->>'peerAgentId')::uuid and room_id=r;
 if origin.id is null or peer.id is null or origin.owner_user_id<>u or peer.owner_user_id=u then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if not workflow_private.binding_live(origin.id,(b->>'originEpoch')::bigint,r) or not workflow_private.binding_live(peer.id,(b->>'peerEpoch')::bigint,r) then raise exception using message='CONFLICT',errcode='P0001';end if;
 if action='resume' and not exists(select 1 from workflow_private.cycles where id=(b->>'cycleId')::uuid and room_id=r and origin_owner_id=u) then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 elsif action='interrupt' then
 if not exists(select 1 from device_binding_private.agents where id=(b->>'agentId')::uuid and owner_user_id=u and room_id=r and binding_epoch=(b->>'bindingEpoch')::bigint and state='active') then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 end if;
 op:=(b->>'operationId')::uuid;ph:=encode(extensions.digest(b::text,'sha256'),'hex');select * into prev from workflow_private.receipts where room_id=r and actor_kind='human' and actor_id=u and operation_id=op;
 if found then if prev.action<>action or prev.payload_hash<>ph then raise exception using message='CONFLICT',errcode='P0001';end if;return workflow_private.restore(action,prev.result);end if;
 if action<>'speak' and (b->>'expectedRoomRevision')::bigint<>rm.revision then raise exception using message='CONFLICT',errcode='P0001';end if;
 if action='speak' then ev:=workflow_private.event(r,'SPEECH',null,null,b->>'publicText',null,'NONE',u);result:=jsonb_build_object('eventId',ev.event_id,'sequence',ev.sequence);
 elsif action='start' or action='resume' and b->>'mode'='cycle' then
 if exists(select 1 from workflow_private.requests where room_id=r and state in ('LEASED','RUNNING','UNKNOWN')) or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.room_id=r and a.state in ('LEASED','EXECUTING','UNKNOWN')) then raise exception using message='CONFLICT',errcode='P0001';end if;
 if not exists(select 1 from workflow_private.readiness where agent_id=origin.id and binding_epoch=origin.binding_epoch and reported_ready and valid_until>clock_timestamp()) or not exists(select 1 from workflow_private.readiness where agent_id=peer.id and binding_epoch=peer.binding_epoch and reported_ready and valid_until>clock_timestamp()) then raise exception using message='CONFLICT',errcode='P0001';end if;
 select * into cy from workflow_private.cycles where room_id=r and retired_at is null;
 if action='start' then
 if rm.mode<>'ACTIVE' or cy.state='ACTIVE' or exists(select 1 from workflow_private.requests where room_id=r and state='QUEUED') then raise exception using message='CONFLICT',errcode='P0001';end if;
 if cy.id is not null then update workflow_private.cycles set retired_at=clock_timestamp() where id=cy.id;end if;
 insert into workflow_private.cycles(room_id,origin_agent_id,peer_agent_id,origin_owner_id,revision,origin_epoch,peer_epoch) values(r,origin.id,peer.id,u,rm.revision,origin.binding_epoch,peer.binding_epoch) returning * into cy;
 insert into workflow_private.generations values(cy.id,1,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText');
 rid:=workflow_private.reserve(cy.id,origin.id,'ORIGIN',b->>'publicText');perform workflow_private.event(r,'INVESTIGATION_STARTED',cy.id,null,b->>'publicText',null,'NONE',u);
 result:=jsonb_build_object('cycleId',cy.id,'requestId',rid,'accepted',rid is not null,'roomRevision',rm.revision,'cycleState',(select state from workflow_private.cycles where id=cy.id));
 else
 if cy.id is null or cy.id<>(b->>'cycleId')::uuid or cy.origin_owner_id<>u or cy.origin_agent_id<>origin.id or cy.peer_agent_id<>peer.id or cy.state<>'HUMAN_INPUT_REQUIRED' then raise exception using message='CONFLICT',errcode='P0001';end if;
 if cy.deadline<=clock_timestamp() or cy.runs_reserved>=11 or cy.peer_rounds_reserved>=5 then
 result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode,'cycleId',cy.id,'requestId',null,'accepted',false,'cycleState',cy.state);
 else
 update workflow_private.rooms set mode='ACTIVE' where room_id=r;update workflow_private.cycles set generation=generation+1,revision=rm.revision,origin_epoch=origin.binding_epoch,peer_epoch=peer.binding_epoch,state='ACTIVE' where id=cy.id returning * into cy;
 insert into workflow_private.generations values(cy.id,cy.generation,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText');rid:=workflow_private.reserve(cy.id,origin.id,'RESUME',b->>'publicText');perform workflow_private.event(r,'INVESTIGATION_RESUMED',cy.id,null,b->>'publicText',null,'NONE',u);
 result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode','ACTIVE','cycleId',cy.id,'requestId',rid,'accepted',rid is not null,'cycleState',(select state from workflow_private.cycles where id=cy.id));end if;
 end if;
 elsif action='interrupt' then
 select * into rq from workflow_private.requests where room_id=r and agent_id=(b->>'agentId')::uuid and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') order by created_at desc limit 1;
 if rq.id is null then result:=jsonb_build_object('controlId',null,'requestId',null,'state','NO_ACTIVE_RUN');else perform workflow_private.human_required(rq.cycle_id,rq.agent_id);if rq.state='QUEUED' then perform workflow_private.state(rq.id,'CANCELLED');else cid:=workflow_private.control(rq.id);end if;result:=jsonb_build_object('controlId',cid,'requestId',rq.id,'state','REQUESTED');end if;
 elsif action='pause' then
 update workflow_private.rooms set mode='PAUSING',revision=revision+1 where room_id=r;
 perform workflow_private.event(r,'ROOM_PAUSE_REQUESTED',null,null,'',null,'NONE',u);
 for cy in select * from workflow_private.cycles where room_id=r and retired_at is null loop perform workflow_private.human_required(cy.id);end loop;
 for rq in select * from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN') order by id loop if rq.state='QUEUED' then perform workflow_private.state(rq.id,'CANCELLED');else perform workflow_private.control(rq.id);end if;end loop;
 perform workflow_private.reconcile(r);select * into rm from workflow_private.rooms where room_id=r;result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode);
 elsif action='resume' and b->>'mode'='room' then
 if rm.mode='ACTIVE' or exists(select 1 from workflow_private.requests where room_id=r and state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.room_id=r and a.state in ('LEASED','EXECUTING','UNKNOWN')) then raise exception using message='CONFLICT',errcode='P0001';end if;
 update workflow_private.rooms set mode='ACTIVE' where room_id=r;perform workflow_private.event(r,'ROOM_RESUMED',null,null,'',null,'NONE',u);result:=jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode','ACTIVE','cycleId',null,'requestId',null,'accepted',true,'cycleState',null);
 else raise exception using message='NOT_FOUND',errcode='P0001';end if;
 insert into workflow_private.receipts values(r,'human',u,op,action,ph,result);return result;
end;$$;
create function workflow_private.device(action text,b jsonb,secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare h text;cred device_binding_private.credentials;d device_binding_private.devices;ag device_binding_private.agents;rm workflow_private.rooms;rd workflow_private.readiness;rq workflow_private.requests;at workflow_private.attempts;cy workflow_private.cycles;q workflow_private.questions;ctl workflow_private.controls;prev workflow_private.receipts;op uuid;ph text;result jsonb;rid uuid;aid uuid;ad text;queued uuid;peerid uuid;wasunknown boolean;
begin
 perform workflow_private.validate(action,b);if b ? 'publicText' then b:=b||jsonb_build_object('publicText',workflow_private.text_trim(b->>'publicText'));end if;perform device_binding_private.guard();
 if secret is null or secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 h:=encode(extensions.digest(secret,'sha256'),'hex');select * into cred from device_binding_private.credentials where hash=h;
 if cred.device_id is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 select * into d from device_binding_private.devices where id=cred.device_id;perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 select * into cred from device_binding_private.credentials where hash=h;select * into d from device_binding_private.devices where id=cred.device_id;
 if d.id is null or d.state<>'active' or d.current_hash<>h or cred.revoked_at is not null or cred.expires_at<=clock_timestamp() or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 select * into ag from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;
 if ag.id is null or ag.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(ag.id,ag.binding_epoch,d.room_id) then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 perform workflow_private.lock_room(d.room_id);perform workflow_private.reconcile(d.room_id);select * into rm from workflow_private.rooms where room_id=d.room_id;
 if action not in ('ready','poll') then
 select * into rq from workflow_private.requests where id=(b->>'requestId')::uuid and device_id=d.id and agent_id=ag.id and binding_epoch=ag.binding_epoch and room_id=d.room_id;
 if rq.id is null then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 if action<>'claim' then select * into at from workflow_private.attempts where id=(b->>'attemptId')::uuid and request_id=rq.id and fence=(b->>'fence')::bigint and fence=rq.fence;
 if at.id is null then raise exception using message='CONFLICT',errcode='P0001';end if;end if;
 end if;
 select * into rd from workflow_private.readiness where agent_id=ag.id;
 if action='poll' then
 select id into queued from workflow_private.requests where agent_id=ag.id and device_id=d.id and binding_epoch=ag.binding_epoch and state='QUEUED' order by created_at,id limit 1;
 select a.* into at from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.agent_id=ag.id and x.device_id=d.id and x.binding_epoch=ag.binding_epoch and a.state in ('LEASED','EXECUTING','UNKNOWN') order by x.created_at,a.fence desc limit 1;
 select * into ctl from workflow_private.controls where attempt_id=at.id;
 return jsonb_build_object('roomId',d.room_id,'roomRevision',rm.revision,'roomMode',rm.mode,'agentId',ag.id,'bindingEpoch',ag.binding_epoch,'reportedReady',coalesce(rd.reported_ready and rd.binding_epoch=ag.binding_epoch and rd.valid_until>clock_timestamp(),false),'validUntil',case when rd.binding_epoch=ag.binding_epoch then rd.valid_until end,'queuedRequest',workflow_private.payload(queued),'attempt',workflow_private.attempt(at.id),'control',case when ctl.id is null then null else jsonb_build_object('controlId',ctl.id,'requestId',ctl.request_id,'attemptId',ctl.attempt_id,'fence',ctl.fence,'state',ctl.state) end);
 end if;
 op:=(b->>'operationId')::uuid;ph:=encode(extensions.digest(b::text,'sha256'),'hex');select * into prev from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=op;
 if found then if prev.action<>action or prev.payload_hash<>ph then raise exception using message='CONFLICT',errcode='P0001';end if;return workflow_private.restore(action,prev.result);end if;
 if action='ready' then
 insert into workflow_private.readiness values(ag.id,d.room_id,d.id,ag.binding_epoch,(b->>'reportedReady')::boolean,case when (b->>'reportedReady')::boolean then clock_timestamp()+interval '60 seconds' end) on conflict(agent_id) do update set device_id=excluded.device_id,binding_epoch=excluded.binding_epoch,reported_ready=excluded.reported_ready,valid_until=excluded.valid_until returning * into rd;
 result:=jsonb_build_object('agentId',ag.id,'bindingEpoch',ag.binding_epoch,'reportedReady',rd.reported_ready,'validUntil',rd.valid_until,'verification','reported');
 elsif action='claim' then
 if rm.mode<>'ACTIVE' or rq.state<>'QUEUED' or rq.deadline<=clock_timestamp() or rq.revision<>rm.revision or not coalesce(rd.reported_ready and rd.binding_epoch=ag.binding_epoch and rd.valid_until>clock_timestamp(),false) or (select state from workflow_private.cycles where id=rq.cycle_id)<>'ACTIVE'
 or exists(select 1 from workflow_private.attempts a join workflow_private.requests x on x.id=a.request_id where x.device_id=d.id and x.agent_id=ag.id and a.state in ('LEASED','EXECUTING','UNKNOWN')) then raise exception using message='CONFLICT',errcode='P0001';end if;
 update workflow_private.requests set fence=fence+1 where id=rq.id returning * into rq;
 insert into workflow_private.attempts(request_id,fence,state,lease_expires_at) values(rq.id,rq.fence,'LEASED',clock_timestamp()+interval '30 seconds') returning id into aid;
 perform workflow_private.state(rq.id,'LEASED');result:=workflow_private.attempt(aid);
 elsif action in ('start-intent','lease') then
 if at.state not in ('LEASED','EXECUTING') or at.lease_expires_at<=clock_timestamp() or rq.revision<>rm.revision or rm.mode<>'ACTIVE' or (select state from workflow_private.cycles where id=rq.cycle_id)<>'ACTIVE' then raise exception using message='CONFLICT',errcode='P0001';end if;
 if action='start-intent' then if at.state<>'LEASED' then raise exception using message='CONFLICT',errcode='P0001';end if;update workflow_private.attempts set state='EXECUTING',start_intent_at=clock_timestamp() where id=at.id;perform workflow_private.state(rq.id,'RUNNING');
 else update workflow_private.attempts set lease_expires_at=clock_timestamp()+interval '30 seconds' where id=at.id;end if;
 result:=workflow_private.attempt(at.id);
 elsif action='question' then
 select * into cy from workflow_private.cycles where id=rq.cycle_id;
 if at.state<>'EXECUTING' or at.start_intent_at is null or at.lease_expires_at<=clock_timestamp() or rq.kind='PEER' or rq.agent_id<>cy.origin_agent_id or rq.generation<>cy.generation or cy.state<>'ACTIVE' or rq.revision<>rm.revision or rm.mode<>'ACTIVE' or not workflow_private.binding_live(cy.origin_agent_id,cy.origin_epoch,d.room_id) or not workflow_private.binding_live(cy.peer_agent_id,cy.peer_epoch,d.room_id) or exists(select 1 from workflow_private.questions where origin_request_id=rq.id or cycle_id=cy.id and adoption='PENDING') then raise exception using message='CONFLICT',errcode='P0001';end if;
 if cy.peer_rounds_reserved>=5 or cy.runs_reserved>=11 or cy.deadline<=clock_timestamp() then perform workflow_private.human_required(cy.id);result:=jsonb_build_object('cycleId',cy.id,'questionId',null,'peerRequestId',null,'accepted',false,'cycleState','HUMAN_INPUT_REQUIRED');
 else
 update workflow_private.cycles set peer_rounds_reserved=peer_rounds_reserved+1 where id=cy.id;
 insert into workflow_private.questions(cycle_id,origin_request_id,generation,revision,origin_epoch,peer_epoch,public_text,deadline) values(cy.id,rq.id,cy.generation,cy.revision,cy.origin_epoch,cy.peer_epoch,b->>'publicText',least(cy.deadline,clock_timestamp()+interval '120 seconds')) returning * into q;
 peerid:=workflow_private.reserve(cy.id,cy.peer_agent_id,'PEER',q.public_text,q.id);if peerid is not null then perform workflow_private.event(d.room_id,'QUESTION',cy.id,rq.id,q.public_text,q.id,'PENDING');end if;result:=jsonb_build_object('cycleId',cy.id,'questionId',case when peerid is not null then q.id end,'peerRequestId',peerid,'accepted',peerid is not null,'cycleState',(select state from workflow_private.cycles where id=cy.id));end if;
 elsif action in ('complete','observe') then
 wasunknown:=at.state='UNKNOWN';
 if action='complete' and (at.state<>'EXECUTING' or at.start_intent_at is null or at.lease_expires_at<=clock_timestamp()) or action='observe' and at.state<>'UNKNOWN' then raise exception using message='CONFLICT',errcode='P0001';end if;
 select * into cy from workflow_private.cycles where id=rq.cycle_id;ad:=case when wasunknown then 'HISTORICAL' when cy.state='ACTIVE' and rq.generation=cy.generation and rq.revision=rm.revision and workflow_private.binding_live(cy.origin_agent_id,cy.origin_epoch,d.room_id) and workflow_private.binding_live(cy.peer_agent_id,cy.peer_epoch,d.room_id) and cy.deadline>clock_timestamp() then case when rq.kind='PEER' then 'PENDING' else 'ACCEPTED' end else 'HISTORICAL' end;
 if b->>'terminal'<>'COMPLETED' then ad:=case when ad='HISTORICAL' then 'HISTORICAL' else 'HUMAN_INPUT_REQUIRED' end;end if;
 update workflow_private.attempts set state=b->>'terminal',terminal_text=b->>'publicText',adoption=ad where id=at.id;perform workflow_private.state(rq.id,b->>'terminal');
 if rq.kind='PEER' then
 select * into q from workflow_private.questions where id=rq.question_id;
 if q.adoption<>'PENDING' or q.deadline<=clock_timestamp() then ad:='HISTORICAL';update workflow_private.attempts set adoption=ad where id=at.id;end if;
 update workflow_private.questions set answer_text=b->>'publicText',adoption=case when ad='PENDING' and b->>'terminal'='COMPLETED' then 'PENDING' else 'HISTORICAL' end where id=q.id;
 perform workflow_private.event(d.room_id,'ANSWER',cy.id,rq.id,b->>'publicText',q.id,ad);
 end if;
 if wasunknown or b->>'terminal'<>'COMPLETED' or ad='HISTORICAL' then perform workflow_private.human_required(cy.id);else rid:=workflow_private.advance(cy.id);end if;
 perform workflow_private.reconcile(d.room_id);select adoption into ad from workflow_private.attempts where id=at.id;
 if rq.kind in ('ORIGIN','CONTINUATION','RESUME') and b->>'terminal'='COMPLETED' and b->>'publicText'<>'' then perform workflow_private.event(d.room_id,'SPEECH',cy.id,rq.id,b->>'publicText',null,case when ad='ACCEPTED' then 'ACCEPTED' else 'HISTORICAL' end);end if;
 result:=jsonb_build_object('requestId',rq.id,'attemptId',at.id,'terminal',b->>'terminal','adoption',ad,'continuationRequestId',rid);
 elsif action='interrupt-ack' then
 select * into ctl from workflow_private.controls where id=(b->>'controlId')::uuid and request_id=rq.id and attempt_id=at.id and fence=at.fence;
 if ctl.id is null then raise exception using message='CONFLICT',errcode='P0001';end if;
 if ctl.state<>'ACKNOWLEDGED' then update workflow_private.controls set state='ACKNOWLEDGED' where id=ctl.id;perform workflow_private.event(d.room_id,'INTERRUPT_ACKNOWLEDGED',rq.cycle_id,rq.id);end if;result:=jsonb_build_object('controlId',ctl.id,'requestId',rq.id,'attemptId',at.id,'fence',at.fence,'state','ACKNOWLEDGED');
 else raise exception using message='NOT_FOUND',errcode='P0001';end if;
 insert into workflow_private.receipts values(d.room_id,'device',d.id,op,action,ph,result);return result;
end;$$;
create or replace function device_binding_private.cancel(u uuid,o uuid,r uuid,d uuid,removed boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare wf_room uuid;
begin
 update device_binding_private.pairings set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and state='approved' and (d is null or device_id=d);
 update device_binding_private.devices set state=case when removed then 'removed' else 'revoked' end,current_hash=null
 where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or id=d) and state<>'removed';
 update device_binding_private.credentials set revoked_at=coalesce(revoked_at,clock_timestamp()) where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
 update device_binding_private.workspaces set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
 update device_binding_private.agents set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
 -- Existing callers already hold guard and the affected scope locks.
 for wf_room in select room_id from workflow_private.rooms where room_id in (select id from public.rooms where organization_id=o and (r is null or id=r)) order by room_id loop
  perform workflow_private.lock_room(wf_room);perform workflow_private.reconcile(wf_room);
 end loop;
end; $$;

create or replace function public.connector_replace(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare h text;d device_binding_private.devices;cred device_binding_private.credentials;a device_binding_private.agents;
begin
 perform device_binding_private.guard();perform device_binding_private.validate('replace',p_body);
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 h:=encode(extensions.digest(p_secret,'sha256'),'hex');select * into cred from device_binding_private.credentials where hash=h;
 if cred.device_id is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 select * into d from device_binding_private.devices where id=cred.device_id;perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 select * into cred from device_binding_private.credentials where hash=h;select * into d from device_binding_private.devices where id=cred.device_id;
 if d.id is null or d.state<>'active' or d.current_hash<>h or cred.revoked_at is not null or cred.expires_at<=clock_timestamp() or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 select * into a from device_binding_private.agents where id=(p_body->>'agentId')::uuid and device_id=d.id and state='active';
 if a.id is null then raise exception using message='NOT_FOUND',errcode='P0001';end if;
 -- The original connector validates replay identity and never performs a new replacement.
 if a.replacement_operation=(p_body->>'operationId')::uuid then return device_binding_private.connector('replace',p_body,h);end if;
 perform workflow_private.lock_room(d.room_id);perform workflow_private.reconcile(d.room_id);
 if exists(select 1 from workflow_private.requests where device_id=d.id and agent_id=a.id and state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) or exists(select 1 from workflow_private.attempts x join workflow_private.requests q on q.id=x.request_id where q.device_id=d.id and q.agent_id=a.id and x.state in ('LEASED','EXECUTING','UNKNOWN')) then raise exception using message='CONFLICT',errcode='P0001';end if;
 delete from workflow_private.readiness where agent_id=a.id;
 return device_binding_private.connector('replace',p_body,h);
end;$$;
create function public.workflow_human_read(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('read',p_body); $$;
revoke all on function public.workflow_human_read(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_read(jsonb) to authenticated;
create function public.workflow_human_speak(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('speak',p_body); $$;
revoke all on function public.workflow_human_speak(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_speak(jsonb) to authenticated;
create function public.workflow_human_start(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('start',p_body); $$;
revoke all on function public.workflow_human_start(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_start(jsonb) to authenticated;
create function public.workflow_human_interrupt(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('interrupt',p_body); $$;
revoke all on function public.workflow_human_interrupt(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_interrupt(jsonb) to authenticated;
create function public.workflow_human_pause(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('pause',p_body); $$;
revoke all on function public.workflow_human_pause(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_pause(jsonb) to authenticated;
create function public.workflow_human_resume(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.human('resume',p_body); $$;
revoke all on function public.workflow_human_resume(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_resume(jsonb) to authenticated;
create function public.workflow_device_ready(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('ready',p_body,p_secret); $$;
revoke all on function public.workflow_device_ready(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_ready(jsonb,text) to anon;
create function public.workflow_device_poll(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('poll',p_body,p_secret); $$;
revoke all on function public.workflow_device_poll(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_poll(jsonb,text) to anon;
create function public.workflow_device_claim(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('claim',p_body,p_secret); $$;
revoke all on function public.workflow_device_claim(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_claim(jsonb,text) to anon;
create function public.workflow_device_start_intent(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('start-intent',p_body,p_secret); $$;
revoke all on function public.workflow_device_start_intent(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_start_intent(jsonb,text) to anon;
create function public.workflow_device_lease(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('lease',p_body,p_secret); $$;
revoke all on function public.workflow_device_lease(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_lease(jsonb,text) to anon;
create function public.workflow_device_question(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('question',p_body,p_secret); $$;
revoke all on function public.workflow_device_question(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_question(jsonb,text) to anon;
create function public.workflow_device_complete(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('complete',p_body,p_secret); $$;
revoke all on function public.workflow_device_complete(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_complete(jsonb,text) to anon;
create function public.workflow_device_interrupt_ack(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('interrupt-ack',p_body,p_secret); $$;
revoke all on function public.workflow_device_interrupt_ack(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_interrupt_ack(jsonb,text) to anon;
create function public.workflow_device_observe(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$ select workflow_private.device('observe',p_body,p_secret); $$;
revoke all on function public.workflow_device_observe(jsonb,text) from public,anon,authenticated;
grant execute on function public.workflow_device_observe(jsonb,text) to anon;
revoke all on all tables in schema workflow_private from public,anon,authenticated;
revoke all on all functions in schema workflow_private from public,anon,authenticated;
commit;
