---
status: active
date: 2026-10-03
risk-surface: public-api
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 완료 보관 문서와 적용된 migration은 변경하지 않는다.

# HTTP JSON 요청 읽기의 공통화

## Context

사용자가 중복 요청 처리와 유지보수 문제를 지적했다. 코드 형식 정리는 [완료 명세](archive/012-readable-source-formatting.md)에 보관했다. 방 접근·기기·조사의 요청 정책은 Origin·JSON type·16KiB·스트림 읽기를 각각 구현한다. 공통 읽기만 한 곳으로 모으고 도메인 검증과 기존 오류 응답은 유지한다. UTF-8 처리 통일·bearer 공통화·오류 계층 변경·폴더 일괄 이동은 이 변경에 포함하지 않는다.

사용자는 현재 문서 기준으로 계획과 구현을 자율 진행하도록 승인했다. 이 논리 변경은 기존 운영 파일 3개와 신규 내부 모듈 1개이며, 공개 HTTP 입력의 위험 표면에 대한 검사와 독립 리뷰를 수행한다. 진행 상태는 [개발·검증 순서](../delivery-and-validation.md#현재-진행-상태)에 유지한다.

## Affected Files

1. 신규 `src/lib/http/read-json-body.ts` — Request의 JSON 본문 읽기. 기대 Origin(선택), 기존 오류 생성 함수, UTF-8 방식만 입력받고 `unknown`을 반환한다. 상한과 content type은 내부 고정값이다.
2. `src/features/room-access/request-policy.ts` — 17–57의 공통 읽기를 대체하고 action별 필드·trim·UUID·email 검증은 유지한다.
3. `src/features/device-binding/request-policy.ts` — 4–41의 공통 읽기를 대체하고 `validateBody`·`bearer`는 유지한다.
4. `src/features/investigation-coordinator/request-policy.ts` — 4–37의 공통 읽기를 대체하고 `validateBody`·`workflowBearer`는 유지한다.
5. 신규 `tests/unit/http-json-body.test.ts`, `tests/unit/http-request-policy.test.ts` — 공통 모듈 동작과 세 기존 wrapper의 입력·오류 보존을 검증한다. 기존 러너를 사용한다.

## Affected Dependents

- `src/app/api/auth/[action]/route.ts`, `src/app/api/access/[action]/route.ts` — `readMutation`의 signature·검증 순서·AccessError를 유지한다.
- `src/app/api/connections/[action]/route.ts`, `src/app/api/connector/[action]/route.ts` — `readConnection`·`bearer`와 사람/기기 Origin 조건·ConnectionError를 유지한다.
- `src/app/api/investigations/[action]/route.ts`, `src/app/api/workflow/[action]/route.ts` — `readWorkflow`·`workflowBearer`와 WorkflowError를 유지한다.
- `src/lib/supabase/server.ts`, 기기/조사 `service.ts` — JSON/크기/Origin 오류는 기존 클래스, 스트림 오류는 원래 예외가 전달되어 기존 UNAVAILABLE 응답이 유지된다.
- 기존 contracts·SQL001–008·connector·웹 화면/intent — 공개 계약·인증·DB·저장소 실행 동작은 바꾸지 않는다.

## Implementation Steps

### [ ] Step 1: 기존 요청 정책의 검사 기준점
**File**: `tests/unit/http-request-policy.test.ts`

- 실제 기존 wrapper를 기존 TypeScript 격리 harness 방식으로 실행한다. `server-only`·설정만 격리하고 도메인 contracts는 실제 코드를 사용한다. 테스트가 제품 코드의 조건을 복사해 구현하지 않는다.
- 사람이 보내는 Origin, 기기 Origin 생략과 설정의 지연 평가, content type·본문 없음, domain 검증과 정확한 오류 클래스, 비정상 UTF-8/BOM 차이를 현재 코드에서 확인한다.
- 현재 소스의 PASS를 고정한다. 버그 수정이 아닌 공통화이며 현재 차이를 실패로 처리하거나 통일하지 않는다.

### [ ] Step 2: 공통 읽기와 wrapper 전환
**File**: 신규 공통 모듈과 세 `request-policy.ts`

- `readJsonBody(request, options)` 한 함수 뒤에 Origin·content type·reader 획득·chunk 누적·취소·lock 해제·decode·JSON parse를 모은다. options는 `expectedOrigin?: string`, 기존 오류 생성 함수, `strict`/`replacement` decode 방식이다.
- Origin은 지정했을 때만 content type보다 먼저 비교한다. room은 항상 서버 Origin, 다른 둘은 `human=true`일 때만 `serverConfig()`를 호출한다.
- 상한은 헤더 값 대신 실제 수신 바이트 16,384다. 초과하면 reader를 취소하고 기존 BODY_TOO_LARGE를 발생시킨다. finally에서 lock을 해제한다.
- `strict`는 현재 TextDecoder(fatal)의 UTF-8·BOM 동작을, `replacement`는 현재 Buffer UTF-8의 대체 문자·BOM 동작을 그대로 유지한다. 두 방식에서 chunk를 합친 뒤 decode하여 분할된 다중 바이트를 보존한다.
- decode/JSON parse만 INVALID_BODY로 바꾼다. reader read/cancel/releaseLock 오류는 포괄 catch로 변경하지 않는다.
- wrapper의 signature·export·반환값·domain validation·bearer·route 호출 순서는 유지한다. 공통 모듈은 Supabase·cookie·domain schema를 import하지 않는다.

### [ ] Step 3: 검증·리뷰·완료
**File**: 해당 코드·검사와 진행 정본

- 신규 모듈을 통한 16,384/16,385 바이트·분할 chunk·UTF-8·BOM·malformed JSON·누락 본문·스트림 오류·취소/lock 해제를 검증한다. wrapper 기준점 검사도 모두 다시 통과시킨다.
- Node 24 root unit·typecheck·lint·build·통합 컴파일·format:check를 실행한다. 변하지 않은 connector 및 모의 화면 검사는 고정 기준점의 PASS를 재사용한다.
- 소유 로컬 stack의 Auth/device/workflow 입력 제한 통합 검사와 desktop/mobile 사용자 흐름을 직렬 실행한다. 새 모델 입력·DB reset·migration 적용은 수행하지 않는다.
- 독립 reviewer가 공통 읽기의 위임과 오류·인증 조건·public 계약 보존, 테스트의 실효성을 검토한다. 지적은 같은 워커 세션에서 보정한다.
- 기존 커밋 지침을 지키며 논리 변경을 기록한다. 관련 아키텍처의 요청 읽기 책임과 진행 정본을 갱신한 후 명세를 보관한다.

## Tests

1. `should enforce optional origin before content type and body access` — 설정 생략/지연 평가와 사람 Origin 순서를 검증한다.
2. `should bound actual streamed bytes at sixteen kibibytes` — 정확한 상한·다중 chunk·거짓 content-length와 취소/lock 해제를 검증한다.
3. `should preserve strict and replacement UTF-8 policies across chunk boundaries` — 정상 다중 바이트, 잘못된 바이트, BOM의 기존 차이를 검증한다.
4. `should map only decode and JSON failures to the supplied error class` — parse 실패와 각 domain 오류 생성, 원래 read/cancel/releaseLock 오류 전파를 검증한다.
5. `should retain domain validation and bearer behavior in each request policy` — 실제 contracts의 필드/trim/크기 조건과 원래 bearer 오류를 검증한다.

## Risks

- 잘못된 UTF-8/BOM을 통일하면 기존 API 입력 계약이 바뀐다. 명시적 두 방식과 wrapper 회귀로 보존한다.
- 포괄 catch는 스트림 실패 응답을 UNAVAILABLE에서 INVALID_BODY로 바꾼다. 실패 주입으로 예외 identity와 route의 기존 변환을 확인한다.
- `serverConfig()`를 기기 요청에서 미리 호출하면 기존 bearer 경로가 달라진다. human 조건의 지연 평가를 검사한다.
- 형식 검증을 helper로 옮기면 domain 책임이 넓어진다. helper는 `unknown` JSON까지만 반환한다.

## Verification

- Node 24 `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `node node_modules/typescript/bin/tsc -p tsconfig.integration.json`.
- `npm run format`, `npm run format:check`, `git diff --check`.
- 소유 로컬 입력 제한 통합 검사는 `tests/integration/web-auth-room-access.test.ts`의 `should reject unsafe origins redirects and oversized or forged mutation bodies`, `tests/integration/device-workspace-binding.test.ts`의 `should keep connector authentication separate from browser cookies and human actions`, `tests/integration/human-direct-questions.test.ts`의 `should reject observer forged actors and invalid direct targets`를 고정 선택한다. 마지막 검사는 raw UTF-8·17,000자 요청을 실제 조사 route로 전달한다. 일반 workflow 명령이 human-direct 파일을 실행한다고 가정하지 않는다.
- Auth/device/workflow desktop/mobile 흐름을 새 웹 빌드로 확인한다. SQL·완료 문서·계약 mirror hash를 보존하며 실제 AI 입력은 0회다.
- 독립 계획·구현 리뷰와 관련 문서 링크 검사.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Independent plan round1 | INFO | PASS | 세 요청 처리기·여섯 route와 Origin/UTF-8/BOM/오류/설정 지연 조건, 고정 통합 검사 선택과 기존 검사 재사용 범위를 검토했다. 구현 완료를 판정한 기록은 아니다. |
