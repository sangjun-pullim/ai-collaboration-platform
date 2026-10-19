-- Receipts are append-only idempotency records. Their exact-key lookup and
-- insertion remain serialized by the existing global guard and room lock.
-- Locking every historical receipt on each poll adds unbounded work without
-- protecting an additional mutation. Preserve all other lock ordering.
create or replace function workflow_private.lock_room(r uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into workflow_private.rooms(room_id) values(r) on conflict do nothing;
 perform 1 from workflow_private.rooms where room_id=r for update;
 perform 1 from workflow_private.cycles where room_id=r order by id for update;
 perform 1 from workflow_private.requests where room_id=r order by id for update;
 perform 1 from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id where q.room_id=r order by a.id for update of a;
 perform 1 from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id where c.room_id=r order by q.id for update of q;
 perform 1 from workflow_private.controls c join workflow_private.requests q on q.id=c.request_id where q.room_id=r order by c.id for update of c;
 perform 1 from workflow_private.readiness where room_id=r order by agent_id for update;
end;$$;
