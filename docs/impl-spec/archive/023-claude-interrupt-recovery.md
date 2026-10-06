---
status: done
date: 2026-10-06
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code. The original 022 implementation review remains REVISE until the corrective implementation is verified.

# Claude 중단 증거의 내구 저장과 같은 입력 복구

## Context

[022](../022-owner-local-ai-setup.md#구현-리뷰-3과-후속-보정)의 최종 구현 리뷰에서 HIGH 1건을 확인했다. 도구 없이 스트리밍 중단한 입력은 live에서 INTERRUPTED지만 종결 저장 전 장애로 UNKNOWN이 되면 같은 이력이 FAILED로 복구된다. 중단 의도가 메모리에만 있고 관찰에는 도구 취소 증거만 전달되기 때문이다. 독립 리뷰가 순수 메모리 2회로 재현했다.

022의 구현 리뷰 3회는 REVISE로 종료했고 소스를 동결한 기록을 보존한다. 이 문서는 기존 전체 목표의 구현 위임과 계속 진행 지시에 따른 국소 후속 보정이다. 기존 022의 범위·성공 기준을 축소하거나 대체하지 않는다. 기존 승인은 같은 작업의 보정에 계속 적용하며 이 계획은 추가 native 입력, 개인 설정 변경, Docker/Git 제한 우회의 허가가 아니다. 022의 원래 HIGH는 실제 보정·검사·독립 구현 리뷰가 끝나기 전에는 해소로 표시하지 않는다.

완료 기준은 도구 없는 중단·종결 저장 실패·새 실행기에서의 복구가 같은 입력의 INTERRUPTED를 유지하고, 증거 없는 typed 중단은 UNKNOWN으로 남는 것이다. 정상 COMPLETED와 기존 held-tool 취소, Codex v1 기록·outbox를 보존한다. 새 native 사용자 입력·새 세션·다른 이력 탐색으로 복구하지 않는다.

## Affected Files

1. `packages/local-connector/src/runtime-contracts.ts` — 전체 NativeInputIntent와 결합한 내구 중단 의도·bounded receipt 관찰 타입, optional authority 저장 접점과 attempt/terminal/closed input/observation 전달 계약.
2. `packages/local-connector/src/runtime-store.ts` — Claude v2에만 새 optional 증거를 허용하고 exact scope·generation·attempt/fence·native input·policy 결합과 불변성을 검증한다.
3. `packages/local-connector/src/workflow-runner.ts` — 중단 저장 authority, 일반 용량/종결 예약, 종료 중 소유 저장, terminal 및 closed proof 복사, UNKNOWN 관찰 전달.
4. `packages/local-connector/src/claude/adapter.ts` — native interrupt 전에 의도 저장 완료를 기다리고 같은 활성 입력의 중복 호출을 합친다. receipt와 terminal의 경합을 보존한다.
5. `packages/local-connector/src/claude/input-proof.ts` — receipt 검증을 bounded 증거 생성과 분리하고 증거 없는 aborted_tools/aborted_streaming이 일반 FAILED로 내려가지 않게 한다. I/O는 추가하지 않는다.
6. `packages/local-connector/src/claude/history-proof.ts` — exact candidate 및 닫힌 입력 증거로 중단 의도를 복원한다. 기존 cancellation 검증은 독립적으로 유지한다.
7. `packages/local-connector/tests/{claude-adapter,claude-runner-intent,provider-runtime-store}.test.ts` — 아래 실패·재시작·위조·경합 검사를 기존 fixture로 추가한다.
8. 관련 정본 문서 `docs/ARCHITECTURE.md`, `docs/BUSINESS-LOGIC.md`, 진행 정본과 022 Review Notes — 실제 검증 결과와 기존 미완료 수용을 구분한다.

## Affected Dependents

- `claude/transport.ts:195–216,263–289`는 control request ID로 응답을 대조한 뒤 body를 반환한다. transport API와 wire 형식은 유지한다. native request ID 영구 저장을 전제하지 않고 host의 전체 입력 descriptor로 저장 증거를 결합한다.
- `codex-adapter.ts`와 기존 합성 adapter의 authority 소비는 새 optional 접점을 사용하지 않는다. Codex의 interrupt·ACK 기반 관찰과 v1 decoder를 유지한다.
- `settings/manager.ts`의 current/retained RuntimeStore 읽기와 unresolved 판정, `cli/runtime-context.ts`와 `cli/runtime-command.ts`의 관찰·실행 호출 형태를 유지한다.
- adapter `validate()`는 candidate 없이 전체 닫힌 이력을 검증한다. attempt 저널만 수정해서는 부족하며 ownedTurns에 불변 중단 증거를 복사해야 한다.
- 중앙 workflow의 `interrupt-ack`, lease, complete/observe body와 서버 receipt는 변경하지 않는다. 로컬 native 증거와 서버 중단 요청 전달을 혼동하지 않는다.
- `tests/integration/claude-product-runtime.test.ts`와 전체 connector/웹 계약 검사는 타입과 종결 증거의 소비자다. 실제 DB/native 실행은 이 계획의 합성 검증이 대신하지 않는다.

## Correction Contract

저널·terminal·닫힌 입력·관찰에는 같은 optional `nativeInterruption`을 사용한다. 전체 descriptor를 함께 보관하므로 attempt가 archive로 이동해 candidate가 없어도 닫힌 이력에서 원문을 읽을 수 있다.

```ts
interface NativeInterruptionReceipt {
  stillQueued: [];
  cancelled: string[]; // Zero or one exact current input ID.
  responseHash: string;
}
interface NativeInterruption {
  intent: NativeInputIntent;
  intentHash: string;
  requestHash: string;
  receipt?: NativeInterruptionReceipt;
}
// SAVED confirms completed durable storage. CLOSED skips a late update without claiming storage.
interruption?(proof: NativeInterruption): Promise<"SAVED" | "CLOSED">;
```

`intentHash`는 보관한 전체 intent의 stableJson hash다. `requestHash`는 고정 `{subtype: "interrupt", cancel_queued: true}`의 stableJson hash다. receipt는 exact `still_queued`와 optional `cancelled`만 허용하고 빈 queue·중복 없는 최대 한 current input ID를 검증한다. 누락된 cancelled는 빈 배열로 정규화하며 `responseHash`는 정규화한 `{still_queued: [], cancelled: [...]}`의 hash다. request ID 상관관계는 기존 transport가 검증하고 host의 증거는 전체 intent로 그 응답을 현재 입력에 결합한다.

저널에서는 보관한 intent 원문/hash를 nativeIntent 전체·scope·generation·snapshot attempt/fence·native IDs·policy와 대조한다. 닫힌 입력에서는 intent의 session/input/prompt/generation/bindingEpoch/policy를 context와 turn에 대조하고 intent 전체/hash를 보존한다. 같은 turn의 attempt가 남아 있으면 그 증거와도 일치해야 한다. candidate가 존재하면 전체 intent와 nativeInterruption 모두 같아야 한다. 이 descriptor는 중앙이나 모델이 제공하는 권한 증거가 아니라 소유 authority가 이미 fsync한 로컬 기록이다.

authority callback은 기존 active 객체와의 동일성, lockHeld·retired, 현재 scope/epoch/generation, snapshot attempt/fence, nativeIntent 전체와 저장 가능 상태(PROVIDER_INTENT/ACKNOWLEDGED/RUNNING)를 매 호출/await 경계에서 확인한다. `storageCheck()`만으로 승인하지 않는다. admission 종료 후에도 이 소유 입력의 정리 증거만 저장할 수 있으며 일반 check/live/tool/transport guard를 열지 않는다. native control 전송에는 기존 `authority.assertLive()`와 transport guard가 계속 필요하다. 따라서 stop() 후 증거 저장은 가능하지만 새 입력·도구·control 전송은 차단되고 소유 child 정리는 기존 close 경로가 맡는다.

이미 terminal/UPLOADED인 exact 입력에는 새 증거를 추가하지 않고 CLOSED를 반환한다. 첫 저장의 CLOSED는 새 native control을 보내지 않는 결과다. late receipt의 CLOSED도 receipt를 fsync했다고 표시하지 않는다. 다른 authority/입력/증거의 요청은 CLOSED로 숨기지 않고 기존 오류로 거절한다.

## Implementation Steps

### [x] Step 1: 도구 없는 중단과 저장 유실의 실패 재현
**File**: 기존 Claude adapter/runner/store 검사

> VERIFIED: Node24 compile exit0. 대상 46개 PASS25/RED21, 기존 22개 전부 PASS. 실제 새 ClaudeAdapter+새 WorkflowRunner에서 같은 합성 이력의 FAILED 대 INTERRUPTED 기대값을 재현했다. 합성 stdin1회, 재관찰 추가 입력0회, 실제 공식 CLI 입력0회. 원본 RED 로그는 `/private/tmp/owner023-tests-red/`에 보존했다.

- 현재 합성 transport와 메모리 history의 실제형 init/user/assistant/result를 사용한다. 도구 없는 aborted_streaming을 live와 UNKNOWN 관찰에 같은 UUID/prompt/hash로 공급한다.
- 새 증거 없이 typed abort를 FAILED로 채택하는 현재 분기를 먼저 RED로 확인한다. 도구 없는 정상 중단의 종결 저장 실패와 새 runner/adapter 복구 기대도 준비한다.
- 기존 IntentAdapter의 결과 단순 반환만으로 history-proof의 오류가 해결됐다고 주장하지 않는다. 복구 검사는 실제 ClaudeAdapter 및 proveOwnedHistory 경로를 사용한다.

### [x] Step 2: 입력에 묶인 내구 중단 의도와 저장 검증
**File**: runtime-contracts.ts, runtime-store.ts, workflow-runner.ts의 authority 저장 접점

- Correction Contract의 원문·hash·callback 계약을 구현한다. session/input/prompt/generation/scope/attempt/fence/policy를 별개 boolean으로 대체하지 않는다. 요청은 고정 interrupt/cancel_queued 형식이며 그 canonical hash를 증거에 포함한다.
- receipt는 transport가 응답 ID를 대조한 후 input-proof가 검증한 bounded 구조와 hash로 기록한다. receipt만 존재하는 상태를 거부한다. receipt는 terminal 증거가 아니다.
- 새 optional 필드는 Claude v2에서만 허용한다. 기존 v1·과거 v2 바이트를 필수 필드 추가로 거부하지 않는다. 저장된 의도는 삭제/교체할 수 없고 receipt는 최대 한 번 추가하며 그 뒤 불변이다.
- 저장 authority는 Correction Contract의 전체 소유 검사를 수행하고 mutation을 fsync한다. 종료 중 증거 저장에만 좁은 guard를 쓰며 일반 실행 guard를 완화하지 않는다. SAVED는 fsync 성공을 반환한 경우만 가능하다. 새 일반 mutation은 종결 예약을 소비하지 않는다.
- 늦은 receipt는 이미 TERMINAL/UPLOADED 또는 닫힌 입력을 변경하지 않는다. 그 경우 native typed terminal과 사전에 내구 저장한 의도를 보존하고 receipt가 기록되지 않았음을 성공한 기록으로 꾸미지 않는다.

### [x] Step 3: native 전송 순서와 완료·receipt 경합
**File**: claude/adapter.ts, claude/input-proof.ts

- exact intent를 준비한 활성 입력에서 authority의 내구 중단 의도 저장을 먼저 기다린다. 저장 실패 시 native interrupt 0회이며 메모리 중단 승인도 만들지 않는다.
- terminal 수신 여부와 현재 시작된 중단 의도·receipt 저장 Promise를 active 입력에 기록한다. result는 proof를 seal하기 전에 수신 시점까지 시작된 저장만 기다린다. 의도 저장의 성공 처리에서 메모리 requestInterrupt와 증거를 먼저 반영한다. 실패하면 terminal을 승인하지 않고 UNKNOWN으로 남긴다. 이미 수신된 terminal 뒤에는 native interrupt나 receipt 저장을 새로 시작하지 않는다.
- 진행 중 receipt 저장이 있으면 그 저장 결과까지 기다려 terminal 증거와 저널을 일치시킨다. 미래 receipt/RPC 완료를 기다리지 않으며, terminal 도착 뒤 receipt 저장을 시작하지 않는다. 저장 중 terminal 수신의 성공·실패를 각각 검증한다.
- 같은 활성 입력의 반복 interrupt는 진행 중 Promise와 같은 내구 의도를 재사용한다. 새 native 사용자 입력이나 새 session을 만들지 않는다.
- 종료는 이미 시작한 소유 중단 저장만 기존 제한 시간으로 기다린다. 제한 뒤에는 해당 저장 대기와 guard를 닫아, 보류된 ACK 등 일반 mutation 뒤의 중단 저장이나 interruptOnStop이 종료를 막지 않게 한다. 늦게 풀린 mutation은 저장·control을 새로 수행하지 않는다. Codex의 기존 제한 시간 종료와 잠금 반환을 보존한다.
- 의도 저장 뒤 메모리 proof에 중단 요청을 기록하고 고정 native control을 전송한다. 검증된 receipt가 terminal보다 먼저 오면 저장 완료 후 중단 요청 전달 성공을 반환한다. receipt가 먼저 왔다는 사실만으로 INTERRUPTED를 만들지 않는다.
- terminal이 receipt보다 먼저 오면 의도 저장과 typed terminal만으로 정상 중단을 닫을 수 있다. terminal이 receipt 저장을 무조건 기다리는 의존성은 만들지 않는다. late receipt는 닫힌 객체를 덧붙여 수정하지 않는다.
- 정상 success는 항상 COMPLETED가 우선이다. 실패한 receipt나 저장된 중단 의도로 정상 완료를 뒤집지 않는다. 종결이 없거나 cleanup/권한/내구 저장이 미확인이면 기존 UNKNOWN 또는 명시적 실패 경계를 유지한다.
- input-proof의 일반 FAILED 분기에서 aborted_tools/aborted_streaming을 제외한다. exact 중단 의도나 기존 닫힌 INTERRUPTED/검증된 도구 취소 근거가 없으면 UNKNOWN이다. 일반 native 오류의 FAILED 판정은 유지한다.

### [x] Step 4: UNKNOWN 관찰과 닫힌 전체 이력에 같은 증거 전달
**File**: workflow-runner.ts, claude/history-proof.ts, runtime-store.ts

- UNKNOWN 관찰은 저널의 immutable NativeInputIntent 및 중단 의도/receipt를 exact session/input ID와 함께 전달한다. descriptor가 없거나 다른 입력과 결합한 증거를 채택하지 않는다.
- terminal과 ownedTurns에는 같은 중단 의도를 복사하고 저널과 hash/identity를 대조한다. candidate 없는 validate()도 같은 닫힌 입력 증거를 읽는다.
- candidate가 이미 닫힌 입력을 가리키면 기존 prompt/결과/도구/중단 증거와 일치해야 한다. candidate로 닫힌 이력의 증거를 교체하거나 종결을 재판정하지 않는다.
- 과거 v2 닫힌 INTERRUPTED와 내구 held-tool 취소 증거의 기존 복원은 보존한다. aborted_tools의 미응답 도구는 여전히 각각 exact cancellation이 필요하며 streaming 중단 의도가 이를 대신하지 않는다.
- 관찰은 읽기 전용 owned full history에 한정하고 새 provider execute/stdin/control은 0회다. 복구한 결과는 기존 같은 complete/observe operation과 단일 답변 계약으로만 업로드한다.

### [x] Step 5: 필수 검사·독립 리뷰와 원래 미해결 기록 정리
**File**: tests와 위 관련 docs

> VERIFIED: 대상47/47·전체 connector410/410·root unit207/207·기존 Codex 보류 ACK1/1과 Node24 compile·application/integration/E2E 타입·lint 경고0·format/check·diff 검사를 통과했다. 새 독립 구현 리뷰2 PASS C0/H0/M0/L0/INFO2, 검토 입력23개·원래022 재사용53개·봉인 로그10개의 SHA가 일치한다. 원래022 HIGH 및 보정 중 드러난 종료 회귀를 RESOLVED 처리했다. 실제 공식 CLI/DB/HTTP/browser/Mac 창/두 Mac/Git 검증은 포함하지 않는다.

- 아래 Tests 및 Verification을 완료한다. 같은 코드·입력의 root unit와 웹 build 결과는 재사용하고, 변경된 connector/proof/store 및 shared type 소비 검사는 새로 실행한다.
- 새 독립 reviewer는 이 국소 diff와 영향받은 authority·저장·종결·history 호출부를 검토한다. 022의 변경 없는 파일 검토는 hash 일치 범위에서만 재사용하며 원래 3차 REVISE를 PASS로 바꾸지 않는다.
- 국소 보정의 필수 검사·독립 리뷰가 통과하면 022의 원래 HIGH를 실제 증거로 RESOLVED 처리한다. 022의 SQL010/upgrade/Auth HTTP/browser/Mac picker/공식 Claude/두 Mac/Git 작업 미완료는 유지한다.
- 모든 단계·검사·독립 리뷰가 완료한 경우에만 023을 보관한다. 권한상 Git metadata 쓰기가 불가능하면 작업 트리의 문서 보관과 실제 Git 커밋/PR 미완료를 구분한다. main 병합은 사용자의 별도 요청이다.

## Tests

- `claude-adapter.test.ts`: should retain UNKNOWN for a typed streaming abort without durable interruption evidence; should recover a tool-free interrupted input from its exact durable intent; should validate the recovered closed history without a candidate and after attempt archive; should persist interruption intent before native control and send no control after storage failure; should coalesce repeated interruption calls; should await only already started intent or receipt storage before sealing a received terminal for both successful and failed storage; should preserve terminal-before-receipt and receipt-before-terminal; should preserve COMPLETED racing failed interruption receipt; should reject foreign or changed evidence.
- `claude-runner-intent.test.ts`: should persist exact interruption intent before sending control; should keep UNKNOWN after terminal storage loss and recover INTERRUPTED with a new runner and new real ClaudeAdapter using the same synthetic history; should send no new native input during recovery; should preserve late receipt and uploaded/closed immutability; should save only owned interruption evidence after stop while sending no new input/tool/control; should reject save after lost authority or retirement; should close queued interruption storage after stopping a Claude input with a held native ACK. Logical beforeMutation failure and actual FileHandle.sync failure are separate tests/evidence.
- `provider-runtime-store.test.ts`: should preserve v1 bytes and reject interruption fields in v1; should reject receipt without intent, foreign intent hash/request hash and wrong queue/input identity; should reject deletion/replacement of saved intent or receipt; should permit one receipt append before terminal; should preserve past v2 closed INTERRUPTED records and held-tool cancellations.
- Existing adapter/runner/store/connector tests: unchanged held read cancellation, all outstanding tool evidence, ordinary FAILED, Codex v1/history/outbox, ordinary capacity and terminal reserve.

## Risks

- intent-only evidence is not a native terminal. Match exact owned history and typed result before adopting INTERRUPTED.
- receipt-after-terminal may be normal. Do not make terminal depend on future receipt or mutate an immutable closed/UPLOADED record.
- receipt validation currently mutates a memory boolean. Separate bounded validation/data from I/O and preserve COMPLETED precedence.
- stop() closes admission before interrupt. Preserve the existing owned shutdown mutation authority instead of reopening ordinary callbacks.
- fsync failure may leave new readable bytes. Never treat a re-read as confirmation that a failed sync succeeded; explicitly test durable success before control.

## Verification

- Node24 `tsc -p packages/local-connector/tsconfig.json`; run the three targeted compiled connector test files, then the full existing connector test suite. A compile failure stops downstream execution.
- Node24 compile `tsconfig.integration.json` and `tsconfig.e2e.json`, application typecheck, lint and format:check. Run format before recording the final review inventory.
- Reuse root unit207/web build only while their runtime inputs are unchanged. Document every reused input hash and rerun affected checks when changes invalidate it.
- Pure memory/fake transport and owned temporary fixture only. Official Claude/Codex, Docker/SQL migration, actual HTTP/browser/native picker and personal configuration access are outside this correction execution.
- Fresh independent plan review before implementation and fresh independent implementation review of the correction. Preserve full original 022/009 unfinished acceptance and the original review history.
- Relative doc links and git diff --check; no Git writes or permission bypass.

## Review Notes

The original 022 source finding is ACCEPTED and remains unresolved until Step5 obtains implementation evidence. This new plan's review evaluates the proposed correction, not whether the current faulty source is complete.

계획 리뷰 1: REVISE, C0/H3/M0/L0/INFO2. 아래 세 보정을 적용했다. 계획 리뷰 2: PASS, C0/H0/M0/L0/INFO2. 검토 전후 12개 입력 hash가 모두 일치하며 새 실행·소스 변경 없이 타입·저장 경합·소유 종료 경계를 검증했다. 기존 승인된 022의 보정으로 구현을 이어간다. 원래 소스 HIGH와 실제 수용 미완료는 유지한다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan1: intent fsync and already-started receipt storage racing terminal | HIGH | ACCEPTED | Step3 records terminal receipt and current storage Promises, waits before seal only for stores already started at receipt, applies memory intent after durable success, and adds success/failure regressions. Future RPC/receipt is never a terminal dependency. |
| Plan1: closed proof lacks reconstructable full intent and explicit callback result | HIGH | ACCEPTED | Correction Contract stores NativeInputIntent plus canonical intent/request hashes and bounded normalized receipt in journal/terminal/ownedTurns/observation, specifies SAVED/CLOSED and full comparison after archive without a candidate. |
| Plan1: stop closes ordinary guard before owned interruption save | HIGH | ACCEPTED | Correction Contract specifies an exact active-authority/lock/scope/generation/attempt/fence/native-intent/state storage guard. Admission-close permits only owned evidence save; ordinary input/tool/transport guards remain closed. Lost ownership/retirement/late evidence are separate regressions. |

구현 리뷰1: REVISE C0/H1/M0/L0/INFO2. 원래 중단 복구 오류의 핵심 보정은 확인했으나 종료 대기가 기존 Codex 보류 ACK를 무한히 기다리는 회귀를 확인했다. 원본 전체 검사 중단 로그를 보존했다. 소유 중단 저장만 제한 시간으로 기다리고 이후 그 대기·guard를 닫도록 보정한다. 추가 Claude 보류 ACK 검사는 먼저 1/1 RED(`SYNTHETIC_shutdown_timeout`)로 확인했다. 후속 검사·새 독립 리뷰를 진행 중이며 원래022 HIGH는 아직 RESOLVED로 바꾸지 않는다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Implementation1: unconditional journal drain and queued interruption shutdown wait | HIGH | ACCEPTED | Track only owned interruption writes, bound that drain, then close its waiter and guard. Keep legacy Codex bounded shutdown and verify both existing Codex and new Claude held-ACK regressions before the full connector suite and fresh review. |

구현 리뷰2: PASS C0/H0/M0/L0/INFO2. 제한된 중단 저장 대기와 종료 후 waiter/guard 폐쇄, 기존 Codex와 새 Claude 보류 ACK의 종료·늦은 쓰기 거절을 확인했다. 대상47/47·전체410/410·root207/207 및 모든 필수 정적 검사를 통과했다. 첫 전체 검사 중단과 새 Claude held-ACK RED의 원본 로그는 보존했다. 변경 없는 웹 build와 원래022 소스53개 검토는 hash 일치 범위로 재사용했다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Implementation1: owned interruption shutdown wait | HIGH | RESOLVED | New Claude held-ACK RED→GREEN, legacy Codex held-ACK1/1 and full connector410/410 passed. Fresh review2 confirmed bounded owned-write drain, waiter/guard closure and no late durable byte change. |

모든023 단계·검사·독립 리뷰를 마쳐 작업 트리에서 명세를 보관했다. Git metadata 쓰기 권한이 없어 실제 커밋·push·PR 갱신은 수행하지 않았다. 원래022의 native 정책/history 운영 연결과 실제 수용은 미완료이며 이 완료 범위로 확대하지 않는다.
