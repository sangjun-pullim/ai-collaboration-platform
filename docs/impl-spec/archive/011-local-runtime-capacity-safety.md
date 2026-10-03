---
status: done
date: 2026-10-03
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 로컬 실행 기록의 용량과 완료 전송 보호

## Context

중간 코드 점검에서 로컬 실행 기록의 용량 소진을 재현했다. 기존 fixture의 완료된 시도와 확정 lease를 1,022개 기록한 뒤 새 합성 실행을 시작하면 정상 종결을 저장하지만 `complete` 작업을 추가하지 못한다. 기록은 1,024개이고 서버 전송은 0회다. 복구도 `UNSAFE_STORAGE`로 막힌다. 비교 조건의 1,019개 기록은 업로드에 성공했다. 실제 모델 입력·외부 요청은 0개다.

기존 2MiB 파일·1,024개 작업·256개 시도·256개 소유 턴 한도를 단순히 늘리지 않는다. 완료 증거를 보존하며 과거 기록을 분리하고, 새 실행 전에 종결·전송 공간을 확보한다. [검증 상태](../../delivery-and-validation.md#현재-진행-상태)와 [007](007-owned-codex-workflow-runner.md)의 내구 intent·UNKNOWN·네이티브 소유권 규칙을 따른다.

운영 파일은 아래 4개다. 공개 HTTP·DB·CLI 명령은 바꾸지 않는다. 사용자의 정상 동작 구현 지시에 따른 관련 결함 보정이며, 필수 권한·증거 검증 리뷰를 수행한다. 다른 운영 파일이 필요해지면 구현 전에 범위를 다시 판단한다.

## Affected Files

1. `packages/local-connector/src/runtime-contracts.ts` — 선택적 보관 참조·마지막 상태 참조와 `RUNTIME_CAPACITY` 내부 오류.
2. `packages/local-connector/src/runtime-archive.ts` — 소유 보관 파일의 안전한 저장·읽기·해시·범위·상한 검증을 담당하는 내부 모듈.
3. `packages/local-connector/src/runtime-store.ts` — 이전 저장 형식 호환, 보관 전이, 완료 이력의 중복 실행 방지, 용량 정책.
4. `packages/local-connector/src/workflow-runner.ts` — 직렬화한 보관 시점, 실행 전 확인, 도구·lease·readiness 증가와 종결 공간의 분리.

검사 변경은 기존 `tests/runtime-store.test.ts`, `tests/workflow-runner.test.ts`와 기존 fixture에 한정한다. 새 내부 모듈의 파일 보호 검사가 필요하면 같은 러너의 `tests/runtime-archive.test.ts`를 추가한다.

## Affected Dependents

- `src/codex-adapter.ts` — 전체 네이티브 이력과 `ownedTurns`의 정확한 비교를 유지한다. 소유 턴은 보관 명목으로 제거하지 않는다.
- `src/cli.ts` — run·observe·prepare·replace·revoke-local 호출 형태와 소유 파일 제거 증명을 유지한다.
- `tests/human-direct-peer.test.ts` — PEER 실행·동일 outbox 회복·새 provider 실행 금지.
- 루트 `tests/integration/owned-codex-workflow.test.ts` — 실제 coordinator와 가짜 adapter의 업로드·관찰·복구.
- `runtime-store.ts`의 `unresolvedRuntime`, session lock, 직접 로컬 제거 경로 — UNKNOWN·TERMINAL·미확정 작업을 계속 미해결로 판단한다.

## Implementation Steps

### [x] Step 1: 원문을 보존하는 제한된 보관 형식
**File**: `src/runtime-contracts.ts`, `src/runtime-archive.ts`

- `RuntimeRecord`에 선택적 `archives` 참조를 추가한다. 기존 필드 없는 version 1 기록은 그대로 읽는다. 참조는 내용 SHA-256과 보관한 request ID 목록만 가진다. 웹·provider의 경로나 외부 파일명을 받지 않는다.
- 마지막 시도까지 보관하면 선택적 표시용 참조에 보관 hash와 attempt 식별자만 저장한다. terminal·receipt를 복제하지 않고 검증된 원문에서 읽는다. 참조가 가리키는 시도는 실제 보관한 완료 묶음에 있어야 한다.
- 한 보관 파일은 보관 직전의 검증된 주 JSON 원문이다. 파일명은 해시에서만 만든다. 파일 0600·디렉터리 0700·소유 UID·canonical parent·NOFOLLOW·단일 hardlink·2MiB·엄격한 UTF-8을 검사한다.
- 최대 보관 참조 64개, 전체 request ID 4,096개, 참조 파일 합계 128MiB를 넘기지 않는다. 한도에 도달하면 새로운 실행을 안전하게 거절한다. 한도를 초기화하거나 자동으로 새 연결·네이티브 세션을 만들지 않는다.
- 모든 참조 파일의 해시·schema·같은 서버/기기/조직/방/agent 범위와 이전 epoch 관계를 확인한다. 각 원문에 들어 있는 이전 참조는 현재 참조의 해당 이전 prefix와 같아야 한다.
- 검증 결과를 재사용한다면 소유 FD의 identity·크기·mtime/ctime·권한·nlink와 경로를 다시 확인한다. 파일이 달라지면 재검증하거나 거절한다. 캐시가 파일 보호를 생략하게 만들지 않는다.
- 이 모듈은 파일 증거 검증만 담당한다. 실행 허가나 새로운 모델 입력을 만들지 않는다.

### [x] Step 2: 완료된 request 묶음만 안전하게 분리
**File**: `src/runtime-store.ts`

- 같은 request의 모든 시도가 `UPLOADED` 또는 증명된 `NOT_STARTED`이고 적어도 하나가 `UPLOADED`인 묶음만 후보로 한다. 모든 연결 작업이 `CONFIRMED`/`CLOSED`여야 하며 준비 기록·남는 다른 시도/도구가 후보 작업을 참조하면 제외한다.
- 원래 native·terminal·receipt·claim/fence·tool receipt·작업 원문을 바꾸지 않는다. UNKNOWN·TERMINAL·미확정 question·현재 실행의 lease는 active 기록에 남긴다.
- 보관은 전용 `compact()` 경계에서 한다. 주 파일과 caller의 snapshot 일치를 확인하고, 보관 파일 생성→파일 fsync→보관 디렉터리 fsync→주 파일의 참조·active 기록 교체→디렉터리 fsync 순서로 저장한다. 새 참조 전이만 기존 삭제 금지 검사에 제한된 예외를 둔다.
- 일반 `write()`로 보관 참조를 추가·제거하거나 과거 증거를 숨길 수 없게 한다. 생존 시도·작업의 순서를 유지한다. 보관한 완료 request와 같은 request를 새 CLAIM_PENDING으로 추가하면 거절한다.
- 보관 전의 마지막 논리적 시도를 표시용 참조로 보존한다. 이후 보관이 더 오래된 active 시도만 옮기면 이 참조를 그대로 유지한다. 일반 `write()`는 참조를 새로 만들거나 바꾸지 못하며 유효한 새 CLAIM_PENDING 시도가 추가될 때만 지울 수 있다. 새 시도 이후에는 기존 active 상태 표시를 사용한다.
- crash로 주 파일 전환 전에 남은 보관 파일은 완료 근거로 채택하지 않는다. 동일한 해시 파일이 이미 있으면 정확한 원문과 안전한 identity를 확인한다. 손상·유실·다른 범위의 참조가 있으면 실행을 거절한다.
- `compact()`는 실제 저장한 새 기록을 반환한다. runner가 이전 snapshot을 다시 쓰지 않게 한다. 일반 `write/read`의 기존 호출 형태는 유지한다.
- 기존 로컬 제거는 미해결 검증을 유지하고 주 파일만 제거한다. 보관 증거를 자동 삭제하지 않는다. 보관 파일을 agent 목록이나 새 연결의 실행 맥락으로 채택하지 않는다.

### [x] Step 3: 실행 전 용량과 종결 공간 확보
**File**: `src/runtime-store.ts`, `src/workflow-runner.ts`

- 실행/관찰 복구의 잠금 아래에서 mutation과 이전 monitor를 정리한 뒤 보관한다. provider·도구·전송이 진행 중일 때 보관하지 않는다. `this.record`에는 실제 저장된 compact 결과를 넣는다.
- `run/status`의 마지막 상태·terminal·adoption은 검증된 표시용 참조 또는 더 최근 active 시도에서 구한다. 마지막 완료를 보관한 뒤 새 요청 없이 다시 실행하거나 조회해도 같은 완료 상태를 표시하고 provider를 호출하지 않는다.
- 작업 768개·시도 128개·encoded JSON 256KiB를 넘거나 다음 실행 공간이 부족할 때 보관을 시도한다. 보관할 증거가 없어도 안전한 용량 거절은 가능해야 한다.
- 새 claim/provider 전에 시도·소유 턴 한도와 claim/start 결과·ACK·종결·complete/observe·마지막 readiness/interrupt·UNKNOWN/정리 저장의 공간을 확인한다. 부족하면 provider 입력 0회로 `RUNTIME_CAPACITY`를 보고하고 readiness를 false로 유지한다. 기존 이력·예산·세션을 초기화하지 않는다.
- serialized `JSON.stringify` 크기로 확인한다. 종결 및 전송을 위한 작업 슬롯과 바이트를 별도로 남긴다. 1.5MiB 종결 공간과 1.75MiB 실행 준비 공간은 주 파일 2MiB 상한 아래에 남길 여유 바이트의 초기 보수적 기준이다. 전체 파일의 허용 임계값을 뜻하지 않는다. 현재 schema의 최악 문자열 escaping·256 final item·각 512자 ID·응답 크기 검사로 충분함을 입증한다. NUL/CR/LF 외의 제어 문자가 JSON에서 6배로 늘어나는 경우도 포함하고, 입증되지 않으면 기준을 보정한다.
- ordinary lease/readiness/question/file-tool 저장은 남겨 둔 종결 공간을 소비하지 못한다. 아직 확정되지 않은 응답과 snapshot 갱신 공간도 계산한다. 도구의 저장 공간은 callback의 성공 응답·상대 질문 전송 전에 확보한다.
- terminal·동일 outbox 업로드·receipt·UNKNOWN/종료는 예약한 공간을 사용할 수 있다. 성공하지 않은 업로드를 완료로 표시하지 않는다. 도중 한도 오류는 원래 입력을 자동 재실행하지 않는다.
- 이미 가득 찬 TERMINAL은 완료된 과거 묶음을 보관한 뒤 같은 terminal과 durable operation으로 업로드만 회복한다. 보관 가능한 과거 근거가 없는 기존 손상/한도 기록은 보존하고 안전하게 거절하며 새 provider 실행으로 우회하지 않는다.
- `ownedTurns` 256개는 그대로 유지한다. 도달 전에 새 실행을 거절한다. 새 context 준비는 기존 소유자의 명시적 prepare·epoch 전이만 사용한다.

### [x] Step 4: 회귀·실제 연결기 검사·문서와 독립 리뷰
**File**: 관련 기존 테스트, `../delivery-and-validation.md`, `../ARCHITECTURE.md`, `../ai-runtime-integration.md`

- 최초 RED와 비교 조건을 보존한다. 기존 합성 adapter·fixture를 사용해 보정 후 결과 업로드와 재시작 회복을 검사한다.
- 타입·connector 전체 합성·빌드·관련 lint와 실제 소유 Auth/DB/HTTP의 가짜 provider 실행기 검사를 수행한다. DB 검사는 다른 전역 quota 검사와 겹치지 않게 한다. 실제 AI 입력은 필요 없다.
- 완료 이력 보관, 사용자에게 보이는 용량 거절, 소유 턴 한도, 보관 파일의 수명주기와 검증 한계를 관련 문서에 반영한다. 성능 수치를 측정 없이 개선 완료로 표시하지 않는다.
- 계획 및 구현의 독립 reviewer가 네이티브 소유권·원문 불변·crash·동시 저장·새 실행 금지를 검토한다. 필수 검사와 리뷰를 통과한 뒤에만 명세를 종료한다.

## Tests

1. `should publish a completed turn near the operation bound without repeating provider execution` — 1,022개 재현과 1,019개 비교, 기존 원문·서버 receipt 보존.
2. `should recover a full legacy terminal by archiving only completed request evidence` — 재시작 업로드만 수행하고 provider 실행 0회.
3. `should preserve unresolved evidence and reject archived request reexecution` — UNKNOWN·TERMINAL·미확정 질문·새 claim/fence 위조·이전 request 재사용.
4. `should commit archive evidence before switching the active journal` — 두 fsync/주 파일 교체 경계의 실패와 정확한 재시작 상태, orphan을 승인 근거로 쓰지 않음.
5. `should reject missing changed foreign linked or oversized archive evidence` — 파일/부모 링크·hardlink·변조·범위·중복 ID·순서·합계 상한·캐시 후 교체.
6. `should refuse provider input before attempt turn or serialized capacity exhaustion` — 255/256 시도·소유 턴, 보관 참조 한도, 바이트만 부족한 상태.
7. `should reserve terminal and outbox bytes against lease readiness and tool growth` — 실제 schema 최대 escaped 문자열·finalItems, 응답·snapshot·반복 파일 읽기 증가와 동시 readiness.
8. `should keep the committed archive snapshot across late writes and shutdown` — 보관 전 snapshot 재제출, 늦은 receipt/정리, 메모리·디스크 일치.
9. `should retain archive evidence through explicit local removal without adopting it as a new agent` — 기존 lock/remove/proof/목록 의미와 보관 원문 유지.
10. `should preserve exact peer outbox recovery and native history ownership` — 기존 PEER·관찰·전체 native 이력·turn ID 재사용 검사를 재사용하거나 영향 범위를 재검증.
11. `should preserve the last public completion after idle journal compaction` — 마지막 완료 묶음과 더 오래된 잔여 묶음을 순차 보관한 뒤 새 요청 없는 run/status가 같은 상태·terminal·adoption을 반환하고 새 provider 입력은 0회. 유효한 새 claim 이후에는 새 시도의 상태를 표시.

## Risks

- 여러 파일의 동시 원자적 교체를 가정하지 않는다. 보관을 먼저 내구 저장하고 참조를 마지막에 바꾼다.
- 보관 참조가 기존 완료 증거를 숨기는 권한이 되지 않도록 실제 원문·완료 receipt·같은 범위를 검증한다.
- 저장 개수만 검사하면 큰 terminal/도구 결과의 실패가 남는다. 직렬화 바이트와 in-flight 응답 공간을 함께 검사한다.
- 보관 읽기·디스크 사용량도 상한을 가진다. 무제한 대화나 자동 새 context를 지원했다고 표시하지 않는다.

## Verification

- Node 24: `npm --prefix packages/local-connector run typecheck`, `test`, `run build`.
- 변경 connector 소스·테스트의 기존 ESLint 검사, 루트 타입 및 통합 컴파일.
- 기존 소유 로컬 stack의 `owned-codex-workflow` 검사. 실제 provider 입력 0회, 기존 DB 변경·완료 문서 불변.
- archived snapshot·주 파일·소유 child/lock 보존과 독립 리뷰, 관련 문서 링크·`git diff --check`.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Midpoint: completed result trapped by storage capacity | HIGH | ACCEPTED — REPRODUCED, CORRECTION PLANNED | 기존 fixture로 완료 저장 뒤 업로드 0회와 재시작 실패를 재현했다. 증거 보관과 실행 전/중 공간 확보를 함께 검사한다. |
| Plan round1: last uploaded status lost after compaction | HIGH | ACCEPTED — CORRECTED IN PLAN | 마지막 논리적 시도를 검증된 보관 원문의 표시용 참조로 보존한다. 새 claim만 참조를 지울 수 있으며 유휴 run/status와 오래된 잔여 묶음의 후속 보관을 회귀 검사한다. 구현 검토 전 실제 해결로 표시하지 않는다. |
| Independent plan round2 | INFO | PASS | C0/H0/M0/L0. 보관된 마지막 상태·권한 증거·crash·저장 순서·전체 네이티브 소유 턴·운영 4개 범위를 검토했다. 구현 및 실제 실행의 완료 판정은 아니다. |

| Implementation round1: receipt growth double-counted | HIGH | ACCEPTED — RESOLVED — SOURCE2 VERIFIED | receipt와 snapshot의 남은 예약을 분리한다. 실제 저장이 확인된 뒤 mutation 직렬 구간에서만 예약을 줄인다. 최대 응답·commit 전후 실패·경쟁 writer 회귀와 실제 연결 검사 및 독립 재검토를 통과했다. |
| Implementation round1: durable terminal blocked by recovered readiness | HIGH | ACCEPTED — RESOLVED — SOURCE2 VERIFIED | 재시작에서도 저장된 terminal 공간을 인정하고 exact 완료 전송을 ordinary readiness보다 먼저 회복한다. 큰 terminal·반복 readiness 응답 유실·동일 작업 ID와 원문·provider 0회 회복을 검사했고 실제 연결과 독립 재검토를 통과했다. |
| Implementation round1: identical archives revalidated twice per write | MEDIUM | ACCEPTED — MEASURED FOLLOWUP | 동일 원문을 이전·다음 기록에서 모두 읽는 비용을 확인했다. 측정과 현재 한계는 진행 정본에 기록한다. 이번 용량 보정에 캐시를 섞지 않고, 포맷 후 파일 identity·권한·해시 검증을 유지하는 내부 최적화를 별도 검증한다. |

| Independent implementation round2 | INFO | PASS — C0/H0/M1/L0 | H1/H2 해소. runner 보정과 영향받는 호출부를 추가 검토하고 동일 hash의 archive/store/contracts 검토를 재사용했다. 소유 Auth·DB·HTTP 실행기·전체 합성·타입·빌드·lint·문서 링크를 확인했다. M1은 별도 성능 보정으로 유지한다. |
