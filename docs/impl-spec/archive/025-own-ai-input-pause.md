---
status: done
date: 2026-10-06
completed: 2026-10-08
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code. Current implementation and acceptance must be verified separately.

# 내 AI의 새 답변 일시정지

## Context

[업무 규칙](../../BUSINESS-LOGIC.md#일시정지중단방향-수정)은 본인 AI의 새 입력 일시정지와 방 전체의 정지, 실행 중인 답변의 중단을 구분한다. 현재 실제 채팅 경로에는 본인 binding의 새 실행만 막는 제어가 없다. `RuntimeAdmission.pause()`는 실행 중 도구도 거절하고 `WorkflowRunner.stop()`은 실제 provider 중단을 요청하므로 이 기능에 재사용하지 않는다.

전체 구현을 계속하라는 기존 승인으로 이 계획을 작성하고 독립 리뷰 후 구현한다. 2026-10-07 사용자는 사람의 상대 AI 질문·답변과 같은 대화 후속 질문을 우선 확정했다. 개인 설명의 저장과 자동 공동 조사의 방향 수정은 후속 기능이며 기본 채팅의 선행 조건이 아니다. 이 계획은 그 두 기능이나 실제 Claude 수용을 대체하지 않는다. 기존 실제 입력 예산, 개인 설정·인증과 미확인 native 실행 제한을 바꾸지 않는다.

범위 조사는 `remaining_private_explanation_scope`의 실제 경로·역참조 및 미시작 증거 조사 결과를 사용한다. 기존 조사와 이후 총괄 보정을 구분한다. 조사에서 발견한 거절 응답 유실 뒤 재개 경합은 아래의 내구 거절 receipt로 해결한다.

완료 기준:

- 본인 AI가 있는 사람은 실제 AI 채팅방에서 새 답변의 일시정지·재개를 선택한다. 본인 AI가 없는 질문자에게 설정이나 제어를 요구하지 않는다.
- 새 실행의 허용 경계는 DB의 최초 성공 `claim` commit이다. 일시정지 전에 실행 준비를 허용한 `LEASED`/`EXECUTING` 답변은 계속한다. 웹에 “이미 실행 준비를 시작한 답변은 계속됩니다”를 표시한다. 이 적용 보고는 모든 native 입력 전송이 끝났다는 증거가 아니다.
- 일시정지는 본인 `agentId`의 desired 상태를 바꾼다. 방 revision, binding epoch, 현재 설정 generation과 공동 event/transcript를 바꾸지 않는다. 같은 agent의 설정 교체 뒤에도 desired 상태를 유지하며 이전 epoch의 ACK는 새 epoch에 적용하지 않는다.
- 서버에 저장한 요청과 현재 epoch의 연결 프로그램 적용 보고를 구분한다. 오프라인에서 요청만 받았는데 적용 완료라고 표시하지 않는다. 본인 재개는 방 `PAUSED`를 해제하지 않는다.
- 이미 허용한 답변의 도구·lease·native ACK·중단 ACK·종결·UNKNOWN 관찰·기존 outbox를 유지한다. 제어 조회 장애와 오래된 revision ACK는 새 실행만 막는다.
- 일시정지로 거절한 claim의 원래 operation/body에 내구 거절 receipt를 남긴다. 응답을 잃고 재개한 뒤에도 같은 claim을 새로 허용하지 않는다. 확정 거절만 미시작 증거이고 timeout·잘못된 envelope·불확실한 저장은 UNKNOWN이다.
- 기존 v1 poll, 성공 claim/start-intent/lease와 종결 receipt의 exact-key 계약을 유지한다. 실제 DB·HTTP·브라우저 회귀와 독립 구현 리뷰까지 끝나야 이 계획을 완료 보관한다.

## Contract and Admission Boundary

기존 HTTP route의 action 목록을 확장한다. protocol은1이며 기존 action의 body와 response는 변경하지 않는다.

| action | 요청 필드 — protocol 외 | 성공 응답 |
|---|---|---|
| 사람 `input-state` | roomId | roomId, bindings: 본인 InputState 목록 최대20개 |
| 사람 `input-control` | roomId, expectedUserId, operationId, agentId, bindingEpoch, expectedRevision, paused | InputState — 해당 operation 당시 receipt |
| 기기 `admission` | agentId, bindingEpoch | InputState — 현재 desired/applied |
| 기기 `admission-ack` | agentId, bindingEpoch, revision, paused | InputState — 정확한 현재 revision/epoch 적용 보고 |

`InputState`의 필드는 `agentId`, `bindingEpoch`, `revision`, `paused`, `appliedRevision`, `appliedEpoch`, `appliedAt`이다. applied 세 필드는 함께 null 또는 함께 값이 있어야 한다. 현재 revision과 epoch가 맞지 않은 과거 ACK는 현재 response에서 null로 투영한다. revision/epoch는 안전한 양의 정수다. 목록은 중복 agent를 거절한다. 응답에는 경로·기기 credential·개인 설정·공동 본문을 넣지 않는다.

없는 desired 행의 기본값은 revision1, paused=false, applied=null이다. 최초 read는 이 기본값을 투영할 수 있으며 설정 생성이나 준비 완료를 의미하지 않는다. 사람이 값을 바꾸면 expectedRevision 비교 후 revision을 증가시키고 ACK를 비운다. 같은 값의 확인은 새 실행이나 설정을 만들지 않는다. 기기 ACK는 동일 revision/epoch/paused에 대해 반복해도 같은 저장 결과를 반환한다. stale ACK는 CONFLICT이고 새 실행 gate를 열 수 없다.

확정 claim 거절은 기존 고정 HTTP 오류 envelope의 `INPUT_PAUSED`/409다. DB RPC 내부 marker는 정확히 `{ "claimDenied": "INPUT_PAUSED" }` 한 필드이며 claim에서만 허용한다. 웹은 이 marker를 검사해 HTTP 오류로 바꾸며 성공 claim response로 반환하지 않는다. 다른 action·추가 필드·알 수 없는 marker는 UNAVAILABLE이다.

## Affected Files

1. `src/features/investigation-coordinator/contracts.ts`, `packages/local-connector/src/workflow-contracts.ts` — 네 action·InputState·고정 오류와 exact 검증을 함께 추가한다.
2. `src/features/investigation-coordinator/service.ts` — 사람 RPC의 hyphen을 underscore로 변환하고 기기 claim의 내구 거절 marker를 검증한다.
3. 신규 `src/features/investigation-coordinator/rpc-response-policy.ts` — server-only service와 단위 검사가 같은 좁은 DB response 해석 함수를 사용한다.
4. 신규 `supabase/migrations/20261006001100-own-ai-input-pause.sql` — 본인 desired/applied, 기존 receipt에 내구 claim 거절, 권한 RPC와 신규 attempt 제한을 추가한다.
5. 신규 `packages/local-connector/src/workflow/input-admission.ts` — 버전·epoch를 확인하는 새 실행 gate. 기존 도구 admission과 분리한다.
6. `packages/local-connector/src/workflow-runner.ts` — gate 조회·보고, readiness, 최초 claim 거절과 exact 복구를 연결한다.
7. `packages/local-connector/src/runtime-contracts.ts`, `packages/local-connector/src/runtime-store.ts` — 세 번째 미시작 증거와 국소 관계·전이 검증을 추가한다.
8. 신규 `src/features/investigation-coordinator/own-input-controls.tsx`, `own-input-control-state.ts` — 본인 버튼·요청/적용 표시·원래 intent 재전달을 구현한다.
9. `src/features/investigation-coordinator/investigation-view.tsx` — 본인 binding이 있을 때 제어를 표시한다. 채팅·직접 질문·공동 기록은 기존 컴포넌트를 사용한다.
10. `tests/helpers/workflow-fixture.ts`, `tests/helpers/runtime-settings-fixture.ts`와 관련 unit/connector/integration/e2e 검사 및 주제별 정본 문서 — 실제 fixture의 새 action 분류·receipt 복구·소유 정리와 아래 Tests/Verification을 따른다. warm upgrade의 실행 진입은 별도 `tests/integration/own-ai-input-upgrade.test.ts`에 둔다.

## Affected Dependents

- `src/app/api/investigations/[action]/route.ts`, `src/app/api/workflow/[action]/route.ts` — 현재 allowlist와 readWorkflow를 계속 사용한다. Origin·cookie·bearer·오류 response 경계를 우회하지 않는다.
- `investigation-client.ts`, `workflow-client.ts` — 기존 bounded UTF-8/JSON와 envelope 검사, timeout, 고정 API 경로를 사용한다.
- `runtime-store.ts`의 기존 operation action 목록은 확장하지 않는다. admission ACK는 native 실행 의도가 아니며 별도 중앙 idempotency로 처리한다.
- `settings/manager.ts` — 기존 persistent runner, 설정 reservation 및 unresolved 대기를 유지한다. pause를 stopRunner나 설정 generation 교체로 구현하지 않는다.
- `codex-adapter.ts`, `claude/adapter.ts`, `provider-adapter.ts` — native beforeSubmit·도구·중단·policy/history 계약은 변경하지 않는다. 허용 경계를 claim으로 두므로 새 native 직전 취소를 추가하지 않는다.
- SQL006/007의 claim receipt replay·lease·종결·관찰, SQL008의 actor 조건, SQL009의 회사 입장 및 SQL010의 설정 예약/commit — 원래 scope→room 잠금 순서와 현재 권한 검증을 보존한다. 과거 migration 파일은 수정하지 않는다.
- `runtime-archive.ts`, `workflow/local-removal.ts`, CLI의 관찰/제거 — NOT_STARTED 불변 증거와 UNKNOWN 보존을 계속 사용한다.
- `runner-fixture.ts`, 설정 fixture 및 실제 workflow fixture — admission의 기본 open 상태를 제공하되 기존 native/receipt 기대값을 낮추지 않는다.

## Implementation Steps

### [x] Step 1: 소유자 제어와 원자적인 새 claim 제한
**File**: 두 contracts, service.ts, 신규 rpc-response-policy.ts, 신규 migration011

소스와 단위 검사를 완료했다. 실제 migration 적용·DB 권한과 잠금 회귀는 Step4에서 확인한다.

- 기존 shape/check 패턴으로 네 action과 InputState를 exact 검증한다. 사람 control의 expectedUserId는 현재 Auth actor와 일치해야 하며 권한으로 신뢰하지 않는다. input-state는 본인 binding만 반환한다. observer·다른 소유자의 binding·탈퇴·취소 기기·오래된 epoch는 실제 기존 live 검사로 거절한다.
- 신규 private schema의 desired/applied 행은 agent FK와 room scope를 사용하고 private table/function 권한을 revoke한다. 공개 human RPC는 authenticated만, 기기 RPC는 유효한 bearer를 검사하는 기존 anon RPC 방식만 허용한다. search_path를 비우고 입력을 SQL 문자열에 보간하지 않는다.
- 현재 `runtime_settings_private.live_device`와 기존 actor/live/room 권한, scope→room 잠금 순서를 재사용한다. 사람 control·기기 ACK·최초 claim은 SQL010 설정 apply/commit과 같은 방 잠금으로 직렬화한다. epoch 변경은 desired를 유지하되 applied projection을 무효화한다.
- 사람 mutation의 원래 operation/body는 내구 receipt로 기록한다. 중복은 동일 요청의 receipt만 반환하고 다른 본문 재사용은 CONFLICT다. receipt 재전달 전에도 현재 actor·membership·소유 scope를 검증한다. 오래된 receipt를 현재 적용 상태로 채택하지 않는다.
- `public.workflow_device_claim`을 신규 private claim 함수로 연결한다. 기존 `workflow_private.device('claim',...)` 본문은 수정하지 않는다. body·현재 기기·agent/epoch·request scope를 검증하고 잠금을 얻은 뒤, 원래 성공 receipt가 있으면 기존 core replay를 따른다.
- 거절도 기존 `workflow_private.receipts`의 `(room_id, actor_kind='device', actor_id, operation_id)` 키에 `action='claim'`, 기존 JSONB 본문 payload_hash와 정확한 marker로 저장한다. 별도 denial table을 만들지 않는다. 새 private claim 함수는 현재 Auth/scope/epoch/request를 확인한 뒤 이 기존 ledger에서 원래 receipt를 검증한다. 성공 claim이면 원래 core replay를 따르고 정확한 거절 marker면 그대로 반환한다. pause가 먼저 commit하면 denial을 commit하고 marker만 반환한다. claim이 먼저 성공하면 이후 pause에서도 그 receipt·start-intent·lease는 유효하다. denial의 SQL raise로 저장을 rollback하지 않는다. 재개 후 exact denial replay는 계속 INPUT_PAUSED다.
- 거절된 claim의 operation은 기존 ready/lease/complete 등 다른 device action에서도 이미 사용한 키로 취급한다. 기존 receipt와 action·hash가 다르면 양쪽 방향 모두 CONFLICT다. 신규 migration에서 현재 SQL007의 `restore(text,jsonb)` 구현을 private 원래 함수로 보존하고, 새 restore는 claim의 정확한 marker만 반환하며 다른 모든 분기는 그 원래 함수에 위임한다. public claim wrapper도 marker receipt를 직접 검증하여 반환한다. 기존 성공 snapshot·DIRECT 종결·adoption 복원과 원래 core 본문은 보존한다. 이미 호출한 DB 함수에 migration을 적용한 upgrade 회귀도 검증한다.
- BEFORE INSERT attempts 방어는 request→agent의 현재 paused를 같은 잠금 순서로 확인해 신규 생성만 거절한다. 기존 attempt update/lease/종결은 제한하지 않는다. 신규 행/receipt는 기존 FK 삭제와 scope 수명을 따른다. 상태·receipt의 영구 용량과 재전달 의미는 기존에 없던 자동 삭제/재사용으로 약화하지 않는다.
- 단위 검사는 marker를 HTTP 오류로 해석하는 실제 helper를 import한다. SQL fixture 작성과 실제 적용/실행은 구분한다. migration 실행이 불가능하면 Step4의 검증을 완료했다고 표시하지 않는다.

### [x] Step 2: 새 입력 gate와 미시작 증거의 내구 복구
**File**: 신규 input-admission.ts, workflow-runner.ts, runtime-contracts.ts, runtime-store.ts, connector tests/fixture

소스와 새 기능 대상 검사를 완료했다. 전체 connector 검사의 기존 취소 항목과 실제 실행 검증은 Step4에 남긴다.

- 새 gate의 초기값은 닫힘이다. 현재 agent/epoch를 확인한 admission 조회와 정확한 ACK 이후에만 새 claim을 허용한다. revision은 단조롭게 채택하고 같은 revision의 모순·오래된 응답·다른 scope·ACK 손실은 닫힌 상태를 유지한다. 입력 제어는 context generation을 바꾸지 않는다.
- 최초 runner 시작과 새 execute 진입 전에 gate를 확인한다. 기존 recover/observe/terminal outbox를 gate 때문에 생략하지 않는다. 프로세스 재시작에서는 중앙 desired를 다시 조회하고 현재 epoch를 ACK한다. 이전 ready:true receipt만으로 gate를 열지 않는다.
- idle loop와 active monitor의 제어 확인을 같은 module에 맡긴다. active native 실행 중에도 2초 이하 간격으로 적용 보고가 가능해야 한다. 요청을 겹쳐 보내지 않고 종료 후 늦은 응답으로 gate를 열지 않는다. 제어 조회·stale ACK 실패는 기존 monitor의 stop 경로에 전달하지 않는다. 기존 credential·poll·lease의 실제 권한 상실 판단은 유지한다.
- ready 값은 기존 방 ACTIVE·capacity와 새 gate를 함께 사용한다. 본인 resume 후에도 room PAUSED를 재개하지 않는다. 새 gate를 `RuntimeAdmission.pause/assertTool`, active authority, lease, native ACK 또는 terminal publication의 조건으로 사용하지 않는다.
- `unstartedClosure`에 `{ kind: 'SERVER_INPUT_PAUSED', claimOperationId }`를 추가한다. 정확히 TRANSMITTED/null-result claim과 같은 scope/request/opID이고 snapshot·nativeIntent·native·terminal·receipt·도구가 없을 때만 저장한다. proof와 원래 claim CLOSED를 한 mutation에서 저장한다. 성공 claim이나 PENDING claim에 붙일 수 없다. 기존 record v1/v2·NOT_STARTED·CLOSED 형식과 불변 전이를 유지한다.
- 최초 `transmit(claim)`의 확정 INPUT_PAUSED와 `recoverUnstarted`의 원래 claim replay 거절에서만 이 proof를 만든다. execute 전체 catch나 다른 action의 오류를 미시작 증거로 쓰지 않는다. 저장 실패·timeout·잘못된 envelope는 UNKNOWN으로 남기고 새 native 입력을 자동 실행하지 않는다.
- 기존 성공 receipt는 paused 상태에서도 성공 snapshot으로 복구한다. 새로운 claim의 응답이 LEASED인 경우 기존 복구 기준을 유지한다. 새 proof로 기존 snapshot이나 성공 receipt를 덮어쓰지 않는다. sealed claim은 재전송하지 않고 이후 재개 실행은 새 operation을 사용한다.
- admission read/ACK는 기존 runtime operations에 기록하지 않는다. 동일 revision/epoch의 반복 ACK를 중앙에서 idempotent하게 처리하고 native journal 용량·종결 예약을 소모하지 않는다.

### [x] Step 3: 실제 채팅방의 본인 제어와 요청 상태
**File**: 신규 own-input-controls.tsx, own-input-control-state.ts, investigation-view.tsx, unit/e2e tests

소스와 서비스·컴포넌트 회귀 검사를 완료했다. 실제 브라우저 수용은 Step4에서 확인한다.

- 실제 채팅 화면에서 본인 binding이 있을 때만 각 AI 별칭과 일시정지/재개 버튼을 표시한다. shadcn Button과 기존 화면 간격·색상·접근성 패턴을 사용한다. 중단 버튼이나 방 정지를 이 버튼으로 바꾸지 않는다.
- “요청됨 · 연결 프로그램 대기”, “일시정지 적용 보고”, “재개 적용 보고”, “상태 확인 불가”를 구분하고 실행 준비 중인 답변 유지 설명을 표시한다. 현재 revision/epoch의 ACK가 없으면 적용 완료로 표시하지 않는다. 경로·내부 receipt·policy 구현 상세는 UI에 노출하지 않는다.
- 본인 상태 조회는 방별 한 요청으로 묶고 visible/hidden·실패 backoff는 기존 polling policy를 사용한다. 본문 이력 paging이나 다른 사람의 선택을 초기화하지 않는다. 다른 사람의 binding 제어·observer 제어를 렌더링하지 않는다.
- control intent를 현재 userId/roomId namespace에 보관하고 재시도·새로고침 뒤에는 같은 operation/body만 전송한다. expectedUserId·roomId·agentId·epoch·revision을 검증한다. 다른 사용자·방의 저장 intent를 채택하지 않는다. 알 수 없는 결과에서 새 operation을 자동 생성하지 않는다.
- read projection만으로 pending intent를 성공 처리하지 않는다. 현재 operation receipt를 확인한 뒤 pending을 정리한다. 오래된 epoch/revision receipt는 현재 제어 상태로 채택하지 않고 최신 상태를 조회한다. stale mutation은 자동으로 새 revision/body로 재시도하지 않는다.
- 실제 브라우저 회귀는 Step4에서 실행한다. 단위 state/helper 검사나 prototype 문자열을 실제 UI/AI 적용 증거로 삼지 않는다.

### [x] Step 4: DB·HTTP·브라우저 회귀와 종료 검토
**File**: tests/integration/own-ai-input-pause.test.ts, tests/integration/own-ai-input-upgrade.test.ts, tests/e2e 관련 workflow/settings 검사, 관련 정본 docs

> 검증 진행: 2026-10-08 환경 전환 뒤 실제 일시정지 DB·HTTP, 같은 backend의 SQL011 warm upgrade, desktop/mobile 제어 회귀를 통과했다. 원본 실패와 보정, fixture 정리 결과를 보존했다. 전체 연결기 검사와 영향 범위 종료 리뷰를 마치기 전에는 이 Step을 완료 표시하지 않는다. 공식 Claude·두 Mac은 022·030에서 별도로 수용한다.

- `WorkflowFixture.human/device`의 operation 분류에서 `input-state`, `admission`, `admission-ack`를 제외한다. `input-control`을 사람 actor로 분류하고 expectedUserId를 현재 fixture 회원으로 검증한다. 조회·ACK에 문자열 `undefined` operation을 기록하지 않는다. 원래 actor·scope·receipt 복구·owned 종료 검사를 약화하지 않고 새 receipt를 실제 소유자 scope로 정리한다. `RuntimeSettingsFixture`가 재사용하는 workflow fixture 및 실제 settings/browser fixture의 경로도 같은 분류를 사용하도록 대조한다.
- 기존 owned fixture에 migration011 적용/업그레이드, 실제 Auth·bearer·RPC·HTTP와 권한/잠금 회귀를 추가한다. 원래 core/restore를 호출한 뒤 migration을 적용한 경로도 포함한다. DB의 claim/pause commit 순서 양쪽을 실제 독립 connection과 barrier로 검증한다.
- warm upgrade의 별도 실행 진입은 owned001–010과 deferred receipt FK를 확인하고 같은 backend의 원래 core/restore를 먼저 호출한다. 기존 guard와 한 transaction에서 repository SQL011만 설치한 뒤 원래 receipt·함수 본문·이력을 대조하고 fixture를 정리한다. SQL011이 이미 설치된 DB를 초기화하거나 다시 적용하지 않는다. 경쟁 검사는 다른 요청의 잠금 대기 대신 정확한 두 connection PID의 대기로 양 commit 순서를 고정한다.
- 기존 성공 claim receipt와 내구 거절의 응답 손실/재개/replay, 서로 다른 본문 재사용, 오래된 epoch ACK, SQL010 apply/commit 경합을 검증한다. 원래 native 입력을 추가하는 테스트는 이 계획에서 승인하지 않는다.
- 실제 브라우저에서 버튼·요청/적용 표시·오프라인/재접속·새로고침 exact retry·방 PAUSED 유지·다른 사람 권한을 검증한다. /demo 검사를 제품 경로의 통과로 사용하지 않는다.
- 해당 source/inputs가 같을 때만 기존 Codex/Claude·중단·outbox·설정 검사와 리뷰를 재사용한다. 계약/runner/store가 변경되므로 connector 전체 및 root unit 검사를 새로 실행한다.
- ARCHITECTURE/BUSINESS-LOGIC/DB-SCHEMA/API-SPEC/FRONTEND-ARCHITECTURE의 관련 절, 사용자 안내와 delivery 정본을 갱신한다. 진행 수치·실제 검증 제한은 delivery 한 곳에 둔다. 022·009와 실제 Claude/두 Mac 미완료를 숨기지 않는다.
- 새 독립 reviewer가 인증·권한·migration·공개 계약·실행 복구·UI를 변경 diff와 검사 범위에 대조한다. 실제 검증이 남으면 source 검토 결과와 별도로 Step4를 미완료로 유지한다. 모든 필수 검증과 리뷰를 마친 뒤에만 done/archive한다. Git metadata가 계속 read-only이면 커밋·push·PR을 수행했다고 표시하지 않는다.

## Tests

- `tests/unit/workflow-contracts.test.ts`: 네 action의 웹/로컬 일치, unknown-field·actor 위조·중복 agent·부분 ACK·stale scope·원래15개 fixture의 exact 계약 유지.
- 신규 `tests/unit/own-input-control-state.test.ts`: revision 단조 채택, epoch ACK 무효화, actor별 intent, 손실 후 exact retry, stale receipt가 pending/current 상태를 확정하지 않음.
- 신규 `tests/unit/workflow-rpc-response-policy.test.ts`: claim 한정 정확한 denial marker, 다른 action/추가 필드 거절, 기존 정상 response 유지.
- 신규 `tests/unit/workflow-human-actor.test.ts`: 실제 service에서 같은 UUID의 대소문자 표현 허용·원래 본문 보존, 다른 actor의 RPC 전 거절.
- 신규 `tests/unit/own-input-controls.test.ts`: 실제 컴포넌트의 두 본인 binding에 저장소·세션 별칭과 동작을 연결하고 상태 설명을 구분한다. 브라우저 검사와 실행 범위를 구분한다.
- 신규 `packages/local-connector/tests/input-admission.test.ts`: 초기 닫힘, 정확한 ACK 뒤 open, pause→resume→pause의 늦은 조회/ACK, coalescing·조회 장애·종료 이후 응답.
- `packages/local-connector/tests/workflow-runner.test.ts`: paused restart·준비 보고/새 claim 차단, 이미 claim된 실행/파일 도구/lease/native ACK/중단 ACK/terminal/outbox 유지, 제어 조회 장애와 stale ACK가 stop하지 않음, 방 PAUSED 유지.
- 같은 runner 검사: 최초 확정 거절·응답 손실 뒤 exact replay·proof 저장 전/후 실패·sealed replay 금지·기존 성공 receipt replay·다른 action/잘못된 envelope의 UNKNOWN 유지. native 시작 횟수와 operation/body를 직접 검증한다.
- `packages/local-connector/tests/runtime-store.test.ts`: 새 proof의 v1/v2 저장·복원, PENDING/CONFIRMED/다른 op/snapshot/nativeIntent 위조 거절, proof 불변성과 원래두 proof/제거/보관 회귀.
- 신규 `tests/integration/own-ai-input-pause.test.ts`: 실제 owner/nonowner/observer/탈퇴/취소/old epoch 권한, DB 양쪽 commit 순서, 내구 denial·중복body 충돌·다른 action과 operation 재사용 양쪽 거절·실제RPC marker→HTTP 변환, room revision/epoch/generation/transcript 보존, SQL010 설정 경쟁. 실제 조회/ACK의 operation 미기록과 사람 control actor·fixture receipt 복구/종료도 검증한다.
- 신규 `tests/integration/own-ai-input-upgrade.test.ts`: 기존 owned001–010에서 같은 backend의 warm 함수와 UNKNOWN/DIRECT receipt를 보유하고 SQL011만 설치한 뒤 원래 결과·함수 본문·이력을 검증한다. 이미 설치된 SQL011은 reset·reapply 없이 실패한다.
- 기존 실제 workflow/settings 브라우저 검사: 본인별 버튼, 요청/적용 구분, refresh retry, scope 교체와 observer·모바일 접근성. 환경 미확인으로 실행하지 못한 검사는 통과/skip을 수용 근거로 사용하지 않는다.

## Risks

- 일시정지 ACK 뒤 이미 허용한 native 입력이 전송될 수 있다. 허용 경계를 최초 claim commit으로 고정하고 UI에 준비 중 답변 유지 조건을 표시한다. native 전송 직전 취소로 바꾸지 않는다.
- 오류를 SQL raise로만 돌려주면 거절 저장이 rollback되어 재개 후 replay가 새 attempt를 만들 수 있다. 내구 denial commit과 private marker 반환을 같은 transaction에서 처리한다.
- 제어 오류가 active monitor의 stop으로 전파되면 진행 중 답변을 잃는다. 독립 gate가 새 claim만 닫고 기존 scope/lease 검사는 그대로 유지한다.
- 오래된 epoch의 ACK와 새 설정이 경합할 수 있다. 같은 room 잠금과 현재 epoch 검사를 사용하고 projection/클라이언트 둘 다 과거 ACK를 채택하지 않는다.
- 거절 proof가 성공/미확인 실행을 숨길 수 있다. action·TRANSMITTED state·정확한 op/body·native 증거 부재를 저장 경계에서 검증한다.
- 추가 조회는 poll 부하를 늘린다. 본인 웹 조회를 방별로 묶고 connector 조회를 coalesce하며 고정2초 cadence와 기존 backoff/종료 경계를 사용한다. 전체 확장성을 합성 검사로 주장하지 않는다.
- 현재 격리 DB·브라우저·native 환경을 이용할 수 없다. 소스/합성 통과와 실제 수용을 분리하고 전체 제품을 완료로 표시하지 않는다.

## Verification

- Node24의 기존 npm CLI로 connector build/typecheck, 새 target test 및 전체 connector test 실행.
- root unit 전체, app/integration/e2e TypeScript compile, lint 최대경고0, format 및 format:check, `git diff --check`.
- 격리 DB 사용 가능 시 migration011 포함 실제 새 통합 검사와 원래 workflow/direct/settings 회귀 실행.
- 같은 owned web fixture에서 실제 workflow/settings browser 회귀 실행. 기존 preview 관찰 timeout만으로 서버를 재시작하지 않는다.
- 변경 inventory·SHA256·검사 로그·원래 통과 재사용 범위·fresh 독립 리뷰 결과를 기록한다. 실제 native·두 Mac·Git 작업0회를 숨기지 않는다.
- 구현 step과 Tests 정의 및 실제 실행 근거를 대조하고 상대 문서 링크를 확인한다. 미완료 검증이 있으면 active 상태를 유지한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 계획 리뷰1 H1: 별도 claim_denials가 기존 전 action operation 충돌 경계와 분리됨 | HIGH | ACCEPTED | 별도 테이블 대신 기존 workflow receipts에 같은 claim/hash/marker를 저장한다. restore의 marker 분기와 다른 action 재사용 양쪽 회귀를 Step1/4와 Tests에 반영했다. |
| 계획 리뷰1 H2: 실제 WorkflowFixture의 조회/ACK/사람 actor 분류 누락 | HIGH | ACCEPTED | affected files에 실제 두 fixture를 명시하고 Step4에 operation 없는 세 action 및 input-control actor/expectedUserId, receipt 복구/소유 정리와 settings 재사용 대조를 추가했다. |
| 구현 부분 리뷰1 H1: 본인 UUID의 대문자 표현을 HTTP에서 다른 actor로 판단 | HIGH | ACCEPTED · FIXED | 실제 humanWorkflow에서 같은 UUID를 허용하고 다른 actor는 거절하는 회귀를 먼저 재현한 뒤 보정했다. 현재 Auth UUID를 대소문자 무관하게 비교하며 원래 요청 본문은 유지한다. 전체 독립 구현 리뷰2가 보정을 확인했다. 실제 Auth/HTTP 수용은 Step4에 남아 있다. |
| 구현 부분 리뷰1 M1: 두 본인 AI의 버튼·적용 상태를 접근 가능한 이름으로 구분하기 어려움 | MEDIUM | ACCEPTED · FIXED | 두 binding의 실제 컴포넌트 회귀를 먼저 재현한 뒤 공개 저장소·세션 별칭을 버튼 이름과 상태에 연결했다. 전체 독립 구현 리뷰2가 보정을 확인했다. 실제 브라우저 수용은 Step4에 남아 있다. |
| 전체 구현 리뷰2 H2: 같은 action·operation에 다른 유효 본문을 보내는 충돌 회귀 누락 | HIGH | ACCEPTED · FIXED_SOURCE_ONLY | 내구 claim 거절과 사람 input-control에서 같은 operation·다른 유효 본문의 정확한 CONFLICT와 원래 receipt·attempt·desired revision 보존을 정의했다. 정확한 본문 replay·다른 action 충돌도 유지한다. 사용자 승인 추가 독립 리뷰가 정의 보완을 확인했으며 실제 DB 실행은 Step4에 남아 있다. |
| 전체 구현 리뷰2 I1: 원본·현재 전체 connector의 동일한 제거 검사 취소 | INFO | REJECTED · 025 신규 회귀로 기각 | 변경 전 입력·양쪽 실행 로그가 일치하며 같은 15초 검사가 양쪽에서 취소되었다. 전체 통과나 원인 해결로 표시하지 않고 원래 timeout·소유권·거절 assertion을 유지한다. |
| 전체 구현 리뷰2 I2: 최대 continuation의 간헐 UNKNOWN | INFO | 기존 미확인 문제 | 제한 비교에서 원본과 현재 모두 관측되었다. 원래 UPLOADED 기대값을 유지하고 credential cache 후보 제거를 원인 해결로 표시하지 않는다. |
| 전체 구현 리뷰3 H2: 신규 interrupt 검사 준비에 bindingEpoch·expectedRoomRevision 누락 | HIGH | ACCEPTED · FIXED_SOURCE_ONLY | 원래 리뷰 상한에서 미해결로 기록하고 2줄 보정안을 준비한 뒤 사용자가 두 값 보완과 독립 리뷰 1회 추가를 승인했다. 실제 소스·fixture·계약의 수정 전 INVALID_BODY 실패와 수정 후 통과를 보존했고 추가 독립 리뷰가 소스 해소를 확인했다. 역사적 REVISE 기록을 유지하며 실제 DB/HTTP 수용은 Step4에 남아 있다. |

## 2026-10-08 최종 수용과 보관

환경 전환 후 정의한 실제 DB·Auth·HTTP·브라우저와 같은 backend의 warm upgrade 검사를 실행했다. 원본 실패와 보정 전후의 source·입력 hash, fixture의 정확한 소유 정리와 기존 데이터 보존을 확인했다. 전체 연결기·웹 단위 검사, 타입·lint·format/check도 통과했다. 상세 실행 수치는 [개발·검증 상태](../../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

새 독립 `pause_source_acceptance_closure_review`는 기존 소스 리뷰의 불변 범위를 재사용하고 SQL 보정·fixture·실제 수용을 추가 검토했다. 일반 설치 안내의 SQL014–016 누락 HIGH1을 수용해 수정했고 최종 C0/H0/M0/L0 PASS를 확인했다. 모든 Step과 필수 Tests·종료 검토를 완료해 보관한다. 공식 Claude 실제 답변·동일 대화 재개·중단과 Mac 폴더 창·두 Mac 수용은 022·029·030의 별도 미완료이며 이 보관의 근거로 확대하지 않는다.
