-- Add bounded reverse history without changing the connector/read-recovery contract.
create function public.workflow_human_history_window(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare page jsonb; result jsonb; candidate jsonb; events jsonb:='[]'::jsonb;
 r uuid; upper_bound bigint; first_sequence bigint; item public.workflow_events;
begin
 if jsonb_typeof(p_body)<>'object' or
   (select count(*) from jsonb_object_keys(p_body))<>4 or
   not p_body ?& array['protocol','expectedUserId','roomId','beforeSequence'] or
   p_body->'protocol'<>'1'::jsonb or jsonb_typeof(p_body->'expectedUserId')<>'string' or
   jsonb_typeof(p_body->'roomId')<>'string' or
   (p_body->'beforeSequence'<>'null'::jsonb and
     (jsonb_typeof(p_body->'beforeSequence')<>'number' or
      (p_body->>'beforeSequence') !~ '^[1-9][0-9]*$' or
      (p_body->>'beforeSequence')::numeric>9007199254740991)) then
   raise exception using message='INVALID_BODY',errcode='P0001';
 end if;
 if auth.uid() is null then raise exception using message='UNAUTHENTICATED',errcode='P0001';end if;
 if (p_body->>'expectedUserId')::uuid<>auth.uid() then raise exception using message='FORBIDDEN',errcode='P0001';end if;
 r:=(p_body->>'roomId')::uuid;
 -- Reuse current authentication, membership, locking, reconcile and recovery projection.
 page:=public.workflow_human_read_recovery(jsonb_build_object('protocol',1,'roomId',r,
   'afterSequence',0,'afterRetirementSequence',0));
 upper_bound:=coalesce((p_body->>'beforeSequence')::bigint,(page->>'highWaterSequence')::bigint+1);
 if upper_bound>(page->>'highWaterSequence')::bigint+1 then raise exception using message='CONFLICT',errcode='P0001';end if;
 page:=page||jsonb_build_object('events','[]'::jsonb,'nextCursor',page->'highWaterSequence','hasMore',false);
 result:=jsonb_build_object('protocol',1,'roomId',r,'beforeSequence',p_body->'beforeSequence',
   'oldestSequence',null,'hasOlder',false,'events',events,'snapshot',page);
 for item in select * from public.workflow_events where room_id=r and sequence<upper_bound
   order by sequence desc limit 40
 loop
   candidate:=result||jsonb_build_object('events',jsonb_build_array(workflow_private.event_json(item))||events,
     'oldestSequence',item.sequence,'hasOlder',item.sequence>1);
   if octet_length(jsonb_build_object('ok',true,'data',candidate)::text)>262144 then exit;end if;
   result:=candidate;events:=result->'events';first_sequence:=item.sequence;
 end loop;
 if (upper_bound>1 and first_sequence is null) or
   octet_length(jsonb_build_object('ok',true,'data',result)::text)>262144 then
   raise exception using message='UNAVAILABLE',errcode='P0001';
 end if;
 return result;
exception when invalid_text_representation or numeric_value_out_of_range then
 raise exception using message='INVALID_BODY',errcode='P0001';
end;$$;
revoke all on function public.workflow_human_history_window(jsonb) from public,anon;
grant execute on function public.workflow_human_history_window(jsonb) to authenticated;
