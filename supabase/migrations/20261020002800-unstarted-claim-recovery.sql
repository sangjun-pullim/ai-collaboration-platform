-- A cancelled request with no attempt can prove that the original claim never started AI work.
-- This helper only records that proof; it must never acquire an execution lease.
create function own_input_private.cancelled_claim(b jsonb,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices; a device_binding_private.agents;
 q workflow_private.requests; prior workflow_private.receipts; ph text;
 marker jsonb:='{"claimDenied":"REQUEST_CANCELLED"}'::jsonb;
begin
 perform workflow_private.validate('claim',b);
 d:=runtime_settings_private.live_device(secret);
 select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id and owner_user_id=d.owner_user_id;
 if a.id is null or a.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(a.id,a.binding_epoch,d.room_id) then perform runtime_settings_private.fail('FORBIDDEN');end if;
 select * into q from workflow_private.requests where id=(b->>'requestId')::uuid and device_id=d.id and agent_id=a.id and binding_epoch=a.binding_epoch and room_id=d.room_id;
 if q.id is null then perform runtime_settings_private.fail('FORBIDDEN');end if;
 ph:=encode(extensions.digest(b::text,'sha256'),'hex');
 select * into prior from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=(b->>'operationId')::uuid;
 if found then
  if prior.action<>'claim' or prior.payload_hash<>ph then perform runtime_settings_private.fail('CONFLICT');end if;
  if prior.result=marker then return marker;end if;
  -- A successful claim or another durable denial keeps its original meaning.
  return null;
 end if;
 perform workflow_private.reconcile(d.room_id);
 select * into q from workflow_private.requests where id=q.id;
 if q.state<>'CANCELLED'
  or exists(select 1 from workflow_private.attempts where request_id=q.id)
  or exists(select 1 from workflow_private.receipts where action='claim' and result->>'requestId'=q.id::text and result ? 'attemptId')
 then return null;end if;
 insert into workflow_private.receipts values(d.room_id,'device',d.id,(b->>'operationId')::uuid,'claim',ph,marker);
 return marker;
end;$$;
revoke all on function own_input_private.cancelled_claim(jsonb,text) from public,anon,authenticated;

create or replace function workflow_private.restore(action text,result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if result ? 'claimDenied' then
  if action='claim' and result in ('{"claimDenied":"INPUT_PAUSED"}'::jsonb,'{"claimDenied":"REQUEST_CANCELLED"}'::jsonb) then return result;end if;
  perform runtime_settings_private.fail('UNAVAILABLE');
 end if;
 return workflow_private.restore_011_original(action,result);
end;$$;

create or replace function own_input_private.claim(b jsonb,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d device_binding_private.devices; a device_binding_private.agents;
 q workflow_private.requests; prev workflow_private.receipts; ph text; result jsonb;
 marker jsonb:='{"claimDenied":"INPUT_PAUSED"}'::jsonb;
begin
 result:=own_input_private.cancelled_claim(b,secret);
 if result is not null then return result;end if;
 perform workflow_private.validate('claim',b);
 d:=runtime_settings_private.live_device(secret);
 select * into a from device_binding_private.agents where id=(b->>'agentId')::uuid and device_id=d.id and room_id=d.room_id;
 if a.id is null or a.binding_epoch<>(b->>'bindingEpoch')::bigint or not workflow_private.binding_live(a.id,a.binding_epoch,d.room_id) then perform runtime_settings_private.fail('FORBIDDEN');end if;
 select * into q from workflow_private.requests where id=(b->>'requestId')::uuid and device_id=d.id and agent_id=a.id and binding_epoch=a.binding_epoch and room_id=d.room_id;
 if q.id is null then perform runtime_settings_private.fail('FORBIDDEN');end if;
 ph:=encode(extensions.digest(b::text,'sha256'),'hex');
 select * into prev from workflow_private.receipts where room_id=d.room_id and actor_kind='device' and actor_id=d.id and operation_id=(b->>'operationId')::uuid;
 if found then
  if prev.action<>'claim' or prev.payload_hash<>ph then perform runtime_settings_private.fail('CONFLICT');end if;
  if prev.result ? 'claimDenied' then return workflow_private.restore('claim',prev.result);end if;
  return workflow_private.device('claim',b,secret);
 end if;
 if exists(select 1 from own_input_private.states where agent_id=a.id and room_id=d.room_id and paused) then
  insert into workflow_private.receipts values(d.room_id,'device',d.id,(b->>'operationId')::uuid,'claim',ph,marker);
  return marker;
 end if;
 return workflow_private.device('claim',b,secret);
end;$$;

-- Inspect cancellation proof before image capability/retention checks, but keep those
-- checks unchanged for any path that might create or resume an actual attempt.
create or replace function chat_attachments_private.device(action text,b jsonb,secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a device_binding_private.agents;result jsonb;version integer;image jsonb;
begin
 if b ? 'imageInputVersion' and (action not in ('poll','claim') or b->'imageInputVersion' is distinct from '1'::jsonb) then perform chat_attachments_private.fail('INVALID_BODY');end if;
 perform workflow_private.validate(action,b-'imageInputVersion');
 a:=chat_attachments_private.device_agent(b,secret);
 version:=case when b->'imageInputVersion'='1'::jsonb then 1 else 0 end;
 if action='claim' then
  result:=own_input_private.cancelled_claim(b-'imageInputVersion',secret);
  if result is not null then return result;end if;
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
