---
status: active
date: 2026-10-16
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: 계획이며 현재 구현의 증거가 아니다. 사용자는 남은 개선 전부의 진행을 요청했다. 2026-10-16 독립 리뷰 통과 후 사용자가 상태 패널 축소·WebSocket·긴 채팅 성능·일반 메시지 복구의 구현·검증·배포를 명시적으로 승인했다. 인증 경계 변경을 포함한 이 계획의 승인을 받았으며, 이전 043 승인을 대신 사용하지 않는다.

# 실시간 채팅·대량 기록·브라우저 종료 후 전송 복구

## Context

기준 main `f458252`이다. 043은 일반 발언의 동일 operation 복구와 직렬 재조회를 완료했다. 이번에는 남은 세 항목을 한 승인 범위로 진행하고 기능별 커밋으로 구분한다. 제품은 사람이 자기 AI 또는 동료 AI에 질문하며 질문자 자신의 AI 연결은 필요 없다. PRD의 읽기·검증·제안 범위와 AI 입력 재실행 금지는 유지한다.

사용자가 추가로 보고한 질문 #61의 고정 상태 패널도 함께 개선한다. 2026-10-16 운영 읽기 전용 조회에서 request `ae97a7fa-3276-40db-a73c-42c1c4c5d83e`는 UNKNOWN, control REQUESTED였다. Mac 연결 프로세스는 살아 있고 heartbeat도 갱신됐으나 로컬 journal reason은 SNAPSHOT_CHANGED, native/terminal/receipt는 null, ready=false였다. 이 자료로 변경된 정확한 파일이나 실제 AI 종료를 확정하지 않는다. 현 기록을 성공·중단으로 강제 변경하거나 질문을 재실행하지 않는다.

## Decisions requiring approval

- Realtime는 공식 Supabase private Broadcast를 사용한다. 브라우저에 기존 사용자 **access token을 메모리로만 전달**한다. refresh token·HttpOnly 쿠키는 전달하지 않는다. 이 access token은 Realtime 전용 토큰이 아니며 현재 사용자의 기존 Supabase 권한을 갖는다. 현재 API-SPEC의 session JSON 비반환 약속 중 access token 예외를 명시적으로 변경한다. 장기 저장, 로그, URL, 분석 도구에는 넣지 않는다. 별도 signer나 신규 서버는 도입하지 않는다.
- 브라우저 종료 후에는 일반 발언(speak)의 저장된 요청을 복원하고 사용자가 ‘같은 메시지 확인’을 눌러 전송을 확인한다. AI 질문과 제어 요청은 기존 수동 복구 규칙을 유지한다. 닫힌 브라우저에서 백그라운드 전송하거나 AI를 자동 실행하지 않는다.
- 일반 발언은 사용자·방별 미확정 요청 하나를 영속 보관한다. 동시에 여러 발언을 쌓는 메신저형 대기열은 만들지 않는다. 대기열의 한 항목도 브라우저 재시작과 다중 탭에서 유실 없이 유지되어야 한다.
- 긴 이력은 정본 전체를 보존하며 화면에 필요한 행만 렌더링한다. 같은 탭의 방 왕복에는 메모리 캐시를 사용한다. 브라우저 재시작의 확정 채팅 전체 캐시는 저장하지 않는다.

## Affected Files

기존 운영 코드와 신규 모듈을 책임별로 나눈다. 공개 타입을 임의로 늘리지 않고 아래 소비자에 필요한 경계만 노출한다.

1. 신규 `src/features/investigation-coordinator/realtime-contracts.ts` — 구독 허가 응답 검증, 공개 오류.
2. 신규 `src/features/investigation-coordinator/realtime-service.ts` — 실제 사용자·session·방 확인 뒤 lease와 메모리용 access token 발급. 기존 requestClient 재사용.
3. 신규 `src/app/api/chat-realtime/[action]/route.ts` — POST authorize/release, 동일 Origin·JSON·크기 제한, private/no-store.
4. 신규 `src/features/investigation-coordinator/room-realtime.ts` — 메모리 전용 Supabase client, 연결·갱신·복구·해제와 상태.
5. 신규 `supabase/migrations/20261016002300-chat-realtime-leases.sql` — 제한된 구독 lease, private Broadcast SELECT policy, 발행 함수·trigger·허가/해제 RPC.
6. `room-chat-controller.ts`, `use-room-chat.ts`, `polling-policy.ts` — 알림을 기존 requestResync에 연결, 폴링 보완, 캐시·영속 저장 수명.
7. 신규 `chat-outbox.ts` — IndexedDB 영속 일반 발언, transaction 기반 조건부 저장·삭제, 사용자·방·operation 식별.
8. `direct-intents.ts` — 기존 sessionStorage 읽기·일반 발언 인계. ask/cancel/retire는 기존 저장 정책.
9. 신규 `chat-history-cache.ts` — actor/room 메모리 캐시와 상한, 검증 전 비공개 상태.
10. `history-state.ts`, `chat-presentation.ts` — 새 페이지만 처리, 변경 없는 배열 참조 유지, 질문 인덱스 재사용.
11. `investigation-view.tsx`, `chat-timeline.tsx`, `chat-markdown.tsx` — 가상화·메모이제이션, 원문 이동, 한 줄 상태 및 별도 상세 창.
12. 신규 `chat-answer-status-panel.tsx` — 채팅을 가리지 않는 상태 표시/상세 창. 기존 RequestRetirementControls와 중단 권한 조건을 재사용.
13. `contracts.ts`, `packages/local-connector/src/workflow-contracts.ts`, `service.ts` — read-recovery의 선택적 expectedUserId; 새 UI는 필수 전송, 서버는 실제 사용자와 대조 후 기존 RPC에는 제거하여 전달. 구형 읽기는 호환.
14. `src/features/room-access/client-actions.tsx`, `login-form.tsx` — 성공 로그아웃·계정 변경 시 캐시·outbox 정리와 다른 탭 통지. 공통 helper로 중복을 피한다.
15. `package.json`, `package-lock.json` — 가변 높이 행에 검증된 가상화 라이브러리를 사용할 경우 명시적 의존성. 기존 Supabase JS 재사용, unrelated upgrade 금지.
16. 관련 unit/integration/e2e 파일과 fixture, 아래 주제별 정본·가이드. `next-env.d.ts` 사용자 변경은 보존하고 커밋에서 제외한다.

파일명만 적힌 항목은 `src/features/investigation-coordinator/` 아래다.

## Affected Dependents

- `useRoomChat` → RoomChatController → `callInvestigation`/projectResponse. UI의 초안과 스크롤은 view가 소유하고 controller는 서버 기록·요청만 소유한다.
- `src/app/app/rooms/[roomId]/page.tsx`가 서버 확인 userId/role을 전달한다. 캐시가 이 확인이나 새 HTTP 읽기의 actor 검증을 대체하지 않는다.
- `SourceViewController`/`RunSourceView`의 event 주소·bindingEpoch·근거 hash 검증은 유지한다. 행 제거 시 abort, 늦은 응답 무시를 유지한다.
- `OwnInputControls`의 별도 sessionStorage는 변경하지 않는다. 연결기 실행 프로토콜과 실제 AI 입력도 이번 전송 개선으로 바꾸지 않는다.
- DB 이벤트는 `workflow_private.event/state` → public.workflow_events. 정리 기록은 direct_retirements 별도 cursor. 준비 상태는 readiness·agent·workspace·device 조합이며 valid_until 경과는 DB 이벤트가 아니다.
- 인증 현재 경계: `src/lib/supabase/server.ts:49`, `src/lib/supabase/proxy.ts:33` HttpOnly. 새 응답은 검증한 access token만 내보내며 전체 session 객체 반환 금지.
- 계약 사본 일치 검사는 tests/unit/human-direct-contracts.test.ts에서 유지한다.
- 문서 사본(소유자 명시 없음=unstated): polling/Realtime 후속 규칙 9곳 — README:65, ARCHITECTURE:18/207, FRONTEND-ARCHITECTURE:34, API-SPEC:125, guides/onboarding-and-settings:248, planning/decisions-and-open-items:27, planning/delivery-and-validation:32 두 문장. 웹만 전환하며 연결기까지 WebSocket이라고 바꾸지 않는다.
- 영속 보존 규칙 6곳 — BUSINESS-LOGIC:50, FRONTEND-ARCHITECTURE:34/110(두 문장), planning/delivery-and-validation:28/32. 일반 발언과 AI 요청을 구분해 갱신한다.
- 인증 비노출 규칙 7곳 — API-SPEC:33 두 문장, ARCHITECTURE:207 두 문장, research/sources:195 세 진술. sources의 당시 조사 내용은 역사로 유지하고 새 날짜의 예외·공식 근거를 추가한다.
- 수동 확인 규칙 BUSINESS-LOGIC:48/50, FRONTEND-ARCHITECTURE:102/104/110은 유지한다. 대량 행/캐시 명시 사본은 없으며 FRONTEND-ARCHITECTURE:28/122 원문 이동·자료 수명은 유지한다.
- 검색 범위는 README, docs 정본·guides·planning·research의 관련 절이다. archive/records는 동결된 역사이므로 재작성하지 않는다.

## Implementation Steps

### [x] Step 1: 상태 패널과 질문 #61 진단 경계

- 재현 테스트부터 추가한다. 중단 대기가 길어져도 입력창 위에는 질문 번호·상태·‘상세’ 버튼만 한 줄 표시한다. 상세·중단·기존 요청 정리 버튼은 별도 Dialog로 옮기고 닫기/ESC/포커스 복귀를 제공한다.
- UI를 닫아도 서버 요청과 기록은 유지한다. 새 상태나 동일 polling으로 상세 창을 자동 재개방하지 않는다. 중단 접수와 종료 확정을 혼동하지 않는다.
- 기존 연결 해제 안내는 상세 창에서만 보여준다. 사용자가 창을 닫기 위해 기기 제거·이전 요청 정리를 할 필요가 없어야 한다.
- 질문 #61은 원본 journal을 보존한다. 정확한 SNAPSHOT_CHANGED 발생 파일은 현 증거로 미확인이다. 이 후속 진단은 아래 Incident Follow-up에 분리하며 UI 숨김을 실행 오류 해결로 보고하지 않는다.

### [x] Step 2: Realtime 인가·발행·연결

- 실제 `getUser` 검증 뒤 현재 access token을 얻고 그 토큰의 사용자와 session을 재검증한다. authorize body는 `{protocol:1, roomId, expectedUserId, clientId, leaseId?}`, release body는 `{protocol:1, roomId, expectedUserId, clientId, leaseId}` exact shape으로 정의한다. ID는 UUID이며 clientId는 탭의 연결 수명 동안 생성한 값이다. leaseId 없는 authorize는 같은 clientId의 기존 활성 lease를 반환하고, leaseId가 있으면 해당 lease만 갱신한다. 모든 갱신·해제는 userId/sessionId/roomId/clientId/leaseId 전체 일치를 요구한다. topic은 응답으로만 반환한다. 동일 토큰으로 RPC를 실행하여 lease에 userId/sessionId를 고정한다. session 존재·not_after·사용자 정지/삭제·조직/방 membership을 확인한다.
- lease는 random 256-bit topic, roomId/userId/sessionId, expiresAt(최대 5분), revokedAt을 가진 private 테이블에 저장한다. 브라우저당 현재 방 하나, 사용자·방·session당 최대 4개. 생성 시 해당 사용자의 만료 항목만 정리하며 수용 한도는 오류로 안내한다. 갱신은 기존 살아 있는 lease를 연장하고 room/user/session 변경 때 재사용하지 않는다.
- refresh token은 반환하지 않는다. access token은 client persistSession=false/autoRefreshToken=false 상태와 메모리에만 둔다. 현재 access token 만료 전에 서버에서 갱신하며 실패 시 토큰·채널 폐기 후 HTTP fallback. 검증된 authorize 성공 응답의 access token 필드만 JSON 예외다. 전체 session·refresh token, 다른 응답·로그·오류에 token을 복사하지 않는다. 기존 HttpOnly session cookie는 유지하며 JavaScript 접근 가능 cookie나 새 영속 저장소에는 토큰을 쓰지 않는다.
- private Broadcast의 SELECT policy는 정확한 topic·현재 auth.uid/session_id·활성 lease·현재 membership을 요구한다. INSERT/Presence는 허용하지 않는다. 기존 project 정책·권한 목록을 읽어 광범위 허용이 없는지 검증하고 관련 없는 policy를 임의 삭제하지 않는다.
- Realtime는 join/새 JWT에서 권한을 캐시하므로 **발행 때도** lease의 session·사용자·membership·만료를 재검사한다. 사용자별 lease topic으로 `{version:1}` 변경 힌트만 보낸다. 본문·이름·경로·request ID·revision은 실시간 payload에 싣지 않는다. 철회 뒤 topic에는 더 이상 발행하지 않는다.
- trigger 대상: 확정 workflow_events INSERT, direct_retirements INSERT. runs/room state는 기존 이벤트에서 이미 반영된다. readiness의 실제 ready/epoch/device 변경과 agent 활성 binding 변경도 알리되 단순 valid_until 연장 heartbeat는 제외한다. 시간 만료·membership 변화는 보완 HTTP 조회로 수렴한다.
- 같은 transaction·방의 중복 알림은 합치며, 구현은 영속 무한 누적 dedupe 테이블을 만들지 않는다. 알림 발행 실패가 정상 채팅 저장을 rollback시키지 않게 오류를 별도 포착하고 비밀값 없는 제한된 진단을 남긴다. HTTP fallback이 누락을 복구한다.
- SUBSCRIBED 뒤 반드시 requestResync한다. 알림/online/visible은 동일 직렬 경로로 합친다. 채널 재연결·token 갱신·방 이탈·logout·권한 상실 시 generation guard와 채널 해제를 검사한다.
- 전경 realtime 정상 시 30초, 비정상 시 기존 active2초/idle10초 보완 조회를 유지한다. 숨긴 탭은 30초 조회를 유지한다. 실행 deadline·readiness 만료가 30초보다 먼저면 해당 시점에 조회한다. 채널은 현재 열린 방 하나만 구독한다. UI에는 연결 중/실시간 연결/재연결 중을 짧게 표시하며 메시지 저장 성공의 증거로 사용하지 않는다.

### [x] Step 3: 일반 발언 영속 outbox

- IndexedDB transaction으로 사용자·방당 하나의 speak intent를 예약한다. 저장 commit 후만 HTTP 전송한다. operationId·expectedUserId·roomId·본문은 immutable. 다른 operation이 이미 있으면 덮어쓰지 않고 기존 확인으로 안내한다.
- 성공/확정 거절 정리는 저장된 operationId가 같은 경우에만 한다. 더 늦은 탭이 새 항목을 지울 수 없도록 compare-and-delete를 같은 transaction에서 수행한다. 여러 탭의 같은 operation 전송은 서버 receipt로 단일 이벤트가 된다.
- browser close/reopen 복원은 사용자·방 인증 성공 뒤 보여준다. 자동 전송은 하지 않는다. 실패 상태·저장 원문·‘같은 메시지 확인’을 제공한다. 저장 불가/용량 초과는 전송 전에 명확히 실패한다.
- sessionStorage 기존 speak는 동일 operation으로 한 번 인계한다. 두 저장소의 요청이 다르면 어느 것도 지우거나 덮어쓰지 않고 명시적 선택 UI를 제공한다. legacy ask/cancel/retire는 기존 규칙을 유지한다.
- BroadcastChannel은 변경 힌트로만 사용하고 IndexedDB를 다시 읽는다. 지원하지 않는 브라우저는 focus/visible/전송 직전 재검사한다. IndexedDB transaction이 실제 동시성 경계다.
- 보관 기간 7일, 사용자별 전체 최대 50개 방·합계 1MiB. 전송 성공·확정 거절·성공 로그아웃·권한 상실 시 해당 범위 항목 제거. 기간 만료는 자동 재전송 없이 UI에 로컬 보관 만료를 안내하고 제거한다. 저장소 사용자 삭제나 브라우저 자체 삭제까지 복구한다고 보장하지 않는다.
- 로그아웃으로 인한 로컬 정리 실패를 성공으로 숨기지 않는다. 현재 화면은 숨기고 메모리를 비우며 다음 동일 사용자 진입에서 정리 상태를 확인한다. 다른 사용자에게 이전 본문을 보여주지 않는다.

### [x] Step 4: 긴 기록과 재입장 성능

- 전체 정본과 두 cursor는 유지한다. mergeHistory는 추가 이벤트만 index/run에 반영하고 변경이 없으면 events 참조를 재사용한다. 오래된 snapshot·누락·중복·역순 검사는 먼저 회귀 테스트로 고정한다.
- 질문 ID→event 인덱스는 events 참조로 재사용한다. answerStatuses/presentation은 history, snapshot, cancelReceipts, pollError, observedAt, role 등 함수가 실제 읽는 모든 입력을 의존성으로 계산한다. 새 이력 없이 도착한 중단 접수·조회 실패·시간 만료도 즉시 반영한다. 입력 초안 타이핑으로 전체 Markdown을 다시 파싱하지 않게 행과 Markdown 경계를 memo 처리한다.
- 가변 높이 행 가상화로 화면 주변 20행 overscan만 렌더링한다. 모든 이력과 상태 근거는 메모리에 유지한다. DOM을 줄이기 위해 증거·기록을 삭제하지 않는다.
- 원문 이동은 index를 찾아 해당 행을 스크롤·렌더한 뒤 anchor focus한다. 외부 hash 진입도 동일 경로로 처리한다. 열린 자료 상세는 Dialog에 event identity를 고정해 행이 화면 밖으로 나가도 조회 대상이 바뀌지 않게 한다.
- 읽는 중 새 메시지는 위치를 유지하고 ‘새 메시지’로 이동한다. 아래를 따라가던 사용자는 마지막 행을 유지한다. 새 행 높이 측정·Markdown 확장·모바일 resize를 검사한다.
- 캐시는 같은 탭 메모리에 userId/roomId/role별 최대 3개 방, 합계 10MiB, 미사용 5분까지 유지한다. 인증 재확인 전에는 내용을 표시하지 않는다. 새 read-recovery에 expectedUserId를 보내 실제 Auth와 대조 후 cursor 이후를 합친다. 거절·계정/role 변경·logout 때 삭제한다.
- 첫 진입은 기존 전체 페이지 조회를 유지하되 받은 페이지부터 표시한다. 재진입에서는 기존 cursor 이후만 조회한다. 최신 일부 기록을 완전 이력이라고 표시하지 않는다.

### [ ] Step 5: 통합 검증·문서·배포

- 아래 수용 기준 모두 통과해야 세 개선 완료라고 보고한다. 각 기능을 따로 구현 완료/실제 검증/운영 반영으로 기록한다.
- 독립 reviewer가 auth token 노출 범위·RLS·권한 철회·저장 경합·캐시 접근·가상화 원문 이동을 검토한다. 부하 수치는 명시된 fixture 기준으로 보고한다.
- second-brain 주제별 정본, 현재 진행 정본과 가이드·인증 결정 ADR을 갱신한다. 구현이 끝나면 이 계획을 archive로 옮긴다.
- Node24 typecheck/lint/unit/build/format/check, 관련 connector 계약 검사. 테스트 전용 Docker만 잠시 켜고 반드시 종료한다. 운영 데이터는 fixture로 쓰지 않는다.
- DB migration 선적용→웹 배포, feature flag로 Realtime만 비활성화할 수 있게 하고 fallback 유지. 기존 사용자 main 병합·배포 승인을 재사용한다. 사용자의 AI 연결 프로세스·설정·기록은 종료/삭제하지 않는다.

## Tests and acceptance criteria

- should reject realtime authorization for wrong user/room/session: 비참가자·다른 계정·삭제/정지·로그아웃 session·만료 lease 차단. 브라우저 INSERT/Presence 차단.
- should stop publishing after access revocation: 이미 joined한 socket에도 membership/session 철회 뒤 새 힌트 0개. topic 갱신·lease 만료 후 기존 topic 수신 없음.
- should isolate realtime leases across tabs: 같은 user/room/session의 두 clientId가 별개 lease를 유지하고 A 갱신·해제가 B에 영향 없음. 타인 leaseId·다른 session·잘못된 clientId 거절, 응답 유실 재authorize 중복 생성 없음.
- should update status without new history: 이력 참조가 그대로여도 cancelReceipts·pollError·observedAt 변경 시 중단 접수·조회 오류·만료 표시 즉시 반영.
- should backfill across subscription races: 구독 전/구독 중/끊김 중 commit, 알림 중복/역순/유실에도 DB event/retirement 순서·개수 동일. 서버 저장을 알림 장애가 rollback하지 않음.
- should renew without persistent tokens: 새 storage·JavaScript 접근 가능 cookie·URL·log·오류에 access/refresh token 없음, 기존 HttpOnly session cookie와 검증된 authorize 성공 응답의 access token만 예외, 갱신 실패 뒤 polling 유지, 종료 후 callback 무시.
- 실제 local Supabase WebSocket 두 브라우저에서 20개 합성 메시지: 정상 연결의 수신 표시 p95 2초 이하. 알림이 실제 WS로 왔음을 socket frame/HTTP 요청 시각으로 확인. 폴링만 통과한 결과를 WS 성공으로 세지 않는다.
- should persist speech through browser restart: 동일 사용자·방 재접속에서 같은 operation 복원, 수동 확인으로 DB 이벤트 1개. 인증 전 본문 0개, 사용자 변경 뒤 이전 본문 0개.
- should serialize cross-tab outbox updates: 동시 두 새 operation 저장 중 하나만 예약, 같은 operation 재확인, 늦은 성공 정리가 새 요청을 지우지 않음. 저장 실패·migration 충돌·만료·logout·quota 모두 검사.
- should preserve history invariants with incremental merge: cursor 누락, 같은 sequence 충돌, 오래된 snapshot, 최근 32개 밖 run, 별도 retirement cursor 회귀.
- 2,000 이벤트·각 본문 1KiB와 코드블록 fixture: 표시 메시지 DOM 최대 100개, 타이핑 20회에 과거 메시지 Markdown 추가 파싱 0회. 같은 탭 재입장 시 afterSequence=기존 cursor, cursor0 페이지 재조회 0회(캐시 미만료 조건).
- 브라우저 1440/390폭에서 원문 jump·자료 열기·읽는 위치 보존·가상화 높이 변경·키보드 포커스·가로 넘침 없음. 재입장 시간과 렌더 시간을 수정 전후 같은 fixture/환경에서 기록한다.
- should keep unknown stop status unobtrusive: UNKNOWN/REQUESTED에서도 패널 한 줄, 상세 닫기 뒤 채팅 높이 복구, 서버 cancel/retire 호출 0회, 재poll 후 자동재개방 0회, 종료 확정 문구 0개.

## Risks

- access token의 메모리 노출은 기존 인증 설계의 명시적 변경이다. XSS 방어·Markdown raw HTML 금지·로그 제외·현재 RLS 검사가 전제이며 이를 Realtime-only 권한으로 설명하지 않는다.
- Supabase private 채널의 권한 캐시는 발행 시 session/member 확인으로 보완한다. 실제 프로젝트 RLS·Realtime enabled 상태는 배포 전 읽기 전용으로 확인한다. 미지원이면 무인증 public channel로 우회하지 않는다.
- Free 한도는 공식 문서 기준 동시 200 연결·초당 100 메시지이며 환경별 설정을 확인한다. 사용자별 topic은 fan-out을 늘리므로 heartbeat는 알리지 않고 채널/lease 상한·수신 이벤트 합치기를 적용한다. 월 사용량은 운영 대시보드에서 확인하며 유료 전환을 자동으로 하지 않는다.
- IndexedDB는 영구 보관 보장이 아니다. 본문을 기기에 최대 7일 저장하는 안내와 삭제 동작을 제공한다.
- 이력 첫 진입 네트워크 비용과 DB 방 잠금 비용은 가상화만으로 사라지지 않는다. 수용 기준은 렌더링과 같은 탭 재진입에 한정하며 초기 0부터 전체 조회 조건을 숨기지 않는다.

## Verification

`npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format`, `npm run format:check`, `git diff --check`. 기존 integration compile/fixture를 확장해 Realtime local 실제 연결과 DB 권한 검사를 수행한다. fixture의 loopback·소유 컨테이너 검사를 유지한다. browser persistent context는 합성 계정의 별도 임시 profile만 사용하며 개인 Chrome을 닫거나 복제하지 않는다. 실제 AI 입력은 0회로 검증한다.

## Incident Follow-up

질문 #61의 SNAPSHOT_CHANGED는 파일/설정 변경 감지와 UNKNOWN 보존의 증거이지 WebSocket 장애의 증거가 아니다. 정확한 비교 실패 지점을 담는 비밀값 없는 로컬 단계 진단, AI 입력 전 실패를 안전하게 종료 처리할 수 있는 증거 경계는 별도 코드 검토가 필요하다. 현 계획은 이를 해결했다고 표시하지 않는다. 사용자 요청 전체 진행 중 별도 원인 보완 계획을 마련하며, 운영 기록 강제 편집이나 새 입력은 하지 않는다.

## Sources

2026-10-16 확인: [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — private SELECT/INSERT policy와 join/JWT 시 권한 캐시. [Broadcast](https://supabase.com/docs/guides/realtime/broadcast) — DB에서 private 힌트 발행. [Limits](https://supabase.com/docs/guides/realtime/limits) — Free 연결·메시지 상한. 외부 문서는 현재 코드의 구현 증거가 아니다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| lease 갱신·해제의 탭 식별 계약 누락 | HIGH | ACCEPTED | clientId/leaseId exact shape과 전체 소유 범위 대조, 다중 탭 회귀를 추가했다. 2차 독립 리뷰에서 해소 확인. |
| 상태 표시 memo가 실제 의존성 누락 | HIGH | ACCEPTED | 질문 인덱스만 events로 memo하고 상태 표시는 실제 모든 입력으로 계산한다. 신규 이력 없는 중단 접수·오류 회귀 추가. 2차 독립 리뷰에서 해소 확인. |
| 토큰 비노출 검사와 기존 쿠키·응답 예외 충돌 | MEDIUM | ACCEPTED | 기존 HttpOnly cookie와 검증 authorize access token 응답 예외를 명시했다. |

2차 독립 리뷰: 기준 `f458252`와 위 세 보완을 대조해 PASS. 차단 지적 없음. LOW 경로 참조 오류는 `src/lib/supabase/proxy.ts:33`으로 정정했다. 이 기록은 계획 승인 당시의 리뷰이며 이후 구현 검증은 아래에 기록한다.

구현 중 검증: Step1은 실제 Chromium 1440/390 폭에서 UNKNOWN/REQUESTED 한 줄 표시, 상세·ESC·포커스 복귀, 닫기 후 cancel/retire 호출0건 및 상태 보존 검사를 통과했다. 일반 발언은 실제 persistent Chromium 종료·재시작 뒤 수동 확인과 DB 단일 저장 검사를 통과했다. 전체 완료·운영 반영은 나머지 검증 후 기록한다.

### 구현 독립 리뷰 1차

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 같은 controller 재시작 시 인증 재확인 전 이전 본문 표시 | HIGH | ACCEPTED · 2차 해소 | 재시작 표시 상태를 비우고 actor-pinned 조회 성공 뒤 복원한다. 인증 지연·거절 회귀로 확인한다. |
| localStorage 정리 표식 실패 시 IndexedDB 삭제 생략 | HIGH | ACCEPTED · 2차 해소 | 표식과 실제 삭제를 독립 시도하고 다음 로그인까지 이전 발언 복원을 차단하는 경계를 검증한다. |
| joined 소켓의 session 철회·lease 만료·topic 교체 발행 중단 검사 누락 | HIGH | ACCEPTED · 2차 해소 | 실제 연결을 유지한 채 각 조건 뒤 이전 topic의 새 힌트가 없는지 검증한다. |

검증된 결과: 전체 unit 732개, 기존 직접 질문·정리 통합 32개 통과. 두 Chromium WebSocket에서 합성 메시지 20개 화면 반영 p95 1,108ms. 실제 IndexedDB 기간·용량·업그레이드 충돌·저장 실패, Realtime INSERT/Presence 거절·알림 실패 시 저장 유지·heartbeat 알림 제외 검사를 통과했다. 성능 계측과 위 보정은 진행 중이다.

리뷰 보정 결정: localStorage 표식 실패와 IndexedDB 삭제를 독립적으로 처리한다. 두 저장소가 함께 실패한 상태를 새 문서까지 확실히 기록할 수 없으므로, 회사 코드로 명시적으로 다시 입장할 때는 인증 요청 전에 기존 로컬 미확정 요청을 모두 정리하며 실패하면 입장을 진행하지 않는다. 기존 로그인 쿠키가 유효한 브라우저 종료·재시작에서는 이 정리를 실행하지 않아 같은 일반 메시지의 수동 복구를 유지한다.

구현 독립 리뷰 2차 PASS: 이전 HIGH 3건 모두 해소 확인. 변경 없는 부분의 1차 리뷰 결과를 재사용했다. 실제 joined socket의 lease 만료·topic 교체·session 삭제 발행 중단, 같은 controller 인증 지연·거절, 정리 실패 시 명시 입장 차단을 확인했다. 2,000개×1KiB 합성 이력의 1440/390 폭에서 DOM23개, 재입장218/207ms, 타이핑20회의 기존 Markdown 추가 파싱0회, 원문 이동·자료 Dialog·스크롤 위치·가로 넘침 검사를 통과했다. 초기 전체 로드와 재입장 개선의 비교 기준은 동일 로컬 환경의 main f458252였다. 기존 bootstrap 그룹인터럽트 검사2건의 병렬 실행 타이밍 실패는 해당 파일39개 격리 재실행으로 해소했다.

구현 독립 리뷰 3차 PASS: 기존 E2E의 저장소 상세 검사를 고정 Dialog로 옮겨도 대상·epoch·소유자·저장소·세션 및 새 저장소 혼입 방지 검사가 유지됨을 확인했다. UNKNOWN 요약은 중단 수신 상태를 표시하고 실행 결과 미확인 설명은 상세 창에서 검증한다. 테스트가 정리된 과거 기록의 문구를 잘못 기대한 HIGH 1건은 실제 UNKNOWN 문구로 보완해 해소 확인을 받았다. 운영 코드는 2차 PASS 이후 변경하지 않았다.

최종 회귀: 기존 브라우저 14개는 전체 실행의 통과 결과와 UNKNOWN·저장소 상세 4개 재검사를 합쳐 통과했다. 상세 조회 응답 본문을 읽는 테스트 단계의 간헐 실패는 같은 코드의 4개 격리 재실행에서 재현되지 않았다. 운영 코드 수정으로 해결했다고 주장하지 않는다. 전체 typecheck와 production build는 통과했다.
