---
status: done
date: 2026-10-01
risk-surface: auth
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 004 — 실제 사람 인증과 조사방 접근 권한

## Context

[PRD의 공동 조사방](../../PRD.md#scope)과 [인증·기기 연결 구조](../../ARCHITECTURE.md#인증기기-연결)를 구현하는 첫 권한 토대다. [로드맵](../../delivery-and-validation.md#단계별-명세-범위)의 공동 조사 단계 중 사람 인증·그룹/방 접근만 독립 검증한다. 실제 기기 pairing/binding·두 AI 왕복·private·steer·복구는 이 토대의 후속 소비자이며 이번 완료 기준으로 대체하지 않는다.

읽기 전용 planner가 현재 `/`의 prototype graph와 검사 설정을 확인했다. `/`는 `PrototypeApp`만 렌더링하며 실제 Auth·DB·API는 없다. 모의 observer/reducer를 서버 권한 판정으로 사용하지 않는다. 실제 화면은 `/login`, `/app`, `/app/rooms/[roomId]`로 분리하고 기존 `/` 모의 체험과 `experiments/local-ai-runtime/**`를 유지한다. 현재 root는 Next 16.3.7/React 19.3.0/Node 24이며 Git은 없다.

사용자에게 로그인 선호를 선택적으로 물었으며 응답 전 기본안은 이메일 일회용 코드다. 새 Auth 가입은 허용하되 다른 사람이 만든 그룹/방은 유효한 초대를 사용하기 전까지 접근할 수 없다. 각 사람은 자신의 새 조사 그룹을 만들 수 있다. 그룹 owner와 member, 방 owner/participant/observer를 구분한다. observer는 초대된 방을 읽을 수 있으나 초대·멤버 제거를 수행하지 못한다. 자기 AI 실행 권한은 후속 기기/실행 명세에서 추가한다.

이메일 OTP는 메일 template의 `{{ .Token }}`을 사용해야 한다. SSR은 요청별 cookie client와 Next 16 proxy로 갱신하며, cookie만 읽는 `getSession()`의 user를 권한 근거로 삼지 않는다. 초기 두 사용자 범위에서는 서버 `getUser()`로 실제 Auth 사용자와 최신 계정 상태를 확인한다. 개인 응답은 공유 cache에 저장하지 않는다. [공식 SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs), [공식 이메일 인증](https://supabase.com/docs/guides/auth/auth-email-passwordless)

로컬 loopback Supabase/Auth/Postgres/Mailpit 환경은 이미 준비됐지만 제품 테이블·RLS는 없다. 이 명세의 실제 검사는 격리된 로컬 환경과 합성 사용자만 사용한다. 클라우드 계정 생성·외부 메일 발송·제품 배포를 수행하지 않는다. 권한·DB 스키마/마이그레이션·HTTP 계약도 위험면에 포함되어 관련 검사와 독립 reviewer가 필수다. 기존 전체 구현 승인을 사용한다.

### 완료 기준

- 실제 이메일 코드로 로그인·로그아웃·새로고침·갱신을 수행하고 위조/갱신 불가 세션을 거절한다.
- A가 만든 방에 B가 participant 또는 observer 초대로 참가한다. 다른 그룹·같은 그룹의 비초대 방과 비멤버는 실제 DB/RLS 및 HTTP에서 차단된다.
- 역할·owner·actor를 클라이언트가 위조하지 못하고, 제거된 멤버는 이미 발급된 Auth 세션으로도 해당 그룹/방에 신규 접근하지 못한다.
- 초대의 원문은 저장하지 않고 단기·단일 사용·원자 소비와 취소 경계를 확인한다. 데이터 변경과 감사 기록이 같은 transaction에서 완료된다.
- 별도 두 browser context와 실제 로컬 DB/API로 검증한다. 모의 화면 통과를 이 인증 검증으로 재사용하지 않는다.

## Affected Files

1. `package.json`, `package-lock.json` — `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.2 및 DB 검사 전용 `pg` 8.23.1/types를 고정한다. registry의 SDK Node >=22 조건과 현재 Node 24 호환을 확인했다. 기존 Next/React/runtime 실험 의존성은 변경하지 않는다.
2. `.env.example` — 서버의 Supabase URL/publishable key·신뢰하는 app origin placeholder. 실제 자격증명 파일을 생성하지 않는다. 제품 서버에는 service-role/admin key가 필요하지 않은 구조다.
3. `src/lib/supabase/server.ts`, `src/lib/supabase/proxy.ts`, `src/proxy.ts` — 요청별 SSR client·cookie 갱신·현재 Auth 사용자 확인. match는 실제 Auth/방 경로에 한정한다.
4. `src/features/room-access/contracts.ts`, `request-policy.ts`, `access-service.ts` — 허용 DTO/오류·body/origin 검증, 현재 actor/RLS/RPC·조회 경계. 서버 구현은 `server-only`로 보호한다.
5. `src/features/room-access/login-form.tsx`, `access-dashboard.tsx`, `room-access-view.tsx` — 실제 로그인·방 생성·초대/참가·역할·멤버 제거. prototype 상태를 import하지 않는다.
6. `src/app/login/page.tsx`, `src/app/app/page.tsx`, `src/app/app/rooms/[roomId]/page.tsx` — 실제 route와 서버 조회. 인증되지 않은 보호 경로는 안전한 로그인 경로로 보낸다.
7. `src/app/api/auth/[action]/route.ts`, `src/app/api/access/[action]/route.ts` — 아래의 고정 action만 지원한다. 경로를 임의 RPC/테이블/함수 이름으로 전달하지 않는다.
8. `src/app/layout.tsx:4-7`, `src/app/page.tsx:1-5` — 전체 metadata를 제품/체험 양쪽에 맞추고 실제 기능으로 가는 링크를 추가한다. 기존 모의 체험 입력·상태는 보존한다.
9. `supabase/migrations/20261001000100-web-auth-room-access.sql`, `20261001000200-deny-inactive-auth-reads.sql`, `20261001000300-deny-soft-deleted-auth.sql`, `supabase/templates/magic-link.html` — 초기 모델/RLS/grants/RPC·감사·OTP 메일 template. 이미 적용한 migration은 유지하고 정지·soft-delete 계정의 조회/RPC 및 삭제된 발급자의 초대 소비 보정은 후속 migration으로 추가한다. 로컬 환경에 template을 적용한 사실을 확인한다.
10. `tests/integration/web-auth-room-access.test.ts`, `tests/helpers/local-access-stack.ts`, `tests/e2e/web-auth-room-access.spec.ts`, `playwright.auth.config.ts`, `tsconfig.integration.json` — 실제 Auth/DB/HTTP·격리 fixture·별도 browser 검사. 기본 mock 검사에서 외부 환경을 요구하지 않는다.
11. `package.json` scripts·`.gitignore`·lint/typecheck의 새 설정 소비자, `next.config.ts` — integration/e2e:auth 명시 실행 및 검사 산출물 제외. 실제 forwarded-header RED를 근거로 공개 `skipProxyUrlNormalize` 설정을 사용해 신뢰하는 origin의 로그인 Location을 유지한다. 기존 웹 검사 경로도 유지한다.
12. `README.md`, `docs/DB-SCHEMA.md`, `docs/API-SPEC.md`, `docs/ARCHITECTURE.md`, `docs/FRONTEND-ARCHITECTURE.md`, `docs/onboarding-and-settings.md`, `docs/delivery-and-validation.md`, 이 명세 — 총괄이 의도/현재 코드/실제 검사 범위를 구분해 갱신한다.

## Affected Dependents

- `src/features/investigation-prototype/**`와 `tests/unit/prototype-state.test.ts`는 모의 전용 graph를 유지한다. 실제 role/token/room DTO를 reducer에 섞지 않는다.
- `tests/e2e/web-base-experience.spec.ts`는 `/`와 기존 접근성 이름을 사용한다. 링크·metadata 추가가 기존 20개 browser 검사를 깨뜨리지 않아야 한다.
- `tsconfig.test.json:18-25`는 prototype/unit만 컴파일한다. 새 integration을 파일 생성만으로 기존 test script에 포함했다고 주장하지 않는다.
- `playwright.config.ts:4-18`는 두 project/workers 2로 모의 `/`를 검사한다. 실제 Auth 검사는 별도 config와 testMatch로 나누고 모두 E2E 타입 검사에 포함한다.
- `experiments/local-ai-runtime/**`는 root import/typecheck/lock graph 밖에 유지한다. Auth 구현 때문에 actual 모델·개인 provider 인증을 사용하지 않는다.

## Implementation Steps

### [x] Step 1: 실제 Auth와 검사 환경의 경계
**File**: package/lock, SSR/proxy, template, 검사 설정
- 의존성을 정확한 버전으로 추가하고 Next 16 cookie API와 설치된 SDK 타입을 확인한다. client/session은 요청마다 만들며 전역 사용자 client를 재사용하지 않는다.
- Auth HTTP가 cookie를 설정하고 proxy가 갱신한다. 서버-only Auth 흐름에서는 HttpOnly/SameSite=Lax와 HTTPS Secure cookie를 사용한다. 갱신 cookie와 private/no-store headers를 최종 response에 보존한다.
- 로그아웃은 실제 Auth `signOut`과 모든 session cookie chunk 삭제를 수행한다. 같은 요청에 proxy 갱신 cookie가 있더라도 최종 로그아웃 삭제가 우선하며 다음 보호 HTTP/browser 요청은 거절한다. refresh 재사용 거절을 확인하지만 이미 발급된 모든 access JWT의 즉시 폐기를 보장한다고 표현하지 않는다.
- 사용자 확인은 검증한 `getUser()` 결과로 하고 그룹/방 role은 JWT의 사용자 metadata가 아니라 매 요청 DB에서 확인한다. 세션 원문·공급자 token·admin key를 DTO/로그/HTML에 반환하지 않는다.
- 실제 route에서 설정 누락은 고정 503/준비 안내로 처리한다. `/`의 모의 체험은 클라우드 설정 없이 계속 열린다.
- repo template과 로컬 Auth의 실제 발송 template을 대조한다. 합성 inbox로 코드 요청/검증·cooldown·만료/오류를 확인하며 실제 외부 수신자를 사용하지 않는다.
- 현재 로컬 Auth는 코드 6자리·만료 3600초·cooldown 1초이며 custom template은 없다. 코드 template을 실제 config에 연결하고 지정 stack 재시작 후 발송을 검증한다. 만료 검사는 격리된 test 계정의 token 시간 fixture 또는 테스트용 단기 만료 설정을 사용하고 원래 로컬 설정을 복원한다. 유효 서명 세션이 남은 합성 계정을 admin fixture로 삭제/정지한 뒤 최신 `getUser()`에 따른 웹 접근 거절도 확인한다.
- 로컬 검사 launcher는 Auth/API/DB/mail origin이 loopback이며 대상 Docker stack/port가 지정한 격리 프로젝트인지 검사한다. 원격/다른 프로젝트라면 migration·fixture 생성·삭제를 수행하지 않는다.

### [x] Step 2: 모델·RLS·원자적 권한 변경
**File**: 초기 migration, access-service, DB integration
- `organizations`, `organization_members`, `rooms`, `room_members`, private `room_invites`, `access_audit`를 만든다. UUID opaque ID·snake_case 컬럼·활성/removed 상태·유일 membership·tenant 관계 FK·역할 CHECK를 명시한다. room은 범용 title/goal/observation/environment를 저장한다.
- public 조회 대상은 grants와 RLS를 함께 적용한다. 로그인만으로 모든 방을 보지 못하며 같은 조직의 다른 방도 room membership이 필요하다. invite hash/감사 내부값은 공용 조회에서 제외한다.
- 정지·삭제된 Auth 사용자의 이미 발급된 JWT로도 네 public 모델의 직접 PostgREST 조회와 RPC를 거절한다. physical delete와 `auth.users.deleted_at`을 남기는 soft delete를 별도로 검사한다. 조회/actor/초대 발급자 확인에 live Auth 상태를 포함하고 기존 활성 사용자 조회는 유지한다.
- 사용자 직접 INSERT/UPDATE/DELETE와 role/owner 승격을 막는다. RPC는 검증된 `auth.uid()`에서 actor를 계산하고 본문 actor/owner를 입력으로 받지 않는다. 서버 web 경로는 publishable key+현재 user 세션을 사용해 RLS를 우회하지 않는다.
- mutation RPC는 `SECURITY DEFINER SET search_path=''`와 schema-qualified 참조, 최소 execute grants를 사용하고 익명 실행을 거절한다. helper가 RLS recursion이나 임의 tenant 조회 우회를 만들지 않게 한다.
- 고정 RPC는 그룹+첫 방 생성, 소유 그룹 내 방 생성, 초대 발급/소비, 방 멤버 제거, 그룹 멤버 제거다. actor의 현재 role·tenant·활성 상태를 transaction 안에서 다시 확인한다.
- 권한 변경 lock 순서는 organization → room → 관련 membership/invite로 통일한다. 그룹 owner와 방 owner의 자기 제거/마지막 owner 제거는 이번 UI/API에서 허용하지 않는다.
- 제거는 tombstone을 남기고 실효 접근을 즉시 차단한다. 그룹 제거 시 해당 사용자의 모든 room membership도 제거한다. 그룹/방 access_version을 올려 제거 전에 발급한 초대로 권한이 다시 살아나지 않게 한다. 이 값은 `roomRevision`/`bindingEpoch`를 대신하지 않는다.
- migration은 격리 로컬 DB에 transaction으로 적용하고 버전/SQL hash를 기록한다. 공유 DB reset·기존 Auth 사용자 전체 삭제를 하지 않는다. 초기 새 모델의 역변경·실패 시 정리 범위를 문서화한다. [공식 grants/RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

### [x] Step 3: 초대·감사와 고정 HTTP 계약
**File**: contracts/request-policy, 두 action route, RPC
- Auth POST actions는 `code {email}`, `verify {email,code}`, `logout {}`다. 이메일 코드는 6자리, user 입력 길이를 제한한다. 새로운 가입은 다른 그룹 접근을 부여하지 않는다. OTP cooldown/만료는 실제 Auth 설정/거절을 따르며 client-only 검사를 보안 근거로 사용하지 않는다.
- access POST actions는 `bootstrap {groupName,title,goal,observation,environment,displayAlias}`, `room {organizationId,title,goal,observation,environment}`, `invite {roomId,role}`, `join {code,displayAlias}`, `revoke-room-member {roomId,userId}`, `revoke-group-member {organizationId,userId}`다. 역할은 초대에서 participant/observer만 허용한다.
- 성공 envelope는 `{ok:true,data}`이고 실패는 `{ok:false,error:{code}}`다. 고정 action 외 404, 잘못된/unknown/actor/owner 필드 400, 미인증 401, 비권한 mutation 403, 비멤버 방 읽기 404, 소모/만료 초대 409, 환경 준비 불가 503을 사용한다. 내부 SQL/provider 오류 원문을 반환하지 않는다.
- cookie mutation은 신뢰하는 `APP_ORIGIN`과 Origin을 검증하고 JSON body를 최대 16KiB로 실제 읽기 제한한다. query·Host·client redirect로 신뢰 origin을 결정하지 않는다. redirect는 허용된 app 내부 경로만 사용한다.
- 초대는 256-bit 무작위 원문과 SHA-256 hash, 최대 24시간 TTL, issuer/tenant/room/role/access_version을 결합한다. 원문은 발급 응답에서 한 번만 제공하고 DB/audit/URL/query/log에 저장하지 않는다. 사람은 로그인 후 코드 입력으로 참가한다.
- 초대 소비는 row lock과 현재 시간/미사용·issuer/current scope/access_version 검사를 transaction 안에서 수행하고 membership+consumed+audit를 함께 commit한다. 동시 두 소비 중 하나만 성공한다. 과거 초대·제거된 issuer·다른 그룹/방 조합을 거절한다.
- 이미 활성인 room member는 owner/participant/observer 모두 `409 ALREADY_MEMBER`로 거절하고 기존 role·초대 소비 상태·성공 감사를 변경하지 않는다. 활성 organization role은 참가 과정에서 유지한다. removed membership은 취소 이후 발급된 현재 scope/access_version의 새 유효 초대에서만 organization member와 초대된 room의 participant/observer로 복원한다. 다른 방의 removed membership은 복원하지 않으며 무조건 UPSERT로 owner를 강등하거나 승격하지 않는다.
- 감사는 서버가 계산한 actor/action/대상/role/결과를 제한된 컬럼으로 보관한다. 사용자 임의 JSON/audit 입력이나 과거 감사 변경을 허용하지 않으며 원문 코드·이메일 코드·cookie·native ID/절대 경로를 넣지 않는다.

### [x] Step 4: 실제 로그인·방과 역할 화면
**File**: 실제 세 route/세 UI 컴포넌트
- 이메일 → 코드 입력 → 내 방 목록의 실제 흐름을 제공한다. Auth/방 오류는 사용자가 재시도하거나 로그인/초대를 확인할 수 있는 문구로 표시한다. 내부 키/SQL/프로토콜을 UI에 노출하지 않는다.
- 방 생성은 범용 목표·관찰 근거·환경과 사용자 별칭을 받는다. participant/observer 초대·코드 입력·역할 표시·owner의 멤버 제거를 실제 서버 결과와 연결한다.
- observer는 방·준비 정보를 읽고 mutation 제어를 사용하지 못한다. owner만 초대/제거를 수행하지만 UI 숨김을 권한 근거로 삼지 않는다.
- 실제 화면은 아직 AI 연결 전임을 정확히 안내한다. mock AI 발신/개인 설명/정지 결과를 실제 방에 표시하지 않는다. 인증과 방 상태는 새로고침 이후 DB/세션으로 복원한다.
- 한국어 UI·키보드·mobile·오류 focus·IME 동작을 유지한다. 초대 원문을 공용 이력이나 분석/콘솔에 기록하지 않고 입력 모드 간 자동 복사하지 않는다.

### [x] Step 5: 실제 Auth/DB/HTTP·두 브라우저 검증
**File**: integration/helper/E2E/config
- actual Auth가 발급한 합성 사용자 세션으로 HTTP/Data API/RPC를 검사한다. DB RLS harness의 `request.jwt.claims`는 격리 DB 검사에만 사용하며 이를 실제 사람 인증 통과로 주장하지 않는다.
- test/worker/project마다 고유 사용자·그룹·방·inbox를 만든다. 별도 두 browser context에서 cookie를 공유하지 않는다. fixture namespace와 생성한 ID를 기록해 해당 합성 데이터만 정리한다.
- migration/RLS/grants 및 Auth/API 거절, 동시 invite·권한 제거·상태/audit 원자성을 아래 named tests로 검증한다. 실패 response/로그에도 자격증명을 남기지 않는다.
- 새 타입/lint/build와 기존 unit9·모의 browser20을 확인한다. 기존 inputs가 바뀐 검사만 재실행하고 단계 종료까지 새 production Auth E2E를 실제 수행한다.

### [x] Step 6: 독립 리뷰·문서·수명주기
**File**: 정본 docs/명세, 총괄 소유
- source inventory/diff·lock·실제 검사 로그를 고정하고 fresh reviewer가 인증/RLS/RPC·초대 경합·CSRF/cache·오류·fixture 정리·화면의 증거 의미를 독립 검토한다. 차단 지적을 보정하고 적용되는 review cap을 따른다.
- DB-SCHEMA는 제약/모델링 의도, API-SPEC은 고정 계약, frontend/architecture는 현재 소스 경계를 기록한다. Git 부재 상태에서 commit freshness hash를 만들지 않는다.
- 준비한 로컬 환경과 실제 통과 결과를 기록하고 기기 pairing/AI 왕복/Realtime/private/복구/클라우드 배포·두 PC 파일럿은 미완료로 유지한다.
- 모든 Step/named test/필수 검사/독립 리뷰가 통과하면 done/archive 및 backlink 보정을 수행한다. 이후 실제 기기 연결의 상세 명세를 이 결과에 맞춰 작성한다.

## Tests

아래 16개 named test는 코드에 존재하고 모두 실제 격리 환경에서 통과했다. Node 통합 14개와 browser 두 named test의 desktop/mobile 4건을 구분한다.

| 이름 | 반드시 확인할 동작 |
|---|---|
| `should sign in with a real email code and persist the session` | 실제 local Auth/Mailpit 코드, cookie 로그인·새로고침·틀린/재사용 코드 거절 |
| `should reject email codes during cooldown and after expiry` | 실제 Auth 설정의 재요청 제한·만료 코드 거절, 합성 시간/단기 설정 fixture 복원, 새 코드 로그인 성공 |
| `should refresh eligible sessions and reject forged or unrefreshable sessions` | 실제 갱신·위조 서명·유효 refresh 없는 만료·사용자별 client/cookie 분리 |
| `should clear refreshed session cookies on logout and reject refresh reuse` | 실제 signOut, proxy 갱신과 겹친 최종 cookie chunk 삭제 우선, 다음 보호 HTTP/browser 거절과 refresh 재사용 거절; access JWT 전체 즉시 폐기 주장은 없음 |
| `should reject access after the authenticated fixture account is disabled or deleted` | 유효 서명 세션이 남은 합성 사용자 삭제/정지 이후 live Auth 조회·보호 route 거절, 다른 사용자 세션 유지 |
| `should reject unsafe origins redirects and oversized or forged mutation bodies` | Origin/내부 redirect/16KiB/unknown actor·owner 필드 거절, DB mutation 없음 |
| `should restrict database reads and mutations to active tenant and room members` | 익명·비멤버·다른 그룹·같은 그룹 다른 방·제거된 멤버 SELECT/INSERT/UPDATE/DELETE 및 RPC 실제 거절 |
| `should prevent client roles and metadata from promoting room privileges` | observer/participant·client metadata·직접 membership/role/owner 변경으로 권한을 얻지 못함 |
| `should consume an unexpired invitation once under concurrent requests` | 두 실제 DB client 소비 중 한 성공, TTL 경계/미사용 조건·issuer 현재 scope, raw code 미저장 |
| `should preserve active roles and restore removed members only with a fresh invitation` | owner/participant/observer 중복 join은 409·role/초대/감사 불변, 활성 org role 유지, 새 version 초대에서만 해당 room 재가입, 옛 초대·다른 방 복원 거절 |
| `should revoke access and invalidate older invitations atomically` | 제거 직후 기존 Auth 세션 신규 접근 거절, 옛 초대 재가입 거절, group 제거의 room 범위·owner 보호 |
| `should commit authoritative audit records with access changes` | actor/current role와 실제 mutation 일치, 실패/중복 성공 감사 없음, raw secret/audit 위조·변경 거절 |
| `should keep user responses cookies and invitation secrets out of shared caches` | 두 사용자 실제 HTTP/browser 분리, private/no-store, code가 URL/공유 화면/오류에 나타나지 않음 |
| `should allow two authenticated browsers to join only the invited room` | A/B context의 실제 로그인·초대·새로고침, 비초대 방 차단, connector 없이 읽기 |
| `should enforce observer and owner controls after a member is removed` | 실제 role에 따른 UI/API, 제거 이후 B의 새 접근 차단, mobile/키보드 오류 복구 |
| `should refuse integration setup and cleanup outside the owned local stack` | 원격/다른 Docker project 설정에서 migration/생성/삭제 0, 정리는 생성한 합성 IDs만 |

## Risks

- Auth 성공은 방 권한이 아니다. live membership/RLS와 RPC 재검사를 모든 경로에 적용한다.
- service-role은 RLS를 우회한다. 제품 web server에서 사용하지 않고 격리 fixture bootstrap에만 별도로 제한한다.
- 초대/제거의 조회 후 쓰기는 경합에 취약하다. transaction·고정 lock 순서·access_version과 실제 동시 검사를 사용한다.
- Auth 로그아웃·JWT 만료와 조직/방 접근 취소는 다른 동작이다. 이 단계는 제거된 membership의 신규 접근 차단을 검증하며 runtime 중단 완료를 주장하지 않는다.
- 초기 로그인 기본은 이메일 코드다. 사용자가 다른 방식을 선택하면 관련 Auth 표면만 계획에 반영하고 DB/방 scope 검증을 유지한다.

## Verification

Node 24.21.0에서 root 기본 검사와 명시적인 로컬 integration을 나눈다. 아래는 실행할 기준이며 통과 증거가 아니다.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:integration
npm run test:e2e:auth
```

실제 환경 변수는 총괄의 격리 task launcher가 process environment로 전달하고 명령 문자열/로그에 출력하지 않는다. production build·실제 local Auth/DB/browser·독립 리뷰까지 확인해야 완료다.

### 현재 실행 증거 — 2026-10-01

- Node 24.21.0의 `npm ci` exit 0. package/lock hash는 변경되지 않았다.
- 최신 보정6의 타입·lint exit 0, 보정5의 integration compile exit 0. lint는 타입용 stages 변수 경고 1개이며 오류는 없다. 보정2의 production build exit 0은 웹 소스·의존성 입력이 동일해 재사용한다. 기존 prototype 상태 검사 9개도 동일 입력의 PASS를 재사용한다.
- 실제 Auth·Postgres·HTTP 통합 **14/14 PASS**. 물리 삭제·정지·soft delete를 각각 실제 membership과 옛 JWT로 검사해 네 모델 직접 조회/RPC 거절과 정상 owner 접근을 확인했다. 삭제된 초대 발급자 회귀도 포함한다. 세 migration의 적용 hash·기존 grants·빈 search_path를 확인했다.
- 기존 모의 화면 browser **20/20 PASS**, 실제 Auth browser **4/4 PASS**. 보호 오류 표시·포커스·Tab·mobile 폭과 owner/observer 제어를 포함한다. 최초 timeout 4건 및 후속 observer 실패 2건은 보존했고 선택자 보정 후 통과했다.
- Playwright 실패 파일의 합성 marker 회귀: baseline/corrected 각각 4개 DOM-render positive control·15개 파일과 내장 ZIP을 확인했다. baseline 11개 파일 노출 → 보정 후 0개. 고의 실패의 exit 1은 이 회귀의 기대값이며 scanner exit 0이다. 실제 OTP/초대는 사용하지 않았다.
- 최초 구현 독립 리뷰의 5개 지적과 추가 실제 soft-delete 실패를 수용해 보정했다. 고정 candidate 3의 독립 구현 리뷰 2는 기존 보정의 해소를 확인했으나 물리 삭제 직접 회귀와 실제 Auth browser timeout 두 HIGH 검증 gap으로 FAIL이다. 두 지적을 수용해 실제 통합 14개·Auth browser 4개를 통과했다. 독립 구현 리뷰 3은 source 37개·문서 9개의 고정 입력을 확인해 추가 지적 없이 PASS했다. 이전 두 HIGH gap은 RESOLVED이며 변경 없는 생산 코드 경계는 리뷰 1·2의 유효한 결과를 재사용했다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 독립 scope 조사 | — | APPLIED | 기존 `/`의 mock import graph와 검사 러너를 유지하고 실제 route·Auth 검사 config를 분리. 먼저 사람/방 권한만 닫고 기기/런타임은 후속 명세에서 구현 |
| 계획 독립 리뷰 2 | — | PASS | 이전 HIGH 두 보정과 영향받는 계약·named test를 새 reviewer가 확인. 변경 없는 최초 source/scope 검토는 재사용, 추가 지적 없음. 구현과 실제 검사 판정은 별도 |
| 계획 리뷰 1: 기존 membership과 재초대 계약 | HIGH | ACCEPTED | 활성 room member는 ALREADY_MEMBER·미소비/role 보존, removed는 현재 version의 새 초대로 해당 room만 복원. owner/중복/재가입 DB named test 추가 |
| 계획 리뷰 1: 실제 Auth 필수 검증 누락 | HIGH | ACCEPTED | 로그아웃 cookie 삭제 우선·refresh 거절, OTP cooldown/만료와 최신 계정 상태 거절을 named tests에 추가. 로컬 코드 template의 config 연결·재시작도 명시 |
| 구현 리뷰 1: 정지 계정의 직접 RLS 조회 | CRITICAL | ACCEPTED — RESOLVED | 실제 Auth JWT를 유지한 ban fixture에서 web/RPC 거절 이후 직접 조회가 허용되는 RED. 네 public 모델의 회귀 검사와 별도 보정 migration을 추가 |
| 구현 리뷰 1: 실패 browser artifact의 초대 원문 | HIGH | ACCEPTED — RESOLVED | locator matcher snapshot이 plaintext error-context로 저장될 수 있음. 저장 전 실패 정보 정제와 fallback 비활성화, 합성 marker의 실제 고의 실패 검사를 수행 |
| 구현 리뷰 1: trusted login Location 불일치 | HIGH | ACCEPTED — RESOLVED | forwarded proto에서 Next loopback 정규화가 configured 127.0.0.1을 localhost로 바꾸는 실제 RED. 공개 설정과 semantic origin/path 회귀로 보정 |
| 구현 리뷰 1: observer 제거 UI 검사 | MEDIUM | ACCEPTED — RESOLVED | 실제 accessible name과 일치하는 locator 및 다른 non-owner fixture로 권한 제어 누출 검출 |
| 구현 리뷰 1: malformed room ID | MEDIUM | ACCEPTED — RESOLVED | 실제 '-' 36자리 경로가 200 준비 화면을 반환하는 RED. 정확한 UUID 검사와 404 회귀 추가 |
| 추가 실제 검사: soft-deleted 계정의 조회/RPC·발급자 | CRITICAL | ACCEPTED — RESOLVED | 보정2의 기본 통합14는 PASS. 별도 own fixture에서 deleted_at nonnull·web307 이후 직접 room 조회와 bootstrap RPC가 성공하는 RED. actor/조회/issuer의 삭제 상태 검사와 실제 회귀를 추가 |
| 구현 리뷰 2: 물리 삭제의 직접 회귀 | HIGH | ACCEPTED — RESOLVED | 삭제 전 실제 membership·발급 JWT·네 public 조회 양성과 삭제 후 직접 조회/RPC·정상 사용자 유지를 보완해 실제 통합 14개 재통과 |
| 구현 리뷰 2: 실제 Auth browser 미통과 | HIGH | ACCEPTED — RESOLVED | 두 named test의 desktop/mobile 4건 모두 60초 timeout. 안전한 checkpoint로 선택자 오류를 확인·보정해 실제 Auth browser 4건 통과 |
| 독립 구현 리뷰 3 | — | PASS | 물리 삭제의 실제 JWT 회귀·Auth browser 4건·안전한 진단·문서 9개 확인. 추가 지적 0, snapshot 46개 SHA 일치. 변경 없는 Auth/RLS/API/lock/grants 경계와 build/unit/artifact 결과 재사용 |
