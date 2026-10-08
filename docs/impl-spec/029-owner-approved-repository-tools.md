---
status: active
date: 2026-10-06
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 폴더 승인과 실제 AI의 자동 코드 탐색 연결

## Context

[PRD의 로컬 AI 연결](../PRD.md#로컬-ai-연결)의 사용자 선택을 실제 채팅 실행에 연결한다. 028의 목록·검색·읽기 모듈은 아직 운영 호출자가 없다. 새 폴더 승인으로 만든 연결에서 Codex와 Claude가 파일을 미리 고르지 않고 필요한 코드를 찾게 한다. 질문자는 자기 AI나 저장소를 연결하지 않아도 지정한 상대 AI에 질문할 수 있다.

전체 구현의 기존 사용자 위임과 자동 탐색 선택을 적용한다. 새 연결의 로컬 폴더 승인과 내용·근거 경로/hash의 공동 기록 안내는 제품의 실제 소유자 확인이다. 구현하는 개발자의 매 단계 재승인으로 대체하지 않는다. 기존 CLI의 선택 파일 모드와 저장된 v1/v2 기록에는 자동 권한을 소급하지 않는다. 개인 로그인·전역 지침은 유지하며 검증하지 못한 MCP·훅·플러그인 제한과 기본 Claude admission 폐쇄는 보존한다.

범위 조사는 기존 `repository_read028_scope` planner의 읽기 전용 보고를 재사용했다. settings manager/store, runtime/Claude/Codex 도구와 이력, SQL010의 정확한 본문 검사를 총괄이 추가 확인했다. 027 중앙 이력은 이 통합에서 확정하는 실제 파일 발췌 관찰 계약을 반영한 뒤 재검토한다.

## Affected Files

1. `packages/local-connector/src/workspace/repository-access.ts` — 신규. 세대·물리 root에 묶인 승인 검사와 기존 모드의 해석을 소유한다.
2. `packages/local-connector/src/workspace/tool-contracts.ts` — 신규. 선택/자동 모드의 도구 정의·인자 검사·도구 분류를 양 provider가 공유한다.
3. `packages/local-connector/src/workflow/repository-tools.ts` — 신규. 실행 한 번의 reader·호출/동시성 예산·반환 자료 관찰을 소유한다.
   `packages/local-connector/src/workspace/repository-observation.ts` — Step1의 승인과 관찰 검사를 분리하는 신규 내부 모듈. 신뢰한 관찰의 정확한 형식·hash·불변성 검사를 소유한다.
4. `packages/local-connector/src/runtime-contracts.ts`, `runtime-store.ts` — 선택적으로 추가되는 폴더 승인과 신뢰할 수 있는 도구 관찰의 형식·저장/불변성 검사를 추가한다.
5. `packages/local-connector/src/settings/local-confirmation.ts`, `settings/store.ts`, `settings/manager.ts` — 새 폴더 자동 읽기 확인, 승인 내구 저장과 새로운 generation의 준비·복구에 연결한다.
6. `packages/local-connector/src/settings/contracts.ts`, `src/features/runtime-settings/contracts.ts` — 기존 mirror의 같은 위치에 선택적 공개 `readMode`를 추가하고 둘을 같은 내용으로 유지한다.
7. `packages/local-connector/src/codex-adapter.ts` — 승인 모드에 따른 도구 광고·입력 안내·실행 인자를 연결한다.
8. `packages/local-connector/src/claude/adapter.ts`, `claude/input-proof.ts`, `claude/history-proof.ts`, `claude/launch-policy.ts` — 도구 이름의 positional 의존성을 제거하고 같은 모드의 광고·native init·입력/취소/소유 이력을 검증한다.
9. `packages/local-connector/src/workflow-runner.ts` — 내부 모듈을 호출하여 새로운 도구를 내구 결과·권한·용량 예약에 연결한다. runner의 다른 책임은 다시 쓰지 않는다.
10. `src/features/runtime-settings/settings-controller.ts`, `runtime-settings-form.tsx` — 본인 receipt의 자동 읽기 범위 표시와 apply의 동일 모드 echo를 추가한다. 상대에게 로컬 절대 경로나 승인용 root hash를 보내지 않는다.
11. `supabase/migrations/20261006001200-owner-approved-repository-access.sql` — 신규. SQL010의 정확한 receipt/apply 검사에 선택적 모드를 연결하고 기존 권한·동시성·revision·폐쇄 상태를 보존한다. 설치된 과거 migration은 수정하지 않는다.
12. 기존 `tests/local-confirmation.test.ts`, `settings-store.test.ts`, `runtime-settings.test.ts`, `provider-runtime-store.test.ts`, `codex-adapter.test.ts`, `claude-adapter.test.ts`, `claude-owned-history.test.ts`, `claude-launch-policy.test.ts`, `runner-fixture.ts` — 해당 책임의 새 동작과 회귀를 같은 러너에 추가한다.
13. 신규 connector `tests/repository-access.test.ts`, `tests/repository-tool-contracts.test.ts`, `tests/workflow-repository-tools.test.ts`, 기존 root `tests/unit/runtime-settings-contracts.test.ts`, `runtime-settings-view.test.ts`, `tests/integration/owner-local-ai-setup.test.ts`, `tests/helpers/runtime-settings-fixture.ts`, `settings-browser-fixture.ts`, `claude-product-fixture.ts`, `tests/e2e/owner-local-ai-setup.spec.ts` — 승인·탐색·재생·권한과 공개 계약의 수용을 검증한다. 실제 browser broker가 쓰는 ClaudeProductFixture도 mode별 승인·init·도구 실행을 지원하고 기존 selected 검사를 유지한다.
14. 관련 정본과 delivery·안내·027 활성 명세 — 실제 소스와 남은 수용을 갱신한다. 표준 second-brain 문서는 `docs/` 바로 아래를 유지한다.

## Affected Dependents

- `workspace/repository-reader.ts` — 검토를 통과한 028의 안전 I/O/출력/누적 예산을 사용하고 상한을 외부에서 늘리지 않는다. 자체 API·legacy 패턴은 변경하지 않는다.
- `runtime-file-policy.ts`, `cli/runtime-command.ts`, `cli/runtime-context.ts` — 과거 선택 파일의 `--files`/공유 확인과 빈 배열의 root 검사 의미를 유지한다.
- `provider-adapter.ts`, `cli.ts`, `cli/runtime-command.ts`, `settings/manager.ts`의 provider factory — 세 Claude 생성 지점의 검증 정책·공식 로그인·exact owned history 공급을 유지한다.
- `workflow/source-snapshot.ts`, 기존 `SourceObservation v1` 검사 — 입력 전 선택 파일 관찰의 immutable 형식을 유지한다. 자동 모드에서 빈 selected set은 실제 읽은 자료 전체라는 뜻이 아니다.
- `runtime-archive.ts`, `workflow/local-removal.ts` — 새 관찰을 변경 없이 보관하며 미해결 입력/결과를 지우거나 새 실행으로 치환하지 않는다.
- `claude/owned-history.ts`, `claude/configuration.ts`, `claude/policy.ts` — 허용한 정확한 소유 이력만 읽는다. 없는 native 검토 자료나 이력을 생성하여 admission을 열지 않는다.
- SQL011의 자기 AI 새 입력 gate, human/device admission, room membership, live binding — 이번 모드로 우회하지 않는다. claim/commit 잠금 순서와 취소된 권한을 유지한다.
- 027의 중앙 source manifest — 아직 구현하지 않은 실제 파일 관찰의 후속 소비자다. migration 번호는 다음013으로 보정하며 과거027 계획 리뷰를 새 계약의 승인으로 재사용하지 않는다.

## Implementation Steps

### [x] Step 1: 새 세대의 승인과 모드 계약

> 소스 보완과 행동 검사를 완료했다. origin 역할의 CONTINUATION/RESUME를 공통 함수로 허용하고, 기존 immutable archive에 원래 승인·설정·증거를 보존한 뒤 새 세대를 준비한다. 독립 구현 리뷰2는 두 HIGH의 소스 해소를 확인했다. 새 도구 자료를 포함한 보관 검사 보완은 마지막 구현 리뷰3에서 확인하며 실제 수용은 Step6에 남아 있다.

**File**: `workspace/repository-access.ts`, `workspace/tool-contracts.ts`, `workspace/repository-observation.ts`, `runtime-contracts.ts`, `runtime-store.ts`, 관련 단위 검사

- `RuntimeSettings`에 선택적인 `repositoryAccess`를 추가한다. 없으면 항상 기존 선택 파일 모드다. `files: []`, publicScopeConfirmed 또는 전역 지침만으로 자동 권한을 만들지 않는다. 자동 권한은 version1/mode `AUTO_CODE`, generation UUID, localRootReference UUID, confirmationOperationId UUID, 승인 ISO시각, canonical `RootIdentity`의 SHA-256, 경로/hash 공동 기록 동의 true를 포함하는 정확한 객체다. root hash와 절대 경로는 로컬에만 보관한다.
- 승인과 실제 `OwnedContext.generation`/root hash가 모두 일치할 때만 자동 모드를 선택한다. 모든 준비·validate·tool 경로에서 같은 검사 함수를 쓴다. 자동 모드는 `files: []`만 허용하고 selected 파일과 동시에 확대하지 않는다. v1 기록에는 새 권한을 추가하지 않으며 기존 v2 객체는 같은 의미로 읽는다. 자동 mode를 이후 record/context/settings mutation으로 삽입하거나 바꾸지 못하게 현재 불변성 검사를 확장한다.
- 이전 세대의 보존된 입력 정책은 당시 세대의 승인·설정에 결합해 검증한다. 현재 세대의 권한 검사를 과거 입력 전체에 적용하지 않는다. CLI의 같은 generationStore 준비 경로에서 AUTO_CODE 완료 이력을 보존한 새 SELECTED 준비와 REPLACE_PENDING 복구를 확인한다. 형식·자체hash·소유scope·payload·동일 세대 결합과 기존 불변성은 유지하며 새 승인 없이 과거 정책을 확대하지 않는다. 이 결합은 기존 RuntimeStore.compact와 immutable archive를 재사용한다. safely completedRequests의 원래 전체 record 바이트·승인/settings/context를 보관하고 검증한 reference를 남긴 뒤 새 세대로 준비한다. 정상 경로는 가능한 한 서버 replace 전에 보관하고 이미 REPLACE_PENDING인 복구도 같은 원본으로 보관·finalize한다. archive 저장/검증·용량 실패에는 원래 증거를 보존하며 unresolved 자료는 보관 대상으로 삼지 않는다. 새 historical schema나 현재 세대 비교를 생략하는 예외를 추가하지 않는다.
- 공통 도구 정의는 legacy `read_workspace_file({path})`와 peer 인자를 그대로 유지한다. 자동 모드는 `list_workspace_files({directory?,after?})`, `search_workspace({query,directory?})`, `read_workspace_file({path,offset?,expectedHash?})`를 제공한다. 도구 이름·순서는 helper가 소유하고 인자는 정확한 키/형식/상한으로 검증한다. 상대가 mode/root/limit을 인자로 선택하지 못한다.
- `ask_peer`는 기존 origin 역할/별도 확인/한 번/즉시 pending 원칙을 따른다. origin 역할에는 최초 ORIGIN과 같은 AI의 CONTINUATION/RESUME 요청이 포함되며 PEER는 제외한다. 역할 판별은 내부 공통 함수 한 곳에 둔다. Claude는 입력별 광고에서 DIRECT·PEER 도구를 제외한다. Codex의 도구는 `thread/start`의 세대별 목록이므로 별도 peer 확인이 없는 설정에서는 제외하고, 확인한 세대에서도 DIRECT·PEER 실행의 callback 권한과 입력 안내로 peer 사용을 거절한다. 저장된 thread의 도구를 입력마다 바꿀 수 있다고 가정하지 않는다. 서버 권한이 최종 기준이다. 모드별 evidence path 검사는 selected enum 또는 자동 구조 경로 정책을 사용한다.
- 자동 모드의 새 Claude 입력에는 모드와 당시 peer 허용 여부의 정확한 `toolPolicy`를 native intent에 보존한다. 동일 값은 닫힌 owned turn에도 보존해 이후 이력을 입력별로 검증한다. 없는 과거 descriptor/turn에는 기존 선택 모드의 검사를 적용한다. 새 필드는 intent/interrupt hash에 포함하고 초기 intent와 닫힌 turn 이후 변경을 허용하지 않는다. native init이 user anchor보다 먼저 나타나는 경우 다음 정확한 소유 입력의 policy와 연결한 뒤 검증한다.
- 새 `RepositoryToolObservation`은 version1/kind `REPOSITORY_TOOL_OBSERVATION`, generation, 승인 객체 hash, 도구 이름, 반환 result hash, 실제 반환한 파일 발췌의 상대 경로/전체 hash/읽은 시각/byte범위/발췌 hash, 전체 관찰 hash를 포함한다. `AttemptJournal.toolCalls`의 선택적 필드로 저장한다. 목록은 files가 빈 관찰이며 검색은 반환된 matches만 기록한다. 검색 중 검사한 모든 파일을 반환/사용 자료로 표시하지 않는다. selected 모드의 임의 JSON 원문에서 관찰을 추측하지 않는다.
- 자동 도구의 I/O 전 `RepositoryToolIntent`는 version1/kind `REPOSITORY_TOOL_INTENT`, generation/승인hash/도구이름/인자hash/시각/자체hash의 정확한 신뢰한 객체다. 기존 `callId/payloadHash/operationId:null/result:null`과 함께 저장하고 반환 관찰이 없을 때도 취소의 대상이 된다. 새 필드는 auto 모드만 허용하고 최초 저장 뒤 바꾸지 않는다. 취소·종결 뒤 결과/관찰을 보강하지 않는다.
- `PeerEvidenceObservation`은 별도 version1/kind `PEER_EVIDENCE_OBSERVATION`이며 generation/승인hash, 요청한 근거의 상대 경로·요청 줄 범위·확인한 전체hash/전체줄수/읽은 시각/바이트범위/발췌hash, 자체관찰hash를 보존한다. purpose는 `VERIFIED_FOR_PEER_QUESTION`이며 provider에 반환한 자료로 표시하지 않는다. final resultHash는 없고 peer operation과 발송 전에 연결하는 선택적 toolCall 필드다. 반환 자료 관찰과 이 선행 근거 관찰을 같은 형식으로 처리하지 않는다.

### [x] Step 2: 로컬 승인·웹 표시·정확한 apply 연결

**File**: `settings/local-confirmation.ts`, `settings/store.ts`, `settings/manager.ts`, 양쪽 settings mirror, 웹 설정 controller/form, SQL012

- 기존 Mac 확인은 새 폴더에서 자동 목록·검색·읽기를 승인하는 화면으로 바꾼다. 수동32개 파일 선택을 필수로 요구하지 않는다. 개인 설정 유지, 비밀/인증/지침 자료·밖 경로 제외, 파일 수정 금지, 생성한 답과 근거 상대 경로/hash가 채팅 기록에 남음을 쉬운 한국어로 설명한다. 취소/중단/잘못된 출력은 미승인으로 닫고 열린 child 종료를 확인한다. 화면 결과는 자동 scope 선택임을 명시하며 root fingerprint/세대는 신뢰하는 manager가 만든다.
- manager의 `bootstrap:245-259`가 생성한 새 generation/localRootReference와 현재 select-folder operation에 승인 객체를 묶어 provider 호출 전에 내구 저장한다. 웹이 보낸 readMode만으로 로컬 승인을 생성하지 않는다. 준비/복구/adopt와 generation 보관은 같은 객체를 검증·전달한다. 옛 receipt·journal이 자동 모드가 되지 않으며 정책 변경을 적용하려면 새 로컬 승인이 필요하다.
- 공개 receipt/apply에는 선택적 `readMode: "AUTO_CODE"`만 추가한다. absent는 legacy다. 선택적 필드가 있으면 LOCAL_CONFIRMATION의 승인된 root/reference와 함께 설정 apply·COMMITTED·APPLIED의 정확한 echo에 포함한다. 읽기 범위를 server·웹이 임의로 추가/삭제하는 요청은 CONFLICT다. `select-runtime`의 catalog 선택 본문에는 readMode를 넣지 않는다. selection 비교에서는 이 필드를 따로 제외하되 승인 receipt와 apply의 일치는 별도로 검사한다.
- 웹은 승인 전 새 폴더의 자동 탐색을 안내하고 승인된 receipt에만 ‘필요한 코드 자동 탐색’을 표시한다. 옛 receipt에는 이를 표시하지 않는다. readMode echo는 본인 설정 응답에서 가져오며 상대·브라우저 임의 경로 입력으로 scope를 넓히지 않는다. 개발자·AI·저장소·세션의 현재 대상 표시와 질문자 무설정 흐름을 유지한다.
- SQL012는 SQL010의 validate, candidate_receipt_ok, human apply의 selection/receipt 비교와 관련 device receipt/commit 검사에 같은 정확한 선택적 field를 연결한다. 현재 잠금과 owner/live-device/configRevision/currentBinding/admission/SQL011 gate를 보존한다. unknown/null/다른 mode·legacy receipt에 삽입·승인 뒤 모드 삭제·본문 바꾼 중복 operation을 거절한다. 기존 receipt/body는 그대로 저장/재생하고 소급 갱신하지 않는다. 양 mirror와 SQL의 UTF-16/JSON 본문 검증 차이를 새 입력 벡터로 검증한다.

### [x] Step 3: Codex·Claude 광고와 소유 이력 연결

> 같은 origin 역할 판별을 광고·callback·입력 정책·관찰 검증에 적용하고 새 행동 검사를 통과했다. 과거 false/absent 정책과 PEER의 거절은 유지한다. source 전체의 독립 재검토는 Step5에서 진행한다.

**File**: `codex-adapter.ts`, `claude/adapter.ts`, `claude/input-proof.ts`, `claude/history-proof.ts`, `claude/launch-policy.ts`, `workflow-runner.ts`의 닫힌 owned turn 생성, 관련 provider 검사

- Codex의 `scopedTools` 기존 호출자/선택 파일 signature는 호환을 유지한다. 준비한 새 context에는 승인 모드의 공통 도구 정의를 광고하고 실행 인자도 같은 정의로 검사한다. 세대의 peer 확인과 현재 입력의 peer 권한을 구분하며 DIRECT·PEER callback을 허용하지 않는다. 승인된 origin 역할의 세 요청 종류는 같은 기준으로 허용한다. instructions/handoff prompt는 자동 모드의 도구·근거 의미를 설명하되 읽기 전용 ceiling·개인 layer 보존·unverified plugin/hooks/MCP 제한을 유지한다.
- Claude의 NATIVE_TOOL_NAMES[0]/[1] 의미 의존성을 이름/도구 분류 함수로 바꾼다. mode에 따른 tools/list, native init의 exact allowed set, assistant tool-use/control claim, argument/cancellation/result hash와 소유 transcript 검증을 함께 연결한다. 예전 두 도구의 이력과 payload hash는 동일하게 검증해야 한다.
- 원래 같은 이름의 legacy read는 path-only, 자동 read는 정확한 optional offset/hash 형식이다. proof에 명시한 모드가 없는 과거 이력에는 선택 모드만 허용한다. 단순히 history의 도구 이름을 보고 자동 권한을 추측하지 않는다. adapter가 검증한 현재 설정/세대의 모드와 해당 입력의 immutable toolPolicy를 소유 이력 검증에 넘기고 context와 일치시킨다. closed 입력과 candidate의 policy가 다른 경우를 거절한다.
- catalog는 실행 자료 읽기 승인을 주지 않는다. 실제 입력 전/재개/observe/interruption 때 같은 소유 입력 descriptor와 정책 fingerprint를 보존한다. 새 도구 목록이 아직 검토되지 않은 실제 Claude 정책을 자동 CONFIRMED로 바꾸지 않는다. 이 단계의 검증은 합성 transport·owned history이며 native 입력을 만들지 않는다.
- runner가 닫힌 owned turn을 만들 때 기존 native intent에 toolPolicy가 있으면 정확한 값을 조건부로 복사한다. 없던 과거 입력에는 필드를 삽입하지 않는다. 이 국소 metadata 연결은 Step3에 포함하며 Step4의 자동 탐색 I/O·예약·취소·peer 발송을 선행 구현하지 않는다. 실제 adapter+runner 합성 검사로 이후 이력의 같은 정책을 확인한다.

### [x] Step 4: runner의 제한 탐색·내구 결과·재생

028 선행 조건을 충족하고 실행기 통합과 관련 행동 검사를 완료했다. 도구별 의도 저장·반환 관찰·중단·peer outbox와 동일 reader의 누적 예산을 구현했다. 독립 구현 리뷰2의 다중 취소·보관 검사·전체 nonzero 처분을 보완했고 현재 전체 검사는 통과했다. 마지막 구현 리뷰3은 보정과 과거 nonzero 처분을 확인하고 PASS를 판정했다. Step4 표시는 구현과 관련 검사 완료이며 전체 제품 완료를 뜻하지 않는다.

**File**: `workflow/repository-tools.ts`, `workflow-runner.ts`, `runtime-store.ts`, runner 관련 검사

- 내부 `authority.peerTools`는 인가된 정확한 claim/start/lease snapshot의 origin 역할에서만 만든다. 현재 SQL의 ORIGIN/CONTINUATION/RESUME는 AI_PAIR의 origin AI에만 예약되고 DIRECT는 PEER만 허용된다. SQL의 mode 불변성·direct_graph·device ownership·epoch·attempt/fence와 동일 payload 검사를 신뢰 경계로 유지한다. 문자열·참가자 수·임의 fixture의 peerAllowed로 실제 권한을 추측하지 않는다. 새 공개 field를 추가하지 않으며 최종 question RPC의 기존 DIRECT/PEER·origin AI·generation·lease 권한 검사는 계속 적용한다.
- 실행 한 번에 내부 handler/RepositoryReader 한 개를 유지한다. 매 도구 앞·뒤에 현재 scope/epoch/generation/lease/native thread·turn, credential와 실행 check를 확인한다. 기존 dedup를 먼저 적용한 뒤 서로 다른 callId의 호출256회와 동시4개를 I/O 앞에 예약한다. 진행 중·실패 호출도 계산하며 query/offset/callId 변경으로 리셋하지 않는다. 모든 descriptor 정리 뒤 동시 슬롯을 해제한다. 다른 실행/세대의 reader를 재사용하지 않는다.
- 같은 callId/payload는 저장 또는 진행 중 결과를 재사용하며 다른 payload는 거절한다. 자동 도구는 code I/O 전 nullable 호출 의도와 RepositoryToolIntent를 내구 저장한다. 저장이 실패하면 code I/O0이다. 목록/검색/읽기의 반환 관찰과 result는 같은 tool-receipt mutation에서 최초 null→확정으로 저장하고 provider에 반환 전에 확정한다. 이미 저장된 intent를 새 행으로 중복 append하지 않는다. UNKNOWN/재시작의 observe 경로에서 새로운 reader·새 입력·새 파일 읽기를 자동 실행하지 않는다. 실패 후 같은 callback을 새 읽기로 치환하지 않는다. 새로운 사람 질문으로 시작한 별도 attempt만 새 예산을 가진다.
- Claude의 취소가 호출 의도 저장 중 도착하면 메모리의 exact callId/payloadHash intent 저장 Promise에만 동기화한다. 전체 읽기 완료는 기다리지 않는다. 취소 fence는 저장 대기 전에 즉시 닫아 후속 I/O·늦은 결과의 채택을 막는다. intent 저장 뒤 cancellation을 같은 소유 입력에 보존하며 저장 실패는 UNKNOWN으로 닫는다. terminal과 cancellation 이후에는 결과/반환 관찰을 새로 넣지 않는다. 기존 완료 도구·legacy 증거와 payload hash는 유지한다.
- 자동 결과는 실제 JSON UTF-8 8KiB 이하인 core 결과를 inputText 한 개로 돌려준다. 일반 기록512KiB·전체2MiB·lease/snapshot131072·종결1536KiB 예약은 바꾸지 않는다. 자동 도구 하나의 예약은 결과 JSON escape와 관찰의 최대 크기/최대callId 메타데이터를 모두 포함하는 산술 상한으로 정한다. 저장 전 용량 거절에서 예약을 제거하고 기존 다른 예약을 유지한다. 파일 읽기 결과 용량을 native 모델이 선택하지 못한다.
- `ask_peer`의 자동 evidence는 같은 안전 reader로 전체 파일 검사와 full lineCount를 확인한다. 범위가 실제 전체 줄 수를 넘으면 거절한다. 근거 확인의 비용도 같은 예산을 소비한다. 검증한 PeerEvidenceObservation과 정확한 peer operation/body/hash를 같은 question-call-intent mutation으로 저장한 뒤에만 외부 발송한다. 이 단계는 pending result:null이어도 허용하고 이후 수정/삭제하지 않는다. 근거 저장 실패는 peer 발송0이다. 응답 후 같은 operation에 도구 result를 확정하며 발송 응답 유실/저장 실패의 UNKNOWN에는 원래 관찰과 operation을 남긴다. 복구는 같은 내구 요청·결과만 확인하고 파일 재읽기0이다. 선행 검증 자료를 provider에 반환한 발췌로 표현하지 않는다. selected 모드는 원래 전체 unchanged 선택 파일 검사를 유지한다.
- 도구 관찰은 runner의 신뢰한 실행 경로에서만 생성한다. legacy의 raw 파일 문자열/모델 최종 답변은 실제 파일 관찰이 아니다. 같은 provider-intent의 SourceObservation v1은 입력 전 관찰로 그대로 남기고 실제 반환 자료와 구분한다. 후속 중앙 이력은 이 새 관찰을 사용하며 이번 단계에서 원문을 중앙 업로드하지 않는다.

### [x] Step 5: 소스 검증·필수 리뷰와 정본 갱신

**File**: 변경 전체와 관련 docs

- 아래 실제 code/fixture 검사와 필수 타입·lint·format/check를 완료한다. 기존 assertion·fixture·timeout을 유지하고 신규 동작/버그는 먼저 실패하는 검사를 작성한다. 동일 코드/입력의 passing 결과만 재사용한다. 028 전체 connector의 취소1과 이전 자연 경합은 실패 원본·현재 영향 판단을 보존하고 통과로 표시하지 않는다.
- baseline/현재 파일의 상대 patch와 변경 인터페이스의 소비자 map, 검사 코드·입력 hash를 준비한 뒤 새 독립 reviewer가 권한/공개API/DB/source recovery를 검토한다. writer가 스스로 최종 리뷰를 대신하지 않는다. `.git`을 쓰지 않고 실제 source delta와 미커밋 상태를 기록한다.
- Architecture/BusinessLogic/API/DB/Frontend/안내에는 실제 새 동작만 기록하고 검사 수치는 delivery 한 곳에 둔다. 027의 필요 migration 번호/actual-read 계약/승인 metadata를 활성 계획에서 수정하고 새 계획 리뷰를 받기 전 구현하지 않는다. 실제 DB/browser/native 검증은 다음 Step의 상태로 따로 유지한다.

### [ ] Step 6: 실제 설정·브라우저 수용

> 2026-10-08 실제 설정 DB·HTTP·브라우저와 SQL012 warm upgrade를 통과했다. 지정한 검증용 폴더 선택과 취소도 실제 Mac 창에서 확인했다. 공식 AI의 자동 탐색 도구 실행 수용이 남아 있어 이 Step은 미완료로 유지한다. 검증 근거는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.


**File**: 기존 설정 통합·browser fixture와 실행 기록

- 허용된 실제 local DB 접근이 가능할 때 SQL010/011→012 warm upgrade와 신규 설치 두 경우를 검증한다. owned human/device로 동일 본문 재전송/불일치/취소/권한상실/old receipt와 새mode를 확인한다. 이전025의8개와022의18개 settings 검사도 새 migration 입력에 맞춰 관련 실행 범위로 포함한다.
- 허용된 브라우저/로컬 서비스 접근이 가능할 때 ‘내 AI 연결’→폴더 선택→소유자 확인→model/effort→apply→상대 개발자의 직접 질문을 검증한다. 질문자 AI 없는 경우와 옛 selected-mode receipt 표시를 확인한다. 실제 Mac dialog와 실제 model 호출은 각각의 허용 조건/검증 근거를 확보했을 때 수행한다. 합성 callback으로 실제 Claude 정책/두 PC 왕복의 통과를 대신하지 않는다.
- 실제 환경 접근이 막히면 이 Step은 `[ ]`/BLOCKED로 남기고 정확한 거절·실행0을 보고한다. source-local 성공 후 독립적인 다음 구현 작업은 계속하되 이 명세 전체나 제품 완료로 보고하지 않는다.

## Tests

- 리뷰1 H1 회귀 — wire-valid CONTINUATION/RESUME에서 명시 peer 권한·동의가 있는 양 provider의 광고/callback·입력 정책·선행 peer observation이 허용되는 행동 실패를 먼저 재현한다. PEER·권한 absent/false·동의 false는 계속 거절한다. 실제 DIRECT 서버 자료는 PEER임을 구분하고 임의 ORIGIN/false fixture를 DIRECT 생산으로 표현하지 않는다.
- 리뷰1 H2 회귀 — 완료된 AUTO_CODE Claude 입력을 보존한 같은 generationStore의 새 SELECTED 준비와 서버 replace 뒤 REPLACE_PENDING 복구를 실제 runner/store 합성 fixture로 재현한다. 과거 입력·승인·정책·도구/결과 자료와 hash가 동일하게 남고 새 세대에서 과거 권한을 사용하지 않는지 검사한다. source의 과거/현재 검증을 통째로 생략하지 않는다.

- `repository-access.test.ts` — absent/emptyfiles/legacy는 selected; 잘못된 세대/root/UUID/time/승인값·v1삽입·mutable확대를 거절하고 matching new generation만 자동 허용한다. root hash·local path가 공개 receipt에 없는지 검사한다.
- `repository-tool-contracts.test.ts` — legacy schema/hash 보존, 자동 list/search/read의 exact 키와 bounds, outside/secret path·limit/mode injection 거절, Claude DIRECT/PEER의 ask_peer 부재·Codex의 세대별 peer 확인과 입력별 실행 거절, 양 provider의 자료 도구 정의 동일성을 검증한다.
- local confirmation/settings store/manager — 수동 파일 선택 없이 owned 새 폴더 승인, 취소/중단/잘못된 결과 미승인, 승인 저장 실패의 provider 호출0, root/generation 변경 거절, 재시작의 동일 승인/adopt/retained 전후 불변성, old journal의 자동권한 없음.
- runtime store — 최초 intent/output/peer-evidence의 exact/hash/mode/context 검증, intent 최초저장/불변성, 반환 관찰의 before-result·late-insertion·mutation/다른세대/raw selected JSON 위조 거절, peer 선행 관찰의 result:null 허용·발송 전 영속화·후속불변성, 취소/종결 뒤 결과 보강 거절, 저장/다시읽기/archive/종결의 관찰 보존, legacy body/string/hash 동일 유지.
- Codex/Claude adapter·history·launch — 같은 승인 fixture에서 미선택 파일 list→search→read가 authority callback에 도달함; mode에 없는 tool/args/init/history/cancel과 peer 광고 거절; 자동 목록/검색/offset/hash의 duplicate/reordered-key payload·retained owned history 복구; 실제검토없는 Claude 기본 gate 유지.
- `workflow-repository-tools.test.ts` —32개 넘는 코드 파일과64KiB 넘는 코드에서 지정 상대의 답변, old files=[]의 자동읽기 거절, 현재 check/credential/lease 상실·stale callback, concurrent/pending/failed256/4예약과 core예산 공유, 동일callId 결과 재생·다른payload거절, store실패/terminal예약/lease보류시 초과 전 거절과 타예약 보존, trusted observation 저장→tool 응답 순서, unknown 재개/observe의 새I/O0, peer 근거 lineCount/hash/비밀 검사와 실제자료기록.
- 같은 runner/실제 ClaudeAdapter의 합성 연결 — automatic call intent 저장 중·읽기 대기 중 cancellation의 동일입력 증거보존, 의도 저장 실패의code I/O0, 취소 뒤 늦은읽기결과/관찰 미채택과닫힌입력/restart observe 새I/O0. 별도 회귀에서는 의도 저장에 성공한 뒤 읽기를 보류하고 취소 저장을 실패시킨다. UNKNOWN으로 남고 원래 내구 의도를 보존하며 늦은 결과·관찰·provider 도구 응답을 채택하지 않아야 한다. 재시작 observe의 새 I/O도0이어야 한다. NativeTransport만 따로 mock한 proof 검사로 통합 경계를 대신하지 않는다. 실제 model 입력은 하지 않는다.
- 같은 runner/peer outbox — evidence 저장 전 실패에서peer요청0, 동일저장 뒤fetch호출의순서, 발송응답유실과result저장실패에서pendingoperation/원래근거hash보존, 동일operation조회/재전송복구의파일재읽기0, 과거 선택모드의결과재생을 확인한다.
- 기존 human-direct peer/runner/source snapshot/selected file capacity/runtime archive/local removal — 단방향 질문자의 AI 비필수·recipient만 실행·자동 continuation 없음, 기존 파일 모드와 source v1·중단·미해결 제거/교체 보존.
- 웹 contracts/controller/form — exact readMode optional mirror·승인된 receipt의 echo/표시, old receipt에 자동 탐색 표시 없음, 본인 owner-bound scope만 변경 가능. mirror 동일 검사는 기존 패턴을 재사용한다.
- SQL/API integration — exact optional AUTO_CODE와 absent를 구분, unknown/null/다른mode/조작/삭제/다른root/미멤버/취소기기/old operation의 mode삽입 거절; 같은 operation의 exact replay 유지; commit/apply race·revision·SQL011 gate를 보존. 실제 실행이 안 되면 검사 정의와 실행0을 분리한다.

## Risks

- 자동 권한의 소급·브라우저 위조: 새 로컬 승인과 context generation/root identity에 결합하고 exact receipt/apply echo를 검증한다.
- provider간 도구·이력 불일치: 공통 schema/도구 분류와 mode 명시를 사용하고 과거 history를 계속 검증한다.
- runner 파일의 재팽창: 새로운 책임은 내부 모듈에 모으고 기존 외부 API를 늘리지 않는다.
- 결과·관찰 이중 저장 비용: 기존 일반/종결/lease 한도와 산술 상한 예약을 유지하고 초과 전에 거절한다.
- 실제 모델/DB 검증 부재: 소스/합성·실제수용을 별도 Step으로 기록하고 없는 proof로 기본 gate를 열지 않는다.

## Verification

- Node24와 기존 npm CLI로 connector typecheck/build, 변경 책임의 단위/합성 provider/runner 검사 및 connector 전체를 실행한다. 실패 원본과 전체 nonzero 상태를 보존하며 필요한 영향 분석/보완을 한다.
- root TypeScript application/integration/E2E/test compile, 관련 unit·root unit, lint 경고0, format/check, 읽기 전용 `git diff --check`, 문서 상대 링크 확인. 대상 코드/입력이 불변인 검사는 hash 대조 후 재사용한다.
- 기존 Next preview를 중간 build/typegen/restart로 변경하지 않는다. 실제 웹 수용을 위해 필요한 새 build/서비스 전환은 허용된 실행 환경에서 진행하며 이전 BUILD_ID를 새 UI 통과 근거로 재사용하지 않는다.
- SQL012 신규 설치/warm upgrade와 실제 HTTP/browser는 현재 runtime 접근 허용을 확인한 경우에만 실행한다. 운영/공유 DB나 배포는 이 plan의 격리 검증 대상이 아니다.
- baseline source와 상대 patch·입력 inventory·검사 로그·의존 map, 새 독립 계획/구현 리뷰와 source-local/실제 단계별 상태를 기록한다. Git commit/push/merge와 새 native입력0을 실제와 동일하게 보고한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 구현 리뷰1 H1: origin 역할의 요청종류 축소 | HIGH | RESOLVED · 구현 리뷰2 확인 | 공통 역할 판별과 명시 권한·동의·PEER 거절, 최종 서버 권한 검사를 확인했다. |
| 구현 리뷰1 H2: 과거 입력을 새 세대 설정으로 검증 | HIGH | RESOLVED · 구현 리뷰2 소스 확인 | 기존 immutable archive에 당시 record 전체를 보존한 뒤 새 세대로 준비하며 원래 설정으로 보관 자료를 검증한다. 새 도구 자료의 실제 보존 검사 공백은 리뷰2 H3으로 별도 보완한다. |
| 구현 리뷰2 H1: 여러 취소의 개별 차단 지연 | HIGH | RESOLVED · 구현 리뷰3 확인 | 취소 callback은 즉시 호출하고 반환 Promise만 저장 대기 경계에 포함한다. 두 도구와 첫 취소 저장 보류를 결합해 두 번째 코드 I/O 진입을 검사한다. |
| 구현 리뷰2 H2: 전체 검사 실패의 처분 근거 없음 | HIGH | RESOLVED · 구현 리뷰3 확인 | 원본 nonzero와 미확인 원인을 유지한다. 현재·이전 source overlay에서 제어한 시작 전 갱신 응답이 기존 거절 경로와 같은 sentinel을 재현했다. 용량 fixture는 실제 native 확인 뒤 갱신 응답을 보류한다. 설정 fixture의 동시 파일 교체·보안 읽기 거절과 UNKNOWN 유지도 제어 재현했고 해당 세대의 실제 읽기·쓰기만 직렬화했다. 기존 assertion·시간 제한과 production의 보안·상태 퇴행 거절은 유지했으며 현재 전체 검사는 통과했다. |
| 구현 리뷰2 H3: 새 도구 자료의 보관 실행 검사 공백 | HIGH | RESOLVED · 구현 리뷰3 확인 | 실제 ClaudeAdapter 합성 AUTO 읽기의 intent·관찰·result를 기존 정상 교체·복구·보관 실패 검사에 포함한다. confirmed peer 관찰과 원래 operation도 compact·보관 원문·hash·read 경계에서 확인한다. |
| 구현 리뷰1 I1: 기존 전체 병렬 취소 | INFO | ACCEPTED | 원본 전체553개 중552통과·취소1·exit1과 baseline/current의 격리 통과를 유지한다. source 회귀 차단에서 제외하지만 전체 시간 원인은 UNVERIFIED다. |
| 계획 리뷰1 H1: pending 자동 읽기의 취소 의도 없음 | HIGH | ACCEPTED | 코드I/O 전 nullable intent를 저장하고 intent-write와 취소만 동기화하며 fence를 먼저 닫는다. 실제 adapter+runner 합성 경계를 검사한다. |
| 계획 리뷰1 H2: peer 발송 전 근거 저장 계약 모순 | HIGH | ACCEPTED | 반환 결과 관찰과 선행 PeerEvidenceObservation을 분리하고 operation과 함께 내구 저장 후에만 발송한다. UNKNOWN의재읽기0을 명시했다. |
| 계획 리뷰1 M1: ClaudeProductFixture 범위 누락 | MEDIUM | ACCEPTED | 실제 browser broker의 helper를 포함하고 mode별승인/init/list→search→read와legacy회귀를 유지한다. |
| 계획 리뷰2 H3: 취소 저장 실패의 통합 회귀 누락 | HIGH | ACCEPTED | 의도 저장 성공→읽기 보류→취소 저장 실패를 실제 ClaudeAdapter와 runner로 검증한다. UNKNOWN·원래 의도 보존·늦은 반환 미채택·observe I/O0을 Tests에 명시했다. |

독립 계획 리뷰1은 REVISE C0/H2/M1/L0/INFO0이었다. 리뷰2는 세 지적의 해소를 확인했고 별도 취소 저장 실패 검사의 누락을 HIGH1로 지적했다. 이 검사도 수용해 Tests에 추가했으며 새 독립 리뷰3가 해당 보정과 입력 불변성을 확인한다. 최초 분류·설계는 총괄, 일반 구현은 승인된 같은 체크아웃의 단일6.1-sol/high worker, 독립 리뷰는 새6.1-sol/xhigh reviewer가 담당한다. 기존 전체 구현 승인으로 진행하며 missing requirement 또는 명시적 새 승인 경계가 있을 때만 질문한다.

독립 계획 리뷰3: PASS C0/H0/M0/L0/INFO0. 취소 저장 실패의 실제 adapter+runner 회귀와028의 Step4 선행 조건을 확인했다. 필요한 신규 selected v2 입력에도 toolPolicy를 기록하는 구현 선택은 기존 이력과v1 권한을 바꾸지 않는다. 입력66개 중59개 존재·7개 예정 미존재가 일치하며 변경 없는 계약·SQL·mirror·설정 검토는 재사용했다. 기존 전체 구현 위임으로 독립적인 Step1–3을 착수하며028 보완 승인·독립 리뷰 전에는 Step4를 진행하지 않는다. 실제 실행이 막힌 Step6은 완료로 표시하지 않는다.

Step1–4 소스 확인: 새 폴더 승인·정확한 readMode echo·provider 도구와 입력별 소유 이력·자동 RepositoryReader의 실행기 연결을 구현하고 관련 합성 검사를 확인했다. 구현 리뷰1의 origin 역할 제한과 과거 세대 검증 문제는 행동 실패를 재현한 뒤 보완했고 리뷰2가 소스 해소를 확인했다. 리뷰2의 다중 취소와 실제 도구 자료의 보관 검사는 보완했으며 현재 전체 검사는 통과했다. 과거 nonzero 처분과 마지막 구현 리뷰3을 완료했다. 새 migration과 브라우저 검사 정의는 작성·타입 검증만 했으며 실제 수용은 Step6에서 확인한다. 과거 전체 실패의 원인은 미확인으로 유지하며 현재 통과로 원인을 확정하지 않는다. 검사 수치와 검증 한계는 [개발·검증 현황](../planning/delivery-and-validation.md)에 기록한다.

독립 부분 구현 리뷰1: REVISE C0/H2/M0/L0/INFO1. Step2는 소스 범위 PASS이고 Step1·3은 위 HIGH2건을 수용했다. 존재 snapshot121개·baseline48개·변경36개·검증 로그47개의 SHA를 확인했다. 실제 DIRECT는 PEER이며 ORIGIN/CONTINUATION/RESUME는 같은 origin 역할이라는 현재 서버 생산 불변식을 확인했다. 추가 고정 CLI 입력으로 같은 generationStore의 준비·서버 replace·finalize와 복구 경로를 추적했다. 과거 증거를 지우지 않고 새 세대 권한을 과거 입력에 소급하지 않도록 보완한다. source 보정 후028을 사용하는 Step4를 진행하고 변경된 전체 source의 영향 부분을 새 독립 리뷰2로 검토한다. 실제 DB/browser/native 실행은0이다.

실행 예외 기록: Step4 검사 준비 중 잘못 지정한 실행 폴더에서 루트 Next 빌드가 시작됐다. 소유 세션은 중단했으나 빌드 생성물이 바뀌어 기존 미리보기의 현재 상태는 미확인이다. 원본 로그·종료 응답·파일 hash를 보존하고 연결기 compiler를 절대 경로와 명시적인 프로젝트 설정으로 실행한다. 이 실행은 실제 웹 수용이나 빌드 통과로 인정하지 않는다. 복원·삭제·서비스 재시작으로 현재 제한을 우회하지 않는다. 구체적인 상태는 [개발·검증 현황](../planning/delivery-and-validation.md)에 기록한다.

독립 전체 소스 구현 리뷰2: REVISE C0/H3/M0/L0/INFO1. 이전 origin 역할과 과거 세대 검증의 소스 지적은 해소됐으며, 다중 취소의 즉시 차단·전체 검사 실패 처분·실제 도구 자료의 보관 검사 세 항목을 수용했다. 현재·이전 source overlay의 제한된 진단은 시작 전 LEASED 응답을 실행 확인 뒤 반영하면 기존 상태 퇴행 거절을 통과하지 못함을 재현했다. 이전 전체 실패 당시의 guard trace는 없어 그 원인을 확정했다고 표시하지 않는다. 용량 fixture의 유한 실행 확인 장벽은 기존 읽기 권한·예약량·내용·시간 제한을 바꾸지 않는다. source 보완과 필수 검사 이후 변경된 입력으로 마지막 독립 구현 리뷰3를 진행한다.

독립 최종 구현 리뷰3: PASS C0/H0/M0/L0/INFO2. 리뷰2의 다중 취소·현재 검증 실패·실제 도구 자료 보관 세 HIGH를 해소했고 Step1–5의 소스·합성 검증·문서 정합성을 확인했다. 불변인 리뷰2 입력은 재사용하고 변경된 소스와 문서를 추가 검토했다. 과거 전체 nonzero의 원인과 이전 Next 생성물·preview·개별 child 정리는 미확인으로 보존한다. Step6 실제 수용은 실행0이므로 명세는 active로 유지한다. Git 쓰기와 새 실제 AI 입력은0이다. 검증 수치는 [개발·검증 현황](../planning/delivery-and-validation.md)에만 기록한다.
