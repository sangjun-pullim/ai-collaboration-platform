---
status: done
date: 2026-10-01
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 로컬 Codex 실행기와 내구 공동 조사 연결

## Context

[PRD의 로컬 AI 연결](../../PRD.md#로컬-ai-연결)과 [참가자별 실행 설정](../../research/ai-runtime-integration.md#참가자별-도구모델effort-선택)을 실제 connector 실행으로 연결한다. 현재 `WorkflowClient`는 제품 CLI 호출자가 없고, 기기 등록의 native session 입력은 provider 소유권을 검증하지 않는다. 실험 adapter의 별도 attempt ID·전체 shutdown·해시 처리한 텍스트는 서버 attempt/fence와 종결 문구를 연결하는 제품 실행기 계약을 대신하지 않는다.

이번 범위는 macOS/Node 24의 connector-owned Codex 공동 조사 세션, 로컬 binding별 모델·effort 선택, 내구 intent/outbox, 실제 서버의 lease/control 및 질문·답변·continuation 왕복이다. 기존 임의 native session 문자열을 자동 resume하지 않는다. 사용자가 로컬에서 명시적으로 새 협업 맥락을 확인한 L1 연결을 만들고 이후 같은 owned thread를 L2로 재개한다. 제품이 전달하는 공유 자료는 선택한 인계 문구와 파일이며 로컬 에이전트의 기존 전역·프로젝트 지침과 설정도 적용한다. 외부 앱의 실행 중 세션 L3·임의 저장 세션 가져오기는 별도 호환성 범위다.

2026-10-01 사용자 확정에 따라 개인 에이전트 지침과 설정 파일 유지를 기본으로 하고 전용 로그인 프로필을 요구하지 않는다. 개인 설정 로딩과 공동 정보 전송을 구분한다. 사용자가 공동 조사 범위를 읽기·격리 검증·수정 제안으로 확정했으므로 조사 세션에는 읽기 전용 실행 권한을 적용한다. 2026-10-02 후속 선택에 따라 권한을 검증하지 못한 MCP·플러그인·훅 실행은 조사 동안 제한한다. 이 선택은 모든 실행 기능을 무조건 활성화하던 보존 요구를 보완하며 개인 설정 파일·인증·지침을 변경하는 승인이 아니다. 원본 프로젝트 수정·커밋·배포는 허용하지 않는다. 기존 001/003 실험과 archive는 당시 검증의 동결 기록으로 유지한다. 웹 선택·대상 프로젝트 표시 요구는 후속 웹 설정 명세에 연결한다.

웹의 모델 선택 UI·공개 capability/settings DTO·Claude adapter·Codex↔Claude 왕복·개인 설명·전체 방향 수정·Realtime·두 PC·배포는 이어지는 명세에서 완성한다. Claude는 사용자 선택대로 각 PC의 공식 비변조 Claude Code에 직접 로그인한 기존 구독 경로를 우선 검증한다. 이번 Codex 성공으로 그 범위를 완료 처리하지 않는다. 현재 서버 DTO/SQL은 유지하고 이미 적용한 migration 001–006과 archive 명세는 동결한다.

수용 기준은 실제 제품 connector 두 개가 합성 저장소 A/B에서 각자의 설정으로 실행하고, A의 실제 tool callback → 내구 QUESTION → B의 실제 근거 답변 → A의 같은 owned thread continuation을 동일 cycle/request/attempt/fence로 연결하는 것이다. 가짜 provider 검사는 장애 검증용이며 이 실제 수용 증거를 대신하지 않는다.

## Affected Files

1. `packages/local-connector/src/runtime-contracts.ts` — adapter, 로컬 설정/관찰, 실행/오류의 좁은 계약.
2. `packages/local-connector/src/runtime-store.ts` — binding별 설정·owned context·attempt/outbox의 0700/0600 내구 저장과 session 잠금.
3. `packages/local-connector/src/codex-transport.ts` — bounded stdio JSON-RPC, private typed events, tool callback, 소유 child 정리.
4. `packages/local-connector/src/codex-adapter.ts` — capability/policy 검사, owned new/resume, addressed interrupt, 종결/적용값 관찰.
5. `packages/local-connector/src/runtime-file-policy.ts` — 선택 상대 경로·snapshot·drift·secret 거절·공개 문구 정책.
6. `packages/local-connector/src/workflow-runner.ts` — 실제 `WorkflowClient`와 로컬 journal/adapter의 intent, lease/control, 질문, outbox, UNKNOWN 복구 연결.
7. `packages/local-connector/src/cli.ts` — runtime 명령, 짧은 profile 잠금, replace/revoke-local과 runtime guard 연결.
8. `packages/local-connector/src/state-store.ts` — 기존 profile 저장 형식은 유지하며 runtime 명령의 짧은 잠금 사용을 지원하는 국소 수정이 필요할 때만 변경.
9. `packages/local-connector/tests/runtime-store.test.ts`, `codex-adapter.test.ts`, `workflow-runner.test.ts`, `runtime-file-policy.test.ts`, `tests/fixtures/*` — 기존 Node test runner의 격리 provider/서버/crash 검증.
10. `tests/integration/owned-codex-workflow.test.ts`, `tests/helpers/owned-runtime-fixture.ts` — 실제 로컬 Auth/DB/HTTP와 제품 connector의 가짜 adapter 장애 통합 fixture. 실제 provider 호출은 별도 opt-in parent 실행이다.
11. `package.json`, `packages/local-connector/package.json`, `tsconfig.integration.json` — 필요한 테스트 진입점과 새 파일의 기존 build 경계만 추가. 새 외부 dependency는 기본적으로 추가하지 않는다.
12. `docs/ARCHITECTURE.md`, `docs/API-SPEC.md`, `docs/BUSINESS-LOGIC.md`, `docs/ai-runtime-integration.md`, `docs/onboarding-and-settings.md`, `docs/delivery-and-validation.md`, `docs/sources.md`, `README.md` — 실제 동작·설치·복구·검증 범위와 남은 웹/Claude 기능을 동기화한다.

## Affected Dependents

- `packages/local-connector/tests/connector.test.ts` — pairing/등록/교체/credential rotation과 v1 profile의 기존 계약.
- `packages/local-connector/tests/workflow-client.test.ts`, `src/features/investigation-coordinator/contracts.ts` — 고정 workflow body/projection과 connector mirror byte 동일성 유지.
- `src/app/api/workflow/[action]/route.ts`, `src/features/investigation-coordinator/service.ts` — 서버가 검증한 device/attempt/fence 권한을 사용하고 임의 provider body를 보내지 않는다.
- `src/app/api/connections/[action]/route.ts`, `src/features/device-binding/service.ts` — 기존 scope/epoch 교체와 키 rotation 계약 유지.
- `supabase/migrations/20261001000600-durable-investigation-coordinator.sql:330–438` — ready 60초, lease 30초, start-intent/complete/observe/replace의 서버 조건 유지.
- `tests/integration/investigation-coordinator.test.ts`, `device-workspace-binding.test.ts`, `web-auth-room-access.test.ts`, `tests/e2e/*` — 같은 실제 fixture/러너와 기존 브라우저 동작의 회귀 검증.
- `experiments/local-ai-runtime/src/{stdio-client,codex-runtime,scoped-tool-experiment,workspace-file-policy}.ts` — 검증한 좁은 정책/프로토콜 패턴의 참고 자료. connector rootDir 밖 TS를 직접 import하거나 기존 실험을 제품 계약으로 바꾸지 않는다.

## Implementation Steps

### [x] Step 1: 로컬 실행 계약과 안전한 내구 저장
**File**: `packages/local-connector/src/runtime-contracts.ts`, `runtime-store.ts`, `tests/runtime-store.test.ts`

- provider adapter seam은 capability, owned context 준비/관찰, 하나의 server attempt 실행, 해당 attempt 중단, read-only 종결 관찰, 소유 child 종료로 제한한다. runner가 server UUID/fence/epoch를 소유한다. adapter가 별도 제품 attempt를 발급하지 않는다.
- 로컬 binding 설정은 provider `codex`, 요청 model/effort, capability snapshot/version, 선택한 파일 목록/hash, 인계 문구, context generation을 저장한다. 원시 capability/config/인증·root/native ID·stderr는 공개 출력에 포함하지 않는다. 요청값과 thread가 보고한 값/turn reroute/turn effort 미확인을 별도 typed 필드로 둔다.
- 기존 v1 profile과 별도의 profile/binding runtime directory를 만든다. 모든 ancestor의 symlink 거절, UID·mode·nlink 검사, O_NOFOLLOW bounded read, temp O_EXCL + fsync + rename + directory fsync를 적용한다. strict schema/크기/상태 전이/같은 identity를 검사한다. 보안 파일 helper는 내부로 유지한다.
- server scope/device/agent/epoch와 local context generation을 고정한 attempt journal 및 action/body/hash/operationId를 가진 outbox를 기록한다. 새로운 attempt의 로컬 journal은 provider 호출 전에 정한 claim operation ID로 구분한다. 기존 v1의 request-only journal은 유일한 원래 claim과 연결되는 경우에만 그 키를 한 번 확정하고, 불명확한 기존 기록은 미확인으로 유지한다. 같은 request의 재할당 fence는 새 journal을 추가하며 이전 원문과 receipt를 덮거나 삭제하지 않는다. claim pending, claimed, server-start-intent pending/confirmed, local provider intent, native ACK, running, terminal, uploaded, UNKNOWN을 구분한다. 같은 op를 다른 payload/action으로 재사용하지 않는다.
- 주기적인 ready 갱신은 확인된 최신 receipt를 유지하면서 이전 confirmed ready housekeeping만 제한적으로 정리한다. pending/transmitted/미확인 ready와 claim/start/질문/terminal/observe 증거는 보존한다. strict 상태 전이 검사에서도 이 정리만 허용하며 장시간 idle이 operation 한도를 채워 정상 실행을 중단하지 않아야 한다.
- binding/session의 long-lived lock은 profile의 짧은 transaction lock과 분리한다. 다른 profile에서 같은 owned native thread를 실행하려는 경우도 차단한다. PID가 사라진 잠금 회수는 identity 검증 후에만 허용하고 active/intent journal은 UNKNOWN으로 남긴다. 같은 사용자 악성 외부 앱까지 잠금으로 제어한다고 주장하지 않는다.

### [x] Step 2: 제품 stdio transport와 capability/policy 확인
**File**: `packages/local-connector/src/codex-transport.ts`, `codex-adapter.ts`, `tests/codex-adapter.test.ts`

- `experiments/local-ai-runtime/src/stdio-client.ts:42–151,300–445`의 검증된 bounded transport 패턴을 좁게 이식한다. shell=false/고정 실행 파일·인자, 1MiB line/bounded queue·request timeout·stderr byte count, fixed 오류, pending rejection/late response 수거, 소유 child만 TERM→KILL→reap한다. 사용자 runtime 환경의 MCP/훅 인증 변수·프록시·인증서 설정을 보존하면서 제품/fixture 서버 secret·DB/admin/OTP/JWK를 제거한다. 제품·fixture가 주입하는 변수의 경계를 명시하고, 임의의 사용자 `*_KEY` 변수를 일괄 제거하지 않는다. provider 인증은 설치된 공식 Codex의 사용자 직접 인증 경로가 소유한다.
- experimental dynamicTools를 사용하므로 initialize feature 지원과 exact protocol/version compatibility를 확인한다. 현재 설치 버전을 기록하고 unknown schema/정책이면 ready를 거절한다. 버전 문구 하나만으로 실행 지원을 확정하지 않는다.
- `model/list`는 bounded pagination/중복 cursor·ID/목록 크기 검증을 하고 모델별 supportedReasoningEfforts/defaultReasoningEffort만 허용한다. 첫 선택은 runtime이 보고한 기본 모델/effort로 결정하고 찾지 못하면 명시적 선택을 요구한다. 목록 존재는 실행 계정 적격성을 확정하지 않는다.
- 공식 CLI의 기존 config/state root와 canonical cwd를 사용한다. 전역·프로젝트 지침·memory·스킬과 environment·developer/base instructions는 유지한다. 사용자 설정 원문·auth를 수정하거나 복사하지 않고 managed policy를 우회하지 않는다. 소유 cwd·선택 model/effort·제품 협업 도구를 연결한다. 공동 조사 세션에만 read-only sandbox·추가 권한 미승인·사용자 reviewer와 실행 기능 제한을 적용한다. 기존의 더 엄격한 승인은 완화하지 않으며 managed policy와 충돌하면 고정 진단으로 준비를 거절한다.
- `config/read`는 로컬 기본 model/effort와 지원 버전·응답 호환성 확인에 사용한다. config와 instructionSources/hook metadata는 private seam에만 두며 지침 출처의 존재만으로 admission을 거절하지 않는다. 제품의 두 dynamic 도구는 허용된 native 도구에 추가되며 로컬 파일 접근 전체를 격리하는 것으로 표시하지 않는다. 제품의 파일 공유 도구에는 선택 파일 snapshot·scope 검사를 계속 적용한다.
- 권한을 검증하지 못한 MCP/apps/plugins와 실행 훅은 작업 전용 제한으로 실행을 막는다. 기본/per-tool `writes`만으로 플러그인 manifest의 자동 승인을 통제하거나 초기 서버 목록만으로 실행 중 변경을 통제한다고 주장하지 않는다. 설치 버전의 제한·실효 설정·관리 정책과 실행 중 적용 경계를 확인한다. 제한이 검증되지 않으면 실행하지 않는다. PreToolUse 훅의 실패·timeout은 native 호출을 허용할 수 있으므로 단독 권한 경계나 훅 신뢰 승인 우회로 사용하지 않는다. 개인 설정 파일과 기존 CLI 로그인은 그대로 둔다.
- 최초 discovery를 포함해 모든 app-server 생성 전에 동일 cwd·환경·작업 override로 공식 `features list`를 실행한다. 이 경로가 보고한 정규화 실행 flag는 지원 stage·중복·누락·출력/시간 제한을 검사하고 요구 flag가 모두 false일 때만 child를 만든다. 관리 정책의 true pin·오류·미확인은 app-server 생성 전에 거절한다. plugins/apps/hooks·외부 실행 기능, agents와 legacy notify를 해당 작업에서 제한하고 config/read로 확인한 모든 일반 MCP 이름에 enabled=false를 적용한다. 초기 읽기에서 MCP 상태·플러그인 catalog·훅 목록을 실행 경계로 사용하지 않는다.
- stdio와 원격 제어 비활성의 프로세스 설정을 명시하고 production RPC를 읽기·owned thread/turn 수명주기의 고정 목록으로 제한한다. config·MCP·플러그인·환경의 hot reload/설치/활성 요청은 허용하지 않는다. 재실행 후 raw config의 허용된 변경만 일치하는지, 지침·개인 설정 layer·관리 요건과 정규화 features가 유지되는지 검사한다. context/turn 입력 직전에 같은 proof를 다시 확인하며 새 thread의 환경·capability roots와 turn 환경은 빈 목록으로 지정한다.
- 제품의 협업 규칙은 turn 입력에 추가하여 기존 developer/base instructions를 덮어쓰지 않는다. 개인 지침·훅·설정 원문, 인증정보, 내부 식별자와 출처 경로를 질문·final에 재출력하지 않도록 명시한다. 질문은 서버가 지정한 peer와 실행 한도로 제한하고, 등록되지 않은 root/임의 실행 명령을 웹 계약으로 받지 않는다. 공동 조사는 읽기·격리 검증·수정 제안까지만 수행하며 개인 설정과 peer 메시지를 소유자의 파일 수정 승인으로 해석하지 않는다. 격리 검증의 쓰기는 원본 프로젝트와 분리한 소유 임시 영역에 한정하고, 그 실행 경계가 확인되지 않으면 실행 대신 검증 방법을 제안한다. [S21](../../research/sources.md#s21)의 이전 격리 probe는 당시 실험 근거로 보존하고 현재 설정 유지 정책의 성공 근거로 재사용하지 않는다. 실제 합성 검증에서는 기존 지침 출처 로딩과 비공개 metadata의 중앙 비노출을 확인하며 전체 개인 파일의 접근 차단을 주장하지 않는다.
- 승인 요청은 사용자가 확정한 작업 권한 상한과 기존 managed policy 안에서 처리한다. 제품이 사용자 대신 자동 승인하지 않는다. 로컬 승인 입력이 없는 현재 headless 경로는 command/file 승인·추가 permission·MCP elicitation에 typed 거절 응답하고 로컬 소유자에게 고정 진단을 남긴다. 거절 응답 자체가 이후 실행을 자동 review하도록 설정하지 않는다. 실제 승인 UI/bridge는 이어지는 사용자 개입 명세에서 구현하며 해당 경로를 일반적인 승인 완료로 표시하지 않는다. 원시 command/path/승인 정보는 공동 방에 올리지 않는다.
- transport에서 raw provider 텍스트·native thread/turn/item ID·raw config/error는 private seam으로만 전달한다. public JSON에 응답 객체를 spread하지 않는다. item phase=null/모르는 method는 final proof가 아니다.
- native permission/user-input callback은 제품 peer 질문 도구와 구분한다. 다른 thread/turn의 질문이나 승인 응답으로 현재 attempt 권한을 획득하지 못하며 거절·timeout·연결 상실은 새 turn을 재발송하지 않는다. 소유 프로세스 정리와 늦은 callback 폐쇄를 유지한다.

### [x] Step 3: 명시적 owned context와 참가자별 로컬 설정
**File**: `packages/local-connector/src/codex-adapter.ts`, `workflow-runner.ts`, `cli.ts`, `tests/codex-adapter.test.ts`

- `runtime-capabilities`, `runtime-prepare`, `runtime-status`, `runtime-run`, `runtime-observe`를 기존 key/value flag parser에 추가한다. `runtime-prepare`는 agent ID, 확인한 공개 범위, model/effort 또는 명시적 runtime default, 선택한 상대 파일 목록, 인계 문구와 새 context 동의를 로컬에서 받는다. 실행 명령/실행 파일 경로를 웹 또는 공유 문구로 받지 않는다. 기존 register/replace의 임의 `--native-session`은 실행 소유권으로 인정하지 않는다.
- 준비 변경은 binding lock 아래 로컬/서버 active·queued·UNKNOWN을 확인하고 ready=false를 기록한 뒤 처리한다. 새 thread만 만들고 turn은 실행하지 않는다. 같은 canonical root/선택 자료/소유 context를 검증한다. 설정·맥락 변경마다 기존 `Connector.replace`의 idempotent epoch 교체를 사용한다.
- 설치 0.159.1은 no-turn `thread/start`만으로 저장 rollout을 만들지 않는다. 새 connector-owned ID에 공식 `thread/name/set`으로 고정 제품명을 지정해 materialization을 확인하고 동일 ID/cwd의 zero-turn full history를 읽은 뒤 candidate를 반환한다. 이름 설정/저장 확인 실패는 불명확 준비로 보존하며 새 thread/priming turn/history injection을 자동 생성하지 않는다. 프로세스 재시작 후 동일 ID를 read/resume할 수 있는지는 실제 no-turn probe로 별도 확인한다.
- 준비 intent/settings와 교체 operation identity를 provider 준비 전에 journal에 보존한다. 새 thread/start의 소유 ID/cwd가 확인되면 이름 설정 전에 생성 descriptor를 fsync하고, 생성 확인과 materialization/full-history 확인 상태를 구분한다. 이름·저장 확인 실패에서도 이미 생성한 ID를 잃지 않으며 불명확 준비를 새 thread로 자동 대체하지 않는다. 확인된 candidate만 서버 교체에 사용한다. 서버가 새 epoch를 적용한 직후 crash해도 같은 replace op 결과를 복원해 candidate를 finalize한다. 불명확한 교체는 old/new 어느 쪽도 ready=true로 만들지 않는다. 실패한 L2를 새 thread로 자동 바꾸지 않는다.
- 새 thread는 선택 맥락 L1로 표시하고 실행 종결 뒤 같은 owned thread 재개는 L2로 표시한다. resume 전 root/cwd/context generation/epoch/known terminal을 검사한다. 재개 응답의 실제 thread status가 idle이고 최신 turn이 journal의 마지막 owned terminal turn과 같은지 full/read-only history로 대조한다. active/UNKNOWN/추가 turn/불충분한 history이면 `turn/start`를 보내지 않는다. 빈 새 context도 owned 생성 기록과 모순되는 turn이 없는지 확인한다. unknown 또는 다른 앱의 소유 thread에는 새 입력을 보내지 않는다. `turn/start` ACK가 기존 terminal turn ID를 재사용하거나 다른 thread/cwd이면 UNKNOWN으로 남기고 해당 입력의 소유권을 추정하지 않는다.
- 선택 effort를 thread start/resume의 지원되는 `config.model_reasoning_effort`와 `turn/start.effort`에 명시하고 선택 model도 두 요청에 지정한다. thread/start·resume의 보고 model/provider/reasoningEffort와 turn 요청 model/effort를 구분한다. 알려진 model/effort mismatch는 ready/run을 거절한다. turn model/rerouted는 별도 관찰하고 결과를 숨기지 않는다. 현재 schema가 turn effort를 보고하지 않으므로 requested effort와 thread-reported effort가 같아도 turn effort는 UNVERIFIED다. clamp/alias/unsupported를 조용히 대체하지 않는다.

### [x] Step 4: 선택 파일 도구와 질문 callback의 실행 권한
**File**: `packages/local-connector/src/runtime-file-policy.ts`, `codex-adapter.ts`, `workflow-runner.ts`, 관련 단위 테스트

- 기존 scoped namespace를 유지하고 `read_workspace_file`과 `ask_peer`만 노출한다. 파일은 사용자가 로컬에서 명시적으로 선택한 최대 32개 상대 경로, 파일당 64KiB/전체 512KiB로 제한한다. absolute·..·빈 segment·backslash·NUL·symlink ancestor/target·hardlink·device/FIFO·binary·불안전 소유권을 거절한다. 일반 저장소 파일은 0644도 허용하며 합성 실험의 0600 제한을 그대로 제품 요구로 만들지 않는다.
- `.git`/credential/cache/auth/env/키 파일 등 비공개 경로와 명백한 secret 패턴을 거절한다. canonical root identity, 각 파일 dev/ino/size/mtime/ctime/hash를 준비와 read 전후에 비교한다. drift는 새 근거 확인 전까지 도구/실행을 차단하고 snapshot mismatch를 로컬 fixed 상태로 남긴다. secret 탐지가 모든 비밀을 알아낸다는 보장은 하지 않는다.
- callback은 same server attempt/fence/epoch/context/root, thread/turn ACK, native thread/turn ID, live lease/상태, exact namespace/tool/args, callId와 payload hash를 확인한다. transport RPC ID 재전달과 tool callId 재전달을 별도로 처리한다. callId가 같고 payload가 다르면 거절하며 파일 read/질문을 중복 실행하지 않는다. terminal/control/lease 상실 이후 stale callback은 거절한다.
- 비동기 ACK/파일 확인/journal/HTTP/tool 대기 뒤와 모든 부작용 직전에 signal·local admission generation·same attempt/fence/epoch·live lease를 다시 대조한다. transport의 abort 또는 `Promise.race`가 handler를 종료했다고 가정하지 않는다. admission된 준비·handler·journal·outbox 작업을 추적하며 늦은 fulfillment/rejection도 수거한다. 이미 전송된 질문은 취소가 서버 rollback이라는 가정 없이 stable receipt/미확인 intent를 보존한다.
- `ask_peer`는 request payload에 해당하는 cycle 상대에게만 서버가 라우팅하도록 질문 문구만 fixed `question` body로 전달한다. PEER run에서 재귀 질문을 받지 않는다. 질문은 길이/공개 문구/snapshot 근거와 사용자가 확인한 공개 자동 질문 scope를 검사하고 stable question op를 먼저 journal한다. 승인된 서버 receipt를 `accepted/pending`으로 즉시 반환하며 상대 답변을 기다려 origin turn을 붙잡지 않는다. 서버가 ORIGIN COMPLETED와 답변을 모두 확인한 뒤 continuation을 발급한다.
- `publicScopeConfirmed`는 확인한 방·조사 목적·선택 근거에 관한 AI 생성 결론의 사전 공유 동의이고 `autoQuestionsConfirmed`는 생성 질문의 자동 전송 동의다. 개인 설정이 생성에 영향을 줄 수 있음을 안내하며, 매 출력의 직접 승인이나 문구 전체의 출처 인증으로 표현하지 않는다. 개인 설정 원문 공개는 이 동의에 포함되지 않는다.
- final text·질문에 known root/native IDs/credential·명백한 secret/raw provider error가 들어가면 공개를 보류한다. 공개 도구 실패는 fixed code다. private local text와 공개 문구를 별도 저장하고 stdout에도 private 내용을 노출하지 않는다. `FINAL_ANSWER`는 해당 turn의 확정 답변 증거이며 평문 출처 증명이 아니다. 모르는 개인 평문까지 탐지한다고 보장하지 않는다. 제품이 관리하는 별도 개인 설명 이력의 자동 import/resume/fork는 금지하며 개인 설명 기능 구현은 후속 범위로 유지한다.

### [x] Step 5: 실제 workflow 실행과 내구 intent/outbox
**File**: `packages/local-connector/src/workflow-runner.ts`, `cli.ts`, `tests/workflow-runner.test.ts`

- 현재 `cli.ts:118–130`의 whole-command profile lock을 runtime long-lived 명령에서 해제한다. runner는 binding/session lock을 잡고 profile credential/scope/mapping을 짧게 읽는다. 기존 짧은 명령의 동작은 유지한다. 현재 credential을 다시 읽어 rotation 뒤 lease/poll/outbox가 새 키를 사용하도록 한다. pending rotation의 복구는 `Connector.rotate`의 기존 op로 처리한다.
- 로컬 profile 잠금 재시도의 2초 제한은 단조 증가하는 경과 시간으로 판단한다. 자격 증명·서버 lease/deadline의 절대 시각 검사는 유지하며 시스템 시각 변경이나 테스트의 Date 이동으로 짧은 잠금 경합이 즉시 만료되거나 무기한 연장되지 않아야 한다.
- 요청을 보낸 키와 현재 profile 키를 구분한다. workflow 401/403에서 즉시 권한 취소로 판정하지 않고 새 admission을 잠시 닫은 뒤 짧은 profile lock 아래 pending rotation을 같은 op로 복구한다. device/server/room scope/agent/epoch가 그대로이고 키만 바뀌었으면 같은 action/body/op를 새 키로 lease deadline 안에서 최대 1회 재시도한다. poll도 같은 body로 제한 재시도한다. rotation 중 불명확 credential은 새 호출에 사용하지 않으며 키가 같거나 새 키 재시도도 거절되거나 scope가 바뀌면 실제 authority loss로 처리한다. 이 복구 중 파일/질문 권한은 재검증 전 열지 않는다. complete/outbox의 동일 op도 새 키로 복구할 수 있어야 한다.
- runner 시작 시 local verified context/settings, credential, 중앙 poll scope/epoch를 대조한 후 ready를 보고한다. ready는 서버의 reported 상태이며 provider 로그인/실제 모델 성공과 동일한 verified 증거로 표시하지 않는다. idle poll은 기본 2초, readiness 갱신은 20초 이내로 제한한다. 한 binding에 하나의 소비자만 실행한다.
- claim의 stable op를 먼저 저장하고 claim 결과의 exact identity를 기록한다. 서버 start-intent를 journal/호출/확인한 뒤, provider turn/start의 local durable intent를 fsync한 후 한 번만 보낸다. 확인되지 않은 intent/ACK/저장 실패는 UNKNOWN이다. 중앙 또는 로컬 start-intent만 남은 restart에서도 turn/start를 재발송하지 않는다. 안전하게 unstarted임이 증명된 claim만 서버 lease 만료/새 fence 규칙에 맡긴다.
- claim 후 준비/turn 대기/실행/terminal 업로드 중에도 lease 갱신과 control poll을 별도 bounded 루프로 실행한다. 30초 lease를 고려해 8초 이내 갱신하며 각 응답의 attempt/fence/epoch/state를 검증한다. 새 lease renewal은 새 op이고 유실한 한 호출의 재시도는 같은 op이다. ready/poll/lease 모두에 서버 timeout/bounded backoff를 적용한다.
- control은 같은 request/attempt/fence를 대조해 해당 native turn만 interrupt한다. native ACK를 받은 뒤 stable `interrupt-ack` outbox를 업로드한다. ACK는 terminal이 아니다. 자연 COMPLETED/FAILED와 경합하면 실제 matching terminal을 보존한다. lease/network/scope/epoch 상실은 도구·새 입력을 즉시 차단하고 bounded interrupt/terminal 관찰 후 UNKNOWN으로 남긴다.
- terminal은 matching native turn의 typed terminal만 허용한다. 같은 turn의 final_answer item을 ID/hash로 dedup하며 full items view 또는 matching item/completed 증거가 있어야 문구를 사용한다. commentary/phase unknown/partial items/다른 turn의 문구를 완료 답변으로 추정하지 않는다. 문구를 확인하지 못한 COMPLETED는 빈 publicText와 로컬 미확인 사유를 저장한다.
- terminal/private text/관찰값/public projection을 먼저 fsync하고 `complete` outbox를 만든 뒤 업로드한다. UNKNOWN 중앙 상태이면 명시적 `observe`의 별도 op로 같은 terminal 증거를 업로드한다. 완료 응답 유실은 같은 body/op를 재전송하며 새 turn을 만들지 않는다. adoption ACCEPTED/HISTORICAL/HUMAN_INPUT_REQUIRED는 중앙 결과를 그대로 기록한다. publication이 실패해도 terminal 기록은 삭제하지 않는다.

### [x] Step 6: 재시작·복구·교체·로컬 취소 보호
**File**: `packages/local-connector/src/runtime-store.ts`, `workflow-runner.ts`, `cli.ts`, 관련 단위/통합 테스트

- startup recovery는 queued 새 요청보다 먼저 동일 action/body/op의 미확인 작업을 검증한다. Native·terminal·tool 증거가 없고 저장된 snapshot 및 start-intent 증거에 시작 기록이 없는 claim은 원래 claim receipt를 현재 scope/epoch에서 HTTP로 다시 확인한다. 완전 일치하는 old attempt/fence의 ABANDONED·startIntentAt=null 증거만 별도의 내구 NOT_STARTED 종결로 보존한다. 원래 CONFIRMED receipt는 변경하지 않고 해당 미전송 start-intent는 재전송하지 않는다. claim의 내구 TRANSMITTED 이전임이 증명된 경우도 current scope 확인 뒤 로컬 미전송 증거로 종결할 수 있다. poll의 attempt=null·409·lease 만료만으로 종결하지 않으며, native/provider intent 또는 non-null start-intent·모순된 증거·revocation/epoch 변화는 UNKNOWN으로 유지한다. 같은 request의 새 fence는 새 claim/journal로 처리하며 실제 호출이 있었을 가능성이 있는 요청을 자동 재호출하지 않는다.
- exact SERVER_ABANDONED·startIntentAt=null 증거로 NOT_STARTED를 확정할 때, 동일 request/attempt/fence/epoch에 연결된 PENDING·TRANSMITTED lease 기록도 폐쇄한다. 이미 NOT_STARTED로 저장된 재시작에서도 현재 권한과 원래 claim의 동일 증거를 확인한 뒤 남은 lease 기록만 정리한다. NOT_STARTED와 종결 증거, CONFIRMED receipt·body·hash는 변경하지 않는다. 다른 identity의 기록과 LOCAL_NOT_TRANSMITTED 증거에는 이 경로를 적용하지 않으며 lease·start-intent·provider 호출을 재전송하지 않는다. 늦은 기존 lease 응답은 폐쇄된 기록을 다시 쓰지 못한다.
- `runtime-observe`는 사용자가 명시적으로 선택한 동일 owned thread/turn의 read-only 저장 기록만 조회한다. active resume/turn/start 없이 matching typed terminal과 complete items 증거를 확인할 수 있을 때만 `observe`를 보낸다. partial/active/locator 없음/서로 다른 turn은 UNKNOWN 유지다. read-only 조회가 새 provider 호출이나 새 조사 입력을 만들지 않는다.
- replace/prepare는 local active/UNKNOWN/pending publication과 중앙 queued/active/UNKNOWN이 있으면 거절한다. runtime-run 동안 status/키 rotation은 가능하다. revoke-local은 진행 중 child/intent/outbox가 있을 때 profile을 먼저 지워 종료 추적을 잃지 않는다. 확인된 terminal·업로드 완료 또는 검증된 NOT_STARTED 종결에서 미확정 intent/outbox가 없을 때만 exact profile-owned runtime 저장물을 삭제한다. 만료·철회·연결 단절 상태의 로컬 제거는 서버 인증 복구를 요구하지 않는다. 동일 profile의 내구 소유 identity와 binding/session 잠금을 확인하는 삭제 전용 경로를 사용하며 UNKNOWN·미확정 publication·실행 중 consumer는 계속 거절한다. prepare/run/replace/observe의 서버 권한 검사는 유지한다. 기기 중앙 revoke는 기존 웹 흐름을 유지하고 실행기는 서버 거절 뒤 안전하게 admission을 닫는다.
- SIGINT/SIGTERM은 새 claim/tool admission을 닫고 addressed interrupt를 요청한 뒤 bounded terminal 관찰·journal·소유 child cleanup을 끝낸다. SIGKILL/crash 뒤 실제 provider intent가 있거나 실행 여부를 확정하지 못하면 UNKNOWN이다. 안전한 unstarted claim은 위의 별도 증거 경로로만 종결한다. 도구/process 종료 실패를 fixed 미확인으로 보고하고 다른 profile/앱 process를 종료하지 않는다.
- 종료 시 binding/session lock을 해제하기 전에 admission된 준비·handler·journal·outbox 작업을 bounded drain한다. drain을 완료하지 못하면 모든 후속 local mutation을 금지하는 폐쇄 generation을 설정하고 durable UNKNOWN/미확인 operation을 보존한다. 이후 늦은 async 작업은 await 뒤 재검증에서 거절돼 새 runner의 저장물을 바꿀 수 없어야 한다. 이미 전송된 HTTP는 취소만으로 미실행으로 표시하지 않는다. 이 폐쇄를 보장할 수 없으면 해당 session lock/프로세스를 살아 있는 상태로 유지하고 fixed cleanup 미완료를 보고한다.

### [x] Step 7: 실제 중앙 계약과 제품 실행기 통합 검증
**File**: `tests/integration/owned-codex-workflow.test.ts`, `tests/helpers/owned-runtime-fixture.ts`, test entrypoints

- 기존 owned local-access/workflow fixture를 사용하고 actual Auth/DB/HTTP+제품 runner+격리 가짜 provider를 연결한다. 테스트만 쓰는 dependency injection은 CLI flag/환경에서 임의 executable/adapter로 열지 않는다. admin/DB/key fixture 환경은 provider child에 전달하지 않는다.
- 질문→peer→continuation, 중복 receipt, crash/ACK 유실/terminal upload 유실, interruption, pause/epoch/key rotation/revoke, 두 runner의 same session 경합을 실제 중앙 상태/이력으로 검증한다. 기존 006 가짜 driver와 중복되는 서버 단독 검사를 늘리지 말고 제품 runner가 실제 API를 쓰는 seam을 확인한다.
- parent가 별도 opt-in bounded 실제 provider 검증을 수행한다. 서로 다른 두 owned profile/root/context와 실제 설치 Codex의 각자 지원 선택값을 사용한다. 두 binding 준비 후 human start로 실제 A 도구 질문→B 파일 근거 답변→A L2 continuation 최대 3turn/새 질문 1회만 허용한다. unexpected extra question은 같은 cycle을 pause하고 채택하지 않는다. 모델은 확인한 실제 로컬 계정 권한에서 선택하고 지원 effort를 명시한다.
- 실제 표본은 namespace/file/tool/terminal, cycle/request/attempt/fence/epoch 상관, 요청/관찰 model·effort, native IDs/root/secret 비노출, provider child 제한과 소유 process 정리를 증명한다. fake provider 성공·명령 시작·interrupt ACK만으로 실제 수용을 통과 처리하지 않는다. 실제 계정/허용 환경이 없으면 미통과 검증을 명세에 명확히 남긴다.

### [x] Step 8: 현재 동작 문서·전체 검사·독립 구현 리뷰
**File**: 관련 `docs/`, `README.md`, 이 active spec

- 새 runtime CLI 준비/실행/복구와 requested/thread-reported/turn-unverified 설정, L1/L2·owned session 제한을 문서화한다. 웹이 아직 settings를 선택/표시하지 않는 범위와 Claude·cross-provider·two-PC 미검증을 유지한다. 현재 fixed 서버 API가 runtime-specific 값을 받는다고 쓰지 않는다. code-derived 문서는 source scope freshness를 갱신하며 Git 부재를 hash로 가장하지 않는다.
- required 검사를 완료하고 동일 code/input의 passing checks는 근거 hash를 확인해 재사용한다. root가 실제 변경·callers·test entries를 확인한 뒤 별도의 새 reviewer가 implementation diff/plan/settings/evidence를 검토한다. 실패는 같은 worker에서 수정하고 영향 검사/리뷰를 갱신한다.
- 모든 step/test/실제 수용이 완료되고 independent CRITICAL/HIGH가 해소된 뒤에만 이 spec을 archive한다. 전체 제품 goal은 이어지는 웹 설정·Claude/개입·Realtime·두 PC 범위가 남아 있으므로 완료하지 않는다.

## Tests

기존 Node runner/fixtures에 다음 이름의 동작 검사를 구현한다. `should` 이름은 각 모듈의 test 파일에 유지하며 의미가 같은 한 검사로 여러 조건을 묶을 수 있다.

1. `should persist validated runtime journals atomically and refuse unsafe files` — strict schema/0700/0600/UID/nlink/symlink/size/atomic crash와 identity.
2. `should admit only one runner for the same binding and owned session` — 서로 다른 profile 포함 lock 경합, stale PID 회수 뒤 UNKNOWN.
3. `should recover pending operations without changing their action or payload` — op/action/body hash 고정과 response 유실.
4. `should preserve independent model and effort choices for each binding` — 모델별 capability/default/목록 pagination/지원 밖 조합.
5. `should distinguish requested settings from thread reports and unverified turn effort` — mismatch/clamp/reroute/null·누락·misleading verification event.
6. `should preserve personal agent settings without bypassing permissions` — global/project instructions·개인 설정 파일·기존 로그인 유지, 공동 조사 read-only sandbox와 검증되지 않은 MCP·플러그인·훅의 작업 전용 실행 제한, 기존 승인 및 managed 정책 비우회, child의 제품/fixture secret 제외와 private config 비노출.
7. `should bind new and resumed contexts to explicit ownership root and epoch` — 외부 session 거절, L1/L2, 다른 cwd·UNKNOWN·implicit fallback 거절.
8. `should finalize a prepared context after an idempotent epoch replacement` — replace 적용 직후 crash와 same op/candidate 회복, 불명확 준비 거절.
9. `should read only selected unchanged text files through scoped tools` — traversal/symlink/hardlink/FIFO/binary/secret/크기/drift/fstat 및 0644 일반 파일.
10. `should reject tool callbacks outside the acknowledged live attempt` — ACK 전/다른 turn/root/epoch/fence/lease/control/terminal 뒤 callback.
11. `should deduplicate tool rpc ids and call ids without duplicating peer questions` — 같은 payload receipt 재사용/다른 payload 거절/late result 수거.
12. `should publish only validated public questions and final text` — private root/native/key/error 비노출, unknown phase/commentary/partial view·다른 turn 제외.
13. `should persist central and local intent before invoking a provider once` — claim/start-intent/provider intent crash 지점과 IPC 직후 ACK/저장 유실, no replay.
14. `should continue leases and controls while preparation or provider execution waits` — bounded deadline/backoff, 갱신 fence·state 확인, stalled turn-start.
15. `should use rotated credentials without holding the profile lock for a whole run` — 실행 중 status/rotate 가능, pending rotation exact 복구, 새키·old키 거절.
16. `should acknowledge interrupt delivery separately from terminal completion` — matching native ACK, 자연 완료/실패 경합, unconfirmed terminal UNKNOWN.
17. `should stop tool admission after scope lease or connection loss` — stale callback/새 입력 차단, bounded interrupt/cleanup, terminal 보존.
18. `should persist terminal evidence before retrying publication` — outbox response 유실/restart/exact retry, adoption 분리, no provider rerun.
19. `should keep unknown attempts blocked until matching read-only terminal evidence arrives` — partial/missing/다른turn 거절, explicit observe only, no resume/start.
20. `should refuse replacement or local deletion while runtime evidence is unresolved` — active/UNKNOWN/pending publication/queued 중앙 상태, safe exact owned 삭제.
21. `should journal shutdown and reap only the owned provider process` — SIGINT/SIGTERM/cleanup 실패, unrelated child 유지, SIGKILL 이후 UNKNOWN.
22. `should complete an origin peer and continuation through the product runner` — actual Auth/DB/HTTP+fake adapter, samecycle receipt 및 L2.
23. `should recover runner crashes and lost responses against the actual coordinator` — actual 중앙 intent/UNKNOWN/outbox/중복 op·기록.
24. `should reject stale runner authority after rotation pause replacement or revocation` — actual device/fence/epoch/control/key 검증과 healthy peer 유지.
25. `should preserve safe claims under concurrent runner and session admission` — actual claim 경합/lease expiry, provider 실행은 하나만.
26. `should retry in-flight workflow operations with the same payload after credential rotation` — 구키 요청 지연/401, rotation 응답 유실, lease/poll/complete 경합을 현키 same op로 제한 복구; 실제 scope 상실은 차단.
27. `should refuse turn submission when resumed history is active unowned or incomplete` — actual status/history와 마지막 owned terminal 대조, 추가 turn/active/partial에는 turn/start 미전송, 이전 turn ID ACK 재사용 UNKNOWN.
28. `should drain or permanently close admitted asynchronous work before releasing runtime locks` — ACK 또는 journal/질문 직전 대기를 멈춘 뒤 control·lease loss·SIGTERM, 늦은 callback의 새 journal/질문 금지와 전송한 receipt 보존.

별도 실제 provider 수용은 Step 7의 3turn 왕복과 실제 bounded interrupt→typed terminal 1건을 parent private 보고서로 기록한다. fake unit/integration 이름이 있다는 이유로 그 수용을 통과 처리하지 않는다. 호출 상한은 제품이 주 세션에 직접 전송하는 `turn/start` 3건과 중단 검증 1건에 적용한다. 유지한 memory·공급자 내부 작업 등의 추가 모델 사용량까지 이 카운터로 제한하거나 측정했다고 주장하지 않는다.

## Risks

- Codex experimental dynamicTools·설치 schema 변화: 버전/응답/실효 정책을 검사하고 미확인 조합은 fail closed한다. 실험 소스와 제품 어댑터를 억지로 공통 패키지화하지 않는다.
- durable intent는 실제 turn 시작 여부를 완전히 확인할 수 없는 장애를 만든다. 안전성을 위해 UNKNOWN에서 자동 재실행하지 않고 read-only 종결 증거 또는 사람의 후속 결정을 기다린다.
- 로컬 session 잠금은 외부 앱의 모든 접근을 금지하지 못한다. connector-owned 세션만 사용하고 임의 session attach를 지원한다고 표시하지 않는다.
- 모델 보고 설정은 turn 적용 증거와 다르다. 실제 effort 미확인과 reroute를 보존하고 지원 밖 조합을 조용히 보정하지 않는다.
- 선택 코드/인계 문구와 공식 CLI가 로드하는 개인 지침은 자기 공급자의 로컬 실행 입력이다. 제품은 설정 원문·키·native식별자를 중앙 DTO에 복제하지 않고 사전 동의한 생성 질문·결론과 선택 근거를 공동 방에 전송한다. 추가 협업 지침은 설정 원문 재출력을 금지하며 알려진 민감값과 미확정 출력은 보류한다. native/MCP 도구의 전체 입력이나 생성 문구의 모든 출처를 제품 allowlist로 검증한다고 주장하지 않는다. 모르는 평문 비밀까지 매번 확인해야 하는 엄격한 공유 정책은 출력별 소유자 확인을 추가하는 별도 제품 선택이다.
- 공식 선행 CLI와 app-server는 설정·cloud 관리 요건을 각각 로드한다. admission 동안 설정이 안정적인 환경을 지원하며 두 프로세스 사이 외부 소유자·관리자의 동시 변경을 원자적으로 차단한다고 주장하지 않는다. 시작 직후와 context/turn 전에 drift를 발견하면 종료하고 공동 입력을 거절한다. managed policy 우회나 개인 설정 파일 변경으로 이 제한을 숨기지 않는다.
- 현재006의 room-wide historical rows 잠금/room request index 부재는 후속 성능 항목으로 남긴다.007은 쿼리/SQL 변경이나 확장성 주장을 하지 않는다.
- 한 PC의 두 owned context 왕복은 두 사람의 계정·두 PC·Claude·클라우드 제품 적격성 증거가 아니다. 인증·과금·환경의 검증 범위를 별도 기록한다.

## Verification

- Node 24 환경에서 `npm --prefix packages/local-connector run typecheck`, `run build`, `test`.
- root `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- owned loopback stack에서 `npm run test:integration:runtime` 신규 진입점, 기존 `test:integration:workflow`, `test:integration:devices`, `test:integration`의 영향 회귀.
- `test:e2e:workflow`, `test:e2e:devices`, `test:e2e:auth`, `test:e2e`는 관련 입력이 바뀌면 수행하고 동일 입력의006 passing 결과는 hash 확인 후 재사용한다.
- 실제 Codex는 parent의 opt-in fixture에서 Step 7 범위만 실행한다. provider child env에 DB/admin/제품 fixture 키가 없는지 검사하고 소유 프로세스를 종료·reap한다. secret/native/root를 출력하지 않는다.
- migration001–006/archive002–006/experiment runtime/prototype의 사전 SHA baseline 동일성, connector workflow mirror byte 동일성, named tests28개 존재, doc local links/anchors를 검사한다. 초기 구현은 Git 없이 scratch frozen copies·SHA inventory·unified diff로 검토했다. 2026-10-02 생성된 Git의 초기 commit은 source16 구현을 포함한다. 이후 변경은 `impl/007-owned-codex-workflow-runner`에서 관리하며 기존 frozen 리뷰 증거를 유지한다.

## Review Notes

2026-10-02 source17 기준 Step 1–8을 완료했다. 기본 paginated 이력에 대응하는 명시적 legacy 생성과 회귀 검사를 추가했으며 원래 전체 connector 검사는 147/147 통과했다. source16의 변경 없는 서버·브라우저 결과와 formal round3을 재사용하고 source17 보정·실제 수용 스크립트 변경은 독립 추가 검토했다. 실제 공식 Codex 질문 왕복 1회는 ORIGIN·PEER·CONTINUATION 입력 3개의 정상 완료·업로드 뒤 검증 스크립트의 ANSWER 개수 assertion에서 실패했으며, 보존한 원본 실패와 공식 native read·control-flow audit으로 완료 근거를 확인했다. 정리된 DB 이벤트 원문 재검증의 한계를 유지한다. 별도 실제 중단 1회는 중앙 ACK·typed INTERRUPTED·업로드·cleanup을 통과했다. 과거 rotation timing MEDIUM의 원인은 UNCONFIRMED다. 변경 문서와 종료 증거의 별도 독립 검토 및 링크 검사를 완료하고 보관했다. 현재 진행 상태의 정본은 [개발 순서와 검증 계획](../../planning/delivery-and-validation.md)이다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan round1: in-flight old credential rotation | HIGH | ACCEPTED | Step5에서 pending rotation 복구·same action/body/op 현키 제한 재시도를 규정하고 test26에 lease/poll/complete 경합을 추가했다. |
| Plan round1: active/unowned turn on L2 resume | HIGH | ACCEPTED | Step3의 실제 idle/full history·last owned terminal 대조와 이전 turn ACK 거절, test27의 turn/start 미전송 검사를 추가했다. |
| Plan round1: late admitted async mutation after cancellation | HIGH | ACCEPTED | Step4/6에서 await 뒤 재검증·작업 추적·lock 해제 전 drain/폐쇄를 규정하고 test28에 취소 경합을 추가했다. |
| Effective policy proof boundary | INFO | ACCEPTED | S21의 실효값 확인과 최종 모델 입력 격리 증거를 구분하고 필수 hooks/approval 우회 금지를 Step2에 명시했다. |
| Plan round2: code line reference | LOW | ACCEPTED | 실제 `cli.ts:118–130`의 profile 잠금 위치로 참조를 바로잡았다. 동작 계획은 동일하다. |
| Independent plan round2 | INFO | PASS | CRITICAL/HIGH/MEDIUM 0. 수정한 경합·policy 절을 재검토했고 나머지 round1 근거는 재사용했다. |
| User clarification: existing agent settings | INFO | ACCEPTED | 기존 개인·프로젝트 설정을 그대로 적용하도록 사용자 확정을 반영했다. 이전 자동 입력 격리 정책을 대체하고 설정 유지·승인 비우회·공동 정보 projection의 변경 범위를 별도 검토한다. |
| Installed no-turn context persistence | HIGH | ACCEPTED — VERIFIED | 실제 설치 probe에서 start-only thread의 full read/restart resume 실패를 재현했다. 새 owned ID의 name/set 후 materialization·zero/full history와 동일 ID 재시작 검증을 구현했다. source17의 explicit legacy 생성·회귀 및 실제 설치 검증을 완료했다. |
| Personal-settings review: runtime environment | HIGH | ACCEPTED — VERIFIED | 사용자 환경·프록시·인증서를 보존하고 제품/fixture 주입 secret을 제외하도록 보정했다. 현재 합성 검사·독립 구현 리뷰와 실제 provider 환경 검증을 완료했다. |
| Personal-settings review: task write authorization | HIGH | ACCEPTED — VERIFIED | 사용자가 공동 조사를 읽기·검증·제안으로 확정했다. 개인 설정 파일을 유지하며 작업의 read-only sandbox·원본 수정 금지 협업 입력·미승인 요청 거절을 구현하고 독립 검토했다. 미검증 외부 실행의 제한은 후속 사용자 선택을 따른다. |
| Independent read-only task overlay review | INFO | PASS WITH VERIFICATION BOUNDARY | 개인 설정 파일 보존·작업 권한 축소·managed 충돌 거절·도구별 승인 및 reviewer 우선순위·typed 미승인 응답의 설계는 차단 지적 없이 통과했다. 설치 버전의 적용 및 실제 승인 경로는 별도 검증하며 외부 도구·trusted hook의 임의 부작용 차단으로 확대하지 않는다. |
| Native runtime MCP authority design review | CRITICAL/HIGH | REJECTED — REPLACED | 플러그인 manifest의 도구별 자동 승인 우선순위, 상태 목록의 출처·원자성 한계, 실행 중 bundle 갱신으로 초기 overlay만으로 읽기 전용 권한을 검증할 수 없음을 확인했다. 해당 설계의 실제 turn 실행은 승인하지 않았으며 작업 전용 실행 제한으로 대체한다. |
| User clarification: readonly execution priority | INFO | ACCEPTED — VERIFIED | 전역·프로젝트 지침과 개인 설정 파일은 유지하고 공동 조사에서 권한을 검증하지 못한 MCP·플러그인·훅 실행을 제한하도록 사용자가 확정했다. 작업 전용 제한의 구현·설치 버전 검사·독립 리뷰를 완료했다. |
| Readonly execution design2: pre-RPC plugin startup | HIGH | ACCEPTED — DESIGN3 VERIFIED | 관리 plugins pin이 CLI false보다 우선하고 최초 생성자가 검사 RPC 전에 plugin 동기화를 시작함을 확인했다. 매 child 전에 공식 features list로 정규화 flag를 확인하도록 보정하고 구현·설치 검증·독립 리뷰를 완료했다. 두 프로세스 간 동시 외부 변경의 비원자성은 Risks에 유지한다. |
| Terminal receipt / lease race | HIGH | ACCEPTED — VERIFIED | 실제 중앙의 완료 200과 lease 409가 교차해 로컬 TERMINAL만 남는 실패를 재현했다. 정확한 active publication receipt가 monitor를 닫고 내구 저장 완료 후에만 UPLOADED로 전이하도록 보정했다. 현재 전체 합성 검사·실제 runner 및 formal round3 검토를 완료했다. 별도 rotation timing 실패의 원인은 확정하지 않는다. |
| Native catalog/detail state authority | INFO | SUPERSEDED BY EXECUTION DESIGN3 | S26의 설치 버전 소스와 모델 없는 제품 조회에서 선택 cwd catalog와 상세 조회의 설치·활성 boolean 차이를 확인했다. 이 조회를 실행 제한의 증거로 쓰던 설계는 관리 pin과 초기 실행 문제로 대체했다. 현재 계획은 catalog/detail RPC를 호출하지 않고 공식 preflight·작업 gate·정규화 설정을 확인한다. 이 행은 이전 조사 경위를 남긴다. |
| Personal-settings review: public text provenance | HIGH | ACCEPTED — VERIFIED WITH CLARIFIED SCOPE | 사전 자동 공유 동의·원문 재출력 금지 지침·알려진 민감값 projection을 구현하고 현재 합성·독립 구현 검토를 완료했다. 전체 native 출처 증명이나 임의 평문 비밀 탐지 주장은 하지 않는다. |
| Personal-settings review: created ID before persistence | MEDIUM | ACCEPTED | 이름/저장 확인 전에 생성 descriptor를 내구 기록하여 실패 뒤에도 소유 ID를 보존한다. 생성 기록을 materialized candidate와 구분하고 자동 재생성하지 않는다. |
| Active-readiness regression: local lock elapsed deadline | HIGH | ACCEPTED | 동결 소스의 진단으로 가속 Date가 profile-lock 재시도를 즉시 만료시켜 TERMINAL 중 갱신을 닫는 실패를 재현했다. 로컬 제한만 monotonic 경과 시간으로 보정하고 전후 회귀·전체 검사로 확인한다. |

| Formal implementation round1: callback operation guard | HIGH | PASS — ROUND2 VERIFIED | question-call-intent 이후 operation-intent에도 같은 callback guard를 전달했다. 합성 회귀 검사와 round2 독립 리뷰에서 해당 보정을 확인했다. |
| Formal implementation round1: late profile auth error | HIGH | PASS — ROUND2 VERIFIED | pending rotate의 늦은 인증 오류 분기에도 live 검사와 guarded write를 적용했다. 합성 회귀 검사와 round2 독립 리뷰에서 해당 보정을 확인했다. |
| Formal implementation round1: safe unstarted recovery | HIGH | PASS — ROUND3 VERIFIED | exact claim receipt의 NOT_STARTED 증거와 새 fence journal을 구현했다. round2에서 남은 미확정 lease를 보정했고 round3에서 exact proof와 내구 종결 보존을 확인했다. |
| Formal implementation round2: unstarted lease closure | HIGH | PASS — ROUND3 VERIFIED | 서버의 정확한 미실행 증거에 연결된 미확정 lease만 폐쇄하고, 이미 NOT_STARTED인 재시작에서도 동일 검증으로 남은 기록을 정리한다. 원래 종결 증거와 CONFIRMED receipt는 보존한다. |
| Formal implementation round2: rotation timing evidence | MEDIUM | ACCEPTED — CAUSE UNCONFIRMED | 키 rotation 검사 1회의 TERMINAL/UPLOADED 불일치 원인은 아직 확인하지 못했다. 제한된 집중 검사에서 진단 정보를 확보하고, 재현되지 않으면 과거 실패 원인을 확인된 사실로 쓰지 않는다. |
| Formal implementation round3: expired resolved local revoke | HIGH | PASS — ROUND3 VERIFIED | 007의 삭제 guard가 만료된 완료 profile의 로컬 제거와 fresh pairing을 막았다. 만료·철회·단절 상태의 완료 기록 삭제와 fresh pairing을 RED3→GREEN3으로 확인했다. 모든 agent의 내구 소유·잠금·미확정 작업 검사와 실행 권한 검사는 유지한다. |

| Final documentation and evidence closure | INFO | PASS | 새 C0/H0/M0, LOW의 왕복 횟수 표기를 수정했다. 원래 전체 검사·실제 수용·변경 없는 검토와 검사 재사용 범위를 대조했다. 과거 rotation MEDIUM의 원인 미확인을 유지한다. 전체 제품 완료 판정은 아니다. |
