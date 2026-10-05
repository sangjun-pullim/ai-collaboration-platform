---
status: done
date: 2026-10-04
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 회사 공용 코드와 표시 이름으로 입장

## Context

2026-10-04 사용자가 이메일 인증 대신 **회사 공용 입장 코드 + 표시 이름**을 선택했다. 이 PC에서 접속을 유지하고 내부 user ID와 기기 소유권은 분리한다. [채팅 중심 화면](020-chat-first-web-experience.md)과 함께 적용한다. Supabase Auth 자체를 없애거나 이름을 신원 증명으로 사용하지 않는다.

현재 auth route는 code/verify/logout, 세션은 HttpOnly cookie, DB 소유자는 `auth.users.id`다. 이메일 없는 [Supabase anonymous sign-in](https://supabase.com/docs/guides/auth/auth-anonymous)을 사용하되 **코드로 입장한 내부 ID만 앱 권한을 얻는 DB 검증**을 추가한다. anonymous도 authenticated role이므로 서버 UI 검사만으로 보호하지 않는다.

완료 기준:

- 이메일 발송 없이 코드·표시 이름으로 접속한다. 올바른 코드가 없으면 방 만들기·참가·보기와 AI 연결 변경을 할 수 없다.
- 새로고침·재접속에서는 같은 browser 세션과 같은 내부 user ID를 사용한다.
- 같은 표시 이름을 입력해도 다른 내부 ID의 방·기기·AI 소유권을 가져오지 않는다.
- 이미 존재하는 email 기반 소유자와 기기 ID는 보존한다. 표시 이름과 회사 코드로 기존 user를 검색·대체하지 않는다.
- 방 초대와 기기 pairing의 기존 권한은 유지한다. 회사 코드를 아는 사실만으로 모든 방·상대 기기를 관리하지 않는다.

익명 계정의 logout·cookie 삭제·다른 browser/PC에서는 같은 ID로 자동 복구할 수 없다. 회사 코드와 표시 이름만으로 옛 계정을 재인증하지 않는다. 이번 범위는 같은 browser에서의 지속 접속이며 다른 PC의 같은 사람 계정 복구는 별도 요구다. 이 제한을 ‘표시 이름 변경으로 내 기기를 복구할 수 있음’처럼 안내하지 않는다.

## Affected Files

1. 신규 `supabase/migrations/20261004000900-team-code-entry.sql` — private 입장 코드 verifier·입장 기록·검증 횟수, admission RPC, 기존 앱 권한의 추가 조건.
2. 신규 `src/features/room-access/team-entry-service.ts` — 검증된 현재 세션 재사용 또는 anonymous 생성, code admission, allowlist 결과와 cookie 정리.
3. `src/features/room-access/{contracts,request-policy,access-service}.ts`, `src/app/api/auth/[action]/route.ts` — enter/logout 계약, 현재 사용자 입장 상태 확인, email action 제거.
4. `src/features/room-access/login-form.tsx`, `src/lib/supabase/{server,proxy}.ts`, `src/proxy.ts` — 코드·표시 이름 UI, no-store·cookie·refresh·보호 경로 유지.
5. 신규 `scripts/configure-team-entry.mjs` — 관리자가 지정한 코드의 verifier만 private DB에 설치하는 명시적 관리 도구. secret 입력·DB 권한은 app server에 전달하지 않는다.
6. `tests/e2e/{web-auth-room-access,device-workspace-binding,investigation-coordinator}.spec.ts`, `tests/helpers/{local-access-stack,device-binding-fixture,workflow-fixture,owned-runtime-fixture,human-direct-fixture}.ts` — 실제 입장한 browser user ID와 fixture의 방·기기 소유자를 연결하고 기존 email helper를 교체한다. anonymous sign-in과 synthetic team verifier는 격리 테스트에서 준비한다.
7. docs/API-SPEC, DB-SCHEMA, BUSINESS-LOGIC, ADR, onboarding, delivery — 완료한 실제 인증 동작과 계정 복구 한계를 동기화한다.

## Affected Dependents

- `src/features/device-binding/service.ts`, `src/features/investigation-coordinator/service.ts` — 각 모듈의 user 권한 확인과 DB RPC가 admission을 우회하지 않아야 한다.
- `room_access_private.actor/in_room/in_organization`과 기기·workflow SQL guard — banned·soft-deleted·removed member 거부에 입장 상태를 추가한다. 이전 보호를 대체하지 않는다.
- connector credential 기반 device API — 웹 입장 code를 Bearer credential로 받아들이지 않는다. 기존 기기 소유자·만료·scope·epoch 취소 의미를 유지한다.
- room/organization/member와 기존 `auth.users` 외래키 — 새 임의 user 테이블로 전체 소유권을 옮기지 않는다.
- `tests/helpers/{local-access-stack,device-binding-fixture,workflow-fixture,owned-runtime-fixture,human-direct-fixture}.ts` — 테스트 계정이 정확한 입장 상태를 가지도록 공통 helper를 사용한다. 테스트용 bypass를 제품 코드에 넣지 않는다.

## Implementation Steps

### [x] Step 1: verifier·입장 기록과 DB 권한 조건
**File**: 새 migration과 관리 도구

- `team_entry_private` schema의 verifier·admissions·attempts 테이블은 anon/authenticated 직접 읽기·쓰기를 금지한다. 코드 원문은 DB·browser storage·소스·로그에 저장하지 않는다. 관리 도구는 암호 해시 verifier를 secret 입력에서 만들고 parameterized DB 호출로 설정하며 코드와 verifier를 출력하지 않는다.
- 코드 설정은 migration에 hardcode하지 않는다. 앱에서 누락된 설정을 개발 기본값으로 자동 대체하지 않는다. 설정되지 않은 서비스는 고정된 준비 필요 오류로 닫힌다. 격리 테스트는 별도의 synthetic code와 verifier를 쓴다.
- anonymous Auth user 존재·banned/deleted·입력 상한·코드 해시·검증 횟수를 admission RPC에서 검사한다. 표시 이름 1–80자, 코드 1–128자, NUL·제어 문자·추가 필드를 거절한다. 코드의 의미 있는 공백을 임의 trim하지 않는다.
- admission 결과는 `{ok:true, userId, displayName}` 또는 고정 오류만 반환한다. 다른 user ID를 입력받지 않고 항상 `auth.uid()`에 기록한다. RPC와 브라우저에서 old user를 displayName으로 찾지 않는다.
- 실패 횟수는 실패 RPC가 끝난 후에도 DB에 남아야 한다. 예외 rollback으로 카운터가 취소되지 않도록 실패를 반환하고 HTTP 계층에서 오류를 만든다. actor별 5회/15분 및 전역 60회/분을 transaction으로 제한하고 같은 user 재진입을 잠금으로 직렬화한다. 이는 provider의 anonymous 가입 IP 한도를 대신하지 않는다.
- 기존 유효한 permanent user와 membership·기기는 마이그레이션으로 소유권을 변경하지 않는다. 기존 확인된 세션에는 legacy admission을 부여하되 banned/deleted user는 제외한다. 새로운 Supabase user 생성만으로 legacy admission을 얻는 trigger는 만들지 않는다.
- shared helper로 active admission과 기존 active-user 검사를 구성한다. 새 직접 Supabase anonymous sign-in·기존 Auth endpoint·Data API 호출만으로 bootstrap/join·방 읽기·기기 변경·질문 RPC를 우회할 수 없도록 mutation guard와 SELECT RLS를 적용한다. 새 SELECT 조건은 기존 permissive 정책과 OR로 섞여 우회되지 않게 restrictive 조건 또는 기존 helper 내부에서 적용한다.
- admitted user도 방·그룹 membership과 기기 소유자 검사에 통과해야 한다. admission은 role 상승·owner 변경·기기 credential 발급 권한의 대체물이 아니다.

### [x] Step 2: 서버 enter와 세션 유지
**File**: team-entry-service, auth route, contracts/request-policy, access-service, Supabase helpers

- `/api/auth/enter`는 exact `{code, displayName}`만 받고 기존 엄격한 UTF-8·16KiB·Origin 검사·no-store를 사용한다. userId·기기 proof·provider token 입력을 받지 않는다.
- 먼저 provider getUser로 현재 세션을 확인한다. active admitted 세션은 같은 ID로 이어가며 닉네임을 바꾸어도 ID를 바꾸지 않는다. 미입장된 유효 세션은 새 세션을 반복 생성하지 않고 동일 admission을 수행한다.
- ‘확정된 무세션’은 해당 Auth cookie가 없고 SDK가 명시적인 session missing을 반환한 경우로 제한한다. `access-service.currentUser`의 모든 오류를 UNAUTHENTICATED로 합치는 경로를 새 가입 판정에 재사용하지 않는다. cookie가 있는 getUser 실패, ban/delete/revoked user, timeout·5xx·재시도 가능한 refresh 오류에서는 새 anonymous 가입을 호출하지 않는다. 재시도 가능한 오류는 UNAVAILABLE/503, 확인된 기존 세션 거절은 UNAUTHENTICATED/401로 종료한다. 새로운 참가자로 시작하려면 별도의 명시적 로그아웃과 새 입장을 거친다.
- 인증 장애 응답이 기존 cookie를 새 anonymous identity로 덮거나 지우지 않게 cookie 쓰기 경계를 검토한다. 이미 성공한 같은 ID의 refresh를 되돌리지 않고 재시도 가능한 실패의 삭제 cookie는 응답에 적용하지 않는다. 고정된 무세션·getUser 5xx/timeout·refresh 5xx·429·revoked/ban/delete 각각에서 새 가입 호출 수와 cookie/ID 보존을 검사한다.
- signup은 서버의 송신 IP를 공유하므로 provider anonymous 가입 한도가 모든 신규 browser에 공통으로 적용될 수 있다. 가입 전에 고정 server-side 요청 제한을 두고, 429는 CODE_COOLDOWN으로 응답하며 새 가입을 자동 재시도하지 않는다. publishable key 경로에 admin key나 위조 client-IP 전달을 추가하지 않는다.
- code admission이 실패하면 protected UI로 보내지 않는다. 잘못된 코드만으로 새로운 anonymous user를 계속 생성하지 않도록 미입장 세션을 서버 cookie에 유지하고 동일 ID의 시도 상한을 적용한다. 입장 전 세션은 앱 권한이 없는 상태임을 모든 gateway/DB가 확인한다.
- 코드 검증 결과와 user ID를 allowlist projection한다. browser에 Auth access/refresh token을 JSON으로 반환하지 않고 기존 HttpOnly/SameSite/secure cookie 경로를 유지한다. 쿠키를 설정/정리하는 같은 응답에 refresh 결과를 반영한다.
- code/verify email action은 새 계약에서 제거하고 요청 시 NOT_FOUND로 거절한다. 제품에 메일 발송 경로를 남기지 않아 ‘코드 받기’와 혼동하지 않게 한다.
- logout은 기존 local signout·모든 chunk cookie 정리를 유지한다. logout 후 같은 표시 이름만으로 이전 계정에 연결하지 않는다. 기존 로그인된 email 계정은 현재 내부 ID와 권한으로 정상 사용한다.
- proxy와 서비스가 Auth getUser 성공만으로 admitted로 판단하지 않게 한다. 로컬 테스트 anonymous 활성화는 격리 fixture에 적용하고 공유/운영 Auth 설정은 자동 변경하지 않는다.

### [x] Step 3: 코드 입장 UI·방 기본 표시 이름
**File**: login-form, access dashboard/client-actions

- 회사 입장 코드·표시 이름과 ‘입장하기’ 한 단계로 바꾼다. 코드 입력은 password/autocomplete off이며 전송 후 UI 원문을 지운다. 이름은 계정의 비밀정보가 아니다.
- 같은 browser에서 재접속할 때 유효 세션이 있으면 다시 code 입력을 요구하지 않는다. 입장 미완료·세션 만료·코드 미설정·요청 과다에 실제 다음 행동을 설명한다.
- 채팅방 생성·초대 참가의 기본 별칭은 admission의 표시 이름으로 채운다. 상대 displayName을 actor ID로 사용하지 않는다. 회사 코드와 기기 연결 code는 입력 화면·계약·검증 경로가 분리된다.
- 다른 browser에서 같은 이름으로 로그인하면 별도 ID라는 계정 한계를 설정/로그아웃 문맥에서 짧게 설명한다. 매 질문에 보안 확인 안내를 반복하지 않는다.

### [x] Step 4: 권한 회귀·리뷰·정본 갱신
**File**: unit, 실제 격리 Auth/DB/HTTP, e2e, 관련 docs

- 코드 없이 직접 anonymous user를 만들어 모든 앱 mutation과 SELECT를 시도하는 회귀를 먼저 추가한다. email endpoint 제거가 기존 앱 권한의 우회 경로를 만들지 않는지 확인한다.
- 올바른 code 입장 두 사용자와 같은 nickname 두 사용자, 새로고침·refresh·logout·쿠키 유실, 멤버/기기 취소·Auth ban/soft-delete를 실제 격리 stack에서 확인한다. 전역 시도 제한·동시 요청과 실패 카운터 유지도 검사한다.
- device/workflow browser spec의 별도 이메일 로그인 helper와 고정 email user ID를 새 입장 helper로 교체한다. browser context별 실제 `/api/auth/enter`가 확정한 userId를 먼저 얻고 fixture가 그 ID에 방·기기·요청을 배치한다. 기존 로그인 전에 만들어 둔 다른 ID의 데이터를 새 입장 계정 것으로 취급하지 않는다. Node HTTP fixture는 동일 admission을 가진 검증된 세션을 사용한다.
- alias 변경 검사는 같은 ID 유지로 확인한다. workflow의 다른 페이지 로그인으로 cookie가 바뀌는 회귀는 별도로 유지한다. 두 독립 context에서 실제 code 입장한 A/B 세션을 얻고, 테스트 context 안에서 검증된 B cookie로 A cookie를 교체하여 저장된 A actor의 요청이 403으로 거절되는지 확인한다. stale Auth chunk를 제거하고 전체 유효 chunk를 교체한다. 제품 gateway에 테스트 전용 login이나 actor override는 만들지 않는다.
- 코드·표시 이름·provider token이 artifact·로그에 섞이지 않게 fixture의 기존 artifact policy를 유지한다. 합성 code의 테스트 성공을 실제 운영 code 설치로 기록하지 않는다.
- 새 독립 reviewer가 auth·RLS·RPC·관리 도구의 secret 처리·legacy 보존·테스트를 검토한다. 해당 단계 완료 뒤 관련 정본과 이 명세를 종료한다.

## Tests

- 신규 `tests/unit/team-entry-contracts.test.ts` — 입력 exactness·bytes·origin·코드 공백·고정 오류, admission projection.
- 신규 `tests/integration/team-code-entry.test.ts` — valid/invalid code, 같은 ID 재시도, actor별/전역 제한과 동시 실패 지속 저장, alias 충돌, 직접 anonymous bypass 차단, legacy 유저 보존. getUser/refresh의 timeout·5xx·429 때 새 가입 0회·cookie와 ID 유지·장애 후 재시도 성공을 확인한다. 유효 세션 거절도 새 가입을 하지 않는다.
- `tests/integration/web-auth-room-access.test.ts` — email flow를 코드 입장으로 바꾸되 room/group/RLS·ban·soft-delete·초대·session/chunk revoke의 기대 의미를 유지한다.
- device/workflow/owned-runtime/human-direct HTTP 기존 테스트 — 소유권·권한 취소·늦은 결과 거절을 유지한다.
- `tests/e2e/web-auth-room-access.spec.ts` — 새 입장, 재접속, 다른 이름과 세션 분리, 로그아웃, room/observer 거부.
- `tests/e2e/device-workspace-binding.spec.ts`, `tests/e2e/investigation-coordinator.spec.ts` — 실제 신규 코드 입장의 userId와 fixture 소유권 대조, 같은 이름 변경의 ID 유지, 실제 다른 Auth cookie로 교체됐을 때 기존 요청 거부를 분리해 검사한다.

## Risks

- anonymous도 authenticated role이다. DB admission 없는 user가 기존 bootstrap을 호출하는 경로와 읽기 정책을 반드시 검사한다.
- 쿠키 유실 계정을 표시 이름으로 복구하면 타인 기기를 가져올 수 있다. 복구 기능을 만들지 않고 기존 세션 유지와 새로운 ID 생성을 명확히 구분한다.
- 회사 공용 코드 교체는 신규 입장의 verifier 변경이다. 기존 admission·기기 소유자 취소는 별도 상태이며 과거 세션이 자동 취소된다고 표시하지 않는다.
- 서버가 anonymous signup을 보내므로 [provider IP 한도](https://supabase.com/docs/guides/auth/rate-limits)는 앱 서버 송신 IP에 적용된다. 신규 가입 전 server-side 제한과 429 안내를 추가하며 운영 한도를 임의로 올리거나 IP 전달을 위해 admin key를 추가하지 않는다.

## Verification

- root Node24 typecheck/lint/unit/build/format/format:check와 connector 입력 일치 검증.
- 독립적인 로컬 DB stack에만 migration 적용 후 새 코드 입장 HTTP·Auth browser·device·workflow·runtime·human direct 회귀.
- 통합 TypeScript 컴파일 후 새 검사도 `node --test --test-concurrency=1 .integration-build/tests/integration/team-code-entry.test.js`로 직접 실행한다. 기존 `test:integration` 스크립트만으로 새 검사를 실행했다고 기록하지 않는다.
- migration에서 기존 테이블·auth user ID·pairing/credential·이전 migration을 삭제하거나 reset하지 않았는지 diff 검토.
- 코드 원문·암호 hash·admin key 비노출 확인, 새 독립 reviewer. shared DB·운영 Auth 설정·외부 메일·실제 AI는 이 검증에서 실행하지 않는다.

## Review Notes

계획 round 2의 새 독립 reviewer가 아래 4개 보정과 관련 코드·권한·fixture를 확인했다. 결과는 **PASS, C0/H0/M0/L0/INFO0**이다. 구현 승인과 새 코드의 검증·독립 리뷰는 별도 단계다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| round 1: browser email helpers and seeded identities | HIGH | ACCEPTED | device/workflow spec을 영향 범위에 명시하고 실제 code 입장 userId로 fixture를 구성한다. nickname 변경과 실제 다른 Auth cookie 교체 회귀를 분리한다. |
| round 1: Auth failure treated as no session | HIGH | ACCEPTED | 확정된 무세션만 가입한다. getUser/refresh 장애·유효 세션 거절에서는 기존 identity를 보존하고 가입 0회를 검증한다. |
| round 1: signup provider IP | MEDIUM | ACCEPTED | 제한 대상은 앱 서버 송신 IP다. signup 전 제한·429 안내를 추가하고 admin key/위조 IP 전달은 추가하지 않는다. |
| round 1: email route removal typo | MEDIUM | ACCEPTED | 메일 발송 경로를 남기지 않는다고 정확히 수정했다. |

### 최종 구현 리뷰 — 2026-10-05

새 독립 reviewer의 최종 결과는 **PASS, C0/H0/M0/L0/INFO0**이다. 앞선 HIGH 3개(실패 응답의 refresh cookie 삭제, proxy/API 오류 분류, 실제 membership의 admission 회귀)와 확인된401의 명시적 logout 부재를 수용해 보정했다. 기존 ID는 장애 때 유지하며 새 ID 생성은 무세션 또는 사용자가 명시적으로 logout한 뒤의 입장으로 제한한다.

실제 폐기된 Auth 계정의 기존 cookie 보존→명시적 logout→다른 새 ID 입장, 실제 DB/RLS·기기·공동 조사·직접 질문·가짜 실행기와 PC/모바일 회귀를 확인했다. 이전 backend 리뷰 입력 61개와 connector 입력 40개의 hash 일치 범위는 재사용했다. 최종 검사와 운영 안내·문서 링크를 확인하고 Step 4를 마쳤다. 당시 수치와 현재 진행 상태는 [개발·검증 상태](../../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다. 실제 Claude·두 PC 수용은 별도 범위다.
