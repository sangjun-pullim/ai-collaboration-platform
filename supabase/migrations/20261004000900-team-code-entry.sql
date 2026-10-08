begin;

create schema team_entry_private;
revoke all on schema team_entry_private from public, anon, authenticated;
create table team_entry_private.configuration (
  id integer primary key check (id=1),
  verifier text not null check (verifier ~ '^\$2[aby]\$'),
  changed_at timestamptz not null default clock_timestamp()
);
create table team_entry_private.admissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  legacy boolean not null default false,
  admitted_at timestamptz not null default clock_timestamp()
);
create table team_entry_private.attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  recent timestamptz[] not null default '{}'
);
create table team_entry_private.global_attempts (
  id integer primary key check (id=1),
  recent timestamptz[] not null default '{}'
);
insert into team_entry_private.global_attempts(id) values(1);
revoke all on all tables in schema team_entry_private from public, anon, authenticated;

-- Preserve existing confirmed permanent identities once, without auto-admitting
-- future Auth users or resolving ownership by their display names.
insert into team_entry_private.admissions(user_id,display_name,legacy)
select u.id, coalesce((select m.display_alias from public.organization_members m
  where m.user_id=u.id and m.status='active' order by m.organization_id limit 1),'참가자'),true
from auth.users u where u.is_anonymous is not true and u.deleted_at is null
  and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
  and (u.banned_until is null or u.banned_until <= clock_timestamp());

create function team_entry_private.admitted(u uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from team_entry_private.admissions a join auth.users x on x.id=a.user_id
  where a.user_id=u and x.deleted_at is null and (x.banned_until is null or x.banned_until<=now()));
$$;
revoke all on function team_entry_private.admitted(uuid) from public,anon,authenticated;

create function public.team_entry_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('admitted',true,'userId',a.user_id,'displayName',a.display_name)
  from team_entry_private.admissions a where a.user_id=auth.uid() and team_entry_private.admitted(a.user_id)),
  jsonb_build_object('admitted',false));
$$;
revoke all on function public.team_entry_status() from public,anon,authenticated;
grant execute on function public.team_entry_status() to authenticated;

create function public.team_entry_admit(p_code text,p_display_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); v text; t timestamptz:=clock_timestamp(); global_recent timestamptz[]; actor_recent timestamptz[];
begin
 if u is null or not exists(select 1 from auth.users where id=u and deleted_at is null
  and (banned_until is null or banned_until<=t)) then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','UNAUTHENTICATED')); end if;
 if p_code is null or char_length(p_code) not between 1 and 128 or octet_length(p_code)>512 or p_code ~ '[[:cntrl:]]'
  or p_display_name is null or char_length(p_display_name) not between 1 and 80
  or char_length(btrim(p_display_name))=0 or p_display_name ~ '[[:cntrl:]]' then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_BODY')); end if;
 select verifier into v from team_entry_private.configuration where id=1 for share;
 if v is null then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','UNAVAILABLE')); end if;
 -- A single lock order protects rolling quotas; returned failures commit counters.
 select recent into global_recent from team_entry_private.global_attempts where id=1 for update;
 global_recent:=array(select x from unnest(global_recent) x where x>t-interval '1 minute');
 insert into team_entry_private.attempts(user_id) values(u) on conflict do nothing;
 select recent into actor_recent from team_entry_private.attempts where user_id=u for update;
 actor_recent:=array(select x from unnest(actor_recent) x where x>t-interval '15 minutes');
 if cardinality(global_recent)>=60 or cardinality(actor_recent)>=5 then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','CODE_COOLDOWN')); end if;
 update team_entry_private.global_attempts set recent=array_append(global_recent,t) where id=1;
 update team_entry_private.attempts set recent=array_append(actor_recent,t) where user_id=u;
 -- Prehash the complete UTF-8 input so bcrypt never truncates a long code at 72 bytes.
 if extensions.crypt(encode(extensions.digest(convert_to(p_code,'UTF8'),'sha256'),'hex'),v)<>v then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','CODE_REJECTED')); end if;
 insert into team_entry_private.admissions(user_id,display_name) values(u,btrim(p_display_name))
 on conflict(user_id) do update set display_name=excluded.display_name;
 update team_entry_private.attempts set recent='{}' where user_id=u;
 return jsonb_build_object('ok',true,'userId',u,'displayName',btrim(p_display_name));
end; $$;
revoke all on function public.team_entry_admit(text,text) from public,anon,authenticated;
grant execute on function public.team_entry_admit(text,text) to authenticated;

create or replace function room_access_private.actor() returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
 if not team_entry_private.admitted(u) then raise exception using message='UNAUTHENTICATED',errcode='P0001'; end if;
 return u;
end; $$;
create or replace function room_access_private.in_organization(p_organization_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select team_entry_private.admitted(auth.uid()) and exists(select 1 from public.organization_members m
  where m.organization_id=p_organization_id and m.user_id=auth.uid() and m.status='active');
$$;
create or replace function room_access_private.in_room(p_room_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select team_entry_private.admitted(auth.uid()) and exists(select 1 from public.room_members m
  join public.organization_members o on o.organization_id=m.organization_id and o.user_id=m.user_id
  where m.room_id=p_room_id and m.user_id=auth.uid() and m.status='active' and o.status='active');
$$;
create or replace function device_binding_private.live(u uuid,o uuid,r uuid,write_access boolean default true) returns boolean
language sql stable security definer set search_path='' as $$
 select team_entry_private.admitted(u) and exists(select 1 from public.organization_members m
  join public.room_members rm on rm.organization_id=m.organization_id and rm.user_id=m.user_id
  where m.user_id=u and m.organization_id=o and m.status='active' and rm.room_id=r and rm.status='active'
  and (not write_access or rm.role in ('owner','participant')));
$$;

commit;
