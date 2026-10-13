---
status: done
date: 2026-10-14
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 로컬 연결과 설정 복구의 책임 단순화

## Context

사용자는 공식 Claude/Codex 실행 방식을 유지하면서 연결·설정·재접속 처리를 단순화하도록 요청했다. 기준은 main `7a704ab`이다. 최근 RUNTIME_BUSY 보정은 유효한 같은 소유자의 미완료 설정을 관리자로 넘기지만, 정상 연결 준비 안에 설정 접근 판단이 섞여 있다. SettingsManager.recover는 서버·로컬 상태 판단과 저장·통신 효과가 한 함수에 있다.

이번 변경은 기존 동작을 유지하는 내부 리팩터다. 정상 연결의 설정 접근 판단을 설정 잠금 모듈에 모으고, 설정 복구의 순수 판단과 효과 실행을 구분한다. 기존 상태를 새 상태로 마이그레이션하거나 오류·저장 형식·공개 API·CLI 명령을 변경하지 않는다. Claude 내부 JSONL 이력 검증, 공급자 실행 제어, 웹 UI, 인증 기간, 새로운 AI 입력과 실제 AI 검증은 범위 밖이다. [PRD](../../PRD.md)의 질문자 AI 없는 직접 질문·본인 AI 질문과 읽기 전용 범위는 그대로다.

## Affected Files

1. `packages/local-connector/src/cli/settings-lock.ts` — 정상 연결에 한정된 설정 접근 검사와 원래 프로필 읽기를 제공한다. 기존 독립 명령의 유휴 검사는 유지한다.
2. `packages/local-connector/src/cli/connection-recovery.ts` — 정상 연결 준비는 위 검사에 위임하고 연결 이력·미사용 프로필·재검증 보호를 계속 담당한다.
3. `packages/local-connector/src/settings/manager.ts` — recover의 순수 판단을 파일 내부 함수로 분리하고 효과 실행은 기존 메서드로 제한한다.
4. `packages/local-connector/tests/runtime-settings.test.ts` — 기존 fixture와 실제 SettingsManager.run을 이용한 복구 우선순위·재연결 인계 검사.
5. `docs/ARCHITECTURE.md` — 연결 준비·설정 복구 모듈의 책임 설명을 갱신한다.
6. `docs/planning/delivery-and-validation.md` — 범위와 검증 결과를 기록한다.

운영 코드 3개다. 새 상태 프레임워크·라이브러리·공급자별 추상 계층을 추가하지 않는다. 사용자의 구현 요청으로 진행하며 별도의 5개 이상 변경 승인 경계에 해당하지 않는다. 권한 검사의 이동이므로 동작 보존 테스트와 새 독립 리뷰는 필수다.

## Affected Dependents

- `cli.ts:431,529,543,548` — 연결 선택·정상 준비·관리자 시작·독립 명령 진입점. 공개 함수 시그니처 유지.
- `cli/connection-recovery.ts:266,689,765` — 선택 재검증·새 승인 복구의 기존 잠금·유휴 검사. 이번 정상 재개 허용을 확대하지 않는다.
- `cli/connect-command.ts:54,135` — 새 승인 복구와 서버 bindings 확인. 정상 준비 후 서버 확인을 생략하지 않는다.
- `cli/remove-local-profile.ts:110`와 `cli/recovery-eligibility.ts` — 만료 복구·제거의 조건은 변경하지 않는다.
- `settings/store.ts:51,895,958` — 저장된 14개 phase, 유휴 판정, 기기 잠금 구현을 유지한다.
- `tests/cli-settings.test.ts`, `tests/connect-command.test.ts`, `tests/connection-lineage.test.ts`, `tests/connection-recovery.test.ts` (모두 packages/local-connector 아래) — 잠금·독립 명령·만료 복구·이력 보호 회귀 검사.
- `tests/unit/local-connection-product.test.ts` — 실제 생성 명령·bootstrap·CLI·Mac PTY와 가짜 HTTP의 12회 연결 경로.
- `tests/helpers/claude-product-fixture.ts` — SettingsManager 공개 옵션·run 호출 계약 유지.

행동 규칙은 변경하지 않는다. planner가 확인한 관련 사본은 아래와 같다. 같은 줄의 별도 문장은 개별 집계했고 행 사이 중복이 있어 합산하지 않는다. 모든 위치의 규칙 관리 소유자는 `unstated`이며 수행 주체 PC/서버를 팀 소유 선언으로 해석하지 않는다.

| 규칙 | 확인 수 | docs/ 아래 위치 |
|---|---:|---|
| 유효 연결 재사용 | 5 | ARCHITECTURE.md:105; FRONTEND-ARCHITECTURE.md:42; guides/onboarding-and-settings.md:81; planning/delivery-and-validation.md:28,56 |
| 동일 소유자 미완료 설정 인계·독립 명령 차단 | 4 | ARCHITECTURE.md:105의 2문장; planning/delivery-and-validation.md:28의 2문장 |
| 기기 잠금·관리자 수명·인계 | 5 | ARCHITECTURE.md:32,38,40,161; BUSINESS-LOGIC.md:70 |
| 같은 operation·receipt 복구 | 6 | ARCHITECTURE.md:161; BUSINESS-LOGIC.md:68; API-SPEC.md:138,140; DB-SCHEMA.md:122; guides/onboarding-and-settings.md:335 |
| 서버 확정·로컬 적용 구분 | 5 | ARCHITECTURE.md:161; BUSINESS-LOGIC.md:68; API-SPEC.md:138; DB-SCHEMA.md:122; GLOSSARY.md:19 |
| pointer가 같아도 최종 저장 | 2 | ARCHITECTURE.md:161; BUSINESS-LOGIC.md:68 |
| 종결 operation의 정확한 조회 | 2 | BUSINESS-LOGIC.md:68; API-SPEC.md:128 |
| 내부 복구 판단·효과 분리 | 0 | 기존 선언 미발견; 이번 구조 설명만 ARCHITECTURE에 추가 |

문서 탐색은 README에서 시작해 위 정본과 PRD, constraints-and-security, decisions-and-open-items, 관련 AI 조사 문서를 검색했다. 관련 없는 가이드의 완전 탐색은 하지 않았다. 저장소 전체의 사본 부재를 주장하지 않는다. ADR·archive·records·오류 이력은 집계와 편집에서 제외한다.

## Change Map

`cli.main → prepareSelectedConnection → settings-lock의 정상 연결 검사 → prepareConnection → SettingsManager.run`

`SettingsManager.recover → 내부 순수 복구 판단 → 기존 cancel/adopt/commit/prepare/save/call`

정상 준비의 잠금을 반환한 뒤 관리자가 잠금을 다시 획득하고 소유자를 재검증하는 기존 순서를 유지한다. `docs/ARCHITECTURE.md:105,161 --restates--> 정상 연결과 설정 복구의 책임`.

## Implementation Steps

### [x] Step 1: 현재 복구 결과를 경계 테스트로 고정
**File**: `packages/local-connector/tests/runtime-settings.test.ts`
- 운영 코드 변경 전 아래 Tests의 빠진 분기 우선순위·부작용 검사를 추가하고 통과 결과를 보관한다. 기존 테스트가 같은 행동을 충분히 고정하면 새 중복 테스트 대신 이름과 근거를 기록한다.
- 기존 reconnectFixture를 활용해 정상 준비 이후 같은 관리자로 인계하는 경로를 검사한다. helper의 분류 문자열만 확인하는 테스트는 만들지 않는다.

### [x] Step 2: 정상 연결의 설정 접근 판단 정리
**File**: `cli/settings-lock.ts`, `cli/connection-recovery.ts` (packages/local-connector/src 아래)
- settings-lock에 정상 연결 전용 `readConnectSettingsOwner(settings, expectedScope)`를 추가한다. 호출자는 이미 settings.locked를 보유해야 한다. settings.profile의 원래 프로필을 읽은 뒤 설정을 읽고, 검사가 끝난 원래 프로필을 반환한다.
- 기존 prepareSelectedConnection:356–379의 검사·오류 순서를 그대로 옮긴다: 설정만 남고 프로필 없음 → RetiredProfileError; 요청 server/조직/방 검사와 credential/device가 있는 프로필의 scope 필수; 저장 설정의 server/device/조직/방 일치; 유효 connected·정상 credential/device ID·미래 만료·pending/registration 없음일 때만 설정 기록을 관리자에게 넘기고 나머지는 assertIdle.
- 원래 Scope 비교는 matchingScope와 동일한 조건을 유지한다. 잠금 전 선택과 잠금 안 재검증은 서로 다른 시점의 보호이므로 제거하지 않는다.
- prepareSelectedConnection은 assertSelection 다음 위 검사를 호출한다. 새 승인·미사용 generation 잠금·pairing namespace 보호·상태 변경 검증·독립 명령 withSettingsDeviceLock은 유지한다. manager.connected의 별도 인증 검사는 합치지 않는다.

### [x] Step 3: 설정 복구의 판단과 효과 구분
**File**: `packages/local-connector/src/settings/manager.ts`
- recover:969–1035의 행동을 파일 내부 순수 함수로 분류한다. 입력은 현재 SetupJournal과 sameOperation으로 검증한 서버 operation 상태다. 내부 action은 디스크나 API에 저장하지 않고 새 외부 export를 만들지 않는다.
- 우선순위를 유지한다: 미확정 서버 취소의 정리 가능성 → 서버 COMMITTED/APPLIED 채택 → 로컬 CANCEL_INTENT의 취소 receipt 재전달 → 저장된 commit 재전달 → 적용 전 UNKNOWN의 확인 receipt 복원 → LOCAL_CONFIRMATION/APPLYING의 서버 요청별 계속 → 나머지 불확실 준비 상태 보존 → 기존 대기.
- recover는 분류 결과에 맞춰 기존 메서드를 호출한다. sameOperation 검증, exact receipt body, save/call 순서, 조건부 영속 쓰기, 기존 no-op 경로를 유지한다. UNKNOWN을 성공/실패로 추정하거나 새 prepare/AI 입력으로 바꾸지 않는다.
- failure, runner 수명, heartbeat, renewal, 실제 자식 프로세스 정리 책임은 바꾸지 않는다.

### [x] Step 4: 검증·리뷰·문서 마무리
**File**: 관련 테스트·문서
- 아래 Verification 실행, 총괄 diff 확인, 새로운 독립 reviewer의 구현 검토를 수행한다.
- ARCHITECTURE의 책임 설명과 delivery 검증 현황만 갱신한다. 완료 조건을 만족하면 본 명세를 archive로 이동한다.
- 기존 사용자 변경 next-env.d.ts와 개인 실행 기록을 보존한다. 기존 GitHub Flow의 커밋·PR·병합·배포 승인에 따라 검증한 변경을 통합한다. 실제 AI 입력은 0회다.

## Tests

- 기존 Claude/Codex × plain/lineage LOCAL_CONFIRMATION 재개, 소유권·만료·pending·registration·retired·실행 잠금 차단 22개를 유지한다.
- should replay local confirmation after an uncertain receipt without preparing another context: UNKNOWN + 적용 body 없음 + 확인 catalog 존재일 때 같은 receipt만 재전달하고 확인 단계로 돌아감. 적용 body가 있으면 이 복원을 하지 않음.
- should preserve cancellation and committed recovery precedence: 서버 취소와 미확정 commit 후보는 취소하고, 서버 COMMITTED/APPLIED는 같은 확정 기록을 채택함. 새 prepare·목록 조회 없음.
- should keep a cancellation intent without a durable cancellation receipt unresolved: 선행 서버 취소·확정 분기가 적용되지 않는 서버 상태에서 재시작으로 새 취소·prepare를 만들지 않음. 대기 경로는 내용 보존과 설정 쓰기 0회를 확인한다. 저장된 취소 receipt가 있으면 정확한 body만 재전달하고 서버 취소 확인 뒤 닫음.
- should preserve unfinished recovery through normal connection handoff: COMMIT_INTENT/LOCAL_COMMITTED/UNKNOWN/CANCEL_INTENT 중 기존 fixture로 생성 가능한 실제 기록을 정상 준비→관리자 경계로 통과시켜 각 기존 결과와 기록 보존·새 세션 없음 확인. 위 테스트에 인계 경로를 합쳐 중복을 피할 수 있음.
- 기존 불확실 준비 phase, COMMITTED 응답 유실, directory-sync 실패 뒤 APPLIED 순서, capability drift, 살아 있는 manager 차단, 새 승인·독립 명령 보호를 재사용한다.
- 실제 생성 명령의 12회 합성 실행 테스트를 재실행한다. 개인 프로필·실제 로그인·실제 모델은 사용하지 않는다.

## Risks

- 정상 연결·새 승인·관리자 인증의 비슷한 조건을 통합하면 권한이 달라질 수 있다. 정상 연결 조건만 옮기고 다른 시점의 재검증은 유지한다.
- 분기 재배치가 취소보다 commit을 먼저 보내거나 UNKNOWN을 재실행으로 바꿀 수 있다. manager의 관찰 가능한 통신·저장·adapter 호출을 먼저 고정한다.
- 새로운 상태 프레임워크나 effect callback 묶음은 복잡성을 늘린다. 내부 순수 함수와 기존 메서드만 사용하며 공개 API를 확대하지 않는다.

## Verification

- Node 24 PATH에서 `npm --prefix packages/local-connector run build` 및 관련 runtime-settings/connect-command/connection-lineage/connection-recovery/cli-settings 테스트.
- 연결기 전체: `node --test --test-concurrency=1 packages/local-connector/dist/tests/*.test.js` (실제 AI fixture 없음).
- 웹 단위 검사: `npm test` (생성 명령의 Mac PTY 검증 포함).
- `npm run lint`, `npm run format`, `npm run format:check`, `git diff --check`.
- 개인 .env와 기존 next-env를 복사하지 않은 격리 사본에서 합성 환경으로 `npm run build`; 실제 배포 코드 manifest를 포함한 build/타입 검사.
- 통과한 같은 입력은 재사용한다. 실패는 원인을 확인하고 동일 테스트 재검사로만 해소하며 기존 실패도 숨기지 않는다.
- 독립 plan review, implementation review 필수. 이전 bug review는 이번 리팩터 리뷰를 대신하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 계획 검토: CANCEL_INTENT 대기 테스트의 서버 상태 | INFO | ACCEPTED | 선행 취소·확정 분기가 적용되지 않는 조건을 명시했다. 복구 우선순위는 유지한다. |
| 계획 검토: 대기 중 동일 내용 쓰기 검출 | INFO | ACCEPTED | 대기 경로에 설정 쓰기 0회 검사를 추가한다. 확정 복구의 필수 fsync는 기존 실패 검사로 유지한다. |
| 독립 구현 검토 | INFO | PASS | Sol xhigh의 새 읽기 전용 리뷰 1회, C0/H0/M0/L0. 오류·복구 우선순위, 잠금 재획득, 정확한 재전달, 영속 저장과 경계 테스트를 대조했다. |

## Completion Evidence

2026-10-14 운영 코드 변경 전 신규 11개를 포함한 설정 검사 102/102, 변경 후 관련 검사 203/203, 연결기 전체 순차 검사 1070/1070, 웹 단위 601/601을 통과했다. 생성 명령·bootstrap·CLI·Mac PTY·가짜 HTTP의 12회 연결 검증을 포함한다. 격리 production/distribution build, 웹·단위·E2E·통합 타입 검사, lint, root format/check와 diff 검사를 통과했다. lint에서 발견한 미사용 import 하나를 제거한 최종 코드를 독립 리뷰가 확인했다.

개인 env를 복사하지 않은 격리 사본과 합성 fixture를 사용했다. 실제 AI 입력·개인 설정 변경·DB 변경은 0회다. 기존 next-env.d.ts 변경은 원문 hash를 확인해 보존했다. 병합·운영 배포 결과는 이 변경의 PR에 기록한다.
