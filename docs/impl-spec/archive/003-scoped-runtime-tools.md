---
status: done
date: 2026-10-01
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 003 — 허용된 파일 도구와 구조화된 질문의 런타임 호환성

## Context

[PRD의 로컬 AI 연결](../../PRD.md#로컬-ai-연결)을 구체화한다. 001의 실제 Codex 새 실행·저장 맥락 재개·중단은 확인했지만, 추가 파일 읽기 요청은 `READ_UNAVAILABLE`로 끝났고 모델의 파일 도구 호출은 관찰하지 못했다. [실제 증거와 한계](../../local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)를 기준으로 공동 조사 이전에 도구 경로를 검증한다. 전체 순서는 [로드맵](../../delivery-and-validation.md#단계별-명세-범위)을 따른다.

읽기 전용 planner가 현재 transport/runtime와 설치된 Codex 0.159.1의 stable 314개·experimental 440개 schema를 확인했다. `thread/start.dynamicTools`는 experimental schema에 있고 `initialize.capabilities.experimentalApi` opt-in 및 서버 callback `item/tool/call`이 필요하다. 현재 `StdioClient`는 opt-in하지 않고 해당 callback을 거절한다. `thread/resume`에는 `dynamicTools` 재등록 필드가 없으므로 저장 thread의 도구 보존을 실제로 확인해야 한다. schema 존재를 실제 호출 성공으로 기록하지 않는다.

이번 범위는 기존 독립 실험 package를 확장하는 Codex 합성 호환성 검사다. 실제 팀의 공급자·L3 필수 여부는 미결로 유지한다. 이 실험으로 상대 사용자의 도구를 정하거나 개인 저장소·공동 방과 연결하지 않는다. 인증·기기 pairing·DB·Realtime·웹 실제 연동은 다음 명세이며 미리 상세 계획을 고정하지 않는다.

### 범위와 완료 기준

- 새 합성 workspace에서 `read_workspace_file`과 `ask_peer`를 명시적으로 등록하고 실제 모델 callback을 관찰한다.
- 읽기는 로컬에 고정한 공개 합성 파일 allowlist만 허용한다. 웹의 경로·임의 shell·실제 사용자 저장소를 입력으로 받지 않는다.
- `ask_peer`는 고정 상대 별칭을 대상으로 하는 구조화된 로컬 fixture 수신 기록이다. 실제 상대 AI·내구 메시지·권한·두 PC 왕복의 증거로 표현하지 않는다.
- 실제 파일에만 있는 임의 표식을 prompt에 재전달하지 않고 읽어 응답 hash가 일치해야 파일 읽기 성공이다. 저장 맥락 표식과 혼동하지 않는다.
- 새 프로세스의 동일 소유 thread/cwd resume에서 파일 표식을 새 값으로 교체한 뒤 callback과 hash를 다시 확인한다. 과거 응답의 반복으로 저장 도구 보존을 통과시키지 않는다.
- 기본 검사와 독립 리뷰를 통과한 뒤 실제 새 실행·resume의 도구 가용성·종결·정책 증거를 기록한다. 실제 callback이 없거나 보존이 안 되면 해당 항목은 미검증/미지원으로 남고 명세를 완료·archive 처리하지 않는다. 자동 새 thread fallback은 없다.

## Affected Files

기존 행 번호는 구현 전에 다시 확인한다. 001의 기본 probe/run/resume 동작과 루트 웹 import graph를 유지한다.

1. `experiments/local-ai-runtime/src/stdio-client.ts` — opt-in 초기화, 고정 dynamic-tool callback, 응답 write/timeout/종료 수거, sanitized agent-message phase. 기본 client는 기존처럼 opt-out한다.
2. `experiments/local-ai-runtime/src/workspace-file-policy.ts` — 합성 공개 파일의 allowlist·경로·파일 형식·크기 검증과 제한 읽기.
3. `experiments/local-ai-runtime/src/scoped-tool-experiment.ts` — 기존 `CodexRuntime` factory seam을 사용하는 wrapper, 도구 등록·현재 turn 결합·callback 중복 제거·policy preflight·표식 증거.
4. `experiments/local-ai-runtime/src/tools-cli.ts` — 별도 opt-in CLI 진입점과 소유 실험 조회. 기존 `cli.ts`의 명령 의미를 변경하지 않는다.
5. `experiments/local-ai-runtime/src/experiment-policy.ts` — 대화 표식을 쓰지 않는 실험의 `contextMarkerHash` 생략을 허용한다. 기존 필수 호출자와 잠금·시작 의도·UNKNOWN 계약을 보존한다.
6. `experiments/local-ai-runtime/package.json` — 새 tools scripts와 전체 `dist/test/*.test.js` 실행. 의존성·lockfile 변경은 필요 없다.
7. `experiments/local-ai-runtime/test/fixtures/fake-app-server.ts`, `test/scoped-tools.integration.test.ts` — 실제 child process의 callback·early ACK·중복·종료·정책·파일 경계 검증.
8. `README.md`, `docs/local-ai-connection-research.md`, `docs/decisions-and-open-items.md`, `docs/delivery-and-validation.md` — 실제 확인된 결과와 남은 통합 조건. 총괄이 갱신한다.

## Affected Dependents

- `CodexRuntime`은 기존 `RuntimeClient` factory를 통해 동일한 journal/lock/deadline/interrupt/UNKNOWN 처리를 사용한다. callback 지원 때문에 별도 turn lifecycle을 복제하지 않는다.
- `StdioClient.launchForTest`와 기존 fake transport tests는 opt-in 옵션의 기본값이 false인 상태를 계속 검증한다. 승인 callback은 기존처럼 거절한다.
- `ExperimentStore.create`의 hash 입력은 optional이 되지만 001 CLI는 실제 대화 표식 hash를 그대로 전달한다. 파일 표식은 해당 hash 필드로 기록하지 않는다.
- npm test glob 확장은 기존 34개 검사와 새 검사를 모두 실행한다. 루트 Next package/types/lint/test에는 실험을 포함하지 않는다.
- product API·binding DTO·DB schema를 정의하는 변경이 아니다. future connector가 이 실험의 로컬 fixture 수신 기록을 durable delivery로 재사용하면 안 된다.

## Implementation Steps

### [x] Step 1: 명시적인 experimental callback transport
**File**: `stdio-client.ts`, fake subprocess, 새 integration tests
- `experimentalApi`와 dynamic tool handler는 명시적으로 설정할 때만 켠다. handler가 없는 기본 경로의 미지원 callback/승인 거절을 유지한다.
- `item/tool/call`의 RPC response ID와 params의 `callId`를 분리한다. params를 unknown으로 받아 handler 경계에서 threadId·turnId·callId·tool·arguments를 검사한다. 결과는 `success`와 `contentItems: [{ type: "inputText", text }]` 형태다.
- handler 예외·응답 write 실패·callback 기한 초과·transport 종료를 수거한다. 각 call에 cancellation signal과 유효 상태를 부여하고 기한 초과·terminal·close에서 무효화한다. handler를 기다리지 않게 된 뒤의 늦은 resolve/reject도 수거하고 같은 RPC에 두 번 응답하지 않는다. 종료 뒤 callback 응답/새 작업을 보내지 않으며 unhandled rejection을 만들지 않는다. callback 최대 대기 2초, 동시 대기 최대 2개로 제한한다.
- agent-message event는 알려진 `commentary`/`final_answer` phase만 추가로 요약한다. 원문은 계속 hash만 보관한다. 기존001의 표식 비교는 유지하며 tools 증거만 `final_answer`로 제한한다.
- client는 arbitrary remote command handler나 approval 허용 인터페이스를 만들지 않는다. 고정 dynamic callback 외 request는 기존 거절/오류 계약을 따른다.
- 실제 등록 후 callback 0회 결과의 보정으로 launch 정책을 다시 검증한다. 두 도구를 고정 namespace `ai_collaboration_scoped`에 넣고 process-local `features.code_mode.direct_only_tool_namespaces`를 그 한 항목으로 제한한다. `code_mode_host=false` 및 나머지 13개 차단은 유지하고 공용 `functions` namespace를 예외에 넣지 않는다. 개인 설정·hook·인증은 변경하지 않는다.

### [x] Step 2: 파일 읽기 정책과 구조화된 로컬 질문
**File**: `workspace-file-policy.ts`, `scoped-tool-experiment.ts`, 새 integration tests
- root는 소유권 확인된 canonical 합성 workspace다. allowlist는 로컬이 정한 `public-context.txt`, `tool-proof.txt`뿐이며 도구 인자가 확대하지 못한다.
- absolute/drive/UNC 경로, `..`·빈 segment·backslash·NUL·secret/metadata 경로, allowlist 밖 파일을 거절한다. symlink와 hardlink, 비정규 파일, 64KiB 초과, binary/NUL 및 잘못된 UTF-8을 읽지 않는다.
- path component의 `lstat`, canonical 경로와 root 포함 관계, `O_NOFOLLOW`로 연 descriptor의 `fstat`/dev/ino/nlink, 읽기 전후 경로 상태를 대조한다. 읽기 양을 64KiB로 제한하며 어떤 실패도 파일 내용·절대 경로가 포함되지 않은 고정 오류로 반환한다.
- 소유한 합성 root는 다른 코드가 악의적으로 동시에 교체하지 않는 조건이다. 위 검사를 공격적인 같은 UID 프로세스에 대한 OS 수준 격리 보증으로 확대하지 않는다. 실제 사용자 저장소 지원에는 별도 immutable snapshot/운영체제 격리 설계가 필요하다.
- `ask_peer` 인자는 고정 `peer-fixture` 별칭, 최대 2,000자 질문, 최대 4개 allowlisted 상대 경로와 줄 범위의 evidence다. unknown field·수신자 위조·절대 경로·scope 밖 evidence를 거절한다. 수신 기록은 이 프로세스의 공개 합성 내용만 보관하고 상대 AI 실행은 하지 않는다.

### [x] Step 3: 소유 thread/turn과 callback 결합
**File**: `scoped-tool-experiment.ts`, 기존 runtime factory seam, 새 integration tests
- wrapper는 initialize 후 `config/read`로 실효 정책을 확인하고 검증 불가/누락 시 thread/turn을 시작하지 않는다. 원본 config·인증·stderr는 저장하거나 출력하지 않는다.
- tool 모드 child는 shell/unified exec·apps·browser·computer·image·multi-agent·memory·workspace 자동 의존 기능을 process-local override로 끈다. read-only/네트워크 비허용/approval never를 유지한다. enabled MCP/plugin 0, apps 기본 false, web disabled, agents false, shell environment inherit none을 확인한다. 기존 개인 설정·hook·로그인을 변경하지 않는다. 설정된 MCP/plugin은 audit된 외부 task wrapper가 이름별로 끄며 단순 빈 map이 비활성화라고 추정하지 않는다.
- `thread/start`에는 고정 namespace와 그 안의 두 function tool spec을 등록한다. namespace/function의 name/description/inputSchema/type을 설치된 experimental schema에 맞춘다. resume에는 존재하지 않는 필드를 넣지 않는다. 실효 direct-only namespace 목록이 정확히 이 한 항목인지 확인하지 못하거나 다른/중복 항목이 있으면 thread/turn 호출 전에 거절한다.
- callback은 params의 namespace가 정확히 `ai_collaboration_scoped`일 때만 허용한다. namespace 누락·null·다른 namespace·동일 function 이름 위조는 현재 thread/turn이 맞아도 거절한다. 도구명·인자·수신자·파일 scope는 기존 두 도구 그대로이며 예외 namespace를 새 도구 권한으로 확대하지 않는다.
- thread/start·resume 응답의 ID와 canonical cwd가 소유 manifest와 맞아야 한다. `turn/start`의 요청 이전에 callback 진입을 막고 응답에서 확인한 현재 thread+turn에만 도구를 적용한다.
- 시작 응답보다 callback이 먼저 오면 제한된 시간 동안 ACK를 기다린다. ACK/ID 검증이 끝나기 전 파일 읽기·수신 기록을 하지 않는다. timeout·다른 thread/turn·과거/terminal callback을 실패로 반환하고 새 실행을 만들지 않는다.
- 한 turn당 최대 32개 고유 callId, 동일 callId/같은 인자는 한 번만 처리하고 결과를 재사용한다. 같은 callId에 다른 인자나 tool이 오면 거절한다. 종료/terminal 시 admission을 닫는다. 이미 admission을 통과한 handler도 각 await 이후와 파일 내용 반환·peer 수신 기록 직전에 현재 attempt/thread/turn/call과 cancellation을 다시 검사한다. timeout·terminal·close 뒤에는 내용 반환·수신 부작용·두 번째 RPC 응답이 없어야 한다. runtime의 시작 의도 저장·UNKNOWN·중단 종결 판정을 그대로 사용한다.

### [x] Step 4: opt-in 합성 tools CLI와 의미 있는 증거
**File**: `tools-cli.ts`, `experiment-policy.ts`, package scripts, 새 integration tests
- 새 tools CLI는 `run`/`resume`만 제공하고 `--allow-model-call`, model, 허용 account route를 필수로 한다. resume는 소유 experiment ID만 받는다. 일반 root/native thread ID/token/prompt 입력은 제공하지 않는다.
- 새 store는 대화 표식 없이 생성한다. 파일 표식은 `tool-proof.txt` 안에만 두고 매 attempt 전에 새로 만든다. 원본 값은 prompt/developer instruction/공개 결과에 넣지 않는다.
- prompt는 명시된 read tool로 파일을 읽고 고정 상대에 합성 질문을 한 번 전달한 뒤 파일 표식만 최종 응답하도록 한다. callback read/peer 횟수, 현재 attempt/turn의 **terminal 이전 `final_answer` textHash**, 실제 COMPLETED가 모두 맞아야 새 도구 성공이다. commentary·phase 누락·과거/terminal 이후 marker는 성공 증거가 아니며 phase를 확인하지 못하면 미검증으로 기록한다.
- resume는 이전 COMPLETED 실험만 허용한다. repository wrapper의 `withLock` 안에서 소유 root·manifest 상태(run은 READY, resume는 COMPLETED)와 runtime admission을 먼저 확인하고 파일 표식을 준비한다. STARTING/RUNNING/UNKNOWN 입력은 표식 갱신·thread/turn 호출 없이 거절한다. 검증된 현재 attempt의 응답과 callback만 채택하며 과거 marker/turn은 성공으로 처리하지 않는다.
- 표식 쓰기도 파일 정책을 적용한다. 기존 대상의 symlink/hardlink/비정규·소유권·mode를 검사하고 링크를 따라 쓰지 않는다. canonical 소유 root에 private sibling 임시 파일을 `O_CREAT | O_EXCL | O_NOFOLLOW`로 생성해 제한된 내용을 쓰고 동기화한 뒤 atomic rename으로 교체한다. 임시 파일/descriptor는 실패·취소에도 정리한다. 시작 전 root·경로와 rename 직전 상태를 다시 확인한다. 밖의 symlink/hardlink 대상은 변경하지 않는다.
- 이 준비는 기존 runtime의 admitted=true 이전에 실행됨을 전제로 cancellation을 설계한다. 각 await 이후와 임시 파일 생성·표식 게시 직전에 admission/취소를 확인한다. 취소 후에는 표식을 게시하거나 runtime operation을 호출하지 않는다. 준비/정리 작업이 남아 있는 동안 잠금을 풀지 않으며 공개 결과를 반환하지 않는다. 대기만 하는 준비 gate는 abort로 해제하고 늦은 rejection을 수거한다. bounded 로컬 파일 준비는 동기 파일 연산을 사용할 수 있으며, 비동기 IO를 사용하면 진행 중인 쓰기/close/cleanup을 잠금 안에서 마무리해야 한다.
- 시작 의도 저장 전 취소는 READY/COMPLETED 상태를 보존한다. 시작 의도 저장 뒤 불확실한 실행은 기존 UNKNOWN 계약을 따른다. `tools-cli`의 SIGINT는 준비와 runtime 양쪽에 취소를 전달하며 준비 promise 수거·잠금/소유 child 정리 뒤에만 종료 결과를 공개한다. 미해결 준비·UNKNOWN 입력·동시 contender 검사를 새 경계에 추가하며 기존001의 shutdown 계약을 변경하지 않는다.
- 출력은 안전한 experiment ID·정책 통과 여부·callback count·표식 일치 boolean·종결·미확인 범위로 제한한다. 원본 marker/hash/path/native ID/도구 내용·원본 config·stderr는 제외한다. 종결 미확인 실험은 유지하고 자동 재호출/삭제하지 않는다.

### [x] Step 5: 실제 호환성·독립 리뷰·문서 수명주기
**File**: 연결 조사/미결 결정/로드맵/README/이 명세
- Node 24.21.0 타입 검사·기존 34개 및 새 격리 검사를 완료한다. package 의존성/lock 불변이면 기존 npm ci를 재사용한다.
- fresh independent reviewer가 permission·callback admission·파일 경계·crash/error·증거 의미를 계획과 대조한다. source inventory/diff를 고정하고 최대 3회 corrective review를 적용한다.
- 개인 설정/인증을 바꾸지 않는 기존 허용 계정과 공개 합성 fixture로 실제 new+resume를 수행한다. 실효 feature 차단·callback 이름과 ID 결합·실제 thread/cwd 일치·final terminal·표식 boolean을 기록한다. 도구 존재를 실제 호출로 대체하지 않는다.
- 다른 provider/L3/제품 인증 적격성/두 PC와 개인 설명 격리는 미결로 유지한다. 도구 실패 시 구체적인 unsupported 결과와 다음 판단을 남긴다. 실제 새 도구+resume 증거 없이 Step 5를 완료 처리하지 않는다.
- 모든 Step·named test·필수 검사·독립 리뷰가 완료되면 명세를 done/archive로 옮기고 backlinks를 보정한다. Git 부재 상태에서 commit freshness hash를 만들지 않는다.

## Tests

`node:test`와 실제 fake child process를 사용한다. 기본 테스트는 provider/model/network에 의존하지 않는다. 새 이름은 `test/scoped-tools.integration.test.ts`에 구현한다.

| 이름 | 검증할 동작 |
|---|---|
| `should enable dynamic tool callbacks only with explicit opt in` | 기본 거절 유지, opt-in handshake/등록/응답 schema |
| `should collect tool handler timeout exceptions and write failures` | 제한 기한·예외·stdin 종료·shutdown 뒤 unhandled rejection/새 작업 없음. handler gate 뒤 timeout/close와 늦은 resolve/reject·중복 RPC 응답 검사 |
| `should read only allowlisted bounded text files` | 허용 fixture 읽기, byte 제한·비정규·binary/UTF-8 오류 거절 |
| `should reject path traversal secrets symlinks and hardlinks` | 상대/절대/drive/NUL/symlink 안팎/hardlink/metadata/secret·scope 위조 거절 |
| `should reject a replaced file before returning its content` | read 경계의 dev/ino/path 교체를 결정적 fixture로 재현하고 내용 미반환 |
| `should validate and record only structured fixture peer questions` | target/text/evidence/unknown field 검증, 상대 실행 없음 |
| `should require verified policy before starting a tool thread` | unsafe/누락 config/MCP/plugin/feature에서 thread/turn 미호출 |
| `should admit callbacks only for the acknowledged active turn` | early→ACK 이후 실행, ACK 유실 bounded 실패, cross/stale/terminal 거절. 허용된 read/handler gate 뒤 terminal/shutdown/timeout에서 내용 반환·peer 수신 부작용 없음 |
| `should process an identical call id once and reject conflicting reuse` | 별도 RPC ID 중복에도 read/수신 1회, 다른 인자 거절, 32개 제한 |
| `should preserve unknown instead of replaying an uncertain tool turn` | callback/응답 장애·crash 뒤 UNKNOWN, 새 호출 없음 |
| `should prove file reading without putting the marker in the prompt` | 파일-only marker, callback+현재-turn final_answer hash와 COMPLETED 모두 필요. 맞는 commentary→틀린 final, phase 누락, terminal 뒤 표식은 실패 |
| `should resume an owned tool thread with a fresh file marker` | 동일 thread/cwd, 저장 도구 보존/미지원 양쪽, 이전 응답 불채택/fallback 없음 |
| `should replace a proof file without writing through links` | static symlink/hardlink 대상 불변, atomic 교체·private mode·temp 정리, 쓰기 실패 시 turn 미호출 |
| `should block tool preparation after shutdown without replacing the proof file` | 지연/미해결 준비의 취소·promise 수거, 표식 불변·신규 runtime 미호출, UNKNOWN 입력 거절, 잠금 유지와 contender 차단·정리 후 진입 |
| `should omit raw tool content secrets and native locators from output` | 오류/성공 모두 sanitized evidence, 기존001 대화 표식 계약 유지 |
| `should expose only the owned namespace without enabling code mode host` | 설치 tag의 CodeModeOnly/direct-only 분기와 맞춘 fake child에서 기존 flat 등록의 callback 0회 실패를 먼저 재현. 고정 namespace의 두 도구만 직접 노출되고 host/shell/외부 도구 차단 유지 |
| `should reject missing or broader direct tool exposure settings before any thread` | 실효 namespace 목록 누락·다른 항목·공용 functions·추가/중복 항목·잘못된 형식에서 thread/turn 호출 0. callback namespace 위조 회귀는 현재-turn 검사를 확장 |

## Risks

- Dynamic tools는 설치 버전의 experimental 계약이다. 실제 registration/callback/resume를 확인한 범위만 지원으로 표시한다.
- custom tool은 connector 프로세스에서 읽으므로 child sandbox가 이 읽기 권한을 대신 제한하지 않는다. allowlist와 fd/path 검증이 필수다.
- 외부 도구·개인 hook·공급자 인증에는 기존 승인 경계가 적용된다. 개인 설정/hook 승인을 우회하지 않고 공개 합성 자료만 사용한다. host 전체 읽기 격리나 실제 repo 지원으로 확대하지 않는다.
- 이 로컬 수신 기록은 durable cross-user 질문이 아니다. 실제 공동 조사에는 인증·DB RLS·기기 scope·journal/lease/epoch·내구 질문/답변의 새 명세와 필수 리뷰가 필요하다.

## Verification

`experiments/local-ai-runtime`에서 Node 24를 사용한다. 아래는 실행 기준이며 통과 증거가 아니다.

```sh
npm run typecheck
npm test
npm run probe
```

실제 모델 검사는 총괄이 확인한 process-local 제한 wrapper와 허용 계정에서 별도로 수행한다. `tools-run`/`tools-resume` scripts에 explicit opt-in/model/account route/소유 experiment ID를 전달한다. 지원되는 실제 인자는 구현 후 README에 기록한다. source diff/inventory, 검사 로그, 안전한 실제 결과를 기준으로 독립 리뷰와 수명주기를 진행한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 계획 리뷰 1: 표식 쓰기의 scope/link 보호 누락 | HIGH | ACCEPTED | 잠긴 소유 root와 기존 대상 검증, exclusive private 임시 파일·동기화·atomic rename·실패 정리, link 대상 불변·쓰기 실패 회귀를 추가 |
| 계획 리뷰 1: runtime admission 이전 준비의 취소/잠금 경계 | HIGH | ACCEPTED | 상태/admission 선검사·각 await/게시 전 취소 검사·abort 가능한 gate·IO/정리 수거 후 잠금 해제/공개 반환. 시작 의도 전 상태 보존과 이후 UNKNOWN을 구분한 회귀를 추가 |
| 계획 리뷰 1: 이미 허용된 handler의 늦은 반환/수신 부작용 | HIGH | ACCEPTED | 각 call의 무효화·await 이후/commit 전 재검사·late rejection 수거·단일 RPC 응답과 gate 후 terminal/shutdown/timeout 회귀를 추가 |
| 계획 리뷰 1: phase 소실로 final 표식 판별 불가 | HIGH | ACCEPTED | sanitized phase와 현재 attempt/terminal 이전 final_answer 증거, commentary/누락/늦은 marker 거절 회귀. 기존001 비교 계약 유지 |
| 보정 계획 독립 리뷰 2 | — | PASS | 네 보정의 경계와 새 named test가 구현 가능함을 독립 확인. 변경 없는 schema·파일 범위는 최초 리뷰를 재사용했으며 추가 지적 없음. 실제 구현 리뷰·호환성 검사는 별도 |
| 구현 독립 리뷰 1 | — | PASS | 변경 8개와 전체 16개 source SHA, 최종 compiled 7개 SHA를 시작·종료에 대조. 같은 입력의 Node 24.21.0 타입 검사·49/49 격리 검사·제한 wrapper 초기화 결과를 재사용했고 차단 지적 없음 |
| 최초 flat 도구 새 실행 | — | FAILED・증거 보존 | 정책 확인·COMPLETED·두 정의 등록/rollout 저장은 확인했지만 callback 0회·파일 표식 불일치. 해당 입력으로 resume나 같은 호출 반복을 수행하지 않았으며 원래 실패 기록을 보존 |
| 실제 노출 보정 | — | VERIFIED | 설치와 같은 0.159.1 tag의 고정 namespace 직접 노출 후보만 회귀·실효 정책·독립 리뷰·실제 new/resume로 검증. 셸/host 등 차단 유지. 실제 내부 ModelInfo는 미확인이므로 최초 실패의 인과는 가설로 유지 |
| 보정 구현 독립 리뷰 2 | — | PASS | 지정 4파일 변경과 source 16/compiled 7/snapshot 16 SHA를 시작·종료에 대조. 타입 검사 exit 0·51/51 PASS/skip 0·실제 제한 namespace 초기화를 재사용했고 지적 없음. Step 1·3 보정 완료, 실제 new/resume·Step 5는 별도 미검증 |
| 보정 후보의 실제 new/resume | — | PASS | 두 별도 process 모두 COMPLETED/exit 0, 파일 읽기 2회·로컬 질문 1회·현재 turn 최종 파일 표식 일치. 같은 소유 thread/canonical cwd·새 attempt·새 파일 표식과 소유 thread/read의 namespace/tool 성공을 확인. 개인 inventory 조회·상대 AI 실행 없음 |
| 종료 검증 | — | PASS | 리뷰된 source 16과 최종 compiled 7 불변, named tests 17개와 기존 34개 모두 존재/통과. 실제 증거·남은 제품 범위를 정본에 반영하고 완료 명세로 archive. Git 부재이므로 commit freshness hash 없음 |
