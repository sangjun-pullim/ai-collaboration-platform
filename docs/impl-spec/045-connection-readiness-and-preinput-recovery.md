---
status: active
date: 2026-10-16
risk-surface: permission, public-api, db-schema
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 연결 확인 피드백과 AI 입력 전 실패 복구

## Context

사용자는 Mac 연결·AI 설정 완료를 보고 채팅 시작을 눌렀지만 질문 대상을 사용할 수 없었다. 연결 확인 버튼은 `connection-manager.tsx:425–432`에서 `router.refresh()`만 호출한다. 설정 화면의 applied 판정과 채팅 시작은 실제 workflow 준비 여부와 독립이다(`runtime-settings-form.tsx:127–152,250–257`).

질문 #61의 확인된 로컬 기록은 `UNKNOWN / SNAPSHOT_CHANGED / ready=false`다. 서버 실행 의도는 확정됐지만 native 입력 의도·실행 식별자·종결·영수증은 없다. 서버의 준비 보고는 만료됐고 PC 통신은 계속된다. 정확한 변경 파일은 당시 로그에 없어 확정하지 않는다.

`workflow-runner.ts:1358–1390`은 서버 실행 의도 뒤 adapter 오류를 모두 UNKNOWN으로 보존한다. Claude는 입력 의도를 저장하기 전 정책 검증에서 실패할 수 있다(`claude/adapter.ts:359–406`). 이 두 경우를 구분하지 않아 영구적인 준비 차단으로 이어진다. 기존 `recoverUnstarted`는 서버 시작 의도가 있는 기록을 제외한다.

목표는 확인 버튼의 실제 결과 표시, 설정과 질문 가능 상태의 일치, 새 실행의 입력 전 확정 실패 종결, 과거 미확인 기록의 명시적 보존 복구다. 개인 로그인·개인 지침·읽기 권한과 자동 AI 재실행 금지는 유지한다.

## Affected Files

1. `src/features/device-binding/connection-manager.tsx` — 선택 기기별 확인 상태, 복구 안내 소유.
2. 신규 `src/features/device-binding/ai-readiness-controller.ts` — 읽기 전용 준비 조회·취소·선택 변경 경합 처리.
3. `src/features/runtime-settings/runtime-settings-form.tsx` — 적용된 binding 식별자 전달, 질문 가능 여부에 따른 완료 안내.
4. `src/features/device-binding/local-connection-guide.tsx` — 기존 새 승인 흐름과 원본 보존 복구 안내 연결.
5. `src/features/investigation-coordinator/request-retirement-controls.tsx` — 원래 소유자의 기존 정리 기능 재사용 경계 추출이 필요할 때만 변경.
6. `packages/local-connector/src/workflow-runner.ts` — 입력 전 확정 거절 저장·보고·재시작 복구.
7. `packages/local-connector/src/claude/adapter.ts` — 입력 전 검증 단계의 명시적 실패 증거 반환.
8. `packages/local-connector/src/claude/native-policy.ts` — 비밀값 없는 실패 범주 진단.
9. `packages/local-connector/src/runtime-contracts.ts` — 입력 전 실패 증거·서버 영수증 타입.
10. `packages/local-connector/src/runtime/record-schema.ts`, `record-validation.ts`, `record-transitions.ts` — 증거의 형식·의미·불변성 검사.
11. `src/features/investigation-coordinator/contracts.ts`, `packages/local-connector/src/workflow-contracts.ts` — 새 device action과 엄격한 요청·응답 계약, 사본 일치 유지.
12. 신규 `supabase/migrations/20261016002400-confirmed-preinput-failure.sql` — 인증된 원래 기기의 입력 전 실패 영수증과 상태 전환. 기존 migration은 동결.
13. `packages/local-connector/src/cli/connection-recovery.ts` — 기존 미확인 기록 보존·새 승인 흐름의 안내 연결이 필요할 때만 변경. 과거 기록 자동 종결 금지.
14. 관련 단위·연결기·DB 통합·브라우저 테스트와 주제별 정본 문서.
15. 신규 `src/app/api/connections/status/route.ts` 및 device-binding의 요청·응답 계약 — 선택한 본인 기기의 최근 통신을 실패까지 명확히 조회하는 POST 경계. `ownedConnections` 결과를 재사용하고 응답은 선택 기기의 공개 필드만 투영한다.

## Affected Dependents

- `src/app/app/connections/page.tsx` → ConnectionManager: 현재 인증·본인 기기·접근 가능한 방만 전달한다.
- `RuntimeSettingsForm` → 설정 controller: 설정 조회의 currentBinding(agentId, bindingEpoch)을 준비 조회의 PublicBinding과 대조한다. 별칭으로 기기를 연결하지 않는다.
- `investigation-client.ts`의 `callInvestigation('read-recovery', …)`는 기존 인증·10초 제한·응답 검증을 재사용한다. RoomChatController는 전송함 복원 부수효과가 있으므로 연결 페이지에서 생성하지 않는다.
- `service.ts:49`의 device RPC 이름 매핑과 device route action 검증, `workflow-client.ts`, 계약 복사 일치 테스트는 신규 action 소비자다.
- WorkflowRunner 생성자는 `cli/runtime-context.ts:16–17,39–43`, `cli.ts:525–529`. Claude 외 Codex는 새 증거를 발급하지 않으며 현재 실행 경로를 유지한다.
- 새 준비 조회는 실패 시 이전 성공을 현재 성공으로 표시하지 않는다. 방·기기·binding 변경의 늦은 응답을 버린다.
- UNKNOWN 차단 규칙 사본 5개: `docs/BUSINESS-LOGIC.md:52,74`, `docs/DB-SCHEMA.md:103`, `docs/guides/onboarding-and-settings.md:347`, `docs/research/ai-runtime-integration.md:112`(소유자 모두 unstated). 기존 UNKNOWN은 유지하고 새 확정 미입력 종결만 예외로 설명한다.
- 시작 의도 이후 미종결 UNKNOWN 규칙 1개: `docs/DB-SCHEMA.md:87`(unstated). 새 영속 증거와 영수증의 예외를 반영한다.
- 이전 요청 정리가 실제 종료 증거가 아니라는 규칙 3개: `docs/BUSINESS-LOGIC.md:64`, `docs/DB-SCHEMA.md:112`, `docs/guides/onboarding-and-settings.md:188`(unstated). 유지한다.
- 준비와 통신 구분: `docs/ARCHITECTURE.md:40–46`의 현재 구분을 유지하고 연결 화면의 확인 경로를 설명한다. 위 사본 검색 범위는 정본·관련 guides/research이며 archive/records의 역사 기록은 제외했다. 전체 문서 전수 검토 결과는 아니다.
- 설정 후 채팅방에서 준비 확인하는 흐름 사본 5문장: `docs/FRONTEND-ARCHITECTURE.md:52` 2문장, `docs/guides/onboarding-and-settings.md:21,131,145`(모두 unstated). 수동 최근 통신 확인 사본 2문장: `FRONTEND-ARCHITECTURE.md:52`, `guides/onboarding-and-settings.md:19`. 연결 화면 자체의 준비 확인으로 갱신한다. 연구·역사 기록은 이 집계에서 제외했다.

## Implementation Steps

### [x] Step 1: 선택한 AI의 현재 상태를 연결 화면에서 확인

**Files**: connection-manager, 신규 ai-readiness-controller, runtime-settings-form.
- 먼저 무피드백 refresh와 applied인데 준비 만료인 화면을 기존 fixture로 실패 재현한다.
- 수동 확인은 `확인 중` → 성공 결과·확인 시각 또는 실패·재시도 버튼을 표시한다. 같은 값이어도 확인 시각과 완료 안내가 바뀐다. 중복 요청을 합치고 타임아웃·언마운트·방/기기 변경 시 취소한다.
- PC 통신과 AI 준비 조회 결과를 별도로 보관한다. router transition 종료만으로 네트워크 성공을 주장하지 않는다. 신규 POST `/api/connections/status`는 기존 동일 Origin·JSON·본문 크기 검사를 따르고 `{expectedUserId, roomId, deviceId}`를 엄격히 검증한다. 현재 Auth 사용자와 expectedUserId를 대조하고 ownedConnections에서 같은 방·본인 기기만 선택한다. 다른 기기·방·계정은 거절하고 키·credential 없이 공개 기기 필드와 서버 조회 시각만 no-store 응답한다. 인증 쿠키 갱신은 기존 requestClient.finish를 사용한다.
- 설정 조회 currentBinding의 agentId·epoch·선택 기기를 고정한 뒤 read-recovery binding의 owned·agentId·epoch·reportedReady·validUntil을 대조한다. 준비 만료는 표시 시각에도 검사한다.
- read-recovery에는 현재 expectedUserId를 전달한다. 조회는 페이지 진입·선택 변경·설정 적용 확정·수동 확인 때만 실행하며 반복 polling은 추가하지 않는다. 만료 시각에는 로컬 표시를 미확인으로 바꾸고 다시 확인 버튼을 제공한다.
- 방 전체 hasBlockingRuns를 특정 AI 원인으로 단정하지 않는다. 같은 agentId/epoch의 candidate/run 증거가 있을 때만 질문 번호를 표시한다. 그 외에는 방의 미확인 요청 또는 준비 미확인으로 구분한다.
- 설정 저장 완료와 질문 가능을 구분하되 사용자에게 다른 화면에서 다시 확인하라고 떠넘기지 않는다. 준비 확인 전에는 ‘설정 저장됨 · 응답 준비 확인 중/실패’로 표시한다. 질문 가능할 때만 ‘AI 준비 완료·채팅 시작’을 표시하고, 일반 채팅으로 이동하는 링크는 항상 제공한다.
- 자동 AI 입력은 없다. 확인은 기존 조회만 사용하고 조회 결과로 설정 변경·기기 해제를 수행하지 않는다.

### [x] Step 2: 새 Claude 실행의 입력 전 확정 실패를 영속 처리

**Files**: adapter, workflow-runner, runtime 계약·검증, shared workflow 계약, 신규 SQL.
- 재현: 서버 start-intent 성공 후 Claude 정책 검증에서 SNAPSHOT_CHANGED 발생; native write 0회인데 UNKNOWN이 되어 다음 준비가 막히는 경로.
- adapter의 `beforeSubmit` 호출 이전의 제한된 검증 구간에서만 명시적 `PREINPUT_REJECTED` 증거를 만든다. 일반 예외, timeout, beforeSubmit 진입 이후 오류, 전송/실행 상태 불확실은 대상이 아니다. 입력 callback 진입 여부를 별도로 추적해 저장 실패를 미입력 성공으로 오인하지 않는다.
- 증거는 원래 scope/generation/request/attempt/fence, 사유 enum, 증거 버전으로 고정한다. 파일 내용·토큰·원문 경로는 공개하지 않는다. 개인 설정의 검증 조건을 느슨하게 바꾸지 않는다.
- 로컬 `AttemptJournal`에는 선택적 `preinputRejection`을 추가한다. 새 `unstartedClosure.kind = SERVER_PREINPUT_REJECTED`는 해당 증거 hash와 확인된 서버 영수증을 포함한다. 기존 snapshot의 startIntentAt은 원본 그대로 보존한다. 새 종류에만 기존 ‘startIntent 없음’ 제약의 대체 조건을 적용하고 기존 세 종류의 검증은 유지한다. native TerminalEvidence의 thread/turn을 만들어 넣지 않는다.
- runner는 독점 실행 권한 아래에서 nativeIntent/native/sourceObservation/toolCalls/terminal 부재와 해당 호출의 명시적 증거를 대조하고 내구 저장한다. 저장 실패 시 기존 UNKNOWN을 유지한다. 증거만으로 ready=true로 바꾸지 않는다.
- 신규 device action `fail-before-input`은 기존 기기 인증과 요청 소유·방·agent·epoch·attempt·fence 및 동일 operation 본문 hash를 검증한다. 기존 action의 허용 필드를 넓히지 않는다. 원래 시도 EXECUTING/UNKNOWN에 한정하고, 이미 완료/다른 시도/철회된 기기 요청은 거절한다. 동일 영수증 재조회는 기존 멱등 규칙을 따른다.
- 요청은 기존 identity 필드와 `proofVersion: 1`, `proofHash`, 제한된 `reason` enum만 받는다. 임의 publicText·완료 상태·다른 실행 ID는 받지 않는다. 응답은 해당 request/attempt/fence/bindingEpoch, `state: FAILED`, `kind: PREINPUT_REJECTED`, proofHash, adoption을 포함한 별도 검증 타입이다. 기존 complete/observe 영수증에 새 의미를 억지로 넣지 않는다. 서버 함수 권한은 다른 device RPC와 동일하게 제한한다.
- 서버는 성공 답변이나 중단 성공 대신 기존 FAILED RUN_STATE 이벤트로 종결한다. 이 이벤트의 publicText는 기존 계약대로 빈 문자열이며 새 필드를 끼워 넣지 않는다. 원래 start-intent와 실패 증거 hash·영수증을 보존한다. 기한 경과 결과는 HISTORICAL이며 자동 후속 질문/AI 실행을 생성하지 않는다. 기존 방/요청 잠금과 이벤트·실시간 발행 패턴을 재사용한다.
- 공개 채팅 이력의 기존 계약은 유지한다. 새 migration의 private 증거 테이블에 attemptId 유일 키, reason enum, proofHash, 원래 scope와 영수증을 저장한다. 직접 브라우저 테이블 접근은 허용하지 않는다. 선택한 본인 기기의 실패 사유는 새 `connection_execution_status` RPC에서 실제 Auth·활성 계정·방 membership·기기 소유·agent/epoch 연결을 대조해 제한된 enum과 requestId만 반환한다. 신규 `/api/connections/status`가 이를 투영해 연결 화면에서 ‘AI에 전달되기 전 설정 검사 실패’로 표시한다. 이전 클라이언트의 read/read-recovery에는 새 필드를 추가하지 않는다. 과거 #61은 이 테이블에 소급 삽입하지 않는다.
- FAILED 처리와 같은 트랜잭션에서 기존 실패 종결과 동일하게 `human_required`로 해당 cycle을 HUMAN_INPUT_REQUIRED로 전환한다. DIRECT의 ACTIVE가 남아 다음 ask를 거절하지 않게 한다. 공동조사는 자동 advance/reserve 없이 기존 질문 adoption·다른 실행 통제 규칙을 유지한다. 실패한 원래 요청의 재실행은 없으며 준비 재검증 뒤 사람이 보낸 새로운 DIRECT 질문만 허용한다.
- 로컬은 서버 영수증을 확인한 뒤에만 미입력 종결로 봉인한다. 전송 전/응답 유실/종결 저장 전 크래시에서 동일 증거·operation으로 재확인한다. 기존 UNKNOWN 기록에 증거를 소급 생성하지 않는다.
- 봉인 전에 해당 실행 monitor를 종료하고 같은 시도의 진행 중 기록 변경을 수렴시킨다. 확인된 새 영수증과 정확히 같은 request/attempt/fence/epoch의 미확인 lease·interrupt-ack만 같은 내구 저장에서 CLOSED로 정리한다. CONFIRMED 원본·claim·start-intent·다른 시도는 변경하지 않는다. record-validation의 CLOSED 허용 조건에 새 증거 종류의 엄격한 대조를 추가한다. 늦은 응답이 봉인된 기록을 다시 바꾸지 못하게 기존 수명/동일성 검사를 유지한다. 종결 저장 실패 시 준비를 열지 않고 재시작 때 같은 영수증으로 정리한다.
- 서버 설정 변경의 `runtime_settings_private.idle`도 정확히 같은 request/attempt/fence의 입력 전 실패 증거와 FAILED 시도를 대조한다. 이 조건을 만족하는 과거 REQUESTED control만 설정 예약에서 제외한다. 원래 control은 그대로 보존하며 ACKNOWLEDGED나 실제 중단으로 바꾸지 않는다. 로컬 DB 재현에서 lease 만료로 생성된 control이 실패 종결 이후에도 설정을 막는 것을 확인한 보정이다.
- 정책 변경으로 실패했다면 설정 재확인 필요를 명확히 남긴다. 실제 설정 검증과 준비 등록을 다시 통과하기 전에는 질문 대상을 활성화하지 않는다.
- 진단은 검증 단계·설정 범주와 correlation ID만 기록한다. 변경 전 자료가 없으면 정확한 변경 파일을 추정하지 않는다.

### [x] Step 3: 질문 #61 같은 과거 기록의 복구를 한 흐름으로 안내

**Files**: connection-manager, local-connection-guide, 기존 retirement/recovery 경계.
- 기존 #61은 새 증거가 없으므로 UNKNOWN 그대로 보존한다. nativeIntent 부재만으로 FAILED/CANCELLED로 바꾸지 않는다.
- 원래 소유자에게 ‘이전 결과를 확인할 수 없음 · 기록을 보존하고 다시 연결’ 경로를 제공한다. 실제로 취소할 기기 ID와 방, 보존할 질문을 명시하고 확인을 받는다. 다른 기기나 참가자까지 일괄 해제하지 않는다.
- 기존 본인 기기 revoke → 서버 canRetire 확인 → 기존 retire → 새 승인 명령의 경계를 재사용한다. 각 단계는 서버 결과로 확인하고 실패/응답 유실 시 같은 작업 상태를 재조회한다. 하나의 성공처럼 표시하지 않는다. 새 backend 우회 API는 만들지 않는다.
- 로컬 새 승인은 기존 프로세스·파일 잠금·원본 보존 검사와 사용자의 미확인 기록 보존 확인을 유지한다(`connection-recovery.ts:727–775`). 원래 연결 프로세스가 살아 있으면 해당 터미널 종료 안내를 한다. 이름 변경·기록 삭제·다른 프로세스 종료로 우회하지 않는다.
- 새 연결과 설정의 실제 준비 확인 뒤 채팅 시작으로 끝낸다. 과거 질문을 자동 재실행하지 않는다. 기존 Claude/Codex 로그인과 개인 설정은 그대로 사용한다.
- 실제 #61 복구 수행 전 대상·실행 중 연결 여부를 재확인한다. 안전한 종료/소유 확인이 안 되면 무작정 새 연결을 만들지 않고 정확한 조건을 보고한다.

실제 #61 원본은 UNKNOWN/SNAPSHOT_CHANGED, nativeIntent·종결·새 입력 전 증거 없음으로 재확인했다. 이전 PID는 종료됐으나 다른 현재 연결 프로세스가 실행 중이며, 이를 임의 종료하거나 웹 본인 확인을 대신하지 않는다. 기록 보존 복구 UI는 실제 DB와 합성 실행으로 desktop/mobile에서 검증했다. 운영 기기 연결 취소와 새 승인은 원래 소유자의 명시적 화면 확인으로 진행한다.

### [ ] Step 4: 검증·정본·배포

필수 전체 연결기 테스트 build에는 변경 전부터 있던 `claude-native-runtime-cache.test.ts:251`의 TS2769가 남아 있다. 운영·배포 연결기 build와 변경 관련 검사는 통과했으나 전체 검사 완료로 표시하지 않는다. 기존 중단 ACK 경합 테스트의 기준 코드 재현과 검증 수치는 delivery-and-validation에 기록한다.

구현·독립 리뷰·변경 관련 브라우저/DB 검증과 승인된 main 병합·운영 배포는 완료했다. 운영 배포와 공개 검증 결과는 [진행 기록](../planning/delivery-and-validation.md#2026-10-16-연결-확인-피드백입력-전-실패-복구)을 따른다. 기존 필수 검사 실패 때문에 이 단계와 계획 전체 완료 표시는 보류한다.

- 아래 검사와 독립 리뷰를 완료한다. 승인된 병합·배포 범위에서 GitHub Flow를 따른다.
- 코드 반영 후 ARCHITECTURE, BUSINESS-LOGIC, DB-SCHEMA, API-SPEC, FRONTEND-ARCHITECTURE, BUG-FIXES의 관련 절과 onboarding 안내를 갱신한다. 상태·검증 수치는 delivery-and-validation 한 곳에 둔다.
- DB를 먼저 호환 추가하고 웹·연결기를 배포한다. 기존 클라이언트의 action은 유지한다. 롤백은 새 action 호출을 중단하며 이미 저장된 증거와 영수증은 삭제하지 않는다.
- 실제 AI 호출은 이번 계획에 포함하지 않는다. fixture 기반 정상 질문·준비·중단 회귀와 실제 브라우저·DB 계약 검사로 검증한다. 사용자의 실제 AI 질문 성공을 검사했다고 보고하지 않는다.

## Tests

- 연결 화면: 상태 확인 loading/같은 값 완료/실패/10초 제한/중복 클릭/선택 변경/권한 상실. 준비 만료·다른 기기·동일 별칭·다른 epoch·방 전체 차단/선택 AI 차단 구분.
- 준비 가능할 때만 준비 완료 및 AI 질문 시작 안내. PC green+applied+UNKNOWN fixture에서 명확한 차단 이유·복구 버튼, 390/1440 화면의 실제 브라우저 확인.
- 기존 `claude-runner-intent.test.ts`, `workflow-runner.test.ts`, `claude-native-policy.test.ts` fixture로 정책 거절 입력 0회, beforeSubmit 진입 뒤 실패의 UNKNOWN 유지, 내구 저장 실패, 응답 유실과 재시작을 검증한다.
- 새로운 증거를 기존 UNKNOWN에 소급 생성하지 못함. nativeIntent·도구·종결이 있는 시도 거절. Codex 경로 불변.
- 입력 전 거절과 lease/interrupt-ack 응답 유실·늦은 응답·종결 저장 실패 경합을 검증한다. 재시작 후 같은 시도의 미확인 작업만 닫히고 confirmed 원본은 보존되며 unresolvedRuntime이 해소되는지 확인한다.
- 실제 DB: 원래 소유 기기만 허용, 타 기기/방/epoch/fence/철회·만료 인증 거절, operation 본문 충돌 거절, 중복 영수증, 동시에 종료·lease 만료·기기 철회 경합, 실패 이벤트·HISTORICAL 유지, 후속 AI 입력 없음.
- 실패 이벤트는 기존 RUN_STATE 검증과 DB shape를 통과한다. 새 소유자 전용 상태 RPC의 다른 사용자/기기/방 접근 거절, 사유 없는 이전 기록의 미확인 표시, 구형 read/read-recovery 호환을 검증한다. DIRECT 실패 뒤 cycle HUMAN_INPUT_REQUIRED·활성 차단 해소·새 준비 보고·사람의 신규 ask 성공을 끝까지 검사한다. 공동조사는 실패 뒤 자동 후속 실행이 0개인지 검사한다.
- 과거 복구: 소유자 확인·원본 보존·현재 프로세스 잠금·서버 revoke/retire 증거 필요, 응답 유실/중간 재시작/새 승인 실패에서 기록과 잠금 유지. 사용자 기기 삭제와 자동 질문 재전송 없음.

## Risks

- 로컬 기기 보고는 해당 기기를 신뢰하는 기존 실행 계약 범위다. 서버는 native 미전송을 직접 관측하지 못하므로 인증·동일 시도·멱등성 검사를 유지하고, 로컬 증거 생성 경계를 테스트·리뷰한다.
- 과거 #61의 정확한 변경 파일을 복원할 수 없다. 현행 정책 예외 확대나 임의 종료 처리를 하지 않는다.
- 준비 결과와 설정/방 선택의 늦은 응답이 섞이지 않게 식별자·generation으로 폐기한다. 준비 보고 만료를 성공 캐시로 숨기지 않는다.
- 입력 전 실패 후 설정 변경을 자동 수용하지 않는다. 설정 확인은 기존 로컬 승인 흐름을 사용한다.

## Verification

- `npm test`, `npm run lint`, `npm run build`, 연결기 build·unit 및 변경 관련 DB integration·browser 검사.
- 로컬 Docker는 DB 검증에 필요한 이 프로젝트 소유 컨테이너만 임시 실행하고 완료 후 중지한다.
- `npm run format`, `npm run format:check`, `git diff --check`. 사용자의 기존 next-env.d.ts 변경은 보존한다.
- 독립 reviewer 검토와 재현·보정 후 재검토. 운영 배포 READY, 실제 공개 URL, 계약 버전 호환 확인.

## Review Notes

구현 승인 전까지 운영 코드·DB·기기 상태는 변경하지 않는다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| Round 1: 실패 사유를 RUN_STATE publicText에 실을 수 없음 | HIGH | ACCEPTED · Round 2 계획 수준 해소 확인 | SQL007:165 및 contracts:632–646은 빈 문자열을 강제한다. 기존 이벤트를 유지하고 새 소유자 전용 상태 조회와 private 증거 저장으로 사유 전달을 분리했다. |
| Round 1: FAILED 뒤 ACTIVE cycle 잔존으로 새 ask 차단 | HIGH | ACCEPTED · Round 2 계획 수준 해소 확인 | SQL020:124–131은 ACTIVE가 있으면 ask를 거절한다. 기존 complete/observe처럼 human_required 호출과 DIRECT 신규 질문 성공 검사를 명시했다. |
| Round 1: 미확인 lease/interrupt-ack가 로컬 준비를 계속 차단 | HIGH | ACCEPTED · Round 2 계획 수준 해소 확인 | runner monitor와 record-validation의 기존 종결 경로를 대조했다. 새 영수증으로 같은 시도의 미확인 작업만 원자적으로 닫고 늦은 응답·재시작 검사를 명시했다. |

독립 검토 2회 완료. 기준 `e663827`; 2회차는 위 보정과 영향 부분을 확인하고 변경 없는 1회차 범위를 재사용했다. 새 차단 지적·MEDIUM/LOW·REJECTED 없음. 이는 계획 검증이며 구현·운영 검증 완료가 아니다.

### Step 2 구현 검토

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 구현 Round 1: POLICY_UNCONFIRMED에 포함된 로그인 probe 시간 초과를 확정 실패로 처리 | HIGH | ACCEPTED · 구현 Round 2 해소 확인 | 실제 NativeAdmissionError(LOGIN) 재현이 실패했다. 일반 POLICY_UNCONFIRMED는 새 증거 발급에서 제외하고 확정 SNAPSHOT_CHANGED/UNSUPPORTED_SETTINGS만 허용했다. 확인 실패는 UNKNOWN을 유지한다. |
| 구현 Round 1: 미전송 ready(true)가 현재 검증 전에 재전송됨 | HIGH | ACCEPTED · 구현 Round 2 해소 확인 | PENDING ready(true)+계속된 SNAPSHOT_CHANGED 재현에서 전송을 확인했다. 복구 중 양성 준비 보고는 현재 adapter.validate 성공 뒤에만 전송한다. 종결 영수증 복구는 먼저 유지한다. |
| 구현 Round 1: 확정 미입력 실패가 UPLOADED 부재 때문에 보관되지 않음 | HIGH | ACCEPTED · 구현 Round 2 해소 확인 | 실제 새 실패 기록의 compact 재현에서 attempts가 남았다. RuntimeStore의 보관 대상에 검증된 SERVER_PREINPUT_REJECTED를 포함하고 증거·영수증 원문 보존을 검사했다. |

위 3개 재현 테스트는 보정 전 실패, 보정 후 통과했다. 변경된 `runtime-store.ts`는 같은 승인 범위의 영속 증거 보관 책임이다. MEDIUM/LOW·REJECTED 없음. 기존 개인 정책 검증은 느슨하게 바꾸지 않는다.

### Step 1·3 구현 검토

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 구현 Round 1: 설정·준비 보고와 현재 기기의 연결 버전 불일치에도 준비 완료 | HIGH | ACCEPTED · 구현 Round 2 해소 확인 | owner status의 agentId·bindingEpoch도 설정과 일치해야 준비 완료로 표시한다. epoch 변경·연결 없음·다른 agent 재현을 포함했다. |
| 구현 Round 1: 일반 승인 확인을 새로운 복구 대상에 재사용 | HIGH | ACCEPTED · 구현 Round 2 해소 확인 | 확인을 방·계정 범위와 guidedRecovery.id에 묶었다. 일반 승인에서 보존 복구로 전환하거나 대상이 바뀌면 새 확인을 받는다. |

보정 전 관련 테스트 48개 중 6개 실패, 보정 후 관련 149개 통과. 독립 Round 2는 두 보정과 영향 부분을 검토해 해소를 확인했다. 변경 없는 첫 검토 범위를 재사용했다. 새 차단 지적·MEDIUM/LOW·REJECTED 없음.

### 최종 브라우저 검사 검토

실제 격리 Auth·DB와 합성 adapter의 desktop/mobile 검사는 설정 적용과 준비 완료 구분, 수동 확인 결과, 질문만 하는 참가자의 답변, 입력 0회 실패 뒤 기한 만료 UNKNOWN·PC 통신 생존·보존 복구 확인을 검증한다. 두 테스트 파일의 추가 독립 리뷰는 PASS이며 운영 코드의 기존 리뷰 결과를 재사용했다. 실제 공급자 AI 입력은 없다.
