begin;

create schema source_history_private;
revoke all on schema source_history_private from public,anon,authenticated,service_role;
-- Mutable Auth/device/workspace identifiers deliberately have no cascading FK.

create table source_history_private.targets (
  request_id uuid primary key references workflow_private.requests(id) on delete cascade,
  room_id uuid not null,
  target jsonb not null
);

create table source_history_private.manifests (
  attempt_id uuid primary key references workflow_private.attempts(id) on delete cascade,
  request_id uuid not null,
  room_id uuid not null,
  agent_id uuid not null,
  binding_epoch bigint not null,
  fence bigint not null,
  manifest_hash text not null,
  count integer not null,
  total_bytes integer not null,
  confirmed boolean not null default false,
  summary jsonb,
  check(count between 1 and 512 and total_bytes between 1 and 4194304),
  check(manifest_hash ~ '^[a-f0-9]{64}$'),
  check(confirmed=(summary is not null))
);

create table source_history_private.packets (
  attempt_id uuid not null references source_history_private.manifests(attempt_id) on delete cascade,
  index integer not null,
  room_id uuid not null,
  device_id uuid not null,
  operation_id uuid not null,
  packet_json text not null,
  chunk bytea not null,
  ack jsonb not null,
  primary key(attempt_id, index),
  unique(room_id, device_id, operation_id),
  check(index between 0 and 511),
  check(octet_length(chunk) between 1 and 8192)
);

create table source_history_private.files (
  attempt_id uuid not null references source_history_private.manifests(attempt_id) on delete cascade,
  index integer not null,
  row_json jsonb not null,
  primary key(attempt_id,index),
  check(index between 0 and 4095)
);

create table source_history_private.events (
  event_id uuid primary key references public.workflow_events(event_id) on delete cascade,
  request_id uuid not null,
  attempt_id uuid references source_history_private.manifests(attempt_id),
  target jsonb not null
);

create function source_history_private.fail(code text) returns void language plpgsql set search_path='' as
$$
begin
  raise exception using message=code,errcode='P0001';
  end;
$$;
create function source_history_private.keys(v jsonb,

  k text[]) returns boolean language sql immutable set search_path='' as
$$
select case
  when jsonb_typeof(v)='object' then (select count(*) from jsonb_object_keys(v))=cardinality(k)
  and v ?& k else false end;
$$;
create function source_history_private.uint(v jsonb,

  maximum bigint default 9007199254740991) returns boolean language sql immutable set search_path='' as
$$
select case
  when jsonb_typeof(v)='number'
  and v::text ~ '^(0|[1-9][0-9]{0,15})$' then (v::text)::numeric<=maximum else false end;
$$;

create function source_history_private.hash(v jsonb) returns boolean language sql immutable set search_path='' as
$$
select coalesce(jsonb_typeof(v)='string' and v#>>'{}' ~ '^[a-f0-9]{64}$',false);
$$;

create function source_history_private.id(v jsonb) returns boolean language sql immutable set search_path='' as
$$
select coalesce(jsonb_typeof(v)='string'
  and v#>>'{}' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
  false);
$$;

create function source_history_private.time(v jsonb) returns boolean language plpgsql immutable set search_path='' as
$$
declare
  t text:=v#>>'{}';
begin
  if jsonb_typeof(v)<>'string' or t !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' then
    return false;
  end if;
  return to_char(t::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t;
  exception when others then return false;
  end;
$$;
-- Scan UTF16 integers. The inner token is never cast to json/jsonb, even for NUL or lone surrogates.

create function source_history_private.token_units(token text) returns integer[] language plpgsql immutable set search_path='' as
$$
declare
  units integer[]:=array[]::integer[];
  escaped boolean[]:=array[]::boolean[];
  i integer:=2;
  n integer:=char_length(token);
  ch text;
  cp integer;
  hex text;
  j integer;
  was boolean;
begin
  if n<2 or n>3074 or left(token,1)<>'"' or right(token,1)<>'"' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  while i<n loop
    ch:=substr(token,i,1);
    cp:=ascii(ch);
    was:=false;
    if ch=chr(92) then
      i:=i+1;
      ch:=substr(token,i,1);
      was:=true;
      if ch in ('"',chr(92)) then
        cp:=ascii(ch);
      elsif ch='b' then
        cp:=8;
      elsif ch='f' then
        cp:=12;
      elsif ch='n' then
        cp:=10;
      elsif ch='r' then
        cp:=13;
      elsif ch='t' then
        cp:=9;
      elsif ch='u' then
        hex:=substr(token,i+1,4);
        if hex !~ '^[0-9a-f]{4}$' then
          perform source_history_private.fail('INVALID_BODY');
        end if;
        cp:=0;
        for j in 1..4 loop
          cp:=cp*16+strpos('0123456789abcdef',substr(hex,j,1))-1;
        end loop;
        i:=i+4;
        if not (cp between 55296 and 57343 or cp between 0 and 31 and cp not in (8,9,10,12,13)) then
          perform source_history_private.fail('INVALID_BODY');
        end if;
      else
        perform source_history_private.fail('INVALID_BODY');
      end if;
    elsif cp<32 or ch='"' then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    if cp>65535 then
      cp:=cp-65536;
      units:=units||(55296+cp/1024)||(56320+cp%1024);
      escaped:=escaped||false||false;
    else
      units:=units||cp;
      escaped:=escaped||was;
    end if;
    i:=i+1;
  end loop;
  if i<>n then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  if cardinality(units)>1 then
    for j in 1..cardinality(units)-1 loop
      if units[j] between 55296 and 56319 and units[j+1] between 56320 and 57343 and (escaped[j] or escaped[j+1]) then
        perform source_history_private.fail('INVALID_BODY');
      end if;
    end loop;
  end if;
  return units;
  end;
$$;
create function source_history_private.path(token text,

  selected boolean default true) returns integer[] language plpgsql immutable set search_path='' as
$$
declare
  units integer[];
  cp integer;
  parts text[]:=array[]::text[];
  part text:='';
begin
  units:=source_history_private.token_units(token);
  if cardinality(units)<1 or cardinality(units)>512 or units[1]=47 then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  foreach cp in array units loop
    if cp in (0,10,13,92) then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    if cp=47 then
      parts:=parts||part;
      part:='';
    else
      part:=part||case when cp between 1 and 127 then chr(cp) else '~' end;
    end if;
  end loop;
  parts:=parts||part;
  foreach part in array parts loop
    if part in ('',
      '.',
      '..')
      or selected
      and part ~* '^([.]git|[.]codex|[.]claude|[.]agents|[.]ssh|[.]aws|[.]config|node_modules|[.]next|[.]cache|cache|credentials?|auth([.]json)?|[.]env([.].*)?|.*[.](pem|key|p12|pfx|sqlite|db))$' then
      perform source_history_private.fail('INVALID_BODY');
    end if;
  end loop;
  return units;
  end;
$$;

create function source_history_private.repository_path(token text) returns void language plpgsql immutable set search_path='' as
$$
declare
  units integer[];
  cp integer;
  t text:='';
  parts text[];
  part text;
  name text;
  i integer;
  doc text:='[.](md|mdx|txt|rst|adoc|json|jsonc|yaml|yml|toml|xml|ini|conf|properties|csv|tsv)$';
  protected text:='^(AGENTS[.]md|CLAUDE[.]md|CODEX[.]md|mcp[.]json|settings[.](json|jsonc|yaml|yml|toml)|(auth|authentication|credentials?|secrets?|tokens?|passwords?|api[._-]?keys?|access[._-]?tokens?|client[._-]?secrets?)([._-].*)?|(settings|config)[.](local[.])?(claude|codex|mcp)[.].*|(claude|codex|agent)[._-]settings([._-].*)?)$';
begin
  units:=source_history_private.path(token,false);
  foreach cp in array units loop
    t:=t||case when cp between 1 and 127 then chr(cp) else '~' end;
  end loop;
  parts:=string_to_array(t,'/');
  name:=parts[cardinality(parts)];
  for i in 1..cardinality(parts) loop
    part:=parts[i];
    if left(part,1)='.' or part ~* '[.](pem|key|p12|pfx|sqlite(3)?|db|der|crt|cer|keystore|jks)$' then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    if i<cardinality(parts)
      and (part ~* '^(node_modules|vendor|build|dist|coverage|cache|target|out|bower_components|credentials?|secrets?|__generated__|__pycache__)$'
      or part ~* '^(AGENTS[.]md|CLAUDE[.]md|CODEX[.]md|mcp[.]json|auth[.]json)$'
      or part ~* doc
      and part ~* protected) then
      perform source_history_private.fail('INVALID_BODY');
    end if;
  end loop;
  if name ~* '[.](min|bundle|generated)[.]' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  if name ~* '[.](ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|m|mm|php|sh|bash|zsh|sql|vue|svelte|html|css|scss|sass|less|graphql|gql|proto)$' then
    return;
  end if;
  if name ~* protected or not (name ~* doc or name ~* '^(LICENSE|NOTICE|README|Dockerfile|Makefile)$') then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  end;
$$;

create function source_history_private.ref(v jsonb) returns void language plpgsql immutable set search_path='' as
$$
declare
  units integer[];
  cp integer;
  t text:='';
begin
  if v='null'::jsonb then
    return;
  end if;
  if jsonb_typeof(v)<>'string' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  units:=source_history_private.token_units(v#>>'{}');
  foreach cp in array units loop
    if cp>127 or cp=0 then perform source_history_private.fail('INVALID_BODY');
  end if;
  t:=t||chr(cp);
  end loop;
  if t<>'unknown'
    and (cardinality(units)>120
    or t !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    or strpos(t,
    '..')>0
    or strpos(t,
    '//')>0
    or right(t,
    1) in ('/',
    '.')
    or right(t,
    5)='.lock') then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  end;
$$;
-- Source schema has fixed ASCII keys. Serialize explicitly instead of substituting jsonb::text.

create function source_history_private.canonical(v jsonb) returns text language plpgsql immutable set search_path='' as
$$
declare
  result text;
begin
  if jsonb_typeof(v)='object' then
    select '{'||coalesce(string_agg(to_json(k)::text||':'||source_history_private.canonical(value),
      ',' order by k collate "C"),
      '')||'}' into result from jsonb_each(v) as e(k,
      value);
    return result;
  elsif jsonb_typeof(v)='array' then
    select '['||coalesce(string_agg(source_history_private.canonical(value),
      ',' order by ord),
      '')||']' into result from jsonb_array_elements(v) with ordinality as e(value,
      ord);
    return result;
  elsif jsonb_typeof(v)='number' then
    if (v::text)::numeric=trunc((v::text)::numeric) and abs((v::text)::numeric)<=9007199254740991 then
      return ((v::text)::numeric)::bigint::text;
    end if;
  end if;
  return v::text;
  end;
$$;

create function source_history_private.digest(t text) returns text language sql immutable set search_path='' as
$$
select encode(extensions.digest(convert_to(t,'UTF8'),'sha256'),'hex');
$$;

create function source_history_private.input(v jsonb) returns void language plpgsql immutable set search_path='' as
$$
declare
  e jsonb;
  entries text:='';
  previous integer[];
  current integer[];
  git text;
  files text;
  body text;
  token text;
begin
  if coalesce(not source_history_private.keys(v,
    array['version',
    'kind',
    'git',
    'files',
    'observationHash'])
    or v->'version'<>'1'::jsonb
    or v->>'kind'<>'INPUT_SOURCE_OBSERVATION'
  or not source_history_private.keys(v->'git',
    array['observedAt',
    'commit',
    'refJson',
    'dirty'])
    or not source_history_private.time(v->'git'->'observedAt')
    or v->'git'->>'dirty'<>'unknown'
  or not (v->'git'->'commit'='null'::jsonb
    or jsonb_typeof(v->'git'->'commit')='string'
    and v->'git'->>'commit' ~ '^([a-f0-9]{40}|[a-f0-9]{64})$')
  or not source_history_private.keys(v->'files',
    array['validatedAt',
    'pathBase',
    'entries',
    'manifestHash'])
    or not source_history_private.time(v->'files'->'validatedAt')
    or v->'files'->>'pathBase'<>'SELECTED_ROOT'
  or jsonb_typeof(v->'files'->'entries')<>'array'
    or jsonb_array_length(v->'files'->'entries')>32
    or not source_history_private.hash(v->'files'->'manifestHash')
    or not source_history_private.hash(v->'observationHash'),
    true) then perform source_history_private.fail('INVALID_BODY');
  end if;
  perform source_history_private.ref(v->'git'->'refJson');
  for e in select value from jsonb_array_elements(v->'files'->'entries') loop
    if not source_history_private.keys(e,
      array['pathJson',
      'hash'])
      or jsonb_typeof(e->'pathJson')<>'string'
      or not source_history_private.hash(e->'hash') then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    token:=e->>'pathJson';
    current:=source_history_private.path(token);
    if previous is not null and previous>=current then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    previous:=current;
    entries:=entries||case when entries='' then '' else ',' end||'{"hash":'||(e->'hash')::text||',"path":'||token||'}';
  end loop;
  entries:='['||entries||']';
  if source_history_private.digest(entries)<>v->'files'->>'manifestHash' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  git:='{"commit":'||(v->'git'->'commit')::text||',"dirty":"unknown","observedAt":'||(v->'git'->'observedAt')::text||',"ref":'||case
    when v->'git'->'refJson'='null'::jsonb then 'null' else v->'git'->>'refJson' end||'}';
  files:='{"entries":'||entries||',"manifestHash":'||(v->'files'->'manifestHash')::text||',"pathBase":"SELECTED_ROOT","validatedAt":'||(v->'files'->'validatedAt')::text||'}';
  body:='{"files":'||files||',"git":'||git||',"kind":"INPUT_SOURCE_OBSERVATION","version":1}';
  if source_history_private.digest(body)<>v->>'observationHash'
    or octet_length(left(body,
    length(body)-1)||',"observationHash":'||(v->'observationHash')::text||'}')>131072 then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  end;
$$;
create function source_history_private.excerpt(v jsonb,
  peer boolean,

  expected integer) returns void language plpgsql immutable set search_path='' as
$$
declare
  k text[]:=array['excerptIndex','pathJson','hash','readAt','byteStart','byteEnd','excerptHash'];
begin
  if peer then
    k:=k||array['lineCount','requestedStartLine','requestedEndLine'];
  end if;
  if coalesce(not source_history_private.keys(v,
    k)
    or v->'excerptIndex'<>to_jsonb(expected)
    or not source_history_private.uint(v->'excerptIndex',
    15)
  or jsonb_typeof(v->'pathJson')<>'string'
    or not source_history_private.hash(v->'hash')
    or not source_history_private.hash(v->'excerptHash')
    or not source_history_private.time(v->'readAt')
  or not source_history_private.uint(v->'byteStart',
    2097152)
    or not source_history_private.uint(v->'byteEnd',
    2097152)
    or (v->>'byteEnd')::bigint<(v->>'byteStart')::bigint,
    true) then perform source_history_private.fail('INVALID_BODY');
  end if;
  perform source_history_private.repository_path(v->>'pathJson');
  if peer
    and coalesce(not source_history_private.uint(v->'lineCount',
    2097153)
    or (v->>'lineCount')::bigint<1
    or not source_history_private.uint(v->'requestedStartLine',
    2097153)
    or (v->>'requestedStartLine')::bigint<1
    or not source_history_private.uint(v->'requestedEndLine',
    2097153)
    or (v->>'requestedEndLine')::bigint<(v->>'requestedStartLine')::bigint
    or (v->>'requestedEndLine')::bigint>(v->>'lineCount')::bigint,
    true) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  end;
$$;
create function source_history_private.confirm_whole(a uuid,

  raw bytea) returns void language plpgsql security definer set search_path='' as
$$
declare
  m source_history_private.manifests;
  t text;
  v jsonb;
  c jsonb;
  f jsonb;
  peer boolean;
  previous integer:=-1;
  callindex integer;
  excerptindex integer;
  idx integer:=0;
  repo integer:=0;
  peers integer:=0;
  lists integer:=0;
  summary_value jsonb;
  file_row jsonb;
  input jsonb;
begin
  select * into m from source_history_private.manifests where attempt_id=a for update;
  if m.confirmed then
    return;
  end if;
  if octet_length(raw)<>m.total_bytes or encode(extensions.digest(raw,'sha256'),'hex')<>m.manifest_hash then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  -- Decode only after joining all raw chunks: a UTF8 code point may straddle any packet boundary.
begin
  t:=convert_from(raw,'UTF8');
  v:=t::jsonb;
  exception when others then perform source_history_private.fail('INVALID_BODY');
  end;
  if coalesce(not source_history_private.keys(v,
    array['version',
    'kind',
    'readMode',
    'input',
    'calls'])
    or v->'version'<>'2'::jsonb
    or v->>'kind'<>'RUN_SOURCE_MANIFEST'
    or v->>'readMode' not in ('SELECTED',
    'AUTO_CODE')
    or jsonb_typeof(v->'calls')<>'array'
    or jsonb_array_length(v->'calls')>256,
    true) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  perform source_history_private.input(v->'input');
  if (v->>'readMode'='SELECTED'
    and jsonb_array_length(v->'calls')<>0)
    or (v->>'readMode'='AUTO_CODE'
    and jsonb_array_length(v->'input'->'files'->'entries')<>0) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  input:=v->'input';
  for f in select value from jsonb_array_elements(input->'files'->'entries') loop
    file_row:=jsonb_build_object('index',
      idx,
      'phase',
      'INPUT',
      'callIndex',
      null,
      'excerptIndex',
      idx,
      'tool',
      null,
      'resultHash',
      null,
      'questionOperationId',
      null,
      'pathJson',
      f->'pathJson',
      'hash',
      f->'hash',
      'readAt',
      null,
      'byteStart',
      null,
      'byteEnd',
      null,
      'excerptHash',
      null,
      'lineCount',
      null,
      'requestedStartLine',
      null,
      'requestedEndLine',
      null);
    insert into source_history_private.files values(a,idx,file_row);
    idx:=idx+1;
  end loop;
  for c in select value from jsonb_array_elements(v->'calls') loop
    peer:=c->>'kind'='PEER_EVIDENCE_OBSERVATION';
    if coalesce(not source_history_private.uint(c->'callIndex',
      255)
      or (c->>'callIndex')::integer<=previous
      or jsonb_typeof(c->'files')<>'array',
      true) then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    callindex:=(c->>'callIndex')::integer;
    previous:=callindex;
    if peer then
      if coalesce(not source_history_private.keys(c,
        array['callIndex',
        'kind',
        'purpose',
        'questionOperationId',
        'files'])
        or c->>'purpose'<>'VERIFIED_FOR_PEER_QUESTION'
        or not source_history_private.id(c->'questionOperationId')
        or jsonb_array_length(c->'files') not between 1
        and 4,
        true) then
        perform source_history_private.fail('INVALID_BODY');
      end if;
      peers:=peers+1;
    else
      if coalesce(not source_history_private.keys(c,
        array['callIndex',
        'kind',
        'tool',
        'resultHash',
        'files'])
        or c->>'kind'<>'REPOSITORY_TOOL_OBSERVATION'
        or c->>'tool' not in ('list_workspace_files',
        'read_workspace_file',
        'search_workspace')
        or not source_history_private.hash(c->'resultHash')
        or jsonb_array_length(c->'files')>case c->>'tool'
        when 'list_workspace_files' then 0
        when 'read_workspace_file' then 1 else 16 end,
        true) then
        perform source_history_private.fail('INVALID_BODY');
      end if;
      repo:=repo+1;
      if c->>'tool'='list_workspace_files' then
        lists:=lists+1;
      end if;
    end if;
    excerptindex:=0;
    for f in select value from jsonb_array_elements(c->'files') loop
      perform source_history_private.excerpt(f,peer,excerptindex);
      if idx>=4096 then
        perform source_history_private.fail('INVALID_BODY');
      end if;
      file_row:=jsonb_build_object('index',
        idx,
        'phase',
        case
        when peer then 'PEER' else 'REPOSITORY' end,
        'callIndex',
        callindex,
        'excerptIndex',
        excerptindex,
        'tool',
        case
        when peer then null else c->'tool' end,
        'resultHash',
        case
        when peer then null else c->'resultHash' end,
        'questionOperationId',
        case
        when peer then c->'questionOperationId' else null end,

      'pathJson',
        f->'pathJson',
        'hash',
        f->'hash',
        'readAt',
        f->'readAt',
        'byteStart',
        f->'byteStart',
        'byteEnd',
        f->'byteEnd',
        'excerptHash',
        f->'excerptHash',
        'lineCount',
        case
        when peer then f->'lineCount' else null end,
        'requestedStartLine',
        case
        when peer then f->'requestedStartLine' else null end,
        'requestedEndLine',
        case
        when peer then f->'requestedEndLine' else null end);
      insert into source_history_private.files values(a,idx,file_row);
      idx:=idx+1;
      excerptindex:=excerptindex+1;
    end loop;
  end loop;
  if source_history_private.canonical(v)<>t then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  -- questionOperationId is an opaque, scoped report, not a receipt or a same-fence delivery proof.
  summary_value:=jsonb_build_object('readMode',
    v->'readMode',
    'input',
    input||jsonb_build_object('files',
    (input->'files'-'entries')||jsonb_build_object('entryCount',
    jsonb_array_length(input->'files'->'entries'))),
    'callCount',
    repo+peers,
    'repositoryCallCount',
    repo,
    'peerCallCount',
    peers,
    'listCallCount',
    lists,
    'fileCount',
    idx);
  update source_history_private.manifests set confirmed=true,summary=summary_value where attempt_id=a;
  end;
$$;

create function source_history_private.snapshot_target() returns trigger language plpgsql security definer set search_path='' as
$$
declare
  ag device_binding_private.agents;
  repository_alias_value text;
begin
  select * into ag from device_binding_private.agents where id=new.agent_id
    and binding_epoch=new.binding_epoch
    and device_id=new.device_id
    and room_id=new.room_id;
  select repository_alias into repository_alias_value from device_binding_private.workspaces where id=ag.workspace_id;
  if ag.id is null or repository_alias_value is null then
    perform source_history_private.fail('CONFLICT');
  end if;
  insert into source_history_private.targets values(new.id,
    new.room_id,
    jsonb_build_object('requestId',
    new.id,
    'agentId',
    new.agent_id,
    'bindingEpoch',
    new.binding_epoch,
    'ownerAlias',
    new.owner_alias,
    'sessionAlias',
    new.session_alias,
    'repositoryAlias',
    repository_alias_value,
    'runtime',
    ag.runtime,
    'reservedAt',
    new.created_at));
  return new;
  end;
$$;

create trigger source_request_snapshot after insert on workflow_private.requests for each row execute function source_history_private.snapshot_target();

create function source_history_private.snapshot_event() returns trigger language plpgsql security definer set search_path='' as
$$
declare
  rid uuid;
  aid uuid;
  target jsonb;
begin
  if new.kind='QUESTION' then
    select id into rid from workflow_private.requests where room_id=new.room_id
      and question_id=new.question_id
      and kind='PEER';
  elsif new.kind in ('ANSWER',
    'SPEECH')
    and new.sender_kind='AGENT'
    or new.kind='RUN_STATE'
    and new.terminal is not null then
    rid:=new.request_id;
    -- The transaction's exact terminal request fence; never a latest attempt fallback.
    select m.attempt_id into aid from source_history_private.manifests m join workflow_private.requests r on r.id=m.request_id join workflow_private.attempts a on a.id=m.attempt_id
    where r.id=rid
      and r.room_id=new.room_id
      and m.fence=r.fence
      and m.confirmed
      and a.state in ('COMPLETED',
      'FAILED',
      'INTERRUPTED')
      and a.start_intent_at is not null;
  else
    return new;
  end if;
  select t.target into target from source_history_private.targets t where t.request_id=rid and t.room_id=new.room_id;
  if target is not null then
    insert into source_history_private.events values(new.event_id,rid,aid,target);
  end if;
  return new;
  end;
$$;

create trigger source_event_snapshot after insert on public.workflow_events for each row execute function source_history_private.snapshot_event();
create function source_history_private.validate(action text,

  b jsonb) returns void language plpgsql immutable set search_path='' as
$$
declare
  k text[];
  field text;
begin
  k:=case action
    when 'source-support' then array['protocol',
    'agentId',
    'bindingEpoch']
    when 'source-confirm' then array['protocol',
    'agentId',
    'bindingEpoch',
    'requestId',
    'attemptId',
    'fence',
    'manifestHash']
    when 'source-upload' then array['protocol',
    'agentId',
    'bindingEpoch',
    'requestId',
    'attemptId',
    'fence',
    'operationId',
    'packetJson']
    when 'source-read' then array['protocol',
    'roomId',
    'eventId',
    'afterIndex'] end;
  if coalesce(k is null or not source_history_private.keys(b,k) or b->'protocol'<>'1'::jsonb,true) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  if octet_length(b::text)>16384 then
    perform source_history_private.fail('BODY_TOO_LARGE');
  end if;
  foreach field in array k loop
    if field in ('agentId',
      'requestId',
      'attemptId',
      'operationId',
      'roomId',
      'eventId')
      and not source_history_private.id(b->field) then
      perform source_history_private.fail('INVALID_BODY');
    end if;
    if field in ('bindingEpoch','fence') and (not source_history_private.uint(b->field) or (b->>field)::numeric<1) then
      perform source_history_private.fail('INVALID_BODY');
    end if;
  end loop;
  if action='source-confirm' and not source_history_private.hash(b->'manifestHash') then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  if action='source-upload'
    and coalesce(jsonb_typeof(b->'packetJson')<>'string'
    or octet_length(b->>'packetJson')>15020,
    true) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  if action='source-read'
    and b->'afterIndex'<>'null'::jsonb
    and not source_history_private.uint(b->'afterIndex',
    4095) then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  exception
    when invalid_text_representation
    or numeric_value_out_of_range then perform source_history_private.fail('INVALID_BODY');
  end;
$$;

create function source_history_private.packet(t text) returns jsonb language plpgsql immutable set search_path='' as
$$
declare
  p jsonb;
  raw bytea;
  expected integer;
begin
begin
  p:=t::jsonb;
  exception when others then perform source_history_private.fail('INVALID_BODY');
  end;
  if coalesce(not source_history_private.keys(p,
    array['version',
    'index',
    'count',
    'totalBytes',
    'manifestHash',
    'chunkHash',
    'bytesBase64'])
    or p->'version'<>'2'::jsonb
    or not source_history_private.uint(p->'index',
    511)
    or not source_history_private.uint(p->'count',
    512)
    or (p->>'count')::integer<1
    or (p->>'index')::integer>=(p->>'count')::integer
  or not source_history_private.uint(p->'totalBytes',
    4194304)
    or (p->>'totalBytes')::integer<1
    or ((p->>'totalBytes')::integer+8191)/8192<>(p->>'count')::integer
    or not source_history_private.hash(p->'manifestHash')
    or not source_history_private.hash(p->'chunkHash')
  or jsonb_typeof(p->'bytesBase64')<>'string'
    or char_length(p->>'bytesBase64')>10924
    or p->>'bytesBase64' !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    true) then perform source_history_private.fail('INVALID_BODY');
  end if;
  raw:=decode(p->>'bytesBase64','base64');
  if replace(encode(raw,
    'base64'),
    chr(10),
    '')<>p->>'bytesBase64'
    or encode(extensions.digest(raw,
    'sha256'),
    'hex')<>p->>'chunkHash' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  expected:=case
    when (p->>'index')::integer=(p->>'count')::integer-1 then (p->>'totalBytes')::integer-8192*((p->>'count')::integer-1) else 8192 end;
  if octet_length(raw)<>expected then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  -- Fixed packet key order is JSON.stringify's insertion order, with no whitespace or duplicate keys.
  if t<>'{"version":2,"index":'||(p->'index')::text||',"count":'||(p->'count')::text||',"totalBytes":'||(p->'totalBytes')::text||',"manifestHash":'||(p->'manifestHash')::text||',"chunkHash":'||(p->'chunkHash')::text||',"bytesBase64":'||(p->'bytesBase64')::text||'}' then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  return p;
  exception
    when invalid_text_representation
    or numeric_value_out_of_range then perform source_history_private.fail('INVALID_BODY');
  end;
$$;
create function source_history_private.device(action text,
  b jsonb,

  secret text) returns jsonb language plpgsql security definer set search_path='' as
$$
declare
  d device_binding_private.devices;
  ag device_binding_private.agents;
  rq workflow_private.requests;
  at workflow_private.attempts;
  m source_history_private.manifests;
  old source_history_private.packets;
  p jsonb;
  identity jsonb;
  ack jsonb;
  next integer;
  raw bytea;
begin
  perform source_history_private.validate(action,b);
  -- Existing credential -> scope -> room -> workflow row lock order and auth error priority.
  d:=runtime_settings_private.live_device(secret);
  select * into ag from device_binding_private.agents where id=(b->>'agentId')::uuid
    and device_id=d.id
    and room_id=d.room_id;
  if ag.id is null
    or ag.binding_epoch<>(b->>'bindingEpoch')::bigint
    or not workflow_private.binding_live(ag.id,
    ag.binding_epoch,
    d.room_id) then
    perform source_history_private.fail('FORBIDDEN');
  end if;
  if action='source-support' then
    return jsonb_build_object('version',2,'agentId',ag.id,'bindingEpoch',ag.binding_epoch);
  end if;
  select * into rq from workflow_private.requests where id=(b->>'requestId')::uuid
    and device_id=d.id
    and agent_id=ag.id
    and binding_epoch=ag.binding_epoch
    and room_id=d.room_id;
  if rq.id is null then
    perform source_history_private.fail('FORBIDDEN');
  end if;
  select * into at from workflow_private.attempts where id=(b->>'attemptId')::uuid
    and request_id=rq.id
    and fence=(b->>'fence')::bigint
    and fence=rq.fence;
  if at.id is null then
    perform source_history_private.fail('CONFLICT');
  end if;
  identity:=jsonb_build_object('version',
    2,
    'agentId',
    ag.id,
    'bindingEpoch',
    ag.binding_epoch,
    'requestId',
    rq.id,
    'attemptId',
    at.id,
    'fence',
    at.fence);
  select * into m from source_history_private.manifests where attempt_id=at.id for update;
  if action='source-confirm' then
    if not exists(select 1 from source_history_private.targets where request_id=rq.id) then
      return identity||jsonb_build_object('manifestHash',
        b->'manifestHash',
        'state',
        'NO_TARGET_SNAPSHOT',
        'count',
        null,
        'totalBytes',
        null,
        'nextMissingIndex',
        0);
    end if;
    if m.attempt_id is null then
      return identity||jsonb_build_object('manifestHash',
        b->'manifestHash',
        'state',
        'ABSENT',
        'count',
        null,
        'totalBytes',
        null,
        'nextMissingIndex',
        0);
    end if;
    if m.manifest_hash<>b->>'manifestHash' then
      perform source_history_private.fail('CONFLICT');
    end if;
    select coalesce(min(i),
      m.count) into next from generate_series(0,
      m.count-1) as s(i) where not exists(select 1 from source_history_private.packets p where p.attempt_id=at.id
      and p.index=i);
    if not m.confirmed and next=m.count then
      perform source_history_private.fail('UNAVAILABLE');
    end if;
    return identity||jsonb_build_object('manifestHash',
      m.manifest_hash,
      'state',
      case
      when m.confirmed then 'CONFIRMED' else 'PARTIAL' end,
      'count',
      m.count,
      'totalBytes',
      m.total_bytes,
      'nextMissingIndex',
      next);
  end if;
  -- New bytes are allowed only before exact-attempt terminal publication; retries remain immutable.
  p:=source_history_private.packet(b->>'packetJson');
  if m.attempt_id is not null
    and (m.manifest_hash<>p->>'manifestHash'
    or m.count<>(p->>'count')::integer
    or m.total_bytes<>(p->>'totalBytes')::integer) then
    perform source_history_private.fail('CONFLICT');
  end if;
  select * into old from source_history_private.packets where room_id=d.room_id
    and device_id=d.id
    and operation_id=(b->>'operationId')::uuid;
  if old.operation_id is not null then
    if old.attempt_id<>at.id or old.index<>(p->>'index')::integer or old.packet_json<>b->>'packetJson' then
      perform source_history_private.fail('CONFLICT');
    end if;
    return old.ack;
  end if;
  select * into old from source_history_private.packets where attempt_id=at.id and index=(p->>'index')::integer;
  if old.operation_id is not null then
    if old.operation_id<>(b->>'operationId')::uuid or old.packet_json<>b->>'packetJson' then
      perform source_history_private.fail('CONFLICT');
    end if;
    return old.ack;
  end if;
  if at.start_intent_at is null
    or at.state not in ('EXECUTING',
    'UNKNOWN')
    or at.state='EXECUTING'
    and at.lease_expires_at<=clock_timestamp()
    or not exists(select 1 from source_history_private.targets where request_id=rq.id) then
    perform source_history_private.fail('CONFLICT');
  end if;
  if m.confirmed then
    perform source_history_private.fail('CONFLICT');
  end if;
  if m.attempt_id is null then
    insert into source_history_private.manifests(attempt_id,
      request_id,
      room_id,
      agent_id,
      binding_epoch,
      fence,
      manifest_hash,
      count,
      total_bytes) values(at.id,
      rq.id,
      d.room_id,
      ag.id,
      ag.binding_epoch,
      at.fence,
      p->>'manifestHash',
      (p->>'count')::integer,
      (p->>'totalBytes')::integer) returning * into m;
  end if;
  ack:=identity||jsonb_build_object('manifestHash',
    m.manifest_hash,
    'operationId',
    b->'operationId',
    'index',
    p->'index',
    'chunkHash',
    p->'chunkHash');
  insert into source_history_private.packets values(at.id,
    (p->>'index')::integer,
    d.room_id,
    d.id,
    (b->>'operationId')::uuid,
    b->>'packetJson',
    decode(p->>'bytesBase64',
    'base64'),
    ack);
  if (select count(*) from source_history_private.packets where attempt_id=at.id)=m.count then
    select string_agg(chunk,
      ''::bytea order by index) into raw from source_history_private.packets where attempt_id=at.id;
    perform source_history_private.confirm_whole(at.id,raw);
  end if;
  return ack;
  end;
$$;

create function source_history_private.read(b jsonb) returns jsonb language plpgsql security definer set search_path='' as
$$
declare
  u uuid;
  r uuid;
  org uuid;
  e public.workflow_events;
  link source_history_private.events;
  m source_history_private.manifests;
  result jsonb;
  rows jsonb:='[]'::jsonb;
  candidate jsonb;
  f source_history_private.files;
  afterindex integer;
  nextindex integer;
begin
  perform device_binding_private.guard();
  perform source_history_private.validate('source-read',b);
  u:=room_access_private.actor();
  r:=(b->>'roomId')::uuid;
  select organization_id into org from public.rooms where id=r;
  if org is null then
    perform source_history_private.fail('NOT_FOUND');
  end if;
  perform device_binding_private.lock_scope(org,r);
  u:=room_access_private.actor();
  if not device_binding_private.live(u,org,r,false) then
    perform source_history_private.fail('FORBIDDEN');
  end if;
  select * into e from public.workflow_events where event_id=(b->>'eventId')::uuid and room_id=r;
  if e.event_id is null then
    perform source_history_private.fail('NOT_FOUND');
  end if;
  select * into link from source_history_private.events where event_id=e.event_id;
  result:=jsonb_build_object('version',
    2,
    'roomId',
    r,
    'eventId',
    e.event_id,
    'state',
    'NO_TARGET_SNAPSHOT',
    'target',
    null,
    'manifestHash',
    null,
    'summary',
    null,
    'files',
    rows,
    'nextIndex',
    null);
  if link.event_id is null then
    return result;
  end if;
  result:=result||jsonb_build_object('state','NO_SOURCE','target',link.target);
  select * into m from source_history_private.manifests where attempt_id=link.attempt_id and confirmed;
  if m.attempt_id is null then
    return result;
  end if;
  result:=result||jsonb_build_object('state','CONFIRMED','manifestHash',m.manifest_hash,'summary',m.summary);
  afterindex:=coalesce((b->>'afterIndex')::integer,-1);
  if afterindex>= (m.summary->>'fileCount')::integer then
    perform source_history_private.fail('INVALID_BODY');
  end if;
  for f in select * from source_history_private.files where attempt_id=m.attempt_id
    and index>afterindex order by index limit 4 loop
    nextindex:=case when f.index<(m.summary->>'fileCount')::integer-1 then f.index end;
    candidate:=result||jsonb_build_object('files',rows||jsonb_build_array(f.row_json),'nextIndex',nextindex);
    if octet_length(jsonb_build_object('ok',true,'data',candidate)::text)>16384 then
      exit;
    end if;
    rows:=rows||jsonb_build_array(f.row_json);
    result:=candidate;
  end loop;
  if afterindex<(m.summary->>'fileCount')::integer-1 and jsonb_array_length(rows)=0 then
    perform source_history_private.fail('UNAVAILABLE');
  end if;
  if octet_length(jsonb_build_object('ok',true,'data',result)::text)>16384 then
    perform source_history_private.fail('UNAVAILABLE');
  end if;
  return result;
  end;
$$;
create function public.workflow_device_source_support(p_body jsonb,

  p_secret text) returns jsonb language sql security definer set search_path='' as
$$
select source_history_private.device('source-support',p_body,p_secret);
$$;
create function public.workflow_device_source_upload(p_body jsonb,

  p_secret text) returns jsonb language sql security definer set search_path='' as
$$
select source_history_private.device('source-upload',p_body,p_secret);
$$;
create function public.workflow_device_source_confirm(p_body jsonb,

  p_secret text) returns jsonb language sql security definer set search_path='' as
$$
select source_history_private.device('source-confirm',p_body,p_secret);
$$;

create function public.workflow_human_source_read(p_body jsonb) returns jsonb language sql security definer set search_path='' as
$$
select source_history_private.read(p_body);
$$;
revoke all on function public.workflow_device_source_support(jsonb,
  text),
  public.workflow_device_source_upload(jsonb,
  text),
  public.workflow_device_source_confirm(jsonb,
  text),
  public.workflow_human_source_read(jsonb) from public,
  anon,
  authenticated,
  service_role;
grant execute on function public.workflow_device_source_support(jsonb,
  text),
  public.workflow_device_source_upload(jsonb,
  text),
  public.workflow_device_source_confirm(jsonb,
  text) to anon;
grant execute on function public.workflow_human_source_read(jsonb) to authenticated;
revoke all on all tables in schema source_history_private from public,anon,authenticated,service_role;
revoke all on all functions in schema source_history_private from public,anon,authenticated,service_role;
commit;
