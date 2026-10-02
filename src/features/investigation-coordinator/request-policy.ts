import "server-only";
import { serverConfig } from "../../lib/supabase/server";
import { WorkflowError, validateBody, type Action } from "./contracts";
export async function readWorkflow(request:Request,action:Action,human:boolean) {
 if(human&&request.headers.get("origin")!==serverConfig().origin)throw new WorkflowError("UNSAFE_ORIGIN");
 if(request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="application/json")throw new WorkflowError("INVALID_BODY");
 const reader=request.body?.getReader();if(!reader)throw new WorkflowError("INVALID_BODY");let size=0;const parts:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw new WorkflowError("BODY_TOO_LARGE");}parts.push(value);}}finally{reader.releaseLock();}
 let input:unknown;try{input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts)));}catch{throw new WorkflowError("INVALID_BODY");}return validateBody(action,input);
}
export function workflowBearer(request:Request){const match=request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);if(!match)throw new WorkflowError("UNAUTHENTICATED");return match[1];}
