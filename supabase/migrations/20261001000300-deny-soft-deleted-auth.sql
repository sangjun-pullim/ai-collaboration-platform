begin;

create or replace function room_access_private.in_organization(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.organization_members m
  join auth.users u on u.id=m.user_id
  where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active'
   and u.deleted_at is null
   and (u.banned_until is null or u.banned_until<=now())
 );
$$;

create or replace function room_access_private.in_room(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.room_members m
  join public.organization_members o on o.organization_id=m.organization_id and o.user_id=m.user_id
  join auth.users u on u.id=m.user_id
  where m.room_id=p_room_id and m.user_id=auth.uid() and m.status='active' and o.status='active'
   and u.deleted_at is null
   and (u.banned_until is null or u.banned_until<=now())
 );
$$;

create or replace function room_access_private.actor() returns uuid language plpgsql security definer set search_path = '' as $$
declare a uuid := auth.uid();
begin
 if a is null or not exists(select 1 from auth.users where id=a and deleted_at is null and (banned_until is null or banned_until <= now())) then raise exception using message='UNAUTHENTICATED', errcode='P0001'; end if;
 return a;
end; $$;

create or replace function public.access_join(p_code text,p_display_alias text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); i room_access_private.room_invites%rowtype; ov bigint; rv bigint; old_role text; org_role text;
begin
 if p_code is null or p_code !~ '^[a-f0-9]{64}$' or p_display_alias is null or char_length(p_display_alias) not between 1 and 80 then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 select * into i from room_access_private.room_invites where code_hash=encode(extensions.digest(p_code,'sha256'),'hex');
 if not found then raise exception using message='INVITE_UNAVAILABLE',errcode='P0001'; end if;
 select access_version into ov from public.organizations where id=i.organization_id for update;
 select access_version into rv from public.rooms where id=i.room_id and organization_id=i.organization_id for update;
 perform 1 from public.organization_members where organization_id=i.organization_id and user_id in (a,i.issuer_user_id) order by user_id for update;
 perform 1 from public.room_members where room_id=i.room_id and user_id in (a,i.issuer_user_id) order by user_id for update;
 select * into i from room_access_private.room_invites where id=i.id for update;
 if i.consumed_at is not null or i.expires_at <= clock_timestamp() or ov is distinct from i.organization_version or rv is distinct from i.room_version
 or not exists(select 1 from public.organization_members where organization_id=i.organization_id and user_id=i.issuer_user_id and status='active')
 or not exists(select 1 from public.room_members where room_id=i.room_id and organization_id=i.organization_id and user_id=i.issuer_user_id and status='active' and role='owner')
 or not exists(select 1 from auth.users where id=i.issuer_user_id and deleted_at is null and (banned_until is null or banned_until<=now()))
 then raise exception using message='INVITE_UNAVAILABLE',errcode='P0001'; end if;
 select role into old_role from public.room_members where room_id=i.room_id and user_id=a and status='active';
 if found then raise exception using message='ALREADY_MEMBER',errcode='P0001'; end if;
 select role into org_role from public.organization_members where organization_id=i.organization_id and user_id=a and status='active';
 insert into public.organization_members(organization_id,user_id,role,status,display_alias) values(i.organization_id,a,'member','active',p_display_alias)
 on conflict (organization_id,user_id) do update set status='active',role=case when organization_members.status='active' then organization_members.role else 'member' end,
 display_alias=case when organization_members.status='active' then organization_members.display_alias else excluded.display_alias end;
 insert into public.room_members(organization_id,room_id,user_id,role,status,display_alias) values(i.organization_id,i.room_id,a,i.role,'active',p_display_alias)
 on conflict (room_id,user_id) do update set role=excluded.role,status='active',display_alias=excluded.display_alias;
 update room_access_private.room_invites set consumed_at=clock_timestamp(),consumed_by=a where id=i.id;
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_user_id,target_role) values(i.organization_id,i.room_id,a,coalesce(org_role,'new-member'),'join',a,i.role);
 return jsonb_build_object('roomId',i.room_id);
end; $$;

commit;
