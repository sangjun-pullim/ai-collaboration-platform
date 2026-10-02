begin;
set local search_path = '';

-- Receipt references survive credential rotation, but must not prevent a whole
-- device/organization cascade. Defer NO ACTION checks without adding cascades.
do $$
declare
 expected record;
 receipt_fk pg_catalog.pg_constraint%rowtype;
 source_keys smallint[];
 target_keys smallint[];
begin
 for expected in select * from (values
  ('device_binding_private.workspaces', 'workspaces_device_id_registration_credential_hash_fkey', 'registration_credential_hash'),
  ('device_binding_private.agents', 'agents_device_id_registration_credential_hash_fkey', 'registration_credential_hash'),
  ('device_binding_private.agents', 'agents_device_id_replacement_credential_hash_fkey', 'replacement_credential_hash')
 ) as receipt(table_name, constraint_name, receipt_column)
 loop
  select c.* into receipt_fk from pg_catalog.pg_constraint c
   where c.conrelid=pg_catalog.to_regclass(expected.table_name) and c.conname=expected.constraint_name;
  if not found then raise exception 'DEVICE_RECEIPT_FK_SHAPE_MISMATCH'; end if;
  select array[d.attnum,r.attnum] into source_keys from pg_catalog.pg_attribute d,pg_catalog.pg_attribute r
   where d.attrelid=receipt_fk.conrelid and d.attname='device_id' and not d.attisdropped
    and r.attrelid=receipt_fk.conrelid and r.attname=expected.receipt_column and not r.attisdropped;
  select array[d.attnum,h.attnum] into target_keys from pg_catalog.pg_attribute d,pg_catalog.pg_attribute h
   where d.attrelid=pg_catalog.to_regclass('device_binding_private.credentials') and d.attname='device_id' and not d.attisdropped
    and h.attrelid=d.attrelid and h.attname='hash' and not h.attisdropped;
  if receipt_fk.contype<>'f' or receipt_fk.confrelid is distinct from pg_catalog.to_regclass('device_binding_private.credentials')
   or source_keys is null or target_keys is null or receipt_fk.conkey is distinct from source_keys or receipt_fk.confkey is distinct from target_keys
   or receipt_fk.confdeltype<>'a' or receipt_fk.confupdtype<>'a' or receipt_fk.confmatchtype<>'s'
   or not receipt_fk.convalidated or receipt_fk.condeferrable or receipt_fk.condeferred
  then raise exception 'DEVICE_RECEIPT_FK_SHAPE_MISMATCH'; end if;
 end loop;
end;
$$;

alter table device_binding_private.workspaces alter constraint workspaces_device_id_registration_credential_hash_fkey deferrable initially deferred;
alter table device_binding_private.agents alter constraint agents_device_id_registration_credential_hash_fkey deferrable initially deferred;
alter table device_binding_private.agents alter constraint agents_device_id_replacement_credential_hash_fkey deferrable initially deferred;
commit;
