begin;

-- The actor is an optional precondition, never an authentication credential.
-- CREATE OR REPLACE preserves the authenticated-only grants of the existing RPC.
create or replace function public.workflow_human_speak(p_body jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  keys text[] := array['protocol','roomId','operationId','publicText'];
  current_actor uuid;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  if octet_length(p_body::text) > 16384 then
    raise exception using message = 'BODY_TOO_LARGE', errcode = 'P0001';
  end if;
  if p_body ? 'expectedUserId' then
    keys := keys || array['expectedUserId'];
  end if;
  if not p_body ?& keys
    or (select count(*) from jsonb_object_keys(p_body)) <> cardinality(keys) then
    raise exception using message = 'INVALID_BODY', errcode = 'P0001';
  end if;
  if p_body ? 'expectedUserId' then
    if jsonb_typeof(p_body->'expectedUserId') is distinct from 'string'
      or p_body->>'expectedUserId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using message = 'INVALID_BODY', errcode = 'P0001';
    end if;
    current_actor := auth.uid();
    if current_actor is null then
      raise exception using message = 'UNAUTHENTICATED', errcode = 'P0001';
    end if;
    if (p_body->>'expectedUserId')::uuid <> current_actor then
      raise exception using message = 'FORBIDDEN', errcode = 'P0001';
    end if;
  end if;
  -- Preserve the existing permissions, transaction and legacy receipt body hash.
  return workflow_private.human('speak', p_body - 'expectedUserId');
end;
$$;

commit;
