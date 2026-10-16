---
status: done
date: 2026-10-16
risk-surface: auth, public-api
---
> NOTE: 구현 계획이며 현재 동작의 증거가 아니다. 2026-10-16 사용자가 구현·검증·배포를 승인했다. 검증 결과는 완료 단계에 기록한다.

# 일반 채팅 전송 복구와 재접속 동기화

## Context

기준 커밋은 `340bfa6`이다. 일반 발언(speak)은 서버의 operationId 영수증을 이미 사용하지만 브라우저가 응답 유실 후 같은 요청을 보존하지 않는다. 사용자가 다시 전송하면 다른 operationId로 중복 저장될 수 있다. 화면 복귀·네트워크 복구도 다음 정기 조회를 기다린다.

이번 단계는 한 번에 미확정 요청 하나를 보존하는 기존 구조를 일반 발언까지 확장한다. 자동 재전송이나 여러 메시지의 전송 대기열은 만들지 않는다. 같은 탭의 새로고침·방 이동 후 복원을 지원하며, 탭 종료 뒤 본문 보관은 확대하지 않는다.

Supabase Realtime 도입은 후속 단계다. 현재 HttpOnly 로그인 쿠키를 브라우저 코드에 노출하지 않는 계약을 유지한다. 익명 private channel 지원이 검증되지 않은 연결 방식을 이번 변경에 넣지 않는다. HTTP 폴링을 WebSocket으로 바꿨다고 설명하지 않는다.

## Affected Files

1. `src/features/investigation-coordinator/direct-intents.ts` — 일반 발언의 같은 operation·본문·사용자 보존. 기존 저장 키와 직접 질문 복원 호환 유지.
2. `src/features/investigation-coordinator/room-chat-controller.ts` — 일반 발언 저장·재시도, 미확정 상태, 직렬 재동기화 요청.
3. `src/features/investigation-coordinator/use-room-chat.ts` — online·visibilitychange 구독/해제.
4. `src/features/investigation-coordinator/investigation-view.tsx` — 일반 발언의 전송 중·결과 확인 필요 표시와 같은 요청 확인, 초안 중복 전송 방지.
5. `src/features/investigation-coordinator/contracts.ts` — speak의 선택적 expectedUserId 검사. 새 UI는 반드시 포함하며 기존 호출은 호환 유지.
6. `supabase/migrations/20261016002200-human-speech-actor-precondition.sql` — 현재 speak wrapper 앞의 선택적 사용자 사전 조건 검증. 기존 영수증 본문 hash와 실제 Auth 권한 검사 유지.
7. `packages/local-connector/src/workflow-contracts.ts` — 웹과 동일한 계약 사본을 갱신한다. 로컬 실행 방식은 변경하지 않는다.

테스트는 기존 controller·intent·view·contract 단위 검사와 human-direct-questions 통합 검사에 추가한다. 이 목록 밖 운영 변경이 필요하면 원인과 영향부터 검토한다.

## Affected Dependents

- `direct-intents.ts`의 저장 기능 소비자는 controller다. 같은 파일의 retirement pin은 변경하지 않는다.
- `useRoomChat`의 소비자는 InvestigationView이며 사용자·방·역할 변경 시 이전 controller가 종료된다.
- `service.ts`와 `api/investigations/[action]/route.ts`는 speak 이름과 기존 RPC를 유지하므로 기존 전달·Origin·인증 경계를 재사용한다.
- 공개 speak wrapper는 007 migration, 실제 human_006은 019 migration이 최신이다. 적용된 migration을 편집하지 않는다. 새 wrapper는 expectedUserId 검증 후 해당 필드를 제거하고 기존 workflow_private.human('speak', body)를 호출한다.
- 일반 발언 영수증은 eventId·sequence를 반환한다. 메시지 본문 일치만으로 전송 성공을 추정하지 않는다.
- 계약 사본은 `tests/unit/human-direct-contracts.test.ts:23-26`에서 import 경로 차이 외 동일성을 검사한다. `workflow-contracts.test.ts`와 `tests/fixtures/workflow-contracts.json`의 양쪽 검증도 유지한다.
- 규칙 사본 조사 범위는 현재 docs 정본·guides·planning이다. archive·records·외부 시스템은 수정 대상이 아니다. 다음 문서의 별도 팀 소유자는 명시되어 있지 않다.
- 동일 요청 복구 규칙 3개: `docs/BUSINESS-LOGIC.md:48`, `docs/FRONTEND-ARCHITECTURE.md:110`의 동일 operation 재확인과 자동 새 질문 금지 문장. 일반 발언으로 확장한다.
- 사용자 격리 규칙 2개: `docs/FRONTEND-ARCHITECTURE.md:110`, `docs/API-SPEC.md:83`. 새 UI 발언의 사용자 사전 조건과 구형 speak 호환 범위를 명시한다.
- 폴링 규칙 2개: `docs/FRONTEND-ARCHITECTURE.md:34,104`. 기본 간격은 유지하며 온라인 복구·보이는 탭 전환의 즉시 조회만 추가한다.
- `docs/ARCHITECTURE.md:24` controller/hook/view 책임은 유지한다. `docs/API-SPEC.md:33`, `docs/ARCHITECTURE.md:207`의 브라우저 JWT 비노출 계약도 유지한다.
- `docs/planning/delivery-and-validation.md`에 실제 검증과 후속 Realtime 과제를 기록한다. 본 계획의 수명주기로 관련 정본만 갱신한다.

## Implementation Steps

### [x] Step 1: 응답 유실과 재접속 실패 재현

**Files**: 기존 unit/integration tests

- 서버 저장 뒤 응답만 유실된 speak를 재시도할 때 operationId가 바뀌는 현재 문제를 재현한다.
- 계정 A에서 만든 발언을 로그인 계정 B로 재시도하는 경우, storage 실패, reload 복원, 이미 전송 중인 상태의 중복 클릭을 검사한다.
- 조회·변경 진행 중 online/visible 알림과 종료 뒤 늦은 응답을 재현한다.

### [x] Step 2: 일반 발언의 동일 요청 복구

**Files**: direct-intents, controller, contracts, 신규 SQL

- 기존 미확정 intent에 speak를 허용하고 새 발언은 expectedUserId를 포함한다. 저장 성공 전에 HTTP 전송하지 않는다. 저장 공간을 사용할 수 없으면 본문을 보존하고 명확한 오류를 보여준다.
- 기존 speak 본문과 expectedUserId가 있는 본문 두 exact shape만 허용한다. 잘못된 타입·null·추가 필드는 거절한다. 필드가 있으면 실제 auth.uid와 반드시 일치해야 한다. 필드 제거 후 기존 권한·중복 제거·트랜잭션 처리로 전달한다.
- 새 UI 복원은 expectedUserId가 없는 speak를 채택하지 않는다. 기존 ask/cancel/retire 저장 형식과 동작은 유지한다.
- UNAVAILABLE·timeout·전송 후 화면 종료는 결과 미확정으로 보존한다. 같은 요청 확인은 같은 action·operation·본문을 사용한다. 온라인 복구만으로 변경 요청을 자동 재실행하지 않는다.
- 성공 영수증 또는 서버의 확정 거절(INVALID_BODY·CONFLICT·접근 거절 등)을 받으면 해당 intent를 종료·정리한다. 확정 거절에는 초안을 유지하고 오류를 표시한다. UNAVAILABLE·timeout·전송 뒤 중단만 미확정으로 보존한다. 기존 ask/cancel/retire의 확정 거절 정리 동작을 유지한다.
- storage 삭제 실패가 서버 성공을 실패로 오표시하거나 새 operation 재전송으로 연결되지 않게 상태를 구분한다. 다음 복원에서 같은 operation 재확인은 안전하다. 확정 거절 뒤 삭제 실패도 무한 대기와 자동 재전송을 만들지 않도록 복원·오류 검사를 추가한다.
- 접근 거절 시 기존 history 비우기·요청 중단을 유지한다. 과거 계정의 intent를 새 계정으로 옮기지 않는다.

### [x] Step 3: 전송 상태와 초안 정리

**File**: investigation-view

- 전송 중, 전송 결과 확인 필요, 확정 오류를 사용자가 구분하도록 표시한다. 결과 미확정에는 원래 본문과 ‘같은 메시지 확인’ 동작을 제공한다.
- 미확정 요청이 있으면 새 메시지 전송을 막는다. 일반 발언의 재확인이 성공했을 때 동일한 제출 초안만 비우며 이후 편집한 초안은 지우지 않는다.
- 낙관적으로 서버 sequence를 만들거나 성공 메시지를 중복으로 timeline에 넣지 않는다. 성공 영수증 뒤 기존 즉시 조회로 확정 순서를 표시한다.

### [x] Step 4: 연결 복구 시 누락 없는 직렬 조회

**Files**: controller, use-room-chat

- hook에서 online과 visible로 바뀌는 visibilitychange를 전달한다. 언마운트 시 listener를 해제한다.
- controller가 재조회 필요 여부를 소유한다. 대기 timer는 당겨 실행하고, 진행 중 조회·변경이 있으면 플래그 하나로 합쳐 끝난 뒤 한 번 조회한다. 요청을 겹쳐 실행하거나 정상 요청을 이벤트마다 취소하지 않는다.
- 플래그는 조회 시작 때 소비한다. 그 조회 도중 새 이벤트가 오면 다음 조회로 남긴다. 중복 이벤트 폭주에는 최소 간격을 두고 실패 시 기존 backoff를 우회하는 무한 루프를 만들지 않는다.
- 기존 연속 cursor 검증·중복 제거·snapshot revision·retirement 별도 cursor·UNKNOWN 기록을 유지한다. stop/권한 상실 뒤에는 재조회하지 않는다.

### [x] Step 5: 검증·리뷰·기록

- 별도 테스트용 로컬 Supabase만 필요 시간에 실행해 실제 영수증·권한 통합 검사를 수행하고 종료한다. 운영 DB를 테스트 fixture로 사용하지 않는다. 사용자 연결 프로그램을 종료하지 않는다.
- 독립 reviewer가 인증 사전 조건, 구형 클라이언트 호환, 저장 실패·순서·수명 경합을 검토한다.
- 본문이 많은 이력의 렌더링 최적화, 닫힌 탭 전송 보관, Realtime는 후속으로 기록한다. 이번 변경으로 해당 기능을 완료했다고 표시하지 않는다.
- 관련 정본 갱신, 기능 단위 커밋, PR, 기존 사용자 병합·배포 승인 범위 안에서 검증된 DB 선적용 → 웹 배포 순서를 따른다.

## Tests

- should reuse the speech operation after a lost response: DB 이벤트와 영수증이 하나이고 같은 eventId/sequence를 반환.
- should reject a mismatched expected speech actor: A 요청을 B 인증으로 보내도 B 발언이 생기지 않음.
- should preserve legacy speech receipts: 기존 본문 호출과 새 expectedUserId 호출의 동일 operation/hash 호환.
- should restore only the current user's pending speech: 계정·방 격리, 새로고침, 손상 저장소, 구형 직접 질문 호환.
- should retain pending speech when acknowledgement is unavailable: 자동 재전송 없음, 중복 클릭 차단, 수동 같은 요청 확인.
- should clear definitively rejected intents: 확정 거절 뒤 pending을 해소하고 초안을 유지한다. 직접 질문의 기존 CONFLICT 검사도 유지한다.
- should retain edited drafts after retry acknowledgement: 제출 당시 초안만 정리.
- should coalesce resync requests during polling and mutation: 동시 HTTP 최대 하나, 후속 조회 누락 없음, 타이머 폭주 없음.
- should ignore lifecycle events after stop or access loss: 이전 방·사용자의 늦은 응답 무시.
- 기존 history 순서·누락·오래된 snapshot·정리 기록 검사를 재사용한다.

## Risks

- 선택적 expectedUserId는 구형 클라이언트 전체에 사용자 사전 조건을 강제하지 않는다. 새 UI의 복구 요청은 필수 포함한다. 필드를 사용자 신원 증명으로 사용하지 않는다.
- DB 먼저 적용하면 구형 웹도 동작한다. 웹 먼저 배포하면 새 필드를 구형 DB가 거절하므로 배포 순서를 검사한다. 웹 rollback 시에도 추가된 wrapper는 호환된다.
- sessionStorage는 탭 종료 뒤 전달을 보장하지 않는다. 브라우저 종료까지 보장하는 전송 대기열이라고 안내하지 않는다.
- 일시적인 테스트 컨테이너는 메모리를 사용한다. 검사 종료 후 프로젝트 테스트 컨테이너만 정리하고 데이터 볼륨을 무단 삭제하지 않는다.

## Verification

- Node 24에서 `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- `tsc -p tsconfig.integration.json` 후 기존 격리 fixture 환경으로 human-direct-questions와 workflow 관련 실제 DB 검사. skip을 통과로 세지 않는다.
- 기존 browser fixture로 일반 발언 응답 유실→새로고침→같은 메시지 확인, 계정 변경, 온라인 복귀를 검사한다. 합성 계정·본문을 사용하며 실제 AI 호출은 없다.
- `npm run format`, `npm run format:check`, `git diff --check`. 사용자 변경 `next-env.d.ts`는 보존·커밋 제외.

## Review Notes

2026-10-16 사용자 계획 승인 후 `fix/chat-delivery-recovery`에서 구현을 시작했다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 영수증만 intent 종료 조건으로 적으면 확정 거절도 미확정으로 남음 | HIGH | ACCEPTED | Step 2에서 성공·확정 거절·미확정을 구분하고 기존 직접 질문 CONFLICT 정리 검사를 유지한다. 독립 reviewer가 보정 확인해 해소했다. |

2026-10-16 독립 계획 리뷰: CRITICAL 0 / HIGH 0 / MEDIUM 0. 코드·SQL 대조 검토이며 실행 검증은 구현 단계에서 진행한다.

## Execution Evidence

- 수정 전 관련 단위 검사 85개 중 새 회귀 8건 실패. 수정 후 관련 검사 93/93 통과.
- 총괄 환경 전체 웹 단위 검사 719/719 통과. 워커 sandbox의 loopback listen EPERM 실패는 총괄 환경에서 해소 확인했다.
- 로컬 실제 DB의 일반 발언 영수증 호환·중복 방지·사용자 사전 조건 검사 2/2 통과. 최초 실행은 테스트 웹 서버 미기동으로 실패했고 서버 기동 뒤 재검증했다.
- 독립 구현 리뷰 PASS(CRITICAL/HIGH/MEDIUM 0). 직접 질문 실제 DB 통합 16/16 통과. desktop/mobile 실제 브라우저 4/4 통과. 실제 AI 입력 0회.

- 구현 리뷰: chat_delivery_impl_review PASS. 기존 UI 변경으로 오래된 browser 공유 안내·대상 없음 문구 3곳을 현행 문구로 맞췄고, 별도 chat_delivery_browser_review에서 의미 유지 PASS를 확인했다.
- 마지막 전체 단위 실행은 720개 중 718개 통과, 기존 bootstrap 종료 타이밍 2건 실패. 해당 파일 단독 39/39 재검증으로 두 실패를 해소했다. 변경 코드의 scoped 93/93 결과도 유지된다.

- 브라우저 이력 검사의 기존 `답변` 선택자를 현행 `AI · 답변`으로 맞췄다. chat_delivery_selector_review PASS로 질문·답변 개수와 저장 대상 검증 유지 확인. 최종 browser 4/4, e2e types, format/check 통과. 운영 코드는 최초 독립 구현 리뷰 이후 변경 없음.
- 테스트용 프로젝트 Supabase 컨테이너 6개는 검증 후 중지하며 볼륨과 사용자 연결 프로세스는 보존한다.

- 운영 DB 마이그레이션 `20261016002200`만 선적용했고 schema_migrations 반영을 확인했다. 테스트 컨테이너 6개 모두 중지 확인. 웹 배포 상태는 PR과 Vercel의 main 배포 기록으로 확인한다.
