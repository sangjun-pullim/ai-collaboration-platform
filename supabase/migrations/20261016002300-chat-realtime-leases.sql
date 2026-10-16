begin;
create schema chat_realtime_private;
revoke all on schema chat_realtime_private from public, anon, authenticated;
create table chat_realtime_private.leases (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 session_id uuid not null,
 room_id uuid not null references public.rooms(id) on delete cascade,
 client_id uuid not null,
 topic text not null unique default 'chat-lease:' || encode(extensions.gen_random_bytes(32),'hex'),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 unique(user_id,session_id,client_id)
);
alter table chat_realtime_private.leases enable row level security;
revoke all on chat_realtime_private.leases from public, anon, authenticated;
create index on chat_realtime_private.leases(room_id,expires_at) where revoked_at is null;

create function chat_realtime_private.live(u uuid,s uuid,r uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.sessions a join public.rooms b on b.id=r
 join public.organizations o on o.id=b.organization_id
 where a.id=s and a.user_id=u and (a.not_after is null or a.not_after>clock_timestamp())
 and device_binding_private.live(u,b.organization_id,b.id,false));
$$;
create function chat_realtime_private.allowed(t text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from chat_realtime_private.leases l where l.topic=t
 and l.user_id=auth.uid() and l.session_id=(auth.jwt()->>'session_id')::uuid
 and l.revoked_at is null and l.expires_at>clock_timestamp()
 and chat_realtime_private.live(l.user_id,l.session_id,l.room_id));
$$;
grant usage on schema chat_realtime_private to authenticated;
grant execute on function chat_realtime_private.allowed(text) to authenticated;

-- Restrictive companions protect this namespace even when unrelated policies coexist.
create policy chat_lease_receive on realtime.messages for select to authenticated
 using (extension='broadcast' and chat_realtime_private.allowed(realtime.topic()));
create policy chat_lease_receive_boundary on realtime.messages as restrictive for select to authenticated
 using (realtime.topic() not like 'chat-lease:%' or (extension='broadcast' and chat_realtime_private.allowed(realtime.topic())));
create policy chat_lease_no_send on realtime.messages as restrictive for insert to authenticated
 with check (realtime.topic() not like 'chat-lease:%');
create policy chat_lease_no_anon_receive on realtime.messages as restrictive for select to anon
 using (realtime.topic() not like 'chat-lease:%');
create policy chat_lease_no_anon_send on realtime.messages as restrictive for insert to anon
 with check (realtime.topic() not like 'chat-lease:%');

create function chat_realtime_private.body(b jsonb,release boolean) returns void
language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(b)<>'object' or b->'protocol'<>'1'::jsonb
 or not (b ?& array['protocol','roomId','expectedUserId','clientId'])
 or exists(select 1 from jsonb_object_keys(b) k where k not in ('protocol','roomId','expectedUserId','clientId','leaseId'))
 or (release and not b ? 'leaseId') then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 if exists(select 1 from jsonb_each(b) e where e.key<>'protocol' and (jsonb_typeof(e.value)<>'string' or e.value#>>'{}' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
end; $$;
create function public.chat_realtime_authorize(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); s uuid:=(auth.jwt()->>'session_id')::uuid; r uuid; c uuid; l chat_realtime_private.leases; expiry timestamptz;
begin
 perform chat_realtime_private.body(p_body,false);
 r:=(p_body->>'roomId')::uuid; c:=(p_body->>'clientId')::uuid;
 if u is null or s is null then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 if u<>(p_body->>'expectedUserId')::uuid or not chat_realtime_private.live(u,s,r) then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text,2300));
 expiry:=least(clock_timestamp()+interval '5 minutes',to_timestamp((auth.jwt()->>'exp')::double precision),(select not_after from auth.sessions where id=s));
 if expiry is null or expiry<=clock_timestamp() then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 if p_body ? 'leaseId' then
  select * into l from chat_realtime_private.leases where id=(p_body->>'leaseId')::uuid and user_id=u and session_id=s and room_id=r and client_id=c and revoked_at is null and expires_at>clock_timestamp() for update;
  if not found then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 else
  delete from chat_realtime_private.leases where user_id=u and (expires_at<=clock_timestamp() or revoked_at is not null);
  select * into l from chat_realtime_private.leases where user_id=u and session_id=s and client_id=c and room_id=r and revoked_at is null and expires_at>clock_timestamp() for update;
  if not found then
   if (select count(*) from chat_realtime_private.leases where user_id=u and session_id=s and room_id=r and revoked_at is null and expires_at>clock_timestamp())>=4 then raise exception using message='QUOTA',errcode='P0001'; end if;
   -- One live room per tab; separate tabs retain separate leases.
   delete from chat_realtime_private.leases where user_id=u and session_id=s and client_id=c;
   insert into chat_realtime_private.leases(user_id,session_id,room_id,client_id,expires_at) values(u,s,r,c,expiry) returning * into l;
  end if;
 end if;
 update chat_realtime_private.leases set expires_at=expiry where id=l.id returning * into l;
 return jsonb_build_object('protocol',1,'roomId',r,'userId',u,'clientId',c,'leaseId',l.id,'topic',l.topic,'expiresAt',l.expires_at);
end; $$;
create function public.chat_realtime_release(p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform chat_realtime_private.body(p_body,true);
 if auth.uid() is null then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 update chat_realtime_private.leases set revoked_at=clock_timestamp()
 where id=(p_body->>'leaseId')::uuid and user_id=auth.uid() and user_id=(p_body->>'expectedUserId')::uuid
 and session_id=(auth.jwt()->>'session_id')::uuid and room_id=(p_body->>'roomId')::uuid and client_id=(p_body->>'clientId')::uuid;
 if not found then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 return jsonb_build_object('released',true);
end; $$;

create function chat_realtime_private.publish(r uuid) returns void
language plpgsql security definer set search_path='' as $$
declare l record; seen jsonb;
begin
 -- Transaction-local deduplication has no retained rows and resets at commit.
 seen:=coalesce(nullif(current_setting('chat_realtime.rooms',true),'')::jsonb,'{}'::jsonb);
 if seen ? r::text then return; end if;
 for l in select * from chat_realtime_private.leases where room_id=r and revoked_at is null and expires_at>clock_timestamp() loop
  if chat_realtime_private.live(l.user_id,l.session_id,l.room_id) then
   begin
    perform realtime.send('{"version":1}'::jsonb,'changed',l.topic,true);
   exception when others then
    raise log 'chat realtime hint delivery failed [%]',sqlstate;
   end;
  end if;
 end loop;
 perform set_config('chat_realtime.rooms',(seen||jsonb_build_object(r::text,true))::text,true);
exception when others then
 raise log 'chat realtime hint preparation failed [%]',sqlstate;
end; $$;
create function chat_realtime_private.changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then perform chat_realtime_private.publish(old.room_id); return old; end if;
 if tg_table_name='readiness' and tg_op='UPDATE' then
  if (new.reported_ready,new.binding_epoch,new.device_id) is not distinct from (old.reported_ready,old.binding_epoch,old.device_id) then return new; end if;
 end if;
 if tg_table_name='agents' and tg_op='UPDATE' then
  if (new.state,new.binding_epoch,new.device_id,new.workspace_id) is not distinct from (old.state,old.binding_epoch,old.device_id,old.workspace_id) then return new; end if;
 end if;
 perform chat_realtime_private.publish(new.room_id); return new;
exception when others then
 raise log 'chat realtime hint trigger failed [%]',sqlstate;
 return coalesce(new,old);
end; $$;
create trigger chat_realtime_event after insert on public.workflow_events for each row execute function chat_realtime_private.changed();
create trigger chat_realtime_retirement after insert on workflow_private.direct_retirements for each row execute function chat_realtime_private.changed();
create trigger chat_realtime_readiness after insert or update or delete on workflow_private.readiness for each row execute function chat_realtime_private.changed();
create trigger chat_realtime_binding after insert or update or delete on device_binding_private.agents for each row execute function chat_realtime_private.changed();
revoke all on all functions in schema chat_realtime_private from public,anon,authenticated;
grant execute on function chat_realtime_private.allowed(text) to authenticated;
revoke all on function public.chat_realtime_authorize(jsonb),public.chat_realtime_release(jsonb) from public,anon;
grant execute on function public.chat_realtime_authorize(jsonb),public.chat_realtime_release(jsonb) to authenticated;
commit;
