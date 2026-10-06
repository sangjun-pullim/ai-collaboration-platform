-- Exact owner-approved read mode is public metadata; local roots and approval hashes stay local.
-- Replacements retain the existing owner, credential, revision, admission and room locking checks.
create or replace function runtime_settings_private.validate(action text,b jsonb) returns void language plpgsql set search_path='' as $$
declare k text[]; field text;
begin
 k:=case action when 'list' then array['deviceId'] when 'cancel' then array['operationId','deviceId'] when 'poll' then array[]::text[]
 when 'select-folder' then array['operationId','deviceId','expectedConfigRevision','runtime']
 when 'select-runtime' then array['operationId','deviceId','expectedConfigRevision','runtime','model','effort','snapshotHash']
 when 'apply' then array['operationId','deviceId','expectedConfigRevision','runtime','model','effort','snapshotHash','localRootReference','repositoryAlias','sessionAlias','expectedEpoch']
 when 'receipt' then array['operationId','state','configRevision','runtime','model','effort','snapshotHash','localRootReference','repositoryAlias','sessionAlias','catalog','bindingEpoch','agentId','workspaceId'] end;
 if action in ('list','poll') and b ? 'operationId' then k:=k||array['operationId'];end if;
 if action in ('apply','receipt') and b ? 'readMode' then k:=k||array['readMode'];end if;
 if k is null or not runtime_settings_private.keys(b,k) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if octet_length(b::text)>16384 then perform runtime_settings_private.fail('BODY_TOO_LARGE');end if;
 if b ? 'readMode' and (jsonb_typeof(b->'readMode')<>'string' or b->>'readMode'<>'AUTO_CODE' or (action='receipt' and (b->'localRootReference'='null'::jsonb or b->'repositoryAlias'='null'::jsonb or b->'runtime'='null'::jsonb))) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 foreach field in array k loop
 if field in ('operationId','deviceId') and (jsonb_typeof(b->field)<>'string' or not runtime_settings_private.id_ok(b->>field)) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('expectedConfigRevision','configRevision') and (jsonb_typeof(b->field)<>'number' or b->>field !~ '^(0|[1-9][0-9]{0,15})$' or (b->>field)::numeric>9007199254740991) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('bindingEpoch','expectedEpoch') and b->field<>'null'::jsonb and (jsonb_typeof(b->field)<>'number' or b->>field !~ '^[1-9][0-9]{0,15}$' or (b->>field)::numeric>9007199254740991) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('runtime','model','snapshotHash','localRootReference','repositoryAlias','sessionAlias','agentId','workspaceId') and (action<>'receipt' or b->field<>'null'::jsonb) then
 if jsonb_typeof(b->field)<>'string' then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='runtime' and b->>field not in ('codex','claude') then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='model' and not runtime_settings_private.text_ok(b->>field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='snapshotHash' and b->>field !~ '^[a-f0-9]{64}$' then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('localRootReference','agentId','workspaceId') and not runtime_settings_private.id_ok(b->>field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field in ('repositoryAlias','sessionAlias') and not coalesce(device_binding_private.alias_ok(b->>field),false) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 end if;
 if field='effort' and b->field<>'null'::jsonb and (jsonb_typeof(b->field)<>'string' or not runtime_settings_private.text_ok(b->>field)) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 if field='catalog' and b->field<>'null'::jsonb and not runtime_settings_private.catalog_ok(b->field) then perform runtime_settings_private.fail('INVALID_BODY');end if;
 end loop;
 if action='receipt' and (jsonb_typeof(b->'state')<>'string' or b->>'state' not in ('LOCAL_CONFIRMATION','COMMITTED','APPLIED','FAILED','UNKNOWN','CANCELLED')) then perform runtime_settings_private.fail('INVALID_BODY');end if;
end;$$;

create or replace function runtime_settings_private.candidate_receipt_ok(o runtime_settings_private.operations,b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if b->>'runtime' is distinct from o.folder_body->>'runtime' then return false;end if;
 if o.apply_body is not null then
 return (b-array['operationId','state','configRevision','catalog','bindingEpoch','agentId','workspaceId'])=(o.apply_body-array['operationId','deviceId','expectedConfigRevision','expectedEpoch']);
 end if;
 if b->'model'<>'null'::jsonb or b->'effort'<>'null'::jsonb or b->'snapshotHash'<>'null'::jsonb or b->'sessionAlias'<>'null'::jsonb then return false;end if;
 if (b->'localRootReference'='null'::jsonb)<>(b->'repositoryAlias'='null'::jsonb) then return false;end if;
 if o.local_receipt is not null then
 return (b->'readMode' is not distinct from o.local_receipt->'readMode') and b->'localRootReference'=o.local_receipt->'localRootReference' and b->'repositoryAlias'=o.local_receipt->'repositoryAlias';
 end if;
 if o.receipt is not null and o.receipt->'localRootReference'<>'null'::jsonb then
 return (b->'readMode' is not distinct from o.receipt->'readMode') and b->'localRootReference'=o.receipt->'localRootReference' and b->'repositoryAlias'=o.receipt->'repositoryAlias';
 end if;
 return true;
end;$$;

create or replace function public.runtime_settings_human(p_action text,p_body jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; d device_binding_private.devices; c runtime_settings_private.configurations; o runtime_settings_private.operations; a device_binding_private.agents;
begin
 perform device_binding_private.guard();perform runtime_settings_private.validate(p_action,p_body);
 if p_action not in ('list','select-folder','select-runtime','apply','cancel') then perform runtime_settings_private.fail('NOT_FOUND');end if;
 u:=room_access_private.actor();
 select * into d from device_binding_private.devices where id=(p_body->>'deviceId')::uuid;
 if d.id is null then perform runtime_settings_private.fail('NOT_FOUND');end if;
 perform device_binding_private.lock_scope(d.organization_id,d.room_id);
 u:=room_access_private.actor();select * into d from device_binding_private.devices where id=d.id;
 if d.owner_user_id<>u or not device_binding_private.live(u,d.organization_id,d.room_id) then perform runtime_settings_private.fail('FORBIDDEN');end if;
 if d.state<>'active' or not exists(select 1 from device_binding_private.credentials where hash=d.current_hash and revoked_at is null and expires_at>clock_timestamp()) then perform runtime_settings_private.fail('CONFLICT');end if;
 perform workflow_private.lock_room(d.room_id);
 insert into runtime_settings_private.configurations(device_id) values(d.id) on conflict do nothing;
 select * into c from runtime_settings_private.configurations where device_id=d.id for update;
 if p_action='list' then return runtime_settings_private.response(d.id,(p_body->>'operationId')::uuid);end if;
 select * into o from runtime_settings_private.operations where device_id=d.id and operation_id=(p_body->>'operationId')::uuid for update;
 if p_action='select-folder' then
 if o.operation_id is not null then
 if o.folder_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if c.revision<>(p_body->>'expectedConfigRevision')::bigint or exists(select 1 from runtime_settings_private.operations where device_id=d.id and (state not in ('APPLIED','CANCELLED') or (state='CANCELLED' and applied_receipt is null))) then perform runtime_settings_private.fail('CONFLICT');end if;
 insert into runtime_settings_private.operations(device_id,operation_id,expected_revision,state,requested,folder_body) values(d.id,(p_body->>'operationId')::uuid,c.revision,'REQUESTED',p_body,p_body) returning * into o;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if o.operation_id is null then perform runtime_settings_private.fail('NOT_FOUND');end if;
 if p_action='cancel' then
 if o.state='CANCELLED' then return runtime_settings_private.response(d.id,o.operation_id);end if;
 if o.state in ('COMMITTED','APPLIED') or (o.state in ('UNKNOWN','FAILED') and o.apply_body is not null) then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state='CANCELLED' where device_id=d.id and operation_id=o.operation_id;
 return runtime_settings_private.response(d.id,o.operation_id);
 end if;
 if p_action='select-runtime' and o.selection_body is not null then
 if o.selection_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 if p_action='apply' and o.apply_body is not null then
 if o.apply_body<>p_body then perform runtime_settings_private.fail('CONFLICT');end if;
 return runtime_settings_private.response(d.id,o.operation_id);end if;
 if o.state<>'LOCAL_CONFIRMATION' or o.expected_revision<>c.revision or o.expected_revision<>(p_body->>'expectedConfigRevision')::bigint then perform runtime_settings_private.fail('CONFLICT');end if;
 if p_body->>'runtime'<>o.folder_body->>'runtime' then perform runtime_settings_private.fail('CONFLICT');end if;
 perform runtime_settings_private.selection(p_body,c.catalog);
 if p_action='select-runtime' then
 update runtime_settings_private.operations set selection_body=p_body,requested=p_body where device_id=d.id and operation_id=o.operation_id;
 else
 if o.selection_body is null or (p_body-array['localRootReference','repositoryAlias','sessionAlias','expectedEpoch','readMode'])<>o.selection_body or (p_body->'readMode' is distinct from o.receipt->'readMode') or o.receipt->>'localRootReference'<>p_body->>'localRootReference' or o.receipt->>'repositoryAlias'<>p_body->>'repositoryAlias' then perform runtime_settings_private.fail('CONFLICT');end if;
 if not runtime_settings_private.idle(d.id) then perform runtime_settings_private.fail('CONFLICT');end if;
 if (select count(*) from device_binding_private.agents where device_id=d.id and state='active')>1 then perform runtime_settings_private.fail('CONFLICT');end if;
 select * into a from device_binding_private.agents where device_id=d.id and state='active';
 if (a.id is null and p_body->'expectedEpoch'<>'null'::jsonb) or (a.id is not null and p_body->'expectedEpoch' is distinct from to_jsonb(a.binding_epoch)) then perform runtime_settings_private.fail('CONFLICT');end if;
 update runtime_settings_private.operations set state='APPLYING',apply_body=p_body,requested=p_body,reserved_epoch=a.binding_epoch,agent_id=a.id,workspace_id=a.workspace_id where device_id=d.id and operation_id=o.operation_id;
 delete from workflow_private.readiness where device_id=d.id;
 end if;
 return runtime_settings_private.response(d.id,o.operation_id);
end;$$;
