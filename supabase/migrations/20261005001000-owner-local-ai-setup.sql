begin;
-- Preserve original migrations and the DIRECT history wrapper.
alter table device_binding_private.agents drop constraint agents_runtime_check;
alter table device_binding_private.agents add constraint agents_runtime_check check(runtime in ('codex','claude'));
create or replace function device_binding_private.validate(action text,b jsonb) returns void language plpgsql set search_path='' as $$
declare keys text[]; k text;
begin
 keys:=case action
 when 'begin' then array['codeHash','proofHash','deviceAlias','protocol'] when 'pairing-status' then array['pairingId']
 when 'exchange' then array['pairingId','operationId','credentialHash','confirmed'] when 'rotate' then array['operationId','credentialHash']
 when 'approve' then array['code','organizationId','roomId','confirmed'] when 'revoke' then array['deviceId'] when 'remove' then array['deviceId']
 when 'workspace' then array['operationId','repositoryAlias','branch','commit','dirty']
 when 'agent' then array['operationId','workspaceId','sessionAlias','runtime']
 when 'replace' then array['operationId','agentId','expectedEpoch','repositoryAlias','branch','commit','dirty','sessionAlias','runtime']
 when 'heartbeat' then array[]::text[] when 'bindings' then array[]::text[] else null end;
 if keys is null or b is null or jsonb_typeof(b)<>'object' then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 if (select count(*) from jsonb_object_keys(b))<>cardinality(keys) or exists(select 1 from jsonb_object_keys(b) x where not(x=any(keys))) then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 foreach k in array keys loop
 if k in ('protocol','expectedEpoch') then
  if jsonb_typeof(b->k)<>'number' or (k='protocol' and b->>k<>'1') or (k='expectedEpoch' and (b->>k !~ '^[1-9][0-9]{0,14}$')) then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 elsif k='confirmed' then
  if b->k is distinct from 'true'::jsonb then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 else
  if jsonb_typeof(b->k)<>'string' then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
  if k like '%Id' and b->>k !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
  if k in ('code','codeHash','proofHash','credentialHash') and b->>k !~ '^[a-f0-9]{64}$' then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
  if k in ('deviceAlias','sessionAlias','repositoryAlias') and not device_binding_private.alias_ok(b->>k) then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 end if;
 end loop;
 if action='begin' and b->>'codeHash'=b->>'proofHash' or action in ('workspace','replace') and not coalesce(device_binding_private.metadata_ok(b),false)
 or action in ('agent','replace') and b->>'runtime' not in ('codex','claude') then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
end; $$;
create or replace function device_binding_private.connector(action text,b jsonb,s text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p device_binding_private.pairings%rowtype; d device_binding_private.devices%rowtype; c device_binding_private.credentials%rowtype;
 w device_binding_private.workspaces%rowtype; a device_binding_private.agents%rowtype; op uuid; ph text; result jsonb; t timestamptz; old_epoch bigint;
begin
 perform device_binding_private.guard();
 perform device_binding_private.validate(action,b);
 if action='begin' then
  t:=clock_timestamp();
  perform 1 from public.organizations where id in (select organization_id from device_binding_private.pairings where state='approved' and expires_at<=t) order by id for update;
  perform 1 from public.rooms where id in (select room_id from device_binding_private.pairings where state='approved' and expires_at<=t) order by id for update;
  perform 1 from public.organization_members where organization_id in (select organization_id from device_binding_private.pairings where state='approved' and expires_at<=t) order by user_id,organization_id for update;
  perform 1 from public.room_members where room_id in (select room_id from device_binding_private.pairings where state='approved' and expires_at<=t) order by room_id,user_id for update;
  perform 1 from device_binding_private.pairings where state in ('pending','approved') and expires_at<=t order by id for update;
  update device_binding_private.pairings set state='expired' where state in ('pending','approved') and expires_at<=t;
  if (select count(*) from device_binding_private.pairings where state in ('pending','approved') and expires_at>clock_timestamp())>=50 then raise exception using message='QUOTA',errcode='P0001'; end if;
  insert into device_binding_private.secret_hashes(hash,kind) values(b->>'codeHash','code'),(b->>'proofHash','proof');
  t:=clock_timestamp();
  insert into device_binding_private.pairings(code_hash,proof_hash,device_alias,created_at,expires_at) values(b->>'codeHash',b->>'proofHash',b->>'deviceAlias',t,t+interval '5 minutes') returning * into p;
  return jsonb_build_object('protocol',1,'pairingId',p.id,'expiresAt',p.expires_at);
 end if;
 if s is null or s !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 if action in ('pairing-status','exchange') then
  select * into p from device_binding_private.pairings where id=(b->>'pairingId')::uuid and proof_hash=s;
  if not found then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
  if p.organization_id is not null then perform device_binding_private.lock_scope(p.organization_id,p.room_id); end if;
  select * into p from device_binding_private.pairings where id=p.id for update;
  if not found then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
  if action='pairing-status' then
   if p.state in ('approved','exchanged') and not device_binding_private.live(p.owner_user_id,p.organization_id,p.room_id) then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
   result:=jsonb_build_object('protocol',1,'pairingId',p.id,'state',case when p.state in ('pending','approved') and p.expires_at<=clock_timestamp() then 'expired' else p.state end,'expiresAt',p.expires_at);
   if p.state='approved' and p.expires_at>clock_timestamp() then result:=result||jsonb_build_object('scope',(select jsonb_build_object('ownerAlias',m.display_alias,'organizationId',o.id,'organizationName',o.name,'roomId',r.id,'roomTitle',r.title,'deviceAlias',p.device_alias) from public.organizations o join public.rooms r on r.organization_id=o.id join public.room_members m on m.room_id=r.id where o.id=p.organization_id and r.id=p.room_id and m.user_id=p.owner_user_id)); end if;
   return result;
  end if;
  op:=(b->>'operationId')::uuid;
  if p.state='exchanged' then
   select * into d from device_binding_private.devices where id=p.device_id;
   select * into c from device_binding_private.credentials where hash=p.credential_hash;
   if p.operation_id=op and p.credential_hash=b->>'credentialHash' and p.completed_at+interval '2 minutes'>clock_timestamp()
    and d.state='active' and d.current_hash=c.hash and c.revoked_at is null and c.expires_at>clock_timestamp()
    and device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then return jsonb_build_object('protocol',1,'deviceId',d.id,'expiresAt',c.expires_at); end if;
   raise exception using message='CONFLICT',errcode='P0001';
  end if;
  if p.state<>'approved' or p.expires_at<=clock_timestamp() then raise exception using message='CONFLICT',errcode='P0001'; end if;
  if not device_binding_private.live(p.owner_user_id,p.organization_id,p.room_id) then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
  if (select count(*) from device_binding_private.devices where owner_user_id=p.owner_user_id and organization_id=p.organization_id and room_id=p.room_id and state='active')>=10 then raise exception using message='QUOTA',errcode='P0001'; end if;
  insert into device_binding_private.secret_hashes values(b->>'credentialHash','credential');
  insert into device_binding_private.devices(owner_user_id,organization_id,room_id,device_alias,current_hash) values(p.owner_user_id,p.organization_id,p.room_id,p.device_alias,b->>'credentialHash') returning * into d;
  t:=clock_timestamp();
  insert into device_binding_private.credentials(hash,device_id,owner_user_id,organization_id,room_id,created_at,expires_at) values(d.current_hash,d.id,d.owner_user_id,d.organization_id,d.room_id,t,t+interval '1 hour') returning * into c;
  update device_binding_private.pairings set state='exchanged',device_id=d.id,operation_id=op,credential_hash=c.hash,completed_at=clock_timestamp() where id=p.id;
  perform device_binding_private.audit(d.organization_id,d.room_id,d.owner_user_id,'device',d.id,p.id,'exchange');
  return jsonb_build_object('protocol',1,'deviceId',d.id,'expiresAt',c.expires_at);
 end if;
 select * into c from device_binding_private.credentials where hash=s;
 if not found then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 select * into d from device_binding_private.devices where id=c.device_id;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 select * into d from device_binding_private.devices where id=c.device_id;
 select * into c from device_binding_private.credentials where hash=s;
 if d.state<>'active' or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 if action='rotate' then
  op:=(b->>'operationId')::uuid;
  if d.rotation_operation=op and d.rotation_hash=b->>'credentialHash' and d.rotation_previous_hash=s
   and d.rotation_completed_at+interval '2 minutes'>clock_timestamp() and d.current_hash=d.rotation_hash
   and exists(select 1 from device_binding_private.credentials where hash=d.current_hash and revoked_at is null and expires_at>clock_timestamp()) then
   return jsonb_build_object('protocol',1,'deviceId',d.id,'expiresAt',(select expires_at from device_binding_private.credentials where hash=d.current_hash));
  end if;
 end if;
 if d.current_hash<>s or c.revoked_at is not null or c.expires_at<=clock_timestamp() then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 if action='rotate' then
  insert into device_binding_private.operations values(d.id,op,'rotate');
  insert into device_binding_private.secret_hashes values(b->>'credentialHash','credential');
  t:=clock_timestamp();
  insert into device_binding_private.credentials(hash,device_id,owner_user_id,organization_id,room_id,created_at,expires_at) values(b->>'credentialHash',d.id,d.owner_user_id,d.organization_id,d.room_id,t,t+interval '1 hour') returning * into c;
  update device_binding_private.credentials set revoked_at=clock_timestamp() where hash=s;
  update device_binding_private.devices set current_hash=c.hash,rotation_operation=op,rotation_hash=c.hash,rotation_previous_hash=s,rotation_completed_at=clock_timestamp() where id=d.id;
  perform device_binding_private.audit(d.organization_id,d.room_id,d.owner_user_id,'device',d.id,null,'rotate');
  return jsonb_build_object('protocol',1,'deviceId',d.id,'expiresAt',c.expires_at);
 elsif action='heartbeat' then
  t:=clock_timestamp(); update device_binding_private.devices set last_seen_at=t where id=d.id;
  return jsonb_build_object('protocol',1,'state','registered','verification','unverified','lastSeenAt',t);
 elsif action='bindings' then return jsonb_build_object('protocol',1,'bindings',device_binding_private.bindings(d.id,null));
 end if;
 op:=(b->>'operationId')::uuid; ph:=encode(extensions.digest((b-'operationId')::text,'sha256'),'hex');
 if action='workspace' then
  select * into w from device_binding_private.workspaces where device_id=d.id and registration_operation=op;
  if found then
   if w.registration_payload_hash=ph and w.registration_credential_hash=s and w.state='active' and w.registration_completed_at+interval '2 minutes'>clock_timestamp()
    and w.repository_alias=b->>'repositoryAlias' and w.branch=b->>'branch' and w.commit_hash=b->>'commit'
    and not exists(select 1 from device_binding_private.agents where workspace_id=w.id and binding_epoch<>1) then return jsonb_build_object('protocol',1,'workspaceId',w.id); end if;
   raise exception using message='CONFLICT',errcode='P0001';
  end if;
  if (select count(*) from device_binding_private.workspaces where device_id=d.id and state='active')>=2 then raise exception using message='QUOTA',errcode='P0001'; end if;
  insert into device_binding_private.workspaces(device_id,owner_user_id,organization_id,room_id,repository_alias,branch,commit_hash,dirty,registration_operation,registration_payload_hash,registration_credential_hash)
   values(d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'repositoryAlias',b->>'branch',b->>'commit','unknown',op,ph,s) returning * into w;
  result:=jsonb_build_object('protocol',1,'workspaceId',w.id);
 elsif action='agent' then
  select * into a from device_binding_private.agents where device_id=d.id and registration_operation=op;
  if found then
   if a.registration_payload_hash=ph and a.registration_credential_hash=s and a.state='active' and a.registration_completed_at+interval '2 minutes'>clock_timestamp() and a.binding_epoch=a.registration_epoch
    and exists(select 1 from device_binding_private.workspaces where id=a.workspace_id and state='active') then
    return jsonb_build_object('protocol',1,'agentId',a.id,'workspaceId',a.workspace_id,'bindingEpoch',a.binding_epoch,'state','registered','verification','unverified'); end if;
   raise exception using message='CONFLICT',errcode='P0001';
  end if;
  select * into w from device_binding_private.workspaces where id=(b->>'workspaceId')::uuid and device_id=d.id and state='active';
  if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
  if (select count(*) from device_binding_private.agents where owner_user_id=d.owner_user_id and organization_id=d.organization_id and room_id=d.room_id and state='active')>=2 then raise exception using message='QUOTA',errcode='P0001'; end if;
  insert into device_binding_private.agents(workspace_id,device_id,owner_user_id,organization_id,room_id,session_alias,runtime,registration_operation,registration_payload_hash,registration_credential_hash)
   values(w.id,d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'sessionAlias',b->>'runtime',op,ph,s) returning * into a;
  result:=jsonb_build_object('protocol',1,'agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch,'state','registered','verification','unverified');
 elsif action='replace' then
  select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and state='active';
  if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
  select * into w from device_binding_private.workspaces where id=a.workspace_id and device_id=d.id and state='active';
  if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
  if a.replacement_operation=op then
   if a.replacement_payload_hash=ph and a.replacement_credential_hash=s and a.replacement_completed_at+interval '2 minutes'>clock_timestamp() and a.binding_epoch=a.replacement_epoch then
    return jsonb_build_object('protocol',1,'agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch,'state','registered','verification','unverified'); end if;
   raise exception using message='CONFLICT',errcode='P0001';
  end if;
  old_epoch:=(b->>'expectedEpoch')::bigint;
  if a.binding_epoch<>old_epoch then raise exception using message='CONFLICT',errcode='P0001'; end if;
  update device_binding_private.workspaces set repository_alias=b->>'repositoryAlias',branch=b->>'branch',commit_hash=b->>'commit' where id=w.id;
  update device_binding_private.agents set session_alias=b->>'sessionAlias',runtime=b->>'runtime',binding_epoch=binding_epoch+1,replacement_operation=op,replacement_payload_hash=ph,replacement_credential_hash=s,replacement_completed_at=clock_timestamp(),replacement_epoch=binding_epoch+1 where id=a.id returning * into a;
  result:=jsonb_build_object('protocol',1,'agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch,'state','registered','verification','unverified');
 else raise exception using message='NOT_FOUND',errcode='P0001'; end if;
 insert into device_binding_private.operations values(d.id,op,action);
 perform device_binding_private.audit(d.organization_id,d.room_id,d.owner_user_id,'device',d.id,null,action);
 return result;
exception when unique_violation then raise exception using message='CONFLICT',errcode='P0001';
end; $$;
create or replace function workflow_private.history_006(r uuid,afterseq bigint,u uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare rm workflow_private.rooms;cy workflow_private.cycles;ev jsonb;rr jsonb;bb jsonb;cursor bigint;
begin
 select * into rm from workflow_private.rooms where room_id=r;select * into cy from workflow_private.cycles where room_id=r and retired_at is null;
 select coalesce(jsonb_agg(workflow_private.event_json(x::public.workflow_events) order by x.sequence),'[]'::jsonb),coalesce(max(x.sequence),afterseq) into ev,cursor from (select * from public.workflow_events where room_id=r and sequence>afterseq order by sequence limit 16)x;
 select coalesce(jsonb_agg(jsonb_build_object('requestId',id,'cycleId',cycle_id,'agentId',agent_id,'ownerAlias',owner_alias,'sessionAlias',session_alias,'requestKind',kind,'roomRevision',revision,'bindingEpoch',binding_epoch,'state',state,'questionId',question_id,'createdAt',created_at,'updatedAt',updated_at) order by created_at,id),'[]'::jsonb) into rr from (select * from workflow_private.requests where room_id=r order by (state in ('QUEUED','LEASED','RUNNING','UNKNOWN')) desc,(cycle_id=cy.id) desc,created_at desc,id desc limit 32)x;
 select coalesce(jsonb_agg(jsonb_build_object('agentId',x.id,'ownerAlias',x.display_alias,'sessionAlias',x.session_alias,'repositoryAlias',x.repository_alias,'runtime',x.runtime,'bindingEpoch',x.binding_epoch,'owned',x.owner_user_id=u,'reportedReady',coalesce(x.reported_ready and x.ready_epoch=x.binding_epoch and x.valid_until>clock_timestamp(),false),'validUntil',case when x.ready_epoch=x.binding_epoch then x.valid_until end) order by x.id),'[]'::jsonb) into bb
 from (select a.id,a.owner_user_id,a.runtime,a.session_alias,a.binding_epoch,m.display_alias,w.repository_alias,rd.reported_ready,rd.binding_epoch ready_epoch,rd.valid_until
 from device_binding_private.agents a join device_binding_private.workspaces w on w.id=a.workspace_id join public.room_members m on m.room_id=a.room_id and m.user_id=a.owner_user_id left join workflow_private.readiness rd on rd.agent_id=a.id
 where a.room_id=r and workflow_private.binding_live(a.id,a.binding_epoch,r)
 order by (a.id in (cy.origin_agent_id,cy.peer_agent_id)) desc,(a.owner_user_id=u) desc,a.id limit 20)x;
 return jsonb_build_object('roomId',r,'roomRevision',rm.revision,'roomMode',rm.mode,'events',ev,'runs',rr,'bindings',bb,'cycle',case when cy.id is null then null else jsonb_build_object('cycleId',cy.id,'originAgentId',cy.origin_agent_id,'peerAgentId',cy.peer_agent_id,'generation',cy.generation,'roomRevision',cy.revision,'originEpoch',cy.origin_epoch,'peerEpoch',cy.peer_epoch,'state',cy.state,'runsReserved',cy.runs_reserved,'peerRoundsReserved',cy.peer_rounds_reserved,'deadline',cy.deadline) end,'nextCursor',cursor,'highWaterSequence',rm.sequence,'hasMore',cursor<rm.sequence);
end;$$;

create schema runtime_settings_private;
revoke all on schema runtime_settings_private from public,anon,authenticated;
create table runtime_settings_private.configurations (
 device_id uuid primary key references device_binding_private.devices(id) on delete cascade,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 catalog jsonb, applied jsonb
);
create table runtime_settings_private.operations (
 device_id uuid not null references device_binding_private.devices(id) on delete cascade,
 operation_id uuid not null, expected_revision bigint not null,
 state text not null check(state in ('REQUESTED','LOCAL_CONFIRMATION','APPLYING','COMMITTED','APPLIED','CANCELLED','FAILED','UNKNOWN')),
 requested jsonb not null, folder_body jsonb not null, selection_body jsonb, apply_body jsonb,
 receipt jsonb, local_receipt jsonb, failure_receipts jsonb not null default '{}'::jsonb, commit_body jsonb, committed_receipt jsonb, applied_receipt jsonb,
 reserved_epoch bigint, agent_id uuid, workspace_id uuid, created_at timestamptz not null default clock_timestamp(),
 primary key(device_id,operation_id)
);
create unique index runtime_settings_one_active on runtime_settings_private.operations(device_id)
 where state not in ('APPLIED','CANCELLED') or (state='CANCELLED' and applied_receipt is null);
alter table runtime_settings_private.configurations enable row level security;
alter table runtime_settings_private.operations enable row level security;

create function runtime_settings_private.fail(code text) returns void language plpgsql set search_path='' as $$
begin raise exception using message=code,errcode='P0001';end;$$;
create function runtime_settings_private.id_ok(v text) returns boolean language sql immutable set search_path='' as $$
 select coalesce(v ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false);
$$;
create function runtime_settings_private.text_ok(v text) returns boolean language sql immutable set search_path='' as $$
 select coalesce(v ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$' and position('..' in v)=0 and v !~* '^[a-f0-9-]{36}$' and v !~* '^[a-f0-9]{24,}$' and v !~* '^sk-' and v !~* '(token|secret|credential|bearer)',false);
$$;
create function runtime_settings_private.keys(b jsonb,k text[]) returns boolean language sql immutable set search_path='' as $$
 select case when jsonb_typeof(b)='object' then (select count(*) from jsonb_object_keys(b))=cardinality(k) and not exists(select 1 from jsonb_object_keys(b) x where not(x=any(k))) else false end;
$$;
create function runtime_settings_private.canonical(b jsonb) returns text language plpgsql immutable set search_path='' as $$
declare result text;
begin
 if jsonb_typeof(b)='object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||runtime_settings_private.canonical(value),',' order by key collate "C"),'')||'}' into result from jsonb_each(b);
 elsif jsonb_typeof(b)='array' then select '['||coalesce(string_agg(runtime_settings_private.canonical(value),',' order by ordinality),'')||']' into result from jsonb_array_elements(b) with ordinality;
 else result:=b::text;end if;
 return result;
end;$$;
create function runtime_settings_private.catalog_ok(b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare m jsonb; defaults jsonb;
begin
 if not runtime_settings_private.keys(b,array['runtime','version','models','defaultSettings','snapshotHash','policy']) or octet_length(b::text)>16384
 or jsonb_typeof(b->'runtime')<>'string' or jsonb_typeof(b->'version')<>'string' or jsonb_typeof(b->'snapshotHash')<>'string' or jsonb_typeof(b->'policy')<>'string'
 or b->>'runtime' not in ('codex','claude') or not runtime_settings_private.text_ok(b->>'version') or b->>'snapshotHash' !~ '^[a-f0-9]{64}$'
 or b->>'policy' not in ('verified','unsupported') or jsonb_typeof(b->'models')<>'array' or jsonb_array_length(b->'models')>256 then return false;end if;
 for m in select value from jsonb_array_elements(b->'models') loop
 if not runtime_settings_private.keys(m,array['id','model','efforts','defaultEffort','isDefault']) or not runtime_settings_private.text_ok(m->>'id') or not runtime_settings_private.text_ok(m->>'model')
 or jsonb_typeof(m->'id')<>'string' or jsonb_typeof(m->'model')<>'string' or jsonb_typeof(m->'defaultEffort') not in ('string','null')
 or jsonb_typeof(m->'efforts')<>'array' or jsonb_array_length(m->'efforts')>12 or jsonb_typeof(m->'isDefault')<>'boolean'
 or exists(select 1 from jsonb_array_elements(m->'efforts') e where jsonb_typeof(e)<>'string' or not runtime_settings_private.text_ok(e#>>'{}'))
 or (select count(*) from jsonb_array_elements(m->'efforts'))<>(select count(distinct value) from jsonb_array_elements(m->'efforts'))
 or (b->>'runtime'='codex' and (jsonb_array_length(m->'efforts')=0 or m->'defaultEffort'='null'::jsonb))
 or (m->'defaultEffort'<>'null'::jsonb and (jsonb_typeof(m->'defaultEffort')<>'string' or not (m->'efforts' ? (m->>'defaultEffort')))) then return false;end if;
 end loop;
 if encode(extensions.digest(runtime_settings_private.canonical(b-'snapshotHash'),'sha256'),'hex')<>b->>'snapshotHash' then return false;end if;
 if (select count(*) from jsonb_array_elements(b->'models'))<>(select count(distinct value->>'id') from jsonb_array_elements(b->'models'))
 or (select count(*) from jsonb_array_elements(b->'models'))<>(select count(distinct value->>'model') from jsonb_array_elements(b->'models'))
 or (select count(*) from jsonb_array_elements(b->'models') m where m->'isDefault'='true'::jsonb)>1 then return false;end if;
 defaults:=b->'defaultSettings';
 if defaults<>'null'::jsonb then
 if not runtime_settings_private.keys(defaults,array['model','effort']) or jsonb_typeof(defaults->'model')<>'string' or jsonb_typeof(defaults->'effort') not in ('string','null') or not exists(select 1 from jsonb_array_elements(b->'models') m where m->>'model'=defaults->>'model' and ((defaults->'effort'='null'::jsonb and b->>'runtime'='claude' and jsonb_array_length(m->'efforts')=0) or (defaults->'effort'<>'null'::jsonb and m->'efforts' ? (defaults->>'effort')))) then return false;end if;
 end if;
 return b->>'policy'<>'unsupported' or (jsonb_array_length(b->'models')=0 and defaults='null'::jsonb);
exception when others then return false;
end;$$;
create function runtime_settings_private.validate(action text,b jsonb) returns void language plpgsql set search_path='' as $$
declare k text[]; field text;
begin
 k:=case action when 'list' then array['deviceId'] when 'cancel' then array['operationId','deviceId'] when 'poll' then array[]::text[]
 when 'select-folder' then array['operationId','deviceId','expectedConfigRevision','runtime']
 when 'select-runtime' then array['operationId','deviceId','expectedConfigRevision','runtime','model','effort','snapshotHash']
 when 'apply' then array['operationId','deviceId','expectedConfigRevision','runtime','model','effort','snapshotHash','localRootReference','repositoryAlias','sessionAlias','expectedEpoch']
 when 'receipt' then array['operationId','state','configRevision','runtime','model','effort','snapshotHash','localRootReference','repositoryAlias','sessionAlias','catalog','bindingEpoch','agentId','workspaceId'] end;
 if action in ('list','poll') and b ? 'operationId' then k:=k||array['operationId'];end if;
 if k is null or not runtime_settings_private.keys(b,k) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if octet_length(b::text)>16384 then perform runtime_settings_private.fail('BODY_TOO_LARGE');end if;
 foreach field in array k loop
 if field in ('operationId','deviceId') and (jsonb_typeof(b->field)<>'string' or not runtime_settings_private.id_ok(b->>field)) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('expectedConfigRevision','configRevision') and (jsonb_typeof(b->field)<>'number' or b->>field !~ '^(0|[1-9][0-9]{0,15})$' or (b->>field)::numeric>9007199254740991) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('bindingEpoch','expectedEpoch') and b->field<>'null'::jsonb and (jsonb_typeof(b->field)<>'number' or b->>field !~ '^[1-9][0-9]{0,15}$' or (b->>field)::numeric>9007199254740991) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('runtime','model','snapshotHash','localRootReference','repositoryAlias','sessionAlias','agentId','workspaceId') and (action<>'receipt' or b->field<>'null'::jsonb) then
 if jsonb_typeof(b->field)<>'string' then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='runtime' and b->>field not in ('codex','claude') then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='model' and not runtime_settings_private.text_ok(b->>field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='snapshotHash' and b->>field !~ '^[a-f0-9]{64}$' then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('localRootReference','agentId','workspaceId') and not runtime_settings_private.id_ok(b->>field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('repositoryAlias','sessionAlias') and not coalesce(device_binding_private.alias_ok(b->>field),false) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 end if;
 if field='effort' and b->field<>'null'::jsonb and (jsonb_typeof(b->field)<>'string' or not runtime_settings_private.text_ok(b->>field)) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='catalog' and b->field<>'null'::jsonb and not runtime_settings_private.catalog_ok(b->field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 end loop;
 if action='receipt' and (jsonb_typeof(b->'state')<>'string' or b->>'state' not in ('LOCAL_CONFIRMATION','COMMITTED','APPLIED','FAILED','UNKNOWN','CANCELLED')) then perform runtime_settings_private.fail('INVALID_BODY');end if;
end;$$;
create function runtime_settings_private.selection(b jsonb,c jsonb) returns void language plpgsql set search_path='' as $$
begin
 if not coalesce(runtime_settings_private.catalog_ok(c),false) or c->>'policy'<>'verified' or c->>'runtime'<>b->>'runtime' or c->>'snapshotHash'<>b->>'snapshotHash' then perform runtime_settings_private.fail('CONFLICT');end if;
 if not exists(select 1 from jsonb_array_elements(c->'models') m where m->>'model'=b->>'model' and ((b->>'runtime'='claude' and b->'effort'='null'::jsonb and jsonb_array_length(m->'efforts')=0) or (b->'effort'<>'null'::jsonb and m->'efforts' ? (b->>'effort')))) then perform runtime_settings_private.fail('INVALID_BODY');end if;
end;$$;
create function runtime_settings_private.candidate_receipt_ok(o runtime_settings_private.operations,b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if b->>'runtime' is distinct from o.folder_body->>'runtime' then return false;end if;
 if o.apply_body is not null then
 return (b-array['operationId','state','configRevision','catalog','bindingEpoch','agentId','workspaceId'])=(o.apply_body-array['operationId','deviceId','expectedConfigRevision','expectedEpoch']);
 end if;
 if b->'model'<>'null'::jsonb or b->'effort'<>'null'::jsonb or b->'snapshotHash'<>'null'::jsonb or b->'sessionAlias'<>'null'::jsonb then return false;end if;
 if (b->'localRootReference'='null'::jsonb)<>(b->'repositoryAlias'='null'::jsonb) then return false;end if;
 if o.local_receipt is not null then
 return b->'localRootReference'=o.local_receipt->'localRootReference' and b->'repositoryAlias'=o.local_receipt->'repositoryAlias';
 end if;
 if o.receipt is not null and o.receipt->'localRootReference'<>'null'::jsonb then
 return b->'localRootReference'=o.receipt->'localRootReference' and b->'repositoryAlias'=o.receipt->'repositoryAlias';
 end if;
 return true;
end;$$;
create function runtime_settings_private.live_device(secret text) returns device_binding_private.devices language plpgsql security definer set search_path='' as $$
declare h text; d device_binding_private.devices; c device_binding_private.credentials;
begin
 perform device_binding_private.guard();
 if secret is null or secret !~ '^[a-f0-9]{64}$' then perform runtime_settings_private.fail('UNAUTHENTICATED');end if;
 h:=encode(extensions.digest(secret,'sha256'),'hex');select * into c from device_binding_private.credentials where hash=h;
 select * into d from device_binding_private.devices where id=c.device_id;
 if d.id is null then perform runtime_settings_private.fail('UNAUTHENTICATED');end if;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 select * into c from device_binding_private.credentials where hash=h;select * into d from device_binding_private.devices where id=d.id;
 if d.state<>'active' or d.current_hash<>h or c.revoked_at is not null or c.expires_at<=clock_timestamp() or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then perform runtime_settings_private.fail('UNAUTHENTICATED');end if;
 perform workflow_private.lock_room(d.room_id);
 return d;
end;$$;
create function runtime_settings_private.idle(d uuid) returns boolean language sql stable security definer set search_path='' as $$
 with related as (
 select c.id from workflow_private.cycles c where c.origin_agent_id in (select id from device_binding_private.agents where device_id=d)
 or c.peer_agent_id in (select id from device_binding_private.agents where device_id=d)
 or exists(select 1 from workflow_private.requests q where q.cycle_id=c.id and q.device_id=d)
 )
 select not exists(select 1 from workflow_private.cycles c join related r on r.id=c.id where c.retired_at is null and (c.state='ACTIVE' or (c.mode='AI_PAIR' and c.state='HUMAN_INPUT_REQUIRED' and c.deadline>clock_timestamp() and c.runs_reserved<11 and c.peer_rounds_reserved<5)))
 and not exists(select 1 from workflow_private.requests q join related r on r.id=q.cycle_id where q.state in ('QUEUED','LEASED','RUNNING','UNKNOWN'))
 and not exists(select 1 from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id join related r on r.id=q.cycle_id where a.state in ('LEASED','EXECUTING','UNKNOWN') or (a.adoption='PENDING' and a.state in ('COMPLETED','FAILED','INTERRUPTED')))
 and not exists(select 1 from workflow_private.controls ctl join workflow_private.requests q on q.id=ctl.request_id join related r on r.id=q.cycle_id where ctl.state='REQUESTED')
 and not exists(select 1 from workflow_private.questions q join related r on r.id=q.cycle_id where q.adoption='PENDING');
$$;
create function runtime_settings_private.reserved(d uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from runtime_settings_private.operations where device_id=d and (state in ('APPLYING','COMMITTED') or (state in ('UNKNOWN','FAILED') and apply_body is not null) or (state='CANCELLED' and applied_receipt is null)));
$$;
create function runtime_settings_private.response(d uuid,op uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare c runtime_settings_private.configurations; o runtime_settings_private.operations; result jsonb; current_binding boolean; active_binding jsonb;
begin
 select * into c from runtime_settings_private.configurations where device_id=d;
 if (select count(*) from device_binding_private.agents where device_id=d and state='active')>1 then perform runtime_settings_private.fail('CONFLICT');end if;
 select jsonb_build_object('agentId',a.id,'workspaceId',a.workspace_id,'bindingEpoch',a.binding_epoch,'runtime',a.runtime) into active_binding from device_binding_private.agents a join device_binding_private.workspaces w on w.id=a.workspace_id where a.device_id=d and a.state='active' and w.state='active';
 select * into o from runtime_settings_private.operations where device_id=d and (op is null and (state not in ('APPLIED','CANCELLED') or (state='CANCELLED' and applied_receipt is null)) or operation_id=op) order by created_at desc limit 1;
 current_binding:=case when coalesce(o.committed_receipt,c.applied) is null then true else exists(select 1 from device_binding_private.agents a where a.id=(coalesce(o.committed_receipt,c.applied)->>'agentId')::uuid and a.state='active' and a.binding_epoch=(coalesce(o.committed_receipt,c.applied)->>'bindingEpoch')::bigint) end;
 result:=jsonb_build_object('protocol',1,'deviceId',d,'configRevision',coalesce(c.revision,0),'catalog',c.catalog,'operation',case when o.operation_id is null then null else jsonb_build_object('operationId',o.operation_id,'deviceId',d,'expectedConfigRevision',o.expected_revision,'state',o.state,'requested',o.requested,'receipt',case when o.receipt is null then null else o.receipt||jsonb_build_object('catalog',null) end) end,'applied',c.applied,'current',current_binding,'currentBinding',active_binding);
 if octet_length(result::text)>16200 then perform runtime_settings_private.fail('UNAVAILABLE');end if;
 return result;
end;$$;
create function public.runtime_settings_human(p_action text,p_body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; d device_binding_private.devices; c runtime_settings_private.configurations; o runtime_settings_private.operations; a device_binding_private.agents;
begin
 perform device_binding_private.guard();perform runtime_settings_private.validate(p_action,p_body);
 if p_action not in ('list','select-folder','select-runtime','apply','cancel') then perform runtime_settings_private.fail('NOT_FOUND');end if;
 u:=room_access_private.actor();
 select * into d from device_binding_private.devices where id=(p_body->>'deviceId')::uuid;
 if d.id is null then perform runtime_settings_private.fail('NOT_FOUND');end if;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 u:=room_access_private.actor();select * into d from device_binding_private.devices where id=d.id;
 if d.owner_user_id<>u or not device_binding_private.live(u,d.organization_id,d.room_id) then perform runtime_settings_private.fail('FORBIDDEN');end if;
 if d.state<>'active' or not exists(select 1 from device_binding_private.credentials where hash=d.current_hash and revoked_at is null and expires_at>clock_timestamp()) then perform runtime_settings_private.fail('CONFLICT');end if;
 perform workflow_private.lock_room(d.room_id);
 insert into runtime_settings_private.configurations(device_id) values(d.id) on conflict do nothing;
 select * into c from runtime_settings_private.configurations where device_id=d.id for update;
 if p_action='list' then return runtime_settings_private.response(d.id,(p_body->>'operationId')::uuid);end if;
 select * into o from runtime_settings_private.operations where device_id=d.id and operation_id=(p_body->>'operationId')::uuid for update;
 if p_action='select-folder' then
 if o.operation_id is not null then
 if o.folder_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if c.revision<>(p_body->>'expectedConfigRevision')::bigint or exists(select 1 from runtime_settings_private.operations where device_id=d.id and (state not in ('APPLIED','CANCELLED') or (state='CANCELLED' and applied_receipt is null))) then perform runtime_settings_private.fail('CONFLICT');end if;
 insert into runtime_settings_private.operations(device_id,operation_id,expected_revision,state,requested,folder_body) values(d.id,(p_body->>'operationId')::uuid,c.revision,'REQUESTED',p_body,p_body) returning * into o;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if o.operation_id is null then perform runtime_settings_private.fail('NOT_FOUND');end if;
 if p_action='cancel' then
 if o.state='CANCELLED' then return runtime_settings_private.response(d.id,o.operation_id);end if;
 if o.state in ('COMMITTED','APPLIED') or (o.state in ('UNKNOWN','FAILED') and o.apply_body is not null) then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state='CANCELLED' where device_id=d.id and operation_id=o.operation_id;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if p_action='select-runtime' and o.selection_body is not null then
 if o.selection_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 if p_action='apply' and o.apply_body is not null then
 if o.apply_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 if o.state<>'LOCAL_CONFIRMATION' or o.expected_revision<>c.revision or o.expected_revision<>(p_body->>'expectedConfigRevision')::bigint then perform runtime_settings_private.fail('CONFLICT');end if;
 if p_body->>'runtime'<>o.folder_body->>'runtime' then perform runtime_settings_private.fail('CONFLICT');end if;
 perform runtime_settings_private.selection(p_body,c.catalog);
 if p_action='select-runtime' then
 update runtime_settings_private.operations set selection_body=p_body,requested=p_body where device_id=d.id and operation_id=o.operation_id;
 else
 if o.selection_body is null or (p_body-array['localRootReference','repositoryAlias','sessionAlias','expectedEpoch'])<>o.selection_body or o.receipt->>'localRootReference'<>p_body->>'localRootReference' or o.receipt->>'repositoryAlias'<>p_body->>'repositoryAlias' then perform runtime_settings_private.fail('CONFLICT');end if;
 if not runtime_settings_private.idle(d.id) then perform runtime_settings_private.fail('CONFLICT');end if;
 if (select count(*) from device_binding_private.agents where device_id=d.id and state='active')>1 then perform runtime_settings_private.fail('CONFLICT');end if;
 select * into a from device_binding_private.agents where device_id=d.id and state='active';
 if (a.id is null and p_body->'expectedEpoch'<>'null'::jsonb) or (a.id is not null and p_body->'expectedEpoch' is distinct from to_jsonb(a.binding_epoch)) then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state='APPLYING',apply_body=p_body,requested=p_body,reserved_epoch=a.binding_epoch,agent_id=a.id,workspace_id=a.workspace_id where device_id=d.id and operation_id=o.operation_id;
 delete from workflow_private.readiness where device_id=d.id;
 end if;
 return runtime_settings_private.response(d.id,o.operation_id);
end;$$;

create function runtime_settings_private.commit_binding(d device_binding_private.devices,o runtime_settings_private.operations,b jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a device_binding_private.agents; w device_binding_private.workspaces; receipt jsonb; next_revision bigint; ph text;
begin
 if o.committed_receipt is not null then
 if o.commit_body<>b then perform runtime_settings_private.fail('CONFLICT');end if;
 return o.committed_receipt;end if;
 if o.state not in ('APPLYING','UNKNOWN') or o.apply_body is null then perform runtime_settings_private.fail('CONFLICT');end if;
 select revision+1 into next_revision from runtime_settings_private.configurations where device_id=d.id and revision=o.expected_revision for update;
 if next_revision is null or next_revision>9007199254740991 or b->'configRevision'<>to_jsonb(next_revision) or not runtime_settings_private.idle(d.id) then perform runtime_settings_private.fail('CONFLICT');end if;
 perform runtime_settings_private.selection(o.apply_body,(select catalog from runtime_settings_private.configurations where device_id=d.id));
 if b->'catalog'<>'null'::jsonb or (b-array['operationId','state','configRevision','catalog','bindingEpoch','agentId','workspaceId'])<>(o.apply_body-array['operationId','deviceId','expectedConfigRevision','expectedEpoch']) then perform runtime_settings_private.fail('CONFLICT');end if;
 ph:=encode(extensions.digest(o.apply_body::text,'sha256'),'hex');
 if o.agent_id is null then
 if b->'bindingEpoch'<>'1'::jsonb or b->'agentId'<>'null'::jsonb or b->'workspaceId'<>'null'::jsonb then perform runtime_settings_private.fail('CONFLICT');end if;
 if (select count(*) from device_binding_private.agents where owner_user_id=d.owner_user_id and organization_id=d.organization_id and room_id=d.room_id and state='active')>=2 or (select count(*) from device_binding_private.workspaces where device_id=d.id and state='active')>=2 then perform runtime_settings_private.fail('QUOTA');end if;
 insert into device_binding_private.workspaces(device_id,owner_user_id,organization_id,room_id,repository_alias,branch,commit_hash,dirty,registration_operation,registration_payload_hash,registration_credential_hash)
 values(d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'repositoryAlias','unknown','unknown','unknown',o.operation_id,ph,d.current_hash) returning * into w;
 insert into device_binding_private.agents(workspace_id,device_id,owner_user_id,organization_id,room_id,session_alias,runtime,registration_operation,registration_payload_hash,registration_credential_hash)
 values(w.id,d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'sessionAlias',b->>'runtime',o.operation_id,ph,d.current_hash) returning * into a;
 else
 select * into a from device_binding_private.agents where id=o.agent_id and device_id=d.id and state='active' and binding_epoch=o.reserved_epoch for update;
 if a.id is null or b->'bindingEpoch'<>to_jsonb(o.reserved_epoch+1) or b->'agentId'<>to_jsonb(o.agent_id) or b->'workspaceId'<>to_jsonb(o.workspace_id) then perform runtime_settings_private.fail('CONFLICT');end if;
 update device_binding_private.workspaces set repository_alias=b->>'repositoryAlias',branch='unknown',commit_hash='unknown' where id=a.workspace_id and state='active' returning * into w;
 if w.id is null then perform runtime_settings_private.fail('CONFLICT');end if;
 update device_binding_private.agents set session_alias=b->>'sessionAlias',runtime=b->>'runtime',binding_epoch=binding_epoch+1,replacement_operation=o.operation_id,replacement_payload_hash=ph,replacement_credential_hash=d.current_hash,replacement_completed_at=clock_timestamp(),replacement_epoch=binding_epoch+1 where id=a.id returning * into a;
 end if;
 receipt:=b||jsonb_build_object('agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch);
 update runtime_settings_private.configurations set revision=next_revision where device_id=d.id;
 update runtime_settings_private.operations set state='COMMITTED',receipt=receipt,commit_body=b,committed_receipt=receipt,agent_id=a.id,workspace_id=w.id where device_id=d.id and operation_id=o.operation_id;
 delete from workflow_private.readiness where device_id=d.id;
 return receipt;
end;$$;
create function public.runtime_settings_device(p_action text,p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices; c runtime_settings_private.configurations; o runtime_settings_private.operations; receipt jsonb;
begin
 perform runtime_settings_private.validate(p_action,p_body);
 if p_action not in ('poll','receipt') then perform runtime_settings_private.fail('NOT_FOUND');end if;
 d:=runtime_settings_private.live_device(p_secret);
 insert into runtime_settings_private.configurations(device_id) values(d.id) on conflict do nothing;
 select * into c from runtime_settings_private.configurations where device_id=d.id for update;
 if p_action='poll' then return runtime_settings_private.response(d.id,(p_body->>'operationId')::uuid);end if;
 select * into o from runtime_settings_private.operations where device_id=d.id and operation_id=(p_body->>'operationId')::uuid for update;
 if o.operation_id is null then perform runtime_settings_private.fail('NOT_FOUND');end if;
 if p_body->>'state'='COMMITTED' then
 receipt:=runtime_settings_private.commit_binding(d,o,p_body);
 elsif p_body->>'state'='APPLIED' then
 if o.applied_receipt is not null then
 if o.applied_receipt<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 elsif o.state<>'COMMITTED' or o.committed_receipt is null or (p_body-'state')<>(o.committed_receipt-'state') or c.revision<>(p_body->>'configRevision')::bigint or not exists(select 1 from device_binding_private.agents where id=o.agent_id and state='active' and binding_epoch=(p_body->>'bindingEpoch')::bigint) then perform runtime_settings_private.fail('CONFLICT');
 else
 update runtime_settings_private.operations set state='APPLIED',receipt=p_body,applied_receipt=p_body where device_id=d.id and operation_id=o.operation_id;
 update runtime_settings_private.configurations set applied=p_body where device_id=d.id;
 end if;
 elsif p_body->>'state'='CANCELLED' then
 if o.applied_receipt is not null then
 if o.applied_receipt<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 -- Only this live-device receipt attests exact owned candidate cleanup. Human cancellation alone never proves cleanup.
 if o.state not in ('CANCELLED','UNKNOWN','FAILED') or o.committed_receipt is not null or p_body->'configRevision'<>to_jsonb(c.revision) or p_body->'catalog'<>'null'::jsonb or p_body->'bindingEpoch'<>'null'::jsonb or p_body->'agentId'<>'null'::jsonb or p_body->'workspaceId'<>'null'::jsonb then perform runtime_settings_private.fail('CONFLICT');end if;
 if not runtime_settings_private.candidate_receipt_ok(o,p_body) then perform runtime_settings_private.fail('CONFLICT');end if;
 if o.applied_receipt is not null and o.applied_receipt<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state='CANCELLED',receipt=p_body,applied_receipt=p_body where device_id=d.id and operation_id=o.operation_id;
 elsif p_body->>'state'='LOCAL_CONFIRMATION' then
 if o.local_receipt is not null then
 if o.local_receipt<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 elsif o.state<>'REQUESTED' or p_body->>'runtime' is distinct from o.folder_body->>'runtime' or p_body->'catalog'->>'runtime' is distinct from o.folder_body->>'runtime' or p_body->'model'<>'null'::jsonb or p_body->'effort'<>'null'::jsonb or p_body->'snapshotHash'<>'null'::jsonb or p_body->'sessionAlias'<>'null'::jsonb or p_body->'configRevision'<>to_jsonb(c.revision) or p_body->'localRootReference'='null'::jsonb or p_body->'repositoryAlias'='null'::jsonb or p_body->'catalog'='null'::jsonb or p_body->'bindingEpoch'<>'null'::jsonb or p_body->'agentId'<>'null'::jsonb or p_body->'workspaceId'<>'null'::jsonb then perform runtime_settings_private.fail('CONFLICT');
 else
 update runtime_settings_private.configurations set catalog=p_body->'catalog' where device_id=d.id;
 update runtime_settings_private.operations set state='LOCAL_CONFIRMATION',receipt=p_body,local_receipt=p_body where device_id=d.id and operation_id=o.operation_id;
 end if;
 else
 if o.failure_receipts ? (p_body->>'state') then
 if o.failure_receipts->(p_body->>'state')<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 if o.state in ('COMMITTED','APPLIED','CANCELLED') then perform runtime_settings_private.fail('CONFLICT');end if;
 if o.state in ('FAILED','UNKNOWN') and o.receipt=p_body then return runtime_settings_private.response(d.id,o.operation_id);end if;
 if p_body->'configRevision'<>to_jsonb(c.revision) or p_body->'catalog'<>'null'::jsonb or p_body->'bindingEpoch'<>'null'::jsonb or p_body->'agentId'<>'null'::jsonb or p_body->'workspaceId'<>'null'::jsonb or not runtime_settings_private.candidate_receipt_ok(o,p_body) then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state=p_body->>'state',receipt=p_body,failure_receipts=jsonb_set(failure_receipts,array[p_body->>'state'],p_body,true) where device_id=d.id and operation_id=o.operation_id;
 end if;
 return runtime_settings_private.response(d.id,o.operation_id);
exception when unique_violation then perform runtime_settings_private.fail('CONFLICT');return null;
end;$$;
-- Reservations share the existing guard and room lock with workflow mutations.
create function runtime_settings_private.workflow_insert_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare blocked boolean;
begin
 perform device_binding_private.guard();
 if tg_table_name='cycles' then
 blocked:=exists(select 1 from device_binding_private.agents a where a.id in (new.origin_agent_id,new.peer_agent_id) and runtime_settings_private.reserved(a.device_id));
 elsif tg_table_name='requests' then
 blocked:=runtime_settings_private.reserved(new.device_id) or exists(select 1 from workflow_private.cycles c join device_binding_private.agents a on a.id in (c.origin_agent_id,c.peer_agent_id) where c.id=new.cycle_id and runtime_settings_private.reserved(a.device_id));
 else blocked:=new.reported_ready and runtime_settings_private.reserved(new.device_id);
 end if;
 if blocked then perform runtime_settings_private.fail('CONFLICT');end if;
 return new;
end;$$;
create trigger runtime_settings_cycle_reservation before insert on workflow_private.cycles for each row execute function runtime_settings_private.workflow_insert_guard();
create trigger runtime_settings_request_reservation before insert on workflow_private.requests for each row execute function runtime_settings_private.workflow_insert_guard();
create trigger runtime_settings_ready_reservation before insert or update on workflow_private.readiness for each row execute function runtime_settings_private.workflow_insert_guard();

alter function device_binding_private.connector(text,jsonb,text) rename to connector_010_runtime;
create function device_binding_private.connector(action text,b jsonb,s text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices; c device_binding_private.credentials;
begin
 perform device_binding_private.guard();perform device_binding_private.validate(action,b);
 if action in ('workspace','agent','replace') then
 select * into c from device_binding_private.credentials where hash=s;
 select * into d from device_binding_private.devices where id=c.device_id;
 if d.id is null then perform runtime_settings_private.fail('UNAUTHENTICATED');end if;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 select * into c from device_binding_private.credentials where hash=s;select * into d from device_binding_private.devices where id=d.id;
 if d.state<>'active' or d.current_hash<>s or c.revoked_at is not null or c.expires_at<=clock_timestamp() or not device_binding_private.live(d.owner_user_id,d.organization_id,d.room_id) then perform runtime_settings_private.fail('UNAUTHENTICATED');end if;
 perform workflow_private.lock_room(d.room_id);
 if runtime_settings_private.reserved(d.id) then perform runtime_settings_private.fail('CONFLICT');end if;
 end if;
 return device_binding_private.connector_010_runtime(action,b,s);
end;$$;
revoke all on function public.runtime_settings_human(text,jsonb),public.runtime_settings_device(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.runtime_settings_human(text,jsonb) to authenticated;
grant execute on function public.runtime_settings_device(text,jsonb,text) to anon;
revoke all on all tables in schema runtime_settings_private from public,anon,authenticated;
revoke all on all functions in schema runtime_settings_private from public,anon,authenticated;
revoke all on function device_binding_private.connector_010_runtime(text,jsonb,text),device_binding_private.connector(text,jsonb,text) from public,anon,authenticated;
commit;
