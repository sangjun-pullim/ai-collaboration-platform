---
status: active
date: 2026-10-03
risk-surface: permission
---
> NOTE: 이 문서는 구현 계획이다. 현재 코드의 증거로 읽지 않는다. active 상태에서는 수정하고, 보관 뒤에는 이력을 고정한다.

# Claude 입력·도구·종결 해석 보정

## Context

[Claude 호환성 검사](009-claude-code-runtime-compatibility.md)의 private 검증기에만 반영된 진행 알림·도구 응답·보류 요청 취소를 공개 실험 코드에 반영한다. 현재 공개 실행기는 입력 전 init과 합성 `_meta`를 요구하고, 실제 응답 전 도구 완료를 기록한다. 실제 실행 승인 대기 동안 합성 실행기로 재현·보정할 수 있는 책임이다. [PRD의 실제 연결 범위](../PRD.md)를 위한 선행 작업이며, 이 계획의 완료가 실제 Claude 또는 두 PC 검증 완료를 뜻하지 않는다.

공식 CLI 2.1.287과 고정 SDK 0.3.287 타입·공식 소스의 형식만 참고한다. private 준비 검사 105개를 공개 검사 75개에 더하거나 새 공개 코드의 검토 근거로 대체하지 않는다. 기존 실제 입력 3회의 UNKNOWN과 원래 승인·예산·기록은 유지한다. 추가 실제 입력 승인·예산·저장소 생성은 이 계획에 포함하지 않는다. 009는 실제 호환성 판정까지 active로 유지한다.

## Affected Files

1. `experiments/claude-code-runtime/src/native-runtime.ts` — 초기화, 내구 기록·입출력, callback 응답, 정리 후 재시작을 연결한다.
2. `experiments/claude-code-runtime/src/native-input-proof.ts` — 새 내부 모듈. 한 입력의 ACK·assistant 연결·도구·응답 완료·중단 의도·알림·종결 검증을 소유한다.
3. `experiments/claude-code-runtime/src/task-policy.ts` — 합성 버전·callback 근거 이름, replay 인수와 작업별 제한을 고정된 2.1.287 형식에 맞춘다.
4. `experiments/claude-code-runtime/test/native-runtime.test.ts` — 실제 공개 Runtime과 합성 stdio의 정상·실패·재개·정리 경로를 검사한다.
5. `experiments/claude-code-runtime/test/native-input-proof.test.ts` — 새 내부 책임의 형식·상한·모호성·종결 조건을 검사한다.
6. `experiments/claude-code-runtime/test/helpers.ts` — 합성 근거와 기존 격리 fixture를 연결한다.
7. `experiments/claude-code-runtime/test/fixtures/fake-claude.mjs` — 첫 입력 뒤 init, `_meta` 없는 도구, 진행·명령·취소·종결 형식을 생성한다.
8. `experiments/claude-code-runtime/test/native-transport-replay.test.ts` — 기본 replay 인수의 추가에 맞춰 활성·비활성 입력을 명시적으로 구성한다.
9. `experiments/claude-code-runtime/README.md` — 실제 실행 거절과 합성 검사 범위·내부 책임을 설명한다.
10. `docs/delivery-and-validation.md` — 검증 수치·진행·남은 실제 검사를 이 정본에 기록한다.

## Affected Dependents

- `experiments/claude-code-runtime/src/cli.ts` — NativeRuntime의 공개 호출과 실행 거절을 유지한다. 새 성공 상태나 제품 adapter를 추가하지 않는다.
- `experiments/claude-code-runtime/src/native-transport.ts` — 실제 write/reply·정확한 replay·bounded handler drain과 child reap을 재사용한다.
- `experiments/claude-code-runtime/src/owned-probe-store.ts` — 입력·UNKNOWN·terminal·cleanup·공유 3슬롯 저장 계약을 유지한다.
- `experiments/claude-code-runtime/test/native-transport-replay.test.ts` — 활성 모드는 replay 인수를 중복 추가하지 않고, 비활성 모드는 이 인수를 명시적으로 제거한다. 정확한 replay만 한 번 인정하는 기존 기대와 변조·외부·중복·비활성 거절을 유지한다.
- private driver7와 permit7 — TaskPolicy의 컴파일 결과를 hash로 고정한다. 공개 dist 변경 뒤 과거 permit을 실행 가능한 상태로 취급하지 않는다. 원본 준비 기록을 덮어쓰지 않고, 실제 실행 전에 영향받은 준비 범위를 별도로 검토한다.
- 웹·connector·DB의 제품 계약은 이 실험 모듈을 import하지 않는다. 변경하지 않은 검사만 정확한 입력 hash가 일치하는 범위에서 재사용한다.

## Implementation Steps

### [ ] Step 1: 공개 코드의 실패 재현

**File**: `test/native-runtime.test.ts`, `test/native-input-proof.test.ts`, `test/native-transport-replay.test.ts`, `test/helpers.ts`, `test/fixtures/fake-claude.mjs` — 위 실험 디렉터리 기준.

- 기존 75개 검사·원본 소스·fixture와 protected 입력을 고정한다. 버전 문자열만 다른 실패를 보정 근거로 사용하지 않는다.
- 성공 결과의 선택적 `terminal_reason`, 요청 없는 aborted 결과, 도구 응답 쓰기 실패, 공식 MCP 응답 형식·초기 연결, 진행·명령 알림, 보류 파일 취소, 이전 cleanup 실패 뒤 재시작의 의미 있는 실패를 먼저 재현한다.
- fake만 실행한다. 개인 native 이력·설정·인증 파일을 fixture에 읽거나 복사하지 않는다. private permit·원래 기록을 검사 구현에 가져오지 않는다.

### [ ] Step 2: 입력 검증과 실행 책임 연결

**File**: `src/native-runtime.ts`, `src/native-input-proof.ts`, `src/task-policy.ts`.

- NativeRuntime은 내구 입력·예산·정책·파일·transport·정리의 단일 소유자다. 새 내부 모듈은 입력 하나의 검증 상태만 소유하며 프로세스·파일·타이머·내구 저장·예산을 만들지 않는다. 기존 Active의 연결 상태를 이중 보유하지 않는다. 제품 공개 인터페이스는 늘리지 않는다.
- 초기화 control 응답과 native init을 구분한다. 입력 전 또는 첫 입력 뒤 init을 허용하되, native 신원 검증 전 assistant·도구·종결을 허용하지 않는다. 무입력 검사는 실제 init·정확한 소유 이력 근거가 있어야 한다.
- init은 정확한 session/root/version, `dontAsk`, 소유 SDK 서버 한 개, plugin·plugin 오류 부재와 소유 도구 둘을 확인한다. 고정 공식 형식의 `EndConversation` 하나만 inventory에 추가로 허용하고 이 도구의 실행 권한은 부여하지 않는다. 모델·effort는 관찰값으로만 기록한다.
- 사용자 ACK의 역할·입력 UUID·prompt hash를 확인한다. 첫 assistant는 명시적 입력 연결을 요구한다. 그 뒤 선택적 연결 필드 누락은 이미 연결된 단일 입력에 한정하고, 존재하는 외부 UUID는 거절한다. native user `tool_result`는 실제 응답 완료된 소유 도구에만 연결한다.
- native assistant의 도구 이름·인수와 정확히 하나의 미소비 callback을 연결한다. `_meta`가 없으면 이 연결만 사용한다. 기존 합성 `_meta`가 있으면 session/input/tool ID를 모두 대조한다. 동일 native tool ID의 정확한 합성 replay는 기존 Promise를 재사용하고 파일 읽기·callback 기록을 반복하지 않는다. 변경·모호성·외부 도구·상한 초과를 거절한다.
- 바깥 control 응답의 MCP 본문은 고정 SDK가 정의한 `mcp_response`를 사용한다. 실제 공개 Runtime의 `initialize → notifications/initialized → tools/list → tools/call` 연결을 fake가 올바른 응답 형식으로 검사한다. `notifications/initialized`에는 SDK 형식의 `id: 0` control 응답을 보내며, 보류된 요청의 `control_cancel_request`는 무응답으로 구분한다.
- 응답 완료는 실제 `transport.reply()`가 성공한 뒤 기록한다. 쓰기 실패·중단·취소·정책 drift 뒤 늦은 gate 해제는 성공 응답과 완료 근거를 만들지 않는다.
- `thinking_tokens`는 정확한 7필드·소유 session/input·정수와 최대 65,536개를 검증하고 개수·마지막 값만 보관한다. 알림마다 fsync하지 않는다. `command_lifecycle`은 정확한 5필드·6개 상태·소유 command·UUID, 최대 16개와 canonical 중복을 확인한다. 두 알림은 ACK·도구 권한·종결·재실행을 만들지 않는다. 종결 후 명령 알림은 기존 terminal을 바꾸지 않는다.
- host interrupt 의도를 control 전송 전에 기록한다. 보류 중인 소유 파일 callback에 대한 정확한 2필드 `control_cancel_request`만 처리한다. 조기·외부·중복 취소는 거절하고, 취소 자체에는 reply·종결을 만들지 않는다. 해당 callback의 대기와 늦은 응답을 닫되 typed result 수신은 계속한다.
- 결과는 ACK·신원·assistant 연결, 안전 정수 `num_turns` 1…64, UUID·빈 대기열, `resume_reason`·`local_command` 부재를 확인한다. 정상 성공은 `terminal_reason` 없음 또는 `completed`와 모든 실제 도구 응답 완료를 요구한다. `INTERRUPTED`는 host interrupt 의도와 명시적 aborted 종결을 모두 요구한다. 중단과 정상 완료가 경합한 경우 기존처럼 실제 `COMPLETED`를 보존한다. 중단 receipt나 취소만으로 종결을 확정하지 않는다.
- 정확한 소유 이력의 마지막 result hash와 입력 ACK·prompt 연결을 검증한다. 결과 UUID가 선택적이어도 이력 provenance와 마지막 입력 연결을 약화하지 않는다. 개인 이력 탐색·native 이력 주입은 하지 않는다.
- 초기 state 외에는 다음 initialize 전에 이전 cleanup `REAPED`를 요구한다. `CLEANUP_INCOMPLETE`와 이전 시작 뒤 남은 `NOT_STARTED`, UNKNOWN·저장 실패는 다음 spawn/슬롯 소비를 막는다. 저장 실패에도 실제 child 정리를 시도하고 저장 실패를 성공으로 숨기지 않는다. 기존 close 반환·오류 계약을 유지한다.
- TaskPolicy의 `SYNTHETIC_FIXTURE` admission과 정확한 fake executable guard를 유지한다. `--replay-user-messages`와 공식 근거가 있는 두 내장 plugin의 작업별 비활성화를 반영하되 개인 설정 파일을 변경하지 않는다.

### [ ] Step 3: 검증·독립 리뷰·문서 완료

**File**: 위 소스·검사, 실험 README, `docs/delivery-and-validation.md`, 이 명세.

- Step 1과 같은 실패 입력으로 보정 후 통과를 확인하고 원래 실패를 보존한다. 기존 정상 도구 중복과 자연 완료/중단 경합을 포함한 전체 실험 검사를 실행한다.
- 첫 입력→파일·peer callback→종결→child 정리→같은 session의 새 프로세스 재개→새 파일 근거와 답변, 별도 보류 파일 중단 흐름을 합성 stdio로 확인한다. 실제 Claude·두 PC 통과로 표현하지 않는다.
- 새 독립 reviewer가 소스·검사·권한·저장·정리·admission과 변경된 private dist 의존성을 검토한다. 이전 private 준비 리뷰는 새 공개 구현 리뷰를 대신하지 않는다.
- 검증된 논리 단위로 코드와 문서를 별도 커밋한다. 전체 Step·검사·리뷰가 완료되면 이 명세만 done/보관한다. 009의 실제 검증과 전체 제품 목표는 미완료로 유지한다.

## Tests

- `should accept valid success without optional terminal_reason` — 실제 공개 Runtime의 정상 typed 성공과 1보다 큰 turn 수.
- `should refuse invalid turn bounds and unsolicited aborted results` — 0·65·소수·안전 정수 초과·자동 재개 이유와 host 요청 없는 중단.
- `should initialize after first input without granting early tool permission` — control 응답과 신원·ACK·assistant 연결의 순서.
- `should correlate native calls without synthetic metadata` — 정확한 유일 연결, 모호성·외부 인수·변조 거절, 기존 합성 replay의 실제 추가 실행 0회.
- `should record response completion only after successful transport reply` — 실제 write 실패와 빠른 result 경합으로 허위 완료 차단.
- `should exchange the official MCP handshake and response envelope` — 실제 공개 Runtime의 stdio initialize·알림·list·call 왕복, `mcp_response` 키와 알림의 `id: 0` control 응답, 잘못된 응답 거절과 무입력 슬롯 0개.
- `should accept only the exact replay of an answered native control request` — 기존 기대를 유지하며 활성 인수를 한 번만 추가하고 비활성 인수는 명시적으로 제거한다.
- `should distinguish user tool results from input acknowledgements` — 소유 응답 연결·prompt hash·중복/위조 ACK 거절.
- `should bound informational progress and command lifecycle` — 정확한 필드·숫자·상한·canonical 중복·종결 이후 terminal 보존, 추가 ACK/도구/입력 0회.
- `should cancel only the interrupted held file callback` — 정확한 요청만 취소, 조기·외부·중복·늦은 gate 응답 거절, 취소 reply 0회와 typed 종결 누락 UNKNOWN.
- `should preserve natural completion racing interrupt` — 기존 완료 경합 계약 유지.
- `should refuse restart after incomplete cleanup or cleanup persistence failure` — 실제 child 정리·다음 spawn 0회·추가 슬롯 0회·기존 terminal/UNKNOWN 불변.
- `should resume the owned synthetic history after process cleanup` — 마지막 result hash와 ACK/prompt 연결, 새 파일 snapshot, 외부·변조·누락 이력 거절.
- 기존 공유 3슬롯·불명확 write·개인 설정 drift·scope·무입력·admission·정확한 transport replay 검사를 유지한다.

## Risks

- 입력 연결 완화로 외부 callback을 인정할 수 있다. 첫 assistant의 명시적 연결·유일한 소유 도구·존재하는 UUID 검사를 유지한다.
- private 중단 실험의 엄격한 조건을 복사하면 정상 완료 경합이 깨진다. 공개 정상 완료를 보존하는 기존 검사를 유지한다.
- 새 모듈에 I/O와 별도 상태 소유자를 추가하면 실행 경합이 늘어난다. 입력 proof와 Runtime의 책임·상태 소유권을 고정한다.
- 형식 보정과 합성 PASS는 실제 정책 우선순위·로그인 적격성·native 이력·중단 증거가 아니다. 실제 admission은 거절 상태로 유지한다.
- dist hash 변경은 준비 permit7의 기존 의존성을 무효화한다. 원본 driver/permit/UNKNOWN을 고정하고 실제 입력 전에 새 준비 검토를 완료한다.

## Verification

- Node 24.21.0 PATH로 실험 package의 `npm run typecheck`, `npm run lint`, `npm test`를 실행한다. `npm test`의 `tsc` build와 실제 fake child 실행을 포함한다.
- RED→GREEN의 동일 입력·기대값과 전체 기존 검사, source/protected/evidence hash를 기록한다. 바뀐 소스 범위만 새 검사를 하고 변경 없는 root/connector 결과는 입력 hash가 같을 때만 재사용한다.
- 프로젝트 루트의 `npm run format`, `npm run format:check`, `git diff --check`를 커밋 전에 실행한다. 실험 디렉터리는 기존 root formatter 제외 대상이며 이번 기능 변경에 전역 재포맷을 섞지 않는다.
- 필수 독립 계획·구현 reviewer와 AGENTS 경계를 따른다. DB·remote·배포·실제 모델 입력은 0회다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan round1: 기본 replay 인수와 비활성 검사 충돌 | HIGH | ACCEPTED — ROUND2 PASS | replay 검사 파일을 변경 대상에 추가하고 활성·비활성 인수 구성을 명시했다. 기존 거절 기대는 유지한다. |
| Plan round1: 합성 전용 MCP 응답과 알림 무응답 | HIGH | ACCEPTED — ROUND2 PASS | `mcp_response`와 초기 연결·알림의 `id: 0` 응답을 Step 1·2와 검사에 추가했다. 보류 취소의 무응답과 구분한다. |
