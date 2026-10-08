-- Extract the files object before removing entries so PostgreSQL resolves the JSONB operator.
-- Preserve validation, transaction rollback, function identity and historical source rows.
create or replace function source_history_private.confirm_whole(a uuid,

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
    ((input->'files')-'entries')||jsonb_build_object('entryCount',
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
