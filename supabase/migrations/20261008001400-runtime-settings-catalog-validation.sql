-- Keep catalog validation strict while separating SQL aliases from the PL/pgSQL loop variable.
-- CREATE OR REPLACE preserves the existing function identity, grants and stored settings.
create or replace function runtime_settings_private.catalog_ok(b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare m jsonb; defaults jsonb;
begin
 if not runtime_settings_private.keys(b,array['runtime','version','models','defaultSettings','snapshotHash','policy']) or octet_length(b::text)>16384
 or jsonb_typeof(b->'runtime')<>'string' or jsonb_typeof(b->'version')<>'string' or jsonb_typeof(b->'snapshotHash')<>'string' or jsonb_typeof(b->'policy')<>'string'
 or b->>'runtime' not in ('codex','claude') or not runtime_settings_private.text_ok(b->>'version') or b->>'snapshotHash' !~ '^[a-f0-9]{64}$'
 or b->>'policy' not in ('verified','unsupported') or jsonb_typeof(b->'models')<>'array' or jsonb_array_length(b->'models')>256 then return false;end if;
 for m in select value from jsonb_array_elements(b->'models') loop
 if not runtime_settings_private.keys(m,array['id','model','efforts','defaultEffort','isDefault']) or not runtime_settings_private.text_ok(m->>'id') or not runtime_settings_private.text_ok(m->>'model')
 or jsonb_typeof(m->'id')<>'string' or jsonb_typeof(m->'model')<>'string' or jsonb_typeof(m->'defaultEffort') not in ('string','null')
 or jsonb_typeof(m->'efforts')<>'array' or jsonb_array_length(m->'efforts')>12 or jsonb_typeof(m->'isDefault')<>'boolean'
 or exists(select 1 from jsonb_array_elements(m->'efforts') e where jsonb_typeof(e)<>'string' or not runtime_settings_private.text_ok(e#>>'{}'))
 or (select count(*) from jsonb_array_elements(m->'efforts'))<>(select count(distinct value) from jsonb_array_elements(m->'efforts'))
 or (b->>'runtime'='codex' and (jsonb_array_length(m->'efforts')=0 or m->'defaultEffort'='null'::jsonb))
 or (m->'defaultEffort'<>'null'::jsonb and (jsonb_typeof(m->'defaultEffort')<>'string' or not (m->'efforts' ? (m->>'defaultEffort')))) then return false;end if;
 end loop;
 if encode(extensions.digest(runtime_settings_private.canonical(b-'snapshotHash'),'sha256'),'hex')<>b->>'snapshotHash' then return false;end if;
 if (select count(*) from jsonb_array_elements(b->'models'))<>(select count(distinct value->>'id') from jsonb_array_elements(b->'models'))
 or (select count(*) from jsonb_array_elements(b->'models'))<>(select count(distinct value->>'model') from jsonb_array_elements(b->'models'))
 or (select count(*) from jsonb_array_elements(b->'models') as catalog_model(value) where catalog_model.value->'isDefault'='true'::jsonb)>1 then return false;end if;
 defaults:=b->'defaultSettings';
 if defaults<>'null'::jsonb then
 if not runtime_settings_private.keys(defaults,array['model','effort']) or jsonb_typeof(defaults->'model')<>'string' or jsonb_typeof(defaults->'effort') not in ('string','null') or not exists(select 1 from jsonb_array_elements(b->'models') as catalog_model(value) where catalog_model.value->>'model'=defaults->>'model' and ((defaults->'effort'='null'::jsonb and b->>'runtime'='claude' and jsonb_array_length(catalog_model.value->'efforts')=0) or (defaults->'effort'<>'null'::jsonb and catalog_model.value->'efforts' ? (defaults->>'effort')))) then return false;end if;
 end if;
 return b->>'policy'<>'unsupported' or (jsonb_array_length(b->'models')=0 and defaults='null'::jsonb);
exception when others then return false;
end;$$;
