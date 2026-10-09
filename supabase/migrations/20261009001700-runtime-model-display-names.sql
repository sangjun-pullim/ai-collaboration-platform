-- Accept safe provider display names without changing executable catalog identity.
-- CREATE OR REPLACE preserves the existing function identity, grants and stored settings.
create or replace function runtime_settings_private.catalog_ok(b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare m jsonb; defaults jsonb; label text; semantic jsonb;
begin
 if not runtime_settings_private.keys(b,array['runtime','version','models','defaultSettings','snapshotHash','policy']) or octet_length(b::text)>16384
 or jsonb_typeof(b->'runtime')<>'string' or jsonb_typeof(b->'version')<>'string' or jsonb_typeof(b->'snapshotHash')<>'string' or jsonb_typeof(b->'policy')<>'string'
 or b->>'runtime' not in ('codex','claude') or not runtime_settings_private.text_ok(b->>'version') or b->>'snapshotHash' !~ '^[a-f0-9]{64}$'
 or b->>'policy' not in ('verified','unsupported') or jsonb_typeof(b->'models')<>'array' or jsonb_array_length(b->'models')>256 then return false;end if;
 for m in select value from jsonb_array_elements(b->'models') loop
 if not runtime_settings_private.keys(m-'displayName',array['id','model','efforts','defaultEffort','isDefault']) or not runtime_settings_private.text_ok(m->>'id') or not runtime_settings_private.text_ok(m->>'model')
 or jsonb_typeof(m->'id')<>'string' or jsonb_typeof(m->'model')<>'string' or jsonb_typeof(m->'defaultEffort') not in ('string','null')
 or jsonb_typeof(m->'efforts')<>'array' or jsonb_array_length(m->'efforts')>12 or jsonb_typeof(m->'isDefault')<>'boolean'
 or exists(select 1 from jsonb_array_elements(m->'efforts') e where jsonb_typeof(e)<>'string' or not runtime_settings_private.text_ok(e#>>'{}'))
 or (select count(*) from jsonb_array_elements(m->'efforts'))<>(select count(distinct value) from jsonb_array_elements(m->'efforts'))
 or (b->>'runtime'='codex' and (jsonb_array_length(m->'efforts')=0 or m->'defaultEffort'='null'::jsonb))
 or (m->'defaultEffort'<>'null'::jsonb and (jsonb_typeof(m->'defaultEffort')<>'string' or not (m->'efforts' ? (m->>'defaultEffort')))) then return false;end if;
 if m ? 'displayName' then
 label:=m->>'displayName';
 if jsonb_typeof(m->'displayName')<>'string' or label<>btrim(label)
 or (label collate "C") !~ '^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$'
 or position('..' in label)>0
 or label ~* '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
 or label ~* '[a-f0-9]{24,}' or label ~* '(sk-|token|secret|credential|bearer)' then return false;end if;
 end if;
 end loop;
 semantic:=jsonb_set(b-'snapshotHash','{models}',
 (select coalesce(jsonb_agg(value-'displayName' order by ordinality),'[]'::jsonb) from jsonb_array_elements(b->'models') with ordinality));
 if encode(extensions.digest(runtime_settings_private.canonical(semantic),'sha256'),'hex')<>b->>'snapshotHash' then return false;end if;
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
