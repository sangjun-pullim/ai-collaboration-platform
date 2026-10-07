---
status: active
date: 2026-10-05
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 내 Mac의 AI 설정과 지정 AI 답변 연결

## Context

[PRD](../PRD.md)의 기본 흐름은 자기 AI가 없는 사람이 동료의 연결된 AI에 질문하는 것이다. 020/021은 채팅 화면과 입장을 보정하며 실제 폴더·Claude·모델·effort의 적용을 대신하지 않는다. 이 명세는 한 답변 제공자의 설정부터 실제 DIRECT 실행까지 연결한다. 두 AI activation과 workflow v2를 선행 조건으로 추가하지 않는다.

범위 조사는 기존 `chat_first_local_setup_scope` planner 보고서를 재사용한다. 현재 connector RuntimeAdapter/Store/Runner/CLI와 device 및 workflow 계약은 Codex로 고정되어 있다. Claude 실험의 NativeRuntime/TaskPolicy는 합성 실행만 허용하며 3회 실험 budget을 제품에 복사할 수 없다. 단순 wrapper나 provider 문자열 추가를 실제 Claude 지원으로 처리하지 않는다.

완료 기준:

- 질문자는 AI·기기·경로 없이 준비된 상대 한 명에게 직접 질문한다.
- 답변 제공자는 내 AI 연결에서 자기 기기를 승인하고 자기 Mac의 native 폴더 창에서 경로를 고른다. 경로는 PC에만 저장된다. 현재 room-scoped pairing은 유지하며 선택한 참가 방에 내 AI를 연결한다. 방 대화 화면을 열기 전에 대시보드에서 설정할 수 있다.
- 설치된 공식 Claude/Codex와 실제 capability의 모델·effort를 선택한다. 선택 지원이 없거나 policy가 미확인인 provider는 이유를 표시하고 실행하지 않는다. Claude의 effort 미제공은 null이며 Codex 기본값으로 채우지 않는다.
- 웹의 요청한 설정과 PC의 실제 적용·응답 준비를 구분한다. 미확정 적용·전송·종결은 동일 operation과 owned native ID로 확인하고 새 맥락이나 새 입력을 자동 생성하지 않는다.
- 기존 구독 로그인과 개인 지침/설정 파일은 유지하며 공동 실행에는 승인된 읽기 전용 도구와 검증된 설정 우선순위만 적용한다.

실제 Claude 부분의 선행 조건은 009에 명시된 추가 실제 입력 승인과 정상 도구·동일 ID 재개·중단 수용이다. 009의 승인/예산/root/state 제한은 이 계획 승인으로 해제되지 않는다. 선행 조건을 충족할 때까지 새 실제 Claude 실행은 하지 않고 합성 계약·설정 queue·Codex 호환 검사는 독립적으로 진행한다. 두 PC의 실제 외부 설치/접속은 별도 현장 수용이며 한 PC·fake provider 결과로 완료 표시하지 않는다.

2026-10-06 구현은 사용자의 전체 목표에서 계획 작성·구현·감독을 위임한 기존 승인으로 진행한다. 별도 구현 승인 대기로 둔 이전 해석은 보정했다. 당시 실행 환경에서 Git metadata 쓰기와 Docker socket 접근이 제한돼 소스·합성 검사와 독립 리뷰를 진행했다. 2026-10-07 사용자의 커밋 요청에서는 `git add`와 `git commit`이 성공해 검토한 소스를 로컬 커밋으로 기록했다. 실제 DB·native·두 Mac 수용과 원격 PR 작업은 가능한 환경과 기존 승인 경계에서 확인한다. 실행 제한을 우회하지 않는다.

## Affected Files

1. 신규 `supabase/migrations/20261005001000-owner-local-ai-setup.sql` — 기기 소유자 설정 command/receipt와 capability projection, Claude runtime 허용과 기존 device/workflow history의 runtime 실제값. 이전 migration은 수정하지 않는다.
2. 신규 `src/features/runtime-settings/{contracts,request-policy,service,settings-client}.ts`, `src/app/api/runtime-settings/[action]/route.ts` — owner cookie와 fixed device bearer action을 분리하고 bounded queue를 제공한다.
3. 신규 `packages/local-connector/src/settings/{contracts,client,store,manager,folder-picker}.ts` — web 계약 mirror, 내구 operation, 고정 Mac 폴더 창, 적용과 실행기 인계 책임.
4. `packages/local-connector/src/{runtime-contracts,runtime-store,state-store,workflow-runner,cli}.ts`, `cli/{parse-options,remove-local-profile}.ts` — provider-aware 설정, CLI 관리 루프, idle 준비와 실제 adapter 선택. 기존 CLI 명령은 호환 유지한다.
5. 신규 `packages/local-connector/src/claude/{adapter,transport,input-proof,owned-history}.ts`와 기존 `codex-adapter.ts` — 제품 authority/내구 ACK/도구/terminal 관측에 연결한다. 실험-only store/budget는 import하지 않는다. Codex의 구현 이동은 필요할 때만 수행한다.
6. `src/features/device-binding/contracts.ts`, connector `contracts.ts`, web/connector workflow `contracts.ts`·`workflow-contracts.ts` — runtime union과 projection mirror를 같이 갱신한다. workflow v1 action/body/lease/control은 유지한다.
7. `src/features/device-binding/connection-manager.tsx`, `src/app/app/connections/page.tsx`, 신규 `src/features/runtime-settings/runtime-settings-form.tsx` — 실제 기기·폴더·provider·model·effort와 요청/적용 상태, 선택 사항인 내 AI 연결.
8. 기존/신규 unit·connector·실제 owned HTTP/DB·browser 검사와 docs — 아래 Tests와 검증에 한정한다. source 책임을 좁히고 전체 실행기 재작성·전역 config 이동·Realtime·메신저 추가는 하지 않는다.

## Affected Dependents

- `packages/local-connector/src/{central-client,workspace-registration,runtime-file-policy}.ts` — 기기 credential/실제 root/native ID의 PC 보관, profile/매핑 보호, scope와 선택 파일 검사를 유지한다.
- `src/features/device-binding/{service,request-policy}.ts` 및 device API — 기존 연결 action 권한·Origin·Bearer 경계를 유지한다. 새 설정 API가 임의 셸이나 경로 입력을 받지 않는다.
- `src/features/investigation-coordinator/{service,history-state,polling-policy,direct-intents,chat-presentation}.ts` 및 investigations/workflow route — 질문 target+epoch/actor와 같은 UUID·body 복구, 단일 답변, 늦은 응답 거부를 유지한다.
- `workflow_private`의 readiness·live device·fence·room revision·termination 보호 — pending settings만으로 실행 중 요청이나 UNKNOWN을 새 generation으로 옮기지 않는다.
- `experiments/claude-code-runtime/src/{native-input-proof,native-transport,task-policy}.ts` — 검토된 증명/stdio/policy 알고리즘의 참고 정본이다. 실험 저장소의 최대 3입력 제한, 합성 ask_peer, synthetic-only admission과 native executable 제한은 제품으로 우회 복사하지 않는다.

## Implementation Steps

### [ ] Step 1: 공급자 공통 계약과 실제 Claude adapter
> 실제 수용 미완료: 도구 없는 중단 복구 HIGH는023의 합성 검사와 독립 리뷰로 해소했다. 제품 CLI의 Claude 생성3곳은024의 공통 정책·정확한 소유 이력 공급에 연결했다. 기본 factory의 공식 설치·설정 검증과 같은 대화 후속 질문은 [030 보정](030-native-claude-chat-and-follow-up.md)에서 진행한다. 추가 사용자 결정을 기본 채팅의 선행 조건으로 요구하지 않는다. 실제 Claude·DB·두 Mac의 실행 조건과 검증 결과는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

**File**: runtime 계약/검증/runner, claude 내부 모듈, contract mirror, migration runtime 부분

- provider는 codex 또는 claude, 설치 version은 adapter가 실제 관찰한 값이다. RequestedSettings effort는 null 또는 지원 문자열이다. 기존 v1 Codex 기록의 decoding·역사·outbox는 보존하고 신규 provider-aware 설정만 명시적인 local format version으로 쓴다. null effort를 과거 Codex 요청으로 해석하지 않는다.
- SQL004의 agents CHECK, runtime validator, INSERT literal과 replace의 runtime 갱신 누락을 후속 migration으로 보정한다. 현재 `workflow_private.history_006` 내부 binding SELECT와 projection의 codex literal을 실제 `a.runtime`으로 바꾼다. SQL007이 감싼 `workflow_private.history` DIRECT wrapper는 교체하지 않고 원문·응답 계약을 보존한다. 역사 이벤트에 저장된 당시 provider가 없으면 현재 provider를 과거 값으로 붙이지 않는다. 현재 binding과 saved epoch 일치 검사를 유지한다.
- RuntimeAdapter의 prepare/validate/execute/observe/interrupt/close 접점을 Claude에 구현한다. 입력 제출 전 제품의 durable intent와 beforeSubmit, 같은 native/session/input ID의 ACK 저장, authority.tool/terminal exact identity 순서를 유지한다. 실험의 ask_peer 합성 응답을 제품에 내보내지 않는다. DIRECT에는 peer 도구가 필요하지 않으며 다른 모드는 검증된 해당 authority 계약이 있을 때만 허용한다.
- Claude의 session UUID는 host가 spawn 전에 예약·fsync한다. 최초 RESERVED 준비에서는 내구 예약·policy·capability만 확정한다. initialize의 control 응답과 실제 system/init은 별개이며 system/init은 첫 입력 뒤에 늦게 올 수 있다. 실제 system/init의 session/root/도구 identity를 예약과 대조하기 전에는 assistant·도구·종결 증거를 승인하지 않는다. 이 예약과 실제 native history 생성은 구분한다. OwnedContext에 materialization 상태와 증거를 저장한다. 최초 입력 전에는 한 번 예약한 UUID와 동일 root로 시작하고 최초 제출을 내구 기록한다. 첫 실행의 ACK/종결이 미확인이면 새 session-id/새 입력/재예약으로 보정하지 않는다. 실제 생성 후에는 exact owned history만 재개/관찰한다. --resume을 쓸 실제 history가 없는 초기 상태를 정상 재개로 처리하지 않는다.
- 최초 Claude spawn 전에 host session UUID/root/generation/policy fingerprint를 준비 저널에 fsync한다. 각 stdin 전송 전에는 input UUID·정확한 serialized prompt hash·authority(scope/fence/epoch)·generation을 `nativeIntent`로 fsync한다. beforeSubmit 접점을 descriptor를 받도록 확장하며 Claude는 필수 descriptor, 기존 Codex 경로는 기존 계약을 유지한다. 저장 실패 시 spawn/입력 write는 0회다. ACK의 실제 ID는 이 intent와 대조하고 대체하지 않는다.
- 전송 뒤 ACK 유실에서는 `journal.native=null`이어도 `nativeIntent`의 exact session/input UUID로 읽기 전용 observe를 수행한다. 같은 root의 정확한 소유 이력·입력 UUID/prompt hash·종결 연결 증거가 없으면 UNKNOWN을 유지한다. host 예약만으로 ACK/종결을 만들지 않고 새 입력·다른 session 탐색·자동 재전송은 0회다. Codex 기존 ACK 기반 관측과 저장 v1은 보존한다.
- 009의 검증된 native policy/버전/설정 우선순위 근거가 있어야 실제 Claude admission을 열 수 있다. 일반 개인 설정 파일을 변경하거나 credentials를 복사하지 않는다. 시작 inventory·실행 중 설정 drift·읽기 전용 allowlist·소유 child 정리 실패를 기존 미확인 계약에 연결한다.

### [ ] Step 2: 소유자 전용 설정 명령과 영수증
> 실제 수용 대기: DB 적용 사용자 보고는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다. Docker socket 접근 제한으로 에이전트의 기존 데이터·receipt 보존 upgrade 회귀와 실제 소유자 권한·HTTP 검사는 실행하지 못했다. 계약·타입·합성 검사 통과와 DB 적용 보고는 실제 DB 수용을 대신하지 않는다.

**File**: 새 migration, runtime-settings web/connector contracts/client/service/store

- 인간 action은 list/select-folder/select-runtime/apply/cancel, 기기 action은 poll/receipt로 고정한다. cookie는 admitted current user, device bearer는 기존 live credential·owner·room membership을 재검사한다. 방 owner라도 다른 사람의 기기 설정을 바꾸지 못한다.
- request는 operationId, deviceId, expected configRevision, provider/model/nullable effort 및 공유 별칭만 받는다. select-folder에는 root 문자열이 없다. 중앙에는 opaque localRootReference와 별칭·검증된 capability·requested/applied status만 둔다. 절대 경로·native ID·token·shell 문자열·실행 파일 경로는 projection에서 거절한다.
- 한 기기에는 동시에 active 설정 operation 하나이며 같은 UUID/body는 receipt를 복원하고 다른 body는 CONFLICT다. current credential/owner가 취소되거나 input validation이 실패하면 poll도 apply도 거부한다. 설정과 queue 잠금 순서, live membership 검사와 결과 저장을 같은 transaction으로 묶는다.
- 상태는 REQUESTED→LOCAL_CONFIRMATION→APPLYING→COMMITTED→APPLIED이며 CANCELLED/FAILED/UNKNOWN을 분리한다. applied receipt는 기기/operation/revision/provider/capability hash/root reference와 새 binding epoch에 결합한다. 전송 receipt나 native ID 예약만으로 APPLIED/ready를 보내지 않는다. 원인 불명 실패의 재시도는 같은 operation 관찰이며 새 생성은 명시적 새 설정이다.
- 서버 apply는 기존 workflow guard→device scope→room 잠금 순서에서 해당 agent가 origin/peer이거나 request target인 cycle 전체의 idle을 확인한 뒤 적용 예약을 저장한다. 본인 poll이 비었다는 사실만으로 예약하지 않는다. retired_at이 없는 현재 cycle의 state=ACTIVE이면 적용을 막는다. retired_at이 없고 mode=AI_PAIR이고 state=HUMAN_INPUT_REQUIRED이며 deadline>현재 시각, runs_reserved<11, peer_rounds_reserved<5인 재개 가능 cycle도 적용을 막는다. HUMAN_INPUT_REQUIRED는 room.mode=ACTIVE와 PAUSED 모두 검사한다. 방의 PAUSED를 cycle 상태로 해석하지 않는다. mode=DIRECT의 HUMAN_INPUT_REQUIRED는 기존 resume API가 재개를 거절하므로 모든 request/result/control이 증거로 닫힌 뒤에는 새 설정과 새 질문이 가능하다. 기존 DIRECT generation/input을 새 binding으로 재개·이전하지 않는다. peer 요청이 전부 종결되고 poll이 비어도 이 재개 조건이면 적용을 막아 기존 generation이 새 root/provider로 재개되지 않게 한다. active attempt/control, UNKNOWN·미업로드 결과와 미확정 준비에도 적용하지 않는다. 이 미해결 증거 검사는 mode와 retired_at 여부에 관계없이 모든 관련 cycle/request에 유지한다. deadline·예산으로 재개가 불가능한 cycle도 다른 미해결 요청·결과·control이 있으면 차단하고, 남은 증거가 모두 닫힌 경우에만 별도 새 설정 generation으로 진행한다. 예약 동안 새 DIRECT ask/start와 legacy replace/new ready는 CONFLICT로 막으며 read·취소·관찰·기존 결과 업로드는 유지한다. 서버 예약 없이 로컬 runner를 인계하거나 새 맥락을 만들지 않는다.
- 설정 commit 전용 RPC는 현재 live credential/기기 소유권·operation/body hash·예약 revision을 재검사하고 workspace/agent 최초 등록 또는 binding 교체와 COMMITTED receipt를 한 DB transaction으로 확정한다. 기존 legacy replace의 2분 replay를 설정 복구에 재사용하지 않는다. 유효한 새 credential로 동일 operation/body의 COMMITTED receipt를 121초 이후·rotation 후에도 복구하며 current epoch가 다르면 역사 receipt로만 반환해 현재 설정으로 채택하지 않는다.
- 취소는 COMMITTED 전에만 가능하며 cancel/commit은 같은 예약·room 잠금으로 직렬화한다. 취소가 먼저면 native 후보는 소유 정리하고 교체하지 않는다. commit이 먼저면 취소는 CONFLICT이며 동일 receipt로 로컬 확정을 복구한다. DB commit 뒤 PC의 current generation pointer/profile mapping을 fsync한 다음에만 APPLIED를 보고한다. 두 단계를 동시에 성공한 것으로 쓰지 않는다.
- catalog는 실제 adapter initialize에서 받은 모델/effort만 사용한다. 버전/hash/selection을 같이 검증하고 전체 응답 16KiB·모델 256개·effort 12개 한도를 지킨다. 한도를 넘으면 전체 catalog unsupported를 명시하고 조용히 일부를 자르지 않는다. 초기 단계에서 512KiB pagination과 양쪽 AI activation은 추가하지 않는다.

### [ ] Step 3: Mac 폴더 선택과 로컬 설정 관리 루프
> BLOCKED: 실제 Mac 폴더 창의 선택·취소와 실제 공급자까지 이어지는 적용을 확인하지 못했다. 중단 복구 HIGH는023에서 해소했으며 정책/history 소스 공급은024에서 연결했다. 실제 Claude의 검토 근거와 수용은 미완료다.

**File**: settings manager/folder-picker/store, CLI 및 runner idle 접점

- 승인된 기존 위치에서 동일 기기의 outbound polling 루프를 실행한다. 한 프로세스가 기기 설정과 runner life-cycle을 소유하며 같은 profile의 이중 manager/runner는 기존 잠금과 별도 설정 잠금으로 거절한다. shell 문자열을 중앙에서 받지 않는다.
- Mac의 폴더 선택은 고정 AppleScript를 osascript에 인자 배열로 실행한다. 사용자 선택 경로를 명령문에 삽입하지 않는다. cancel/권한 거절/timeout은 고정 상태로 반환하며 경로와 raw 오류는 공개하지 않는다. 선택 뒤 realpath/uid/inode/protected root와 기존 파일 정책을 검증하고 0600 local store에만 기록한다.
- 새/교체 설정에는 PC에서 경로·공유 별칭·공유 파일 범위·협업 맥락 생성 확인을 받는다. 개인 전역 지침은 적용되며 검증하지 못한 MCP/plugin/hook 제한은 유지한다. 모델/effort만 바뀐 경우에도 실행 중 요청의 설정을 바꾸지 않는다.
- 적용 전 현재 generation과 정확한 configRevision을 확인한다. 진행 중 run/peer 대기/continuation/UNKNOWN/미확정 준비/미업로드 결과가 있으면 기다림을 표시한다. idle에서 기존 runner를 안전히 닫고 잠금을 인계한 뒤 새 준비를 한다. replace와 receipt가 확정되면 새 runner가 새 epoch를 ready로 보고한다. 실패 시 이전 기록을 지우지 않고 미확정을 표시한다.
- 최초 연결은 begin→인간 승인→PC의 실제 scope 확인→exchange→폴더/공유 범위 확인→미준비 workspace/agent 등록→예약 context 준비→서버 commit→로컬 확정→ready 순서다. register/replace에 실제 provider를 전달한다. 최초 local mapping은 `RESERVED`와 host reservation을 명시하며 아직 생성되지 않은 native ID를 기존 실재 history로 취급하지 않는다. StateStore decoder와 Runner 진입은 이 상태를 명시적으로 검사하고 초기 metadata 등록은 응답 준비가 아니다.
- root/provider 교체는 현재 mapping/context root를 덮어쓴 뒤 prepare하지 않는다. settings journal의 별도 후보 generation에 새 root identity·provider·후보 context와 파일 범위를 저장하고 준비한다. idle 예약과 COMMITTED receipt 뒤에만 current mapping/generation pointer를 원자적으로 확정한다. 이전 RuntimeRecord/context/history/archives/outbox는 generation별 읽기 전용 보관으로 유지하며 이전 native input 재개는 그 root/ID로만 관찰한다. legacy v1 current record는 명시적인 migration 저널로 보관하고 새 pointer를 fsync하며 crash 시 동일 operation으로 복구한다. 경로가 다르다는 이유로 기존 root 동일성 검사를 제거하거나 old UNKNOWN을 새 root로 옮기지 않는다.
- CLI runtime-prepare/register/replace/run 및 revoke-local은 settings device 잠금→기존 binding/session/profile 잠금 순서를 따르며 active operation/UNKNOWN/미확정 journal을 검사한다. settings manager와 raw CLI가 같은 PC profile을 동시에 변경할 수 없다. remove-local-profile은 새 settings journal·generation 기록의 소유권과 unresolved/lock을 확인하고 준비 후보·이력을 무조건 삭제하지 않는다. settings 기록 없는 기존 CLI profile의 호환은 유지한다.
- 새 명령은 기존 begin/approval/exchange/등록 contract를 재사용한다. 연결 승인과 PC의 room scope 확인을 생략하지 않는다. PC를 켜고 connector를 실행해 둔 답변 제공자는 매 질문에 수동 입력할 필요가 없다.

### [ ] Step 4: 웹 내 AI 설정과 실제 적용 상태
> BLOCKED: 화면과 제어 코드의 합성 검사는 통과했으나 SQL010을 사용하는 실제 Auth/DB 브라우저 검사는 미실행이다. 요청한 설정·실제 적용·응답 준비의 연결을 실제 환경에서 확인해야 한다.

**File**: connection-manager, connections page, runtime-settings-form

- 대시보드의 내 AI 연결에서 참가 방·본인 기기를 고르고 폴더 선택을 요청한다. 질문만 하는 사용자는 돌아가기를 통해 설정 없이 방에 들어간다. 기존 pairing은 해당 방에 묶이며 방 대화 화면을 먼저 열 필요가 없다.
- provider/model/effort는 PC의 capability를 받은 뒤 선택한다. 미설치·로그인 필요·policy 미확인·미지원 조합은 이유와 본인 PC에서 할 실제 동작을 표시한다. 중앙 웹이 provider login을 대신하지 않는다.
- 요청한 값과 적용된 값, 기다림·Mac에서 선택/확인·취소·미확정·준비 완료를 구분한다. 웹의 저장 성공으로 응답 준비를 표시하지 않는다. 다른 사람의 설정에는 편집 UI를 제공하지 않는다.
- 동일 agent/epoch의 현재 공개 별칭과 실제 provider만 대상 카드에 표시한다. 과거 질문의 당시 저장소/모델 snapshot이 없는 v1 기록은 현재 값으로 채우지 않는다. model/effort의 상세 역사 snapshot은 후속 계약이며 초기 DIRECT 기본 질문의 전제조건이 아니다.

### [ ] Step 5: 권한·장애·실제 연결 검증과 종료
> BLOCKED: 원래 구현 리뷰3의 역사적 REVISE를 보존하며 중단 복구 HIGH는023의 독립 리뷰2 PASS로 해소했다. 정책/history 소스 연결은024에서 완료했다. 실제 native 정책 활성화와 DB·브라우저·Mac 폴더 창·공식 Claude·두 Mac 수용, GitHub Flow 작업이 남아 있어022를 종료하거나 보관하지 않는다.

**File**: test와 관련 정본 문서

- Tests를 실행하며 009 선행 조건을 통과한 실제 Claude/개인 설정 결과와 합성 결과를 분리한다. 실제 CLI 없거나 승인되지 않으면 실제 항목은 미완료로 남긴다.
- 새 독립 reviewer가 인증·기기 소유권·API/mirror·SQL·로컬 설정·native 입력/ACK/도구/종결과 cleanup를 검토한다.
- 구현한 범위와 동작만 정본에 반영하고 전 단계/필수 테스트/리뷰가 끝나면 이 명세를 보관한다. 원래 008의 큰 양쪽 activation/v2/역사 snapshot은 후속 항목으로 이관하고 실제 구현 승인 전에 deprecated 상태와 링크를 정리한다. 009는 자체 실제 수용 기준으로 종료한다.

## Tests

- settings 계약/mirror: exact keys·16KiB·임의 root/shell/token·unsupported provider/model/effort·catalog 변경·null effort·oversized catalog 거절.
- 실제 owned DB/HTTP: 자기 기기 설정, 같은 방의 타인/방 owner 거절, admitted nonmember·observer·ban/soft-delete·membership 제거·credential 철회/rotation·epoch 교체·동일 UUID/body replay와 mismatch 거절.
- Mac folder unit: fixed spawn 인자, 취소/timeout/AppleEvent 거절, symlink/protected root/uid/drift, raw 경로/credential의 공개 receipt 비노출. 실제 native picker는 소유 테스트 폴더 하나에서 선택/취소를 직접 확인한다.
- manager/runner: 이중 lock 거절, 재시작 같은 receipt, crash 지점별 전송/생성/replace/receipt UNKNOWN 보존, 진행 중/UNKNOWN 설정 금지, idle 인계, late old-epoch receipt/answer 거절, 원래 Codex v1 decoding·history/outbox 보존.
- Claude adapter 합성 stdio: 실제형 initialize/ACK·native input UUID·product authority 도구·연결 없는 assistant tool-use 거부·typed terminal·observe exact full history·held tool interrupt·normal completion race·child/descendant cleanup 실패·drift·실제 stderr/usage/credential 공개 금지. 실험 3회 budget을 제품에 복사하지 않았는지 확인한다.
- 웹 browser actual Auth/DB + fake runtime: 질문-only 입장, Mac 요청/적용 상태, 실제 catalog/null effort, stale selection/capability/revision, 다른 사람 설정 편집 금지, room-scoped pairing, 지정 한 AI만 답변·재시작/단일 답변·현재/과거 metadata 구분. mock만으로 actual provider라고 주장하지 않는다.
- 009 수용 후 실제 CLI: 한 Mac owned fixture에서 제품 Claude의 선택 파일 읽기·정상 답변·정확한 대화 재개·중단과 개인 설정 불변을 bounded 실행으로 검증한다. 실제 추가 모델 입력의 구체 상한/맥락은 앞서 승인된 009 입력 범위와 구분하여 실행 전 확정한다. 구독 API key를 중앙에 저장하지 않는다.
- 실제 두 번째 Mac 질문-only→Claude 지정 답변은 별도 외부 설치·owner 접속 수용으로 기록한다. 그 환경이 없으면 로컬 구현 검증과 남은 현장 검증을 구분한다.

## Risks

- 실제 구독 CLI 조건과 설치/버전 차이는 native 설정 근거와 분리한다. 지원하지 않은 버전을 자동 신뢰하지 않는다.
- read-only 파일 도구 allowlist와 개인 MCP 전체 권한을 혼동하지 않는다. 제품이 승인한 native 제한과 실효 policy를 확인해야 실행한다.
- 폴더 선택은 서버의 파일 선택이 아니다. PC offline/사용자 취소는 정상 상태이며 native chooser가 표시됐다는 사실을 설정 적용으로 표시하지 않는다.
- 개인 익명 세션 cookie 유실은 다른 계정이다. 이전 기기 설정을 nickname으로 복구하지 않는다.

## Verification

- Node24 root format/check·typecheck·lint·unit·build·connector 전체 tests.
- owned loopback stack에만 새 migration 적용, legacy upgrade와 Auth/device/workflow/runtime/human-direct 및 설정 HTTP/browser 검사.
- contract mirror byte/의미 일치와 기존 workflow v1/SQL guard 보존, 새 reviewer diff 대조.
- 실제 native 입력은 별도의 승인된 한도·owned path·설정 fingerprint·cleanup 조건에서만 실행한다. remote DB/배포/외부 메신저/개인 설정 변경은 이 검증에서 수행하지 않는다.
- docs 링크, 소유 임시 산출물 정리, GitHub Flow feature PR; main 병합은 별도 사용자 요청을 따른다.

## Test Files and Required Cases

- `tests/unit/runtime-settings-contracts.test.ts`: should reject private paths and commands; should preserve nullable provider effort; should reject changed or oversized capabilities; should keep web and connector mirrors equal.
- `packages/local-connector/tests/runtime-settings.test.ts`: should register an unprepared owned first context; should switch roots through a separate candidate without erasing prior history; should hold a device settings lock against legacy CLI and revoke-local; should recover same committed receipt after every local crash.
- `packages/local-connector/tests/claude-adapter.test.ts`: should persist reservation before spawn; should accept delayed system init only for the exact reserved identity before any assistant tool or terminal approval; should retain UNKNOWN for missing or mismatched delayed init; should persist exact input intent before stdin write; should send nothing after fsync failure; should observe exact reserved input after a lost ACK without another input; should reject foreign history and retain UNKNOWN; should preserve interrupted and normal completion races.
- existing `runtime-store.test.ts`, `workflow-runner.test.ts`, `connector.test.ts`: legacy v1 decoding/outbox, separate root/provider generation, pending/UNKNOWN locks and unchanged Codex flow.
- `tests/integration/owner-local-ai-setup.test.ts`: should serialize apply against new DIRECT and legacy replace; should wait for an idle related peer cycle; should block resumable HUMAN_INPUT_REQUIRED in ACTIVE and PAUSED rooms even with empty poll and finished requests; should check deadline and 11-run or 5-peer-round budget edges without retargeting the old generation; should allow a new setting after a proof-closed terminal DIRECT without resuming its old generation; should commit binding and receipt atomically; should recover after 121 seconds and credential rotation; should serialize cancel against commit; should reject stale epoch adoption and every foreign owner/device request.
- `tests/integration/claude-product-runtime.test.ts`: owned HTTP + fake Claude product authority/ACK/file tool/terminal/UNKNOWN and no requester AI. This file never implicitly launches official Claude. Actual native acceptance uses a separately bounded owned driver after the 009 prerequisite and explicit product-input authorization.
- `tests/e2e/owner-local-ai-setup.spec.ts`: actual Auth/DB + fake runtime owner setup/cancel/requested-versus-applied/null effort/stale capability; question-only skip; target-only question/reply. New browser parent exposes only owned fixed actions and uses the existing artifact/env policy.
- owned migration preparation/upgrade helper extends the existing namespace/proof checks. Fresh local installation and legacy001–009 upgrade both run `owner-local-ai-setup.test.ts`; no shared DB reset and no test admission bypass.

Additional execution: compile `tsconfig.integration.json`, then explicitly run `node --test --test-concurrency=1 .integration-build/tests/integration/owner-local-ai-setup.test.js .integration-build/tests/integration/claude-product-runtime.test.js`. Add a bounded settings browser parent runner to execute `playwright --config playwright.settings.config.ts` with private DB/admin held only by its parent. New test file/config/script paths are part of the implementation inventory. Existing root integration scripts are not claimed to discover these new files automatically.

실제 DB 준비의 후속 실행 범위: `scripts/apply-local-ai-settings.mjs`와 `tests/unit/local-settings-upgrade.test.ts`로 지정한 OrbStack 개발 DB에 미설치010–013을 한 transaction으로 적용하는 운영 명령과 격리 검사를 추가한다. 컨테이너 고정 ID·프로젝트·loopback port·소유 workdir와 SQL hash를 확인한다. 기존001–009의 필수 함수, SQL005의 receipt 외래키 3개의 shape·지연 검사 설정, SQL008의 actor·public wrapper 원문과 설정을 읽기 전용으로 확인하고 같은 transaction guard에서도 검사한다. 기존 필수 조건이 없거나 새 schema가 이미 존재하면 적용을 거절한다. 원본 SQL 파일은 변경하지 않으며010/013의 바깥 transaction만 묶음 실행 안에서 제거한다.011/012도 같은 transaction에 포함해 부분 적용을 방지한다. 응답 유실은 미확정으로 보존하고 자동 재적용하지 않는다. 이 준비·독립 검토는 실제 DB·upgrade·HTTP·브라우저 검증을 대신하지 않는다.

웹 실행 준비의 후속 범위: `scripts/dev-local-web.mjs`와 `tests/unit/local-web-environment.test.ts`를 추가한다. 기존 DB 점검을 읽기 전용으로 재사용하고 같은 프로젝트·workdir·로컬 API 포트의 게이트웨이를 확인한다. 확인한 workdir에서 공식 Supabase `status`를 실행하고 API URL을 대조한 뒤 공개 anon 키만 웹에 전달한다. PATH의 CLI가 없으면 설치·캐시의 CLI를 offline·no-install로 사용한다. 상태 응답의 비공개 값은 출력·파일 저장·웹 전달하지 않는다. Next 개발 환경 파일은 metadata로만 검사하고 존재하면 시작을 거절한다. 세 필수 웹 설정을 채워 현재 웹 코드를 실행하며 inherited 관리자/DB/AI 키와 임의 서버 설정은 전달하지 않는다. 원본 DB·프로필·대기 연결과 사용자 소유 웹 프로세스를 변경하지 않는다. 독립 검토와 격리 검사 후 운영자가 기존 웹 터미널을 종료하고 새 명령으로 실행한다. 실제 HTTP·브라우저·native 수용은 그 결과로 별도 확인한다.

## Review Notes

웹 실행 준비의 실패 보정 범위: CLI 조회 실패를 `LOCAL_STATUS_UNAVAILABLE`로만 합쳐 원인이 사라지는 문제를 고정 진단 분류와 숫자 종료 코드로 보완한다. 원문 오류·키·개인 경로는 출력하지 않는다. `--check`는 같은 읽기 전용 준비 검사를 수행하고 Next를 시작하지 않는다. 실제 차단 해소는 사용자 Mac의 진단 결과로 확인하며 기존 사전 검사·공개 키 검증·권한·DB·대기 연결은 변경하지 않는다.

Round 1: C0/H4/M2/L0/INFO1. All six corrections ACCEPTED; native-input authorization INFO preserved. Round 2: C0/H1/M1/L0/INFO1. Both corrections ACCEPTED; native-input authorization INFO preserved. Round 3: PASS, C0/H0/M0/L0/INFO1. The final nonretired AI_PAIR resumption versus proof-closed terminal DIRECT distinction was confirmed against actual SQL. Native authorization INFO is retained. 기존 전체 목표 승인에 따라 구현 중이다. 실제 native/DB 검증은 별도 실행 조건을 유지한다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Initial/root/provider registration path absent | HIGH | ACCEPTED | Step3 specifies unprepared registration, RESERVED context, separate candidate generation and durable pointer, preserving old history/outbox and v1 checks. |
| Legacy 2-minute replace receipt and cancel race | HIGH | ACCEPTED | Step2 separates transactionally COMMITTED binding/receipt, current-credential recovery beyond 121sec/rotation and commit-before-cancel ordering; APPLIED follows local fsync. |
| Apply versus DIRECT/peer/legacy CLI races | HIGH | ACCEPTED | Step2 reserves under guard/scope/room locks with entire related cycle idle; Step3 covers legacy commands/settings locks and revoke-local. |
| Native intent durability and ACK-loss observe | HIGH | ACCEPTED | Step1 fsyncs host session before spawn and input UUID/prompt/authority before stdin, observes exact reservation despite missing ACK and preserves UNKNOWN/no new input. |
| Renamed history_006 and DIRECT wrapper | MEDIUM | ACCEPTED | Migration modifies history_006 binding SELECT/projection only and preserves current DIRECT history wrapper. |
| Test files and direct execution missing | MEDIUM | ACCEPTED | Test Files section names cases/files and explicit new integration/browser runner commands with owned preparation/upgrade scope. |

| Resumable HUMAN_INPUT_REQUIRED versus room mode | HIGH | ACCEPTED | Step2 uses actual cycle states and deadline/run/peer budget conditions in ACTIVE and PAUSED rooms, with empty-poll and finished-request regressions. |
| Delayed system/init identity versus control initialization | MEDIUM | ACCEPTED | Step1 separates durable RESERVED preparation/control capabilities from delayed actual system/init; exact identity is required before assistant/tool/terminal approval and product tests cover delayed/missing/mismatched init. |

### 구현 리뷰 3과 후속 보정

2026-10-06 구현 리뷰 3은 REVISE, C0/H1/M0/L0/INFO2다. 위 Round 3 PASS는 구현 전 계획 리뷰 결과이며 이 구현 리뷰 결과와 구분한다. [impl-execute](/Users/pullim/.codex/agent-skills/impl-execute/SKILL.md)의 리뷰 3회 상한에 따라 당시 소스를 동결하고 HIGH를 미해결로 남겼다. `status: active`와 Step 미완료 표시는 유지한다.

계속 진행하는 전체 목표의 기존 위임으로 [중단 복구 국소 보정 계획](archive/023-claude-interrupt-recovery.md)을 작성한다. 후속 계획은 이 명세를 대체하지 않는다. 원래 리뷰3의 REVISE 기록은 보존한다. 후속023의 구현·필수 검사·새 독립 리뷰2 PASS가 완료되어 아래 HIGH를 해소 처리했다. 계획 검토만으로 해소 처리한 결과가 아니다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 도구 없는 Claude 중단의 UNKNOWN 복구 | HIGH | ACCEPTED / RESOLVED by023 | `claude/history-proof.ts:208`은 닫힌 INTERRUPTED 기록이나 도구 취소 증거가 있어야 중단 의도를 복원한다. 종결 저장 전 장애가 난 도구 없는 입력에는 둘 다 없어 `claude/input-proof.ts:529`가 같은 `aborted_streaming`을 FAILED로 채택한다. `workflow-runner.ts:2101`의 관찰에도 정확한 입력의 내구 중단 의도·영수증이 전달되지 않는다. 독립 리뷰의 순수 메모리 재현 2회에서 live INTERRUPTED와 복구 FAILED를 확인했다. 정확한 입력에 묶인 중단 증거의 내구 저장·관찰 전달, 증거 없는 typed 중단의 UNKNOWN 보존과 도구 없는 중단·종결 저장 실패·재시작 회귀 검사가 필요하다. 원래 재현의 실제 native 입력·DB·HTTP·브라우저·native 파일 이력 접근은0회다. 후속023은 전체 입력 descriptor/hash의 내구 중단 증거를 전달하고 새 실제 ClaudeAdapter+실행기의 같은 합성 이력 복구, archive 후 검증, 증거 없는 abort의 UNKNOWN 보존을 검사했다. 대상47/47·전체connector410/410·독립 구현 리뷰2 C0/H0/M0/L0/INFO2로 해소했다. 실제 공식CLI·DB·두 Mac 수용은 남아 있다. |


## Implementation Review

2026-10-06 소스 구현과 합성 검증을 진행했다. 실제 수용을 포함한 Step 완료 표시는 유지한다. 검사 수치와 환경별 미완료 범위는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에 둔다.

- 구현 리뷰 1: backend C0/H3/M1/L0/INFO1. 설정 receipt 이전의 currentBinding, Codex effort 검증, 취소 후 PC 정리 예약, receipt state 타입을 소스·회귀 검사로 보정했다.
- 구현 리뷰 2: 전체 운영 소스 C0/H4/M1/L0/INFO2. 완료 operation 정확 조회, 같은 pointer의 동기화 재확인, 중단한 읽기 도구의 내구 취소 증거와 전체 이력 검증, 제거한 profile의 재연결 정책, 확정 거절 요청의 화면 예약 해제를 보정했다. 관련 실패를 먼저 재현했으며 전체 합성 검사를 다시 통과했다.
- 구현 리뷰 3: REVISE, C0/H1/M0/L0/INFO2. 고정 소스 62개의 SHA가 모두 일치하고 리뷰 2와 같은 34개 파일의 근거를 재사용했다. 도구 취소 보정은 확인했으나 도구 없는 중단의 UNKNOWN 복구에서 별도 HIGH 1건을 순수 메모리로 재현했다. 리뷰 3회 상한에 도달해 위 Review Notes에 UNRESOLVED로 남겼다. 이 소스 리뷰는 실제 SQL 설치·upgrade·Auth HTTP·브라우저·Mac 폴더 창·공식 Claude·두 Mac 수용을 대신하지 않는다.

023 후속 보정: 원래 구현 리뷰3의 중단 복구 HIGH와 보정 중 드러난 종료 대기 회귀를 별도 국소 구현·검사·독립 리뷰로 해소했다. 원래022 전체 구현 리뷰3의 REVISE는 역사적 결과로 유지하며022의 실제 수용과 native 운영 공급 미완료는 계속 이 명세의 범위다.


024 후속 연결 기록: [Claude 정책·이력 연결 기록](archive/024-claude-native-policy-and-history.md)의 공통 생성 함수와 exact owned history 공급, 설정/환경 변경·effort 고정·profile catalog 실행 차단을 소스에 연결했다. 당시 합성 전체443/443과 독립 구현 리뷰1 PASS C0/H0/M0/L0/INFO0을 확인했으며 공식 설치 admission은 없었다. 2026-10-07의 native 기본 정책·후속 질문 보정은030에서 진행한다. 009의 추가 최대3회·합계 최대6회 사용자 승인은 재사용하며 현재 실행 조건은009와 검증 정본을 따른다.
