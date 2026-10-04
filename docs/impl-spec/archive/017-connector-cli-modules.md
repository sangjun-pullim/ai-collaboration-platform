---
status: done
date: 2026-10-03
risk-surface: permission
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 활성 명세는 검증한 단계만 완료로 표시하고 보관 뒤에는 동결한다.

# 로컬 연결 명령의 옵션 해석과 profile 제거 분리

## Context

로컬 연결 프로그램의 `main`은 옵션 해석과 명령 조립, 여러 AI 연결의 안전한 제거를 함께 처리한다. 사용자 요청에 따른 유지보수 정리로 두 독립 책임을 `cli/` 내부 모듈로 옮긴다. 전체 폴더 이동이나 명령 체계 재작성은 하지 않는다. [로컬 실행 경계](../../ARCHITECTURE.md)의 실행·기록·소유권과 현재 공개 명령을 유지한다.

옵션 해석은 명령을 제외한 문자열 배열을 일반 객체로 변환한다. 필수 옵션 조회·플랫폼과 Node 검사·명령 판단·store/client/runner 조립·출력은 `main`에 남는다. profile 제거는 원래 store 객체와 runner factory를 사용해 모든 agent의 보호를 확보한 뒤 원래 transaction에서 다시 검증하고 삭제한다. credential·소유 runtime을 삭제하는 권한 경로이므로 전후 동작 비교와 새 독립 구현 리뷰가 필요하다.

실제 Claude·두 PC 검증은 [진행 정본](../../planning/delivery-and-validation.md#현재-진행-상태)의 별도 조건이다. 이번 이동에서는 실제 공급자 입력·remote·DB reset·migration·외부 발송을 하지 않는다.

## Affected Files

1. `packages/local-connector/src/cli.ts` — 현재 396–428의 옵션 해석과 519–601의 revoke-local 분기를 내부 모듈로 옮긴다. `Connector`, `hash`, `main`, bin 진입과 JSON 출력은 유지한다.
2. `packages/local-connector/src/cli/parse-options.ts` — 신규. `parseCliOptions(rest: string[]): Record<string, string>` 함수 하나가 기존 허용 목록·쌍 해석·중복 거절을 담당한다. `required`나 명령별 검증을 넣지 않는다.
3. `packages/local-connector/src/cli/remove-local-profile.ts` — 신규. `revokeLocalProfile(store: StateStore, runner: (agentId: string) => WorkflowRunner)` 함수 하나 뒤에 현재 제거 흐름을 옮긴다. store/runner는 타입 import로 참조하고 CLI를 역참조하지 않는다.
4. `packages/local-connector/tests/cli-options.test.ts` — 신규. 이전 실제 옵션 블록과 새 실제 모듈에 같은 입력·기대값을 사용해 옵션 해석을 검사한다. 영구 검사에는 이전 구현 복사본·fallback을 남기지 않는다.
5. `packages/local-connector/tests/connector.test.ts` — 기존 제거·여러 agent·공급자/네트워크 0회·bin 검사를 유지한다. 플랫폼/Node 가드 우선순위와 실제 bin의 잘못된 옵션 오류를 보강한다.

운영 3개·검사 2개다. 총괄은 관련 아키텍처 절·진행 정본·이 명세를 관리한다. runtime/store/adapter/contracts·package/tsconfig·DB·fixture·개인 설정은 변경하지 않는다.

## Affected Dependents

- `connector.test.ts`, `runner-fixture.ts`, `tests/helpers/owned-runtime-fixture.ts`, `tests/helpers/human-direct-fixture.ts` — 기존 CLI export와 실제 생성자·소유권 검사 연결을 유지한다.
- `packages/local-connector/package.json`의 bin과 `tests/helpers/device-binding-fixture.ts` — `dist/src/cli.js` 실행 경로·stderr JSON·종료 코드를 유지한다.
- `WorkflowRunner.guardLocalRemoval`과 내부 `removeLocal` — 기존 보호 객체의 check/validate/remove·잠금·비동기 정리를 그대로 소비한다. runner 구현은 변경하지 않는다.
- `RuntimeStore.agents`, `StateStore.transaction/read/remove`, `stableJson` — 원래 소유 profile의 목록·snapshot 대조·transaction과 삭제 의미를 유지한다.
- root 통합 TypeScript fixture — CLI import와 신규 하위 폴더의 .ts→.js 빌드 경로를 확인한다.

## Implementation Steps

### [x] Step 1: 옵션과 제거의 현재 동작 기준 고정
**File**: 관련 검사 2개

- HEAD·현재 소스·기존 검사와 fixture·설정·개인 지침의 hash를 고정한다. 기존 connector 210개 통과 결과는 변경 없는 기준 입력에서만 재사용한다.
- 현재 main의 실제 옵션 블록을 격리 VM에서 실행하는 기준 검사로 19개 허용 옵션·쌍 해석·빈 입력·중복·누락·빈 값·잘못된 prefix/알 수 없는 옵션의 결과를 고정한다. 소스에서 블록을 읽어 실행하며 수동으로 정책을 복제하지 않는다. 같은 실제 `ConnectionError`를 사용한다.
- 현재 가드와 실제 bin의 잘못된 옵션 오류를 검사한다. 플랫폼/Node 검사는 옵션 오류보다 먼저 일어나야 한다. 전역 process를 변경하지 않는 격리된 실제 함수 검사나 동등한 격리 방법을 사용한다.
- 기존 여러 agent 제거·원래 transaction·소유 정보 변이·다른 profile 보존·네트워크와 공급자 0회 검사를 읽고 기준을 유지한다. 책임 이동을 위한 의도적 RED는 만들지 않는다. 실패가 있으면 원래 입력·로그와 관계를 보고한다.
- 기준 검사와 최종 검사의 입력·기대값을 고정하고 구현 이동 전에 총괄에게 결과를 보고한다.

### [x] Step 2: 두 책임 이동과 실제 모듈 연결
**File**: 운영 3개·관련 검사 2개

- 플랫폼/Node 가드 뒤에서 옵션 해석을 호출한다. 기존 일반 객체·허용 19개·순회/검증 순서·`ConnectionError` identity를 유지한다. 값이 `--`로 시작해도 원래처럼 허용하며 명령별 제한이나 새 parser 규칙을 추가하지 않는다.
- `required`와 기본 state-dir/profile, revoke-local의 기존 server fallback, client/connector/runner 생성, 명령 순서, 출력·bin 처리는 `main`에 유지한다.
- 제거 함수는 원래 store와 runner factory를 사용한다. snapshot·stored agent와 mapping의 합집합·중복 제거·정렬, 재귀적 모든 보호 획득/반환과 원래 transaction 순서를 유지한다.
- transaction 안에서 snapshot 일치·새 agent 거절·모든 proof validate를 마친 뒤 삭제한다. 기존 check 위치와 무조건 실행하는 디렉터리 close를 그대로 옮긴다. profile 경로의 inode/device·UID/0600/nlink·크기·시간 비교, `StateStore.read`의 기존 소유권 검사, unlink·디렉터리 sync와 store.remove fallback 및 오류 순서를 유지한다. 새 FD/path 대조나 check를 추가하지 않는다.
- 원래 `{ state: "removed", scope: "local profile" }` 결과를 그대로 전달한다. 새 adapter 실행/정리 호출, 잠금·상태 소유자·일반 삭제 framework를 만들지 않는다.
- 영구 옵션 검사는 새 실제 모듈을 실행한다. 기준과 같은 입력·기대값을 사용하고 이전 구현이나 fallback을 제거한다. 실제 bin과 기존 여러 agent 제거 검사를 그대로 통과시킨다.

### [x] Step 3: 전체 검증·독립 리뷰·문서 종료
**File**: 관련 검사·아키텍처·진행 정본·이 명세

- Node 24 connector 전체 test·typecheck·build, root typecheck/lint·통합 컴파일·format/diff를 완료한다. import 연결이 바뀐 connector 결과를 새로 실행한다.
- root 웹 source·검사·설정·빌드 입력이 같은 경우 016의 unit 120개·Auth 브라우저 4개·웹 빌드는 hash 대조한 범위에서 재사용한다. 기기 fixture는 실제 `cli.js`를 실행하고 조사 fixture도 이를 사용하므로 device 4개·workflow 8개는 새 connector 빌드로 다시 실행한다. 실제 bin의 로컬 profile 제거도 새 빌드로 확인한다.
- 소유 로컬 Auth/DB/HTTP fixture의 가짜 provider 실행기 6개·직접 질문 11개를 새 connector 빌드로 확인한다. 관리자 값은 부모 fixture에만 두고 SQL001–008·소유 stack은 변경하지 않는다.
- 새 독립 reviewer가 실제 이동한 옵션·가드·제거/권한·에러/정리·import/bin 연결과 제출 증거를 검토한다. 필요한 보정은 같은 구현 CLI에서 진행하고 영향받은 검사를 다시 실행한다.
- 책임 경계·진행 정본을 갱신하고 단계 완료·명세 보관·논리 단위 커밋·구현 CLI 종료/정리를 총괄이 수행한다.

## Tests

1. `should parse existing connector options without changing their values` — 빈 옵션, 19개 전체, 순서, 공백·JSON·`--`로 시작하는 값이 원래 객체로 반환된다. 원래 목록만 검사하는 문자열 비교로 대체하지 않는다.
2. `should reject malformed connector option pairs` — 알 수 없는 key·잘못된 prefix·중복·누락·빈 값이 같은 실제 오류 코드·클래스로 거절된다. 수신 배열을 바꾸지 않는다.
3. `should guard the CLI environment before parsing options` — 실제 main의 플랫폼/Node 가드가 잘못된 옵션보다 먼저 UNAVAILABLE을 반환한다. process 전역 변이를 피한다.
4. `should retain CLI error output for malformed options` — 새 빌드의 실제 bin이 잘못된 옵션에서 정확한 stderr JSON과 exit 1을 반환하며 stdout은 비어 있다. 네트워크·AI를 실행하지 않는다.
5. 기존 `connector.test.ts` 제거 검사 — 미확정/잠금/여러 agent/소유 변이에서 전체 기록 보존, 모든 검증 뒤 삭제, 다른 profile 보존, 공급자·fetch 각 0회와 bin 결과를 유지한다. 파일 이름·함수 존재만으로 통과시키지 않는다.

## Risks

- parser 규칙을 개선하면서 공개 의미를 바꿀 수 있다. 기존의 특이한 허용 결과도 같은 입력으로 고정한다.
- 제거를 agent별 즉시 삭제로 나누면 뒤 agent의 거절에서 앞 기록을 잃는다. 모든 보호와 검증 뒤 삭제 순서를 보존한다.
- store 재생성이나 일반 helper는 잠금·transaction 기준과 실패 정리를 바꾼다. 원래 객체와 기존 guard 인터페이스만 사용한다.
- 하위 폴더 import나 bin 실행 조건 변경은 기존 fixture를 깨뜨린다. 생성된 bin·전체 검사·통합 컴파일과 실제 소유 HTTP를 확인한다.
- 실제 AI·두 PC 검증과 한 PC의 가짜 provider를 구분한다. 이전 실패·미확인 원인을 후속 통과로 해소했다고 표시하지 않는다.

## Verification

- Node 24 `npm --prefix packages/local-connector test`, `npm --prefix packages/local-connector run typecheck`, `npm --prefix packages/local-connector run build`.
- `npm run typecheck`, `npm run lint`, `node node_modules/typescript/bin/tsc -p tsconfig.integration.json`.
- `npm run format`, `npm run format:check`, `git diff --check`; 계약 mirror와 비소유 source/fixture·설정 hash 확인.
- 새 빌드의 실제 bin·전체 connector 검사, 소유 fixture의 실행기 6개·직접 질문 11개. 변하지 않은 웹 증거의 정확한 입력 hash 대조.
- 독립 계획·구현 리뷰, 문서 경로/anchor 검사, 관련 문서·명세 완료와 보관·CLI 정리.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| PLAN-1 | LOW | ACCEPTED·보정 | 새 독립 계획 리뷰 C0/H0/M0/L1/INFO0에서 기존 보호 검사 설명이 과하다고 지적했다. 실제 코드의 check 위치·무조건 close, profile 경로 metadata 비교와 StateStore.read의 기존 소유권 검사로 범위를 좁혔다. 새 검사를 추가하지 않으며 공개 동작·권한·파일 소유자는 유지한다. 소스 2개·보호 195개·증거 6개와 신규 3개 부재를 확인한 새 계획 리뷰를 재사용한다. |
| Baseline-1 | None | 검증 완료 | 운영 소스를 그대로 두고 관련 73/73, Node 24.21.0 build/typecheck·관련 lint·format/diff를 통과했다. 19개 옵션·가드 8조건·실제 bin 오류 5조건과 기존 제거 검사를 확인했다. 총괄이 비소유 tracked 198개·전후 snapshot 114개·증거/맥락 14개·동일 오류 클래스와 현재 검사·지침 hash를 대조했다. 최초 실패나 보정은 없으며 Step2 완료를 뜻하지 않는다. |
| Browser dependency | None | 검증 범위 보정 | 총괄이 DeviceFixture.cli의 bin 실행과 workflow의 기기 등록 호출을 추가 확인했다. 코드가 바뀌는 두 화면의 12개 결과를 재사용하지 않고 새 빌드에서 다시 실행한다. 운영 변경 범위와 권한·명령은 유지한다. |
| Extraction-1 | None | 검증 완료 | 두 내부 모듈과 원래 main 연결을 완료했다. 같은 관련 73개를 포함한 전체 connector 272/272, 타입·lint·통합 컴파일·format 검사를 통과했다. 옵션·제거·main·bin·고정 검사 입력과 기대값의 보존 비교 9개를 확인했다. 총괄이 소스/입력 202개·전후 snapshot 122개·원래 기준 증거 2,545개·실제 CLI 빌드와 snapshot 6개를 대조했다. 새 HTTP 17개·브라우저 12개와 독립 구현 리뷰는 아직 남았다. |
| Implementation-1 | None | PASS | 새 독립 구현 리뷰 C0/H0/M0/L0/INFO0이다. 실제 옵션·guard/transaction/검증 뒤 제거·파일 검사·오류/정리·type-only import·bin과 고정 검사 입력 보존을 확인했다. 소스 5개·보호 195개·개인 지침 2개·증거 43개·빌드와 snapshot 각 6개를 대조했고 같은 전후 snapshot 122개·기준 증거 2,545개 검토를 재사용했다. 전체 connector 272/272·관련 73/73·타입·lint·통합 컴파일·root format/format:check/diff, 새 소유 HTTP 6/6+11/11·device 4/4·workflow 8/8을 확인했다. 웹 unit 120/120·Auth 4/4·웹 빌드만 입력 66개·fixture/config 27개·served artifact 113개의 hash 일치 범위에서 재사용했다. 기존 lint 경고 1개와 실제 AI·두 PC 미검증은 유지한다. |
| Lifecycle-1 | None | 종료 완료 | 소스는 `f8ffac50da6e9ef4189e28edc4830cabf13b4d22`의 운영 3개·검사 2개 별도 커밋이다. 관련 아키텍처와 진행 정본을 갱신하고 명세를 보관했다. 같은 소유 CLI의 종료 상태와 창 닫기를 확인했으며 사용자 창은 변경하지 않았다. 종료 요청은 이미 종료된 창으로 보고됐고 Orca의 종료 원인은 미확인으로 보존했다. 기본 브랜치 push·병합은 하지 않았다. |
