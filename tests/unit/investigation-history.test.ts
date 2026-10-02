import {test} from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";
import {emptyHistory,mergeHistory} from "../../src/features/investigation-coordinator/history-state.ts";import type {HistoryPage,PublicEvent} from "../../src/features/investigation-coordinator/contracts.ts";
import {pollingDelay} from "../../src/features/investigation-coordinator/polling-policy.ts";
test("should merge durable history without leaking state across rooms",()=>{
 assert.equal(pollingDelay(true,false,0),2000);assert.equal(pollingDelay(false,false,0),10000);assert.equal(pollingDelay(true,true,0),30000);assert.equal(pollingDelay(true,false,1),20000);assert.equal(pollingDelay(true,false,1000),30000);
 const fixture=JSON.parse(readFileSync("tests/fixtures/workflow-contracts.json","utf8"));const page={...fixture.cases[0].response,runs:[]} as HistoryPage;const event=page.events[0];const third={...event,eventId:"00000000-0000-4000-8000-000000000033",sequence:3};let state=mergeHistory(emptyHistory(page.roomId),{...page,events:[third],nextCursor:3,highWaterSequence:3});assert.equal(state.cursor,0);assert.equal(state.gap,true);
 const second={...event,eventId:"00000000-0000-4000-8000-000000000022",sequence:2};state=mergeHistory(state,{...page,events:[second,event],nextCursor:2,highWaterSequence:3});assert.equal(state.cursor,3);state=mergeHistory(state,page);assert.equal(state.events.length,3);assert.deepEqual(state.events.map(e=>e.sequence),[1,2,3]);
 const runEvents:PublicEvent[]=Array.from({length:40},(_,i)=>({...event,eventId:`00000000-0000-4000-8000-${String(i+100).padStart(12,"0")}`,sequence:i+4,kind:"RUN_STATE",publicText:"",cycleId:page.cycle!.cycleId,requestId:`00000000-0000-4000-8000-${String(i+200).padStart(12,"0")}`,agentId:page.bindings[0].agentId,bindingEpoch:1,requestKind:"ORIGIN",runState:"COMPLETED",terminal:"COMPLETED"}));state=mergeHistory(state,{...page,events:runEvents,runs:[],nextCursor:43,highWaterSequence:43});assert.equal(state.runs.length,40);assert.equal(state.cursor,43);assert.equal(state.events.some(e=>e.publicText==="pending local text"),false);
 // A delayed page may add events, but must never roll current runs back.
 const currentRun=fixture.cases[0].response.runs[0];const runningPage={...page,events:[],runs:[{...currentRun,state:"RUNNING" as const}],nextCursor:state.cursor,highWaterSequence:44};
 state=mergeHistory(state,runningPage);const latestSnapshot=state.snapshot;
 state=mergeHistory(state,{...page,events:[],runs:[{...currentRun,state:"QUEUED" as const}],nextCursor:1,highWaterSequence:1});
 assert.equal(state.snapshot,latestSnapshot);assert.equal(state.runs.find(r=>r.requestId===currentRun.requestId)?.state,"RUNNING");
 state=mergeHistory(state,{...runningPage,runs:[],highWaterSequence:45});
 assert.equal(state.runs.some(r=>r.requestId===currentRun.requestId),false);
 const current={...page,events:[...runEvents.slice(-1)],runs:[],nextCursor:43,highWaterSequence:43};
 state=mergeHistory(emptyHistory(page.roomId),current);
 const old={...page,events:[],runs:[{requestId:runEvents[39].requestId!,cycleId:page.cycle!.cycleId,agentId:page.bindings[0].agentId,ownerAlias:"공개 소유자",sessionAlias:"공개 세션",requestKind:"ORIGIN" as const,roomRevision:1,bindingEpoch:1,state:"RUNNING" as const,questionId:null,createdAt:event.createdAt,updatedAt:event.createdAt}],nextCursor:1,highWaterSequence:1};
 state=mergeHistory(state,old);
 assert.equal(state.snapshot?.highWaterSequence,43);
 assert.equal(state.runs.find(r=>r.requestId===runEvents[39].requestId)?.state,"COMPLETED");
 const other="00000000-0000-4000-8000-000000009999";state=mergeHistory(state,{...page,roomId:other,events:[],runs:[],cycle:null,nextCursor:0,highWaterSequence:0});assert.equal(state.roomId,other);assert.equal(state.events.length,0);assert.equal(state.runs.length,0);assert.equal(state.cursor,0);
});
