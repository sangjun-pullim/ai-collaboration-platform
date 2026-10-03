---
status: active
date: 2026-10-03
risk-surface: permission
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 활성 명세는 검증한 단계만 완료로 표시하고 보관 뒤에는 동결한다.

# 조사 화면의 HTTP 처리와 직접 요청 정책 분리

## Context

조사 화면은 680줄이며 HTTP 응답 읽기와 사용자별 미확정 요청 복원까지 한 파일에 있다. [화면 아키텍처](../FRONTEND-ARCHITECTURE.md)의 조사 상태 소유자를 유지하면서, 화면 상태 없이 동작하는 두 책임을 feature 내부 모듈로 옮긴다. 사용자 요청에 따른 유지보수 정리이며 제품 기능이나 권한을 추가하지 않는다.

HTTP 응답은 최대 262,144바이트이고 서버의 공통 요청 읽기는 16KiB다. 두 처리의 상한·실행 환경·오류 정책이 다르므로 이번 변경은 브라우저 응답 책임에 한정한다. 함수 하나의 인터페이스 뒤에서 요청 검증·fetch·응답 읽기·오류 처리를 수행한다. 직접 요청 정책은 저장 키·복원·본문 생성만 소유한다.

조회·요청 전송·미확정 요청의 저장/삭제·대상 선택·React 상태는 현재 화면이 계속 소유한다. hook, storage manager, 일반 browser client나 새 설정 계층을 만들지 않는다. 진행 상태는 [개발·검증 정본](../delivery-and-validation.md#현재-진행-상태)에 유지한다. 실제 Claude 호환성과 두 PC 검증은 별도 조건이며 이 정리의 통과로 대신하지 않는다.

## Affected Files

1. `src/features/investigation-coordinator/investigation-view.tsx` — 현재 35–85의 `call`, 87–149의 직접 요청 타입·정책을 새 모듈에서 가져온다. Props, user·room 재생성 key, 조회/요청 effect와 JSX는 유지한다.
2. `src/features/investigation-coordinator/investigation-client.ts` — 신규. `(HumanAction, Body, AbortSignal) => Promise<unknown>` 함수 하나로 현재 HTTP 정책을 옮긴다. 타입을 보장하는 새 generic 계약을 만들지 않는다.
3. `src/features/investigation-coordinator/direct-intents.ts` — 신규. `DirectIntent`, `directIntentKey`, `restoreDirectIntent`, `mutationBody`를 옮긴다. 저장/삭제 실행과 상태 변경은 화면에 남긴다.
4. `tests/unit/human-direct-intents.test.ts` — 화면 VM의 import 허용 목록에 실제 새 모듈을 연결한다. 원래 화면의 복원 effect 검사와 사용자 격리를 유지하고 본문 생성·재시도·storage 실패를 검증한다.
5. `tests/unit/investigation-client.test.ts` — 신규. 원래 private 함수와 분리한 실제 함수에 같은 입력·기대값으로 HTTP 경계·오류·취소·정리를 검사한다.

운영 코드 3개와 검사 코드 2개다. 계약·routes·DB·SQL·connector·공급자·fixture·실행 설정·개인 설정은 변경하지 않는다. 총괄이 해당 아키텍처 절과 진행 정본 및 이 명세의 수명주기를 관리한다.

## Affected Dependents

- `src/app/app/rooms/[roomId]/page.tsx` — 유일한 운영 `InvestigationView` 소비자다. 기존 props와 user·room key를 유지한다.
- `investigation-view.tsx`의 조회와 `mutate` — HTTP 함수의 두 호출자다. 응답 해석·권한 차단·미확정 요청 유지 및 취소/종료 정리 순서를 유지한다.
- `investigation-view.tsx`의 최초 effect·persist/clear·재시도 버튼 — 사용자별 저장 키와 정확한 action/body를 공유한다. 자동 저장·삭제 주체를 추가하지 않는다.
- `src/features/investigation-coordinator/contracts.ts` — 동일 `WorkflowError` 클래스, `validateBody`, `projectEnvelope`, Body/HumanAction을 사용한다. `instanceof`와 상태별 오류 계약을 유지한다.
- `tests/unit/workflow-contracts.test.ts`, `human-direct-contracts.test.ts` 및 원래 JSON fixture — 응답 해석과 두 계약 mirror의 동일성은 계속 검사한다. fixture 원문을 바꾸지 않는다.
- `tests/e2e/investigation-coordinator.spec.ts` — 조사 이력·observer·pause/resume, 직접 질문 재시도/reload/cancel, 계정 전환의 화면 흐름이 유지돼야 한다.
- `src/lib/http/read-json-body.ts` — 서버 요청 책임은 독립적이다. 이번 브라우저 모듈의 내부 reader로 사용하지 않는다.

## Implementation Steps

### [ ] Step 1: 현재 HTTP와 직접 요청의 동작 기준 고정
**File**: 신규 HTTP 검사, 기존 직접 요청 검사

- 현재 소스·보호 입력·검사 fixture의 hash와 Git 기준점을 고정한다. 기존 세 직접 요청 검사를 그대로 통과시킨다.
- HTTP의 현재 private `call`을 테스트 VM 안에서만 노출한다. 기존 `transpileModule`/VM 관례와 실제 계약·동일 `WorkflowError`를 사용한다. 본문·상태·오류·정리 검사를 현재 함수에서 통과시켜 로그와 입력을 보존한다.
- 원래 private 직접 요청 정책도 같은 방식으로 검사할 수 있다. UUID 생성, 같은 재시도 body 재사용, actor·room 검증, 저장 실패 시 복원 거절의 현재 결과를 고정한다.
- 순수 책임 이동이므로 의도적인 RED를 만들지 않는다. 실패가 발견되면 원래 입력·실패를 보존하고 변경 범위와의 관계를 총괄에게 보고한다.
- 임의의 Response 스트림은 fetch 취소와 자동으로 연결되지 않는다. 취소 검사는 mock fetch와 합성 signal을 실제로 연결한다. 10초 값은 격리한 timer 또는 signal 관찰로 확인하고 임의의 새 retry를 만들지 않는다.

### [ ] Step 2: 두 책임 이동과 실제 모듈 검사
**File**: 운영 코드 3개, 관련 검사 2개

- `call`의 요청 검증은 try/fetch 앞에 둔다. POST JSON·no-store·redirect error, caller signal과 10초 timeout의 합성, JSON content type, body 부재 거절, 실제 스트림 바이트 상한을 유지한다.
- 최대 262,144바이트는 허용하고 초과할 때만 cancel한다. reader lock 해제, cancel/read/release 실패의 기존 오류 우선순위, 엄격한 UTF-8·기존 BOM 처리, JSON/상태/응답 해석을 유지한다.
- caller가 중단한 경우와 동일 `WorkflowError`는 원래 오류를 전달하고 다른 실패는 UNAVAILABLE로 변환한다. 새 cancel·재시도·캐시·typed DTO를 추가하지 않는다.
- 직접 요청 키는 user와 room을 계속 포함한다. legacy room 전용 키를 먼저 제거하고 현재 actor·room의 정확한 ask/cancel만 복원한다. 잘못된 저장값·storage 실패는 기존처럼 복원을 거절하고 다른 사용자의 namespace를 변경하지 않는다.
- `mutationBody`는 ask/cancel뿐 아니라 모든 현재 action을 처리한다. 원래 UUID 생성·fields spread·직접 요청 actor 덮어쓰기·retryBody 우선·검증과 오류 순서를 유지한다. 재시도에서는 UUID와 본문을 새로 만들지 않는다.
- 화면의 요청 전 저장과 확정/거절 뒤 삭제, UNAVAILABLE 뒤 유지, polling abort, unmount, 단일 pending, epoch 대상 선택, 이력 병합과 JSX를 그대로 둔다. HTTP import 이름을 조정하더라도 화면 실행 부분의 의미를 바꾸지 않는다.
- 최종 HTTP 검사는 새 실제 모듈을 사용한다. 원래 함수 복사본이나 이전 파일에 대한 fallback을 제품/영구 검사에 남기지 않는다. 화면 복원 VM에도 실제 직접 요청 모듈을 연결하며 권한 정책을 mock으로 대체하지 않는다.
- Step 1과 같은 입력·기대값 및 기존 root unit을 실행하고 전후 함수 의미·화면 호출 연결을 총괄이 확인한다.

### [ ] Step 3: 브라우저·독립 리뷰·문서 종료
**File**: 관련 검사, 화면 아키텍처·진행 정본·이 명세

- 새 웹 빌드와 타입·lint·root unit·format/diff 검사를 완료한다. 변경 없는 connector의 015 전체 210개 결과는 기준 소스·검사·설정 hash를 총괄이 대조한 범위에서만 재사용한다.
- 소유 로컬 stack과 공개 제품 환경으로 Auth/device 각 4건과 workflow 전체 8건의 desktop/mobile 검사를 직렬 실행한다. workflow의 계정 전환 검사를 생략하는 `--direct-browser-only`를 사용하지 않는다. 관리자 fixture 값은 부모 검사에만 전달한다.
- 실제 provider 입력·remote·DB reset·migration·외부 발송은 0이다. 새 빌드의 실제 입력과 결과를 기록한다. 기존 가짜 실행기/한 PC/두 PC를 구분한다.
- 새 독립 reviewer가 이동한 오류·권한·보관 정책, 단일 화면 소유자, 실제 모듈 검사·취소 연결·정리 및 제출 증거를 확인한다. 차단 지적은 같은 구현 CLI에서 보정하고 영향받은 검사를 다시 실행한다.
- 화면 책임과 import 연결을 문서에 반영한다. 진행 수치는 정본에만 갱신한다. 완료한 Step을 즉시 표시하고 모두 완료·리뷰 통과 뒤 명세를 보관한다. 논리 단위 커밋과 CLI 종료/정리를 총괄이 수행한다.

## Tests

1. `should validate the investigation body before fetching` — 잘못된 body는 실제 검증 오류를 유지하며 fetch 0회다. 정상 요청은 원래 URL·POST 옵션·본문·합성 signal을 사용한다.
2. `should project bounded investigation responses` — 기존 실제 계약 fixture의 정상 응답, 정확한 262,144바이트 경계, 나눈 UTF-8 문자와 원래 BOM 처리를 확인한다.
3. `should reject unavailable investigation responses without retrying` — JSON 아닌 content type·본문 부재·잘못된 UTF-8/JSON·상태/envelope 불일치를 기존 오류로 거절하며 자동 재요청을 하지 않는다.
4. `should cancel oversized responses and release reader locks` — 바이트 초과, read/cancel/release 실패 및 오류가 겹칠 때의 원래 결과·cancel/해제 호출을 확인한다. 성공에서도 lock을 해제한다.
5. `should preserve caller cancellation and workflow error identity` — caller abort·10초 합성 timeout·일반 fetch 실패·동일 WorkflowError를 구분한다. 연결한 mock fetch/stream의 취소 정리를 검증한다. 합성 검사를 실제 네트워크 취소 증거로 확대하지 않는다.
6. 기존 직접 요청 세 검사 — 사용자별 격리·legacy 삭제·정확한 복원/거절·actor 계약을 유지한다. 화면의 실제 복원 effect와 새 실제 모듈 연결을 계속 실행한다.
7. `should retain exact direct mutation identity on retry` — 새 요청의 UUID/actor, 일반 mutation, 정확한 재시도 body·UUID 유지와 actor/room 거절을 확인한다.
8. `should refuse restoration when storage fails` — legacy 제거·get·잘못된 값 제거 실패에서도 복원을 승인하지 않으며 다른 사용자 키를 지우지 않는다.

검사 이름은 기존 형식에 맞게 나눌 수 있으나 위 동작을 빠뜨리지 않는다. 소스 문자열이나 private 함수 존재만으로 통과시키지 않는다. 새 fixture·네트워크 자원·실제 모델을 만들지 않는다.

## Risks

- 오류 변환이나 정리 우선순위 변경은 미확정 요청 유지·권한 차단을 바꾼다. 같은 실제 계약 클래스로 전후 검사하고 기존 분기 순서를 유지한다.
- retry body를 재생성하면 같은 요청의 재전달 보장을 깨뜨린다. 본문·UUID와 storage 실행 순서를 검사한다.
- 별도 hook/상태 소유자가 생기면 조회와 요청 전송이 겹친다. 두 새 모듈은 상태 없는 함수만 제공하며 화면 effect와 refs를 이동하지 않는다.
- VM 비교만으로 browser fetch·React lifecycle을 확정할 수 없다. 새 실제 빌드의 전체 workflow·계정 전환 검사로 화면 연결을 확인한다.
- 과거 실패·미확인 provider 상태를 후속 통과로 해소했다고 표시하지 않는다. 이전 증거와 명시적 실제 입력 상한을 유지한다.

## Verification

- Node 24 `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` 및 통합 TypeScript 컴파일.
- `npm run format`, `npm run format:check`, `git diff --check`; 신규 모듈과 보호 입력·두 계약 mirror hash 확인.
- 소유 stack의 Auth 4/4·device 4/4·workflow 전체 8/8 브라우저. 새 웹 빌드·사용한 설정·실제 실행 로그를 고정한다.
- 변경 없는 connector 210/210과 server/runtime의 독립 리뷰는 동일 입력 범위에서만 재사용한다. root unit과 화면 브라우저 결과는 새로 실행한다.
- 독립 계획·구현 리뷰, 문서 링크 검사, 관련 아키텍처·진행 정본·명세 완료와 보관.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| PLAN-1 | None | 통과 | 새 독립 reviewer가 기준 HEAD·명세·planner·현재 코드·역참조·검사를 대조해 C0/H0/M0/L0를 보고했다. 전후 동일 기대값, 실제 모듈·취소 연결, 새 빌드의 workflow 8건(계정/cookie 전환 포함)·Auth/device 각 4건과 독립 구현 리뷰를 확인했다. connector 210개 재사용은 총괄이 소스 입력 38개·빌드 27개·원래 TAP hash와 정확한 210/210을 별도로 대조했다. 구현 완료 근거는 아직 없다. |
