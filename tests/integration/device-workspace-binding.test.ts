import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { deviceCase, digest, secret, DeviceFixture, type DeviceProfile, type DeviceResponse } from "../helpers/device-binding-fixture.js";
import { assertOwnedConfig, LocalAccessStack, ensure, productEnvironment, type StackConfig } from "../helpers/local-access-stack.js";
const good=(r:DeviceResponse)=>{ensure(r.status===200&&r.data.ok===true,"Expected successful device envelope");return r.data.data as Record<string,unknown>;};
async function anonDeviceRpc(f:DeviceFixture,action:string,body:unknown,key:string) {
 await f.saveCleanupIdentity();
 const response=await fetch(`${f.stack.config.api}/rest/v1/rpc/connector_${action}`,{method:"POST",headers:{apikey:f.stack.config.key,"Content-Type":"application/json"},body:JSON.stringify({p_body:body,p_secret:key})});
 return {status:response.status,data:await response.json() as Record<string,unknown>};
}
const rpcGood=(r:{status:number;data:Record<string,unknown>})=>ensure(r.status===200&&r.data.protocol===1,"Original secret must authenticate the direct anon device RPC");
const rpcDenied=(r:{status:number;data:Record<string,unknown>})=>ensure(r.status>=400&&r.data.code==="P0001"&&r.data.message==="UNAUTHENTICATED","Direct device RPC must reject with the fixed authentication error");
const denied=(r:DeviceResponse,status:number)=>ensure(r.status===status&&r.data.ok===false,"Expected fixed rejection");
function connectorHeaders(r:DeviceResponse) {
 const vary=r.headers.get("vary")?.split(",").map(value=>value.trim().toLowerCase())??[];
 if(r.status===200)ensure(vary.includes("authorization"),"Successful connector Vary must retain Authorization alongside framework tokens");
 ensure(!vary.includes("cookie"),"Connector Vary must not depend on human cookies");
 ensure(r.headers.get("cache-control")?.includes("no-store"),"Connector response must forbid caching");
 ensure(!r.headers.get("set-cookie"),"Connector response must not refresh human cookies");
}
async function cleanupIdentity(f:DeviceFixture) {
 const file=join(f.root,"cleanup-identity.json"),metadata=await lstat(file),text=await readFile(file,"utf8");
 ensure(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.uid===process.getuid?.()&&(metadata.mode&0o777)===0o600,"Recovery identity must be a private owned manifest");
 const identity=JSON.parse(text) as {version:number;project:string;namespace:string;users:string[];organizations:{id:string;ownerUserId:string}[];hashes:string[];pairings:{name:string;profileFile:string;pairingId?:string;codeHash?:string;proofHash?:string;deviceId?:string}[]};
 ensure(identity.version===1&&identity.project===f.stack.config.project&&identity.namespace===f.stack.namespace,"Recovery identity must preserve the owned namespace");
 for(const id of f.stack.users)ensure(identity.users.includes(id),"Recovery manifest must retain exact owned users before effects");
 for(const [id,ownerUserId] of f.stack.organizationOwners)ensure(identity.organizations.some(entry=>entry.id===id&&entry.ownerUserId===ownerUserId),"Recovery manifest must retain exact owned organization tuples");
 for(const p of f.profiles.values()) {
  const intent=identity.pairings.find(entry=>entry.name===p.name);ensure(intent&&intent.profileFile===`state/${p.name}.json`&&intent.pairingId===p.pairingId&&intent.codeHash===p.codeHash&&intent.proofHash===p.proofHash&&(!p.deviceId||intent.deviceId===p.deviceId),"Recovery manifest must connect exact pairing hashes and identities to its private profile intent");
  for(const value of [p.code,p.proof,p.credential])if(value)ensure(!text.includes(value),"Recovery manifest must exclude original authentication input");
 }
 for(const value of [f.stack.config.adminKey,f.stack.config.db,f.root])ensure(!text.includes(value),"Recovery manifest must exclude management credentials and absolute private paths");
 return identity;
}
async function setup(f:DeviceFixture) {const owner=await f.stack.person("owner");const scope=await f.stack.bootstrap(owner);const member=await f.stack.person("member");await f.stack.join(member,await f.stack.invite(owner,scope.roomId));const observer=await f.stack.person("observer");await f.stack.join(observer,await f.stack.invite(owner,scope.roomId,"observer"));return {owner,member,observer,scope};}
const exchangeBody=(p:DeviceProfile,key=secret())=>({pairingId:p.pairingId,operationId:randomUUID(),credentialHash:digest(key),confirmed:true});
const workspaceBody=()=>({operationId:randomUUID(),repositoryAlias:"저장소",branch:"main",commit:"unknown",dirty:"unknown"});
async function directExchange(f:DeviceFixture,p:DeviceProfile) {const key=secret();f.hashes.add(digest(key));const body=exchangeBody(p,key);const result=await f.request("exchange",body,p.proof);if(result.status===200){p.credential=key;p.deviceId=String(good(result).deviceId);}await f.saveCleanupIdentity();return {result,body,key};}
async function expirePair(f:DeviceFixture,p:DeviceProfile) {await f.verifyPairing(p);await f.stack.db.query("update device_binding_private.pairings set created_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second' where id=$1 and code_hash=$2 and proof_hash=$3",[p.pairingId,p.codeHash,p.proofHash]);}
async function expireReceipt(f:DeviceFixture,p:DeviceProfile) {await f.verifyPairing(p);await f.stack.db.query("update device_binding_private.pairings set completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and code_hash=$2",[p.pairingId,p.codeHash]);}
async function actionAuditCount(f:DeviceFixture,p:DeviceProfile,action:"rotate"|"workspace"|"agent"|"replace") {
 ensure(p.deviceId&&p.ownerUserId&&p.organizationId&&p.roomId,"Receipt audit regression requires an exact owned device scope");
 const count=await f.stack.db.query("select count(*)::int n from device_binding_private.connection_audit where device_id=$1 and actor_user_id=$2 and organization_id=$3 and room_id=$4 and action=$5",[p.deviceId,p.ownerUserId,p.organizationId,p.roomId,action]);return count.rows[0].n as number;
}

test("should pair a device only after human approval and matching local proof",()=>deviceCase("pair",async f=>{
 const {owner,observer,scope}=await setup(f);const p=await f.pair("pair");denied(await f.request("exchange",exchangeBody(p),p.proof),409);denied(await f.request("pairing-status",{pairingId:p.pairingId},secret()),401);
 denied(await f.human(observer,"approve",{code:p.code,...scope,confirmed:true}),403);const outsider=await f.stack.person("outside");const other=await f.stack.bootstrap(outsider);denied(await f.human(owner,"approve",{code:p.code,...other,confirmed:true}),403);
 await f.approve(owner,p,scope);const status=good(await f.request("pairing-status",{pairingId:p.pairingId},p.proof));const approved=status.scope as Record<string,unknown>;ensure(approved.roomId===scope.roomId&&approved.organizationId===scope.organizationId,"Approved scope must be authoritative");denied(await f.request("exchange",exchangeBody(p),p.code),401);await f.exchange(p);good(await f.request("heartbeat",{},p.credential));
 const rows=await f.stack.db.query("select code_hash,proof_hash from device_binding_private.pairings where id=$1",[p.pairingId]);ensure(rows.rows[0].code_hash===p.codeHash&&rows.rows[0].proof_hash===p.proofHash,"Only distinct pairing hashes belong in private storage");
}));
test("should consume pairing once and recover only the same exchange operation",()=>deviceCase("exchange",async f=>{
 const {owner,scope}=await setup(f);const p=(await f.apiPair("receipt")).profile!;await f.approve(owner,p,scope);const keys=[secret(),secret()],bodies=keys.map(key=>exchangeBody(p,key));
 for(const key of keys)f.hashes.add(digest(key));await f.saveCleanupIdentity();
 await f.stack.db.query("update device_binding_private.pairings set created_at=clock_timestamp()-interval '298 seconds',expires_at=clock_timestamp()+interval '1 second' where id=$1 and proof_hash=$2",[p.pairingId,p.proofHash]);
 const results=await Promise.all(bodies.map(body=>f.request("exchange",body,p.proof)));ensure(results.filter(r=>r.status===200).length===1&&results.filter(r=>r.status===409).length===1,"Concurrent exchange must consume once");
 // Use the winning payload, then cross the original pairing TTL without changing receipt time.
 const winner=results.findIndex(r=>r.status===200);const body=bodies[winner],key=keys[winner];const original=good(results[winner]);p.deviceId=String(original.deviceId);p.credential=key;f.hashes.add(digest(key));await expirePair(f,p);const recovered=good(await f.request("exchange",body,p.proof));ensure(JSON.stringify(recovered)===JSON.stringify(original),"Recovery must return unchanged result after pairing TTL");
 denied(await f.request("exchange",{...body,credentialHash:digest(secret())},p.proof),409);denied(await f.request("exchange",{...body,operationId:randomUUID()},p.proof),409);
 const audits=await f.stack.db.query("select count(*)::int n from device_binding_private.connection_audit where pairing_id=$1 and action='exchange'",[p.pairingId]);ensure(audits.rows[0].n===1,"Successful receipt must create exactly one audit");
 await expireReceipt(f,p);denied(await f.request("exchange",body,p.proof),409);const expired=(await f.apiPair("expired")).profile!;await f.approve(owner,expired,scope);await expirePair(f,expired);denied((await directExchange(f,expired)).result,409);
 const current=(await f.apiPair("current")).profile!;await f.approve(owner,current,scope);const x=await directExchange(f,current);good(x.result);good(await f.request("rotate",{operationId:randomUUID(),credentialHash:digest(secret())},x.key));denied(await f.request("exchange",x.body,current.proof),409);
}));
test("should bound pending pairing and owned device creation",()=>deviceCase("quotas",async f=>{
 const {owner,scope}=await setup(f);const count=await f.stack.db.query("select count(*)::int n from device_binding_private.pairings where state in ('pending','approved') and expires_at>clock_timestamp()");const available=50-count.rows[0].n;ensure(available>=0,"Global pending quota must already be bounded");
 const pending=await Promise.all(Array.from({length:available+3},(_,i)=>f.apiPair(`quota-${i}`)));ensure(pending.filter(x=>x.response.status===200).length===available&&pending.filter(x=>x.response.status===429).length===3,"Concurrent begin must respect exact global quota");
 const approved=pending.find(x=>x.profile)?.profile;if(approved)await f.approve(owner,approved,scope);
 for(const entry of pending)if(entry.profile)await expirePair(f,entry.profile);const reclaimed=(await f.apiPair("reclaimed")).profile;ensure(reclaimed,"Expired pending and approved entries must recover budget");await expirePair(f,reclaimed);
 const ps:DeviceProfile[]=[];for(let i=0;i<12;i++){const p=(await f.apiPair(`device-${i}`)).profile!;await f.approve(owner,p,scope);ps.push(p);}const devices=await Promise.all(ps.map(p=>directExchange(f,p)));ensure(devices.filter(x=>x.result.status===200).length===10&&devices.filter(x=>x.result.status===429).length===2,"Concurrent device creations must respect owner scope ten");
 const active=ps.filter(p=>p.credential);const workspaces=await Promise.all(Array.from({length:4},()=>f.request("workspace",workspaceBody(),active[0].credential)));ensure(workspaces.filter(r=>r.status===200).length===2&&workspaces.filter(r=>r.status===429).length===2,"Concurrent workspace quota is two per device");
 const w1=workspaces.filter(r=>r.status===200).map(good);const w2=good(await f.request("workspace",workspaceBody(),active[1].credential));const agents=await Promise.all([...w1.map(w=>({p:active[0],w})),{p:active[1],w:w2}].map(({p,w})=>f.request("agent",{operationId:randomUUID(),workspaceId:w.workspaceId,sessionAlias:"세션",runtime:"codex"},p.credential)));ensure(agents.filter(r=>r.status===200).length===2&&agents.filter(r=>r.status===429).length===1,"Agents must be limited across devices in owner scope");
 good(await f.human(owner,"remove",{deviceId:active[0].deviceId}));const newp=(await f.apiPair("replacement")).profile!;await f.approve(owner,newp,scope);good((await directExchange(f,newp)).result);const freedWorkspace=good(await f.request("workspace",workspaceBody(),newp.credential));good(await f.request("agent",{operationId:randomUUID(),workspaceId:freedWorkspace.workspaceId,sessionAlias:"새 세션",runtime:"codex"},newp.credential));
}));
test("should reject device access when its owner or membership becomes inactive",()=>deviceCase("inactive",async f=>{
 const {owner,member,scope}=await setup(f);const healthy=await f.connected(owner,scope,"healthy");await f.register(healthy);const target=await f.connected(member,scope,"target");await f.register(target);
 rpcGood(await anonDeviceRpc(f,"heartbeat",{},healthy.credential!));rpcGood(await anonDeviceRpc(f,"heartbeat",{},target.credential!));
 await Promise.all([f.request("rotate",{operationId:randomUUID(),credentialHash:digest(secret())},target.credential),owner.web.mutate("revoke-room-member",{roomId:scope.roomId,userId:member.id})]);denied(await f.request("heartbeat",{},target.credential),401);rpcDenied(await anonDeviceRpc(f,"heartbeat",{},target.credential!));good(await f.request("heartbeat",{},healthy.credential));rpcGood(await anonDeviceRpc(f,"heartbeat",{},healthy.credential!));
 for(const mode of ["ban","soft","hard","group"]){
  const person=await f.stack.person(mode);await f.stack.join(person,await f.stack.invite(owner,scope.roomId));const p=await f.connected(person,scope,mode);await f.register(p);
  const before=await f.stack.db.query("select id from device_binding_private.agents where id=$1 and workspace_id=$2 and device_id=$3 and owner_user_id=$4",[p.agentId,p.workspaceId,p.deviceId,person.id]);ensure(before.rowCount===1,"Inactive account regression must start with a real registered binding");
  rpcGood(await anonDeviceRpc(f,"heartbeat",{},p.credential!));rpcGood(await anonDeviceRpc(f,"heartbeat",{},healthy.credential!));
  if(mode==="ban")await f.stack.disable(person);else if(mode==="soft")await f.stack.softDeleteAccount(person);else if(mode==="hard")await f.stack.deleteAccount(person);else await owner.web.mutate("revoke-group-member",{organizationId:scope.organizationId,userId:person.id});
  denied(await f.request("heartbeat",{},p.credential),401);rpcDenied(await anonDeviceRpc(f,"heartbeat",{},p.credential!));good(await f.request("heartbeat",{},healthy.credential));rpcGood(await anonDeviceRpc(f,"heartbeat",{},healthy.credential!));
  const roster=await owner.web.dataClient().rpc("connection_room_bindings",{p_room_id:scope.roomId});ensure(!roster.error&&!roster.data.some((entry:{agentId:string})=>entry.agentId===p.agentId)&&roster.data.some((entry:{agentId:string})=>entry.agentId===healthy.agentId),"Inactive registered binding must disappear while a healthy owner stays visible");
  if(mode==="hard"){const removed=await f.stack.db.query("select (select count(*)::int from device_binding_private.devices where id=$1) devices,(select count(*)::int from device_binding_private.workspaces where id=$2) workspaces,(select count(*)::int from device_binding_private.agents where id=$3) agents,(select count(*)::int from device_binding_private.credentials where device_id=$1) credentials",[p.deviceId,p.workspaceId,p.agentId]);ensure(Object.values(removed.rows[0]).every(count=>count===0),"Physical account deletion must cascade all registered device state");}
 }
}));
test("should keep revoked devices and bindings disabled after a fresh invitation",()=>deviceCase("rejoin",async f=>{
 const {owner,member,scope}=await setup(f);const healthy=await f.connected(owner,scope,"healthy");const old=await f.connected(member,scope,"old");await f.register(old);const rotatedKey=secret(),rotation={operationId:randomUUID(),credentialHash:digest(rotatedKey)};f.hashes.add(digest(rotatedKey));good(await f.request("rotate",rotation,old.credential));const approved=await f.pair("approved");await f.approve(member,approved,scope);
 await Promise.all([f.request("exchange",exchangeBody(approved),approved.proof),owner.web.mutate("revoke-group-member",{organizationId:scope.organizationId,userId:member.id})]);await f.stack.join(member,await f.stack.invite(owner,scope.roomId));
 denied(await f.request("heartbeat",{},old.credential),401);denied(await f.request("rotate",rotation,old.credential),401);denied(await f.request("heartbeat",{},rotatedKey),401);denied(await f.request("exchange",exchangeBody(approved),approved.proof),409);const bindings=await owner.web.dataClient().rpc("connection_room_bindings",{p_room_id:scope.roomId});ensure(!bindings.error&&!(bindings.data as Record<string,unknown>[]).some(b=>b.agentId===old.agentId),"Rejoining must not revive old bindings");await f.connected(member,scope,"fresh");good(await f.request("heartbeat",{},healthy.credential));
 // Exercise both membership removal consumers against exchange and replacement commits.
 for(const scopeKind of ["room","group"] as const)for(const mutation of ["exchange","replace"] as const) {
  const prefix=`race-${scopeKind}-${mutation}`,person=await f.stack.person(prefix);await f.stack.join(person,await f.stack.invite(owner,scope.roomId));
  const active=await f.connected(person,scope,`${prefix}-active`);await f.register(active);const waiting=await f.pair(`${prefix}-waiting`);await f.approve(person,waiting,scope);
  const candidate=secret(),exchange=exchangeBody(waiting,candidate);f.hashes.add(digest(candidate));
  const replacement={operationId:randomUUID(),agentId:active.agentId,expectedEpoch:1,repositoryAlias:"경합 저장소",branch:"main",commit:"unknown",dirty:"unknown",sessionAlias:"경합 세션",runtime:"codex"};
  good(await f.request("heartbeat",{},active.credential));const beforeBindings=await owner.web.dataClient().rpc("connection_room_bindings",{p_room_id:scope.roomId});ensure(!beforeBindings.error&&beforeBindings.data.some((b:{agentId:string})=>b.agentId===active.agentId),"Race regression must begin with an active registered member binding");
  const [changed]=await Promise.all([mutation==="exchange"?f.request("exchange",exchange,waiting.proof):f.request("replace",replacement,active.credential),owner.web.mutate(`revoke-${scopeKind}-member`,scopeKind==="room"?{roomId:scope.roomId,userId:person.id}:{organizationId:scope.organizationId,userId:person.id})]);
  ensure([200,401,409].includes(changed.status),"Race must either commit before removal or reject after it");denied(await f.request("heartbeat",{},active.credential),401);good(await f.request("heartbeat",{},healthy.credential));
  const removedBindings=await owner.web.dataClient().rpc("connection_room_bindings",{p_room_id:scope.roomId});ensure(!removedBindings.error&&!removedBindings.data.some((b:{agentId:string})=>b.agentId===active.agentId),"Membership removal must permanently disable the prior active binding");
  await f.stack.join(person,await f.stack.invite(owner,scope.roomId));denied(await f.request("heartbeat",{},active.credential),401);denied(await f.request("heartbeat",{},candidate),401);denied(await f.request("exchange",exchange,waiting.proof),409);denied(await f.request("replace",replacement,active.credential),401);
  await f.connected(person,scope,`${prefix}-fresh`);good(await f.request("heartbeat",{},healthy.credential));
 }

}));
test("should rotate credentials atomically and preserve the original scope",()=>deviceCase("rotate",async f=>{
 const {owner,scope}=await setup(f);const p=await f.connected(owner,scope,"rotate");const old=p.credential!;const next=secret(),body={operationId:randomUUID(),credentialHash:digest(next)};f.hashes.add(digest(next));const rotationBefore=await actionAuditCount(f,p,"rotate");const first=good(await f.request("rotate",body,old));
 ensure(await actionAuditCount(f,p,"rotate")===rotationBefore+1,"Initial rotation must commit one scope-specific audit");
 denied(await f.request("heartbeat",{},old),401);good(await f.request("heartbeat",{},next));const recovered=good(await f.request("rotate",body,old));ensure(JSON.stringify(first)===JSON.stringify(recovered),"Rotation recovery must retain exact original expiry and scope");denied(await f.request("rotate",{...body,credentialHash:digest(secret())},old),401);
 ensure(await actionAuditCount(f,p,"rotate")===rotationBefore+1,"Rotation recovery and rejected changed payload must not add audits");
 await f.stack.db.query("update device_binding_private.credentials set created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where hash=$1 and device_id=$2",[digest(old),p.deviceId]);good(await f.request("rotate",body,old));denied(await f.request("rotate",{operationId:randomUUID(),credentialHash:digest(old)},next),409);denied(await f.request("rotate",{operationId:randomUUID(),credentialHash:p.proofHash},next),409);
 ensure(await actionAuditCount(f,p,"rotate")===rotationBefore+1,"Expired original-key receipt recovery must not add a rotation audit");
 const third=secret(),thirdBody={operationId:randomUUID(),credentialHash:digest(third)};f.hashes.add(digest(third));good(await f.request("rotate",thirdBody,next));denied(await f.request("rotate",body,old),401);
 const row=await f.stack.db.query("select owner_user_id,organization_id,room_id from device_binding_private.devices where id=$1",[p.deviceId]);ensure(row.rows[0].owner_user_id===owner.id&&row.rows[0].organization_id===scope.organizationId&&row.rows[0].room_id===scope.roomId,"Rotation cannot change approved scope");
 await f.stack.db.query("update device_binding_private.credentials set created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where hash=$1 and device_id=$2",[digest(third),p.deviceId]);denied(await f.request("rotate",thirdBody,next),401);denied(await f.request("rotate",{operationId:randomUUID(),credentialHash:digest(secret())},third),401);
 const receipt=await f.connected(owner,scope,"receipt-window"),receiptKey=secret(),receiptBody={operationId:randomUUID(),credentialHash:digest(receiptKey)};f.hashes.add(digest(receiptKey));good(await f.request("rotate",receiptBody,receipt.credential));await f.stack.db.query("update device_binding_private.devices set rotation_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and owner_user_id=$2",[receipt.deviceId,owner.id]);denied(await f.request("rotate",receiptBody,receipt.credential),401);
 const q=await f.connected(owner,scope,"race");const key=secret();f.hashes.add(digest(key));await Promise.all([f.request("rotate",{operationId:randomUUID(),credentialHash:digest(key)},q.credential),f.human(owner,"revoke",{deviceId:q.deviceId})]);denied(await f.request("heartbeat",{},key),401);
}));
test("should restrict registration and replacement to the credential scope and epoch",()=>deviceCase("registration",async f=>{
 const {owner,member,scope}=await setup(f);const p=await f.connected(owner,scope,"own");const other=await f.connected(member,scope,"other");const outsider=await f.stack.person("other-tenant"),tenant=await f.stack.bootstrap(outsider);const far=await f.connected(outsider,tenant,"far");
 const body=workspaceBody(),workspaceBefore=await actionAuditCount(f,p,"workspace");const w=good(await f.request("workspace",body,p.credential));ensure(await actionAuditCount(f,p,"workspace")===workspaceBefore+1,"Initial workspace registration must commit one audit");ensure(JSON.stringify(w)===JSON.stringify(good(await f.request("workspace",body,p.credential))),"Workspace receipt must recover once");
 ensure(await actionAuditCount(f,p,"workspace")===workspaceBefore+1,"Workspace receipt recovery must not add an audit");denied(await f.request("workspace",{...body,repositoryAlias:"changed"},p.credential),409);denied(await f.request("workspace",{...workspaceBody(),nativeSessionId:"private"},p.credential),400);
 const abody={operationId:randomUUID(),workspaceId:w.workspaceId,sessionAlias:"세션",runtime:"codex"};for(const key of [other.credential,far.credential])denied(await f.request("agent",abody,key),404);const agentBefore=await actionAuditCount(f,p,"agent"),a=good(await f.request("agent",abody,p.credential));ensure(await actionAuditCount(f,p,"agent")===agentBefore+1,"Initial agent registration must commit one audit");good(await f.request("agent",abody,p.credential));
 ensure(await actionAuditCount(f,p,"agent")===agentBefore+1,"Agent receipt recovery must not add an audit");
 let fkRejected=false;try{await f.stack.db.query("update device_binding_private.workspaces set device_id=$2 where id=$1",[w.workspaceId,other.deviceId]);}catch(e){fkRejected=(e as {code?:string}).code==="23503";}ensure(fkRejected,"Composite scope FK must reject a foreign device tuple");
 const replace={operationId:randomUUID(),agentId:a.agentId,expectedEpoch:1,repositoryAlias:"새 저장소",branch:"main",commit:"unknown",dirty:"unknown",sessionAlias:"새 세션",runtime:"codex"};denied(await f.request("replace",replace,other.credential),404);const replacementBefore=await actionAuditCount(f,p,"replace"),changed=good(await f.request("replace",replace,p.credential));ensure(changed.bindingEpoch===2,"Replacement increments once");ensure(await actionAuditCount(f,p,"replace")===replacementBefore+1,"Initial replacement must commit one audit");ensure(JSON.stringify(changed)===JSON.stringify(good(await f.request("replace",replace,p.credential))),"Receipt recovery precedes stale epoch check");
 ensure(await actionAuditCount(f,p,"replace")===replacementBefore+1,"Replacement receipt recovery must not add an audit");denied(await f.request("agent",abody,p.credential),409);denied(await f.request("workspace",body,p.credential),409);denied(await f.request("replace",{...replace,operationId:randomUUID()},p.credential),409);denied(await f.request("replace",{...replace,sessionAlias:"different"},p.credential),409);
 const nextReplace={...replace,operationId:randomUUID(),expectedEpoch:2,sessionAlias:"다음 세션"};good(await f.request("replace",nextReplace,p.credential));denied(await f.request("replace",replace,p.credential),409);
 await f.stack.db.query("update device_binding_private.agents set replacement_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and device_id=$2",[a.agentId,p.deviceId]);denied(await f.request("replace",nextReplace,p.credential),409);
 const expiredWorkspaceBody=workspaceBody(),expiredWorkspace=good(await f.request("workspace",expiredWorkspaceBody,far.credential));const expiredAgentBody={operationId:randomUUID(),workspaceId:expiredWorkspace.workspaceId,sessionAlias:"기한 세션",runtime:"codex"};const expiredAgent=good(await f.request("agent",expiredAgentBody,far.credential));await f.stack.db.query("update device_binding_private.workspaces set registration_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and device_id=$2",[expiredWorkspace.workspaceId,far.deviceId]);await f.stack.db.query("update device_binding_private.agents set registration_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and device_id=$2",[expiredAgent.agentId,far.deviceId]);denied(await f.request("workspace",expiredWorkspaceBody,far.credential),409);denied(await f.request("agent",expiredAgentBody,far.credential),409);
 await Promise.all([f.request("replace",{...replace,operationId:randomUUID(),expectedEpoch:3},p.credential),f.human(owner,"revoke",{deviceId:p.deviceId})]);denied(await f.request("replace",replace,p.credential),401);good(await f.request("heartbeat",{},other.credential));
}));
test("should keep private roots credentials and locators out of public storage and responses",()=>deviceCase("private",async f=>{
 const {owner,observer,scope}=await setup(f);const p=await f.connected(owner,scope,"private");await f.register(p);await f.cli(p.name,"heartbeat");const state=await f.state(p.name);const local=(state.mappings as Record<string,unknown>[])[0];
 const publicRpc=await observer.web.dataClient().rpc("connection_room_bindings",{p_room_id:scope.roomId});ensure(!publicRpc.error&&publicRpc.data.length===1,"Observer must see public unverified binding");const html=await (await observer.web.request(`/app/rooms/${scope.roomId}`)).text();const db=await f.stack.db.query("select to_jsonb(w) w,to_jsonb(a) a,to_jsonb(d) d from device_binding_private.workspaces w join device_binding_private.agents a on a.workspace_id=w.id join device_binding_private.devices d on d.id=a.device_id where d.id=$1",[p.deviceId]);const audit=await f.stack.db.query("select to_jsonb(a) from device_binding_private.connection_audit a where organization_id=$1",[scope.organizationId]);const api=await f.request("bindings",{},p.credential);const err=await f.request("agent",{privateRoot:local.root},p.credential);
 const pairingRows=await f.stack.db.query("select to_jsonb(p) data from device_binding_private.pairings p where p.id=$1 and p.code_hash=$2 and p.proof_hash=$3",[p.pairingId,p.codeHash,p.proofHash]);const credentialRows=await f.stack.db.query("select to_jsonb(c) data from device_binding_private.credentials c where c.device_id=$1",[p.deviceId]);const hashRows=await f.stack.db.query("select to_jsonb(h) data from device_binding_private.secret_hashes h where h.hash=any($1::text[])",[[p.codeHash,p.proofHash,digest(p.credential!)]]);
 ensure(pairingRows.rowCount===1&&credentialRows.rowCount===1&&hashRows.rowCount===3,"Leak regression must inspect actual pairing credential and retained hash storage");
 const publicText=JSON.stringify([publicRpc.data,html,api.text,err.text]);for(const value of [p.codeHash,p.proofHash,digest(p.credential!)])ensure(!publicText.includes(value),"Public projections must also omit stored secret hashes");
 const shared=JSON.stringify([publicText,db.rows,audit.rows,pairingRows.rows,credentialRows.rows,hashRows.rows]);for(const value of [local.root,local.nativeSessionId,p.credential,p.proof,p.code])ensure(typeof value==="string"&&!shared.includes(value),"Public response or storage contains private source material");ensure(html.includes("공개 저장소"),"Public alias must positively appear");
 const grants=await f.stack.db.query("select has_schema_privilege('anon','device_binding_private','USAGE') anon,has_table_privilege('authenticated','device_binding_private.credentials','SELECT') auth");ensure(!grants.rows[0].anon&&!grants.rows[0].auth,"Private schema must not grant direct access");for(const person of [owner,observer])ensure((await person.web.dataClient().schema("device_binding_private").from("devices").select("*")).error,"Direct private read must fail");
 const funcs=await f.stack.db.query("select p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'connector_%' or p.proname like 'connection_%')");ensure(funcs.rowCount===14&&funcs.rows.every(r=>r.prosecdef&&r.proconfig.includes('search_path=""')),"All connection RPCs must use empty definer search path");
}));
test("should keep connector authentication separate from browser cookies and human actions",()=>deviceCase("boundaries",async f=>{
 const {owner,scope}=await setup(f);
 const directPair=await f.pair("direct-inputs");
 const storedPair=await f.stack.db.query("select code_hash,proof_hash from device_binding_private.pairings where id=$1 and code_hash=$2 and proof_hash=$3",[directPair.pairingId,directPair.codeHash,directPair.proofHash]);ensure(storedPair.rowCount===1,"Direct RPC regression must use the actual stored hashes");
 const statusBody={pairingId:directPair.pairingId};rpcDenied(await anonDeviceRpc(f,"pairing_status",statusBody,storedPair.rows[0].proof_hash));rpcGood(await anonDeviceRpc(f,"pairing_status",statusBody,directPair.proof));
 const approval={code:directPair.code,...scope,confirmed:true};
 const hashApproval=await owner.web.dataClient().rpc("connection_approve",{p_body:{...approval,code:storedPair.rows[0].code_hash}});ensure(hashApproval.error?.code==="P0001"&&hashApproval.error.message==="NOT_FOUND","Stored code hash must not approve a pairing");
 for(const malformed of [null,[],{...approval,code:7},{...approval,code:"malformed"},{...approval,code:null},{...approval,confirmed:"true"},{...approval,extra:"unknown"}]) {
  const rejected=await owner.web.dataClient().rpc("connection_approve",{p_body:malformed});ensure(rejected.error?.code==="P0001"&&rejected.error.message==="INVALID_BODY","Approval must validate original body before hashing");
 }
 const rawApproval=await owner.web.dataClient().rpc("connection_approve",{p_body:approval});ensure(!rawApproval.error&&rawApproval.data.approved===true,"Raw code must approve the same pairing after the hash and malformed-body denials");directPair.organizationId=scope.organizationId;directPair.roomId=scope.roomId;directPair.ownerUserId=owner.id;
 const exchangeKey=secret(),exchange=exchangeBody(directPair,exchangeKey);
 f.hashes.add(digest(exchangeKey));rpcDenied(await anonDeviceRpc(f,"exchange",exchange,storedPair.rows[0].proof_hash));rpcGood(await anonDeviceRpc(f,"exchange",exchange,directPair.proof));directPair.credential=exchangeKey;
 const storedCredential=await f.stack.db.query("select d.id,c.hash from device_binding_private.pairings p join device_binding_private.devices d on d.id=p.device_id join device_binding_private.credentials c on c.hash=d.current_hash where p.id=$1 and p.code_hash=$2 and p.proof_hash=$3",[directPair.pairingId,directPair.codeHash,directPair.proofHash]);ensure(storedCredential.rowCount===1,"Direct credential regression must use the actual stored hash");directPair.deviceId=storedCredential.rows[0].id;
 rpcDenied(await anonDeviceRpc(f,"heartbeat",{},storedCredential.rows[0].hash));rpcGood(await anonDeviceRpc(f,"heartbeat",{},exchangeKey));
 const nextKey=secret(),rotation={operationId:randomUUID(),credentialHash:digest(nextKey)};
 f.hashes.add(digest(nextKey));rpcDenied(await anonDeviceRpc(f,"rotate",rotation,storedCredential.rows[0].hash));rpcGood(await anonDeviceRpc(f,"rotate",rotation,exchangeKey));
 rpcDenied(await anonDeviceRpc(f,"rotate",rotation,storedCredential.rows[0].hash));rpcGood(await anonDeviceRpc(f,"rotate",rotation,exchangeKey));rpcDenied(await anonDeviceRpc(f,"heartbeat",{},exchangeKey));rpcDenied(await anonDeviceRpc(f,"heartbeat",{},digest(nextKey)));rpcGood(await anonDeviceRpc(f,"heartbeat",{},nextKey));
 const p=await f.connected(owner,scope,"boundary");const cookieOnly=await f.request("heartbeat",{},undefined,{Cookie:owner.web.cookieHeader()});denied(cookieOnly,401);
 connectorHeaders(cookieOnly);
 const bearerOnly=await f.request("heartbeat",{},p.credential,{Cookie:owner.web.cookieHeader(),Origin:"https://other.invalid"});good(bearerOnly);connectorHeaders(bearerOnly);
 const human=await fetch(`${f.stack.config.app}/api/connections/revoke`,{method:"POST",headers:{Authorization:`Bearer ${p.credential}`,Origin:f.stack.config.app,"Content-Type":"application/json"},body:JSON.stringify({deviceId:p.deviceId})});ensure(human.status===401,"Bearer cannot authorize human mutation");
 const access=await fetch(`${f.stack.config.app}/api/access/invite`,{method:"POST",headers:{Authorization:`Bearer ${p.credential}`,Origin:f.stack.config.app,"Content-Type":"application/json"},body:JSON.stringify({roomId:scope.roomId,role:"observer"})});ensure(access.status===401,"Bearer cannot authorize existing access RPC caller");
 const csrf=await owner.web.post("/api/connections/revoke",{deviceId:p.deviceId},{Origin:"https://other.invalid"});ensure(csrf.status===403,"Human origin must be exact");
 const missingOrigin=await owner.web.post("/api/connections/revoke",{deviceId:p.deviceId},{Origin:""});ensure(missingOrigin.status===403,"Human origin must be present");
 const largeHuman=await owner.web.post("/api/connections/revoke",{deviceId:p.deviceId,text:"x".repeat(17000)});ensure(largeHuman.status===400,"Human body must retain the 16KiB limit");
 denied(await f.request("unknown",{},p.credential),404);denied(await f.request("heartbeat",{roomId:scope.roomId},p.credential),400);denied(await f.request("heartbeat",{text:"x".repeat(17000)},p.credential),400);
 const invalidType=await f.request("heartbeat",{},p.credential,{"Content-Type":"text/plain"});denied(invalidType,400);connectorHeaders(invalidType);
 const direct=await fetch(`${f.stack.config.api}/rest/v1/rpc/access_invite`,{method:"POST",headers:{apikey:f.stack.config.key,"Content-Type":"application/json"},body:JSON.stringify({p_room_id:scope.roomId,p_role:"observer"})});ensure(!direct.ok,"Anon device caller cannot execute human access RPC");
 const r=await f.request("heartbeat",{},p.credential);good(r);connectorHeaders(r);
}));
test("should commit connection audits with successful state changes",()=>deviceCase("audit",async f=>{
 const {owner,scope}=await setup(f);const p=await f.connected(owner,scope,"audit");await f.register(p);const before=await f.stack.db.query("select count(*)::int n from device_binding_private.connection_audit where organization_id=$1",[scope.organizationId]);ensure(before.rows[0].n===4,"Approve exchange workspace and agent must commit audits");
 denied(await f.request("agent",{operationId:randomUUID(),workspaceId:randomUUID(),sessionAlias:"bad",runtime:"codex"},p.credential),404);await f.cli(p.name,"rotate");await f.refresh(p);good(await f.human(owner,"revoke",{deviceId:p.deviceId}));const rows=await f.stack.db.query("select action,actor_user_id,actor_kind,device_id from device_binding_private.connection_audit where organization_id=$1",[scope.organizationId]);ensure(rows.rowCount===6&&rows.rows.every(r=>r.actor_user_id===owner.id),"Failed requests cannot commit successful audit");ensure(rows.rows.filter(r=>r.actor_kind==="human").length===2,"Audit actor kind must distinguish human approval and revocation");
}));
test("should preserve registered state without claiming runtime readiness",()=>deviceCase("state",async f=>{
 const {owner,scope}=await setup(f);const p=await f.connected(owner,scope,"state");await f.register(p);const first=await f.cli(p.name,"status");ensure(first.state==="registered"&&first.verification==="unverified","CLI restart must report registered and unverified");const beat=await f.cli(p.name,"heartbeat");ensure(beat.verification==="unverified","Heartbeat cannot verify provider readiness");const second=await f.cli(p.name,"status");ensure(JSON.stringify(first.bindings)!=="[]"&&second.verification==="unverified","Restart must restore private mapping");const privateFile=await readFile(join(f.root,"state",`${p.name}.json`),"utf8");ensure(privateFile.includes("private-native-state"),"Native locator must be restored only from private state");denied(await f.request("begin",{codeHash:digest(secret()),proofHash:digest(secret()),deviceAlias:"unsupported",protocol:2}),400);good(await f.human(owner,"revoke",{deviceId:p.deviceId}));ensure((await f.cli(p.name,"status")).state==="disconnected","Revoked connector must require fresh approval");
}));
test("should refuse device fixture setup and cleanup outside the owned stack",async()=>{
 const owned:StackConfig={workdir:"/owned-synthetic-workdir",project:"ai-collab-txxcvm61",api:"http://127.0.0.1:56321",db:"postgresql://fixture@127.0.0.1:56322/postgres",mail:"http://127.0.0.1:56324",app:"http://127.0.0.1:4318",key:"synthetic",adminKey:"synthetic"};let effects=0;
 for(const alteration of [{project:"other"},{api:"https://remote.invalid"},{db:"postgresql://fixture@remote.invalid:5432/postgres"}]){let rejected=false;try{assertOwnedConfig({...owned,...alteration});effects++;}catch{rejected=true;}ensure(rejected,"Wrong fixture config must fail before effects");let openRejected=false;try{await LocalAccessStack.open("refused",{...owned,...alteration});}catch{openRejected=true;}ensure(openRejected,"Unowned stack must not open");}
 ensure(effects===0,"Unowned configs must cause zero side effects");const env=productEnvironment({PATH:"synthetic",LOCAL_ACCESS_ADMIN_KEY:"synthetic-admin",LOCAL_ACCESS_DB_URL:"synthetic-db",LOCAL_ACCESS_SIGNING_JWK:"synthetic-jwk"});ensure(Object.keys(env).length===1,"CLI child must not inherit fixture credentials");
 await deviceCase("cleanup",async f=>{
  const p=await f.pair("anonymous");await f.verifyPairing(p);ensure(f.profiles.size===1&&!p.organizationId,"Anonymous fixture pairing must be tracked before approval");
  const control=await f.pair("cleanup-control");
  await cleanupIdentity(f);
  const normalOwner=await f.stack.person("cleanup-normal"),normalScope=await f.stack.bootstrap(normalOwner);const normal=await f.connected(normalOwner,normalScope,"cleanup-normal");await f.register(normal);
  const owner=await f.stack.person("cleanup-owner"),scope=await f.stack.bootstrap(owner);
  const removed=await f.connected(owner,scope,"cleanup-device");await f.register(removed);
  await f.cleanupPairing(removed.name);
  const deviceRows=await f.stack.db.query("select (select count(*)::int from device_binding_private.devices where id=$1) devices,(select count(*)::int from device_binding_private.credentials where device_id=$1) credentials,(select count(*)::int from device_binding_private.workspaces where id=$2) workspaces,(select count(*)::int from device_binding_private.agents where id=$3) agents",[removed.deviceId,removed.workspaceId,removed.agentId]);ensure(Object.values(deviceRows.rows[0]).every(count=>count===0),"Fixture device cleanup must cascade registered bindings and credentials");
  denied(await f.request("heartbeat",{},removed.credential),401);rpcDenied(await anonDeviceRpc(f,"heartbeat",{},removed.credential!));good(await f.request("heartbeat",{},normal.credential));rpcGood(await anonDeviceRpc(f,"heartbeat",{},normal.credential!));await f.verifyPairing(control);
  const organizationDevice=await f.connected(owner,scope,"cleanup-organization");await f.register(organizationDevice);const historical=organizationDevice.credential!;
  await f.cli(organizationDevice.name,"rotate");await f.refresh(organizationDevice);
  good(await f.request("replace",{operationId:randomUUID(),agentId:organizationDevice.agentId,expectedEpoch:1,repositoryAlias:"정리 저장소",branch:"main",commit:"unknown",dirty:"unknown",sessionAlias:"정리 세션",runtime:"codex"},organizationDevice.credential));
  const receipts=await f.stack.db.query("select w.registration_credential_hash workspace,a.registration_credential_hash agent,a.replacement_credential_hash replacement from device_binding_private.workspaces w join device_binding_private.agents a on a.workspace_id=w.id where a.id=$1 and a.device_id=$2",[organizationDevice.agentId,organizationDevice.deviceId]);ensure(receipts.rowCount===1&&receipts.rows[0].workspace===digest(historical)&&receipts.rows[0].agent===digest(historical)&&receipts.rows[0].replacement===digest(organizationDevice.credential!),"Cascade regression must populate all three receipt credential references");
  let historicalDeleteStarted=false,historicalDeleteRejected=false;
  await f.stack.db.query("begin");
  try {
   await f.stack.db.query("delete from device_binding_private.credentials where device_id=$1 and hash=$2",[organizationDevice.deviceId,digest(historical)]);historicalDeleteStarted=true;
   await f.stack.db.query("set constraints all immediate");
  }catch(error){historicalDeleteRejected=(error as {code?:string}).code==="23503";}finally{await f.stack.db.query("rollback");}
  ensure(historicalDeleteStarted&&historicalDeleteRejected,"Historical credential deletion must remain NO ACTION and be rejected at the deferred check");
  const stillRegistered=await f.stack.db.query("select id from device_binding_private.agents where id=$1 and device_id=$2",[organizationDevice.agentId,organizationDevice.deviceId]);ensure(stillRegistered.rowCount===1,"Rejecting historical credential deletion must preserve the registered binding");
  await f.saveCleanupIdentity();await cleanupIdentity(f);
  const deleted=await f.stack.db.query("delete from public.organizations where id=$1 and owner_user_id=$2 returning id",[scope.organizationId,owner.id]);ensure(deleted.rowCount===1,"Physical organization cleanup must target only the exact owned organization");
  const organizationRows=await f.stack.db.query("select (select count(*)::int from device_binding_private.devices where organization_id=$1) devices,(select count(*)::int from device_binding_private.credentials where organization_id=$1) credentials,(select count(*)::int from device_binding_private.workspaces where organization_id=$1) workspaces,(select count(*)::int from device_binding_private.agents where organization_id=$1) agents",[scope.organizationId]);ensure(Object.values(organizationRows.rows[0]).every(count=>count===0),"Physical organization cleanup must cascade every registered device tuple");
  denied(await f.request("heartbeat",{},organizationDevice.credential),401);rpcDenied(await anonDeviceRpc(f,"heartbeat",{},organizationDevice.credential!));good(await f.request("heartbeat",{},normal.credential));rpcGood(await anonDeviceRpc(f,"heartbeat",{},normal.credential!));await f.verifyPairing(control);
  const normalBindings=await normalOwner.web.dataClient().rpc("connection_room_bindings",{p_room_id:normalScope.roomId});ensure(!normalBindings.error&&normalBindings.data.some((entry:{agentId:string})=>entry.agentId===normal.agentId),"Deleting another registered organization must preserve the normal owner's public binding");
  await f.cleanupPairing(organizationDevice.name);
  for(const [name,fault,api] of [
   ["lost-api","response-lost",true],
   ["failed-cli","cli-response-invalid",false],
   ["lost-cli","response-lost",false],
   ["lost-stdout","stdout-lost",false],
   ["state-validation","state-validation",false],
  ] as const) {
   let tracked:DeviceProfile|undefined;
   await deviceCase(`cleanup-${name}`,async failedFixture=>{
    let failed=false;try{if(api)await failedFixture.apiPair(name,{fault});else await failedFixture.pair(name,{fault});}catch{failed=true;}ensure(failed,"Injected post-begin failure must surface instead of masking actual verification");
    tracked=failedFixture.profiles.get(name);ensure(tracked&&failedFixture.pairingIntents.has(name),"Failed anonymous begin must retain its pre-recorded profile intent and exact recovered identity");await failedFixture.verifyPairing(tracked);
    ensure(failedFixture.hashes.has(tracked.codeHash)&&failedFixture.hashes.has(tracked.proofHash),"Failed pairing cleanup must track both original hashes");
    await cleanupIdentity(failedFixture);
   });
   ensure(tracked,"Failed pairing identity must remain available for the exact cleanup assertion");
   const remaining=await f.stack.db.query("select (select count(*)::int from device_binding_private.pairings where id=$1 or (code_hash=$2 and proof_hash=$3)) pairing,(select count(*)::int from device_binding_private.secret_hashes where hash=any($4::text[])) hashes",[tracked.pairingId,tracked.codeHash,tracked.proofHash,[tracked.codeHash,tracked.proofHash]]);
   ensure(remaining.rows[0].pairing===0&&remaining.rows[0].hashes===0,"Fixture close must remove only its exact failed anonymous pairing and original secret hashes");await f.verifyPairing(control);good(await f.request("heartbeat",{},normal.credential));
  }
 });
});
