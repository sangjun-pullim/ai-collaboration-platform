begin;
create schema if not exists room_access_private;
revoke all on schema room_access_private from public, anon, authenticated;
create extension if not exists pgcrypto with schema extensions;

create table public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 1 and 100),
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 access_version bigint not null default 1 check (access_version > 0), created_at timestamptz not null default now()
);
create table public.organization_members (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('owner','member')), status text not null default 'active' check (status in ('active','removed')),
 display_alias text not null check (char_length(display_alias) between 1 and 80), primary key (organization_id,user_id)
);
create table public.rooms (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 owner_user_id uuid not null references auth.users(id) on delete cascade,
 title text not null check (char_length(title) between 1 and 160), goal text not null check (char_length(goal) between 1 and 2000),
 observation text not null check (char_length(observation) between 1 and 2000), environment text not null check (char_length(environment) between 1 and 2000),
 access_version bigint not null default 1 check (access_version > 0), created_at timestamptz not null default now(), unique (organization_id,id)
);
create table public.room_members (
 organization_id uuid not null, room_id uuid not null, user_id uuid not null,
 role text not null check (role in ('owner','participant','observer')), status text not null default 'active' check (status in ('active','removed')),
 display_alias text not null check (char_length(display_alias) between 1 and 80), primary key (room_id,user_id),
 foreign key (organization_id,room_id) references public.rooms(organization_id,id) on delete cascade,
 foreign key (organization_id,user_id) references public.organization_members(organization_id,user_id) on delete cascade
);
create table room_access_private.room_invites (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, room_id uuid not null,
 issuer_user_id uuid not null, role text not null check (role in ('participant','observer')),
 code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'), organization_version bigint not null, room_version bigint not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default (now() + interval '24 hours'), consumed_at timestamptz,
 consumed_by uuid, check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
 foreign key (organization_id,room_id) references public.rooms(organization_id,id) on delete cascade,
 foreign key (organization_id,issuer_user_id) references public.organization_members(organization_id,user_id) on delete cascade
);
create table room_access_private.access_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 room_id uuid, actor_user_id uuid not null, actor_role text not null check (actor_role in ('owner','member','participant','observer','new-member')),
 action text not null check (action in ('bootstrap','room','invite','join','revoke-room-member','revoke-group-member')),
 target_user_id uuid, target_role text check (target_role in ('owner','member','participant','observer')),
 result text not null default 'success' check (result = 'success'), created_at timestamptz not null default now(),
 foreign key (organization_id,room_id) references public.rooms(organization_id,id) on delete cascade
);
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table room_access_private.room_invites enable row level security;
alter table room_access_private.access_audit enable row level security;
revoke all on public.organizations, public.organization_members, public.rooms, public.room_members from public, anon, authenticated;
grant select on public.organizations, public.organization_members, public.rooms, public.room_members to authenticated;
revoke all on all tables in schema room_access_private from public, anon, authenticated;

create function room_access_private.in_organization(p_organization_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active');
$$;
create function room_access_private.in_room(p_room_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.room_members m join public.organization_members o on o.organization_id=m.organization_id and o.user_id=m.user_id
 where m.room_id=p_room_id and m.user_id=auth.uid() and m.status='active' and o.status='active');
$$;
revoke all on function room_access_private.in_organization(uuid), room_access_private.in_room(uuid) from public, anon;
grant usage on schema room_access_private to authenticated;
grant execute on function room_access_private.in_organization(uuid), room_access_private.in_room(uuid) to authenticated;
create policy organization_read on public.organizations for select to authenticated using (room_access_private.in_organization(id));
create policy organization_member_read on public.organization_members for select to authenticated using (room_access_private.in_organization(organization_id));
create policy room_read on public.rooms for select to authenticated using (room_access_private.in_room(id));
create policy room_member_read on public.room_members for select to authenticated using (room_access_private.in_room(room_id));

create function room_access_private.actor() returns uuid language plpgsql security definer set search_path = '' as $$
declare a uuid := auth.uid();
begin
 if a is null or not exists(select 1 from auth.users where id=a and (banned_until is null or banned_until <= now())) then raise exception using message='UNAUTHENTICATED', errcode='P0001'; end if;
 return a;
end; $$;
create function room_access_private.owner(p_org uuid, p_room uuid, a uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
 if not exists(select 1 from public.organization_members where organization_id=p_org and user_id=a and status='active')
 or not exists(select 1 from public.room_members where room_id=p_room and organization_id=p_org and user_id=a and status='active' and role='owner')
 then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
end; $$;
revoke all on function room_access_private.actor(), room_access_private.owner(uuid,uuid,uuid) from public, anon, authenticated;

create function public.access_bootstrap(p_group_name text,p_title text,p_goal text,p_observation text,p_environment text,p_display_alias text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); o uuid; r uuid;
begin
 insert into public.organizations(name,owner_user_id) values(p_group_name,a) returning id into o;
 insert into public.organization_members(organization_id,user_id,role,display_alias) values(o,a,'owner',p_display_alias);
 insert into public.rooms(organization_id,owner_user_id,title,goal,observation,environment) values(o,a,p_title,p_goal,p_observation,p_environment) returning id into r;
 insert into public.room_members(organization_id,room_id,user_id,role,display_alias) values(o,r,a,'owner',p_display_alias);
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_user_id,target_role) values(o,r,a,'owner','bootstrap',a,'owner');
 return jsonb_build_object('organizationId',o,'roomId',r);
end; $$;
create function public.access_room(p_organization_id uuid,p_title text,p_goal text,p_observation text,p_environment text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); r uuid; alias text;
begin
 perform 1 from public.organizations where id=p_organization_id for update;
 select display_alias into alias from public.organization_members where organization_id=p_organization_id and user_id=a and role='owner' and status='active' for update;
 if not found then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 insert into public.rooms(organization_id,owner_user_id,title,goal,observation,environment) values(p_organization_id,a,p_title,p_goal,p_observation,p_environment) returning id into r;
 insert into public.room_members(organization_id,room_id,user_id,role,display_alias) values(p_organization_id,r,a,'owner',alias);
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_user_id,target_role) values(p_organization_id,r,a,'owner','room',a,'owner');
 return jsonb_build_object('roomId',r);
end; $$;
create function public.access_invite(p_room_id uuid,p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); o uuid; ov bigint; rv bigint; c text; e timestamptz;
begin
 if p_role is null or p_role not in ('participant','observer') then raise exception using message='INVALID_BODY',errcode='P0001'; end if;
 select organization_id into o from public.rooms where id=p_room_id;
 select access_version into ov from public.organizations where id=o for update;
 select access_version into rv from public.rooms where id=p_room_id and organization_id=o for update;
 perform 1 from public.organization_members where organization_id=o and user_id=a for update;
 perform 1 from public.room_members where room_id=p_room_id and user_id=a for update;
 perform room_access_private.owner(o,p_room_id,a);
 c := encode(extensions.gen_random_bytes(32),'hex'); e := now()+interval '24 hours';
 insert into room_access_private.room_invites(organization_id,room_id,issuer_user_id,role,code_hash,organization_version,room_version,expires_at)
 values(o,p_room_id,a,p_role,encode(extensions.digest(c,'sha256'),'hex'),ov,rv,e);
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_role) values(o,p_room_id,a,'owner','invite',p_role);
 return jsonb_build_object('code',c,'expiresAt',e);
end; $$;
create function public.access_join(p_code text,p_display_alias text) returns jsonb
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
 or not exists(select 1 from auth.users where id=i.issuer_user_id and (banned_until is null or banned_until<=now()))
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
create function public.access_revoke_room_member(p_room_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); o uuid; target_role text;
begin
 select organization_id into o from public.rooms where id=p_room_id;
 perform 1 from public.organizations where id=o for update;
 perform 1 from public.rooms where id=p_room_id and organization_id=o for update;
 perform 1 from public.organization_members where organization_id=o and user_id in(a,p_user_id) order by user_id for update;
 perform 1 from public.room_members where room_id=p_room_id and user_id in(a,p_user_id) order by user_id for update;
 perform room_access_private.owner(o,p_room_id,a);
 select role into target_role from public.room_members where room_id=p_room_id and user_id=p_user_id and status='active';
 if not found or p_user_id=a or target_role='owner' then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 update public.room_members set status='removed' where room_id=p_room_id and user_id=p_user_id;
 update public.rooms set access_version=access_version+1 where id=p_room_id;
 insert into room_access_private.access_audit(organization_id,room_id,actor_user_id,actor_role,action,target_user_id,target_role) values(o,p_room_id,a,'owner','revoke-room-member',p_user_id,target_role);
 return jsonb_build_object('removed',true);
end; $$;
create function public.access_revoke_group_member(p_organization_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a uuid := room_access_private.actor(); target_role text;
begin
 perform 1 from public.organizations where id=p_organization_id for update;
 perform 1 from public.rooms where organization_id=p_organization_id order by id for update;
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id in(a,p_user_id) order by user_id for update;
 perform 1 from public.room_members where organization_id=p_organization_id and user_id in(a,p_user_id) order by room_id,user_id for update;
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=a and status='active' and role='owner') then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 select role into target_role from public.organization_members where organization_id=p_organization_id and user_id=p_user_id and status='active';
 if not found or p_user_id=a or target_role='owner' or exists(select 1 from public.room_members where organization_id=p_organization_id and user_id=p_user_id and status='active' and role='owner') then raise exception using message='FORBIDDEN',errcode='P0001'; end if;
 update public.organization_members set status='removed' where organization_id=p_organization_id and user_id=p_user_id;
 update public.room_members set status='removed' where organization_id=p_organization_id and user_id=p_user_id;
 update public.organizations set access_version=access_version+1 where id=p_organization_id;
 update public.rooms set access_version=access_version+1 where organization_id=p_organization_id;
 insert into room_access_private.access_audit(organization_id,actor_user_id,actor_role,action,target_user_id,target_role) values(p_organization_id,a,'owner','revoke-group-member',p_user_id,target_role);
 return jsonb_build_object('removed',true);
end; $$;
revoke all on function public.access_bootstrap(text,text,text,text,text,text), public.access_room(uuid,text,text,text,text), public.access_invite(uuid,text), public.access_join(text,text), public.access_revoke_room_member(uuid,uuid), public.access_revoke_group_member(uuid,uuid) from public,anon,authenticated;
grant execute on function public.access_bootstrap(text,text,text,text,text,text), public.access_room(uuid,text,text,text,text), public.access_invite(uuid,text), public.access_join(text,text), public.access_revoke_room_member(uuid,uuid), public.access_revoke_group_member(uuid,uuid) to authenticated;
commit;
