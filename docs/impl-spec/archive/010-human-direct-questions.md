---
status: done
date: 2026-10-02
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: 구현 계획이며 현재 지원의 증거가 아니다. 활성 명세는 구현·리뷰 결과로 갱신한다. 보관한 명세와 적용된 migration은 변경하지 않는다.

# 자기 AI 연결 없이 상대 저장소 AI에 직접 질문

## Context

[사람의 직접 질문 요구](../../PRD.md#공동-조사방)를 구현한다. 현재 SQL006의 사람 `start`는 자기 origin과 다른 소유자의 peer를 요구한다. 웹 질문자는 기기·저장소·AI 없이 참가할 수 있어야 한다. 대상 소유자는 기존 읽기·공유 범위를 확인하고 연결기를 실행해 둔다. 지정한 대상만 답하고 질문자 AI와 자동 후속 왕복을 만들지 않는다.

기존 대상 답변 요청인 `PEER`를 재사용한다. 이는 답변 실행의 종류이며 발신자가 AI라는 뜻으로 사용하지 않는다. 사람 질문은 실제 HUMAN 발신자와 별도 질문 원천으로 저장한다. 가짜 origin binding·run·native session을 만들지 않는다. 기존 `PEER` payload·claim·terminal receipt의 정확한 형태를 유지하면 로컬 실행기와 과거 저널을 재사용할 수 있다. `WorkflowRunner.performTool`의 PEER 질문 재귀 차단과 Codex의 PEER 지침도 유지한다.

현재 계약과 provider는 Codex다. 승인된 [009](../009-claude-code-runtime-compatibility.md)의 공식 Claude 호환성 검사를 병행하고, Claude 제품 adapter·등록 계약은 그 결과를 반영한 별도 작은 명세에서 연결한다. 이 단계 성공을 Claude나 실제 두 PC 완료로 확대하지 않는다. 모델 catalog·다자 대기열·개인 설명·Realtime·파일 수정은 포함하지 않는다.

한 방의 현재 작업 하나와 실행/UNKNOWN 충돌 차단을 유지한다. 준비된 상대 연결이 정확히 하나일 때만 기본 대상으로 지정한다. 여러 연결이면 명시적으로 선택한다. 직접 질문은 한 번의 대상 실행이며 재개·자동 재시도는 제공하지 않는다. 확인된 종결 후 사람이 제출하는 추가 질문은 새 작업이다.

## Affected Files

운영 파일은 아래 6개다. 첫 구현의 4개에 독립 리뷰 보정용 페이지와 forward migration 2개를 추가한다. 추가 범위는 계획 검토와 사용자의 진행 지시 후 구현했다. 적용된 SQL001–008은 동결한다.

1. 신규 `supabase/migrations/20261002000700-human-direct-questions.sql` — 직접 cycle·사람 질문 저장, admission·채택·취소·이력과 RPC의 additive 변경.
2. `src/features/investigation-coordinator/contracts.ts` — `ask`·`cancel` 사람 계약, 직접 cycle 요약과 HUMAN QUESTION 검증.
3. `packages/local-connector/src/workflow-contracts.ts` — 동일한 계약 mirror. 기존 요청·attempt·receipt의 wire 형태는 유지.
4. `src/features/investigation-coordinator/investigation-view.tsx` — AI 없는 질문 폼, 대상 표시·기본 선택, 직접 질문 상태와 범위가 한정된 중단 요청.
5. `src/app/app/rooms/[roomId]/page.tsx` — 이미 서버에서 인증한 `data.userId`를 직접 질문 화면에 전달한다. 별도 인증 endpoint는 만들지 않는다.
6. 신규 `supabase/migrations/20261002000800-human-direct-actor-precondition.sql` — `ask/cancel` 공개 RPC에서 기대 사용자와 현재 Auth를 대조하는 precondition, 일반 질문 cycle 인덱스를 additive 적용한다.

관련 unit·integration·e2e·fixture·검사 설정에는 아래 수용 검사를 추가한다. `docs/{API-SPEC,DB-SCHEMA,BUSINESS-LOGIC,FRONTEND-ARCHITECTURE,delivery-and-validation,onboarding-and-settings}.md`, `README.md`는 현재 구현과 후속 provider 범위를 동기화한다.

## Affected Dependents

- `src/app/api/investigations/[action]/route.ts`, `src/features/investigation-coordinator/{service,request-policy}.ts` — `humanActions`와 검증·generic RPC 이름 조합을 사용한다. 하이픈 없는 `ask`·`cancel`과 `workflow_human_ask/cancel` wrapper를 사용해 기존 gateway를 유지한다.
- `src/app/api/workflow/[action]/route.ts`, `packages/local-connector/src/workflow-client.ts` — 기존 device action과 정확한 PEER payload를 유지한다.
- `packages/local-connector/src/{workflow-runner,runtime-contracts,runtime-store,codex-adapter,cli}.ts` — 기존 서버 claim·fsync intent·owned native 실행·종결·outbox·복구·PEER 재귀 차단을 유지한다. 기존 저널의 claim/receipt validator가 같은 형태를 받아야 한다.
- `src/features/investigation-coordinator/{history-state,polling-policy}.ts`, `src/app/app/rooms/[roomId]/page.tsx` — 직접 run에도 기존 cycleId와 RUN_STATE를 유지한다. 공동 이력의 순서·gap 복원·중복 제거를 유지한다.
- `device_binding_private.cancel`, `public.connector_replace` — 직접 실행도 기존 requests/attempts를 사용하므로 취소·교체의 진행 중/UNKNOWN 보호에서 빠지지 않는다.
- `tests/helpers/{workflow-fixture,owned-runtime-fixture,device-binding-fixture}.ts`, 기존 workflow browser broker — 기존 양쪽 연결 scene은 유지하고, 질문자 device/profile/runtime이 실제로 없는 scene을 추가한다. 테스트 자격증명은 기존 소유 loopback 경계를 유지한다.
- 미구현 008의 migration 이름은 예약이 아니다. 007번 migration을 실제 추가하면 후속 settings 계획의 migration 번호·기준 소스는 착수 전에 새로 배정한다.

## Implementation Steps

### [x] Step 1: 직접 질문 저장과 정확한 계약
**File**: 새 migration, 두 contracts mirror

- `cycles`에 불변 `mode`를 `AI_PAIR` 기본값으로 추가한다. DIRECT는 `origin_owner_id`가 실제 질문자이고 origin agent/epoch는 null, peer agent/epoch는 실제 대상이다. AI_PAIR는 기존 두 agent·epoch와 서로 다른 agent 조건을 유지한다. SQL의 null 비교로 잘못된 조합이 통과하지 않도록 명시적인 모드별 CHECK를 검증한다.
- `generations.origin_epoch`는 DIRECT에만 null을 허용한다. 현재 cycle 모드와 generation의 조합을 내구 저장 경계에서 검증한다. 직접 cycle은 generation 1, 대상 실행 1개, 자동 peer 왕복 0개로 고정한다. 대상·질문자·모드·epoch를 기존 cycle 재개로 바꾸지 않는다.
- `questions`에 `source`와 사람 질문자 식별자를 추가한다. 기본 AI 질문은 기존 origin request/epoch를 유지한다. HUMAN 질문만 origin request/epoch가 null이고 인증된 질문자를 참조한다. 한 직접 cycle에 사람 질문 하나와 대상 PEER 하나만 존재하도록 제약을 둔다. 개인 식별자는 private 저장소에 두며 공개 native locator로 사용하지 않는다.
- SQL007의 최초 `ask` 본문은 정확히 `protocol:1, roomId, operationId, targetAgentId, targetEpoch, expectedRoomRevision, publicText, confirmed:true`다. `cancel`은 `protocol:1, roomId, operationId, requestId, expectedRoomRevision`이다. 기존 UUID·안전한 양의 정수·trim·UTF-8 16KiB 요청/8KiB 문구 상한과 오류 목록을 재사용한다. origin·클라이언트 actor/owner·임의 경로 필드를 받지 않는다. 최종 ask/cancel 계약은 Step 5의 `expectedUserId` 사전 조건을 추가한 형태다.
- 기존 AI_PAIR cycle JSON은 바꾸지 않는다. 직접 cycle은 별도의 정확한 요약 `{cycleId, mode:"DIRECT", targetAgentId, targetEpoch, generation, roomRevision, state, runsReserved, peerRoundsReserved, deadline, canInterrupt}`로 반환한다. 권한 boolean은 현재 인증 주체로 계산한다. `HistoryPage.cycle`은 두 형태의 union이며 AI_PAIR 소비자는 직접 형태를 구별한다.
- 인간 QUESTION도 기존 event 봉투를 사용하되 `senderKind:HUMAN`, 실제 사람 별칭, 대상 PEER request·agent·epoch·questionId를 기록한다. 이 경우 agent/epoch는 발신 AI가 아니라 실행 대상으로 해석한다. AI QUESTION·ANSWER의 기존 조건은 유지한다. DB CHECK와 web/local validator를 함께 갱신한다. PEER payload·run·attempt·receipt JSON에는 새 필드를 넣지 않는다.
- 적용된 migration 001–006은 수정하지 않는다. private schema 접근 차단·security definer의 빈 search_path·Auth와 기기 RPC 권한·공개 RLS를 유지한다. 되돌리기는 새 기능을 차단하는 forward migration이며 이미 저장한 질문·시도·이력을 삭제하지 않는다.

> 검증: 기존 데이터의 새 DB 변경 적용, 이력·UNKNOWN receipt 보존과 모드·source·null·RLS 검사를 소유 로컬 DB에서 확인했다. web/local 계약 mirror와 관련 단위 검사를 통과했다. 독립 구현 리뷰는 Step 4에서 마친다.

### [x] Step 2: 사람 admission과 한 대상의 실행·채택
**File**: 새 migration

- 기존 guard → 조직/방 scope 잠금 → workflow 방 잠금 순서를 사용한다. `ask`는 웹 Auth의 실제 참가자 권한을 확인한다. observer·비멤버·다른 방·자기 소유 대상으로의 직접 질문을 거절한다. 질문자 기기/binding은 조회 조건에 넣지 않는다.
- 대상의 현재 소유자·방·기기·epoch·live membership과 유효한 reported readiness를 확인한다. 등록만으로 ready를 만들지 않는다. 기존 connector의 owner-confirmed public scope와 읽기 전용 실행 준비를 사용하며 질문자 요청으로 범위를 넓히지 않는다. readiness는 소유자가 인증한 보고이며 독립 native 호환성 인증이라고 표시하지 않는다.
- `ask`와 기존 `start`, `pause`, 권한 취소·교체의 경합은 같은 잠금으로 직렬화한다. 방이 ACTIVE이고 기존 QUEUED/LEASED/RUNNING/UNKNOWN·미해결 attempt·ACTIVE cycle이 없을 때만 기존 현재 cycle을 보관하고 DIRECT cycle·generation·HUMAN 질문·PEER 요청·영속 이벤트·receipt를 함께 만든다. 기한은 cycle 한도와 기존 질문의 120초 한도 중 짧은 값이다.
- 인간 operationId/action/정규화 payload hash의 기존 receipt를 재사용한다. 동일 요청의 응답 유실·재접속은 같은 질문·request를 반환한다. 다른 문구·대상으로 operationId를 재사용하면 CONFLICT다. 현재 방·참가자 권한은 replay에도 다시 검사한다. 거절·미확정 전송을 새 operation으로 자동 재시도하지 않는다.
- DIRECT는 기존 PEER의 poll/claim/start-intent/lease/complete/observe·control·journal 흐름으로 실행한다. server `question`과 로컬 PEER callback에서 추가 질문을 거절한다. origin request와 CONTINUATION은 생성하지 않는다.
- `reconcile`, 결과 adoption, `advance`, receipt `restore`는 DIRECT에 한해 질문자의 현재 참가자 권한과 실제 대상 epoch·현재 room revision/generation/deadline을 확인한다. 요청자 권한 상실은 binding 검사를 대신할 수 없다. 종결 사실과 현재 결과 채택을 구분한다. 현재 credential·기기·agent epoch가 유효한 늦은/UNKNOWN 업로드만 중앙 HISTORICAL로 저장한다. 취소된 대상·옛 epoch 업로드는 기존 gateway에서 거절하고 로컬 저널에 증거를 보존한다. 이를 위해 기존 인증·epoch 검사를 완화하지 않으며 자동 실행을 만들지 않는다.
- 정상 PEER 완료와 유효한 질문/attempt·확인된 종결에만 답변을 채택하고 DIRECT cycle을 완료한다. 기존 PENDING→ACCEPTED 답변 이벤트 의미를 유지한다. 실패·중단·기한·권한 상실은 기존 HUMAN_INPUT_REQUIRED/UNKNOWN 보호를 사용한다. DIRECT에 cycle resume을 허용하지 않는다. 답변 채택과 state 변화가 receipt replay로 새 호출을 만들지 않아야 한다.
- 일반 방 pause·기기 취소·교체 보호는 공통 requests/attempts에서 직접 작업도 본다. 미실행은 취소하고 이미 intent가 있는 불확실한 실행은 UNKNOWN·제한된 중단 경로로 보존한다. 오래된 callback과 업로드가 새 질문 결과로 채택되지 않는다.

> 검증: 실제 로컬 Auth·DB·HTTP에서 질문자 기기·AI 없이 접수하고 가짜 provider로 대상만 실행했다. 기존 양방향 흐름·멱등 회복·권한 취소·UNKNOWN 보호도 확인했다. 실제 provider와 두 PC 검증으로 확대하지 않는다.

### [x] Step 3: 질문자와 대상 소유자의 한정된 중단
**File**: 새 migration, contracts

- 기존 자기 binding용 `interrupt`는 그대로 둔다. 새 `cancel`은 지정한 DIRECT request 하나에만 적용한다. 현재 방 participant이면서 cycle의 실제 질문자 또는 대상 binding 소유자인 경우만 허용한다. alias나 client flag를 권한으로 쓰지 않는다.
- 다른 사람의 질문·다른 방·AI_PAIR·후속 교체의 다른 실행을 취소하지 못한다. request의 고정 대상 epoch와 기존 attempt/fence를 대조한다. QUEUED면 CANCELLED, 시작 가능성이 있는 작업이면 기존 control을 만들고 실제 종결을 기다린다. ACK만으로 완료하지 않는다. UNKNOWN에서 취소 요청을 했다는 이유로 새 호출을 허용하지 않는다.
- 같은 operation의 취소 replay와 자연 완료 경합을 내구 receipt로 처리한다. 이미 종결된 request는 `NO_ACTIVE_RUN`이며 현재 다른 request의 중단으로 전환하지 않는다. 방 전체 pause와 구분한다.

> 검증: 실제 로컬 Auth·DB·HTTP에서 질문자/대상 소유자의 범위가 한정된 취소, 같은 operation 회복과 ACK/실제 종결 구분을 확인했다. 가짜 provider를 사용했다.

### [x] Step 4: 자기 AI 없는 질문 화면과 검증·문서
**File**: investigation-view, 관련 tests/fixtures/docs

- 사람의 상대 AI 질문을 별도 폼으로 제공한다. 질문자의 AI·경로·모델 선택을 요구하지 않는다. ready이며 다른 소유자인 대상이 정확히 하나면 제안한다. 여러 연결이면 명시 선택한다. 사람·runtime·저장소·session 별칭과 준비 상태를 보여주고 선택한 agent/epoch를 제출 시 고정한다. 절대 경로·인증정보는 공개하지 않는다.
- AI_PAIR의 기존 시작·재개 폼을 유지한다. 직접 질문에는 질문·답변·대상 상태와 `canInterrupt`에 따른 취소/중단 요청을 표시한다. 실제 종결·UNKNOWN·기한·대상 offline 상태를 표시한다. 일반 공동 발언·개인 설명을 AI 실행 요청으로 바꾸지 않는다.
- 미확정 ask/cancel에는 같은 operation과 정확한 본문을 유지한다. Step 5의 사용자 식별자와 방 ID로 저장·복원을 구분한다. history polling의 gap·중복·재접속 복원을 재사용한다. 새 동작을 읽지 못하는 구형 웹은 새 bundle로 갱신해야 한다. 기존 AI_PAIR 응답과 로컬 PEER wire가 유지되는 범위를 검사하고, 모든 구형 클라이언트에 새 HUMAN 이력을 지원한다고 주장하지 않는다.
- 관련 검사를 통과하고 독립 reviewer가 인증·권한·migration·공개 계약과 기존 실행기 재사용을 확인한다. 결과 수치·남은 Claude/두 PC 범위는 delivery 정본에만 유지한다. 단계별 진행 표시를 갱신하고 완료된 명세를 규칙대로 보관한다.

### [x] Step 5: 계정 전환 뒤 이전 질문의 재전송 차단
**File**: page, investigation-view, 두 contracts mirror, 신규 SQL008

- 페이지의 서버 인증 사용자 ID를 `userId` prop으로 전달한다. 저장 키는 사용자 ID와 방 ID를 포함한다. 복원한 `ask/cancel` 본문의 `expectedUserId`가 현재 prop과 같아야 한다. 예전 방 ID만 있는 저장 항목은 재전송하지 않고 제거한다. React key만으로 저장소 격리가 된다고 판단하지 않는다.
- `ask`와 `cancel` 본문에 UUID `expectedUserId`를 필수로 추가한다. 이 필드는 로그인 주체가 바뀌지 않았다는 사전 조건이며 대리 실행 권한이 아니다. 서버는 현재 `auth.uid()`가 없으면 UNAUTHENTICATED, 불일치하면 FORBIDDEN을 반환한다. 다른 사람의 식별자로 질문하거나 중단할 권한을 만들지 않는다. 다른 탭에서 쿠키가 바뀌어도 이전 화면의 본문이 접수되지 않아야 한다.
- SQL008의 private helper가 원본 본문의 16KiB 크기 상한과 정확한 새 필드를 검증하고 현재 Auth를 대조한 뒤 `expectedUserId`를 제거해 기존 `workflow_private.human`에 위임한다. 필드 제거 뒤의 크기만 검사하지 않는다. 공개 `workflow_human_ask/cancel(jsonb)` 두 wrapper만 새 helper로 연결한다. 기존 `validate/human`을 rename하거나 재귀적으로 교체하지 않는다. SQL007의 재검증, trim, 실제 Auth actor 기준 receipt key와 payload hash, 방·대상·attempt/fence 검사를 그대로 사용한다.
- 새 helper는 SECURITY DEFINER와 빈 search_path를 사용하고 public·anon·authenticated에서 직접 호출하지 못하게 한다. 공개 wrapper의 기존 authenticated grants를 유지한다. 원래 AI_PAIR 사람 RPC와 기기 PEER wire는 바꾸지 않는다. 아직 배포하지 않은 직접 질문 웹과 신규 본문을 함께 갱신한다.
- SQL008에 `workflow_private.questions(cycle_id)` 일반 B-tree 인덱스를 추가한다. HUMAN/PENDING 부분 인덱스로 모든 모드의 질문 이력 조회가 지원된다고 판단하지 않는다. 대량 성능 수치를 추정하지 않고 실제 인덱스 정의와 관련 query plan을 검사한다.
- 같은 탭 A→로그아웃→B, 재개된 A 화면의 쿠키만 B로 변경, 잘못된 expectedUserId의 ask/cancel을 실패 재현 후 검사한다. A의 첫 실행이 종결되고 대상·revision이 그대로여도 B가 A의 intent를 재전송할 수 없어야 한다. 같은 A의 응답 유실·reload·동일 operation 회복은 유지한다. 직접 질문과 기존 양방향 검사를 새 계약에서 확인한 뒤 Step 4를 닫는다.

## Tests

1. `should admit a human question without a requester device or agent` — 실제 로컬 Auth/DB/HTTP scene에 질문자 profile/device/root/runtime이 없고 대상만 준비. HUMAN 질문·PEER 요청 1개, origin/continuation 0개.
2. `should preserve paired workflow and peer wire compatibility` — 기존 AI_PAIR JSON·ORIGIN→PEER→CONTINUATION, old PEER payload/claim/terminal receipt와 기존 journal 검증 유지. mirror byte parity와 fixture actions 추가.
3. `should reject observer forged actors and invalid direct targets` — 비멤버·observer·다른 방·자기 대상·옛 epoch·offline/unready·추가 origin/owner/경로 필드·잘못된 Unicode/UTF-8·본문 상한 거절.
4. `should replay the same direct admission without executing twice` — 응답 유실·동시 접수·다른 payload/target의 같은 operation, 기존 start/pause와 양방향 경합, read cursor 복원.
5. `should execute only the selected responder and never continue automatically` — 실제 coordinator + 합성 owned adapter/runner. provider starts 1, 질문자 starts 0, 추가 ask_peer 로컬·서버 거절, same question 답변의 PENDING/ACCEPTED와 추가 질문/continuation 0.
6. `should protect direct results after requester or target revocation` — 질문자 역할/회원 제거·방 revision 변경·기한 뒤 현재 대상 권한의 결과는 historical. 취소된 대상·옛 epoch 업로드는 401/403/CONFLICT의 기존 권한 경계에서 거절하고 로컬 종결·outbox를 보존. 회전된 현재 유효 credential의 exact 회복, UNKNOWN 보호·교체·새 호출 차단.
7. `should cancel only the caller's direct request or their owned responder request` — 큐 취소·active matching control·ACK/종결 분리·자연 완료 경합·멱등 replay·이미 끝난 request, 다른 질문·AI_PAIR·다른 fence 중단 거절.
8. `should retain ambiguous direct attempts without automatic retry` — intent/ACK/종결/업로드 유실과 재시작. 일반 room resume·새 질문·context 교체로 UNKNOWN을 우회하지 않음; typed 관찰은 historical.
9. `should show a direct question form without an own AI connection` — browser에서 질문자 연결 없음, 단일 기본 대상/복수 명시 선택, 대상 교체·offline 표시, 제출/답변/재접속·한글/키보드 조작·observer read-only·한정된 중단.
10. `should upgrade legacy workflow storage without fabricating an origin` — 새 설치와 기존 001–006 데이터 upgrade, 모드별 null 제약·직접 generation/source·한 질문/한 run·중복 회복·RLS와 기존 개인 정보 비공개.
11. `should isolate unresolved direct intents across authenticated users` — 같은 탭 계정 전환 뒤 이전 질문을 복원·접수하지 않음. 같은 사용자의 reload/동일 operation 복원은 유지.
12. `should reject a stale direct actor precondition after a cookie change` — 기대 사용자와 현재 Auth가 다른 ask/cancel은 질문·request·control·receipt를 추가하지 않음. 클라이언트 식별자를 권한으로 사용하지 않음.
13. `should preserve existing direct receipts when adding the actor precondition` — SQL007에 저장한 기존 이력·receipt를 보존하고 SQL008 뒤 현재 같은 사용자로 exact replay 가능. old body에서 새 필수 조건 누락은 거절. 일반 cycle 인덱스와 private helper grants 검사.

## Risks

- 직접 발신자는 사람이다. 기존 PEER 실행 재사용과 질문자의 존재를 혼동하면 가짜 origin 또는 권한 확대가 생긴다. 모드·source·actor를 저장하고 양쪽에서 검증한다.
- 현재 readiness는 소유 connector의 보고다. 별도 서버 scope 인증을 새로 추가한 것으로 표현하지 않는다. 기존 로컬 사전 확인과 허용한 scope를 유지한다.
- public history의 새 cycle/HUMAN QUESTION은 구형 웹 parser가 읽지 못한다. AI_PAIR와 로컬 실행 DTO를 유지하고 새 웹을 함께 배포해야 한다. runtime 저널의 기존 PEER 계약이 변경되면 재사용 전제를 재검토한다.
- SQL의 shared lifecycle 변경은 기존 paired 업무도 영향을 받는다. 적용한 SQL을 덮지 않고 upgrade·paired 회귀·직접 권한 경합을 검증한다.
- 현재 한 방 한 작업이다. 여러 동료의 동시 질문 대기열은 별도 요구로 다루고, 이 단계에서 기존 충돌 보호를 완화하지 않는다.

## Verification

- Node 24의 기존 root/connector typecheck·lint·build·unit과 integration compile. 새 실험은 import하지 않는다.
- 소유 loopback stack에 새 migration을 additive 적용하고 기존 device/workflow/runtime integration 및 workflow browser 검사와 새 direct scene을 실행한다. 기적용 SQL·DB reset·원격 운영 접근은 금지한다.
- 변경 없는 Auth·다른 e2e·Claude 실험의 PASS는 해당 코드와 입력 hash가 같을 때만 재사용한다. 위험 표면과 영향받은 shared 계약은 새 독립 리뷰를 수행한다.
- synthetic provider 검사와 actual native·두 PC 결과를 구분한다. 이 단계의 가짜 provider 검사를 실제 Claude나 두 PC 증거로 보고하지 않는다.
- 문서 링크·contract mirror·동결 archive·migration baseline 검사를 수행한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan round1: revoked/old-epoch result boundary | MEDIUM | ACCEPTED — CORRECTED | 기존 RPC의 current credential·agent epoch 검사에서 거절되는 업로드와 현재 권한으로 중앙 HISTORICAL을 저장하는 결과를 Step 2와 Tests 6에서 구분했다. 권한을 완화하거나 추가 운영 파일을 넣지 않는다. |
| Independent plan round1 | INFO | PASS WITH MEDIUM CORRECTION | C0/H0/M1/L0. reviewer가 운영 4개와 exact PEER DTO·실행기 재사용 가능성을 확인했다. 계획 검토이며 실제 동작 완료의 증거가 아니다. |
| Implementation source2 H1: actor-free browser intent | HIGH | ACCEPTED — RESOLVED | Step 5에서 사용자별 저장과 서버의 현재 Auth 사전 조건을 함께 확인한다. 운영 6개 보정 계획은 독립 검토와 사용자의 진행 지시 후 구현했다. source6에서 사용자·방 저장 키와 서버 Auth 사전 조건을 검증했고 실제 계정 전환 검사도 통과했다. |
| Implementation source2 M1: cycle question scan | MEDIUM | ACCEPTED — RESOLVED | SQL007을 보존하고 SQL008의 일반 cycle 인덱스 정의와 실제 query plan을 검사했다. |

| Independent implementation source6 | INFO | PASS | C0/H0/M0/L0. 인증 사전 조건·원본 본문 크기·권한·기존 함수/receipt 보존·일반 인덱스를 독립 검토했다. 동일 소스의 실제 새 DB 변경 적용, Auth/DB/HTTP, desktop/mobile 검사를 통과한 뒤 2026-10-03 종료했다. Claude 제품 연동·두 PC 완료의 증거는 아니다. |
