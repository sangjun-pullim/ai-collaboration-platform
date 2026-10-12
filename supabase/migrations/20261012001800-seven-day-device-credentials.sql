begin;
-- Extend only new device credentials; retained credentials are never rewritten.
lock table device_binding_private.credentials in access exclusive mode;
DO $credential_lifetime$
declare source_hash text; lifetime_constraint text; lifetime_default text; lifetime_check text;
begin
 select md5(p.prosrc) into source_hash from pg_catalog.pg_proc p
 where p.oid=to_regprocedure('device_binding_private.connector_010_runtime(text,jsonb,text)')
 and p.prokind='f' and p.prosecdef and p.provolatile='v' and not p.proretset
 and p.prorettype='jsonb'::regtype and p.proargnames=ARRAY['action','b','s']::text[]
 and p.proargmodes is null and p.prolang=(select oid from pg_catalog.pg_language where lanname='plpgsql')
 and p.proconfig=ARRAY['search_path=""']::text[];
 select regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[()[:space:]]','','g') into lifetime_default
 from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
 where d.adrelid='device_binding_private.credentials'::regclass and a.attname='expires_at' and not a.attisdropped;
 select c.conname,regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g')
 into strict lifetime_constraint,lifetime_check from pg_catalog.pg_constraint c
 where c.conrelid='device_binding_private.credentials'::regclass and c.contype='c' and c.convalidated
 and regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g') in (
 $old_check$expires_at>created_atANDexpires_at<=created_at+'01:00:00'::interval$old_check$,
 $new_check$expires_at>created_atANDexpires_at<=created_at+'7days'::interval$new_check$);
 if ((source_hash='5ddfe023acf667121443a91bb3093797'
 and lifetime_default=$old_default$now+'01:00:00'::interval$old_default$
 and lifetime_check=$old_check$expires_at>created_atANDexpires_at<=created_at+'01:00:00'::interval$old_check$)
 or (source_hash='a24c498139a82092565e650bfceb4986'
 and lifetime_default=$new_default$now+'7days'::interval$new_default$
 and lifetime_check=$new_check$expires_at>created_atANDexpires_at<=created_at+'7days'::interval$new_check$)) is not true then
 raise exception using message='CREDENTIAL_LIFETIME_SOURCE_UNVERIFIED',errcode='P0001';
 end if;
 alter table device_binding_private.credentials alter column expires_at set default now()+interval '7 days';
 execute format('alter table device_binding_private.credentials drop constraint %I',lifetime_constraint);
 execute format('alter table device_binding_private.credentials add constraint %I check (expires_at>created_at and expires_at<=created_at+interval ''7 days'')',lifetime_constraint);
exception when no_data_found or too_many_rows then
 raise exception using message='CREDENTIAL_LIFETIME_SOURCE_UNVERIFIED',errcode='P0001';
end;
$credential_lifetime$;

create or replace function device_binding_private.connector_010_runtime(action text,b jsonb,s text) returns jsonb
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
  insert into device_binding_private.credentials(hash,device_id,owner_user_id,organization_id,room_id,created_at,expires_at) values(d.current_hash,d.id,d.owner_user_id,d.organization_id,d.room_id,t,t+interval '7 days') returning * into c;
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
  insert into device_binding_private.credentials(hash,device_id,owner_user_id,organization_id,room_id,created_at,expires_at) values(b->>'credentialHash',d.id,d.owner_user_id,d.organization_id,d.room_id,t,t+interval '7 days') returning * into c;
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
commit;
