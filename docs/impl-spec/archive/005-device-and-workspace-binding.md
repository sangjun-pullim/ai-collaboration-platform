---
status: done
date: 2026-10-01
risk-surface: auth
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 005 — 기기 연결과 로컬 저장소·AI binding 등록

## Context

[사람과 로컬 연결의 구분](../../ARCHITECTURE.md#저장소와-ai의-최초-등록), [기기 scope](../../ARCHITECTURE.md#인증기기-연결), [첫 사용 순서](../../guides/onboarding-and-settings.md#최초-접속-흐름)를 구현한다. 현재 사람 인증·방 권한의 실제 구현과 검증은 [API](../../API-SPEC.md)·[DB](../../DB-SCHEMA.md)·[frontend](../../FRONTEND-ARCHITECTURE.md)에 있다. Auth 통합 14개·Auth browser 4개·모의 browser 20개와 독립 구현 리뷰 3을 통과했다. 004는 완료 보관 기록이다.

읽기 전용 planner가 현재 cookie SSR, 고정 action·RPC, membership 취소와 검사 소비자를 조사했다. `requestClient`는 사람 Auth 전용이며 device bearer로 `auth.uid()`를 대신할 수 없다. `readMutation`의 동일 Origin 검사를 connector에 맞춰 완화하지 않는다. 새 기능은 별도 `device-binding` feature와 고정 API로 분리한다. 기존 세 migration은 수정하지 않는다.

사용자는 전체 구현과 단계별 계획·실행을 총괄이 진행하도록 승인했다. 기존 in-place 위치와 Node 24/TypeScript/Next/Supabase를 사용한다. 첫 connector는 현재 확인한 macOS에서 검증하며 다른 OS의 실제 지원을 주장하지 않는다. 실제 AI는 후속 단계에서 현재 검증된 Codex 경로부터 연결한다.

### 이번 완료 기준

- 로컬 연결 프로그램이 일회용 연결 코드를 만들고, 사람이 웹에서 자기 계정·참가한 방에 승인한다. 별도 로컬 proof 없이는 credential을 교환할 수 없다.
- credential은 한 소유자·한 조직·한 방의 기기 연결에 고정된다. 만료·회전·접근 취소·기기 제거를 실제 DB/API에서 검사한다. 다른 방은 새 승인·profile을 사용한다.
- 실제 로컬 폴더를 선택해 canonical root와 private mapping을 로컬에 보관하고, 웹에는 확인한 별칭·제한된 Git metadata·opaque workspace/agent ID만 보인다. native provider session ID·절대 경로·provider credential은 등록 payload에 없다.
- 멤버 제거는 그 사람의 해당 scope credential·binding·승인된 미교환 pairing도 같은 transaction에서 취소한다. 다른 사람의 기기는 유지한다. 새 초대 재참가로 옛 credential/binding을 복구하지 않는다.
- 등록·최근 heartbeat와 실제 AI 실행 준비를 구분한다. 이번 binding은 `registered/unverified`이며 Auth/provider/session/cwd의 실제 runtime 검증 완료를 주장하지 않는다.
- 실제 loopback Auth/Postgres/HTTP, production connector CLI, 별도 사람 browser context로 검증한다.

실제 provider 실행, 두 AI 질문 왕복, durable run/질문/답변, Realtime, private 설명, steer/UNKNOWN 복구, 클라우드 배포와 두 PC 파일럿은 이 완료 기준 밖의 후속 구현이다.

## Affected Files

1. `supabase/migrations/20261001000400-device-workspace-binding.sql` — private pairing/device/credential/workspace/agent/audit 모델, 고정 SECURITY DEFINER RPC, 현재 membership 취소 RPC의 대상자 기기 취소 consumer. 이미 적용한 00100/00200/00300/00400은 유지한다. `20261001000500-device-cascade-integrity.sql`은 receipt credential FK의 transaction 말미 검사를 위한 후속 보정이다.
2. `src/features/device-binding/contracts.ts`, `request-policy.ts`, `service.ts`, `device-client.ts` — 새 DTO·고정 오류·action, 16 KiB 제한, 사람 cookie와 connector bearer 분리, 명시적인 응답 projection. 서버 코드는 `server-only`로 보호한다.
3. `src/app/api/connections/[action]/route.ts`, `src/app/api/connector/[action]/route.ts` — 사람 승인/취소/제거와 connector 생성/교환/회전/등록/heartbeat를 고정 action에만 연결한다.
4. `src/app/app/connections/page.tsx`, `src/features/device-binding/connection-manager.tsx`, `room-bindings.tsx` — 사람이 방을 선택해 코드 승인·자기 기기 관리, 참가자가 허용된 공개 binding을 관찰한다.
5. `src/app/app/rooms/[roomId]/page.tsx`, `src/features/room-access/access-dashboard.tsx`, `room-access-view.tsx` — 별도 binding 조회/컴포넌트 조합과 준비 안내·연결 관리 링크. 기존 access 반환 계약과 mutation을 변경하지 않는다.
6. `packages/local-connector/package.json`, `package-lock.json`, `tsconfig.json`, `src/contracts.ts`, `central-client.ts`, `state-store.ts`, `workspace-registration.ts`, `cli.ts` — 독립 Node/TypeScript package. runtime 의존성은 Node built-in으로 시작한다. root 웹 graph에 CLI/fs/credential을 import하지 않는다.
7. `packages/local-connector/tests/*.test.ts`, `tests/fixtures/device-binding-contracts.json`, `tests/unit/device-binding-contracts.test.ts`, `tests/unit/device-upstream.test.ts`, `tsconfig.test.json` — private 파일·network·등록·재시도/회전의 격리 unit/CLI와 두 순수 공개 계약의 일치성 검사. 공유 fixture에는 공개 합성 값만 둔다.
8. `tests/helpers/local-access-stack.ts`, 신규 `device-binding-fixture.ts`, `tests/integration/device-workspace-binding.test.ts`, `tests/e2e/device-workspace-binding.spec.ts`, `playwright.device.config.ts` — 기존 owned stack에만 생성하는 새 fixture·실제 DB/HTTP/CLI·browser 검사. 조직 승인 전 생성한 pairing ID도 정확히 추적한다.
9. `package.json`, `tsconfig.integration.json`, `tsconfig.e2e.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `tests/e2e/web-auth-room-access.spec.ts` — 새 package/명시적 test runner·산출물 제외, 기존 Auth 준비 안내 assertion의 의미를 유지한다. 테스트 파일을 추가했는데 실행하지 않는 상태를 허용하지 않는다.
10. `README.md`, `docs/ARCHITECTURE.md`, `DB-SCHEMA.md`, `API-SPEC.md`, `FRONTEND-ARCHITECTURE.md`, `onboarding-and-settings.md`, `delivery-and-validation.md`, 필요시 `ADR.md`·`BUG-FIXES.md`, 이 명세 — 총괄이 실제 범위·남은 runtime/Realtime·검증과 수명주기를 기록한다.

## Affected Dependents

- `src/lib/supabase/server.ts:7-24,33-70`의 설정/요청별 cookie/finish 계약은 두 기존 API와 두 보호 화면·proxy가 소비한다. 새 bearer client는 별도로 만들고 기존 Auth cookie를 소비하거나 refresh하지 않는다. 서버 환경은 기존 세 제품 설정을 유지한다.
- `src/features/room-access/request-policy.ts:12-14,37-48`은 Auth/access 전체의 Origin/16KiB/unknown-field 경계다. connector에 맞춘 완화는 하지 않는다.
- `src/proxy.ts:4`의 `/app/:path*`는 새 사람 관리 화면도 보호한다. 신규 `/api/connector`는 cookie proxy에 포함하지 않는다. `/api/connections`는 route에서 사람 Auth·Origin을 검사하며 요청별 cookie client의 갱신 응답을 끝낸다.
- 기존 membership revoke SQL은 organization→room→membership lock 후 tombstone·access version·감사를 반영한다. 후속 replacement는 기존 계약을 유지하며 대상자 device/credential/pairing/binding 취소를 같은 transaction으로 추가한다. global access version을 device validity version으로 사용하지 않는다.
- `access-service.ts:9-16`의 여섯 RPC caller 및 실제 Auth 통합 14개가 새 revoke 함수 소비자다. 이 14개는 새 DDL 적용 후 다시 실행한다.
- Auth E2E는 준비 안내 문구를 확인한다. 기기 등록 가능·AI 실행 미검증이라는 새 실제 의미로 해당 assertion만 보정하고 로그인·초대·역할·제거·개인 cookie 검사는 유지한다.
- `useMutation`·Auth/access 오류 union은 기존 세 화면/로그아웃의 소비자다. 새 오류/structured DTO 때문에 공개 helper를 늘리거나 이 계약을 확장하지 않고 새 feature가 자신의 송신/오류 상태를 소유한다.
- root `/`의 prototype source·unit 9·mock browser 20, 독립 `experiments/local-ai-runtime` source·51 검사는 변경하지 않는다. 유효한 입력의 결과는 재사용하되 영향받은 graph는 다시 검사한다.

## Implementation Steps

### [x] Step 1: 기기 인증 계약과 원자적 pairing
**File**: 새 migration·contracts·request-policy
- connector가 독립적인 256-bit 연결 코드와 256-bit private proof를 생성한다. 서버 begin에는 각 SHA-256 hash와 확인한 기기 별칭·protocol 1만 전달한다. code/proof hash는 다르며 원문은 DB/audit에 저장하지 않는다. 코드는 로컬 사용자에게 보여주고 proof는 private state에만 둔다.
- pairing은 5분 만료·pending→approved→exchanged 상태로 한 번 승인/교환하며 expired/revoked는 종결 상태다. 승인자는 current Auth·활성 조직/방 membership과 owner/participant 역할을 갖고 명시적으로 방·공개 metadata 범위를 확인한다. observer의 방 기기 등록 승인은 거절한다.
- 연결 쓰기와 두 membership 취소 RPC는 동일한 고정 transaction advisory lock을 가장 먼저 취득한다. 첫 MVP의 bounded한 쓰기를 직렬화하며 기존 organization→rooms(id 순)→organization members(user_id 순)→room members(room_id,user_id 순)→pairings(id 순)→devices(id 순)→credentials→workspaces→agents 순서를 유지한다. scope를 찾기 위한 잠금 전 조회는 권한 근거가 아니며 해당 순서로 잠근 뒤 live actor/membership·scope·상태를 다시 확인한다. 승인·교환·회전·등록·교체·기기 취소와 방/그룹 멤버 취소 모두 같은 guard를 사용하고, 조직 lock 뒤 guard를 얻는 경로는 만들지 않는다. 읽기 RPC도 한 transaction에서 현재 권한과 공개 projection을 확인한다.
- approve는 원문 code hash로 pending 행을 찾고 위 순서로 잠근다. caller/tenant/TTL/미승인 여부를 transaction 안에서 다시 확인한다. actor·소유자·권한은 요청 body에서 받지 않는다.
- connector는 private proof로 승인 상태를 읽고 로컬에 승인된 소유자 별칭·조직/방을 표시한다. 사용자가 이 scope를 확인한 뒤 교환한다. 자동으로 다른 계정/방에 등록을 이어가지 않는다.
- 교환 전 connector가 새 256-bit credential을 로컬에 먼저 저장한다. 서버에는 credential hash와 고정 operation ID만 전달한다. 최초 exchange만 proof·pairing 5분 TTL·승인 scope/live membership을 검사하고 device/credential/audit를 한 번 생성한다. 이미 성공한 동일 proof+operation ID+hash의 복구는 pairing TTL과 별도로 commit 뒤 2분 동안만 허용한다. 잠금 후 현재 device·Auth 소유자·membership이 활성이고 결과 credential이 아직 현재 key이며 미만료인지 다시 확인한다. 조건을 만족하면 기존 opaque 결과/원래 만료를 반환하고 생성·감사·TTL 연장을 하지 않는다. TTL 직전 commit/ACK 유실 후 TTL이 지난 동일 재시도도 이 제한 안에서 복구한다. 다른 operation/hash, 후속 회전·취소·만료·복구창 종료 후 replay는 거절한다.
- credential 만료는 1시간이다. 정상 rotate는 현재 미만료 credential으로 새 hash+operation ID를 승인하며 이전 hash를 즉시 정상 인증에서 무효화한다. 별도 복구 분기는 commit 뒤 2분 안의 마지막 성공 회전 operation/hash와 그때의 이전 credential에만 적용한다. 잠금 후 새 credential이 현재 key·미만료이고 device·Auth 소유자·membership이 활성인지 재검사한 뒤 동일 결과만 반환한다. 최초 회전은 원래 credential 만료 전에 성공해야 하며, 성공 후 원래 key가 자연 만료되어도 위 복구창에서는 확인만 가능하다. 새 key 만료·취소·다음 회전·다른 operation/hash·복구창 종료에는 예외가 없다. 옛 key의 다른 action은 401이며 회전 복구가 scope·기한을 늘리지 않는다. 복구가 불가능하면 CLI는 미확정 상태를 보존하고 disconnected로 표시한다.
- code/proof hash와 전체 보관 credential hash는 각각 유일 제약을 둔다. 교환/회전의 새 credential hash는 현재·이전 보관 key와 pairing code/proof hash를 재사용하지 않는다. 새 secret 생성과 별개인 같은 완료 operation의 확인만 위 복구 분기로 허용한다.
- private schema는 직접 SELECT/DML을 anon/authenticated에 주지 않는다. 사람 RPC는 현재 Auth actor를, 기기 RPC는 고정 credential hash→device→현재 Auth 사용자/활성 org·room membership을 검사하는 별도 private helper를 사용한다. 기기 RPC에만 제한된 anon execute를 부여하고 사람 access RPC나 사람 권한을 대행하지 않는다.
- 모든 함수는 빈 search_path/schema-qualified 참조·최소 grants를 사용한다. web API는 publishable/anon client로 고정 device RPC만 호출하며 service-role·관리자 JWT·가짜 user JWT를 사용하지 않는다. bearer 원문은 TLS/loopback 요청에서 일시적으로 검증할 뿐 저장·로그·사람 DTO로 반환하지 않는다.
- 원문을 전달하는 신규 device client는 upstream도 HTTPS 또는 정확한 loopback HTTP로 제한하고 redirect를 거절한다. 외부 HTTP·URL credentials·지원 밖 URL은 RPC/fetch 전에 거절하며 기존 사람 Auth 설정 전체를 재작성하지 않는다.
- 공개 RPC의 인증 입력은 일시적인 원문 proof/credential이다. DB의 고정 wrapper가 원문의 SHA-256을 계산하고 private helper에서 저장 hash와 비교한다. 서버가 계산한 저장 hash를 공개 RPC의 bearer로 전달하지 않는다. 사람 승인도 원문 code를 받아 DB 안에서 hash를 계산한다. begin의 code/proof hash와 새 credential hash는 등록 자료이며 인증 bearer가 아니다. 저장된 code/proof/credential hash만으로 공개 RPC를 호출하면 거절하고 원문 보유자의 동일 요청은 허용하는 직접 anon/authenticated 회귀를 추가한다. 이 원문은 DB row·감사·오류·로그로 기록하지 않는다.
- 무인 pairing 생성은 위 고정 lock 아래 만료 pending/approved를 expired로 처리하고, 전역의 미만료 pending+approved만 최대 50개로 집계한다. expired/revoked/exchanged는 이 budget을 소비하지 않으며 교환/회전 receipt의 2분 복구창을 정리 때문에 삭제하지 않는다. 활성 device 최대 10개와 활성 agent 최대 2개는 각각 `(owner_user_id, organization_id, room_id)`의 모든 기기에 걸쳐 집계한다. 활성 workspace는 device마다 최대 2개다. 공통 guard 아래 재집계/삽입하여 동시 생성도 한도를 넘지 않으며 revoked/removed binding은 활성 한도에서 제외한다. quota 초과는 고정 429이다. 원문 IP/환경/임의 JSON을 보관하지 않는다. 외부 운영 DDoS 방어는 이후 배포 검증으로 남긴다.

### [x] Step 2: workspace/agent 관계와 취소
**File**: 새 migration·service
- device는 승인된 소유자·조직·방 scope의 한 연결 instance다. 다른 방에 연결하려면 별도 승인/profile을 사용한다. 재등록/재가입으로 기존 ID의 소유자나 scope를 변경하지 않는다.
- 기존 계정·조직 물리 삭제의 cascade를 등록된 binding도 막지 않아야 한다. workspace/agent의 receipt credential FK는 후속 migration에서 `DEFERRABLE INITIALLY DEFERRED`로 보정해 같은 transaction의 child cascade 뒤 검사한다. credential만 삭제하여 남은 binding의 참조를 깨는 commit은 거절하며 receipt 삭제 때문에 binding을 자동 삭제하는 새 cascade를 만들지 않는다.
- workspace는 그 device의 opaque ID·사용자가 확인한 repository 별칭과 제한된 Git metadata만 보관한다. agent는 같은 owner/org/room/device/workspace의 opaque ID, `codex`, 확인한 session 별칭, `binding_epoch`와 `registered/unverified` 상태를 가진다. 복합 FK/유일 제약으로 cross-tenant·다른 사람/device/workspace 조합을 막는다.
- 최초 workspace/agent 등록도 operation ID·명시적 공개 payload의 hash를 로컬에 선기록하고 같은 2분 완료 receipt로 응답 유실을 복구한다. 동일 현재 device scope/활성 credential와 아직 바뀌지 않은 결과 metadata/epoch를 확인하며 한 번만 생성·감사한다. 다른 payload/operation·교체/취소 뒤 과거 결과·복구창 종료는 거절한다. 각 단계의 ACK를 저장한 뒤 다음 등록 단계로 진행하며 미확정 상태에서 새 등록 operation을 만들지 않는다.
- 공유 alias는 최대 40자·사람이 확인한 문자 집합으로 제한하고 path/URI·UUID/token 형태를 거절한다. branch는 Git ref의 제한된 상대 문자열로 검증하고 절대 경로·상위 이동·URL을 거절한다. commit hash·dirty 상태는 정의된 형식/enum만 받는다. 미확인 Git은 unknown으로 표시한다. native path/session/token 필드와 generic metadata JSON은 거절한다. 웹 feature의 순수 contracts가 공개 규칙의 기준이며 connector의 Node/fs/credential 없는 순수 contracts mirror와 versioned 합성 fixture로 양성/음성 alias·branch·protocol·unknown field·응답 projection 판정을 비교한다. 제품 웹은 connector CLI/state를 import하지 않으며 이 비교는 격리 unit graph에서만 수행한다.
- 사람 조회는 current room membership으로 공개 projection만 읽는다. observer는 공개 준비 metadata를 읽되 승인/등록/교체/회전 mutation을 하지 못한다. 사람에게 device credential/hash/proof/pending 원문을 반환하지 않는다.
- workspace/session 교체 전에 connector가 candidate private mapping·expected epoch·operation ID·명시적 공개 payload hash를 로컬에 저장한다. 서버는 자기 device/binding scope와 expected epoch를 검사하고 epoch를 한 번 증가시킨다. commit 뒤 2분 안의 마지막 동일 operation/서버가 계산한 공개 payload hash 재시도는 stale 검사보다 먼저 receipt를 확인한다. 잠금 후 현재 권한·device·credential·binding이 활성이고 binding epoch가 그 결과 epoch와 같을 때만 기존 결과를 반환한다. 후속 교체·취소·다른 payload/operation·복구창 종료는 409 또는 현재 인증 오류이며 새 mutation/audit를 만들지 않는다. 임의 binding ID로 남의 binding을 바꾸지 못한다. local mapping은 동일 결과의 ACK 뒤 확정하며 미확정 candidate가 있으면 새 교체/등록을 차단하고 자동 rollback·새 operation을 하지 않는다. 실제 run이 없는 이번 단계의 등록 교체이며 후속 run 도입 때 active/UNKNOWN 중단 gate를 추가해야 한다.
- 자기 device revoke/remove는 credential·workspace/agent·승인된 미교환 pairing을 동일 transaction으로 비활성화한다. remove는 tombstone을 남기고 새 pairing은 새 ID를 사용한다. 회전과 취소 경합에서 취소 이후 유효 credential이 생기지 않게 같은 lock 순서를 사용한다.
- 사람의 room/group membership 취소 RPC replacement는 대상자의 해당 scope 연결만 영구 취소한다. 다른 멤버와 다른 허용 scope를 건드리지 않는다. removed→fresh invite rejoin 뒤 옛 credential/binding은 계속 거절하며 새 pairing을 요구한다. roomRevision/bindingEpoch와 기존 access_version을 혼용하지 않는다.
- hard delete·ban·soft delete는 기기 요청에서도 현재 사용자/권한 조건으로 거절한다. heartbeat는 마지막 수신 시각/등록 상태만 갱신하고 권한이나 실제 runtime 종결의 증거로 삼지 않는다.

### [x] Step 3: 사람·connector의 고정 HTTP 경계
**File**: 두 신규 route·request-policy·service
- 사람 `/api/connections` actions는 `approve`, `revoke`, `remove`다. 정확한 APP_ORIGIN·JSON·실제 16 KiB·unknown-field 거절과 현재 cookie Auth를 적용한다. 승인 body는 code·organizationId·roomId·공개 metadata 확인, 취소/제거는 자기 deviceId뿐이다.
- connector `/api/connector` actions는 `begin`, `pairing-status`, `exchange`, `rotate`, `heartbeat`, `workspace`, `agent`, `replace`, `bindings`로 고정한다. begin은 새 hash 두 개/별칭/protocol, 상태/교환은 proof bearer, 그 외는 device bearer다. exchange/rotate/replace의 operation ID와 복구 응답은 위 고정 receipt 규칙을 따른다. cookie를 신원으로 쓰거나 cookie를 설정하지 않는다. 사람 Origin 검사를 완화하는 공용 함수 변경은 없다.
- request의 actor/owner/organization/room은 approved pairing/credential scope에서 계산한다. 등록/heartbeat body에 임의 scope·RPC·callback URL·remote command·path/native locator를 받지 않는다. scope가 필요한 사람 승인에만 검증된 opaque room/org ID를 받는다.
- 성공 `{ok:true,data}`와 고정 오류 `{ok:false,error:{code}}`를 사용한다. 미인증/옛 credential 401, 권한 403, 접근 불가 ID 404, 만료/이미 사용/stale epoch 409, quota 429, unavailable 503. provider/SQL/파일/원문 HTTP 오류를 응답으로 복사하지 않는다.
- 응답은 private/no-store. connector는 Vary Authorization, 사람은 Cookie/Origin 경계를 유지한다. cache·RSC·URL·analytics·console에 비밀/로컬 경로를 넣지 않는다. device credential로 기존 human Auth/access endpoint를 호출해도 권한을 얻지 못한다.

### [x] Step 4: 실제 로컬 등록 프로그램과 private state
**File**: 독립 local-connector package·unit/CLI tests
- Node 24 built-in fetch/crypto/fs 기반 CLI에 pair/status/exchange/rotate/register/heartbeat/replace/revoke-local 흐름을 제공한다. `--server`는 HTTPS 또는 명시적인 loopback HTTP만 허용하고 redirect·timeout·지원 밖 protocol을 거절한다. 외부에서 PC로 접속하는 listener나 shell endpoint를 만들지 않는다.
- private state는 OS 사용자 data 영역 또는 명시적 state-dir에 0700 디렉터리·0600 파일로 저장한다. 소유권/permissions·symlink·동시 process 잠금을 검사하고 atomic write/rename·flush로 pending operation을 보존한다. 실제 tests는 task-owned 임시 영역만 사용한다. 개인 agent 설정/provider credential은 읽거나 변경하지 않는다.
- pairing code와 private proof·credential을 분리한다. 출력은 코드·공개 scope·고정 상태뿐이며 credential/proof/native ID/root/error 원문을 로그에 출력하지 않는다. 교환/회전 전에 생성한 다음 secret과 operation ID를 저장해 crash/response 유실 후 같은 요청을 복구한다. 확인되지 않은 상태에서 자동 새 pairing/credential을 생성하지 않는다.
- root는 사용자가 로컬에서 선택한다. 디렉터리·canonical path·접근 권한을 확인하고 filesystem root·사용자 home 전체·개인 인증/agent 설정 디렉터리는 거절한다. 보호 디렉터리의 lexical 경로와 존재하는 canonical target·하위 경로를 함께 차단하여 설정 디렉터리 자체의 symlink도 우회가 되지 않게 한다. provider/native session mapping과 root는 로컬 파일에만 둔다. 등록 payload를 전용 DTO builder로 만들어 local state를 그대로 JSON serialize하지 않는다.
- Git metadata는 timeout/출력 한도가 있는 고정 readonly argv의 `rev-parse --verify HEAD`와 `symbolic-ref --quiet --short HEAD`만 사용한다. shell·network·hook/fsmonitor를 실행하지 않으며 system/global Git config와 관련 환경 주입을 차단하고 stderr를 공유하지 않는다. status/diff로 외부 clean filter를 실행하지 않고 dirty는 이번 단계에서 unknown으로 둔다. Git이 없거나 결과 형식/metadata를 확인할 수 없으면 unknown을 사용한다. alias·공개 metadata를 사용자가 확인해야 등록한다.
- CLI 재시작 뒤 같은 private profile과 opaque mapping을 복원한다. remote revoke/만료/권한 거절은 disconnected로 표시하고 새 실행/등록을 허용하지 않는다. local 제거는 그 profile만 지우며 다른 profile·provider history·root 파일을 삭제하지 않는다.
- runtime/provider/session을 아직 실제 검증하지 않았으므로 registered/unverified를 유지한다. 공급자 인증 token을 이 제품의 pairing credential로 사용하지 않는다.

### [x] Step 5: 웹 관리·공개 준비 정보
**File**: connection manager·room roster·보호 pages
- 사람이 자기 참가 방 중 owner/participant 권한의 방을 선택하고 로컬 프로그램의 연결 코드를 승인한다. 기기 별칭·공개 범위·소유 계정/방을 확인한다. 웹에 로컬 절대 경로나 provider key 입력란을 만들지 않는다.
- 자기 연결 목록에 등록 상태·최근 수신·만료·취소/제거·다시 연결 행동을 보여준다. 다른 사람의 기기 관리 ID/credential을 표시하지 않는다.
- 방에는 공개 repository/session 별칭·runtime 종류·epoch·등록/미검증 상태만 표시한다. connector 없는 observer도 읽을 수 있다. AI 실행 가능/중단 완료라고 표시하지 않는다.
- 한국어·키보드·mobile과 고정 오류의 focus/복구를 제공한다. 기존 Auth UI 권한과 prototype graph를 유지한다. 보호 오류와 Next route announcer를 구분하는 locator를 사용한다.

### [x] Step 6: 실제 CLI·Auth/DB/HTTP·browser 검증
**File**: 새 fixture/test runner·owned local stack
- Node-only unit과 실제 Supabase integration을 분리한다. 실제 fixture는 기존 exact project·canonical workdir·여섯 running container·세 loopback binding 검증을 재사용한다. migration/생성/정리는 지정 stack에서만 수행한다.
- fixture가 요청해 생성한 pairing UUID/hash·사용자·device·organization만 추적한다. 승인 전 anonymous pairing도 exact ID/hash를 확인해 정리한다. 다른 사용자/stack 전체 삭제나 DB reset을 하지 않는다.
- fixture는 자기 namespace와 생성한 exact ID/hash의 최소 cleanup identity를 task-owned 0600 manifest에 기록한다. 관리자·DB·JWK/provider credential은 기록하지 않는다. 실패와 cleanup 실패를 구분하는 고정 stage/파일 위치 진단을 보존하고 원문 예외나 비밀 값을 공개하지 않는다.
- actual product CLI를 별도 process로 실행해 private state-dir·합성 로컬 root·서버 URL을 사용한다. 실제 제품 서버에는 기존 세 설정만 전달하고 test parent의 admin/DB/JWK를 CLI/browser/제품 child로 보내지 않는다.
- browser parent의 새 scoped broker는 자기 fixture의 pairing·교환·등록/heartbeat만 지원하고 device credential은 parent/CLI에 둔다. browser는 사람 Auth와 필요한 일회용 연결 코드만 사용한다. Auth의 artifact 정제 policy·trace/screenshot/video off를 재사용한다.
- 기존 package의 compile/testMatch에 새 파일을 넣고 명시적인 `test:integration:devices`, `test:e2e:devices`를 제공한다. connector package ci/build/typecheck/test를 독립 실행한다.
- 적용된 기존 세 SQL hash를 보호하고 후속 migration hash·grants·함수 실제 상태를 확인한다. 변경된 revoke를 소비하는 기존 Auth14·Auth browser4를 다시 실행한다. root/unit/mock/runtime 결과는 covered inputs가 동일할 때만 재사용한다.

### [x] Step 7: 독립 리뷰·문서·수명주기
**File**: 정본 docs·명세·총괄 소유
- source inventory/diff·의존성·실제 검사를 고정하고 fresh reviewer가 새 bearer/anon definer·pairing proof·rotation/idempotency·권한 취소/재참가·local state·데이터 노출·fixture를 검토한다. 차단 지적은 보정하고 skill의 review cap을 적용한다.
- DB/API/frontend/온보딩은 새 owner/device scope·원문 보관 경계·실행 미검증 상태·private state 복구를 설명한다. Git이 없으므로 freshness commit을 꾸며내지 않는다. 실제 provider/두 AI/Realtime/클라우드/두 PC는 미완료로 남긴다.
- 모든 Step/named test/필수 검사/독립 리뷰가 완료되면 done/archive와 backlinks를 정리한다. 다음 상세 명세는 durable 요청과 connector-owned runtime의 실제 왕복을 이 결과에 맞춰 작성한다.

## Tests

아래는 구현할 named tests다. 존재나 통과를 뜻하지 않는다.

| 이름 | 검증할 동작 |
|---|---|
| `should pair a device only after human approval and matching local proof` | actual Auth actor/room scope·code/proof 분리·approval·exchange, 다른 proof/observer/tenant 거절 |
| `should consume pairing once and recover only the same exchange operation` | 동시 교환 하나, TTL 직전 성공/ACK 유실 후 TTL 뒤 2분 이내 동일 결과 복구·단일 감사, 최초 만료·다른 operation/hash·복구창/현재 key/권한 종료 거절 |
| `should bound pending pairing and owned device creation` | 실제 DB 동시 pending/device/agent/workspace 한도·429·pending/approved 만료 후 quota 회복, 정확한 fixture cleanup |
| `should reject device access when its owner or membership becomes inactive` | 실제 등록 binding을 가진 대상의 hard-delete/ban/soft-delete·room/group 제거 후 old bearer API/RPC 거절, 정상 owner 유지 |
| `should keep revoked devices and bindings disabled after a fresh invitation` | rejoin 후 옛 credential·approved pairing·binding 불복구, 새 pairing 성공·다른 기기 유지 |
| `should rotate credentials atomically and preserve the original scope` | old hash 정상 무효·key hash 재사용·원래/새 key 만료·동시rotate/revoke·2분 same-operation 복구·후속 회전/취소/rejoin replay 거절·scope 불변 |
| `should restrict registration and replacement to the credential scope and epoch` | 다른 owner/tenant/device/workspace/binding·observer·stale epoch·unknown fields와 최초 등록/replace ACK 유실 복구·후속 교체/다른 payload/취소 거절 |
| `should keep private roots credentials and locators out of public storage and responses` | actual CLI payload·DB·HTML/RSC·API·오류·diagnostics의 private 원문 부재, 공개 projection 양성 |
| `should keep connector authentication separate from browser cookies and human actions` | device bearer로 사람 권한 불가·cookie-only connector 거절·CSRF/Origin/16KiB·고정 action·저장 hash만 제시한 직접 public RPC 거절과 원문 보유자 양성 대조 |
| `should commit connection audits with successful state changes` | 승인/교환/회전/등록/취소 actor·scope/audit 원자성, 실패·중복 새 감사 없음 |
| `should preserve registered state without claiming runtime readiness` | 실제 CLI restart/heartbeat·protocol 거절·offline/등록/미검증 표시, 새로운 provider 호출 0 |
| `should refuse device fixture setup and cleanup outside the owned stack` | 원격/다른 Docker project에서 DDL/생성/삭제 0·미승인 pairing exact cleanup |
| `should store connector secrets atomically with private ownership` | Node-only mode/owner/symlink/lock·partial write·기존 state 보존 |
| `should recover saved pairing and rotation operations after a response is lost` | exchange TTL 경계·rotate·최초 등록/replace ACK 유실/재시작의 local journal/candidate 선기록·동일 operation 재사용, 새 key/operation·rollback 없음 |
| `should reject unsafe service origins redirects and unsupported protocol versions` | local HTTP/HTTPS 허용, 외부 HTTP/redirect·unknown response 필드/버전 거절 |
| `should build public registration metadata without serializing local state` | canonical root/native state를 전송하지 않고 explicit alias/Git metadata만 사용 |
| `should reject protected roots and preserve independent local profiles` | broad/protected/nonexistent root와 외부로 symlink된 보호 설정 target/하위 경로 거절·정상 root 양성·canonical mapping·자기 profile만 제거 |
| `should approve an owned connection and display only public unverified bindings` | 실제 CLI·사람 browser·공개 roster, 별도 B/observer·mobile/keyboard·민감 artifact 없음 |
| `should revoke a connection and require fresh approval after membership removal` | 사람 취소/제거와 old bearer 차단·재참가 불복구·다른 사용자 기기 유지·복구 안내 |
| `should agree on public connection contracts across web and connector validators` | 순수 root unit에서 두 validator의 공개 합성 fixture 양성/음성 판정 일치·protocol/action/응답/metadata·unknown field·private 입력 거절 |
| `should reject unsafe device upstreams before sending authentication input` | 신규 device client의 외부 HTTP·URL 인증정보/비정상 origin은 fetch 전 거절, canonical loopback/HTTPS 양성·redirect 거절 |

앞의 12개는 실제 DB/HTTP/CLI integration, 다음 5개는 connector package의 격리 unit/CLI, 다음 2개는 desktop/mobile 실제 browser, 마지막 2개는 root의 순수 unit으로 실행한다. 원래 20개 이름을 유지하고 upstream 보안 회귀를 추가해 총 21개 named test이며 existing Auth14/4는 별도 유지한다. exchange/replace와 room/group revoke의 실제 동시 경합·종료 뒤 재참가에서 옛 연결/승인 불복구를 inactive/rejoin/registration 검사에 포함하고, 같은 scope의 정상 다른 사용자 연결을 양성 대조한다.

## Risks

- 기기 bearer를 사람 JWT로 바꾸면 권한이 확대된다. 별도 고정 RPC/actor로 scope를 재검사하고 human actions를 노출하지 않는다.
- 코드만으로 credential을 가져가거나 회전 유실 후 새 key를 만들면 탈취/중복이 생긴다. private proof·선기록 operation·원자적 idempotency를 사용한다.
- 전역 access version은 다른 사용자의 기기를 취소할 수 있다. 대상자별 영구 revoke consumer와 현재 membership을 사용한다.
- alias·metadata는 데이터 공유다. local DTO builder·server schema·문자열 제한·명시적 공개 확인을 함께 적용하며 source/native locator를 자동 업로드하지 않는다.
- 등록/heartbeat는 실제 provider readiness·active run 생존/종결의 증거가 아니다. 공개 상태를 미검증으로 유지하고 후속 admission/UNKNOWN gate가 이 불변식을 소비하도록 남긴다.
- anonymous pairing의 제한은 초기 instance의 저장/생성 budget이다. 실제 cloud/운영 네트워크·큰 공격 규모의 검증은 완료로 주장하지 않는다.

## Verification

Node 24.21.0, task-owned loopback stack/roots만 사용한다. 아래는 실행할 기준이다.

```sh
npm ci
npm --prefix packages/local-connector ci
npm --prefix packages/local-connector run typecheck
npm --prefix packages/local-connector run build
npm --prefix packages/local-connector test
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:e2e:auth
npm run test:integration:devices
npm run test:e2e:devices
npm run test:e2e
```

현재 입력이 동일한 통과 결과는 재사용한다. 변경된 revocation의 Auth14와 실제 새 connector/DB/browser·root 계약 unit은 직접 실행한다. test parent의 admin/DB/JWK는 process environment에서만 다루고 출력/명령문/파일 또는 제품/CLI/browser child에 보관·전달하지 않는다. 제품 connector 자신의 proof/opaque credential/pending candidate는 의도대로 0600 private state에 저장하되 중앙·web·공유 artifact로 내보내지 않는다. 실제 provider·cloud 호출은 이번 검증에 없다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 읽기 전용 scope 조사 | — | APPLIED | cookie Auth/Origin과 device bearer 분리, 기존 revoke의 새 consumer·입력별 검증·실행 러너를 명시. planner는 source/실제 환경을 변경하지 않음 |
| replace ACK 유실의 stale epoch와 local mapping 불일치 | HIGH | ACCEPTED | candidate/operation/payload hash 선기록과 2분 마지막 결과 복구, 현재 epoch/scope 재확인·후속 교체/취소·재시작 회귀를 추가 |
| 옛 credential의 회전 복구 예외와 만료/취소 우선순위 | HIGH | ACCEPTED | 정상 인증과 2분 마지막 회전 receipt 복구를 분리. 새 key 현재성·만료·live scope를 재검사하고 후속 회전/취소 replay를 거절 |
| pairing TTL 직전 성공 후 ACK 유실 복구의 모순 | HIGH | ACCEPTED | 최초 소비 TTL과 성공 receipt의 별도 2분 복구창을 구분. 현재 credential/scope 확인·TTL 경계 회귀 명시 |
| 기기 연결 mutation과 membership revoke의 전체 잠금 순서 누락 | HIGH | ACCEPTED | 공통 advisory guard를 처음 취득하고 기존 정렬 organization/room/member 뒤 pairing/device/credential/binding 순서 유지. 잠금 후 재검사·실제 경합 회귀 추가 |
| expired approved quota와 device/agent 집계·동시 한도 누락 | HIGH | ACCEPTED | 미만료 pending+approved만 50, 만료 처리·정확한 owner/org/room key·workspace 한도와 실제 동시 device/agent 검사 명시 |
| 웹·connector의 공개 계약 drift | MEDIUM | ACCEPTED | 순수 contracts mirror의 versioned 공개 합성 fixture를 root unit에서 대조하고 양성/음성 DTO·metadata·protocol 경계를 검사 |
| 총괄 보강: 최초 등록의 ACK 유실과 Git metadata 외부 filter | — | APPLIED | 최초 등록도 선기록/동일 receipt로 복구. Git은 고정 rev-parse/symbolic-ref만 사용하고 dirty unknown·외부 config/env 제외를 명시 |
| 독립 계획 재검토 round 2 | — | PASS | HIGH 5·MEDIUM 1 해소 및 새 지적 0. 본문·20 named test와 현재 revoke/caller/fixture를 대조한 계획 검증이며 구현·실제 검사 통과를 뜻하지 않음 |
| 총괄 추가 대조: 저장 hash를 공개 RPC bearer로 소비하는 경로 | HIGH | ACCEPTED | 공개 wrapper가 원문을 hash하여 private helper에 전달하도록 인증 입력을 명확히 하고, 저장 hash 거절/원문 양성 회귀를 요구. 다음 계획 리뷰는 이 보강과 영향 부분을 검토하며 새 DDL은 적용하지 않음 |
| 독립 계획 보강 리뷰 round 3 | — | PASS | 변경 없는 round 2를 재사용하고 원문/RPC/hash 경계와 직접 RPC 회귀를 추가 검토. 비활성 사용자 검사는 원문·정상 owner 양성 대조를 유지해야 하며 구현 보정·실제 검사는 남아 있음 |
| 실제 등록 binding의 삭제 cascade와 receipt credential FK | HIGH | ACCEPTED | 실제 device integration 첫 실행은 4/12 통과·8 실패. 여러 cleanup 실패의 FK 23503과 등록 계정 삭제 경로를 보정하는 후속 migration·등록 hard-delete/cleanup 회귀를 요구하며 이미 적용한 SQL은 유지. AFTER 검증은 아직 남아 있음 |
| 보호 디렉터리 자체의 외부 symlink | HIGH | ACCEPTED | root만 canonicalizing하면 lexical 보호 경로를 우회한다. 독립 리뷰의 코드 추적과 synthetic RED에 따라 보호 canonical target도 차단하며 정상 root·독립 profile 양성 대조 유지. 총괄 실제 검사·재리뷰는 남아 있음 |
| 신규 device upstream의 외부 HTTP | HIGH | ACCEPTED | 기존 설정 검증은 외부 HTTP를 허용하여 새 raw proof/key 경로의 TLS/loopback 조건을 강제하지 않는다. device client에서 URL·redirect를 국소 검증하고 외부 HTTP의 실제 fetch 0과 loopback/HTTPS 양성 회귀를 요구. 현재 actual stack은 loopback이며 외부 유출을 관찰한 것은 아님 |
| 최초 begin ACK 유실 뒤 불가능한 동일 명령 재시도 안내 | MEDIUM | ACCEPTED | local profile 제거와 새 pairing·새 사람 승인을 명시한다. 자동 재연결은 하지 않으며 다른 operation의 receipt 복구는 유지한다. synthetic RED 뒤 unit 통과 |
| 실제 atomic write 실패 주입 부족 | MEDIUM | ACCEPTED | StateStore.write의 rename 실패를 주입해 기존 state·임시 파일/lock 정리와 후속 정상 쓰기를 검사. 원래 구현은 통과하여 fabricated RED나 불필요한 source 변경 없음 |
| exchange 외 mutation receipt의 감사 중복 검증 부족 | MEDIUM | ACCEPTED | rotate/workspace/agent/replace별 정확한 actor·device·scope 감사 수를 성공 전후/receipt 재시도 후 검사. 실제 12 integration 재실행 통과 |
| 실제 후속 DDL 및 integration 재실행 | — | PASS | 00500 적용 뒤 세 receipt FK만 deferred NO ACTION으로 변경됨을 catalog 대조. 함수·권한·다른 제약 유지, 기존 네 SQL SHA 유지. 보정 후 actual device12 전부 통과·skip0. 기존 Auth14·Auth browser4·기기 browser4·모의 browser20 재검사도 모두 통과. 독립 재리뷰는 아직 남아 있음 |
| 독립 구현 재리뷰 round 2 | — | PASS | 첫 HIGH3·MEDIUM3 해소·신규 지적0, current51/controlled104/protected19 SHA 일치·named21 존재와 실제 검사 증거 대조. 변경 없는 Auth/prototype/runtime 리뷰와 입력이 같은 통과 검사를 재사용. 리뷰어의 실제 호출/파일 수정 없음 |

검증 결과(2026-10-01): 기기 actual12·Auth actual14·기기 browser4·Auth browser4·모의 browser20 통과, skip 없음. 현재 SHA를 대조한 worker의 root type/lint/unit11/build·connector type/unit5/build와 입력이 같은 root/connector ci 통과 결과를 재사용한다. 기존 Auth lint warning 1개는 유지한다. 독립 구현 재리뷰 round2는 첫 HIGH3·MEDIUM3 해소를 확인하고 새 지적 없이 통과했다. Step7의 문서·검증·보관 수명주기를 완료한다. 전체 제품의 durable workflow·Realtime·provider 실행·두 PC 파일럿은 후속으로 남는다.
