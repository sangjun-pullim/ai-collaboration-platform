begin;

create schema chat_attachments_private;
revoke all on schema chat_attachments_private from public,anon,authenticated;

-- No FK cascades: removing a room/user must never erase charged Storage objects.
create table chat_attachments_private.budget (
 id integer primary key check(id=1), storage_limit bigint not null default 1000000000 check(storage_limit between 524288 and 1000000000),
 charged_bytes bigint not null default 0 check(charged_bytes>=0), cleaning boolean not null default false,
 cleanup_lease uuid, cleanup_until timestamptz
);
insert into chat_attachments_private.budget(id) values(1);
create table chat_attachments_private.images (
 id uuid primary key default gen_random_uuid(),room_id uuid not null,owner_id uuid not null,
 state text not null default 'RESERVED' check(state in ('RESERVED','READY','ATTACHED','DELETING','DELETED')),
 mime text not null check(mime in ('image/png','image/jpeg','image/webp')),
 bytes integer not null check(bytes between 1 and 524288), width integer not null check(width between 1 and 2048),height integer not null check(height between 1 and 2048),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),attached_at timestamptz,deleted_at timestamptz,
 revision bigint not null default 1 check(revision between 1 and 9007199254740991),event_id uuid unique,request_id uuid unique,
 deletion_lease uuid,
 check(width::bigint*height<=4194304),check((state='DELETED')=(deleted_at is not null)),
 check((event_id is null)=(attached_at is null))
);
create index chat_images_cleanup on chat_attachments_private.images(state,created_at);
create index chat_images_request on chat_attachments_private.images(request_id) where request_id is not null;
create table chat_attachments_private.download_leases (
 id uuid primary key default gen_random_uuid(),attachment_id uuid not null references chat_attachments_private.images(id),
 expires_at timestamptz not null default clock_timestamp()+interval '2 minutes'
);
create index chat_image_download_lease on chat_attachments_private.download_leases(attachment_id,expires_at);
create table chat_attachments_private.egress (
 month date primary key,charged_bytes bigint not null default 0 check(charged_bytes between 0 and 2000000000)
);
create table chat_attachments_private.capabilities (
 agent_id uuid primary key,device_id uuid not null,room_id uuid not null,binding_epoch bigint not null,
 image_input_version integer not null check(image_input_version=1),valid_until timestamptz not null
);
create table chat_attachments_private.publications (
 room_id uuid not null,user_id uuid not null,operation_id uuid not null,action text not null check(action in ('speak','ask')),
 payload_hash text not null,result jsonb not null,primary key(room_id,user_id,operation_id)
);
create table chat_attachments_private.attempt_versions (
 attempt_id uuid primary key,image_input_version integer not null check(image_input_version=1)
);
create table chat_attachments_private.preinput_failures (
 attempt_id uuid primary key,request_id uuid not null,device_id uuid not null,room_id uuid not null,
 proof_hash text not null,reason text not null check(reason in ('IMAGE_DOWNLOAD_FAILED','IMAGE_CONTENT_MISMATCH','IMAGE_HISTORY_CAPACITY')),receipt jsonb not null
);
revoke all on all tables in schema chat_attachments_private from public,anon,authenticated;

-- A separate bucket with no application-role object policies. The explicit deny also
-- prevents unrelated broad Storage policies from opening this bucket accidentally.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('chat-images','chat-images',false,524288,array['image/png','image/jpeg','image/webp']);
create policy chat_images_private_only on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'chat-images') with check(bucket_id<>'chat-images');
create policy chat_image_bucket_private_only on storage.buckets as restrictive for all to anon,authenticated
 using(id<>'chat-images') with check(id<>'chat-images');

create function chat_attachments_private.fail(code text) returns void language plpgsql set search_path='' as $$
begin raise exception using message=code,errcode='P0001';end;$$;
create function chat_attachments_private.body(b jsonb,ks text[]) returns void language plpgsql set search_path='' as $$
declare k text;
begin
 if not coalesce(runtime_settings_private.keys(b,ks),false) or b->'protocol' is distinct from '1'::jsonb then perform chat_attachments_private.fail('INVALID_BODY');end if;
 if octet_length(b::text)>16384 then perform chat_attachments_private.fail('BODY_TOO_LARGE');end if;
 foreach k in array ks loop
  if k like '%Id' and (jsonb_typeof(b->k) is distinct from 'string' or not coalesce(runtime_settings_private.id_ok(b->>k),false)) then perform chat_attachments_private.fail('INVALID_BODY');end if;
  if k in ('bytes','width','height','bindingEpoch','fence') then
   if jsonb_typeof(b->k) is distinct from 'number' or b->>k !~ '^[0-9]+$' then perform chat_attachments_private.fail('INVALID_BODY');end if;
   if (b->>k)::numeric<1 or (b->>k)::numeric>9007199254740991 then perform chat_attachments_private.fail('INVALID_BODY');end if;
  end if;
 end loop;
end;$$;
create function chat_attachments_private.user_scope(b jsonb,w boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid;o uuid;r uuid:=(b->>'roomId')::uuid;
begin
 perform device_binding_private.guard();
 u:=room_access_private.actor();
 if u is distinct from (b->>'expectedUserId')::uuid then perform chat_attachments_private.fail('FORBIDDEN');end if;
 select organization_id into o from public.rooms where id=r;
 if o is null then perform chat_attachments_private.fail('FORBIDDEN');end if;
 perform device_binding_private.lock_scope(o,r);
 if not device_binding_private.live(u,o,r,w) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 return u;
end;$$;
create function chat_attachments_private.descriptor(i chat_attachments_private.images) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('attachmentId',i.id,'mime',i.mime,'bytes',i.bytes,'width',i.width,'height',i.height,'sha256',i.sha256);
$$;

create function public.chat_attachment_authorize_upload(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform chat_attachments_private.body(p_body,array['protocol','roomId','expectedUserId']);
 perform chat_attachments_private.user_scope(p_body,true);
 return jsonb_build_object('authorized',true);
end;$$;
create function public.chat_attachment_reserve(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid;q chat_attachments_private.budget;i chat_attachments_private.images;
begin
 perform chat_attachments_private.body(p_body,array['protocol','roomId','expectedUserId','mime','bytes','width','height','sha256']);
 u:=chat_attachments_private.user_scope(p_body,true);
 if jsonb_typeof(p_body->'mime') is distinct from 'string' or p_body->>'mime' not in ('image/png','image/jpeg','image/webp')
 or jsonb_typeof(p_body->'sha256') is distinct from 'string' or p_body->>'sha256' !~ '^[a-f0-9]{64}$'
 or (p_body->>'bytes')::bigint>524288 or (p_body->>'width')::bigint>2048 or (p_body->>'height')::bigint>2048
 or (p_body->>'width')::numeric*(p_body->>'height')::numeric>4194304 then perform chat_attachments_private.fail('INVALID_BODY');end if;
 select * into q from chat_attachments_private.budget where id=1 for update;
 if (select count(*) from chat_attachments_private.images where owner_id=u and state in ('RESERVED','READY'))>=8 then
  return jsonb_build_object('needsCleanup',true,'reason','TOO_MANY_PENDING');
 end if;
 if q.cleaning or q.charged_bytes+(p_body->>'bytes')::integer>q.storage_limit*75/100 then
  update chat_attachments_private.budget set cleaning=true where id=1;
  return jsonb_build_object('needsCleanup',true,'reason','STORAGE_PROTECTED');
 end if;
 insert into chat_attachments_private.images(room_id,owner_id,mime,bytes,width,height,sha256)
 values((p_body->>'roomId')::uuid,u,p_body->>'mime',(p_body->>'bytes')::integer,(p_body->>'width')::integer,(p_body->>'height')::integer,p_body->>'sha256') returning * into i;
 update chat_attachments_private.budget set charged_bytes=charged_bytes+i.bytes where id=1;
 return jsonb_build_object('attachmentId',i.id);
end;$$;
-- Only the Storage owner can finalize a write; public callers cannot manufacture READY.
create function public.chat_attachment_finalize(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i chat_attachments_private.images;
begin
 perform device_binding_private.guard();
 select * into i from chat_attachments_private.images where id=p_id for update;
 if i.id is null or i.state not in ('RESERVED','READY') or i.created_at<=clock_timestamp()-interval '1 hour' then perform chat_attachments_private.fail('CONFLICT');end if;
 if i.state='RESERVED' then update chat_attachments_private.images set state='READY',revision=revision+1 where id=i.id;end if;
 return chat_attachments_private.descriptor(i);
end;$$;

-- Step 4 calls this inside the message/request transaction while its scope/room
-- locks are held. It does not create/replace workflow behavior or public events.
create function chat_attachments_private.publish(p_id uuid,p_room uuid,p_user uuid,p_event uuid,p_request uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i chat_attachments_private.images;
begin
 perform device_binding_private.guard();
 select * into i from chat_attachments_private.images where id=p_id for update;
 if i.id is null or i.owner_id<>p_user or i.room_id<>p_room then perform chat_attachments_private.fail('FORBIDDEN');end if;
 if i.state='ATTACHED' and i.event_id=p_event and i.request_id is not distinct from p_request then return chat_attachments_private.descriptor(i);end if;
 if i.state<>'READY' or i.created_at<=clock_timestamp()-interval '1 hour' then perform chat_attachments_private.fail('CONFLICT');end if;
 if not exists(select 1 from public.rooms r where r.id=p_room and device_binding_private.live(p_user,r.organization_id,r.id,true))
 or not exists(select 1 from public.workflow_events e where e.event_id=p_event and e.room_id=p_room and e.sender_kind='HUMAN'
   and ((p_request is null and e.kind='SPEECH' and e.request_id is null) or (p_request is not null and e.kind='QUESTION' and e.request_id=p_request)))
 or p_request is not null and not exists(select 1 from workflow_private.requests r where r.id=p_request and r.room_id=p_room) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 update chat_attachments_private.images set state='ATTACHED',event_id=p_event,request_id=p_request,attached_at=clock_timestamp(),revision=revision+1 where id=i.id;
 return chat_attachments_private.descriptor(i);
end;$$;
create function chat_attachments_private.request_descriptor(p_request uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select chat_attachments_private.descriptor(i) from chat_attachments_private.images i where i.request_id=p_request;
$$;
create function chat_attachments_private.lock_request(p_request uuid) returns void
language plpgsql security definer set search_path='' as $$
declare i chat_attachments_private.images;
begin
 select * into i from chat_attachments_private.images where request_id=p_request for update;
 if found and i.state<>'ATTACHED' then perform chat_attachments_private.fail('CONFLICT');end if;
end;$$;

create function public.chat_attachment_read(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform chat_attachments_private.body(p_body,array['protocol','roomId','expectedUserId','eventIds']);
 perform chat_attachments_private.user_scope(p_body);
 if jsonb_typeof(p_body->'eventIds') is distinct from 'array' then perform chat_attachments_private.fail('INVALID_BODY');end if;
 if jsonb_array_length(p_body->'eventIds')>32 or exists(select 1 from jsonb_array_elements(p_body->'eventIds') v where jsonb_typeof(v) is distinct from 'string' or not coalesce(runtime_settings_private.id_ok(v#>>'{}'),false)) then perform chat_attachments_private.fail('INVALID_BODY');end if;
 if exists(select 1 from jsonb_array_elements_text(p_body->'eventIds') v where not exists(select 1 from public.workflow_events e where e.event_id=v::uuid and e.room_id=(p_body->>'roomId')::uuid)) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 select coalesce(jsonb_agg(chat_attachments_private.descriptor(i)||jsonb_build_object('eventId',i.event_id,'state',i.state,'revision',i.revision,'deletedAt',i.deleted_at)),'[]'::jsonb) into result
 from chat_attachments_private.images i where i.room_id=(p_body->>'roomId')::uuid and i.event_id in (select v::uuid from jsonb_array_elements_text(p_body->'eventIds') v);
 return result;
end;$$;

create function chat_attachments_private.download(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i chat_attachments_private.images;l uuid;used bigint;m date:=date_trunc('month',clock_timestamp() at time zone 'UTC')::date;
begin
 select * into i from chat_attachments_private.images where id=p_id for update;
 if i.id is null or i.state<>'ATTACHED' then perform chat_attachments_private.fail('NOT_FOUND');end if;
 insert into chat_attachments_private.egress(month) values(m) on conflict do nothing;
 select charged_bytes into used from chat_attachments_private.egress where month=m for update;
 if used+i.bytes>2000000000 then perform chat_attachments_private.fail('QUOTA');end if;
 update chat_attachments_private.egress set charged_bytes=charged_bytes+i.bytes where month=m;
 insert into chat_attachments_private.download_leases(attachment_id) values(i.id) returning id into l;
 return jsonb_build_object('descriptor',chat_attachments_private.descriptor(i),'leaseId',l);
end;$$;
create function public.chat_attachment_user_download(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform chat_attachments_private.body(p_body,array['protocol','roomId','expectedUserId','attachmentId']);
 perform chat_attachments_private.user_scope(p_body);
 if not exists(select 1 from chat_attachments_private.images i join public.workflow_events e on e.event_id=i.event_id and e.room_id=i.room_id where i.id=(p_body->>'attachmentId')::uuid and i.room_id=(p_body->>'roomId')::uuid) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 return chat_attachments_private.download((p_body->>'attachmentId')::uuid);
end;$$;
create function public.chat_attachment_device_download(p_body jsonb,p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices;q workflow_private.requests;a workflow_private.attempts;
begin
 perform chat_attachments_private.body(p_body,array['protocol','attachmentId','agentId','bindingEpoch','requestId','attemptId','fence','imageInputVersion']);
 if p_body->'imageInputVersion' is distinct from '1'::jsonb then perform chat_attachments_private.fail('INVALID_BODY');end if;
 d:=runtime_settings_private.live_device(p_secret);
 select * into q from workflow_private.requests where id=(p_body->>'requestId')::uuid and room_id=d.room_id and device_id=d.id and owner_id=d.owner_user_id and agent_id=(p_body->>'agentId')::uuid and binding_epoch=(p_body->>'bindingEpoch')::bigint;
 if q.id is null or not workflow_private.binding_live(q.agent_id,q.binding_epoch,d.room_id) or q.deadline<=clock_timestamp() or q.state not in ('LEASED','RUNNING') then perform chat_attachments_private.fail('FORBIDDEN');end if;
 select * into a from workflow_private.attempts where id=(p_body->>'attemptId')::uuid and request_id=q.id and fence=(p_body->>'fence')::bigint and fence=q.fence and state in ('LEASED','EXECUTING') and lease_expires_at>clock_timestamp();
 if a.id is null or not exists(select 1 from chat_attachments_private.images i where i.id=(p_body->>'attachmentId')::uuid and i.request_id=q.id and i.room_id=q.room_id) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 return chat_attachments_private.download((p_body->>'attachmentId')::uuid);
end;$$;

create function public.chat_attachment_cleanup_claim(p_limit integer default 32) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q chat_attachments_private.budget;i chat_attachments_private.images;l uuid;ids uuid[]:='{}';projected bigint;
begin
 perform device_binding_private.guard();
 if p_limit is null or p_limit<1 or p_limit>32 then perform chat_attachments_private.fail('INVALID_BODY');end if;
 select * into q from chat_attachments_private.budget where id=1 for update;
 if q.cleanup_until>clock_timestamp() then return jsonb_build_object('leaseId',null,'attachmentIds','[]'::jsonb);end if;
 l:=gen_random_uuid();projected:=q.charged_bytes;
 if q.charged_bytes>q.storage_limit*75/100 then q.cleaning:=true;end if;
 if q.charged_bytes<=q.storage_limit*60/100 then q.cleaning:=false;end if;
 update chat_attachments_private.budget set cleaning=q.cleaning,cleanup_lease=l,cleanup_until=clock_timestamp()+interval '30 seconds' where id=1;
 delete from chat_attachments_private.download_leases where expires_at<=clock_timestamp();
 for i in select im.* from chat_attachments_private.images im
  where im.state<>'DELETED'
  and not exists(select 1 from chat_attachments_private.download_leases dl where dl.attachment_id=im.id and dl.expires_at>clock_timestamp())
  -- A missing retained request is unconfirmed, never evidence of termination.
  and (im.request_id is null or exists(select 1 from workflow_private.requests r where r.id=im.request_id
    and r.state in ('COMPLETED','FAILED','INTERRUPTED','CANCELLED')
    and not exists(select 1 from workflow_private.attempts a where a.request_id=r.id and a.state in ('LEASED','EXECUTING','UNKNOWN'))))
  and (im.state='DELETING' or im.event_id is null and im.created_at<=clock_timestamp()-interval '1 hour'
    or q.cleaning and im.state='ATTACHED' and im.attached_at<=clock_timestamp()-interval '24 hours')
  order by case when im.state='DELETING' then 0 else 1 end,coalesce(im.attached_at,im.created_at),im.id
  for update of im
 loop
  exit when cardinality(ids)>=p_limit;
  if i.state='ATTACHED' and projected<=q.storage_limit*60/100 then continue;end if;
  update chat_attachments_private.images set state='DELETING',deletion_lease=l,revision=revision+case when state='DELETING' then 0 else 1 end where id=i.id;
  ids:=array_append(ids,i.id);projected:=projected-i.bytes;
 end loop;
 return jsonb_build_object('leaseId',l,'attachmentIds',to_jsonb(ids));
end;$$;
create function public.chat_attachment_cleanup_confirm(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i chat_attachments_private.images;q chat_attachments_private.budget;
begin
 perform device_binding_private.guard();
 select * into q from chat_attachments_private.budget where id=1 for update;
 select * into i from chat_attachments_private.images where id=p_id for update;
 if i.id is null or i.deletion_lease is distinct from p_lease or q.cleanup_lease is distinct from p_lease then perform chat_attachments_private.fail('CONFLICT');end if;
 if i.state='DELETED' then return jsonb_build_object('deleted',true);end if;
 if i.state<>'DELETING' then perform chat_attachments_private.fail('CONFLICT');end if;
 update chat_attachments_private.images set state='DELETED',deleted_at=clock_timestamp(),revision=revision+1 where id=i.id;
 update chat_attachments_private.budget set charged_bytes=charged_bytes-i.bytes,
 cleaning=cleaning and charged_bytes-i.bytes>storage_limit*60/100 where id=1;
 return jsonb_build_object('deleted',true);
end;$$;

create function chat_attachments_private.device_agent(b jsonb,secret text) returns device_binding_private.agents
language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices;a device_binding_private.agents;
begin
 d:=runtime_settings_private.live_device(secret);
 select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id and owner_user_id=d.owner_user_id;
 if a.id is null or a.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(a.id,a.binding_epoch,a.room_id) then perform chat_attachments_private.fail('FORBIDDEN');end if;
 return a;
end;$$;
create function public.chat_attachment_capability(p_body jsonb,p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a device_binding_private.agents;c chat_attachments_private.capabilities;
begin
 perform chat_attachments_private.body(p_body,array['protocol','agentId','bindingEpoch','imageInputVersion']);
 if p_body->'imageInputVersion' is distinct from '1'::jsonb then perform chat_attachments_private.fail('INVALID_BODY');end if;
 a:=chat_attachments_private.device_agent(p_body,p_secret);
 -- Only the provider whose exact installed input/history path was verified is enabled.
 if a.runtime<>'claude' then perform chat_attachments_private.fail('FORBIDDEN');end if;
 insert into chat_attachments_private.capabilities(agent_id,device_id,room_id,binding_epoch,image_input_version,valid_until)
 values(a.id,a.device_id,a.room_id,a.binding_epoch,1,clock_timestamp()+interval '60 seconds')
 on conflict(agent_id) do update set device_id=excluded.device_id,room_id=excluded.room_id,binding_epoch=excluded.binding_epoch,image_input_version=1,valid_until=excluded.valid_until returning * into c;
 perform chat_realtime_private.publish(a.room_id);
 return jsonb_build_object('agentId',a.id,'bindingEpoch',a.binding_epoch,'imageInputVersion',1,'validUntil',c.valid_until);
end;$$;
create function chat_attachments_private.capable(a uuid,e bigint) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from chat_attachments_private.capabilities c join device_binding_private.agents ag on ag.id=c.agent_id
  where c.agent_id=a and c.binding_epoch=e and ag.binding_epoch=e and ag.device_id=c.device_id and ag.room_id=c.room_id
  and ag.runtime='claude' and workflow_private.binding_live(a,e,c.room_id) and c.valid_until>clock_timestamp());
$$;
create function public.chat_attachment_capabilities(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform chat_attachments_private.body(p_body,array['protocol','roomId','expectedUserId']);
 perform chat_attachments_private.user_scope(p_body);
 select coalesce(jsonb_agg(jsonb_build_object('agentId',c.agent_id,'bindingEpoch',c.binding_epoch,'imageInputVersion',1,'validUntil',c.valid_until)),'[]'::jsonb) into result
 from chat_attachments_private.capabilities c where c.room_id=(p_body->>'roomId')::uuid and chat_attachments_private.capable(c.agent_id,c.binding_epoch);
 return result;
end;$$;

alter function public.workflow_human_speak(jsonb) rename to chat_attachment_text_speak;
alter function public.workflow_human_ask(jsonb) rename to chat_attachment_text_ask;
revoke all on function public.chat_attachment_text_speak(jsonb),public.chat_attachment_text_ask(jsonb) from public,anon,authenticated;
create function chat_attachments_private.human(action text,b jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid;r uuid;ph text;prior chat_attachments_private.publications;result jsonb;base jsonb;i chat_attachments_private.images;event uuid;
begin
 -- The original wrappers remain the only implementation for text-only requests.
 if not b ? 'attachmentId' then
  perform device_binding_private.guard();
  if exists(select 1 from chat_attachments_private.publications where room_id=(b->>'roomId')::uuid and user_id=auth.uid() and operation_id=(b->>'operationId')::uuid) then perform chat_attachments_private.fail('CONFLICT');end if;
  if action='speak' then return public.chat_attachment_text_speak(b);else return public.chat_attachment_text_ask(b);end if;
 end if;
 perform chat_attachments_private.body(b,case when action='speak' then array['protocol','roomId','expectedUserId','operationId','publicText','attachmentId'] else array['protocol','roomId','expectedUserId','operationId','targetAgentId','targetEpoch','expectedRoomRevision','publicText','confirmed','attachmentId'] end);
 u:=chat_attachments_private.user_scope(b,true);r:=(b->>'roomId')::uuid;
 perform workflow_private.lock_room(r);
 if jsonb_typeof(b->'publicText') is distinct from 'string' or octet_length(b->>'publicText')>8192 or char_length(b->>'publicText')>4000 or workflow_private.text_trim(b->>'publicText')='' then perform chat_attachments_private.fail('INVALID_BODY');end if;
 b:=b||jsonb_build_object('publicText',workflow_private.text_trim(b->>'publicText'));
 ph:=encode(extensions.digest(b::text,'sha256'),'hex');
 select * into prior from chat_attachments_private.publications where room_id=r and user_id=u and operation_id=(b->>'operationId')::uuid;
 if found then
  if prior.action<>action or prior.payload_hash<>ph then perform chat_attachments_private.fail('CONFLICT');end if;
  return workflow_private.restore(action,prior.result);
 end if;
 if exists(select 1 from workflow_private.receipts where room_id=r and actor_kind='human' and actor_id=u and operation_id=(b->>'operationId')::uuid) then perform chat_attachments_private.fail('CONFLICT');end if;
 select * into i from chat_attachments_private.images where id=(b->>'attachmentId')::uuid for update;
 if i.id is null or i.room_id<>r or i.owner_id<>u then perform chat_attachments_private.fail('FORBIDDEN');end if;
 if i.state<>'READY' or i.created_at<=clock_timestamp()-interval '1 hour' then perform chat_attachments_private.fail('CONFLICT');end if;
 if action='ask' and not chat_attachments_private.capable((b->>'targetAgentId')::uuid,(b->>'targetEpoch')::bigint) then perform chat_attachments_private.fail('CONFLICT');end if;
 -- The client fixes an image-only caption before reserving its exact operation.
 base:=b-'attachmentId';
 if action='speak' then
  result:=public.chat_attachment_text_speak(base);event:=(result->>'eventId')::uuid;
 else
  result:=public.chat_attachment_text_ask(base);
  if result->>'requestId' is null then perform chat_attachments_private.fail('CONFLICT');end if;
  select event_id into event from public.workflow_events where room_id=r and request_id=(result->>'requestId')::uuid and kind='QUESTION' and sender_kind='HUMAN';
 end if;
 perform chat_attachments_private.publish(i.id,r,u,event,case when action='ask' then (result->>'requestId')::uuid else null end);
 insert into chat_attachments_private.publications values(r,u,(b->>'operationId')::uuid,action,ph,result);
 return result;
end;$$;
create function public.workflow_human_speak(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.human('speak',p_body);$$;
create function public.workflow_human_ask(p_body jsonb) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.human('ask',p_body);$$;

create or replace function workflow_private.payload(q uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('requestId',id,'cycleId',cycle_id,'agentId',agent_id,'bindingEpoch',binding_epoch,'roomRevision',revision,'requestKind',kind,'questionId',question_id,'publicText',public_text,'replyText',reply_text,'deadline',deadline)
  ||case when chat_attachments_private.request_descriptor(q) is null then '{}'::jsonb else jsonb_build_object('attachment',chat_attachments_private.request_descriptor(q)) end from workflow_private.requests where id=q;
$$;
alter function public.workflow_device_poll(jsonb,text) rename to chat_attachment_text_poll;
alter function public.workflow_device_claim(jsonb,text) rename to chat_attachment_text_claim;
alter function public.workflow_device_start_intent(jsonb,text) rename to chat_attachment_text_start_intent;
alter function public.workflow_device_lease(jsonb,text) rename to chat_attachment_text_lease;
revoke all on function public.chat_attachment_text_poll(jsonb,text),public.chat_attachment_text_claim(jsonb,text),public.chat_attachment_text_start_intent(jsonb,text),public.chat_attachment_text_lease(jsonb,text) from public,anon,authenticated;
create function chat_attachments_private.device(action text,b jsonb,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a device_binding_private.agents;result jsonb;version integer;image jsonb;
begin
 if b ? 'imageInputVersion' and (action not in ('poll','claim') or b->'imageInputVersion' is distinct from '1'::jsonb) then perform chat_attachments_private.fail('INVALID_BODY');end if;
 perform workflow_private.validate(action,b-'imageInputVersion');
 a:=chat_attachments_private.device_agent(b,secret);
 version:=case when b->'imageInputVersion'='1'::jsonb then 1 else 0 end;
 if action='claim' then
  image:=chat_attachments_private.request_descriptor((b->>'requestId')::uuid);
  if image is not null then
   if version<>1 or not chat_attachments_private.capable(a.id,a.binding_epoch) then perform chat_attachments_private.fail('CONFLICT');end if;
   perform chat_attachments_private.lock_request((b->>'requestId')::uuid);
  end if;
  result:=public.chat_attachment_text_claim(b-'imageInputVersion',secret);
  if image is not null and result ? 'attemptId' then insert into chat_attachments_private.attempt_versions values((result->>'attemptId')::uuid,1) on conflict do nothing;end if;
 elsif action='poll' then
  result:=public.chat_attachment_text_poll(b-'imageInputVersion',secret);
  if version<>1 then
   if result->'queuedRequest' ? 'attachment' then result:=jsonb_set(result,'{queuedRequest}','null');end if;
   if result->'attempt'->'payload' ? 'attachment' then result:=jsonb_set(jsonb_set(result,'{attempt}','null'),'{control}','null');end if;
  end if;
 else
  image:=chat_attachments_private.request_descriptor((b->>'requestId')::uuid);
  if image is not null then
   perform chat_attachments_private.lock_request((b->>'requestId')::uuid);
   if not exists(select 1 from chat_attachments_private.attempt_versions where attempt_id=(b->>'attemptId')::uuid and image_input_version=1) then perform chat_attachments_private.fail('CONFLICT');end if;
  end if;
  if action='start-intent' then result:=public.chat_attachment_text_start_intent(b,secret);else result:=public.chat_attachment_text_lease(b,secret);end if;
 end if;
 return result;
end;$$;
create function public.workflow_device_poll(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.device('poll',p_body,p_secret);$$;
create function public.workflow_device_claim(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.device('claim',p_body,p_secret);$$;
create function public.workflow_device_start_intent(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.device('start-intent',p_body,p_secret);$$;
create function public.workflow_device_lease(p_body jsonb,p_secret text) returns jsonb language sql security definer set search_path='' as $$select chat_attachments_private.device('lease',p_body,p_secret);$$;

create function public.workflow_device_fail_image_before_input(p_body jsonb,p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ag device_binding_private.agents;rq workflow_private.requests;at workflow_private.attempts;cy workflow_private.cycles;rm workflow_private.rooms;prev workflow_private.receipts;ph text;ad text;result jsonb;
begin
 perform chat_attachments_private.body(p_body,array['protocol','operationId','agentId','bindingEpoch','requestId','attemptId','fence','proofVersion','proofHash','reason']);
 if p_body->'proofVersion' is distinct from '1'::jsonb or jsonb_typeof(p_body->'proofHash') is distinct from 'string' or p_body->>'proofHash' !~ '^[a-f0-9]{64}$'
 or p_body->>'reason' not in ('IMAGE_DOWNLOAD_FAILED','IMAGE_CONTENT_MISMATCH','IMAGE_HISTORY_CAPACITY') or jsonb_typeof(p_body->'reason') is distinct from 'string' then perform chat_attachments_private.fail('INVALID_BODY');end if;
 ag:=chat_attachments_private.device_agent(p_body,p_secret);
 select * into rq from workflow_private.requests where id=(p_body->>'requestId')::uuid and device_id=ag.device_id and agent_id=ag.id and binding_epoch=ag.binding_epoch and room_id=ag.room_id;
 if rq.id is null or chat_attachments_private.request_descriptor(rq.id) is null then perform chat_attachments_private.fail('FORBIDDEN');end if;
 select * into at from workflow_private.attempts where id=(p_body->>'attemptId')::uuid and request_id=rq.id and fence=(p_body->>'fence')::bigint and fence=rq.fence;
 if at.id is null or not exists(select 1 from chat_attachments_private.attempt_versions where attempt_id=at.id and image_input_version=1) then perform chat_attachments_private.fail('CONFLICT');end if;
 ph:=encode(extensions.digest(p_body::text,'sha256'),'hex');
 select * into prev from workflow_private.receipts where room_id=ag.room_id and actor_kind='device' and actor_id=ag.device_id and operation_id=(p_body->>'operationId')::uuid;
 if found then
  if prev.action<>'fail-image-before-input' or prev.payload_hash<>ph then perform chat_attachments_private.fail('CONFLICT');end if;
  return prev.result;
 end if;
 if at.state not in ('EXECUTING','UNKNOWN') or at.start_intent_at is null or exists(select 1 from chat_attachments_private.preinput_failures where attempt_id=at.id) then perform chat_attachments_private.fail('CONFLICT');end if;
 select * into cy from workflow_private.cycles where id=rq.cycle_id;select * into rm from workflow_private.rooms where room_id=ag.room_id;
 ad:=case when at.state='EXECUTING' and cy.state='ACTIVE' and rq.generation=cy.generation and rq.revision=rm.revision and workflow_private.cycle_scope_live(cy) and cy.deadline>clock_timestamp() and rq.deadline>clock_timestamp() then 'HUMAN_INPUT_REQUIRED' else 'HISTORICAL' end;
 update workflow_private.attempts set state='FAILED',terminal_text='',adoption=ad where id=at.id;
 perform workflow_private.state(rq.id,'FAILED');
 if rq.kind='PEER' then update workflow_private.questions set adoption='HISTORICAL' where id=rq.question_id;end if;
 perform workflow_private.human_required(cy.id);
 -- Attachment preparation failures do not revoke readiness or the device binding.
 perform workflow_private.reconcile(ag.room_id);
 select adoption into ad from workflow_private.attempts where id=at.id;
 result:=jsonb_build_object('requestId',rq.id,'attemptId',at.id,'fence',at.fence,'bindingEpoch',ag.binding_epoch,'state','FAILED','kind','ATTACHMENT_PREINPUT_REJECTED','proofHash',p_body->>'proofHash','adoption',ad);
 insert into chat_attachments_private.preinput_failures values(at.id,rq.id,ag.device_id,ag.room_id,p_body->>'proofHash',p_body->>'reason',result);
 insert into workflow_private.receipts values(ag.room_id,'device',ag.device_id,(p_body->>'operationId')::uuid,'fail-image-before-input',ph,result);
 return result;
end;$$;

-- Preserve SQL024's text proof path. An image proof releases a retained interrupt
-- only when its request/attempt/fence, device, room and immutable receipt match.
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
     where p.attempt_id=ctl.attempt_id and p.request_id=ctl.request_id and p.fence=ctl.fence)
   and not exists(select 1 from chat_attachments_private.preinput_failures p
     join workflow_private.attempts a on a.id=p.attempt_id and a.request_id=p.request_id and a.state='FAILED'
     where p.attempt_id=ctl.attempt_id and p.request_id=ctl.request_id and a.fence=ctl.fence
       and p.device_id=q.device_id and p.room_id=q.room_id and p.proof_hash ~ '^[a-f0-9]{64}$'
       and p.receipt @> jsonb_build_object('requestId',q.id,'attemptId',a.id,'fence',a.fence,
         'bindingEpoch',q.binding_epoch,'proofHash',p.proof_hash,'state','FAILED','kind','ATTACHMENT_PREINPUT_REJECTED')))
 and not exists(select 1 from workflow_private.questions q join related r on r.id=q.cycle_id where q.adoption='PENDING');
$$;

-- Only an opaque change hint is broadcast. Event sequence/content stay immutable.
create trigger chat_image_changed after update of state on chat_attachments_private.images
 for each row when (old.event_id is not null and old.state is distinct from new.state) execute function chat_realtime_private.changed();
revoke all on all functions in schema chat_attachments_private from public,anon,authenticated;
revoke all on function public.chat_attachment_authorize_upload(jsonb),public.chat_attachment_reserve(jsonb),public.chat_attachment_read(jsonb),public.chat_attachment_user_download(jsonb),public.chat_attachment_device_download(jsonb,text),public.chat_attachment_finalize(uuid),public.chat_attachment_cleanup_claim(integer),public.chat_attachment_cleanup_confirm(uuid,uuid) from public,anon,authenticated;
grant execute on function public.chat_attachment_authorize_upload(jsonb),public.chat_attachment_reserve(jsonb),public.chat_attachment_read(jsonb),public.chat_attachment_user_download(jsonb) to authenticated;
grant execute on function public.chat_attachment_device_download(jsonb,text) to anon;
grant execute on function public.chat_attachment_finalize(uuid),public.chat_attachment_cleanup_claim(integer),public.chat_attachment_cleanup_confirm(uuid,uuid) to service_role;
revoke all on function public.workflow_human_speak(jsonb),public.workflow_human_ask(jsonb),public.workflow_device_poll(jsonb,text),public.workflow_device_claim(jsonb,text),public.workflow_device_start_intent(jsonb,text),public.workflow_device_lease(jsonb,text),public.workflow_device_fail_image_before_input(jsonb,text),public.chat_attachment_capability(jsonb,text),public.chat_attachment_capabilities(jsonb) from public,anon,authenticated;
grant execute on function public.workflow_human_speak(jsonb),public.workflow_human_ask(jsonb),public.chat_attachment_capabilities(jsonb) to authenticated;
grant execute on function public.workflow_device_poll(jsonb,text),public.workflow_device_claim(jsonb,text),public.workflow_device_start_intent(jsonb,text),public.workflow_device_lease(jsonb,text),public.workflow_device_fail_image_before_input(jsonb,text),public.chat_attachment_capability(jsonb,text) to anon;
commit;
