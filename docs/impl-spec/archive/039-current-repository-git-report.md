---
status: done
date: 2026-10-14
risk-surface: [auth, permission, db-schema, public-api]
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 선택 저장소의 최근 브랜치·커밋 표시

## Context

웹에서 설정한 AI의 연결 정보가 `unknown`으로 표시된다. `runtime_settings_private.commit_binding`은 최초 등록·교체 모두 Git 값을 `unknown`으로 저장한다(SQL016:18,24). 기존 CLI 등록에만 `gitMetadata`가 있다. 사용자 저장소를 읽기 전용으로 확인한 결과 현재 브랜치는 `dev`, 커밋은 `612b91c`였다. 이를 고정값으로 저장하지 않고 각 PC에서 실제 읽은 최근 값을 표시한다. 저장소 checkout 변경은 하지 않는다. PRD의 사람→선택 AI 질문 범위와 기존 로그인·저장소 선택을 유지한다.

검색 시간 확대·마크다운 표시는 별도 국소 변경이며 이 계획의 구현에 포함하지 않는다. 2026-10-14 사용자가 “수정 진행해”로 구현·검증·배포를 승인했다.

## Affected Files

로컬 설치 스크립트를 포함해 운영 파일 10개를 변경한다. 기존 계약·기록의 형식을 바꾸지 않는 별도 Git 보고 경로를 추가한다.

1. `src/features/device-binding/contracts.ts` — `git-report` 요청·응답 계약. 기존 action 응답은 그대로 유지.
2. `packages/local-connector/src/contracts.ts` — 위 계약과 일치하는 사본.
3. `src/features/device-binding/service.ts` — 새 device RPC 연결 및 웹 전용 방 조회 RPC 사용.
4. `packages/local-connector/src/settings/git-report.ts` (신규) — 현재 설정의 root만 새로 관찰하고 보고. 실패 격리·설정 전후 대조 담당.
5. `packages/local-connector/src/cli.ts` — 기존 직렬 heartbeat callback 뒤 보고를 연결. 기존 heartbeat를 먼저 보낸다.
6. `src/features/device-binding/room-git-report.ts` (신규) — 웹 전용 Git 보고 projection/type. 기존 `PublicBinding` 계약은 변경하지 않는다.
7. `src/features/device-binding/room-bindings.tsx` — 최근 관찰·조회 시각과 미확인 상태 표시.
8. `supabase/migrations/20261014002000-current-repository-git-report.sql` (신규) — private 저장, 소유자·현재 epoch 검사, 기기 쓰기 RPC 및 참가자 읽기 RPC.
9. `scripts/apply-local-ai-settings.mjs` — 새 migration의 hash·기능 검사와 기존 설치 지원. 기존 SQL 원문·교정 hash는 수정하지 않는다.
10. `src/app/app/rooms/[roomId]/page.tsx` — 기존 `PublicBinding[]` 변수의 형식을 웹 전용 `RoomGitBinding[]`로 맞춘다. 실제 타입 검사에서 확인한 기존 호출자 보정이며 실행 동작은 바꾸지 않는다.

추가 테스트: 계약 fixture·단위, 새 connector Git 보고 단위, DB 통합, 패널 SSR/브라우저, 로컬 설치 갱신 검사. 테스트 helper가 migration 목록을 고정했다면 새 파일을 포함한다. 운영 파일 추가가 필요하면 범위와 이유를 기록한다.

## Affected Dependents

- `src/app/api/connector/[action]/route.ts`의 기존 action 검증·16KiB 제한·Origin 정책을 재사용한다.
- `CentralClient.call`의 엄격한 응답 projection을 유지한다. `bindings` 응답과 `device_binding_private.bindings`는 새 필드를 받지 않는다. 기존 배포 CLI가 깨지지 않아야 한다.
- `SettingsManager.run:1149`의 배경 통신은 직렬·종료 신호 전달을 유지한다. 설정 적용 중 별도 쓰기 잠금을 잡거나 AI를 실행하지 않는다.
- `SettingsStore.GenerationPointer:37`, `cli/runtime-context.ts:28` — `current`만 사용하며 retained·journal의 준비 root를 현재 root로 대체하지 않는다.
- `workflow/source-snapshot.ts:94`의 `collectSourceObservation(root, [], check, signal)`을 새로 호출해 Git 부분만 쓴다. 저장된 질문의 sourceObservation은 재사용하지 않는다. 기존 함수·역사 자료 형식은 변경하지 않는다.
- `src/app/app/rooms/[roomId]/page.tsx:26` → `roomBindings` → 패널. “다시 확인”의 기존 `router.refresh()`로 최신 서버 보고를 조회한다. 자동 화면 polling은 추가하지 않는다.
- `runtime_settings_private.live_device`(SQL010:295)의 credential·소유자·조직·방 검사 및 잠금 순서를 사용한다. AI 준비 상태/readiness·epoch·실행 상태는 보고로 변경하지 않는다.
- 공개 Git·로컬 경계 규칙 사본 4곳: `docs/API-SPEC.md:117`, `docs/ARCHITECTURE.md:161`, `docs/FRONTEND-ARCHITECTURE.md:38`, `docs/guides/onboarding-and-settings.md:304`(문서 소유자 unstated). 이 저장소의 API·구조·화면 정본을 갱신하고 가이드는 정본 링크를 쓴다.
- 배경 통신 규칙 사본 2곳: `docs/ARCHITECTURE.md:38,40`(SettingsManager/배경 통신). Git 보고 실패와 heartbeat 실패를 분리한다고 보완한다.
- 서버 확정·로컬 적용 규칙 사본 2곳: `docs/ARCHITECTURE.md:163`, `docs/BUSINESS-LOGIC.md:74`(서버/SettingsStore/PC). 현재 pointer와 서버 revision 대조로 따르며 기존 적용 규칙을 변경하지 않는다.
- 과거 입력 자료 규칙 사본 3곳: `docs/ARCHITECTURE.md:191`, `docs/API-SPEC.md:159`, `docs/guides/onboarding-and-settings.md:449`(WorkflowRunner/RuntimeStore 또는 unstated). 이번 보고를 과거 답변 근거로 쓰지 않는다는 경계를 유지한다.
- 문서 검색 범위: docs/README에서 연결된 현재 API·DB·구조·화면·업무·용어·온보딩·보안 안내. 보관 계획/ADR/기록은 사본 집계에서 제외했고 동결한다. 최신성 규칙의 기존 정본은 찾지 못했다.
- `docs/DB-SCHEMA.md`, `docs/BUG-FIXES.md`, `docs/planning/delivery-and-validation.md`에 이번 저장·재현·실제 검사 결과를 기록한다.

## Implementation Steps

### [x] Step 1: 보고 계약과 DB 권한

- 새 `git-report` 본문은 정확한 flat 필드 `agentId`, `workspaceId`, `bindingEpoch`, `configRevision`, `branch`, `commit`, `observedAt`만 받는다. epoch/revision은 양의 안전한 정수, branch는 기존 isBranch 또는 `unknown`, commit은 소문자 40/64 hex 또는 `unknown`, 시각은 정규 ISO UTC이다. 절대 경로·원격 URL·파일 내용은 전송하지 않는다. RPC 결과는 `{protocol:1,reported:true}`로 고정하고 `projectResponse`에 명시적인 분기를 둔다. HTTP 경로는 기존 `{ok:true,data:...}` 외피를 유지한다.
- private table은 agent당 한 행이며 epoch/revision, branch/commit, observed_at, received_at을 보관한다. FK 삭제 정리를 적용하고 직접 테이블 접근을 public/anon/authenticated에 허용하지 않는다. RPC는 search_path 빈 값, 구체 schema 이름을 사용한다.
- 현재 credential로 기기 소유권을 확인한 뒤 agent/workspace/device/owner/org/room 전부 일치·active인지 확인한다. 현재 agent epoch와 설정 revision도 일치해야 한다. 미완료 설정 작업이 있으면 채택하지 않는다. 검사와 저장은 설정 변경과 같은 scope/room 잠금 안에서 실행한다.
- 같은 epoch의 이전 observedAt 보고가 최신 행을 덮지 않게 한다. 서버 기준 5분보다 오래되거나 1분보다 미래인 시각은 거절하며, 동일 시각·동일 값 재전송은 성공한다. 같은 시각에 값이 다르면 CONFLICT. 시계 오차는 연결 실패로 취급하지 않는다.
- 현재 epoch/revision과 일치하지 않는 저장 행은 조회에서 제외한다. 새 설정이 같은 workspace를 재사용해도 옛 값을 보여주지 않는다. commit_binding의 기존 함수 원문은 변경하지 않는다.
- 기존 `connector_heartbeat`/`connector_bindings`/`connection_room_bindings`는 바꾸지 않는다. 새 `connector_git_report`는 anon 기기 credential 쓰기 전용, 새 `connection_room_git_bindings`는 authenticated 참가자의 해당 방 읽기 전용이다. 기존 room 조회 권한 검사를 재사용하고 기존 binding에 nullable `gitReport`를 붙이는 웹 전용 응답을 반환한다.

### [x] Step 2: 현재 폴더의 Git 관찰과 실패 격리

- 현재 연결에 적용된 current pointer 및 해당 generation RuntimeStore의 root/context를 읽는다. ID·epoch·revision·generation을 대조한다. 설정이 미완료이거나 현재 root를 입증할 수 없으면 보고를 생략한다. 비공개 경로를 오류에 출력하지 않는다.
- 기존 관찰 함수를 빈 파일 목록으로 새로 호출한다. 전체 3초 상한, root 동일성 검사, HEAD 전후 일치, 외부 Git 설정·hook·network 억제, 출력 제한, abort를 재사용한다. dirty scan을 추가하지 않는다.
- 관찰 이후 settings를 다시 읽어 같은 current·진행 중 설정 없음·연결 scope 일치를 확인하고 전송한다. server도 현재 epoch/revision을 검사하므로 로컬 재검사 뒤의 교체 경쟁을 차단한다.
- heartbeat 성공 뒤 기존 30초 직렬 반복에서 보고를 1회 실행한다. 별도 timer·동시 report·무한 재시도를 만들지 않는다. Git 실패는 unknown 보고로 표현하고 연결·준비 상태를 끊거나 새 AI 입력을 만들지 않는다. root/권한/취소 실패는 보고하지 않는다.
- 모든 Git·HTTP 작업은 유한하며 종료 후 새 작업을 시작하지 않는다. 전송 실패는 다음 원래 통신 주기에만 다시 관찰한다. heartbeat 인증 실패는 기존 처리로 전달하고 Git 보고 실패 때문에 heartbeat 성공을 실패로 바꾸지 않는다.

### [x] Step 3: 사람에게 최근 확인값을 표시

- 웹 전용 projection은 기존 binding과 nullable Git report를 엄격하게 검증한다. 기존 PublicBinding/connector projection 형식은 그대로 둔다.
- 값이 있으면 `브랜치 dev · 커밋 612b91c`와 `Git 확인: 시각`을 표시한다. 해시는 짧게 보이되 전체 값도 확인할 수 있게 한다. 실제 브랜치를 읽을 뿐 `dev`를 선택·변경하지 않는다.
- 관찰 시각이 조회 기준 2분보다 오래되면 `이전 Git 확인값`으로 표시한다. `최근 수신`은 PC 통신 시각으로 명확히 구분한다. 화면 자체가 자동 최신임을 주장하지 않고 다시 확인 버튼을 사용한다.
- commit만 있으면 `브랜치 이름 미확인`으로 표시한다. detached라고 단정하지 않는다. Git 관찰 실패/nonGit/초기 저장소를 구별할 증거가 없으면 `Git 정보 확인 불가`, 보고 자체가 없으면 `Git 확인 대기`로 표시한다. dirty는 기존 `작업 상태 미확인`을 유지한다.
- legacy 등록 값이 있더라도 최근 보고로 승격하지 않는다. 필요하면 `등록 당시 정보`로만 구분해 표시한다. AI 준비·질문 대상·과거 답변 자료와 별개다.

### [x] Step 4: 설치·검증·배포·기록

- 고정 목록 기반 로컬 설치 스크립트에 새 migration 및 기능 검사를 추가한다. 기존 SQL·원문 검사와 과거 migration은 변경하지 않는다. 클라우드 준비 스크립트는 사본만 만들며 DB에 적용하지 않는다. 운영자 역할의 에이전트는 [클라우드 배포 절차](../../guides/cloud-deployment.md#supabase-준비)에 따라 준비한 동일 workdir로 Supabase CLI의 dry-run을 실행하고 프로젝트 `tcljbegdguixopfcaycs`와 미적용 목록(`20261014002000-current-repository-git-report.sql` 하나만 예상)을 대조한 후 실제 `db push`를 실행한다. 적용 후 migration 이력과 두 새 RPC·private table·실행 권한 설치를 읽기 조회로 검증한다. 검토하지 않은 미적용 SQL이 있으면 함께 적용하지 않는다. 준비/검사만 성공한 상태를 DB 적용 성공으로 표시하지 않는다.
- 기존 동작 실패를 먼저 재현하는 테스트를 추가하고 아래 필수 검사를 마친다. 독립 reviewer의 auth/permission/DB/API 검토를 받는다.
- DB migration을 먼저 배포해도 구버전 웹/CLI가 기존 API로 계속 동작해야 한다. 새 웹과 연결 bundle 배포 뒤 최신 bundle/manifest를 확인한다. UI 보고는 연결 터미널을 정상 종료 후 같은 연결 명령으로 재실행하면 시작한다. 기기 삭제나 새 승인을 요구하지 않는다.
- 현재 `tests/helpers/local-access-stack.ts:107`은 격리 Supabase 컨테이너 정확히6개와 Auth/HTTP 경로를 검사한다. 새 DB 통합·기존 device/workspace HTTP 회귀를 검증할 때만 이 기존 격리 fixture를 실행하며 보호 검사를 완화하지 않는다. 이 fixture의 프로젝트 ID는 현재 꺼 둔 `ai-collab-txxcvm61`과 같다. 별도 스택이라고 주장하지 않는다. 기존 소유 식별·loopback·workdir 검사가 일치하는 경우에만 이 프로젝트의 필요한 6개를 검증 직전에 한시적으로 재시작한다. 기존 데이터는 reset/삭제하지 않고 fixture가 만든 합성 사용자·행만 정리한다. 검사 성공/실패 모두 finally에서 이번에 시작한 컨테이너를 종료하고 프로젝트 실행 컨테이너0개를 확인한다. 다른 프로젝트 컨테이너는 시작/중지/삭제하지 않는다. 화면 검사는 합성 React fixture로 별도 실행한다. 메모리 부족이면 검증이 불완전하다고 보고하고 배포하지 않는다. 실제 AI 입력은 0회다.
- 기존 승인 범위의 PR→main→배포를 진행하고 실제 결과를 delivery에 기록한다. 완료 후 명세를 archive로 이동한다.

## Tests

- 계약: 기존 body/response fixtures 및 웹·로컬 사본 일치, 새 필드 누락/추가·잘못된 시간·branch·40/64 SHA.
- connector: 합성 Git 저장소 dev/main·commit 변화, detached/nonGit, 현재 root만 사용, 이전 generation/교체 중 보고 금지, slow/failed Git에서도 heartbeat 유지, 취소 후 전송 금지, root 교체·시계 범위·Git report 실패 격리, 직렬 실행.
- DB 통합: 올바른 보고·재전송·순서 역전; 다른 사용자/기기/방/agent/workspace·구 credential·이전 epoch/revision·삭제/해제·설정 변경 중 거절; 방 비참가자 조회 거절; unknown과 현재값 교체; 같은 workspace 새 epoch에서 이전 보고 미노출; 직접 테이블 접근 거절; 원래 heartbeat/bindings의 응답 완전 호환.
- 화면: dev/짧은 해시/전체 해시 접근, 미보고·unknown·branch만 미확인·오래된 보고, PC 시각과 Git 시각 구별, router refresh 후 새 보고, 질문 당시 sourceObservation 불변.
- 로컬 설치: 기존 적용 상태에서 새 migration만 추가·재실행 무변경·알 수 없는 기존 함수 원문 보호 유지.

## Risks

- 실제 checkout과 화면 사이 최대 한 통신 주기+수동 조회 지연: 관찰 시각·이전 값 표시로 명확히 한다.
- 설정 교체 경쟁: 로컬 전후 current 비교와 서버 잠금/epoch/revision 검사, 읽을 때 현재값 재검사로 차단한다.
- 구 실행기 strict projection: 새 action과 웹 전용 RPC만 추가하고 기존 응답에 필드를 넣지 않는다.
- repo clock 오차/관찰 실패: 미확인 값이며 PC 연결·AI 준비 상태를 실패로 바꾸지 않는다.
- 검색 시간·AI 전체 실행 시간은 이번 Git 확인 3초와 별개다. UI 버그를 고친다는 이유로 임의 브랜치 전환이나 실행 차단 규칙을 추가하지 않는다.

## Verification

- connector build/typecheck + 새 Git 보고/source-snapshot/heartbeat/settings 관련 단위 검사.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run format:check`.
- 기존 local-access-stack의 임시 격리 6개 컨테이너를 사용한 새 Git 보고 DB/API 통합 검사 + `npm run test:integration:devices`의 기존 device/workspace HTTP 회귀. 기존 검사는 이번 API/DB 영향을 받으므로 이전 결과로 대체하지 않는다. 변경 없는 repository reader/source-history 등 직접 무관한 검사는 기준·설정이 동일한 기존 결과를 재사용한다. 실제 React 패널 브라우저 검사는 DB 없이 합성 fixture로 별도 수행한다.
- 격리 production/distribution build 및 독립 reviewer, 배포 후 manifest와 검증한 bundle 내용 비교.
- 승인된 환경·실행 결과만 완료로 기록한다. 사용자 기기의 재시작·새 보고 수신 전에는 실제 표시 완료를 단정하지 않는다.

## Review Notes

사용자 승인 범위로 구현한다. 최초 독립 리뷰의 나머지 코드 범위·계약 검토는 재사용하며 아래 보정만 추가 검토한다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 준비 스크립트만으로 DB 적용을 완료한 것으로 기술 | HIGH | ACCEPTED | 준비 사본→같은 workdir dry-run→미적용 목록 확인→실제 DB push→이력/RPC/권한 설치 검증을 웹 배포 전 필수 단계로 명시했다. |
| DB만으로 기존 Auth/HTTP 통합 회귀를 실행할 수 없음 | HIGH | ACCEPTED | 기존 6개 격리 fixture를 검증할 때만 실행하고 finally 종료한다. 기존 보호 검사는 유지하며 별도 합성 화면 검사와 재사용 검사를 구분했다. |


2026-10-14 독립 Sol xhigh 계획 리뷰2: PASS(C0/H0/M0/L0). DB 실제 적용·설치 확인과 동일 프로젝트 컨테이너의 한시 검증·종료 보정을 확인했다. 영향 없는 첫 리뷰 결과를 재사용했다. 구현 승인 완료(2026-10-14).

2026-10-14 독립 Sol xhigh 구현 리뷰1: PASS(C0/H0/M0/L0). 운영10개 파일과 테스트 보정 diff를 검토했다. 전체 웹641건·관련 connector187건·화면10건과 DB/API15건의 통과/재사용 근거를 확인했다. soft remove와 물리 삭제를 혼동한 테스트, 신규 RPC 개수 누락 테스트는 보정 및 실제 재검사로 해소했다. 리뷰 이후 운영 적용·배포 확인·완료 기록을 마쳤다.

운영 완료: Supabase에 새20261014002000만 적용하고 이력21개·권한·기존 함수 보존을 확인했다. PR35의 main43e27d4가 Production READY이며 공개 HTTPS10건과 새 Git 보고 모듈이 포함된 배포 tar의 검증 빌드 동일성을 확인했다. 사용자 기기의 실제 새 Git 보고는 기존 터미널의 정상 재시작 뒤 확인한다.
