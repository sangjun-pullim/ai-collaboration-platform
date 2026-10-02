import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { deviceClient } from "../../src/features/device-binding/device-client.ts";
import { ConnectionError } from "../../src/features/device-binding/contracts.ts";

test("should reject unsafe device upstreams before sending authentication input",async()=>{
  let calls=0;const redirects:RequestInit["redirect"][]=[];
  const fetchMock=mock.method(globalThis,"fetch",async(_input:unknown,init?:RequestInit)=>{
    calls++;redirects.push(init?.redirect);
    return Response.json({protocol:1});
  });
  const call=async(url:string)=>{
    const client=deviceClient(url,"sb_publishable_synthetic");
    const result=await client.rpc("connector_heartbeat",{p_body:{},p_secret:"a".repeat(64)});
    assert.equal(result.error,null);
  };
  try {
    for(const url of ["http://remote.invalid","http://127.0.0.1.remote.invalid","http://127.1:56321","http://2130706433:56321","http://localhost.remote.invalid","https://user:pass@secure.invalid","https://secure.invalid/?token=synthetic","https://secure.invalid/#synthetic","file:///synthetic","malformed"]){
      await assert.rejects(()=>call(url),(error:unknown)=>error instanceof ConnectionError&&error.code==="UNAVAILABLE");
      assert.equal(calls,0);
    }
    for(const url of ["http://127.0.0.1:56321","http://[::1]:56321","http://localhost:56321","https://secure.invalid","https://secure.invalid/"])await call(url);
    assert.equal(calls,5);
    assert.deepEqual(redirects,Array.from({length:5},()=>"error"));
  } finally {fetchMock.mock.restore();}
});
