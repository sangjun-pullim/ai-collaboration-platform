---
status: done
date: 2026-10-01
risk-surface: auth
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 006 — 내구 질문·답변과 실행 조정

## Context

[기록과 실행 요청](../../BUSINESS-LOGIC.md#메시지와-실행-요청의-구분), [실행 소유권](../../BUSINESS-LOGIC.md#중복-실행과-소유권), [중단과 방향 변경](../../BUSINESS-LOGIC.md#일시정지중단방향-수정)을 실제 중앙 DB·HTTP 계약으로 연결한다. 현재 사람·기기 scope의 구현은 [DB](../../DB-SCHEMA.md)·[API](../../API-SPEC.md)이며 005는 검증·보관을 완료했다. 등록만으로 runtime readiness나 실제 AI 실행이 확인된 것은 아니다.

사용자는 전체 구현과 단계별 계획·실행을 총괄이 진행하도록 승인했다. 기존 in-place 위치·Node 24·Next.js/TypeScript·Supabase Auth/Postgres와 제품 환경 세 개를 유지한다. 읽기 전용 planner가 기존 private scope helper·취소·교체·회전·삭제 cascade·fixture의 새 consumer 영향을 조사했다. 추가 signing/admin key나 사람 JWT의 기기 위임을 도입하지 않는다.

### 이번 완료 기준과 후속 경계

- 사람의 명시적 공동 발언과 지정한 두 binding의 조사 시작을 구분한다. 질문은 한 수신 binding의 run만 만든다.
- 질문→peer run→저장된 답변→현재 origin의 후속 요청을 내구 기록으로 연결한다. 답변 도착과 origin 종결의 순서가 달라도 후속 요청은 한 번만 만든다.
- roomRevision·bindingEpoch·방별 sequence·request/attempt/fence·cycle budget을 분리한다. 시작 의도·lease 만료·기본 interrupt/ACK/terminal·UNKNOWN 자동 재실행 차단을 중앙 계약에서 검증한다.
- 사람 cookie 조회/제어와 device bearer의 자기 run payload·claim·제출을 별도 고정 HTTP/RPC로 제공한다. 실제 DB/RLS/HTTP와 가짜 runtime driver로 두 참가자·observer·다른 tenant를 검증한다.
- 웹은 실제 공동 기록과 미검증/대기/실행 보고/UNKNOWN/사람 확인 상태를 보여 준다. 공개 projection·backfill을 사용하는 polling을 구현하고 전달 누락·중복을 검증한다.

실제 Codex/Claude adapter·로컬 runtime 저널·native session 소유권·참가자별 모델/effort 적용은 이 coordinator를 소비하는 후속 명세다. 실제 provider 호출·두 AI 왕복 완료를 가짜 driver 검사로 주장하지 않는다. Realtime는 사람 HttpOnly cookie와 opaque device scope를 유지하는 별도 제한된 중계 단계에서 실제 검증한다. 이번 polling은 Realtime 완료가 아니다. private 설명·전체 방향 수정/복구 UI·클라우드·두 PC 파일럿도 후속이다. 기본 fencing/interrupt/UNKNOWN 차단은 이번 단계에서 미루지 않는다.

## Affected Files

1. `supabase/migrations/20261001000600-durable-investigation-coordinator.sql` — workflow private 정본·얇은 공개 event/run projection·live RLS·고정 definer RPC·기존 취소/교체 consumer의 새 실행 gate. 적용된 00100–00500 source는 동결한다.
2. `src/features/investigation-coordinator/contracts.ts`, `request-policy.ts`, `service.ts` — 고정 action·공개 DTO·본문/응답 검증·원문 예외 차단·scope별 service.
3. `src/app/api/investigations/[action]/route.ts`, `src/app/api/workflow/[action]/route.ts` — 사람 cookie action과 device opaque bearer action을 분리한다. 기존 connector 아홉 action을 늘리지 않는다.
4. `src/features/investigation-coordinator/investigation-view.tsx`, `history-state.ts` — 공개 이력·cursor와 제어 화면, abort 가능한 제한된 polling·backoff·상태 표시.
5. `src/app/app/rooms/[roomId]/page.tsx`, `src/features/room-access/room-access-view.tsx` — 기존 역할/방 관리와 새 실제 공동 기록 화면을 조합한다. prototype graph는 유지한다.
6. `packages/local-connector/src/workflow-contracts.ts`, `workflow-client.ts` — 별도 순수 계약 mirror·HTTPS/loopback/redirect/timeout 정책의 고정 device workflow client. native runtime 실행/daemon은 아직 추가하지 않는다.
7. `tests/fixtures/workflow-contracts.json`, `tests/unit/workflow-contracts.test.ts`, `tests/unit/investigation-history.test.ts`, `packages/local-connector/tests/workflow-client.test.ts`, `tsconfig.test.json` — 합성 공개 계약·이력 순서/중복·client 경계 검사.
8. `tests/helpers/workflow-fixture.ts`, `tests/helpers/device-binding-fixture.ts`, `tests/integration/investigation-coordinator.test.ts` — 기존 owned stack·합성 기기/사람을 재사용하는 실제 fixture, fake driver와 exact identity cleanup. 00500까지 source hash를 고정 검사한다.
9. `tests/e2e/investigation-coordinator.spec.ts`, `playwright.workflow.config.ts`, `package.json`, `tsconfig.integration.json`, `tsconfig.e2e.json`, `eslint.config.mjs`, `.gitignore` — 명시적 actual integration/browser 진입점·scope 제한 broker·산출물 정제.
10. `README.md`, `docs/ARCHITECTURE.md`, `docs/DB-SCHEMA.md`, `docs/API-SPEC.md`, `docs/FRONTEND-ARCHITECTURE.md`, `docs/BUSINESS-LOGIC.md`, `docs/onboarding-and-settings.md`, `docs/delivery-and-validation.md`, 필요시 `docs/ADR.md`·`docs/BUG-FIXES.md`, 이 명세 — 총괄이 현재 전달/실행 범위·불변식·검사·수명주기를 기록한다.

## Affected Dependents

- `device_binding_private.guard()`·`lock_scope()`·`live()`는 현재 기기/회원 RPC의 private helper다. 새 definer만 내부 호출하며 anon/authenticated private EXECUTE/USAGE/DML deny를 유지한다. 새 RPC 이름은 `workflow_*` 계열로 기존 `connector_%`/`connection_%`의 14개 assertion과 계약을 유지한다.
- 기존 순서는 guard(51005,1)→organization→rooms→org membership→room membership→pairing→device→credential→workspace→agent다. 새 workflow room/cycle/request/attempt/receipt row는 그 뒤의 고정 순서로 잠근다. 빠른 prelookup은 scope hint이며 잠금 후 재확인한다.
- `connector()`의 current key 인증은 inline이다. heartbeat를 먼저 호출한 결과를 다른 transaction의 권한으로 쓰지 않고 새 private workflow actor helper에서 원문 hash·현재 credential/device·live scope·binding을 다시 확인한다.
- `device_binding_private.cancel()`의 revoke/remove와 room/group revoke는 durable 상태를 모른다. 후속 SQL은 기존 signature/응답/취소 범위를 유지하면서 같은 transaction의 queued 취소·active interrupt/UNKNOWN 경계를 추가한다.
- `connector_replace`는 ID를 유지하고 epoch를 올린다. 실행 중·UNKNOWN이면 기존 교체도 거절하고 terminal 확인 뒤 교체한다. 회전은 stable device/agent/epoch를 유지하며 새 current key로 같은 lease를 이어 갈 수 있다. 옛 key의 rotation receipt 예외를 workflow에 적용하지 않는다.
- 실제 Auth/organization 물리 삭제는 guard 밖 cascade다. 새 FK·삭제 대응은 이 경로를 막거나 새 잠금 역전을 만들지 않아야 한다. 데이터 보존은 아래 Step 2의 계약을 따른다.
- `requestClient()`/`finish()`는 Auth/access/connections/page의 cookie·private JSON 계약이다. 새 사람 route도 이를 사용하되 shape를 바꾸거나 session 원문을 반환하지 않는다. 새 device route는 cookie proxy/refresh를 사용하지 않는다.
- 기존 `DeviceFixture`는 실제 CLI 등록·0600 cleanup identity를 제공하며 scope는 자기 fixture뿐이다. 새 fixture는 별도 진입점과 안전한 실패 위치 allowlist를 사용한다. 기존 helper의 호출부·Auth14·기기12·browser4/4를 다시 검증한다.
- root prototype 9 unit/20 browser, runtime 실험 source/51 unit과 보관 명세는 변경하지 않는다. 실제 provider 검증은 그 결과와 분리한다.

## Implementation Steps

### [x] Step 1: 고정 봉투와 idempotency 계약
**File**: contracts·mirror·합성 fixtures

모든 body는 `protocol: 1`과 아래 필드만 받는다. 표의 필드는 모두 필수이며 nullable만 명시적으로 허용한다. actor/role/owner/조직·기기 scope/RPC/native ID/명령/모델 원문 설정을 받지 않는다. 서버와 SQL은 직접 RPC에서도 exact schema·같은 한도를 검사한다.

| 사람 action | protocol 외 필수 body | 성공 data |
|---|---|---|
| read | roomId, afterSequence | HistoryPage |
| speak | roomId, operationId, publicText | eventId, sequence |
| start | roomId, operationId, originAgentId, peerAgentId, originEpoch, peerEpoch, expectedRoomRevision, publicText, confirmed:true | CycleAdmission |
| interrupt | roomId, operationId, agentId, bindingEpoch, expectedRoomRevision | controlId:nullable, requestId:nullable, state:REQUESTED 또는 NO_ACTIVE_RUN |
| pause | roomId, operationId, expectedRoomRevision | roomId, roomRevision, roomMode |
| resume (mode:room) | roomId, operationId, mode:room, expectedRoomRevision | ResumeResult |
| resume (mode:cycle) | roomId, operationId, mode:cycle, cycleId, originAgentId, peerAgentId, originEpoch, peerEpoch, expectedRoomRevision, publicText, confirmed:true | ResumeResult |

사람은 Cookie와 현재 Auth user를 사용한다. 모든 POST는 같은 APP_ORIGIN·JSON·16 KiB 본문 경계를 사용한다. read/poll에는 operation을 요구하지 않는다. 사람 write는 현재 owner/participant만 가능하고 interrupt는 자기 binding, resume mode:cycle은 그 cycle의 원래 origin 소유자만 가능하며 mode:room은 현재 owner/participant가 방의 intake만 재개한다. resume의 두 body는 mode로 구분하는 exact schema며 서로의 필드를 섞으면 거절한다.

| device action | protocol 외 필수 body | 성공 data |
|---|---|---|
| ready | operationId, agentId, bindingEpoch, reportedReady:boolean | agentId, bindingEpoch, reportedReady, validUntil:nullable, verification:reported |
| poll | agentId, bindingEpoch | PollSnapshot |
| claim | operationId, agentId, bindingEpoch, requestId | AttemptSnapshot |
| start-intent | AttemptIdentity | AttemptSnapshot |
| lease | AttemptIdentity | AttemptSnapshot |
| question | AttemptIdentity, publicText, confirmed:true | cycleId, questionId:nullable, peerRequestId:nullable, accepted:boolean, cycleState |
| complete | AttemptIdentity, terminal, publicText | TerminalReceipt |
| interrupt-ack | AttemptIdentity, controlId | controlId, requestId, attemptId, fence, state:ACKNOWLEDGED |
| observe | AttemptIdentity, terminal, publicText | TerminalReceipt |

`AttemptIdentity`는 operationId·agentId·bindingEpoch·requestId·attemptId·fence다. actor/조직/방/device는 bearer에서 계산한다. binding/request/attempt/control의 자기 소유·scope를 SQL 같은 transaction에서 대조한다. terminal은 COMPLETED/FAILED/INTERRUPTED만 가능하며 FAILED/INTERRUPTED의 publicText는 빈 문자열, COMPLETED는 공유된 텍스트 또는 빈 문자열만 받는다. provider error 원문 필드를 받지 않는다.

### 고정 DTO와 크기

- ID는 UUID, revision/epoch/fence는 양의 safe integer, sequence/cursor는 0 이상 safe integer, 시간은 ISO date 또는 명시적 null이다. publicText는 최대 UTF-8 8 KiB·4,000 Unicode codepoint이며 speak/start/resume mode:cycle/question에서는 trim 후 비어 있으면 거절한다. 본문 전체는 실제 16 KiB다. unknown field·잘못된 nested DTO를 거절하고 success `{ok:true,data}`/failure `{ok:false,error:{code}}`만 반환한다.
- 고정 error와 HTTP status는 기존 연결 계약과 같은 INVALID_BODY/BODY_TOO_LARGE(400), UNSAFE_ORIGIN/FORBIDDEN(403), UNAUTHENTICATED(401), NOT_FOUND(404), CONFLICT(409), QUOTA(429), UNAVAILABLE(503)다. error 원문/stack/SDK message를 DTO에 넣지 않는다. 개인 scope는 no-store·device Vary:Authorization, 사람 cookie는 기존 finish 정책이다.
- roomMode는 ACTIVE/PAUSING/PAUSED다. cycleState는 ACTIVE/COMPLETED/HUMAN_INPUT_REQUIRED/CANCELLED다. runState는 QUEUED/LEASED/RUNNING/UNKNOWN/COMPLETED/FAILED/INTERRUPTED/CANCELLED다. attemptState는 LEASED/EXECUTING/UNKNOWN/COMPLETED/FAILED/INTERRUPTED/ABANDONED다. interrupt control은 REQUESTED/ACKNOWLEDGED이며 terminal 여부와 독립적이다.
- `PublicEvent`는 eventId·roomId·sequence·createdAt·kind·senderKind(HUMAN/AGENT/SYSTEM)·senderAlias·publicText·cycleId/requestId/questionId/replyTo(각 nullable)·roomRevision·bindingEpoch(nullable)·agentId(nullable)·requestKind(nullable)·runState(nullable)·terminal(nullable)·roomMode(nullable)·adoption(NONE/PENDING/ACCEPTED/HISTORICAL/HUMAN_INPUT_REQUIRED)이다. kind는 SPEECH/INVESTIGATION_STARTED/QUESTION/ANSWER/RUN_STATE/INTERRUPT_REQUESTED/INTERRUPT_ACKNOWLEDGED/ROOM_PAUSE_REQUESTED/ROOM_PAUSED/ROOM_RESUMED/INVESTIGATION_RESUMED/HUMAN_INPUT_REQUIRED만 사용한다. RUN_STATE는 cycleId/requestId/agentId/requestKind/runState가 non-null이며 terminal은 COMPLETED/FAILED/INTERRUPTED runState와 일치할 때만 같은 값, 나머지는 null이다. QUESTION/ANSWER는 cycleId/requestId/agentId/requestKind/questionId가 non-null이며 ANSWER replyTo는 questionId다. room 제어 event는 roomMode를 보존한다. 관련 없는 nullable field는 null이고 kind별 일관성을 SQL·DTO에서 검사한다. event는 immutable이고 변경 사실은 새 event/sequence다. 32개 초과의 과거 run도 typed event만으로 상태/terminal을 복원한다. SPEECH의 HUMAN 발언은 실행 correlation을 모두 null·adoption NONE으로 둔다. AGENT의 승인된 완료 텍스트는 cycleId/requestId/agentId/requestKind/bindingEpoch를 non-null로 보존하며 requestKind는 ORIGIN/CONTINUATION/RESUME, questionId/replyTo/runState/terminal/roomMode는 null, adoption은 ACCEPTED/HISTORICAL이다. terminal 사실은 해당 request의 RUN_STATE event로 연결한다.
- `RunSummary`는 requestId·cycleId·agentId·ownerAlias·sessionAlias·requestKind(ORIGIN/PEER/CONTINUATION/RESUME)·roomRevision·bindingEpoch·state·questionId(nullable)·createdAt·updatedAt다. `PublicBinding`은 agentId·ownerAlias·sessionAlias·repositoryAlias·runtime:codex·bindingEpoch·owned:boolean·reportedReady·validUntil(nullable)이다. owned는 서버가 현재 사람 기준으로 계산하며 browser 입력을 믿지 않는다. 기존 등록 DTO는 계속 unverified다.
- `CycleSummary`는 cycleId·originAgentId·peerAgentId·generation·roomRevision·originEpoch·peerEpoch·state·runsReserved·peerRoundsReserved·deadline이다. lifetime counters·deadline은 현재 generation을 바꿔도 유지한다. `CycleAdmission`은 cycleId·requestId(nullable)·accepted:boolean·roomRevision·cycleState다. 한도 admission 실패는 accepted:false/requestId:null/HUMAN_INPUT_REQUIRED를 commit해 반환한다. `ResumeResult`는 roomId·roomRevision·roomMode·cycleId(nullable)·requestId(nullable)·accepted:boolean·cycleState(nullable)다. mode:room 성공은 cycleId/requestId/cycleState 모두 null·accepted:true이며 새 run/cycle을 만들지 않는다. mode:cycle은 해당 cycle의 admission 결과를 이 봉투로 반환한다.
- `HistoryPage`는 roomId·roomRevision·roomMode·events(최대16)·runs(최대32)·bindings(최대20)·cycle(nullable)·nextCursor·highWaterSequence·hasMore다. events는 afterSequence보다 큰 sequence 오름차순, nextCursor는 **실제 반환한 마지막 sequence**이며 빈 page는 입력 cursor다. hasMore일 때 highWater로 건너뛰지 않는다. runs는 현재 cycle/active blocker를 우선해 최신32개를 제공하고 event backfill이 오래된 이력의 정본이다. room/mode/binding/current cycle snapshot과 highWater는 같은 transaction의 일관된 조회다. 사람 응답은 최대256 KiB다.
- `RequestPayload`는 requestId·cycleId·agentId·bindingEpoch·roomRevision·requestKind·questionId(nullable)·publicText·replyText(nullable)·deadline이다. approved publicText 두 개 이하이며 전체 이력·private prompt를 넣지 않는다. `AttemptSnapshot`은 requestId·attemptId·agentId·bindingEpoch·fence·state·leaseExpiresAt·startIntentAt(nullable)·payload(RequestPayload)다. `PollSnapshot`은 roomId·roomRevision·roomMode·agentId·bindingEpoch·reportedReady·validUntil(nullable)·queuedRequest(nullable)·attempt(nullable)·control(nullable)다. control은 controlId·requestId·attemptId·fence·state만 갖는다. device 응답/client read는 최대64 KiB며 초과는 고정 UNAVAILABLE다.
- `TerminalReceipt`는 requestId·attemptId·terminal·adoption(PENDING/ACCEPTED/HISTORICAL/HUMAN_INPUT_REQUIRED)·continuationRequestId(nullable)다. peer answer를 받았으나 origin terminal을 기다리는 동안 adoption은 PENDING event로 기록하고, current epoch/revision/scope를 다시 검사해 continuation을 commit할 때 최종 ACCEPTED가 된다. terminal report는 이 단계의 fake/local 보고이며 provider를 독립 검증했다고 표시하지 않는다.

### 재시도와 준비 보고

- receipt 대상은 사람 speak/start/interrupt/pause/resume와 device ready/claim/start-intent/lease/question/complete/interrupt-ack/observe다. operation UUID는 사람 `(room,user)` 또는 기기 `(room,device)` namespace에서 action·정규화 payload hash와 결합한다. read/poll은 receipt가 없으며 보수적인 상태 reconciliation만 가능하고 실행/예산을 생성하지 않는다.
- 같은 operation/같은 payload는 최초 효과와 현재 해당 record 상태만 복구하며 event·예산·attempt를 새로 만들거나 readiness/lease TTL을 연장하지 않는다. ready/lease 갱신에는 새 operation이 필요하다. 다른 action/payload는409다. 재전달에서도 current credential·live scope·소유권을 먼저 확인하며 scope가 취소됐으면 receipt로 권한을 복원하지 않는다.
- readiness는 해당 소유 기기의 현재 등록 epoch에 대한 로컬 사전검사의 **보고**다. fake driver의 합성 준비를 실제 provider 검증으로 표시하지 않는다. reportedReady false/미보고/expired/offline이면 새 claim을 막되 소유한 기존 attempt의 terminal 관찰을 막는 근거로 사용하지 않는다. 기존 공개 등록 DTO의 unverified 의미를 유지한다.

### [x] Step 2: 정본과 공개 projection·live 권한
**File**: 신규 SQL·service
- workflow private에는 room control/revision/sequence counter, cycle와 immutable generation snapshot, addressed question, run request, attempt/lease, operation receipt, interrupt control, binding readiness를 책임별로 둔다. 동일 범위의 복합 제약·유일 request/continuation 제약과 상태 check를 사용한다. 모델 수는 이 책임을 합칠 수 있으나 상태/권한을 generic JSON 한 행으로 대체하지 않는다.
- public event/run projection은 roomId·eventId·sequence·kind·공개 sender 별칭/종류·공개 text·질문/답변 correlation·revision/epoch·고정 실행/채택 상태만 둔다. private prompt·provider event/error·credential/hash·lease secret·native locator·절대 경로·private 설명은 넣지 않는다.
- authenticated SELECT만 grant하고 현재 `room_access_private.in_room()`의 계정/그룹/방 live RLS를 사용한다. observer는 읽기만 가능하다. anon read, 사람/기기의 직접 DML·private schema 사용/조회/실행은 거절한다. device는 지정된 자기 binding의 미처리 request와 필요한 공개 context만 고정 RPC로 읽는다.
- 방별 counter 증가와 event 삽입을 같은 transaction에서 잠그고 commit 순서의 sequence를 만든다. 일반 sequence만으로 room commit 순서를 주장하지 않는다. `access_version`과 roomRevision·bindingEpoch를 분리한다.
- room/organization 삭제는 관련 workflow 정본/projection을 cascade 정리한다. member/device/agent 물리 삭제는 공동 이력을 유지하며 FK를 nullable historical reference 또는 서버가 계산한 immutable snapshot으로 설계한다. private request/attempt는 기존 origin/peer 식별·epoch와 삭제/무효화 사실을 남긴다. actor Auth FK를 추가해 기존 삭제 순서와 교착을 만들지 않는다. 사라진 실행 대상의 미시작 요청은 cancelled, 종결 미확인 attempt는 UNKNOWN이며 삭제를 terminal 증거로 삼지 않는다. scope/epoch/revision/예산 무효화 reconciliation은 ACTIVE cycle을 HUMAN_INPUT_REQUIRED로 바꾸고 pending question의 채택을 막으며 임의 COMPLETED로 종결하지 않는다.
- 물리 삭제 후 소비/read의 같은 transaction에서 current binding/scope 부재를 재검사하고 보존 record를 reconciliation한다. guard를 늦게 취득하는 삭제 trigger로 기존 cascade 잠금 순서를 뒤집지 않는다. 실제 삭제 경합에서 rollback/정상 소유자 유지와 부모 삭제 종료 가능성을 검증한다.

### [x] Step 3: 지정 질문·답변과 origin continuation
**File**: SQL coordinator·HTTP service
- start는 자기 origin binding과 같은 방의 다른 사람 peer binding 두 개를 확인한다. 현재 readiness·scope·epoch/revision·공유 확인이 유효한 경우에만 첫 origin request를 만들고, 일반 speak는 기록만 남긴다. 한 방의 active cycle은 초기 한 개로 제한한다.
- 한 cycle은 명시적 origin/peer 한 쌍·immutable initial snapshot·별도 current generation snapshot을 갖는다. 각 request/question은 생성 generation/revision/양쪽 epoch를 고정 보존한다. 첫 버전은 한 번에 미응답 peer question 하나만 진행한다. peer 실행 중 중첩 peer 질문으로 새 cycle/무제한 run을 만들지 않으며 별도 공동 발언은 실행을 만들지 않는다. origin request 하나에 question은 최대 하나이며 다음 origin turn이 후속 질문을 할 수 있다. 반대 방향 조사는 peer를 origin으로 하는 별도 명시적 cycle로 시작할 수 있다.
- `question`은 현재 EXECUTING origin attempt·commit된 startIntentAt·미만료 lease/fence·현재 generation/origin epoch/room revision을 확인하고 addressed question과 peer request를 한 transaction으로 만든다. 질문은 originRunId/originBindingEpoch·peer epoch·cycleId·deadline을 서버에서 묶는다. 다른 room/binding으로 라우팅할 수 없다. start intent 이전 question은409로 거절하며 question/peer request/peer 왕복/실행 예약을 모두0으로 유지한다.
- `complete`는 start intent가 기록된 현재 lease attempt의 terminal 보고와 공유 answer를 구분한다. 이미 UNKNOWN인 attempt는 observe로 terminal 사실만 기록하며 자동 채택하지 않는다. stale revision에서도 동일 소유 attempt의 terminal 사실은 보존하되 채택은 따로 거절한다. 완료 보고는 하나만 확정하며 peer answer의 responder epoch와 **origin epoch**·roomRevision·양쪽 live scope·cycle 상태를 재검사한다. stale/취소/기한 초과 결과는 역사/미채택으로 기록하고 후속 입력으로 채택하지 않는다. peer 외 ORIGIN/CONTINUATION/RESUME의 COMPLETED 공유 텍스트는 trim 후 비어 있지 않을 때 같은 transaction에서 correlated AGENT SPEECH event로 한 번 공개한다. 현재 채택은 ACCEPTED, UNKNOWN observe/늦은 완료는 HISTORICAL이며 FAILED/INTERRUPTED/빈 텍스트에는 발언 event를 만들지 않는다. 재전달 receipt는 새 발언을 만들지 않는다.
- answer가 먼저 도착해도 origin attempt의 confirmed completed terminal을 기다린다. origin terminal이 먼저 오면 answer를 기다린다. 두 조건을 만족하고 active/UNKNOWN blocker가 없을 때만 question별 유일 origin continuation request를 만든다. 중복 complete·동시 answer/terminal로 둘을 만들지 않는다. origin interrupted/failed/UNKNOWN이면 자동 continuation 없이 사람 확인이다. 현재 generation의 **마지막 origin/continuation/resume request**가 COMPLETED이며 pending question·대기 continuation·QUEUED/LEASED/RUNNING/UNKNOWN request와 미종결 attempt가 모두 없을 때만 cycle을 COMPLETED로 종결한다. answer-first와 terminal-first 둘 다 continuation 생성 후 그 request가 끝날 때까지 cycle은 ACTIVE이고 새 start는 거절한다. HUMAN_INPUT_REQUIRED/기한 만료 cycle은 명시적 새 start에서만 retire할 수 있고, 모든 기존 attempt가 confirmed terminal 또는 unstarted abandoned/cancelled여야 한다. UNKNOWN/started 미확인 attempt를 생략해 retire하지 못한다. 정상 종결 후 새 start의 양성과 UNKNOWN 차단을 검증한다.

### [x] Step 4: lease·start intent·UNKNOWN과 예산
**File**: SQL run/attempt·client contracts
- ready/poll은 현재 기기/binding과 마지막 관찰을 보고한다. readiness는 60초, claim lease는 30초, 정상 heartbeat는 10초를 기본으로 한다. server clock과 현재 scope를 기준으로 검사하며 heartbeat가 actual terminal 증거가 되지 않는다.
- claim은 queued request에 유일 attempt와 증가하는 fence를 발급한다. 동일 stable `(deviceId,agentId)` binding은 epoch가 달라도 confirmed terminal 이전 attempt 또는 UNKNOWN이 있으면 새 claim을 할 수 없다. ownership은 stable device+agent epoch이고 credential hash는 lease identity가 아니다. current key 회전 뒤 정상 lease/결과 제출은 허용하고 옛 key workflow 호출은 거절한다.
- `start-intent`를 중앙에 commit한 뒤에만 adapter가 실제 runtime 호출을 할 수 있다는 계약을 제공한다. 후속 local journal은 호출 전 자체 durable intent까지 기록해야 한다. 이번 fake driver도 이 순서를 검사한다. 시작 의도 이전 lease 만료는 원래 request의 새 attempt로 재대기할 수 있고, 시작 이후 만료/통신 유실/종결 미확인은 UNKNOWN으로 고정해 자동 새 attempt를 만들지 않는다.
- fence는 옛 결과/제어의 채택을 차단하며 실제 옛 프로세스를 종료했다고 표현하지 않는다. `observe`는 동일 attempt의 뒤늦은 confirmed terminal 관찰을 기록하되 UNKNOWN에서 자동 후속 실행을 하지 않는다. 사람의 명시적 resume도 confirmed terminal·현재 scope·epoch·revision을 요구하며 원래 request를 replay하지 않는다.
- 한 cycle의 초기 한도는 5회 peer 왕복·11회 실행 예약·시작 후 10분이며 peer 대기 deadline은 cycle 잔여 시간 이하 최대 120초다. 실행 예약은 start/peer/continuation/resume의 **새 request admission**에서 같은 transaction에 한 번만 소비한다. 시작 전 abandoned attempt의 새 attempt/fence는 기존 request 예약을 재사용한다. peer 왕복은 question admission에서 한 번 소비한다. stale/취소/UNKNOWN에서도 이미 예약한 소비를 돌려주지 않는다. 한도 admission 실패는 cycle의 HUMAN_INPUT_REQUIRED·대기 취소/active control을 commit하고 새 request/attempt를 만들지 않는다. 방향/epoch 변경·재접속·일반 resume로 예산을 초기화하지 않는다. 한도/기한 도달은 HUMAN_INPUT_REQUIRED이며 자동 새 cycle을 만들지 않는다. 공급자 token/금액 hard cap은 주장하지 않는다.

### [x] Step 5: 취소·교체·pause와 기본 제어
**File**: 후속 SQL의 기존 consumer 보강·service
- 기존 cancel signature와 각 사람 RPC의 body/응답·권한/감사를 유지한다. 기기/대상 membership 취소와 queued 취소·active interrupt intent를 같은 transaction에 묶는다. 이미 시작된 attempt는 terminal 확인 전 interrupted로 꾸미지 않고 UNKNOWN/interrupt requested를 보존한다. 재초대는 옛 run/binding/readiness를 되살리지 않는다.
- revoke 후 device가 제어를 더 poll할 수 없더라도 서버는 종료를 확인한 것으로 표시하지 않는다. 후속 local driver는 current credential/권한 거절을 받으면 자기 실행을 중단하고 terminal을 로컬에 보존해야 한다. 이번 중앙 검사는 미확인 상태·채택 차단을 검증한다.
- 기존 replace는 active/start intent/UNKNOWN blocker가 있으면 409로 거절한다. confirmed terminal 이후에만 epoch/root/session 교체를 허용하며 readiness를 무효화한다. 같은 operation의 이미 완료한 replace receipt 규칙은 유지한다. 새 active run을 두고 receipt로 교체가 재실행되지 않는다.
- 자기 interrupt는 자기 binding만 대상으로 한다. room pause는 cycle 없는 방·완료/기한 만료/소진 cycle의 방에서도 현재 owner/participant의 명시적 action으로 새 intake를 막고 roomRevision을 증가시키며 대기 요청과 양쪽 active control을 함께 처리한다. 같은 pause transaction에서 현재 ACTIVE cycle을 HUMAN_INPUT_REQUIRED로 전환하고 pending question은 HISTORICAL/미채택으로 고정한다. 기존 COMPLETED/기한 만료/소진 상태와 lifetime counters/deadline은 보존하며 room-only 재개가 그 cycle을 ACTIVE로 되살리지 않는다. QUEUED origin/continuation이 취소된 경우에도 모든 attempt의 안전 종료를 확인하면 mode:cycle로 같은 cycle을 재개하거나 명시적 새 start로 retire할 수 있다. 요청/ACK/실제 terminal을 분리하며 ACK만으로 pause 완료가 되지 않는다. UNKNOWN이 남으면 PAUSING/사람 확인으로 유지한다.
- resume mode:room은 현재 owner/participant·현재 revision·방의 모든 blocker의 confirmed terminal/unstarted 안전 종료를 확인한 뒤 roomMode만 ACTIVE로 바꾸고 ROOM_RESUMED event를 만든다. cycle 유무/완료/기한/소진과 관계없이 가능하며 run/cycle/generation/예산을 만들거나 초기화하지 않는다. UNKNOWN이 있으면409다. room 재개만으로 옛 HUMAN_INPUT_REQUIRED cycle을 자동 실행하지 않으며 다음 start의 명시적 retirement 조건은 계속 적용한다.
- resume mode:cycle은 기존 권한·현재 snapshot·모든 blocker의 confirmed terminal/unstarted 안전 종료·기존 HUMAN_INPUT_REQUIRED cycle을 확인한다. 원래 cycle origin 소유자만 현재 roomRevision·같은 origin/peer ID와 현재 양쪽 epoch로 별도 generation을 추가하고 명시적 새 origin request를 만든다. initial snapshot·옛 request/question을 수정하지 않으며 cycle lifetime counters/deadline을 유지한다. 만료/소진 cycle은 resume로 되살릴 수 없다. roomMode를 ACTIVE로 바꾸되 pause로 높인 revision은 내리지 않으며 옛 generation의 답변은 역사로 남긴다. 옛 요청/epoch의 결과나 원래 run을 자동 재호출하지 않는다. 재개로 cycle counter/deadline을 초기화하지 않는다. private 설명과 전체 방향 수정 UI는 후속이다.

### [x] Step 6: 실제 공동 기록 화면과 durable polling
**File**: 신규 view/history-state·방 조합
- 모의 reducer와 분리된 실제 이력은 server snapshot과 `afterSequence` backfill을 사용한다. eventId dedup·sequence 정렬과 gap 복구를 수행하고 미확정 발신을 확정 이력처럼 표시하지 않는다. 공개 sender·질문/답변·현재/과거 미채택·queued/UNKNOWN/사람 확인을 구분한다.
- participant/owner는 공동 발언과 명시적 조사 시작·자기 interrupt·room pause·방 재개(mode:room)를 사용할 수 있다. cycle origin 소유자만 잔여 예산/기한이 있는 조사 재개(mode:cycle)를 사용할 수 있으며 두 동작의 문구·조건을 분리한다. observer는 읽기만 가능하다. 실제 runtime driver가 준비되지 않은 등록은 미검증/연결 보고로 표시하고 시작 조건을 설명한다. 모델·effort 선택 UI를 가짜 옵션으로 넣지 않는다.
- 초기 browser polling은 활동 시 2초, idle 10초, 숨김/오류 시 최대 30초 backoff로 제한한다. 한 consumer는 한 요청만 진행하고 unmount/전환/권한 거절 시 abort한다. hint 손실 없이 DB 조회만으로 확정 이력을 복원한다. 사용자 간 cursor/state를 공유하지 않는다.
- 실제 Realtime 구현이 없음을 문서와 수용 증거에 남긴다. provider·원문 세션·private 요청을 browser/network/HTML/RSC/로그/analytics/실패 artifact에 포함하지 않는다. 한국어·keyboard·mobile과 고정 오류의 focus/복구를 유지한다.

### [x] Step 7: 실제 DB/HTTP·fake driver·browser 검증
**File**: workflow fixture·명시적 runners
- task-owned 여섯 container·canonical workdir·loopback API/DB/Mailpit과 다섯 적용 SQL SHA를 검증한다. 새 DDL 적용은 총괄만 수행하고 fixture는 설치 상태만 검사한다. 새로운 관리자·DB·JWK/provider credential을 제품/CLI/browser child나 파일/출력에 전달하지 않는다.
- fixture는 자기 namespace·정확한 사용자/조직/기기/agent/cycle/event/request/attempt ID와 operation을 최소 0600 recovery identity에 기록한다. 실패와 cleanup 실패의 stage·허용 source 위치만 남기고 private diagnostics 원문을 공개하지 않는다. 다른 row·DB reset·unknown anonymous data 삭제는 하지 않는다.
- 시간 경계는 parent DB가 먼저 recovery identity를 저장하고 exact 자기 room/cycle/question/request/attempt ID·namespace·소유자를 검증한 뒤 해당 readiness/lease/deadline timestamp만 함께 조정해 결정적으로 검사한다. public testClock/RPC나 production clock override·전역 UPDATE를 추가하지 않는다. 기존 device fixture의 exact timestamp 패턴을 재사용한다.
- fake driver는 실제 제품 HTTP/RPC를 호출해 claim/start intent/질문/terminal/ACK/observe와 crash 지점을 제어한다. 실제 모델/SDK/개인 저장소가 없는 합성 driver임을 표시한다. 실제 local CLI 등록과 현재 raw bearer scope는 기존 fixture로 검증한다.
- browser는 사람 Auth와 scope 제한 broker만 받는다. broker는 자기 fixture의 fixed ready/run/question/result/control만 지원하고 provider/remote command를 실행하지 않는다. Auth artifact 정제·trace/screenshot/video off 정책을 재사용한다.
- root/connector type/lint/unit/build, 새 actual integration/browser와 기존 Auth14·기기12·Auth browser4·기기 browser4·모의 browser20을 검증한다. 변경 없는 runtime51/기존 리뷰는 입력이 같은 범위에서 재사용한다.

### [x] Step 8: 독립 리뷰·정본·수명주기
**File**: 총괄 소유 docs·명세
- source inventory/diff/의존성·실제 검사와 fake/provider 구분을 고정하고 fresh reviewer가 scope·public/private projection·FK/삭제·동시 claim·lease/fence·UNKNOWN·late origin·budget·취소/교체·polling/fixture를 검토한다. 지적을 보정하고 별도의 plan/implementation review cap을 적용한다.
- 정본 문서에 실제 coordinator/HTTP·polling·미검증 runtime 보고와 남은 adapter/모델·effort/Realtime/두 PC 범위를 기록한다. 중요한 선택의 이유를 ADR로 승격하고 Git 부재로 commit stamp를 꾸며내지 않는다.
- 모든 step·named test·필수 검사·clean 독립 리뷰가 완료된 경우에만 done/archive와 backlinks를 정리한다. 다음 상세 명세는 실제 connector-owned Codex 실행과 per-binding 설정·local journal/terminal 관찰을 연결하며 Claude adapter도 뒤이어 별도 검증한다.

## Tests

아래는 만들 named tests이며 구현/통과 사실이 아니다.

| 이름 | 검증할 동작 |
|---|---|
| `should route an addressed question through one peer run and one current origin continuation` | 실제 DB/HTTP 두 기기·방 scope, answer-first/terminal-first·유일 continuation·후속 대기 중 cycle ACTIVE/새 start 거절 |
| `should finish a completed cycle and retire it only after confirmed execution termination` | 질문 없는 origin/continuation 완료 텍스트의 correlated 공개·receipt 재전달 중복0·정상 종결 뒤 새 start 양성·HUMAN_INPUT_REQUIRED/기한 만료의 명시적 retirement·UNKNOWN 시작 차단 |
| `should reopen a paused room without dispatching or resetting an investigation` | 빈/정상 종결/기한 만료/소진 방의 mode:room 양성·run/예산0·observer 및 UNKNOWN 거절·mode:cycle 원래 origin 권한·QUEUED origin/continuation pause의 HIR 전이·room-only 재개 뒤 cycle resume/명시적 new-start retirement 양성 |
| `should record shared speech without dispatching automatic runs` | participant 공개 발언은 event만, observer 쓰기·비멤버/다른 room 거절 |
| `should deduplicate operations across actions and reject conflicting payloads` | 같은 receipt·새 감사/event/attempt/예산 없음, 다른 action/payload conflict |
| `should claim one attempt and block concurrent execution across binding epochs` | 동시 claim·같은 agent 다른 epoch·새 device/다른 tenant의 claim 거절 |
| `should recover an expired unstarted lease without replaying a started request` | pre-intent question409/peer예약0·start intent 전 새 attempt/fence, start intent 뒤 UNKNOWN·자동 replay0 |
| `should reject stale fences and preserve unknown terminal observation without automatic continuation` | 옛 fence result/control·lease takeover, UNKNOWN 뒤 terminal 사실·늦은 완료 텍스트 HISTORICAL 기록·auto-followup0 |
| `should reject late answers when either binding epoch or the room revision has changed` | responder/origin 각각의 epoch와 pause revision·권한 변경·역사 미채택 |
| `should reserve cycle budgets before admission and preserve them across recovery` | 동시 예약·5왕복/11실행/10분·peer deadline·UNKNOWN 소비·resume/epoch/reconnect 불초기화 |
| `should keep run scope revoked after device or membership removal and fresh invitation` | device/remove·room/group revoke·재초대·옛 run/ready/continuation 거절·다른 정상 참가자 유지 |
| `should preserve stable run ownership through credential rotation and gate binding replacement` | 새 current key의 같은 lease·옛 key 거절·active/UNKNOWN replace409·terminal 뒤 교체/ready무효 |
| `should preserve shared history and unknown execution through physical owner deletion` | 등록 origin/peer의 hard-delete·ban/soft-delete/조직 cleanup·새 FK·삭제/claim 경합·정상 scope 유지 |
| `should separate interrupt requests acknowledgements and confirmed room pause` | 자기 interrupt/room pause·ACK≠terminal·자연종료경합·UNKNOWN미완료·안전한resume |
| `should enforce live public event access and private device payload ownership` | direct SELECT/DML/RPC·저장 hash 거절/원문 양성·tenant/observer·public/private allowlist |
| `should recover ordered history after duplicate delivery gaps and reconnect` | 실제 event commit순서/정정·cursor·중복/구독없는backfill·32개 초과 과거 run의 typed event replay·권한취소 뒤 조회 거절 |
| `should keep coordinator secrets and runtime locators out of storage responses and artifacts` | rawkey/proof/admin/JWK/native/root/providererror 원문 부재·공개 text 양성·최소 recovery identity |
| `should refuse workflow fixture effects outside the owned stack and clean exact identities` | sourceHash/원격/다른project guard·fault 이후 exact 정리·정상 fixture 보존 |
| `should agree on workflow contracts across web and local clients` | 순수 mirror/fixture의 action·DTO·nested projection·잘못된 상태/원문 필드 판정 일치 |
| `should merge durable history without leaking state across rooms` | 순수 eventId/sequence/gap·cursor/room 전환·미확정/확정 분리 |
| `should restrict workflow transport and preserve fixed error boundaries` | connector client HTTPS/loopback/redirect/timeout·unknown response·원문 exception 부재 |
| `should display an owned investigation and restore public history for an observer` | 실제 browser 두 context·동일 공개 이력·observer write없음·refresh/poll·desktop/mobile |
| `should distinguish reported execution unknown and confirmed pause in the browser` | fake 보고≠provider검증·ACK/UNKNOWN/terminal·재개차단·keyboard/focus/privacy |

첫 18개는 actual DB/HTTP·fake driver integration, 다음 2개는 root 순수 unit, 다음 1개는 connector 격리 unit, 마지막 2개는 실제 browser desktop/mobile 총 4건이다. fake driver는 실제 provider 호출 검증을 대신하지 않는다.

## Risks

- 등록 receipt를 runtime replay 규칙으로 쓰면 UNKNOWN 중복 호출이 생긴다. 중앙 start intent·fence·보수적 UNKNOWN·후속 local durable intent를 분리한다.
- peer answer만 검사하면 바뀐 origin에 늦은 답변이 실행된다. 양쪽 epoch·revision·현재 scope·terminal과 유일 continuation을 함께 확인한다.
- 새 FK/trigger가 물리 삭제를 막거나 guard 역전을 만들 수 있다. historical reference 수명과 기존 cascade를 분리하고 실제 삭제/경합을 검사한다.
- polling/lease가 전역 guard를 과도하게 사용하면 다른 방까지 대기한다. 두 사용자 초기 범위의 짧은 transaction·bounded polling과 실제 검사 시간을 기록하며 확장성을 주장하지 않는다.
- ready 보고와 fake driver는 실제 provider readiness/모델 적용의 독립 증거가 아니다. 공개 상태·문서·검증 계층을 구분하고 후속 adapter에서 실제 계정/버전을 검증한다.
- browser JWT가 없는 현재 HttpOnly 계약에서 Realtime direct 연결을 가정하면 인증을 우회한다. polling을 정본 복구 경로로 먼저 구현하고 제한된 server hint relay는 별도 검증한다.

## Verification

Node 24.21.0·owned loopback stack·합성 fixture만 사용한다.

```sh
npm ci
npm --prefix packages/local-connector ci
npm --prefix packages/local-connector run typecheck
npm --prefix packages/local-connector run build
npm --prefix packages/local-connector test
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:integration:devices
npm run test:integration:workflow
npm run test:e2e:auth
npm run test:e2e:devices
npm run test:e2e:workflow
npm run test:e2e
```

입력이 유지된 passing 검사/독립 리뷰만 재사용한다. 실제 새 SQL 설치·grants/함수/제약·새 tests와 영향받은 취소/교체/fixture는 직접 검증한다. 제품/child에는 세 제품 설정·scope 제한 fixture bridge만 전달하며 parent admin/DB/JWK는 process memory에만 둔다. 실제 provider·Realtime·cloud·두 PC 호출은 이번 검증에 없다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 기존 helper와 새 실행 consumer의 범위 조사 | — | APPLIED | fixed workflow RPC·transactional current key 검증·취소/교체/회전·삭제 FK/잠금·public projection·명시적 runner와 guard를 계획에 반영. planner는 source/실제 환경을 변경하지 않음 |
| Realtime와 HttpOnly cookie 접점 조사 | — | APPLIED | opaque bearer 표준JWT불가·browserJWT경로없음·stream 이후cookie갱신불가를 확인. 이번 polling과 후속 제한된 server Realtime relay를 구분하고 session 비노출/ENV3개 경계를 유지 |
| action별 exact body/DTO·pagination·owned projection 미정 | HIGH | ACCEPTED | Step1의15 action 표·고정 nested DTO/enums·body/response bounds·실제 cursor/highWater·자기 origin projection을 확정 |
| read/poll receipt 범위와 ready/lease 재전달 TTL 미정 | HIGH | ACCEPTED | nonreceipt read/poll·mutation namespace·최초 효과만 복구·새 갱신 operation·매번 live/current scope 확인 |
| pause 이후 고정 cycle snapshot과 resume/소유권 충돌 | HIGH | ACCEPTED | immutable initial/history + current generation·원래 origin 소유자·같은 cycle lifetime counter/deadline 유지 |
| 실행 예약의 request/attempt 단위 불명확 | HIGH | ACCEPTED | 새 request에서만 run 예약·unstarted attempt 재발급은 재소비 없음·question에서 peer round 예약·취소/stale/UNKNOWN 소비 유지 |
| cycle 정상 종결/retirement와 named test 누락 | HIGH | ACCEPTED | origin 완료/열린 질문 없음 종결·명시적 새 start와 모든 attempt terminal/안전 미시작 종료·UNKNOWN 차단·새 lifecycle integration test |
| DB clock 경계의 결정적 검증 방법 누락 | MEDIUM | ACCEPTED | recovery identity 선기록·parent DB exact fixture identity 뒤 timestamps 조정·public clock override 없음 |
| 빈/종결/만료/소진 방의 pause 해제 경로 없음 | HIGH | ACCEPTED | resume exact mode:room/mode:cycle·방 재개는 run/예산 생성 없음·현재 역할/revision/모든 terminal 확인·전용 actual named test |
| 원래 origin 종결이 대기 continuation을 두고 cycle을 종료할 수 있음 | HIGH | ACCEPTED | 현재 generation 마지막 origin/continuation/resume 완료·pending question/continuation와 모든 active/UNKNOWN request/attempt 없음·양쪽 도착순서 ACTIVE 회귀 |
| RUN_STATE event에 typed 실행/terminal 필드가 없음 | HIGH | ACCEPTED | nullable agentId/requestKind/runState/terminal/roomMode·kind별 nonnull/일관성·32개 초과 실제 historical replay |
| start intent 없는 LEASED origin의 question이 peer 효과를 만들 수 있음 | HIGH | ACCEPTED | EXECUTING+committed intent/current lease/fence/generation만 question 허용·pre-intent409/모든 peer 예약0 회귀 |
| binding blocker 키가 기기 전체로 해석될 수 있음 | MEDIUM | ACCEPTED | 동일 stable(deviceId,agentId)의 across-epoch blocker를 명시하고 다른 binding을 기기 ID만으로 묶지 않음 |
| 진행 중 최종 리뷰의 pause→cycle 상태 전이 누락 | HIGH | ACCEPTED | pause 동일 TX의 ACTIVE→HUMAN_INPUT_REQUIRED·pending question 역사화·lifetime budget 보존·QUEUED origin/continuation 취소 뒤 room/cycle 재개와 명시적 retirement 회귀를 명시. 진행 중인 같은 round3에서 변경 delta를 검증해 해소 |
| 독립 plan review round3 최종 검증 | — | PASS | 이전6건·round2 네 HIGH 및 stable key·같은 ongoing round3 pause 전이 보정 모두 해소. 남은 C/H/M/L 없음. 구현/실제 검사 통과와 구분 |

| 구현 리뷰: 물리 peer 삭제·claim 경합·workflow cascade 검증 누락 | HIGH | ACCEPTED | 기존 namedtest를 exact-owned barrier/실제 두 transaction 잠금 대기·11개 테이블 자식0·정상 fixture 보존으로 보강. 최종 실제 검사 PASS |
| 구현 리뷰: 새 DB 설치 안내의006 누락과 API 현재 상태 모순 | HIGH / MEDIUM | ACCEPTED | 새DB001–006·기존DB미적용 후속만·schema reload 및 별도workflow/provider범위로 국소 보정 |
| 실제 경합 검사의 직접 blocker/한쪽 순서 제한 | MEDIUM | ACCEPTED | 실제 parent→claim→DELETE tuple 대기열을 확인하고 cycle없는 bounded root path를 순서 중립으로 검증. 제품 결함이 아닌 검사 보정 |
| 과거 rows/receipt 전체 잠금과 room 인덱스 부재 | MEDIUM | FOLLOW-UP | 초기두사용자범위. 로드맵에 측정·잠금 축소·후속migration 개선 기록 |
| 독립 구현 리뷰 round1 | — | PASS | prearchive6 frozen diff·최종 실제/동일입력 재사용 근거 확인. 미해결 CRITICAL/HIGH0·비차단성능MEDIUM1 |
