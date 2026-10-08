---
status: done
date: 2026-09-30
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 001 — 로컬 AI 런타임 연결 검증

## Context

[PRD의 로컬 AI 연결](../../PRD.md#로컬-ai-연결)과 [관찰·개입](../../PRD.md#실시간-관찰과-개입)을 구현하기 전에 실제 런타임의 실행·이벤트·중단 계약을 확인한다. 전체 제품 순서는 [단계별 명세 범위](../../delivery-and-validation.md#단계별-명세-범위)를 따른다.

현재 프로젝트에는 Markdown 문서만 있고 소스·package·테스트 러너·Git 저장소가 없다. 기존 로컬 증거는 Codex 0.159.1의 schema와 추론 없는 초기화까지다. [확인 범위](../../local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)를 실제 turn 성공으로 확대하지 않는다.

이번 명세는 실험 CLI 구현과 실행 계획이다. 언어는 TypeScript, 실행 환경은 Node.js 24 LTS, 패키지 관리는 npm으로 잡는다. 현재 설치된 Node는 20.19.5이므로 구현 검증 전에 프로젝트용 Node 24 환경을 준비한다. TypeScript·타입 패키지의 실제 설치 버전은 구현 시 lockfile에 고정한다. [Node 근거](../../sources.md#s16)

Codex는 설치·프로토콜 증거가 있는 첫 실험 대상이다. 팀의 실제 도구나 제품의 유일한 provider로 확정하는 선택이 아니다. 웹·Supabase·Claude adapter·기기 pairing·공동 조사·기존 앱 live attach는 후속 범위다.

### 범위와 완료 기준

| 확인 | 이번에 구현할 것 | 통과 기준 |
|---|---|---|
| 프로토콜 기반 | 결정적 fake subprocess와 stdio client | handshake, 응답 상관관계, 이벤트, 중단 경합·장애 테스트 통과 |
| 설치 runtime 초기화 | 실제 Codex의 추론 없는 `probe` 모드 | initialize 성공·initialized 전송·프로세스 정리. thread/turn/개인 목록 조회 없음 |
| 새 실행 | 실제 모델 호출을 명시한 `run` 모드 | 합성 저장소에서 새 thread로 질문·관찰·실제 종결 확인 |
| 중단 | `run --interrupt-after-ms` 실험 | ACK와 종결을 구분하고 실제 INTERRUPTED를 관찰. 자연 완료만 관찰되면 중단 기능은 미확인 |
| 저장 맥락 | 실험이 만든 thread만 사용하는 `resume` 모드 | 동일 thread/cwd에서 대화에만 있던 표식을 재전달 없이 회수. 새 세션 fallback 없음 |

프로토콜 테스트와 probe만 통과하면 **실험 도구 준비 완료**다. 실제 run·중단·resume 증거가 확보되어야 **Codex 경로 확인 완료**로 기록한다. 두 PC·Claude·제품 통합 인증·L3까지 검증됐다는 뜻은 아니다. 실제 호출 조건이 없으면 해당 실험은 미검증으로 남고 Step 5를 완료 처리하지 않는다.

### 실제 호출에 필요한 입력

- `--allow-model-call`, 지원하는 `--model`, 사용자가 확인한 `--account-route`가 있어야 run/resume를 허용한다. route는 `api` 또는 사용 허용을 확인한 `local-login`이며 token 입력은 받지 않는다. 이 값은 실험의 호출 조건을 명시하는 값이지 인증·적격성의 증명이 아니다.
- 실험 대상은 CLI가 생성한 합성 저장소이며 회사 코드·사용자 작업 저장소는 사용하지 않는다. 원래 개인 thread 목록을 조회하거나 임의 thread ID를 받지 않는다.
- 로컬 공급자 인증은 기존의 허용된 흐름을 사용한다. 인증 파일을 복사하거나 로그인 방식을 변경하지 않는다. 허용 여부가 미확정이면 실제 호출을 진행하지 않는다.
- 기존 앱과 같은 실행을 유지해야 하는지, 상대 사용자의 실제 앱·OS·버전은 다음 명세 범위를 정하기 전에 확인한다. L3가 필수라면 해당 앱의 공식 연결 실험이 먼저다.

## Affected Files

아래는 모두 신규 예정 경로다. 현재 코드의 행 번호·공개 계약으로 취급하지 않는다.

1. `experiments/local-ai-runtime/package.json`, `package-lock.json`, `tsconfig.json`, `.node-version`, `.gitignore` — 독립 실험 package, strict TypeScript 빌드와 Node test scripts, 산출물 제외.
2. `experiments/local-ai-runtime/src/stdio-client.ts` — child process·newline JSON·RPC 응답·이벤트·종료 관리.
3. `experiments/local-ai-runtime/src/codex-runtime.ts` — initialize/start/resume/run/interrupt와 실행 상태 정규화.
4. `experiments/local-ai-runtime/src/experiment-policy.ts` — 합성 workspace·실험 manifest·권한·출력 필드 제한.
5. `experiments/local-ai-runtime/src/cli.ts` — probe/run/resume 입력 검증과 결과 출력.
6. `experiments/local-ai-runtime/test/fixtures/fake-app-server.ts` — 지연·분할 출력·장애·중단 경합을 만드는 fake subprocess.
7. `experiments/local-ai-runtime/test/runtime.integration.test.ts` — 실제 child process 경계를 사용하는 격리 테스트.
8. `docs/local-ai-connection-research.md` — 실제 실험 결과·버전·한계를 기존 확인 표에 반영.
9. `docs/decisions-and-open-items.md` — 실험으로 확인한 항목과 남은 앱·인증·L3 선택 갱신.

## Affected Dependents

- 기존 코드 caller·export 소비자·route·DB가 없으므로 깨질 실행 의존성은 없다.
- `docs/ai-runtime-integration.md`의 `AgentRuntime`은 개념 예시다. 이 실험의 내부 API를 제품의 최종 SDK 계약으로 공개하지 않는다.
- `docs/BUSINESS-LOGIC.md`의 [실행 상태](../../BUSINESS-LOGIC.md#실행-상태)와 [일시정지·중단·방향 수정](../../BUSINESS-LOGIC.md#일시정지중단방향-수정)은 종결·UNKNOWN 판정의 기준이다. 실험에 방 revision·DB lease·자동 왕복을 추가하지 않는다.
- 후속 웹·connector 명세는 실험 결과와 작은 런타임 API를 참고한다. 실험 디렉터리를 최종 앱 구조로 고정하지 않는다.

## Implementation Steps

### [x] Step 1: 실험 package와 테스트 기반
**File**: `experiments/local-ai-runtime/package.json`, `tsconfig.json`, `.node-version`, `.gitignore`
- npm package는 이 디렉터리에만 둔다. TypeScript와 `@types/node`를 개발 의존성으로 사용하고 별도 SDK·웹 프레임워크는 아직 설치하지 않는다.
- ESM/NodeNext·strict, `rootDir: .`, `outDir: dist`로 src와 test를 빌드한다. `.ts`를 Node가 직접 실행한다고 가정하지 않는다.
- `typecheck`는 `tsc --noEmit`, `build`는 `tsc`, `test`는 빌드 후 `node --test dist/test/runtime.integration.test.js`를 실행한다. `probe`, `run-experiment`, `resume-experiment`도 빌드 후 각각 `node dist/src/cli.js probe`, `run`, `resume`를 호출하는 scripts로 정의한다.
- `node_modules/`, `dist/`, 로컬 실험 manifest·원본 출력은 버전 관리 대상에서 제외한다. Git 초기화·개인 설정 변경은 포함하지 않는다.

### [x] Step 2: stdio transport와 결정적 fixture
**File**: `src/stdio-client.ts`, `test/fixtures/fake-app-server.ts` (실험 package 기준)
- `spawn`에 executable·argument 배열·명시적 cwd를 전달하고 shell을 사용하지 않는다. production executable은 `codex`로 고정하며 fixture 교체는 테스트 내부에서만 주입한다.
- stdout의 분할 chunk·여러 줄·CRLF를 처리하고 JSON 응답의 ID로 pending request를 찾아 resolve/reject한다. notification과 서버→client request를 응답과 구분한다.
- handshake 전 후속 RPC를 차단한다. 요청 timeout, 잘못된 JSON, 최대 1MiB line, 조기 EOF/exit 시 모든 pending을 종료하고 무한 대기를 방지한다. raw 메시지를 오류에 붙이지 않는다.
- stderr는 읽어서 pipe 정체를 막되 raw 본문을 일반 결과로 출력·저장하지 않는다. 이벤트도 allowlist로 요약하고 텍스트 delta 전체는 저장하지 않는다.
- 지원되는 도구 승인 요청에는 설치 버전 schema의 거절 응답을 보내고 권한을 확대하지 않는다. 알 수 없는 서버 request는 오류 처리하고 실험을 중단한다.
- close/timeout/SIGINT에서는 신규 RPC를 막고 자신이 띄운 child만 정리한다. 프로세스 종료를 runtime turn의 중단 완료로 바꾸지 않는다.
- child stdin의 error와 모든 write promise 실패를 transport 오류로 수거한다. 종료 요청은 대기 중인 이벤트 처리도 깨우며, 종료가 시작된 뒤 새로운 client나 모델 요청을 허용하지 않는다.

### [x] Step 3: Codex의 실행·중단·resume 계약
**File**: `src/codex-runtime.ts`, `src/experiment-policy.ts`
- 구현 시 설치 버전의 schema를 임시 경로에 생성해 필드를 확인한다. 0.159.1에서 `ThreadStartParams.sandbox`, `TurnStartParams.sandboxPolicy`, `TurnInterruptParams.threadId/turnId`를 확인한 증거를 재사용하되 버전이 바뀌면 재검증한다.
- probe는 initialize → initialized만 수행하고 thread API를 호출하지 않는다. 실험 실행은 새 thread → turn/start로 한 turn만 허용한다.
- thread에는 `sandbox: read-only`, turn에는 schema에 맞는 read-only policy를 명시하고 승인 정책은 `never`로 고정한다. 기존 관리자 요구나 승인 훅이 거절하면 실패로 보고하고 우회하지 않는다.
- 모든 실행의 cwd는 실험 manifest의 canonical root와 일치해야 한다. read-only를 ‘그 root 밖의 모든 읽기까지 차단한다’는 보장으로 표현하지 않는다. 개인 도구·MCP·네트워크에 대한 실효 정책을 확인할 수 없는 환경은 실제 run 대상에서 제외한다.
- 상태는 READY → STARTING → RUNNING → INTERRUPT_REQUESTED → 실제 종결(COMPLETED/FAILED/INTERRUPTED)로 구분한다. 각 `turn/start` 전에 manifest lock 안에서 새로운 attempt ID와 STARTING을 영속 저장하고 저장 실패 시 호출하지 않는다. 실행 요청 후 연결·응답을 잃으면 UNKNOWN으로 기록하고 자동 재호출하지 않는다.
- 시작 응답보다 먼저 도착한 turn 이벤트는 thread/turn ID로 상관관계를 확인할 때까지 보관한다. late·다른 turn·중복 이벤트가 새 실행 상태를 바꾸지 않게 한다.
- interrupt 응답은 수신 확인이다. terminal notification으로만 실제 종결을 판정한다. timeout이면 UNKNOWN이며 자연 완료·실패와 중단 경합도 실제 상태로 기록한다.
- interrupt RPC 응답과 terminal을 동시에 관찰한다. 중단 요청 시점부터 종결 기한을 적용하며, terminal 뒤에 온 ACK 오류·유실이 확인된 종결을 UNKNOWN으로 덮지 않는다.
- RPC timeout과 별개로 시작 의도 저장 시점부터 전체 turn deadline을 둔다. 기본 120초, 최대 600초로 제한한다. deadline 만료 시 확인된 turn ID에 한 번만 interrupt를 요청하고 최대 10초의 종결 확인 기한을 둔다. terminal이 오지 않거나 turn ID가 미확인이면 UNKNOWN을 영속 저장하고 owned child를 정리한다. child가 살아 있어도 CLI가 무한 대기하지 않게 한다.
- resume는 이 도구가 만든 완료 thread의 로컬 manifest만 받는다. 동일 root·비활성 상태를 검증하고 별도 process로 이어간다. manifest가 UNKNOWN/active이면 재개하지 않으며 실패 시 새 thread로 대체하지 않는다.

### [x] Step 4: 얇은 CLI와 실험 결과
**File**: `src/cli.ts`, `src/experiment-policy.ts`
- subcommand가 없으면 probe다. run/resume는 명시적 모델 호출 flag·model·account-route와 허용된 계정 경로 확인 없이는 시작하지 않는다. 구독/API를 자동 전환하지 않는다.
- run은 공개해도 되는 합성 fixture를 임시 workspace에 만들고 고정된 짧은 질문으로 읽기·응답을 확인한다. 사용자의 개인 repository나 thread를 자동 감지하지 않는다.
- 로컬 manifest에는 experiment ID·thread/turn locator·root·attempt ID·현재 상태·시작 의도·deadline·확인 시각·맥락 검사용 `contextMarkerHash`만 최소 저장한다. 원본 nonce는 저장하지 않는다. 권한은 소유자 읽기/쓰기, 한 manifest 동시 실행 lock을 사용한다. 파일 동기화와 rename을 포함한 영속 갱신을 완료한 뒤에만 runtime을 호출한다.
- 동시 실행 lock은 Node 24 내장 SQLite의 `BEGIN IMMEDIATE` transaction으로 유지한다. 고정 SQL만 사용하고 busy이면 실행을 차단한다. 파일의 PID·내용을 읽고 삭제하는 stale 회수는 사용하지 않으며, crash 뒤 해제되는 OS lock으로 다음 holder를 직렬화한다. 개인 설정이나 제품 DB 스키마는 변경하지 않는다.
- 기존 SQLite lock 파일의 소유권·권한·link는 `lstat`으로 검증하고 raw file descriptor로 열었다 닫지 않는다. raw descriptor는 `O_CREAT | O_EXCL` 최초 생성에만 사용한다. 같은 프로세스의 재진입 거절 뒤에도 별도 프로세스의 진입이 차단되고 holder 해제 뒤에만 다음 실행이 진입해야 한다.
- 재시작 시 STARTING/RUNNING/INTERRUPT_REQUESTED 등 미종결 기록은 UNKNOWN으로 취급한다. stale lock이 있어도 기록을 과거 COMPLETED로 되돌리거나 자동 새 turn을 시작하지 않는다. 정상 종결 후에만 완료 상태를 저장한다. crash가 난 새 실행과 resume 모두 같은 규칙을 적용한다.
- 기본 출력은 실험 ID·CLI/protocol 버전·연결 수준·상태 전이·이벤트 종류·성공/실패·미확인 범위다. native ID·절대 경로·provider 인증·원본 stderr·원본 대화는 출력하지 않는다.
- 합성 임시 root의 prefix에 experiment ID를 포함하고 `resume --experiment-id`로 소유 manifest를 조회할 수 있게 한다. 기존 `--resume-manifest`도 지원하며 실패 후에도 안전한 실험 ID를 반환한다. 개인 thread 목록은 조회하지 않는다.
- 실제 종결 전 workspace/manifest를 삭제하지 않는다. UNKNOWN은 자동 재개·새 실행 대신 상태 확인 필요로 남긴다. 임시 저장 위치와 정리 방법을 본인에게 안내한다.

### [x] Step 5: 실제 호환성 확인과 문서 반영
**File**: `docs/local-ai-connection-research.md`, `docs/decisions-and-open-items.md`
- 먼저 격리 테스트와 실제 probe를 실행한다. 계정·model·실효 권한이 확인된 환경에서만 새 질문, 중단, 도구가 만든 저장 thread의 순차 resume를 실행한다.
- 저장 맥락 실험은 첫 turn의 대화에만 임의 nonce를 넣고, 생성한 값의 SHA-256을 시작 의도와 함께 로컬 manifest의 `contextMarkerHash`에 저장한다. 종료한 뒤 새 process에서 같은 thread/cwd를 resume해 nonce를 다시 주지 않은 질문으로 회수하고 응답의 표식 hash를 비교한다. nonce/hash는 workspace 파일·후속 prompt·developer instructions에 넣지 않는다. 일치 여부만 공개 기록에 남긴다. 같은 파일을 다시 읽은 성공을 대화 맥락 보존으로 판정하지 않는다.
- 중단 실험은 terminal 상태가 INTERRUPTED인 경우에만 실제 중단을 확인한 것으로 기록한다. 자연 완료/실패가 먼저 오면 그 종결과 경합을 기록하고, 중단 성공 증거는 미확인으로 남겨 다른 지연 조건에서 다시 확인한다. 도구·자식 process 전체 종료의 보증으로 확대하지 않는다.
- 각 실험에 버전·cwd 일치·이벤트 종류·실제 종결·맥락 표식 일치/누락·한계를 남긴다. 원본 nonce·질문/응답이나 개인 경로를 연구 문서로 자동 복사하지 않는다.
- 실제 호출을 하지 못하면 해당 행은 미검증으로 남긴다. fake 통과를 실제 호환성으로 기록하거나 Step 5를 완료 처리하지 않는다.
- 다음 명세 작성 전에 실제 팀 앱과 L2/L3 필요성, 상대 provider, 허용 인증 경로를 확인한다. 결과에 따라 Codex 확장·Claude 실험·기존 앱 bridge 범위를 정한다.

## Tests

모두 `test/runtime.integration.test.ts`에 추가하며 `node:test`와 fake subprocess를 사용한다. 실제 provider·개인 session·네트워크 추론을 기본 테스트 의존성으로 두지 않는다.

| 이름 | 고정할 동작 |
|---|---|
| `should initialize before sending thread requests` | handshake 순서와 probe의 thread/turn 미호출 |
| `should correlate fragmented and out-of-order responses` | chunk/CRLF·여러 줄·ID 상관관계와 이벤트 분리 |
| `should reject requests after timeout or process exit` | malformed·과대 line·조기 종료 시 pending 종료와 자동 재호출 없음 |
| `should pass the canonical workspace without invoking a shell` | 공백·shell 문자 경로가 cwd로 전달되고 command로 평가되지 않음 |
| `should enforce read-only policy and decline approval requests` | thread/turn 정책과 승인 거절·알 수 없는 request 실패 |
| `should require explicit inputs before model calls` | flag/model/계정 경로 미확인 시 provider 요청 없음 |
| `should wait for a terminal event after interrupt acknowledgement` | ACK만으로 INTERRUPTED가 되지 않고 자연 완료/실패도 정확히 처리 |
| `should mark an uncertain started turn as unknown` | 시작 응답 유실·연결 끊김·중단 timeout 시 UNKNOWN, 새 호출 없음 |
| `should expire a started turn without a terminal notification` | 정상 시작 응답 후 열린 연결에 terminal이 없어도 전체 deadline/중단 기한 뒤 UNKNOWN과 child 정리 |
| `should block replay after a crash during a resumed turn` | 완료 manifest의 resume에서 호출 직후 CLI를 강제 종료해도 시작 의도가 남고 재실행의 추가 turn이 차단됨 |
| `should avoid runtime calls when the start intent cannot be persisted` | manifest 저장 실패 전에 thread의 새 turn을 시작하지 않음 |
| `should ignore events from another or completed turn` | early/late·중복 이벤트 상관관계와 active turn 최대 하나 |
| `should resume only an inactive experiment-owned thread` | canonical root·소유 manifest·lock 확인과 resume 실패의 새 thread fallback 금지 |
| `should recall a conversation marker without resending it` | fixture가 resume 문맥의 표식을 반환하고 후속 prompt·파일에 표식이 없어도 비교할 수 있음. 같은 hash라도 다른 turn의 표식은 일치로 판정하지 않음. 실제 맥락 보존은 수동 실험으로 별도 확인 |
| `should omit secrets and native locators from public output` | synthetic token·path·stderr·대화가 기본 CLI 출력/연구 결과로 새지 않음 |
| `should clean up only the child process it started` | SIGINT/close에서 child 정리와 실제 runtime 종결 판정의 분리 |
| `should clear the overall deadline timer after an early terminal event` | 정상 완료 이후 120초 deadline timer가 별도 CLI 프로세스의 종료를 지연하지 않음 |
| `should start the overall deadline after persisting the start intent` | initialize/thread 준비 시간이 turn 실행 기한을 소모하지 않음 |
| `should serialize manifest holders across creation and crash recovery` | 생성 직후·동시 회수에서도 단일 holder만 진입하고 crash 후 active 기록을 UNKNOWN으로 저장한 뒤 재실행 차단 |
| `should preserve a holder after a same-process contender is rejected` | A holder 유지 → 같은 PID B 거절 → 별도 PID C도 거절 → A 해제 뒤 새 holder 진입. 기존 SQLite 파일의 raw close로 OS lock이 풀리는 경합을 재현 |
| `should preserve a terminal received before an interrupt acknowledgement failure` | 실제 COMPLETED/INTERRUPTED 뒤 늦은 ACK 오류·유실이 종결을 덮지 않음 |
| `should bound terminal waiting from the interrupt request` | ACK 지연과 무관하게 중단 요청부터 종결 대기 기한 적용 |
| `should block runtime admission after shutdown during preparation` | 준비·lock·시작 의도 저장 중 종료 요청과 종료 이후 호출에서 새 client/turn 차단. 실행 전 준비·lock promise가 미해결이어도 종료가 대기하지 않으며, 시작된 실행은 UNKNOWN 저장·child 정리 후 반환 |
| `should terminate promptly after SIGINT while awaiting a terminal` | subprocess의 실제 SIGINT가 terminal 대기를 깨우고 UNKNOWN 영속화·child 정리·신속 종료 |
| `should handle a closed child stdin without an uncaught exception` | stdout이 열린 상태에서 fd0 종료가 transport 오류로 수거됨 |
| `should collect write failures while rejecting unknown server requests` | 알 수 없는 서버 request의 오류 응답 write 실패도 unhandled rejection 없이 처리 |
| `should locate an owned experiment by ID without exposing its path` | ID 조회의 소유권·중복 검증 및 기본 출력 경로 제외 |
| `should retain the experiment ID after a runtime failure` | 실험 생성 이후 실패에도 정리·상태 확인을 위한 안전한 ID 유지 |
| `should await durable unknown and child cleanup after shutdown of a started turn` | 이미 시작된 실행은 UNKNOWN 영속 저장·소유 child 정리 전에 공개 결과를 반환하지 않음 |
| `should preserve a confirmed terminal during shutdown persistence` | UNKNOWN 저장을 기다리는 사이 확인한 실제 terminal을 보존 |

## Risks

- **permission 표면:** 로컬 runtime의 실행 정책·승인·workspace를 제어한다. 테스트와 독립 reviewer가 필수다. read-only의 읽기 범위와 외부 도구 정책은 실제 환경으로 확인한다.
- fake는 우리 client의 계약을 검증한다. 실제 provider의 resume·interrupt·승인 동작은 별도 실험 증거가 필요하다.
- 한 PC의 실험 결과는 팀의 앱·OS·계정 적격성과 L3를 보장하지 않는다. 실시간 기존 세션이 필수이면 다음 단계 전에 공식 앱 연결을 검증한다.
- UNKNOWN을 반복 실행으로 해결하지 않는다. runtime 원본 확인·소유권 회복은 별도 판단이며 중단 ACK가 이미 발생한 작업을 되돌리지 않는다.
- 코드·설정 파일 수에 따른 적용 AGENTS.md의 계획 승인 경계는 실제 구현 전에 판단한다. 이 명세 작성은 구현·과금·배포 승인이 아니다.

## Verification

아래 명령은 구현 후 실행할 기준이며 현재 통과한 결과가 아니다. package 디렉터리 `experiments/local-ai-runtime`에서 수행한다.

```sh
node --version
npm ci
npm run typecheck
npm test
npm run probe
```

- 기본 명령은 실제 모델 호출 없이 통과해야 한다. 실제 probe는 설치된 Codex 실행 파일이 있어야 한다.
- 계정·실효 정책을 확인한 뒤 `npm run run-experiment -- --allow-model-call --model <선택 모델> --account-route <허용 경로>`로 실제 질문을 실행한다. 중단은 `--interrupt-after-ms <시간>`을 추가한다. 이어가기는 `npm run resume-experiment -- --allow-model-call --model <선택 모델> --account-route <허용 경로> --resume-manifest <이 도구의 manifest>`를 사용한다. 이는 opt-in 수동 실험이며 CI에서 자동 수행하지 않는다.
- 기본 CLI 출력의 비밀/경로 제외, fixture 파일 무변경, 실행 후 child 정리, UNKNOWN 기록을 확인한다. 원본 증거가 필요하면 본인이 로컬에서 확인한다.
- 구현 diff를 독립 reviewer가 권한·실행 상태·오류 처리·테스트 기준으로 검토한다. 계획 리뷰 PASS를 구현 리뷰로 재사용하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 실행 시작 의도 영속화·crash 재실행 차단 누락 | HIGH | ACCEPTED | turn 호출 전 STARTING 저장, 재시작 UNKNOWN, resume 중 CLI crash·저장 실패 테스트를 본문에 반영 |
| 정상 시작 후 terminal 없는 전체 기한 누락 | HIGH | ACCEPTED | 전체 turn deadline과 제한된 중단/종결 기한, 열린 연결 무응답 테스트를 반영 |
| 저장 맥락 판별 입력·기대 결과 부족 | MEDIUM | ACCEPTED | 첫 대화에만 넣은 nonce를 재전달 없이 회수하는 실제 실험과 fixture 검증을 반영 |
| 구현 리뷰 1: 빈 PID lock·stale 회수 경합으로 동시 holder 발생 | HIGH | ACCEPTED | Node 24 내장 SQLite의 프로세스 소유 transaction lock으로 직렬화하고 생성·crash 회수 경합을 회귀 검사로 확인. 파일 삭제로 stale lock을 회수하지 않음 |
| 구현 리뷰 1: terminal 이후 늦은 interrupt ACK 오류가 UNKNOWN으로 덮음 | HIGH | ACCEPTED | 실제 종결을 우선 보존하고 중단 요청 시점부터 제한된 종결 대기를 적용. ACK 오류·유실 회귀 통과 |
| 구현 리뷰 1: shutdown 이후 신규 실행·SIGINT 대기 종료 미보장 | HIGH | ACCEPTED | 영구 취소 상태·신규 RPC 차단·대기 깨우기를 적용. 미해결 준비·이미 시작된 실행의 실제 subprocess SIGINT 회귀 통과 |
| 구현 리뷰 1: stdin EPIPE·서버 오류 응답 write rejection 미처리 | HIGH | ACCEPTED | transport 오류로 수거하고 비정상 종료 없이 UNKNOWN을 저장. fd0 종료와 오류 응답 write 실패 회귀 통과 |
| 구현 리뷰 1: 결과 ID로 manifest 조회 불가·실패 ID 누락 | MEDIUM | ACCEPTED | 소유한 합성 실험만 ID로 조회하며 실패에도 안전한 ID를 반환. 공개 출력의 경로 제한은 유지 |
| 구현 리뷰 1 보정 검사 | — | VERIFIED | 동일 세션 보정 후 Node 24.21.0 typecheck·33/33 테스트·실제 initialize-only probe를 총괄 환경에서 통과. package/lock 불변으로 npm ci 결과 재사용. 독립 재리뷰와 실제 turn 실험은 별도 |
| 구현 리뷰 2: 같은 PID contender의 raw close가 SQLite OS lock을 해제 | HIGH | ACCEPTED | 회귀 테스트에서 B는 거절되지만 외부 C가 READY로 진입하는 실패를 먼저 재현. 기존 파일은 lstat 검증, 최초 생성만 exclusive open/close로 보정. Node 24.21.0 typecheck·34/34 테스트·initialize-only probe 통과 뒤 독립 리뷰 3에서 해소 확인 |
| 구현 리뷰 3 | — | PASS | 변경된 잠금·회귀 테스트를 독립 검토하고 12개 파일 SHA-256을 시작·종료 시 대조. 변경 없는 transport/runtime/CLI 계약은 리뷰 2, package/npm ci는 기존 통과 결과를 재사용. Step 1–4 완료이며 실제 호환성 Step 5는 별도 |
| 실제 합성 실험 | — | VERIFIED | Codex 0.159.1·Node 24.21.0·허용된 local-login에서 새 실행 COMPLETED, 새 process의 동일 소유 thread/cwd resume COMPLETED와 대화 표식 일치, 실제 interrupt ACK/INTERRUPTED를 확인. 소유 thread/read로 대조했고 종결 fixture는 증거 보관 후 정리. 후속 요구 확인으로 참여자는 주로 macOS·Claude Code를 사용하며 기존 공식 로그인·개인 설정과 connector 소유 세션을 적용하기로 정했다. PRD에서 모든 앱의 실행 중 세션 지원을 초기 필수 범위에서 제외하고 Claude를 필수 지원 대상으로 정해 다음 검증 범위를 정했으므로 Step 5를 완료한다. 파일 도구 경로는 별도003 선행 검증이며 실제 Claude·제품의 두 PC 검증 완료를 뜻하지 않음 |
| 명세 종료 검토 2026-10-04 | — | PASS C0/H0/M0/L0/INFO0 | 기존 구현 리뷰와 공개 실제 실험 기록을 재사용하고, 마지막 단계의 후속 요구 확인 및 현재 Tests 정의·보호 파일 hash를 독립 검토했다. 완료 표시 누락을 보정해 보관하며 새로운 실제 AI 실행·제품 Claude·두 PC 완료를 주장하지 않는다. |
