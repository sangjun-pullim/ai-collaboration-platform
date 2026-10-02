begin;
create schema device_binding_private;
revoke all on schema device_binding_private from public,anon,authenticated;

-- One retained namespace prevents any code, proof or historical credential reuse.
create table device_binding_private.secret_hashes (
 hash text primary key check (hash ~ '^[a-f0-9]{64}$'), kind text not null check(kind in ('code','proof','credential'))
);
alter table public.room_members add constraint room_member_scope_unique unique(organization_id,room_id,user_id);
create table device_binding_private.pairings (
 id uuid primary key default gen_random_uuid(), code_hash text not null unique references device_binding_private.secret_hashes(hash),
 proof_hash text not null unique references device_binding_private.secret_hashes(hash), device_alias text not null,
 state text not null default 'pending' check(state in ('pending','approved','exchanged','expired','revoked')),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '5 minutes',
 owner_user_id uuid, organization_id uuid, room_id uuid,
 operation_id uuid, credential_hash text, completed_at timestamptz, device_id uuid,
 check(code_hash<>proof_hash), check(expires_at>created_at and expires_at<=created_at+interval '5 minutes'),
 check((owner_user_id is null and organization_id is null and room_id is null) or (owner_user_id is not null and organization_id is not null and room_id is not null)),
 foreign key(organization_id,room_id,owner_user_id) references public.room_members(organization_id,room_id,user_id) on delete cascade
);
create table device_binding_private.devices (
 id uuid primary key default gen_random_uuid(), owner_user_id uuid not null, organization_id uuid not null, room_id uuid not null,
 device_alias text not null, state text not null default 'active' check(state in ('active','revoked','removed')),
 current_hash text references device_binding_private.secret_hashes(hash), last_seen_at timestamptz,
 rotation_operation uuid, rotation_hash text, rotation_previous_hash text, rotation_completed_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),
 unique(id,owner_user_id,organization_id,room_id), check((state='active')=(current_hash is not null)),
 foreign key(organization_id,room_id,owner_user_id) references public.room_members(organization_id,room_id,user_id) on delete cascade
);
create table device_binding_private.credentials (
 hash text primary key references device_binding_private.secret_hashes(hash), device_id uuid not null,
 owner_user_id uuid not null, organization_id uuid not null, room_id uuid not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '1 hour', revoked_at timestamptz,
 check(expires_at>created_at and expires_at<=created_at+interval '1 hour'), unique(device_id,hash),
 foreign key(device_id,owner_user_id,organization_id,room_id) references device_binding_private.devices(id,owner_user_id,organization_id,room_id) on delete cascade
);
alter table device_binding_private.devices add foreign key(id,current_hash) references device_binding_private.credentials(device_id,hash) deferrable initially deferred;
alter table device_binding_private.pairings add foreign key(device_id,owner_user_id,organization_id,room_id) references device_binding_private.devices(id,owner_user_id,organization_id,room_id) on delete cascade;
alter table device_binding_private.pairings add foreign key(device_id,credential_hash) references device_binding_private.credentials(device_id,hash) on delete cascade;
create table device_binding_private.workspaces (
 id uuid primary key default gen_random_uuid(), device_id uuid not null, owner_user_id uuid not null, organization_id uuid not null, room_id uuid not null,
 repository_alias text not null, branch text not null, commit_hash text not null, dirty text not null check(dirty='unknown'),
 state text not null default 'active' check(state in ('active','revoked')),
 registration_operation uuid not null, registration_payload_hash text not null, registration_credential_hash text not null,
 registration_completed_at timestamptz not null default clock_timestamp(),
 unique(id,device_id,owner_user_id,organization_id,room_id), unique(device_id,registration_operation),
 foreign key(device_id,registration_credential_hash) references device_binding_private.credentials(device_id,hash),
 foreign key(device_id,owner_user_id,organization_id,room_id) references device_binding_private.devices(id,owner_user_id,organization_id,room_id) on delete cascade
);
create table device_binding_private.agents (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, device_id uuid not null,
 owner_user_id uuid not null, organization_id uuid not null, room_id uuid not null,
 session_alias text not null, runtime text not null check(runtime='codex'), binding_epoch bigint not null default 1 check(binding_epoch>0),
 state text not null default 'active' check(state in ('active','revoked')), verification text not null default 'unverified' check(verification='unverified'),
 registration_operation uuid not null, registration_payload_hash text not null, registration_credential_hash text not null,
 registration_completed_at timestamptz not null default clock_timestamp(), registration_epoch bigint not null default 1,
 replacement_operation uuid, replacement_payload_hash text, replacement_credential_hash text, replacement_completed_at timestamptz, replacement_epoch bigint,
 unique(device_id,registration_operation), unique(workspace_id),
 foreign key(device_id,registration_credential_hash) references device_binding_private.credentials(device_id,hash),
 foreign key(device_id,replacement_credential_hash) references device_binding_private.credentials(device_id,hash),
 foreign key(workspace_id,device_id,owner_user_id,organization_id,room_id) references device_binding_private.workspaces(id,device_id,owner_user_id,organization_id,room_id) on delete cascade
);
create table device_binding_private.operations (
 device_id uuid not null references device_binding_private.devices(id) on delete cascade,
 operation_id uuid not null, action text not null check(action in ('rotate','workspace','agent','replace')),
 primary key(device_id,operation_id)
);
create table device_binding_private.connection_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 room_id uuid not null, actor_user_id uuid not null, actor_kind text not null check(actor_kind in ('human','device')),
 device_id uuid, pairing_id uuid, action text not null check(action in ('approve','exchange','rotate','workspace','agent','replace','revoke','remove','membership-revoke')),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(organization_id,room_id) references public.rooms(organization_id,id) on delete cascade
);

create function device_binding_private.guard() returns void language sql security definer set search_path='' as $$
 select pg_catalog.pg_advisory_xact_lock(51005,1);
$$;
-- Scope lookups before this function are hints only. All authorization follows locks.
create function device_binding_private.lock_scope(o uuid,r uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.organizations where id=o for update;
 perform 1 from public.rooms where organization_id=o and (r is null or id=r) order by id for update;
 perform 1 from public.organization_members where organization_id=o order by user_id for update;
 perform 1 from public.room_members where organization_id=o and (r is null or room_id=r) order by room_id,user_id for update;
 perform 1 from device_binding_private.pairings where organization_id=o and (r is null or room_id=r) order by id for update;
 perform 1 from device_binding_private.devices where organization_id=o and (r is null or room_id=r) order by id for update;
 perform 1 from device_binding_private.credentials where organization_id=o and (r is null or room_id=r) order by hash for update;
 perform 1 from device_binding_private.workspaces where organization_id=o and (r is null or room_id=r) order by id for update;
 perform 1 from device_binding_private.agents where organization_id=o and (r is null or room_id=r) order by id for update;
end; $$;
create function device_binding_private.live(u uuid,o uuid,r uuid,write_access boolean default true) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users a join public.organization_members m on m.user_id=a.id
 join public.room_members rm on rm.organization_id=m.organization_id and rm.user_id=m.user_id
 where a.id=u and a.deleted_at is null and (a.banned_until is null or a.banned_until<=clock_timestamp())
 and m.organization_id=o and m.status='active' and rm.room_id=r and rm.status='active'
 and (not write_access or rm.role in ('owner','participant')));
$$;
create function device_binding_private.alias_ok(v text) returns boolean language sql immutable set search_path='' as $$
 select v is not null and char_length(v) between 1 and 40 and v=btrim(v) and v ~ '^[[:alnum:]가-힣 _.-]+$'
 and v !~ '^\.' and position('..' in v)=0 and v !~ '^[a-fA-F0-9-]{36}$'
 and v !~ '^[a-fA-F0-9]{24,}$' and v !~ '^[A-Za-z0-9_-]{24,}$';
$$;
create function device_binding_private.metadata_ok(b jsonb) returns boolean language sql immutable set search_path='' as $$
 select device_binding_private.alias_ok(b->>'repositoryAlias')
 and (b->>'branch'='unknown' or (char_length(b->>'branch') between 1 and 120 and b->>'branch' ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
 and position('..' in b->>'branch')=0 and position('//' in b->>'branch')=0 and b->>'branch' !~ '(/|\.|\.lock)$'))
 and (b->>'commit'='unknown' or b->>'commit' ~ '^[a-f0-9]{40}$') and b->>'dirty'='unknown';
$$;
create function device_binding_private.validate(action text,b jsonb) returns void language plpgsql set search_path='' as $$
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
 or action in ('agent','replace') and b->>'runtime'<>'codex' then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
end; $$;
create function device_binding_private.bindings(d uuid,r uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('workspaceId',w.id,'agentId',a.id,'deviceAlias',dv.device_alias,'ownerAlias',m.display_alias,
 'repositoryAlias',w.repository_alias,'branch',w.branch,'commit',w.commit_hash,'dirty',w.dirty,'sessionAlias',a.session_alias,'runtime',a.runtime,
 'bindingEpoch',a.binding_epoch,'state','registered','verification',a.verification,'lastSeenAt',dv.last_seen_at) order by a.id),'[]'::jsonb)
 from device_binding_private.agents a join device_binding_private.workspaces w on w.id=a.workspace_id
 join device_binding_private.devices dv on dv.id=a.device_id join public.room_members m on m.room_id=a.room_id and m.user_id=a.owner_user_id
 where (d is null or dv.id=d) and (r is null or a.room_id=r) and a.state='active' and w.state='active' and dv.state='active'
 and device_binding_private.live(a.owner_user_id,a.organization_id,a.room_id);
$$;
create function device_binding_private.audit(o uuid,r uuid,u uuid,kind text,d uuid,p uuid,act text) returns void
language sql security definer set search_path='' as $$
 insert into device_binding_private.connection_audit(organization_id,room_id,actor_user_id,actor_kind,device_id,pairing_id,action) values(o,r,u,kind,d,p,act);
$$;
create function device_binding_private.cancel(u uuid,o uuid,r uuid,d uuid,removed boolean default false) returns void
language plpgsql security definer set search_path='' as $$
begin
 update device_binding_private.pairings set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and state='approved' and (d is null or device_id=d);
 update device_binding_private.devices set state=case when removed then 'removed' else 'revoked' end,current_hash=null
 where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or id=d) and state<>'removed';
 update device_binding_private.credentials set revoked_at=coalesce(revoked_at,clock_timestamp()) where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
 update device_binding_private.workspaces set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
 update device_binding_private.agents set state='revoked' where owner_user_id=u and organization_id=o and (r is null or room_id=r) and (d is null or device_id=d);
end; $$;

create function device_binding_private.human(action text,b jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; p device_binding_private.pairings%rowtype; d device_binding_private.devices%rowtype; o uuid; r uuid;
begin
 perform device_binding_private.guard();
 perform device_binding_private.validate(action,b);
 if action='approve' then
  o:=(b->>'organizationId')::uuid; r:=(b->>'roomId')::uuid;
  perform device_binding_private.lock_scope(o,r);
  u:=room_access_private.actor();
  if not device_binding_private.live(u,o,r) then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
  select * into p from device_binding_private.pairings where code_hash=b->>'code' for update;
  if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
  if p.state<>'pending' or p.expires_at<=clock_timestamp() then raise exception using message='CONFLICT',errcode='P0001'; end if;
  update device_binding_private.pairings set state='approved',owner_user_id=u,organization_id=o,room_id=r where id=p.id;
  perform device_binding_private.audit(o,r,u,'human',null,p.id,'approve');
  return jsonb_build_object('approved',true,'deviceAlias',p.device_alias);
 end if;
 select * into d from device_binding_private.devices where id=(b->>'deviceId')::uuid;
 if not found then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 u:=room_access_private.actor();
 select * into d from device_binding_private.devices where id=d.id;
 if d.owner_user_id<>u or not device_binding_private.live(u,d.organization_id,d.room_id,false) then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
 perform device_binding_private.cancel(u,d.organization_id,d.room_id,d.id,action='remove');
 -- Also cancel any approvals awaiting exchange in this user's same scope.
 update device_binding_private.pairings set state='revoked' where owner_user_id=u and organization_id=d.organization_id and room_id=d.room_id and state='approved';
 perform device_binding_private.audit(d.organization_id,d.room_id,u,'human',d.id,null,action);
 return jsonb_build_object('removed',true);
end; $$;

create function device_binding_private.connector(action text,b jsonb,s text) returns jsonb
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
   values(w.id,d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'sessionAlias','codex',op,ph,s) returning * into a;
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
  update device_binding_private.agents set session_alias=b->>'sessionAlias',binding_epoch=binding_epoch+1,replacement_operation=op,replacement_payload_hash=ph,replacement_credential_hash=s,replacement_completed_at=clock_timestamp(),replacement_epoch=binding_epoch+1 where id=a.id returning * into a;
  result:=jsonb_build_object('protocol',1,'agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch,'state','registered','verification','unverified');
 else raise exception using message='NOT_FOUND',errcode='P0001'; end if;
 insert into device_binding_private.operations values(d.id,op,action);
 perform device_binding_private.audit(d.organization_id,d.room_id,d.owner_user_id,'device',d.id,null,action);
 return result;
exception when unique_violation then raise exception using message='CONFLICT',errcode='P0001';
end; $$;

create or replace function public.access_revoke_room_member(p_room_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid; o uuid; target_role text;
begin
 perform device_binding_private.guard();
 select organization_id into o from public.rooms where id=p_room_id;
 perform device_binding_private.lock_scope(o,p_room_id);
 a:=room_access_private.actor();
 perform room_access_private.owner(o,p_room_id,a);
 select role into target_role from public.room_members where room_id=p_room_id and user_id=p_user_id and status='active';
 if not found or p_user_id=a or target_role='owner' then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 perform device_binding_private.cancel(p_user_id,o,p_room_id,null);
 perform device_binding_private.audit(o,p_room_id,a,'human',null,null,'membership-revoke');
 update public.room_members set status='removed' where room_id=p_room_id and user_id=p_user_id;
 update public.rooms set access_version=access_version+1 where id=p_room_id;
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_user_id,target_role) values(o,p_room_id,a,'owner','revoke-room-member',p_user_id,target_role);
 return jsonb_build_object('removed',true);
end; $$;

create or replace function public.access_revoke_group_member(p_organization_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid; target_role text;
begin
 perform device_binding_private.guard();
 perform device_binding_private.lock_scope(p_organization_id,null);
 a:=room_access_private.actor();
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=a and status='active' and role='owner') then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 select role into target_role from public.organization_members where organization_id=p_organization_id and user_id=p_user_id and status='active';
 if not found or p_user_id=a or target_role='owner' or exists(select 1 from public.room_members where organization_id=p_organization_id and user_id=p_user_id and status='active' and role='owner') then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 perform device_binding_private.cancel(p_user_id,p_organization_id,null,null);
 insert into device_binding_private.connection_audit(organization_id,room_id,actor_user_id,actor_kind,action) select p_organization_id,id,a,'human','membership-revoke' from public.rooms where organization_id=p_organization_id;
 update public.organization_members set status='removed' where organization_id=p_organization_id and user_id=p_user_id;
 update public.room_members set status='removed' where organization_id=p_organization_id and user_id=p_user_id;
 update public.organizations set access_version=access_version+1 where id=p_organization_id;
 update public.rooms set access_version=access_version+1 where organization_id=p_organization_id;
 insert into room_access_private.access_audit(organization_id,actor_user_id,actor_role,action,target_user_id,target_role) values(p_organization_id,a,'owner','revoke-group-member',p_user_id,target_role);
 return jsonb_build_object('removed',true);
end; $$;

create function public.connection_approve(p_body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 -- Validate the original DTO before replacing its code with a lookup hash.
 perform device_binding_private.validate('approve',p_body);
 p_body:=pg_catalog.jsonb_set(p_body,'{code}',pg_catalog.to_jsonb(pg_catalog.encode(extensions.digest(p_body->>'code','sha256'),'hex')));
 return device_binding_private.human('approve',p_body);
end; $$;
revoke all on function public.connection_approve(jsonb) from public,anon,authenticated;
grant execute on function public.connection_approve(jsonb) to authenticated;

create function public.connection_revoke(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select device_binding_private.human('revoke',p_body); $$;
revoke all on function public.connection_revoke(jsonb) from public,anon,authenticated;
grant execute on function public.connection_revoke(jsonb) to authenticated;

create function public.connection_remove(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$ select device_binding_private.human('remove',p_body); $$;
revoke all on function public.connection_remove(jsonb) from public,anon,authenticated;
grant execute on function public.connection_remove(jsonb) to authenticated;

create function public.connector_begin(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is not null then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 return device_binding_private.connector('begin',p_body,null);
end; $$;
revoke all on function public.connector_begin(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_begin(jsonb,text) to anon;

create function public.connector_pairing_status(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('pairing-status',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_pairing_status(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_pairing_status(jsonb,text) to anon;

create function public.connector_exchange(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('exchange',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_exchange(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_exchange(jsonb,text) to anon;

create function public.connector_rotate(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('rotate',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_rotate(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_rotate(jsonb,text) to anon;

create function public.connector_heartbeat(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('heartbeat',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_heartbeat(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_heartbeat(jsonb,text) to anon;

create function public.connector_workspace(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('workspace',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_workspace(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_workspace(jsonb,text) to anon;

create function public.connector_agent(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('agent',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_agent(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_agent(jsonb,text) to anon;

create function public.connector_replace(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('replace',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_replace(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_replace(jsonb,text) to anon;

create function public.connector_bindings(p_body jsonb,p_secret text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform device_binding_private.guard();
 if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return device_binding_private.connector('bindings',p_body,pg_catalog.encode(extensions.digest(p_secret,'sha256'),'hex'));
end; $$;
revoke all on function public.connector_bindings(jsonb,text) from public,anon,authenticated;
grant execute on function public.connector_bindings(jsonb,text) to anon;

create function public.connection_list() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; o uuid;
begin
 perform device_binding_private.guard();
 u:=room_access_private.actor();
 for o in select organization_id from public.organization_members where user_id=u order by organization_id loop perform device_binding_private.lock_scope(o,null); end loop;
 u:=room_access_private.actor();
 return jsonb_build_object('devices',coalesce((select jsonb_agg(jsonb_build_object('deviceId',d.id,'deviceAlias',d.device_alias,'organizationId',d.organization_id,'roomId',d.room_id,'state',d.state,'lastSeenAt',d.last_seen_at,'expiresAt',c.expires_at) order by d.created_at)
 from device_binding_private.devices d left join device_binding_private.credentials c on c.hash=d.current_hash where d.owner_user_id=u and device_binding_private.live(u,d.organization_id,d.room_id,false)),'[]'::jsonb),
 'rooms',coalesce((select jsonb_agg(jsonb_build_object('organizationId',o.id,'organizationName',o.name,'roomId',r.id,'roomTitle',r.title) order by r.id)
 from public.rooms r join public.organizations o on o.id=r.organization_id where device_binding_private.live(u,o.id,r.id)),'[]'::jsonb));
end; $$;
create function public.connection_room_bindings(p_room_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o uuid; u uuid;
begin
 perform device_binding_private.guard();
 select organization_id into o from public.rooms where id=p_room_id;
 perform device_binding_private.lock_scope(o,p_room_id);
 u:=room_access_private.actor();
 if not device_binding_private.live(u,o,p_room_id,false) then raise exception using message='NOT_FOUND',errcode='P0001'; end if;
 return device_binding_private.bindings(null,p_room_id);
end; $$;
revoke all on function public.connection_list(),public.connection_room_bindings(uuid) from public,anon,authenticated;
grant execute on function public.connection_list(),public.connection_room_bindings(uuid) to authenticated;
revoke all on all tables in schema device_binding_private from public,anon,authenticated;
revoke all on all functions in schema device_binding_private from public,anon,authenticated;
commit;
