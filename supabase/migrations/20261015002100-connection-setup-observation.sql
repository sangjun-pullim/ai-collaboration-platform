begin;
-- Observations never modify runtime operations, credentials, or immutable receipts.
create schema connection_setup_private;
revoke all on schema connection_setup_private from public, anon, authenticated;
create table connection_setup_private.tickets (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  organization_id uuid not null,
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  payload text not null check (octet_length(payload) <= 16384),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '30 minutes',
  first_attempt uuid,
  primary key(owner_id, request_id)
);
create table connection_setup_private.attempts (
  key_hash text not null references connection_setup_private.tickets(key_hash) on delete cascade,
  attempt_id uuid not null,
  ordinal integer not null check (ordinal between 1 and 8),
  sequence bigint not null,
  body jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key(key_hash, attempt_id), unique(key_hash, ordinal)
);
create table connection_setup_private.observations (
  device_id uuid not null,
  operation_id uuid not null,
  config_revision bigint not null,
  sequence bigint not null,
  body jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key(device_id, operation_id),
  foreign key(device_id, operation_id) references runtime_settings_private.operations(device_id, operation_id) on delete cascade
);
alter table connection_setup_private.tickets enable row level security;
alter table connection_setup_private.attempts enable row level security;
alter table connection_setup_private.observations enable row level security;
revoke all on all tables in schema connection_setup_private from public, anon, authenticated;

create function connection_setup_private.clean() returns void
language plpgsql security definer set search_path='' as $$
begin
  delete from connection_setup_private.tickets where (owner_id,request_id) in
    (select owner_id,request_id from connection_setup_private.tickets
     where created_at < clock_timestamp()-interval '24 hours' order by created_at limit 128);
  delete from connection_setup_private.observations where (device_id,operation_id) in
    (select device_id,operation_id from connection_setup_private.observations
     where received_at < clock_timestamp()-interval '24 hours' order by received_at limit 128);
end;$$;

create function connection_setup_private.description_ok(p text) returns boolean
language plpgsql immutable set search_path='' as $$
declare b jsonb; s jsonb; g jsonb; previous text; expected text;
begin
  b:=p::jsonb; s:=b->'selection';
  if exists(select 1 from jsonb_each(b) e where e.value='null'::jsonb)
    or jsonb_typeof(b->'ownerUserId')<>'string' or jsonb_typeof(b->'organizationId')<>'string'
    or jsonb_typeof(b->'roomId')<>'string' or jsonb_typeof(b->'deviceAlias')<>'string' then return false; end if;
  if octet_length(p)>16384 or not runtime_settings_private.keys(b,array['version','origin','ownerUserId','organizationId','roomId','deviceAlias','selection'])
    or b->'version' is distinct from '1'::jsonb or jsonb_typeof(b->'origin')<>'string'
    or b->>'origin' !~ '^(https://[^/?#@[:space:]]+|http://(localhost|127[.]0[.]0[.]1|\[::1\])(:[0-9]+)?)$'
    or not runtime_settings_private.id_ok(b->>'ownerUserId') or not runtime_settings_private.id_ok(b->>'organizationId')
    or not runtime_settings_private.id_ok(b->>'roomId') or not device_binding_private.alias_ok(b->>'deviceAlias')
    or not runtime_settings_private.keys(s,array['version','baseProfile','chain']) or s->'version' is distinct from '1'::jsonb
    or jsonb_typeof(s->'chain')<>'array' or jsonb_array_length(s->'chain')>32 then return false; end if;
  previous:='web-'||substr(encode(extensions.digest(
    '['||to_json(b->>'origin')::text||','||to_json(b->>'ownerUserId')::text||','||to_json(b->>'roomId')::text||']','sha256'),'hex'),1,32);
  if s->>'baseProfile' is distinct from previous then return false; end if;
  for g in select value from jsonb_array_elements(s->'chain') loop
    if not runtime_settings_private.keys(g,array['previousProfile','recoveryId','profile'])
      or jsonb_typeof(g->'previousProfile')<>'string' or jsonb_typeof(g->'recoveryId')<>'string' or jsonb_typeof(g->'profile')<>'string'
      or g->>'previousProfile' is distinct from previous
      or g->>'recoveryId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then return false; end if;
    expected:='web-'||substr(encode(extensions.digest(
      '["connection-recovery",'||to_json(previous)::text||','||to_json(g->>'recoveryId')::text||']','sha256'),'hex'),1,32);
    if g->>'profile' is distinct from expected or expected=previous then return false; end if;
    previous:=expected;
  end loop;
  return true;
exception when others then return false;
end;$$;

create function connection_setup_private.observation_json(b jsonb,t timestamptz) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
  return b||jsonb_build_object('receivedAt',to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;$$;
create function public.connection_setup_human(p_action text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid; r public.rooms; t connection_setup_private.tickets; old connection_setup_private.tickets;
  b jsonb; a connection_setup_private.attempts; d device_binding_private.devices; o jsonb; obs jsonb;
begin
  perform device_binding_private.guard();
  u:=room_access_private.actor();
  if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>16384 then
    perform runtime_settings_private.fail('INVALID_BODY'); end if;
  if p_action='issue' then
    if not runtime_settings_private.keys(p_body,array['requestId','payload','payloadHash','keyHash'])
      or not runtime_settings_private.id_ok(p_body->>'requestId')
      or jsonb_typeof(p_body->'requestId')<>'string' or jsonb_typeof(p_body->'keyHash')<>'string'
      or jsonb_typeof(p_body->'payloadHash')<>'string' or jsonb_typeof(p_body->'payload')<>'string'
      or not coalesce(connection_setup_private.description_ok(p_body->>'payload'),false)
      or p_body->>'keyHash' !~ '^[a-f0-9]{64}$'
      or p_body->>'payloadHash' is distinct from encode(extensions.digest(p_body->>'payload','sha256'),'hex')
      then perform runtime_settings_private.fail('INVALID_BODY'); end if;
    b:=(p_body->>'payload')::jsonb;
    if b->>'ownerUserId' is distinct from u::text then perform runtime_settings_private.fail('FORBIDDEN'); end if;
    select * into r from public.rooms where id=(b->>'roomId')::uuid;
  elsif p_action in ('scope','inspect') then
    if not runtime_settings_private.keys(p_body,case when p_action='scope' then array['roomId'] else array['roomId','requestId','deviceId'] end)
      or jsonb_typeof(p_body->'roomId')<>'string' or not runtime_settings_private.id_ok(p_body->>'roomId')
      or (p_action='inspect' and ((p_body->'requestId'<>'null'::jsonb and not runtime_settings_private.id_ok(p_body->>'requestId'))
        or (p_body->'deviceId'<>'null'::jsonb and not runtime_settings_private.id_ok(p_body->>'deviceId')))) then
      perform runtime_settings_private.fail('INVALID_BODY'); end if;
    select * into r from public.rooms where id=(p_body->>'roomId')::uuid;
  else perform runtime_settings_private.fail('NOT_FOUND'); end if;
  if r.id is null then perform runtime_settings_private.fail('FORBIDDEN'); end if;
  perform device_binding_private.lock_scope(r.organization_id,r.id);
  if not device_binding_private.live(u,r.organization_id,r.id) then perform runtime_settings_private.fail('FORBIDDEN'); end if;
  if p_action='scope' then return jsonb_build_object('organizationId',r.organization_id); end if;
  if p_action='issue' then
    if b->>'organizationId' is distinct from r.organization_id::text then perform runtime_settings_private.fail('FORBIDDEN'); end if;
    -- Serialize quotas and idempotency for this owner, even across rooms.
    perform pg_catalog.pg_advisory_xact_lock(hashtextextended(u::text,4021));
    perform connection_setup_private.clean();
    select * into old from connection_setup_private.tickets where owner_id=u and request_id=(p_body->>'requestId')::uuid;
    if found then
      if old.payload is distinct from p_body->>'payload' then perform runtime_settings_private.fail('CONFLICT'); end if;
      return jsonb_build_object('requestId',old.request_id,'payloadHash',old.payload_hash,'expiresAt',old.expires_at,'created',false,'reissueRequired',true);
    end if;
    if (select count(*) from connection_setup_private.tickets where owner_id=u and expires_at>clock_timestamp())>=32
      or (select count(*) from connection_setup_private.tickets where owner_id=u and created_at>clock_timestamp()-interval '24 hours')>=128 then
      perform runtime_settings_private.fail('QUOTA'); end if;
    insert into connection_setup_private.tickets(owner_id,request_id,room_id,organization_id,key_hash,payload,payload_hash)
      values(u,(p_body->>'requestId')::uuid,r.id,r.organization_id,p_body->>'keyHash',p_body->>'payload',p_body->>'payloadHash') returning * into t;
    return jsonb_build_object('requestId',t.request_id,'payloadHash',t.payload_hash,'expiresAt',t.expires_at,'created',true,'reissueRequired',false);
  end if;
  if p_body->'requestId'<>'null'::jsonb then
    select * into t from connection_setup_private.tickets where owner_id=u and room_id=r.id and request_id=(p_body->>'requestId')::uuid;
    if not found then perform runtime_settings_private.fail('NOT_FOUND'); end if;
    select * into a from connection_setup_private.attempts where key_hash=t.key_hash and attempt_id=t.first_attempt;
  end if;
  if p_body->'deviceId'<>'null'::jsonb then
    select * into d from device_binding_private.devices where id=(p_body->>'deviceId')::uuid and owner_user_id=u and room_id=r.id;
    if not found then perform runtime_settings_private.fail('FORBIDDEN'); end if;
    o:=runtime_settings_private.response(d.id,null);
    -- Catalogs are fetched through the unchanged settings API, not diagnostic polling.
    o:=jsonb_set(o,'{catalog}','null'::jsonb);
    select connection_setup_private.observation_json(x.body,x.received_at) into obs from connection_setup_private.observations x
      where x.device_id=d.id and x.operation_id=(o->'operation'->>'operationId')::uuid
        and x.config_revision=(o->>'configRevision')::bigint;
  end if;
  return jsonb_build_object('requestId',t.request_id,'expiresAt',t.expires_at,
    'startup',case when a.attempt_id is null then null else connection_setup_private.observation_json(a.body,a.received_at)||'{"authenticated":false}'::jsonb end,
    'settings',obs,'runtime',o,'device',case when d.id is null then null else jsonb_build_object('deviceId',d.id,'state',d.state,
      'authenticated',d.state='active' and exists(select 1 from device_binding_private.credentials c where c.hash=d.current_hash and c.revoked_at is null and c.expires_at>clock_timestamp())) end);
end;$$;

create function public.connection_setup_device(p_action text,p_body jsonb,p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t connection_setup_private.tickets; a connection_setup_private.attempts;
  d device_binding_private.devices; o runtime_settings_private.operations; c runtime_settings_private.configurations;
  x connection_setup_private.observations; n integer; result jsonb;
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then perform runtime_settings_private.fail('UNAUTHENTICATED'); end if;
  if p_body is null or jsonb_typeof(p_body)<>'object' or octet_length(p_body::text)>16384 then perform runtime_settings_private.fail('INVALID_BODY'); end if;
  if p_action in ('resolve','startup-report') then
    select * into t from connection_setup_private.tickets where key_hash=encode(extensions.digest(p_secret,'sha256'),'hex');
    if not found then perform runtime_settings_private.fail('UNAUTHENTICATED'); end if;
    perform device_binding_private.lock_scope(t.organization_id,t.room_id);
    select * into t from connection_setup_private.tickets where key_hash=t.key_hash for update;
    if t.expires_at<=clock_timestamp() then perform runtime_settings_private.fail('CONFLICT'); end if;
    if not device_binding_private.live(t.owner_id,t.organization_id,t.room_id) then perform runtime_settings_private.fail('FORBIDDEN'); end if;
    perform connection_setup_private.clean();
    if p_action='resolve' then
      if not runtime_settings_private.keys(p_body,array[]::text[]) then perform runtime_settings_private.fail('INVALID_BODY'); end if;
      return jsonb_build_object('payload',t.payload,'payloadHash',t.payload_hash,'expiresAt',t.expires_at);
    end if;
    if not runtime_settings_private.keys(p_body,array['attemptId','sequence','stage','reason'])
      or jsonb_typeof(p_body->'attemptId')<>'string' or not runtime_settings_private.id_ok(p_body->>'attemptId') then perform runtime_settings_private.fail('INVALID_BODY'); end if;
  elsif p_action in ('settings-inspect','settings-report') then
    if not runtime_settings_private.keys(p_body,case when p_action='settings-inspect' then array['deviceId','operationId','configRevision']
      else array['deviceId','operationId','configRevision','sequence','stage','reason'] end)
      or jsonb_typeof(p_body->'deviceId')<>'string' or jsonb_typeof(p_body->'operationId')<>'string'
      or not runtime_settings_private.id_ok(p_body->>'deviceId') or not runtime_settings_private.id_ok(p_body->>'operationId')
      or jsonb_typeof(p_body->'configRevision')<>'number' or p_body->>'configRevision' !~ '^(0|[1-9][0-9]{0,15})$' then perform runtime_settings_private.fail('INVALID_BODY'); end if;
    d:=runtime_settings_private.live_device(p_secret);
    if d.id::text<>p_body->>'deviceId' then perform runtime_settings_private.fail('FORBIDDEN'); end if;
    select * into c from runtime_settings_private.configurations where device_id=d.id for update;
    select * into o from runtime_settings_private.operations where device_id=d.id and operation_id=(p_body->>'operationId')::uuid for update;
    if c.device_id is null or o.operation_id is null or o.expected_revision<>(p_body->>'configRevision')::bigint
      or c.revision<>o.expected_revision or o.state in ('COMMITTED','APPLIED')
      or (o.state='CANCELLED' and o.applied_receipt is not null)
      or exists(select 1 from runtime_settings_private.operations newer where newer.device_id=d.id and newer.created_at>o.created_at) then
      perform runtime_settings_private.fail('CONFLICT'); end if;
    select * into x from connection_setup_private.observations where device_id=d.id and operation_id=o.operation_id;
    if p_action='settings-inspect' then
      return jsonb_build_object('sequence',coalesce(x.sequence,0),'observation',case when x.operation_id is null then null else connection_setup_private.observation_json(x.body,x.received_at) end);
    end if;
  else perform runtime_settings_private.fail('NOT_FOUND'); end if;
  if jsonb_typeof(p_body->'sequence')<>'number' or p_body->>'sequence' !~ '^[1-9][0-9]{0,15}$'
    or (p_body->>'sequence')::numeric>9007199254740991
    or jsonb_typeof(p_body->'stage')<>'string' or jsonb_typeof(p_body->'reason') not in ('string','null') then perform runtime_settings_private.fail('INVALID_BODY'); end if;
  if (p_action='startup-report' and (p_body->>'stage' not in ('PREPARING','DOWNLOADING','CONNECTING','FAILED')
    or (p_body->'reason'<>'null'::jsonb and p_body->>'reason' not in ('UNCONFIRMED','TIMEOUT','DENIED','UNSUPPORTED','FAILED','SHARING_UNCONFIRMED','PROVIDER_UNAVAILABLE','RUNTIME_BUSY','SNAPSHOT_CHANGED','POLICY_UNCONFIRMED','CONTEXT_UNCONFIRMED','CLEANUP_INCOMPLETE','FORBIDDEN','CONFLICT','UNAUTHENTICATED','UNAVAILABLE','MACOS_REQUIRED','MACOS_13_5_REQUIRED','UNSUPPORTED_ARCHITECTURE','DOWNLOAD_FAILED','DOWNLOAD_DIGEST','INVALID_MANIFEST','INVALID_ARCHIVE','INVALID_DESCRIPTION','EXPIRED','RUNTIME_VERSION','RUNTIME_ARCHIVE','RUNTIME_FILE','REDIRECT_OR_HTTP_ERROR','DOWNLOAD_SIZE','MACOS_VERSION'))))
    or (p_action='settings-report' and (p_body->>'stage' not in ('FOLDER_SELECTION','SHARING_CONFIRMATION','MODEL_DISCOVERY','MODEL_SELECTION','APPLYING','CANCELLING','FAILED')
    or (p_body->'reason'<>'null'::jsonb and p_body->>'reason' not in ('UNCONFIRMED','TIMEOUT','DENIED','UNSUPPORTED','FAILED','SHARING_UNCONFIRMED','PROVIDER_UNAVAILABLE','RUNTIME_BUSY','SNAPSHOT_CHANGED','POLICY_UNCONFIRMED','CONTEXT_UNCONFIRMED','CLEANUP_INCOMPLETE','FORBIDDEN','CONFLICT','UNAUTHENTICATED','UNAVAILABLE')))) then
    perform runtime_settings_private.fail('INVALID_BODY'); end if;
  if p_action='startup-report' then
    select * into a from connection_setup_private.attempts where key_hash=t.key_hash and attempt_id=(p_body->>'attemptId')::uuid;
    if a.attempt_id is null then
      select count(*)+1 into n from connection_setup_private.attempts where key_hash=t.key_hash;
      if n>8 then perform runtime_settings_private.fail('QUOTA'); end if;
      insert into connection_setup_private.attempts(key_hash,attempt_id,ordinal,sequence,body)
        values(t.key_hash,(p_body->>'attemptId')::uuid,n,(p_body->>'sequence')::bigint,p_body) returning * into a;
      update connection_setup_private.tickets set first_attempt=coalesce(first_attempt,a.attempt_id) where key_hash=t.key_hash;
    elsif (p_body->>'sequence')::bigint<a.sequence or ((p_body->>'sequence')::bigint=a.sequence and a.body<>p_body) then
      perform runtime_settings_private.fail('CONFLICT');
    elsif (p_body->>'sequence')::bigint>a.sequence then
      update connection_setup_private.attempts set sequence=(p_body->>'sequence')::bigint,body=p_body,received_at=clock_timestamp()
        where key_hash=t.key_hash and attempt_id=a.attempt_id returning * into a;
    end if;
    return jsonb_build_object('accepted',true);
  end if;
  if x.operation_id is not null and ((p_body->>'sequence')::bigint<x.sequence or ((p_body->>'sequence')::bigint=x.sequence and x.body<>p_body)) then
    perform runtime_settings_private.fail('CONFLICT'); end if;
  if x.operation_id is null or (p_body->>'sequence')::bigint>x.sequence then
    insert into connection_setup_private.observations(device_id,operation_id,config_revision,sequence,body)
      values(d.id,o.operation_id,o.expected_revision,(p_body->>'sequence')::bigint,p_body)
      on conflict(device_id,operation_id) do update set sequence=excluded.sequence,body=excluded.body,received_at=clock_timestamp() returning * into x;
  end if;
  return jsonb_build_object('sequence',x.sequence,'observation',connection_setup_private.observation_json(x.body,x.received_at));
end;$$;
revoke all on all functions in schema connection_setup_private from public, anon, authenticated;
revoke all on function public.connection_setup_human(text,jsonb),public.connection_setup_device(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.connection_setup_human(text,jsonb) to authenticated;
grant execute on function public.connection_setup_device(text,jsonb,text) to anon;
notify pgrst,'reload schema';
commit;
