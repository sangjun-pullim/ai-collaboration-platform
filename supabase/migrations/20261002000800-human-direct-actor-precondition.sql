begin;

-- The expected actor is a freshness precondition, never delegated authority.
-- Strip it only after validating the original body and current authenticated actor.
create function workflow_private.human_actor(action text, b jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  expected uuid;
  current_actor uuid;
  keys text[];
begin
  if action is null or action not in ('ask', 'cancel') or b is null or jsonb_typeof(b) <> 'object' then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  if octet_length(b::text) > 16384 then
    raise exception using message = 'BODY_TOO_LARGE', errcode = 'P0001';
  end if;
  keys := case when action = 'ask' then
    array['protocol','roomId','operationId','expectedUserId','targetAgentId','targetEpoch',
      'expectedRoomRevision','publicText','confirmed']
    else array['protocol','roomId','operationId','expectedUserId','requestId','expectedRoomRevision'] end;
  if not b ?& keys or (select count(*) from jsonb_object_keys(b)) <> cardinality(keys)
    or jsonb_typeof(b->'expectedUserId') is distinct from 'string'
    or b->>'expectedUserId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  expected := (b->>'expectedUserId')::uuid;
  current_actor := auth.uid();
  if current_actor is null then
    raise exception using message = 'UNAUTHENTICATED', errcode = 'P0001';
  end if;
  if expected <> current_actor then
    raise exception using message = 'FORBIDDEN', errcode = 'P0001';
  end if;
  -- SQL007 retains validation, trim, guard/scope/room locks and original receipt hashes.
  return workflow_private.human(action, b - 'expectedUserId');
end;
$$;
revoke all on function workflow_private.human_actor(text,jsonb) from public, anon, authenticated;

-- CREATE OR REPLACE retains the existing authenticated-only wrapper grants.
create or replace function public.workflow_human_ask(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human_actor('ask', p_body);
$$;
create or replace function public.workflow_human_cancel(p_body jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select workflow_private.human_actor('cancel', p_body);
$$;

-- This full B-tree covers both AI and HUMAN questions, unlike partial indexes.
create index workflow_questions_cycle on workflow_private.questions using btree(cycle_id);

commit;
