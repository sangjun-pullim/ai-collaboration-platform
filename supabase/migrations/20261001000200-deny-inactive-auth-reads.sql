begin;

create or replace function room_access_private.in_organization(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(
  select 1 from public.organization_members m
  join auth.users u on u.id=m.user_id
  where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active'
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
   and (u.banned_until is null or u.banned_until<=now())
 );
$$;

commit;
