import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deviceClient } from "../device-binding/device-client";
import { serverConfig } from "../../lib/supabase/server";
import { WorkflowError,errorStatus,projectResponse,type Body,type HumanAction,type DeviceAction } from "./contracts";
async function rpc(client:SupabaseClient,name:string,params:Record<string,unknown>){const {data,error}=await client.rpc(name,params);if(error)throw new WorkflowError(error.code==="P0001"&&Object.hasOwn(errorStatus,error.message)?error.message as keyof typeof errorStatus:"UNAVAILABLE");return data;}
export async function humanWorkflow(client:SupabaseClient,action:HumanAction,body:Body){const {data:{user},error}=await client.auth.getUser();if(error||!user)throw new WorkflowError("UNAUTHENTICATED");return projectResponse(action,await rpc(client,`workflow_human_${action}`,{p_body:body}));}
export async function deviceWorkflow(action:DeviceAction,body:Body,secret:string){const {url,key}=serverConfig();return projectResponse(action,await rpc(deviceClient(url,key),`workflow_device_${action.replaceAll("-","_")}`,{p_body:body,p_secret:secret}));}
export function workflowFailure(error:unknown){const code=error instanceof WorkflowError?error.code:"UNAVAILABLE";return {body:{ok:false,error:{code}},status:errorStatus[code]};}
