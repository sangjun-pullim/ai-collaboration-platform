-- Disambiguate the confirmed receipt variable from the stored receipt column.
create or replace function runtime_settings_private.commit_binding(d device_binding_private.devices,o runtime_settings_private.operations,b jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a device_binding_private.agents; w device_binding_private.workspaces; binding_receipt jsonb; next_revision bigint; ph text;
begin
 if o.committed_receipt is not null then
 if o.commit_body<>b then perform runtime_settings_private.fail('CONFLICT');end if;
 return o.committed_receipt;end if;
 if o.state not in ('APPLYING','UNKNOWN') or o.apply_body is null then perform runtime_settings_private.fail('CONFLICT');end if;
 select revision+1 into next_revision from runtime_settings_private.configurations where device_id=d.id and revision=o.expected_revision for update;
 if next_revision is null or next_revision>9007199254740991 or b->'configRevision'<>to_jsonb(next_revision) or not runtime_settings_private.idle(d.id) then perform runtime_settings_private.fail('CONFLICT');end if;
 perform runtime_settings_private.selection(o.apply_body,(select catalog from runtime_settings_private.configurations where device_id=d.id));
 if b->'catalog'<>'null'::jsonb or (b-array['operationId','state','configRevision','catalog','bindingEpoch','agentId','workspaceId'])<>(o.apply_body-array['operationId','deviceId','expectedConfigRevision','expectedEpoch']) then perform runtime_settings_private.fail('CONFLICT');end if;
 ph:=encode(extensions.digest(o.apply_body::text,'sha256'),'hex');
 if o.agent_id is null then
 if b->'bindingEpoch'<>'1'::jsonb or b->'agentId'<>'null'::jsonb or b->'workspaceId'<>'null'::jsonb then perform runtime_settings_private.fail('CONFLICT');end if;
 if (select count(*) from device_binding_private.agents where owner_user_id=d.owner_user_id and organization_id=d.organization_id and room_id=d.room_id and state='active')>=2 or (select count(*) from device_binding_private.workspaces where device_id=d.id and state='active')>=2 then perform runtime_settings_private.fail('QUOTA');end if;
 insert into device_binding_private.workspaces(device_id,owner_user_id,organization_id,room_id,repository_alias,branch,commit_hash,dirty,registration_operation,registration_payload_hash,registration_credential_hash)
 values(d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'repositoryAlias','unknown','unknown','unknown',o.operation_id,ph,d.current_hash) returning * into w;
 insert into device_binding_private.agents(workspace_id,device_id,owner_user_id,organization_id,room_id,session_alias,runtime,registration_operation,registration_payload_hash,registration_credential_hash)
 values(w.id,d.id,d.owner_user_id,d.organization_id,d.room_id,b->>'sessionAlias',b->>'runtime',o.operation_id,ph,d.current_hash) returning * into a;
 else
 select * into a from device_binding_private.agents where id=o.agent_id and device_id=d.id and state='active' and binding_epoch=o.reserved_epoch for update;
 if a.id is null or b->'bindingEpoch'<>to_jsonb(o.reserved_epoch+1) or b->'agentId'<>to_jsonb(o.agent_id) or b->'workspaceId'<>to_jsonb(o.workspace_id) then perform runtime_settings_private.fail('CONFLICT');end if;
 update device_binding_private.workspaces set repository_alias=b->>'repositoryAlias',branch='unknown',commit_hash='unknown' where id=a.workspace_id and state='active' returning * into w;
 if w.id is null then perform runtime_settings_private.fail('CONFLICT');end if;
 update device_binding_private.agents set session_alias=b->>'sessionAlias',runtime=b->>'runtime',binding_epoch=binding_epoch+1,replacement_operation=o.operation_id,replacement_payload_hash=ph,replacement_credential_hash=d.current_hash,replacement_completed_at=clock_timestamp(),replacement_epoch=binding_epoch+1 where id=a.id returning * into a;
 end if;
 binding_receipt:=b||jsonb_build_object('agentId',a.id,'workspaceId',w.id,'bindingEpoch',a.binding_epoch);
 update runtime_settings_private.configurations set revision=next_revision where device_id=d.id;
 update runtime_settings_private.operations set state='COMMITTED',receipt=binding_receipt,commit_body=b,committed_receipt=binding_receipt,agent_id=a.id,workspace_id=w.id where device_id=d.id and operation_id=o.operation_id;
 delete from workflow_private.readiness where device_id=d.id;
 return binding_receipt;
end;$$;
