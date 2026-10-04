---
status: done
date: 2026-10-03
risk-surface: permission
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 이전 완료 명세와 실패·실행 증거는 유지한다.

# 선택 파일 크기에 따른 도구 저장 예약

## Context

[보관 검증 재사용](014-scoped-archive-validation.md)의 실제 직접 질문 검사에서 작은 파일 읽기가 UNKNOWN/RUNTIME_CAPACITY로 중단됐다. 선택 파일은 38바이트지만 최대 파일 예약 397,312바이트를 적용한다. 처리 중인 lease 응답·snapshot 예약 131,072바이트, 종결 예약 1,572,864바이트, 기록 5,863바이트를 합치면 2MiB를 9,959바이트 초과한다. 고정한 이전/현재 Archive·Store 모두 같은 실패를 재현했다. lease는 실행 권한 기한을 갱신하는 요청이다.

이 변경은 이미 확인한 선택 파일의 크기로 최악의 JSON 저장 비용을 계산한다. 읽기 권한을 추가하지 않으며 전체 용량·종결 보존 예약·응답 내구 규칙을 유지한다. 38바이트의 예약은 `6 * 38 + 4096 = 4324`다. 같은 조건의 합계는 1,714,123바이트다. 진행·실패 기록은 [개발·검증 정본](../../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## Affected Files

1. `packages/local-connector/src/workflow-runner.ts` — 1524–1533의 파일 도구 예약 산정을 private 책임으로 분리한다. 유효한 선택 파일 snapshot을 이용하며 공개 WorkflowRunner 인터페이스는 늘리지 않는다.
2. `packages/local-connector/tests/workflow-file-capacity.test.ts` — 신규 파일에 이번 예약 책임의 검사를 모은다. 기존 fixture의 응답 보류와 실제 파일로 작은 파일·lease 동시 예약과 크기·encoding·fallback 경계를 확인한다. 기존 큰 workflow-runner.test.ts는 유지한다.

Store·Archive·FilePolicy·계약·CLI·웹·실험009·SQL·기존 합성 파일을 변경하지 않는다. 관련 현재 아키텍처와 단계 표시는 총괄이 검증 뒤 갱신한다. 앞선 014 보관 코드와 공개 오류 리뷰의 동일 해시 범위는 재사용한다.

## Affected Dependents

- 같은 파일의 private `tool()` 1482–1511 — callback identity·중복 Promise/영속 결과 재사용·다른 payload 거절 순서를 유지한다.
- 기존 `runner-fixture.ts`의 `runnerFixture`·`deferred`·`settleRunnerJobs`와 workflow-runner.test.ts의 최대 파일·lease 내구 검사 — fixture와 공개 export를 늘리지 않고 가져온다. 작은 callback builder는 새 검사 모듈 내부에 둔다.
- `RuntimeFilePolicy.read()` 202–209 및 `assertUnchanged()` — 인증·선택 경로·파일 identity·엄격한 UTF-8·변조·비밀정보 검증은 그대로 실제 읽기를 승인한다. 예상 바이트 계산이 검증을 대체하지 않는다.
- `RuntimeStore.assertRuntimeCapacity()` 976–997 — 2MiB·1,024 operations·종결 예약 1,536KiB와 기존 admission 예약은 그대로다. 처리 중인 응답·snapshot 예약의 해제는 영속 저장 증거에 따른다.
- `CodexAdapter`의 `AttemptAuthority.tool()` callback 및 CLI의 WorkflowRunner 호출 — ORIGIN/PEER/CONTINUATION의 정상 선택 파일 읽기 모두 같은 private 경로를 사용한다. 실제 모델 입력은 추가하지 않는다.
- `tests/integration/human-direct-questions.test.ts` 320–399 — 선택 응답자 한 번 실행, 재귀 질문 거절, 응답 유실 후 동일 결과 전송, 자동 이어가기 금지 조건을 유지한다. 원래 fixture와 기대값을 바꾸지 않는다.

## Implementation Steps

### [x] Step 1: 처리 중인 lease와 작은 파일의 실패 재현
**File**: `workflow-file-capacity.test.ts`

- 기존 `runnerFixture`·`deferred`·`executeHook`·`faults.after`를 사용한다. 실제 lease 응답을 반환하기 전에 보류해 131,072바이트 예약이 유지되는 시점을 고정한다.
- provider 실행이 시작된 뒤 선택 파일 읽기를 요청한다. 호출 전후 해당 lease가 보류 상태임을 검증하고, 읽기 성공과 정상 종결·업로드를 기대하는 RED를 현재 코드에서 보존한다. timer 확률이나 private 메서드의 존재만 검사하지 않는다.
- 보류는 finally에서 풀고 실행 Promise를 기다린 다음 소유 fixture를 삭제한다. 기존 64KiB/용량 fixture를 줄이지 않는다.

### [x] Step 2: 선택 snapshot 기반의 최악 비용
**File**: `workflow-runner.ts`, 관련 테스트

- 파일 읽기 도구이고 인자가 정확히 `path` 한 필드이며 문자열 경로가 선택 snapshot의 `path`와 정확히 일치할 때만 해당 `size`를 사용한다. 정상 크기는 정수 0…65,536이며 빈 파일도 포함한다.
- 예약은 `6 * size + 4096`이다. 엄격한 UTF-8을 통과한 문자열의 코드 단위 수는 파일 바이트 수를 넘지 않고 JSON 문자는 최대 6배로 escape된다. metadata 여유는 현재 단일 결과·최대 callId·hash·배열 구분자의 최악 비용을 포함한다. 최대 파일에서는 기존 397,312바이트 예약을 유지한다.
- 잘못된 인자 형식·미선택/별칭 경로·비정상 snapshot 크기는 기존 최대 파일 예약을 유지한다. `ask_peer`의 8,192바이트 예약과 추가 operation 계산은 유지한다. 인자·인증 검증을 예약 앞으로 옮겨 오류 우선순위를 바꾸지 않는다.
- 기존 callback 중복 처리 뒤, 실제 읽기와 결과 반환 전에 예약한다. 실제 `credential`·`assertUnchanged`·`policy.read`와 모든 guard·결과 저장·finally 해제를 유지한다. 파일이 커지거나 바뀌면 원래 검증이 거절한다.
- 새 영속 cache·필드·직렬화·잠금·전역 상한·재시도·모델 입력을 추가하지 않는다.
- 예약 충분성은 실제 `authority.tool`·보류한 lease 응답·도구 기록의 실제 디스크 증가량으로 확인한다. Store는 비정상 snapshot 크기를 시작 전에 거절하므로, 방어 fallback 검사는 정상 ACK 뒤 테스트 내부에서 현재 record의 size를 제한적으로 주입·복원해 새 경로에 도달시킨다. 잘못된 값을 파일에 저장하지 않는다.

### [x] Step 3: 회귀·실제 연결·독립 리뷰
**File**: 관련 검사, 현재 아키텍처와 진행 정본

- connector 전체 검사와 필수 타입·lint·build·통합 컴파일·format/diff를 실행한다. 실패 원인을 가리기 위해 기대값이나 기존 fixture를 바꾸지 않는다.
- 같은 소유 stack·기존 웹 빌드로 실제 Auth/DB/HTTP와 가짜 provider의 실행기 6개·직접 질문 11개를 직렬 확인한다. 제품 서버에는 공개 환경만, 관리자 fixture 값은 부모 검사에만 전달한다. DB reset·migration·remote·실제 모델 입력은 0이다.
- 새 독립 reviewer가 예약 충분성·fallback·권한/오류 순서·중복·정리·회귀 실효성을 확인한다. 동일 해시인 014 코드 리뷰와 웹 검사만 재사용하며 남아 있던 직접 질문 검사는 새로 완료한다.
- 관련 docs와 완료 표시를 갱신하고 015 및 014의 남은 검증 단계를 완료한 뒤 각각 보관한다. 첫 interrupt 단위 검사 실패의 원인은 별도 미확인 기록으로 유지하며 이번 용량 보정의 원인과 섞지 않는다.

## Tests

1. `should read a small selected file while a lease response remains in flight` — 실제 작은 파일과 보류한 lease 예약이 겹쳐도 정상 읽기·종결·업로드를 완료한다. 현재 코드의 RUNTIME_CAPACITY를 먼저 확인한다.
2. `should reserve selected file bytes across encoding and size boundaries` — 빈 파일·다중 바이트 UTF-8·JSON escape 문자·65,536바이트에서 실제 저장 증가가 계산한 예약에 들어간다. 최악 callId metadata도 확인한다.
3. `should preserve conservative reservations for invalid file calls` — 인자 추가 필드·미선택/별칭 경로·비정상 크기는 기존 최대 예약과 오류 우선순위를 유지한다. 공개 콜백 경로와 기존 거절 조건을 검사한다.
4. `should retain file drift and duplicate callback checks with sized reservations` — 선택 뒤 실제 파일 변경을 거절한다. 파일 읽기의 동일 callId/payload는 추가 기록·읽기 없이 같은 결과를 반환하고 다른 payload는 거절한다. 기존 ask_peer 중복 검사도 유지한다.

기존 최대 파일 반복 읽기의 공간 소진, 최대 종결 보존, lease 응답·snapshot의 저장 전후 장애와 예약 해제, 원문 보관·복구·UNKNOWN 보존 검사를 유지한다.

## Risks

- 너무 작은 예약은 성공 응답 뒤 기록 저장을 실패시킨다. 파일 바이트의 6배·최악 metadata·최대 파일 동등성을 검사하고 실제 저장 guard를 유지한다.
- snapshot 예상 비용을 읽기 승인으로 오용할 수 있다. 경로/파일/인증 검증을 기존 위치에서 수행하고 변경된 파일을 거절하는 검사로 확인한다.
- 미선택 입력을 먼저 거절하면 오류 우선순위가 달라진다. 할인 조건 밖은 기존 최대값을 사용하고 실제 검증 순서를 유지한다.
- 두 작업의 겹침을 고정하지 않으면 회귀가 잘못 통과한다. 기존 HTTP 응답 보류로 저장 예약이 유지된 상태를 검증한다.

## Verification

- Node 24 `npm --prefix packages/local-connector test`, `run typecheck`, `run build`; root `npm run typecheck`, `npm run lint`, 통합 TypeScript 컴파일.
- `npm run format`, `npm run format:check`, `git diff --check`.
- 소유 로컬 `owned-codex-workflow`·`human-direct-questions` 통합 전체. 변경 없는 웹 unit 55개·웹 빌드·브라우저와 014 성능 결과는 코드·입력이 같은 범위에서만 재사용한다.
- 두 계약 mirror·SQL001–008·009 source/dist·개인 설정·원래 실행 증거는 유지한다. 신규 native 입력과 외부 전송은 없다.
- 독립 계획·구현 리뷰와 문서 링크 검사. 기존 실패 기록은 덮어쓰지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| PLAN-1 | None | 통과 | 새 독립 reviewer가 HEAD·계획·planner·소스 8개·증거 4개를 대조했고 C0/H0/M0/L0를 보고했다. 기존 최대 파일·lease 내구 검사와 014의 동일 해시 코드 리뷰만 재사용한다. |
| Plan observation: 검사 모듈과 도달 조건 | None | ACCEPTED | 큰 기존 검사 파일에 추가하는 대신 새 책임별 검사 모듈을 사용한다. 실제 callback·디스크 증가·보류 lease를 검증하고 비정상 size는 정상 ACK 뒤 격리 주입·복원한다. 중복 파일 읽기는 새로 검사하며 보류·실행 정리를 완료한다. 운영 코드·동작 범위는 동일하다. |
| Implementation-1 | None | 통과 | 새 독립 reviewer의 코드·검사 수용은 C0/H0/M0/L0다. 실제 callback과 디스크 증가·보류 lease·metadata·fallback·중복·drift·정리를 확인했다. 동일 해시인 014 코드 리뷰만 재사용하며 새 통합과 성능·첫 실패 한계는 추가 검토했다. |
| Validation and closure | None | 완료 | RED RUNTIME_CAPACITY→GREEN UPLOADED, 관련 8/8·기본 동시성 전체 210/210과 필수 검사, 실제 소유 Auth/DB/HTTP·가짜 provider 실행기 6/6·직접 질문 11/11을 통과했다. 원래 실패·증거·개인 설정·입력 상한을 보존하고 문서·커밋·보관을 마쳤다. 실제 provider·remote·reset·migration은 0이며 두 PC 완료를 뜻하지 않는다. |
