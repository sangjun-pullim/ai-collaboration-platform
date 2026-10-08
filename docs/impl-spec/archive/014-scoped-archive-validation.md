---
status: done
date: 2026-10-03
risk-surface: permission
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 완료 문서·SQL·원래 실행 증거는 유지한다.

# 한 저장 안의 보관 파일 검증 재사용

## Context

사용자가 성능과 책임 분리를 포함한 유지보수 개선을 요청했다. [HTTP 공통 읽기](013-shared-http-json-reader.md)를 완료했고, 이번 변경은 [보관·용량 명세](011-local-runtime-capacity-safety.md)의 비차단 M1을 다룬다. 현재 `RuntimeStore.write()` 1045–1049는 같은 참조의 원문을 이전·다음 기록에서 각각 읽고 해석한다. `validateChange()` 630은 두 기록의 보관 참조가 같아야 한다고 검사한다. 읽은 내용·schema는 한 저장 안에서만 재사용하며 두 기록과의 관계 검증은 각각 수행한다.

기존 planner의 archive/store·호출부 조사와 입력이 같은 코드 해시를 재사용한다. RuntimeStore의 공개 저장·잠금·복구 인터페이스, 기록 schema·상한·오류, 새 실행 입장과 완료 업로드 우선순위는 유지한다. 실제 Claude 실행의 별도 입력 상한 확인을 기다리는 동안 독립적으로 진행할 수 있다. 진행 수치는 [개발·검증 정본](../../delivery-and-validation.md#현재-진행-상태)에 둔다.

## Affected Files

1. `packages/local-connector/src/runtime-archive.ts` — 기존 안전한 읽기를 내부 보류 FD 읽기로 나눈다. FD는 열린 파일의 연결이다. 한 callback 동안만 검증 원문을 유지하는 내부 `withVerifiedContents`를 추가한다. 경로·파일 메타데이터와 정리는 이 모듈 안에서 관리한다.
2. `packages/local-connector/src/runtime-store.ts` — 보관 원문의 JSON/schema 해석과 현재 기록의 참조·scope·epoch·완료 요청 관계 검증을 private 책임으로 분리한다. 일반 `write()`에서만 같은 원문과 해석 결과를 재사용한다.
3. `packages/local-connector/tests/runtime-archive.test.ts`, `runtime-store.test.ts` — 기존 fixture·FileHandle 검사 방식을 사용해 실제 읽기 바이트, 교체·변경 거절, resource 정리와 저장 간 재검증을 확인한다.

package·계약·runner·CLI·웹·실험009·SQL·보관 문서는 편집하지 않는다. 관련 현재 아키텍처와 진행 정본은 총괄이 검증 뒤 갱신한다.

## Affected Dependents

- `workflow-runner.ts` — 변이 큐의 `store.write()`와 monitor 저장·재시작 복구가 원래 검증·오류를 유지해야 한다. 예약 credit과 TERMINAL 우선 복구는 변경하지 않는다.
- `runtime-file-policy.ts`, `cli.ts`, runtime fixture — binding/session 잠금과 제거 보호의 Store 공개 인터페이스는 유지한다.
- Store `read()`, `compact()`, `lastAttempt()`와 Archive `read()`, `verify()`, `save()` — 원래 안전한 결과와 오류를 유지한다. 공유 내부 읽기 변경이 이 경로에 영향을 주므로 기존 전체 검사를 수행한다. 저장을 넘는 cache는 없다.
- root `tests/integration/owned-codex-workflow.test.ts`, `human-direct-questions.test.ts` — 실제 로컬 Auth/DB/HTTP와 가짜 provider의 실행·업로드·미확인 복구 경로를 재검증한다. 실제 모델 입력은 없다.

## Implementation Steps

### [x] Step 1: 중복 읽기의 검사 기준점
**File**: 관련 두 test 파일과 private 기준점

- 소유 fixture의 완료 요청을 보관한 뒤 일반 write를 실행한다. 기존 FileHandle prototype 검사 방식으로 보관 파일 inode의 실제 읽기 바이트를 합산한다. 현재 두 원문 읽기를 확인하고, 한 번 읽기를 기대하는 검사의 RED를 보존한다.
- IO 계측은 파일 한 번당 `read()` 호출 수를 고정하지 않는다. 부분 읽기와 EOF 확인은 여러 호출일 수 있으므로 실제 읽은 바이트와 소유 handle을 기준으로 삼는다. prototype mock은 finally에서 복원한다.
- 현재 Store/Archive 코드와 컴파일 산출물을 고정해 후속 성능 비교의 같은 입력 기준점으로 사용한다. 새 package·운영 로그·모델 입력·DB 작업은 없다.

### [x] Step 2: 범위가 제한된 검증과 책임 분리
**File**: `runtime-archive.ts`, `runtime-store.ts`

- 내부 보류 읽기는 기존 lstat→open(O_NOFOLLOW/O_NONBLOCK)→fstat identity→크기보다 1바이트 큰 제한 읽기→FD/path 재대조→canonical directory→엄격한 UTF-8·내용 hash 확인을 유지한다. 실패한 읽기의 handle은 그 내부에서 닫는다. 성공한 handle만 한 저장 범위의 소유 목록으로 넘긴다.
- `withVerifiedContents(references, validate, check)`는 기존 참조 64개·요청 4096개·원문 합계 128MiB와 중복 hash/요청 조건을 유지한다. callback에는 검증한 UTF-8 문자열의 readonly 목록만 전달하며 FD·Stats·변경 가능한 Buffer를 노출하지 않는다. 원래 TextDecoder의 BOM 동작을 보존한다.
- callback 전에 보류한 모든 FD/path와 directory를 재확인한다. callback은 동기 해석·관계 검증·직렬화만 수행한다. callback 뒤에도 모든 FD/path의 dev/ino/size/mtime/ctime·UID/0600/nlink1, directory 소유·0700·실제 경로를 확인한다. 이 확인이 끝난 뒤에만 준비한 주 JSON을 반환한다.
- 모든 성공·실패 경로에서 열린 handle 전체의 종료를 시도한다. 하나의 종료 오류가 나머지 handle 정리를 생략하지 않게 한다. 파일 IO의 기존 UNSAFE_STORAGE 변환과 callback/guard의 원래 오류를 구분하며 callback 전체를 포괄 catch로 변환하지 않는다. 종료 실패도 성공으로 처리하지 않으며 오류 뒤 주 파일을 교체하지 않는다. 결과를 저장이나 호출 사이에 보관하지 않는다.
- Store의 private 원문 해석은 JSON/schema를 각 파일 한 번만 검사한다. 관계 검증은 이전 기록과 다음 기록에 각각 적용한다. 이전 관계 검증→`validateChange`의 참조 불변 검사→다음 관계 검증 순서를 유지한다. refs prefix·scope/epoch·eligible request 순서·lastArchive 연결을 생략하지 않는다.
- 일반 write는 검증 결과를 받은 뒤 기존 임시 파일·fsync·rename·directory sync·check 순서를 따른다. 새로운 파일에는 기존 보관 참조를 채택하지 않는다. 큐와 스키마·상한은 그대로 유지한다.
- read/compact/lastAttempt는 기존 비재사용 경로를 유지하며 private 해석·관계 책임만 공유한다. 공개 인터페이스를 늘려 private 헬퍼를 노출하지 않는다.

### [x] Step 3: 회귀·성능·독립 리뷰와 완료
**File**: 관련 검사, 현재 아키텍처와 진행 정본

- 경로 교체·같은 inode의 내용/권한/nlink 변경·callback 오류·guard 중단·부분 batch 실패에서 거절, 주 기록 불변, 소유 handle 정리를 확인한다. 다음 write/read는 파일을 다시 검증한다.
- 기존 archive 변조·내구 순서·stale write·완료 보존과 용량/예약·TERMINAL 복구를 포함한 connector 전체 검사를 수행한다. 변경 없는 웹 unit/빌드/브라우저의 013 결과를 그 입력이 같은 범위에서 재사용한다.
- 고정한 이전/다음 코드로 동일 합성 보관 chain의 0/1/8/32/64 참조를 비교한다. 각 구간에서 read/write를 반복 측정하고 실제 바이트와 사용한 코드를 기록한다. 시간 임계값으로 단위 검사를 불안정하게 만들지 않는다.
- 기존 monitor의 2초 확인·6초 lease 갱신 설정과 측정한 저장 비용을 함께 보고한다. 이것만으로 운영 처리량·최대 원문·두 PC나 lease 만료가 해결됐다고 주장하지 않는다.
- 소유 로컬 Auth/DB/HTTP·가짜 provider 실행기 및 직접 질문 통합을 직렬 재검증한다. DB reset·migration 적용·실제 AI 입력은 하지 않는다.
- 독립 reviewer가 안전한 재사용의 기간·FD identity·이전/다음 관계·오류/정리·테스트 실효성을 검토한다. 보정은 같은 CLI 워커 세션에 전달한다. 커밋과 문서 수명주기를 마친다.

## Tests

1. `should read each referenced archive once during a validated write` — 실제 payload 바이트가 원문 합계 한 번이며 두 기록 관계는 모두 확인한다.
2. `should reject archive replacement or mutation during scoped validation` — callback 사이의 교체·수정·메타데이터 변경을 주 파일 교체 전에 거절한다.
3. `should close all owned archive handles after scoped validation failures` — 부분 batch·callback·guard·close 실패에서도 정리를 이어간다.
4. `should revalidate archive evidence between independent writes` — 첫 PASS를 다음 저장의 근거로 보관하지 않는다.
5. `should preserve previous and next archive relationships before committing a write` — 다른 참조·scope/epoch·eligible request·lastArchive의 위조와 정상 전이를 구분한다.

기존 unsafe archive의 16개 변이, 파일/directory sync와 main switch 장애, stale write·요청 재실행 차단·예약·큰 TERMINAL 재시작도 함께 유지한다.

## Risks

- 원문만 재사용하면 파일 교체·권한 변경을 놓친다. 보류 FD와 현재 경로를 callback 전후 재대조하고 다음 저장에서는 다시 읽는다.
- 한 번 읽기의 성공이 다음 기록의 관계를 증명하지 않는다. 참조 불변과 두 관계 검증을 별도로 유지한다.
- batch 실패·close 오류가 FD를 남기거나 주 JSON을 먼저 commit할 수 있다. 전체 finally 정리와 주 파일 변경 전 실패 회귀를 둔다.
- 새로운 영구 cache나 스키마 변경은 이전 상태/재실행 판정을 바꾼다. 한 write의 지역 변수만 사용하고 관련 계약·runner 변경을 제외한다.
- 큰 chain의 비용은 여전히 원문 규모에 비례한다. 정확한 IO와 같은 입력의 측정만 보고하며 성능 목표나 monitor 보장을 추정하지 않는다.

## Verification

- Node 24 `npm --prefix packages/local-connector test`, `run typecheck`, `run build`; root `npm run typecheck`, `npm run lint`, 통합 TypeScript 컴파일.
- `npm run format`, `npm run format:check`, `git diff --check`.
- 고정 전후 합성 성능 비교, 소유 stack의 `owned-codex-workflow`·`human-direct-questions` 통합 검사. fixture credential은 부모 검사에만 전달하고 제품 서버에는 전달하지 않는다.
- 두 계약 mirror·SQL001–008·009 source/dist/설정·이전 private 실행 증거를 유지한다. 실제 AI 입력과 remote/reset/migration은 0이다.
- 독립 계획·구현 리뷰와 관련 문서 링크 검사. 원래 011 성능 측정과 실패 기록은 변경하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| PLAN-1 | None | 통과 | 새 independent reviewer의 계획 검증은 C0/H0/M0/L0다. 기준 HEAD·명세·Archive/Store hash와 영향 경로·기존 검사/정리 경계를 대조했다. 변경 없는 011·012 리뷰와 planner 조사만 재사용했으며 실행 검증은 Step 3에서 수행한다. |
| Implementation H1: 공개 읽기의 오류 우선순위 | HIGH | ACCEPTED — 보정·재검토 통과 | 공개 read/verify/save의 일반 오류 변환과 guard·close 충돌 우선순위를 복원했다. 새 오류 회귀는 보정 전 8개 실패, 보정 후 17개 통과이며 공개 경로 16개는 동일 검사로 원래 구현에서도 통과했다. source2 독립 코드 리뷰는 C0/H0/M0/L0다. |
| Implementation INFO1: 보유 메모리 | INFO | 측정 한계 유지 | 검증 범위가 끝날 때까지 원문 Buffer와 문자열을 보유하고 callback에서 JSON 객체를 만든다. 최대 메모리는 측정하지 않았으며 이번 변경을 추가 메모리 최적화로 확대하지 않았다. |
| Implementation INFO2: 첫 interrupt 회귀 실패 | INFO | 원인 미확인 유지 | 첫 전체 실행 201/202의 열린 주 파일 검사 실패를 보존했다. 같은 원본·수정 코드의 파일 교체 재현은 모두 거절했고, 제한된 각 10회 검사와 후속 전체 검사는 통과했다. 이 결과로 첫 실패의 원인이나 실행 시점 영향을 확정하지 않는다. |
| Actual direct integration: 작은 파일 예약 과다 | HIGH | ACCEPTED — 015 보정·통합 통과 | 고정한 이전/현재 코드 모두 같은 예약 과다를 재현했다. [선택 파일 예약](015-file-tool-capacity.md)의 별도 최소 보정 후 원래 기대값·fixture로 실제 실행기 6/6·직접 질문 11/11을 통과했다. 전체 용량과 파일 검증은 유지한다. |
| Closure evidence review | None | 통과·한계 유지 | 015의 새 독립 reviewer가 동일 해시인 보관 코드 리뷰만 재사용하고 성능·실패 영향·새 통합을 추가 검토했다. C0/H0/M0/L0이며 최대 메모리 미측정과 첫 interrupt 원인·시점 영향 미확정 INFO 2개를 유지한다. 관련 문서·완료 표시·보관을 마쳤다. |
