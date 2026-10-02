import {NextResponse} from "next/server";
import {deviceActions,WorkflowError,type DeviceAction} from "../../../../features/investigation-coordinator/contracts";
import {readWorkflow,workflowBearer} from "../../../../features/investigation-coordinator/request-policy";
import {deviceWorkflow,workflowFailure} from "../../../../features/investigation-coordinator/service";
export const runtime="nodejs";
export async function POST(request:Request,context:{params:Promise<{action:string}>}){let body:unknown,status=200;try{const {action}=await context.params;if(!deviceActions.includes(action as DeviceAction))throw new WorkflowError("NOT_FOUND");const secret=workflowBearer(request);body={ok:true,data:await deviceWorkflow(action as DeviceAction,await readWorkflow(request,action as DeviceAction,false),secret)};}catch(error){const failure=workflowFailure(error);body=failure.body;status=failure.status;}return NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store, max-age=0",Pragma:"no-cache",Expires:"0",Vary:"Authorization"}});}
