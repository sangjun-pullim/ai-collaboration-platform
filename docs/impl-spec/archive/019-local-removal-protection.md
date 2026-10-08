---
status: done
date: 2026-10-03
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 로컬 제거 보호의 내부 책임 분리

## Context

`WorkflowRunner.guardLocalRemoval`에 모인 소유 정보 검증·파일 삭제를 내부 모듈로 분리한다. 실행기의 잠금과 종료 상태는 기존 클래스가 계속 소유한다. [아키텍처](../../ARCHITECTURE.md)의 공개 실행·제거 계약을 유지하며, 큰 파일 정리를 실제 공급자·두 PC 검증 완료로 표현하지 않는다.

사용자가 계획·구현·검증까지 자율 진행하도록 승인한 범위다. 실제 Claude 추가 입력은 [009](../009-claude-code-runtime-compatibility.md)의 별도 상한 확인에 계속 의존한다. 이번 명세는 실제 AI 입력·새 승인·예산·제품 Claude 등록·DB·API·개인 설정 변경을 포함하지 않는다.

## Affected Files

1. `packages/local-connector/src/workflow-runner.ts` — 2093–2234행의 제거 보호에서 snapshot·proof·파일 삭제·session 보호 callback을 내부 모듈로 옮긴다. 진입 검사·binding 잠금·기존 admission·추적 작업·종료 상태는 남긴다.
2. `packages/local-connector/src/workflow/local-removal.ts` — 새 내부 모듈. 한 generic 보호 함수 뒤에 snapshot 검증과 `check/validate/remove` proof의 수명·삭제를 둔다.
3. `packages/local-connector/tests/workflow-runner.test.ts` — 기존 공개 실행기와 실파일 fixture로 빠진 세 경계 조건을 검증한다. 기존 제거 검사 9개와 다른 검사 입력·기대값은 유지한다.
4. `docs/ARCHITECTURE.md` — 완료 후 로컬 제거의 책임과 잠금 소유자를 설명한다.
5. `docs/delivery-and-validation.md` — 완료 근거·한계는 이 정본에 기록한다.

운영 코드 변경은 2개다. `RuntimeStore`, `StateStore`, contracts, adapter, CLI, 기존 HTTP fixture와 설정은 수정하지 않는다.

## Affected Dependents

- `cli/remove-local-profile.ts:25–52` — 모든 agent의 기존 proof를 중첩 획득하고 원래 profile transaction에서 전체 validate 후 삭제한다. 기존 proof 구조·수명을 유지한다.
- `WorkflowRunner.removeLocal:2235–2244` — 원래 profile transaction·검사 순서·반환 `{ state: "removed" }`를 유지한다.
- `cli.ts:414–425`, `tests/runner-fixture.ts:405–416`, `tests/helpers/owned-runtime-fixture.ts:609–630`, `tests/helpers/human-direct-fixture.ts:116–129` — 기존 생성자·export·실행 경로를 유지한다.
- `RuntimeStore.locked/sessionLocked/drainWrites`와 `StateStore.read/transaction` — 원래 객체와 잠금·안전 읽기를 소비한다. 저장 형식·순서·권한을 변경하지 않는다.
- 실행기의 `stop`, `check`, `boundedMutations`, `shutdown`, `underBinding` — 같은 admission·종료 상태를 사용한다. 삭제 보호를 일반 실행 보호나 공급자 shutdown으로 합치지 않는다.

## Implementation Steps

### [x] Step 1: 기존 제거 동작의 경계 검사

**File**: `packages/local-connector/tests/workflow-runner.test.ts`

- 새 검사 3개를 원래 실행기에서 먼저 통과시킨다. 실패하면 구현 이동 전에 원인을 보고하며 기존 기대값을 고치지 않는다.
- 소유 scope/context 불일치와 미해결 증거가 겹치면 `AUTHORITY_LOST`가 우선하고 원래 profile/runtime 바이트가 보존되는지 확인한다.
- 저장 runtime 파일이 없는 유효한 mapping에서 proof를 사용해 callback 결과를 반환하고, 삭제로 파일을 새로 만들지 않는지 확인한다.
- 같은 proof의 첫 remove 뒤 두 번째 remove는 `RUNTIME_CLOSED`이며 다른 profile/runtime은 보존되는지 확인한다.
- 테스트용 production export·환경 옵션·filesystem fault seam을 만들지 않는다. 기존 fixture와 실제 파일·잠금을 사용한다.
- 새 검사의 입력·기대값을 고정하고 다음 단계에서 같은 검사로 비교한다. 기존 9개 제거 검사와 CLI 소유 정보·다중 agent·호출 0회 검사를 보존한다.

### [x] Step 2: snapshot과 파일 삭제를 내부 모듈로 이동

**Files**: `workflow-runner.ts`, `workflow/local-removal.ts`

- 새 함수 `withLocalRemovalProtection`은 기존 profile/store, server origin, 기존 `check`, 추적 작업을 시작하는 callback, 기존 종료 대기 callback과 mutation을 받는다. 실행기 전체·provider·connections·새 admission을 받거나 만들지 않는다.
- 실행기는 admission assert → retired/lockHeld/active → profile/store 경로 검사의 순서와 binding 잠금을 유지한다. `resolve` 경로 검사는 실행기에 남기고 삭제 전용 fs import만 새 모듈로 옮긴다.
- 실행기는 잠금 획득 후 원래 `lockHeld`를 설정한다. 기존 removals 목록을 유지하고 같은 `admission.track`의 Promise를 원래 방식으로 추적한다.
- 실행기 drain은 `toolOpen = false` → admission close → 원래 timeout drain → 모든 removals 대기 → 공용 boundedMutations → store drainWrites 순서를 그대로 유지한다. 공용 `boundedMutations`나 `shutdown`을 옮기지 않는다.
- 내부 모듈은 원래 saved/owner snapshot을 읽고 각 await 뒤 원래 check를 수행한다. 소유 정보 → pending/registration → saved scope/context → unresolved 순서와 validate의 snapshot 비교 → unresolved 순서를 유지한다.
- 내부 remove는 기존 admission의 tracked job 안에서 중복 제거 검사 → validate/check → lstat → validate/check → lstat/속성·identity 비교 → check/unlink/check → directory open/check/sync/check → 무조건 close 순서를 유지한다. 파일 권한·소유자·link 수·inode/device·크기·mtime/ctime 조건과 예외 우선순위를 바꾸지 않는다.
- saved context가 있으면 같은 thread의 session 잠금 안에서 validate/mutation/check와 내부 finally의 drain을 수행한다. 없으면 원래 execute 경로를 사용한다. 반환값과 예외를 정규화하지 않는다.
- 실행기 외부 finally의 두 번째 drain과 그 뒤 retired/lockHeld 갱신을 유지한다. 내부 함수 결과를 반드시 await하여 binding 잠금보다 작업이 먼저 끝나게 한다. drain 실패 시 뒤 상태 대입이 실행되지 않는 기존 동작도 이번 이동에서 바꾸지 않는다.
- 새 모듈의 비교 헬퍼는 같은 `stableJson` 의미를 사용한다. 기존 실행기의 공유 helper·RuntimeScope·unresolvedRuntime import는 다른 경로가 사용하므로 유지한다.
- 공개 클래스·메서드·proof 계약, 파일·저널·중단·복구·오류 코드·공급자 호출 0회를 유지한다. 새 모듈은 패키지의 공개 진입점으로 노출하지 않는다.

### [x] Step 3: 회귀·독립 검토·문서 수명주기

**Files**: 관련 검증 및 위 문서 2개

- 새 3개와 기존 제거/CLI 검사를 전후 같은 입력으로 비교하고 connector 전체 검사를 수행한다. 새 module import가 가리키는 실제 코드를 검사한다.
- 실제 소유 로컬 Auth/DB/HTTP와 가짜 provider의 실행기·직접 질문 fixture를 실행해 일반 준비·실행·업로드·잠금 경로를 확인한다. 이 결과를 제거 자체 또는 실제 AI·두 PC의 증거로 사용하지 않는다.
- 소스·테스트·설정이 그대로인 웹 unit/browser 결과는 정확한 입력 hash 일치 범위에서만 재사용한다. 018 중 실수로 생성된 웹 빌드는 과거 browser 결과와 연결하지 않는다. 이번에는 웹 빌드를 새로 만들 필요가 없다.
- 새 독립 reviewer가 계획·전체 변경·잠금/취소/정리·새 경계 검사를 확인한다. 차단 지적은 같은 구현 세션에서 보정하고 영향받은 검사만 재실행한다.
- 단계 완료 표시를 즉시 갱신하고 검증된 논리 단위로 로컬 커밋한다. 완료 시 문서의 관련 절을 갱신하고 명세를 done으로 보관한다. main push/병합은 하지 않는다.

## Tests

- 새 검사 3개: 복합 오류 우선순위·runtime 없는 제거·두 번 제거의 공개 동작과 실제 파일 보존.
- 기존 제거 9개: 만료 credential, 미시작 journal, stop/늦은 proof, 안전 읽기 중 취소, 기다리지 않은 Promise의 잠금 유지, inode 교체/다른 profile, await 중 소유 정보 변이, transaction 대기 중 취소/active consumer, unresolved 거절.
- 기존 CLI: 소유 정보 거절 입력 13개, binding/session 잠금, 모든 agent 검증 후 삭제, fetch·provider 메서드 호출 0회.
- 기존 전체 connector와 실 HTTP 가짜 provider 검사. 테스트 이름·기대값·fixture를 이동 결과에 맞춰 느슨하게 바꾸지 않는다.
- filesystem sync/close 실패 주입의 새 seam은 이번 범위에서 만들지 않는다. 원래 finally와 오류 우선순위는 코드 비교·독립 리뷰로 확인하며 해당 실패 조합을 새로 실행 검증했다고 주장하지 않는다.

## Risks

- root와 module 양쪽에 종료 소유자를 만들면 잠금이 일찍 풀릴 수 있다. 원래 admission·추적 목록·binding 소유자를 유지한다.
- snapshot 검증보다 unresolved 검사를 먼저 하면 오류 우선순위가 바뀐다. 복합 입력을 전후 같은 기대값으로 검사한다.
- bounded admission drain 뒤에도 삭제 작업은 남을 수 있다. 원래 모든 removals 대기와 session/binding 내부의 두 drain을 유지한다.
- 새 catch/RuntimeStore.remove/shutdown 공용화는 파일 검사·cleanup·provider 호출을 바꾼다. 기존 삭제 body를 국소 이동한다.
- 실제 HTTP fixture의 안전 진단은 신규 모듈의 stack frame을 표시하지 않을 수 있다. 기존 진단 정책은 유지하며 통과 범위를 과장하지 않는다.
- 이번 변경은 책임 분리이며 성능 향상 수치를 주장하지 않는다. 기록 용량·IO 최적화의 기존 결과와 구분한다.

## Verification

- Node 24.21.0과 canonical TMPDIR에서 새 3개 baseline → 이동 후 같은 3개 및 기존 제거/CLI 검사 비교.
- `npm --prefix packages/local-connector run test`와 `run typecheck`, `run build`.
- 루트 `npm run typecheck`, `npm run lint`, 통합 TypeScript 컴파일.
- 기존 소유 stack의 labels·loopback 주소·상태를 확인한 환경에서 실행기 HTTP 6개와 직접 질문 HTTP 11개. 관련 fixture 소유 데이터만 정리하고 reset/migration/remote/provider 입력은 하지 않는다.
- 루트 `npm run format`, `npm run format:check`, `git diff --check`; 허용 파일 외 hash와 기존 테스트 입력·기대값·공개 메서드의 비교.
- 독립 계획·구현 reviewer, 문서 링크·표시·보관·소유 CLI 종료 확인.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 독립 계획 리뷰 round 1 | none | ACCEPTED | C0/H0/M0/L0/INFO0. 현재 코드·호출부·오류/잠금/정리 순서 및 새 경계 검사 구성을 확인했다. 입력 hash가 같은 기존 272개는 변경 전 기준으로만 재사용한다. |
| 독립 구현 리뷰 round 1 | INFO1 | ACCEPTED | C0/H0/M0/L0/INFO1. 기준 body·공개 proof·다른 실행기 멤버 78개·호출자·두 종료 대기·파일 속성·삭제/정리·오류 순서와 전후 검사 입력을 확인했다. 원래 위치의 진단 로깅은 통과한 실행에서 호출되지 않았고 기대값은 그대로다. |
| 직접 질문 HTTP 원본 두 실패 | INFO | REJECTED — 이번 회귀의 차단 사유 | 원본은 두 번 10/11, 진단 복사본 단독 1/1·전체 11/11, 원래 위치 진단 11/11이다. 직접 질문과 정리 호출 경로는 변경된 제거 보호를 쓰지 않고 나머지 실행기 멤버는 보존됐다. 독립 리뷰는 범위 내 완료를 위한 추가 반복 실행을 요구하지 않았다. 최초 원인은 미확인으로 보존하며 진단 통과를 원인 수정으로 기록하지 않는다. |
