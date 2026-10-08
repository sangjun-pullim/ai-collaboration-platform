---
status: active
date: 2026-10-02
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 참가자별 웹 실행 설정과 대상 저장소 표시

## Context

[참가자별 도구·모델·effort 선택](../research/ai-runtime-integration.md)과 [대상 식별 요구](../guides/onboarding-and-settings.md)를 웹과 실제 로컬 실행기에 연결한다. 각 참가자는 자신의 모델과 effort(추론 강도)를 선택한다. 상대의 선택은 변경할 수 없다. 첫 방문에는 자신의 공식 CLI가 제공한 기본값을 제안하고, 재방문에는 마지막 선택값과 실제 적용 상태를 표시한다.

007의 Codex 실행과 개인 로그인·지침 보존, 조사 동안의 읽기 전용 실행 제한을 재사용한다. 웹은 PC의 절대 경로, 실행 명령, 인증 정보를 받지 않는다. 선택 경로와 공유 파일·인계 문구는 로컬에서 확인한다. 모델·effort만 바꾸면 기존 로컬 범위 확인을 유지하고 새 협업 맥락을 만드는 데 명시적으로 동의받는다.

이번 실제 실행 범위는 Codex다. Claude 항목은 후속 adapter 검증 전까지 실행할 수 없는 상태로 표시한다. Claude 인증과 실제 왕복, 전체 방향 수정·개인 설명·Realtime·두 PC·배포는 후속 명세의 범위다. 적용된 migration 001–006과 archive 명세는 변경하지 않는다.

핵심 동작은 요청한 설정과 적용된 설정을 구분하는 것이다. 진행 중인 조사, 상대 답변 대기, continuation, 같은 조사 재개, UNKNOWN에는 기존 설정과 대상 정보를 고정한다. 새 선택은 다음 새 조사에 적용한다. 상대에게는 사람·AI·프로젝트 별칭·작업공간 별칭을 표시한다. 과거 기록은 당시 대상 정보를 보존한다.

범위 조사 접점은 007 source13의 동결 소스로 확인했다. 구현 전 007 최종 소스의 복구 보정과 접점 차이를 반영한다. 조사 기록은 구현 완료 증거가 아니다.

2026-10-02에는 질문자 AI·경로 없이 사람→상대 AI에 질문하는 요구가 추가됐다. 이 명세의 양쪽 AI activation 계약은 공동 조사용 검토안으로 유지한다. 직접 질문에 질문자 설정을 요구하지 않도록 후속 작은 명세에서 대상 표시·설정 UI의 적용 범위를 다시 나눈다. 이 문구로 기존 계약 검토를 직접 질문 구현의 승인이나 완료 근거로 사용하지 않는다.

2026-10-04에는 기존 등록 정보만 사용하는 공동 조사의 내 AI·상대 AI 선택 목록에 개발자·runtime·저장소·세션 표시를 반영했다. 선택 값과 요청 처리는 유지하는 작은 표시 수정이다. 이 명세의 모델·effort 설정 계약과 적용 상태는 후속 구현 범위이며 진행 근거는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## Affected Files

1. 신규 `supabase/migrations/20261002000700-owner-runtime-settings.sql` — 설정·capability·적용 receipt·공개 대상 저장, 권한 및 조사 admission 보호.
2. 신규 `src/features/runtime-settings/{contracts,request-policy,service,settings-client}.ts` — 정확한 입력·응답 계약, 소유자·기기 gateway 및 브라우저 요청.
3. 신규 `src/features/runtime-settings/runtime-settings-form.tsx` — 참가자 본인의 provider/model/effort 선택과 요청·적용 상태.
4. 신규 `src/app/api/runtime-settings/[action]/route.ts` — action별 인간 인증 또는 기기 인증을 구분하는 POST gateway.
5. 신규 `packages/local-connector/src/{runtime-settings-contracts,runtime-settings-client,runtime-settings-store,runtime-settings-manager}.ts` — 계약 mirror, bounded HTTP, 별도 적용 journal, 실행기 교대 관리.
6. `packages/local-connector/src/{workflow-runner,runtime-contracts,runtime-store,cli,codex-adapter}.ts` — idle 인계, 준비된 binding 확정 접점, 내구 creation 전송 경계와 읽기 전용 owned-descriptor 검사, 기존 증거 보존, 관리 루프 진입점.
7. `src/features/investigation-coordinator/{contracts,request-policy,service}.ts`, `packages/local-connector/src/{workflow-contracts,workflow-client}.ts`, 신규 `src/app/api/{workflow,investigations}/v2/[action]/route.ts` — 협상된 workflow v2, 기존 v1 응답 보존, 새 nullable target snapshot과 legacy 로컬 기록 읽기 계약.
8. `src/features/device-binding/room-bindings.tsx`, `src/features/investigation-coordinator/investigation-view.tsx`, `src/app/app/rooms/[roomId]/page.tsx` — 현재 대상 카드, 조사 대상 선택, 과거 대상 표시와 본인 설정 패널.
9. 관련 unit·connector·integration·e2e 테스트와 기존 helper — 아래 Tests의 실제 동작 검증.
10. `docs/ARCHITECTURE.md`, `docs/DB-SCHEMA.md`, `docs/API-SPEC.md`, `docs/BUSINESS-LOGIC.md`, `docs/research/ai-runtime-integration.md`, `docs/guides/onboarding-and-settings.md`, `README.md` — 구현과 확인된 지원 범위를 동기화.

## Affected Dependents

- `packages/local-connector/src/{central-client,state-store}.ts` — 기존 profile v1, pairing·rotation·replace 경로와 2분 replay는 그대로 사용하는 호출자를 유지한다.
- `src/features/device-binding/{contracts,service}.ts` 및 connector `contracts.ts` — 기존 PublicBinding wire shape를 유지한다. 새 대상 정보를 별도 namespace에서 읽고 agent/epoch가 일치할 때만 현재 카드에 결합한다.
- `src/features/investigation-coordinator/{service,history-state,polling-policy}.ts`, `src/app/api/{investigations,workflow}/[action]/route.ts` — 고정 workflow action·권한·lease·control과 history 정합성을 유지한다.
- `packages/local-connector/src/{codex-transport,runtime-file-policy}.ts` — 007의 native 실행 정책·파일 범위·실제 effort 미검증 계약을 유지한다. codex-adapter의 새 creation 경계·읽기 전용 검사도 기존 작업 정책과 소유 검사를 그대로 사용한다.
- `tests/integration/{device-workspace-binding,investigation-coordinator,owned-codex-workflow}.test.ts`, `tests/e2e/*` — 기존 기기·조사·복구 동작이 새 namespace 때문에 막히거나 잘못 재실행되지 않아야 한다.

## Implementation Steps

### [ ] Step 1: 별도 설정 계약과 저장 구조
**File**: 신규 settings contracts와 migration

- `runtime_settings_private` schema를 만들고 직접 테이블 접근을 차단한다. 소유자 user, organization/room, device/agent, 현재 binding epoch의 권한을 각 RPC에서 다시 검증한다. owner가 아니면 catalog·desired·변경 action을 읽거나 실행할 수 없다. 방 참가자는 허용한 공개 대상 정보와 적용 선택만 읽는다.
- agent별 `desiredRevision`, `appliedRevision`, desired/applied provider/model/effort, capability hash, 현재 apply 상태를 분리한다. activationState와 activationEpoch를 appliedEpoch와 따로 저장한다. activation은 새 workflow를 사용할 준비이며 desired 적용 완료 증거가 아니다. 적용 receipt에는 고정 operation/application ID, 입력 hash, 이전·새 epoch, 적용 선택, phase를 저장한다. 설정 변경은 expected revision/epoch를 확인한다. 같은 op·같은 body는 재사용하고 다른 body는 CONFLICT다.
- 새로운 apply receipt는 이전 credential을 파일에 복사하거나 기존 replace의 2분 replay에 의존하지 않는다. 현재 유효 credential과 같은 소유 범위로 회복한다. revoke/remove/조직·방 권한 상실 후 receipt로 권한을 복구할 수 없다.
- capability manifest는 native의 모델 최대 256개를 받으며 목록을 조용히 잘라내지 않는다. 모델 id/model은 각 256자, effort는 최대 12개·각 32자, 전체 정규화 manifest는 최대 512KiB다. begin/page/finalize와 소유자 조회는 페이지당 최대 8개이면서 **전체 HTTP JSON 요청과 envelope 포함 응답의 직렬화 UTF-8 크기 각각 16KiB 이하**로 가변 분할한다. JSON escaping과 metadata를 포함해 분할하며 한 항목조차 상한에 들지 않거나 전체 상한을 넘으면 공개 고정 오류로 거절한다. 페이지 수는 1–256이며 선언한 pageCount/modelCount, 0부터 연속인 index, page hash와 전체 ordered manifest hash를 확인한다. 중복 재전송은 같은 hash만 허용하고 누락·순서 변경·중복 모델·잘못된 default는 finalize하지 않는다. owner 조회 cursor는 완성된 manifest hash+page index에 묶는다. 완성된 manifest만 조회 대상으로 교체하며 관찰 시각·공급자 버전·10분 유효기간을 저장한다. 만료 staging은 정리하고 agent별 동시 staging은 하나로 제한한다.
- 모델 목록은 계정의 실행·구독 적격성 증거로 표시하지 않는다. requested choice와 thread reported observation을 구분한다. turn effort verification은 007의 UNVERIFIED를 유지한다.
- 공개 대상은 ownerAlias/provider/projectAlias/workspaceAlias/선택적 relativeRootHint/applied choice다. projectAlias의 초기값은 등록된 repositoryAlias다. workspaceAlias는 로컬에서 확인한 별칭이며 미설정 기존 기록은 미확인으로 표시한다. hint는 owner가 확인한 상대 경로만 허용한다. 절대 경로·드라이브·UNC·상위 이동·제어 문자·native ID·설정 원문은 받지 않는다. raw Git remote와 native title을 추출하지 않는다.

### [ ] Step 2: 인증된 gateway와 원자적인 조사 경계
**File**: 신규 migration, settings request-policy/service/route

- 인간 action은 `read-owned`, `read-public`, `request`로 나눈다. Origin·세션 인증·역할·소유 agent와 정확한 schema/bytes를 검사한다. 기기 action은 `handshake`, `publish-begin/page/finalize`, `sync-current`, `activate`, `pending`, `begin-apply`, `application-status`, `fail-precommit`, `commit-binding`, `confirm-applied`로 나눈다. 혼용하거나 임의 RPC 이름을 입력받지 않는다. 응답은 allowlist projection과 no-store를 적용한다.
- 첫 연결의 `handshake`는 현재 권한·agent·epoch에서 지원 workflow 버전과 settings 기능을 확인한다. `sync-current`는 이미 로컬에서 확인한 007 owned context와 현재 epoch의 설정을 보고한다. 아직 설정 행·진행 중 application·desired 변경이 없을 때만 revision 0을 초기화한다. 동일 op/body와 현재 epoch의 sync-current receipt가 이미 확인된 로컬 mapping·선택에 대한 revision 0 applied ACK를 겸한다. bootstrap에 별도 commit application을 요구하지 않으며 receipt 유실은 현재 권한의 같은 op로 회복한다. native ID나 root는 보내지 않는다. 새 context를 만들지 않으며 새로운 웹 선택을 덮어쓰는 bootstrap으로 사용하지 않는다. handshake·catalog·revision 0 bootstrap은 activationState=INACTIVE로 저장하며 v1 ready/claim 차단을 활성화하지 않는다. INACTIVE 기존 binding은 legacy null snapshot과 진행 중 v1 동작을 유지한다. ACTIVE binding은 같은 epoch의 v2 지원·적용 확인 없이는 NEW cycle을 시작할 수 없다. 외부 legacy replace로 epoch가 달라진 설정 행은 stale로 표시하고 자동 bootstrap하지 않는다. 현재 epoch에서 명시적으로 새 application을 확인해 회복한다.
- `activate`는 본인 binding의 INACTIVE → ACTIVE 전환 또는 stale activationEpoch의 명시적 재확인만 수행한다. 양쪽 현재 epoch의 v2 handshake, 본인의 현재 로컬 mapping/owned context를 확인한 고정 confirmedCurrentContext 입력, 전체 cycle idle을 같은 기존 room 잠금에서 확인한다. applied ACK는 activation의 선행조건이 아니다. 양쪽 선택과 appliedEpoch는 바꾸지 않고 본인의 activationEpoch만 현재 binding epoch에 맞춘다. RESERVED/COMMITTED application이 있으면 다른 activation을 거절한다. 상대의 선택이나 context는 변경하지 않는다. 승인 시 본인 ready를 false로 내려 같은 epoch의 v2 runner가 새로 검증·보고하게 한다. legacy NEW가 먼저 승인되면 activation을 연기하고 기존 cycle을 유지한다. activation이 먼저 승인되면 새 v1 NEW를 거절한다. 단순 catalog/handshake/sync-current는 ready나 v1 claim을 바꾸지 않는다. INACTIVE라도 명시적인 desired 변경이 pending이면 **NEW만** 차단하고 기존 cycle의 실행·재개는 유지한다. begin-apply는 본인 ACTIVE/activationEpoch=현재 binding epoch와 양쪽 v2 지원이 확인된 상태에서만 허용한다. stale appliedEpoch라도 현재 로컬 owned mapping을 명시적으로 확인한 경우 application의 previousEpoch는 실제 현재 binding epoch를 사용한다. 이전 applied receipt와 최신 desired는 그대로 보존한다. NEW는 별도로 appliedEpoch와 ACK가 현재 binding epoch에 일치하고 desired가 실제 적용된 뒤에만 허용한다. 따라서 INACTIVE bootstrap 뒤 legacy replace가 발생해도 sync-current로 덮어쓰지 않고 현재 epoch의 activate → begin-apply → commit/LOCAL/ACK로 회복할 수 있다.
- server lock 순서는 기존 guard → device-binding lock_scope → workflow lock_room을 따른다. `begin-apply`는 이 잠금 아래 현재 desired/epoch, manifest, 전체 관련 조사 상태를 확인한다. 단순 empty poll이나 본인 request 부재를 idle로 판단하지 않는다.
- 관련 agent가 현재 ACTIVE cycle 또는 아직 재개 가능한 HUMAN_INPUT_REQUIRED cycle에 참여하면 전환하지 않는다. QUEUED/LEASED/RUNNING/UNKNOWN request와 LEASED/EXECUTING/UNKNOWN attempt가 있으면 전환하지 않는다. COMPLETED/CANCELLED이거나 HUMAN_INPUT_REQUIRED의 기존 resume가 deadline/실행 예산으로 이미 거부되는 경우에만, unresolved work가 없음을 확인하고 전환할 수 있다. 기존 HUMAN_INPUT_REQUIRED의 재개 가능 여부는 SQL006 human resume의 조건과 같게 판단한다.
- 단순 desired pending은 기존 ready를 false로 만들지 않는다. 따라서 기존 PEER/CONTINUATION/RESUME가 계속 실행된다. 실제 begin-apply 승인 시에만 해당 agent readiness를 false로 하고 적용 전환을 예약한다. 서버 cycle BEFORE INSERT는 origin/peer의 pending·applying·미확정 적용 상태를 검사한다. 신규 조사와 begin-apply의 양방향 경합은 같은 room 잠금으로 결정한다.
- cycle BEFORE UPDATE OF origin_epoch/peer_epoch는 실제 값 변경을 거부한다. 같은 epoch의 generation/revision 변경과 resume는 유지한다. binding 교체 후 같은 cycle을 새 epoch로 재개하던 기존 동작은 CONFLICT가 된다. NEW cycle은 새 적용값으로 시작한다.
- 새 migration은 기존 legacy `public.connector_replace` wrapper에 settings guard를 추가한다. 기존 guard → device-binding scope → workflow room 잠금 아래 본인 binding의 RESERVED/COMMITTED application이 있으면 외부 legacy replace와 replay를 CONFLICT로 거절한다. `commit-binding`만 exact application/body/current authority를 검사한 private 내부 교체 경로를 사용하며, 임의 body flag로 이 guard를 우회할 수 없다. application commit과 legacy replace의 양방향 경합을 같은 잠금으로 결정한다. 완료된 APPLIED/FAILED_PRECOMMIT에는 기존 idle 조건으로 legacy replace를 허용하고 metadata를 stale로 표시한다. 과거 receipt를 변경하지 않는다.
- `commit-binding`은 기존 replace와 같은 현재 권한·scope·epoch 조건을 적용하고, binding 교체와 새 durable receipt를 같은 DB transaction으로 저장한다. 이후에는 2분을 넘긴 정확한 회복도 이 receipt로 처리한다. `confirm-applied`는 같은 application/new epoch/선택을 확인한다. 늦은 ACK가 더 최신 desired를 덮지 않는다. 이전 적용이 실제 완료되었다면 applied는 그 사실을 표시하고 최신 desired는 pending으로 유지한다.
- application의 서버 phase는 RESERVED → COMMITTED → APPLIED이며, RESERVED에서만 FAILED_PRECOMMIT으로 종결할 수 있다. begin 응답 유실은 같은 application/body로 재조회하며 새 context를 만들지 않는다. `fail-precommit`과 `commit-binding`은 같은 scope/room 잠금에서 경합하고 terminal receipt를 남긴다. failure가 먼저 확정되면 늦은 commit은 거절하고 commit이 먼저 확정되면 failure 요청은 기존 commit receipt를 돌려준다. COMMITTED 이후에는 취소나 이전 epoch rollback 없이 receipt·LOCAL 확정·ACK만 회복한다. 실패 종결은 application 예약만 해제하고 readiness는 false로 둔다. desired pending·stale·미확정 적용의 NEW 차단은 유지한다. 원래 epoch의 로컬 mapping/context를 다시 검증한 runner는 ready를 다시 보고할 수 있지만, 실패한 선택을 대신 적용한 것으로 표시하거나 그 이전 applied로 NEW를 시작하지 않는다. 새 조사는 사용자가 확인한 desired가 새 application에서 실제로 적용되고 ACK·v2 ready를 확인한 뒤에만 허용한다. 이전 desired를 조용히 적용 완료로 표시하지 않으며 최신 선택은 pending 상태로 새 application에서 회복한다.
- context 생성 호출 전에 실패했거나 생성 호출이 종료되어 exact descriptor와 미실행 증거를 내구 저장한 경우에만 로컬 pre-commit 실패를 확정한다. 생성 요청의 전송/결과가 모호하면 UNKNOWN_PRECOMMIT으로 남겨 admission을 닫고 소유자에게 확인을 요청한다. 이때 새 context를 자동 생성하거나 서버 실패를 먼저 선언하지 않는다. readonly 조회로 원래 owned descriptor를 확인할 수 있는 명시적 복구만 허용한다. 서버 FAILED_PRECOMMIT receipt와 동일 application·미실행 후보 증거를 settings journal에 보존한 뒤에만 해당 preparation을 감사 가능한 실패 종결로 해제한다. 생성된 native context와 기존 CONFIRMED evidence는 삭제하지 않는다. 남은 후보와 늦은 비동기 응답은 기존 runtime/profile를 덮어쓸 수 없다.
- 배포 순서는 v1 보존 migration/gateway → v2 connector와 INACTIVE handshake/bootstrap → 양쪽 현재 epoch의 v2 지원 확인 → 본인의 현재 owned mapping 확인과 전체 cycle idle을 같은 room 잠금에서 확인한 ACTIVE 전환이다. v1 endpoint의 lease/poll/start-intent/terminal/observe와 기존 cycle은 동일 JSON shape와 오류 allowlist로 유지한다. v2는 별도 `/api/workflow/v2/[action]`·`/api/investigations/v2/[action]` endpoint와 protocol 2를 사용한다. 서버는 요청의 endpoint·protocol을 대조하고 새 기능을 임의 header로 활성화하지 않는다. v2 NEW cycle은 양쪽 binding의 현재 epoch v2 handshake와 applied ACK를 요구한다. ACTIVE binding의 새 snapshot 작업에 대해 v1 NEW/claim/ready-true는 서버의 같은 잠금에서 CONFLICT로 거절한다. INACTIVE 상태에서는 v1 ready와 기존 cycle의 queued PEER/CONTINUATION claim·lease/control/complete/UNKNOWN/observe 복구를 모두 유지한다. ACTIVE 이후에도 기존 null-snapshot cycle의 exact identity 회복·완료·관찰을 막지 않는다. 지원 확인이나 활성화가 끝나지 않으면 웹은 업그레이드 필요 상태를 표시하며 새 snapshot cycle을 만들지 않는다. desired pending만으로 기존 cycle을 중단하지 않는다.
- 새 컬럼은 nullable 또는 default로 추가한다. 기존 데이터는 당시 snapshot을 추정해 backfill하지 않는다. rollback은 새 기능을 비활성화하는 forward migration으로 설계하고, 이미 생성한 역사·receipt를 삭제하지 않는다. 운영 DB에 적용하지 않고 owned local fixture에서 upgrade와 초기 설치를 검증한다.

### [ ] Step 3: 로컬 적용 journal과 실행기 교대
**File**: 신규 connector settings store/client/manager, workflow-runner/runtime-contracts/runtime-store/cli

- 별도 settings apply journal은 private 0700/0600, no-follow·UID·nlink·size·atomic write 규칙을 재사용한다. op/body hash, desired revision, 이전 epoch, 준비 generation, 생성 intent/descriptor, 서버 receipt, profile/runtime 확정, ACK 진행을 정확한 순방향 상태로 저장한다. 로컬 phase는 BEGIN_INTENT → RESERVED → PREPARING → CANDIDATE_VERIFIED → COMMIT_INTENT → SERVER_COMMITTED → LOCAL_APPLIED → ACKED다. 확실한 pre-commit 실패만 FAILED_PRECOMMIT으로 종결하며 외부 context 생성 결과가 모호하면 UNKNOWN_PRECOMMIT으로 보존한다. credential 원문을 복제하지 않는다. preparation이 삭제되어도 ACK 회복 근거는 남긴다.
- 기존 `run`이 idle poll 동안 binding/session 잠금을 유지하는 점을 고려한다. runner가 idle 인계 callback에서 서버 begin-apply를 요청하고, 승인된 전환만 정상적으로 drain/close한 뒤 잠금을 반환한다. manager는 반환 이후 새 runner를 생성한다. 영구 폐쇄된 기존 runner를 재개하지 않는다. callback 안에서 profile/binding/session 잠금을 중첩 획득하거나 `prepare`를 호출하지 않는다.
- 기존 `finishPreparation`의 candidate validation → REPLACE_PENDING → 짧은 profile transaction → mapping 검증 → LOCAL finalize 접점에 optional settings commit 경로를 추가한다. 기존 CLI prepare의 legacy replace는 유지한다. 새 경로는 settings client의 durable commit result를 current profile mapping에 확정하며 legacy pending 재전송을 사용하지 않는다.
- RuntimeAdapter에 settings 전용 optional before-create-submit callback과 읽기 전용 inspect-created 접점을 정의하고 실제 CodexAdapter에서 구현한다. before-submit callback은 모든 사전 검사 뒤 실제 `thread/start` 호출 직전에 동일 application/generation/epoch의 CREATE_SUBMIT_INTENT를 fsync한다. 저장 실패나 live guard 거절 뒤 creation RPC를 보내지 않는다. callback이 시작되기 전의 실패는 adapter가 모든 후속 작업을 닫고 실제 thread/start 미호출을 확인한 고정 typed BEFORE_SUBMIT_CONFIRMED 증거가 있을 때만 안전 종결한다. journal에 intent가 없다는 사실이나 일반 Promise 예외만으로 미전송을 추정하지 않는다. callback 이후 모호한 전송/응답은 UNKNOWN_PRECOMMIT이다.
- inspect-created는 해당 application이 내구 저장한 정확한 생성 descriptor/ID와 현재 scope만 사용한다. `thread/read`만 호출하며 thread/start·name setter·thread/resume·turn/start·개인 thread 목록 조회를 하지 않는다. 완전한 동일 root/ID/owned 생성 증거·미실행 상태를 확인할 때만 VERIFIED_NO_TURNS를 반환하고, 저장되지 않은 locator·불완전 기록·모순·다른 turn·권한/설정 drift는 UNKNOWN이다. 새 native context를 만들거나 복구 성공으로 추정하지 않는다. 기존 CLI prepare/validate의 동작은 유지한다.
- 먼저 runtime context와 profile mapping을 회복 가능한 방식으로 확정한다. 그 뒤 confirm-applied를 전송한다. 서버 commit 직후, profile만 저장된 시점, runtime 확정 직후, ACK 유실 각각에서 같은 후보와 receipt를 회복한다. 불명확한 context 생성이나 007의 provider intent/UNKNOWN을 새 context로 자동 재실행하지 않는다.
- manager는 activate 전 현재 profile/runtime의 exact owned mapping·root/files/handoff·미확정 작업 부재를 로컬에서 확인한다. stale epoch 회복은 사용자에게 확인한 현재 로컬 범위를 사용하며 웹의 root/locator 입력을 받지 않는다. activation은 context 생성이나 applied 보고가 아니다. 이전 applied가 stale이면 NEW를 닫은 채 기존 desired의 명시적 application을 회복한다.
- 새 manager는 provider context 생성과 v2 NEW admission 전에 handshake를 완료한다. 구형 서버가 settings/v2를 지원하지 않으면 SERVER_UPGRADE_REQUIRED를 표시하고 새 설정 적용을 시작하지 않는다. 기존 로컬 journal과 미확정 operation은 저장된 protocol과 body/hash 그대로 해당 v1/v2 endpoint로 복구한다. 기존 v1 receipt를 v2 JSON으로 다시 쓰거나 protocol을 바꿔 재전송하지 않는다. 007의 UNKNOWN/native intent를 settings 전환으로 해제하지 않는다.
- 요청 중 모델·effort가 변경되어도 현재 application body는 바꾸지 않는다. 다음 revision은 다음 전환으로 처리한다. manifest 만료·지원 밖 선택·권한 상실은 고정된 공개 오류로 알리고 조용히 다른 모델이나 effort로 바꾸지 않는다.
- CLI 관리 실행은 로컬에서 확인한 root/files/handoff와 공개 작업공간 별칭을 사용한다. 웹 선택으로 로컬 명령·경로·파일 범위를 늘리지 않는다. model/effort 변경에는 새 owned context 동의를 요구한다. 개인 native 로그인·지침·설정 파일은 그대로 유지한다.

### [ ] Step 4: 현재 대상과 역사적 snapshot
**File**: migration, workflow contracts mirror, room-bindings/investigation-view

- cycle INSERT 시 origin/peer의 공개 대상과 applied 선택을 각각 저장한다. request INSERT는 agent에 맞는 cycle snapshot을 복사한다. PEER/CONTINUATION/같은 cycle RESUME가 live label이나 새 설정을 다시 읽지 않는다. snapshot은 생성 뒤 변경하지 않는다.
- 새 workflow v2의 payload/history projection에 `targetSnapshot`을 추가한다. 기존 v1 endpoint는 새 필드와 새 오류 코드를 추가하지 않고 기존 exact response shape를 유지한다. snapshot은 최대 2KiB로 제한하고 기존 human 256KiB/device 64KiB 응답 상한에 포함한다. 최대 공개 문구·이벤트 수 조건에서도 상한을 지키는 bounded history 응답을 검증한다. 새 서버 응답에는 명시적인 object 또는 null을 요구한다. 기존 로컬 v1 journal/CONFIRMED receipt에서 필드가 없으면 legacy null로 읽되 원래 body/result bytes를 덮어쓰지 않는다. 복구 대조에서는 missing과 null만 같은 legacy 의미로 취급하고 non-null 차이는 거부한다. 웹/connector contract mirror의 bytes 동일성을 유지한다.
- 기존 PublicBinding API는 확장하지 않는다. 현재 대상 overlay는 agentId+bindingEpoch가 모두 일치할 때만 결합한다. 일치하지 않으면 미확인/변경 중으로 표시한다. 과거 기록에 현재 overlay를 fallback으로 붙이지 않는다.
- 대상 선택과 카드에는 사람·provider·프로젝트 별칭·작업공간 별칭을 함께 표시한다. 저장소 별칭이 같은 두 참가자를 구분할 수 있어야 한다. 별칭은 실제 절대 경로의 인증 증거로 표시하지 않는다. 상대의 설정 form은 제공하지 않는다.

### [ ] Step 5: 웹 선택과 적용 상태
**File**: runtime-settings-form/settings-client, room page

- 본인 binding별 provider → model → effort 순서로 선택한다. 첫 방문의 native default는 제안으로 표시한다. 재방문에는 마지막 desired와 현재 applied를 함께 불러온다. 모델을 바꾸면 지원하는 effort 목록을 갱신하고 새 조합을 사용자가 확인한 뒤 제출한다.
- 새 협업 맥락 동의와 공개 범위를 보여준다. 기존 조사 설정 유지, 다음 새 조사에 적용, 로컬 PC가 켜져 있어야 적용된다는 상태를 설명한다. 요청 수신을 적용 완료로 표시하지 않는다.
- 상태는 준비 안 됨/선택 가능/오프라인 또는 catalog 만료/지원 안 됨/다음 조사 대기/적용 중/적용 확인으로 구분한다. 구독·인증 오류는 native catalog의 존재와 구분한다. Claude는 실제 지원이 확인될 때까지 선택 실행을 막고 사유를 표시한다.
- expected revision/epoch가 충돌하면 새 상태를 읽는다. 중복 클릭에는 같은 op/body를 재사용한다. 방·로그인 계정 변경 시 이전 비동기 결과가 다른 사람의 패널에 반영되지 않게 한다. 제한된 polling을 사용하고 Realtime을 완료했다고 표시하지 않는다.

### [ ] Step 6: 검증·리뷰·문서 수명주기
**File**: 관련 tests와 docs

- 아래 Tests를 기존 fixture/runner에 추가한다. root는 실제 변경과 호출자를 확인하고 새 독립 reviewer가 auth/permission/DB/API 및 007 회귀를 검토한다.
- owned local DB에서 migration upgrade와 rollback 비활성화를 확인한다. 외부 Vercel/Supabase 계정이나 운영 접근은 이 단계의 로컬 검증에 필요하지 않다.
- 실제 Codex 수용은 본인 두 binding의 다른 선택, 새 context 적용, 실제 origin→peer→continuation, pending 선택 중 기존 조사 고정 및 다음 NEW cycle 적용을 한 PC의 owned 저장소에서 확인한다. fake 검사는 실제 수용 증거를 대신하지 않는다. 실제 호출은 구체적인 fixture와 상한을 준비·리뷰한 뒤 기존 승인 범위로 진행한다.
- 각 항목은 구현과 관련 검증이 끝났을 때만 [x]로 바꾼다. 문서는 확인된 동작을 갱신한다. 모든 수용과 독립 리뷰가 통과한 뒤 archive한다. Claude·개입·Realtime·두 PC·배포가 남아 있으면 전체 제품 완료로 보고하지 않는다.

## Tests

1. `should restrict runtime settings mutations and private catalogs to the binding owner` — 다른 참가자·조직·방·epoch·역할·revoke/remove 및 인간/기기 인증 혼용 거절.
2. `should publish complete bounded capability manifests without exposing staging` — 최대 256개·가변 1–256page, 최대 8개/page와 envelope 포함 UTF-8 16KiB, 다중바이트 Unicode·JSON escaping 경계, bytes·중복·누락·hash/default·만료·quota와 owner-only pagination. 초기 current 동기화는 기존 owned context만 사용하며 새 desired·stale epoch를 덮지 않는다. request가 bootstrap보다 먼저 오면 보존하며, INACTIVE legacy replace 후 sync-current 거절과 명시적 activate/application 회복을 확인한다.
3. `should preserve independent desired and applied revisions for each participant` — default/재입장/동시 선택·same op/body와 다른 body 충돌.
4. `should recover settings commits with current credentials beyond legacy replacement ttl` — 121초 이후 서버 응답 유실·rotation, 같은 receipt, 권한 상실 거절. RESERVED/COMMITTED 중 외부 legacy replace/replay를 거절하고 commit-first/replace-first 경합과 settled 뒤 stale 회복을 확인한다.
5. `should finalize local settings before acknowledging applied state` — commit/profile/runtime/ACK 각 crash, preparation 삭제 후 ACK 회복, 새 provider context 중복 생성 금지. COMMITTED→ACK 사이 legacy replace 거절과 new epoch receipt 회복을 확인한다.
6. `should retain a newer desired revision after an older applied acknowledgement` — 실제 older applied 표시, newer desired 유지, 잘못된 application/epoch/choice 거절.
7. `should serialize new investigation admission with settings application` — NEW-first와 activation/apply-first 경합의 허용 결과·readiness 및 rollback 일관성. FAILED_PRECOMMIT 뒤 ready 복구만으로 pending NEW를 허용하지 않으며 새 desired 적용/ACK 이후 허용한다.
8. `should defer application across peer waits continuations and resumable human input` — empty poll/상대 대기/QUEUED/UNKNOWN 전환 금지, 기존 PEER/CONTINUATION/동일 epoch RESUME 유지.
9. `should admit settings application only after the whole related cycle is no longer resumable` — COMPLETED/CANCELLED, deadline/예산 경계, unresolved attempt와 ACTIVE 차단.
10. `should preserve historical targets and reject cycle epoch changes` — 같은 이름의 두 참가자, origin/peer snapshot, metadata 변경 뒤 과거 유지, 같은 epoch resume 허용·교체 후 resume 거절.
11. `should read legacy null target snapshots without rewriting confirmed evidence` — 007 journal/receipt 보존, missing/null 대조, non-null drift 거절, contract mirror.
12. `should preserve native instructions login and readonly execution during web settings changes` — task-only 제한과 root/files/handoff 불변, 웹 경로/명령/auth 주입 거절, unsupported model/effort 미보정.
13. `should show owner choices and distinguish pending from applied state in the room` — 본인 form만 표시, 상대 대상 식별, offline/stale/Claude unavailable, 새 context 동의, 충돌·늦은 UI 응답.
14. `should apply independent web choices through the real product connector` — actual Auth/DB/HTTP fake adapter 통합과 별도 bounded actual Codex 수용.

15. `should release verified precommit failures without losing committed receipts` — begin 응답 유실, context 전송 전 실패, exact 생성 완료 후 검증 실패, UNKNOWN 생성 결과, failure/commit 및 legacy replace 양방향 경합, 늦은 callback, failure 뒤 application 예약만 해제·pending NEW 거절·새 desired 적용/ACK 후 NEW 회복. 원래 runner ready 회복은 applied 변경 증거가 아니다.
16. `should negotiate workflow versions without interrupting legacy work` — 구형 서버/신형 연결기·신형 서버/구형 연결기·양쪽 v2, INACTIVE bootstrap 중 v1 주기 ready·queued PEER/CONTINUATION claim·lease/control/complete·legacy UNKNOWN/observe 유지, activation/NEW 경합과 INACTIVE→legacy replace→현재 epoch 명시적 activation/application 회복, activationEpoch/appliedEpoch/ACK 분리, ACTIVE v1 새 snapshot claim 거절, 웹 업그레이드 안내, 버전별 operation bytes/receipt 불변.

17. `should prove creation submission boundaries with the production adapter` — actual CodexAdapter+fake transport로 callback 전 확정 실패·fsync/live 거절·callback 뒤 응답 유실·생성 descriptor 저장·늦은 응답을 검증한다. inspect-created가 thread/read 외 start/name/resume/turn을 0회 호출하고 불완전 기록을 UNKNOWN으로 보존한다.

## Risks

- profile와 runtime 파일의 두 번 저장은 한 DB transaction과 다르다. 각 저장 경계의 journal/receipt 회복을 검증한다.
- 과거 cycle을 새 epoch로 resume하던 동작은 변경된다. 같은 조사에는 기존 설정을 고정하며 새 설정은 NEW cycle로 사용한다.
- workflow v1과 v2를 별도 endpoint로 유지한다. 구형 CLI 자체는 새 오류 문구를 표시할 수 없으므로 기존에 해석하는 CONFLICT로 새 admission을 거절하고, 웹의 호환성 상태와 새 CLI handshake에서 연결기 또는 서버 업그레이드 필요를 구체적으로 안내한다. 구형의 진행 중 조사·UNKNOWN 증거 회복과 v1 local receipt는 계속 v1 계약을 사용한다. INACTIVE bootstrap과 ACTIVE 활성화를 구분하며, 활성화는 같은 잠금에서 전체 cycle idle·양쪽 현재 epoch v2 지원·본인의 현재 owned mapping 확인 뒤 진행한다. activationEpoch와 appliedEpoch를 구분하며 applied ACK는 NEW의 조건이다.
- durable receipt와 history는 유한한 저장 공간을 사용한다. 미확정 application과 unresolved evidence를 quota 정리로 삭제하지 않는다. 확정 receipt 보존량 상한에서는 새 변경을 거절한다.
- capability는 설치된 CLI가 보고한 지원 목록이다. 실제 계정 적격성·모델 실행·turn effort 확인을 대신하지 않는다.

## Verification

- 기존 Node 24 환경의 connector typecheck/build/test, root typecheck/lint/test/build, integration compile.
- 기존 owned fixture의 integration devices/workflow/runtime 및 e2e devices/workflow와 새 settings 검사.
- unchanged 입력의 기존 auth/prototype/CI 검사는 해당 hash 범위를 확인해 재사용한다.
- UTF-8 response 상한, contract mirror, legacy 증거 보존, migration upgrade, fresh independent plan/implementation review, docs links.
- 준비·리뷰된 actual provider 수용은 fake unit/integration와 구분해 호출 수·적용 관찰·정리 결과를 기록한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 계획 round1/round2: pre-commit 실패 종료 | HIGH | PASS — ROUND3 VERIFIED | failure는 application 예약만 해제하며 pending NEW 차단을 유지한다. 새 desired의 실제 적용·ACK 뒤 NEW를 허용한다. |
| 계획 round1: Unicode page budget | HIGH | PASS — ROUND2 VERIFIED | 최대 8개·envelope 포함 16KiB의 가변 1–256 페이지와 연속 index/hash/완성 검증을 독립 검토에서 확인했다. |
| 계획 round1/round2: legacy 전환 계약 | HIGH | PASS — ROUND3 VERIFIED | INACTIVE bootstrap은 기존 v1 ready·queued claim과 회복을 보존한다. 양쪽 v2 지원·본인의 현재 owned mapping 확인·전체 cycle idle을 같은 잠금에서 확인한 뒤 activationEpoch를 확정한다. appliedEpoch/ACK는 NEW의 별도 조건이다. |
| 계획 round2: adapter의 전송·읽기 전용 복구 접점 | HIGH | PASS — ROUND3 VERIFIED | codex-adapter를 변경 파일에 포함했다. 내구 before-submit과 고정 미전송 증거·thread/read 전용 inspect-created를 실제 adapter+fake transport로 검증한다. |
| 계획 round3: stale bootstrap 활성화 회복 | HIGH | PASS — ROUND3 VERIFIED | 현재 로컬 owned mapping 확인과 activationEpoch를 applied ACK/appliedEpoch에서 분리한다. stale 상태는 NEW를 닫은 채 명시적 application으로 회복한다. |
| 계획 round3: 외부 legacy replace 경합 | HIGH | PASS — ROUND3 VERIFIED | 같은 scope/room 잠금의 legacy wrapper가 RESERVED/COMMITTED application을 거절한다. exact settings commit의 private 경로만 교체하며 terminal 뒤에는 기존 idle 조건을 유지한다. |
