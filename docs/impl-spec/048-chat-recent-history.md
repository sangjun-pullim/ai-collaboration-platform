---
status: active
date: 2026-10-19
risk-surface: permission, public-api, db-schema
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 최근 채팅 우선 조회와 이전 기록 점진 로딩

## Context

사용자는 재입장 시 오래 기다리지 않고 최근 대화를 보고, 위로 스크롤할 때만 이전 기록을 불러오기를 요청했다. 현재 `RoomChatController.poll`은 `read-recovery`를 cursor 0부터 호출하고 이벤트 16개씩 오래된 순서로 자동 추가 조회한다. 기존 가상 목록은 DOM 수를 제한하지만 이 조회 비용을 줄이지 않는다.

첫 화면은 최근 이벤트 최대 40개를 시간순으로 표시한다. 이전 페이지도 최대 40개이며 응답 바이트 상한 때문에 더 적을 수 있다. 실행 상태 이벤트와 중복 답변을 합쳐 표시하므로 화면 메시지 개수는 이벤트 개수보다 적을 수 있다. 전체 과거 기록을 입장 시 자동으로 읽지 않는다. 실제 AI 입력은 이번 검증에서 실행하지 않는다.

## Affected Files

1. `supabase/migrations/20261019002700-chat-history-window.sql` — 현재 사용자·방 권한을 검사하는 최근/이전 기록 전용 RPC 추가. 기존 테이블과 기존 RPC 계약 유지.
2. `src/app/api/chat-history/route.ts` — 동일 출처·세션·요청 검증과 비공개 응답.
3. `src/features/investigation-coordinator/history-window-contracts.ts` — 최근/이전 요청, 범위·순서·바이트 제한 응답 검증.
4. `src/features/investigation-coordinator/history-window-service.ts` — 현재 사용자 사전 조건 확인 및 고정 RPC 호출.
5. `src/features/investigation-coordinator/history-window-client.ts` — 취소·시간 제한·응답 크기 제한 조회.
6. `src/features/investigation-coordinator/history-state.ts` — 최초 최신 범위 수용, 이전 범위 병합, 실시간 cursor와 이전 페이지 경계 분리.
7. `src/features/investigation-coordinator/room-chat-controller.ts` — 최신 초기 조회와 중복 없는 이전 페이지 요청, 기존 실시간 추가 조회 유지.
8. `src/features/investigation-coordinator/use-room-chat.ts` — 전용 조회 주입과 이전 페이지 동작 전달.
9. `src/features/investigation-coordinator/chat-history-cache.ts` — 호출자에서 실제 채팅의 캐시 읽기·쓰기를 우회한다. 재입장은 새 최근 범위를 검증하며 기존 캐시 구현 자체는 변경하지 않는다.
10. `src/features/investigation-coordinator/investigation-view.tsx` — 이전 로딩 상태·이벤트 전달.
11. `src/features/investigation-coordinator/chat-timeline.tsx` 및 `use-virtual-history.ts` — 상단 접근 시 이전 조회와 읽던 메시지 위치 유지, 이전 페이지 실패 재시도.
12. 관련 unit/integration/browser tests — 아래 Tests 참조.
13. `docs/API-SPEC.md`, `docs/FRONTEND-ARCHITECTURE.md`, `docs/DB-SCHEMA.md` — 구현 후 관련 정본 절만 갱신.

## Affected Dependents

- 기존 `contracts.ts`와 `packages/local-connector/src/workflow-contracts.ts`의 16개 history 계약은 변경하지 않는다. 연결기·준비 확인·복구 상태 조회는 기존 `read-recovery`를 계속 사용한다.
- `history-state.ts` 소비자 `chat-presentation.ts`의 답변·질문·과거 실행 상태 표시, `chat-history-cache.ts`, `RoomChatController`를 검사한다. 과거 페이지가 최신 snapshot이나 실행 상태를 되돌리면 안 된다.
- 이미지 manifest는 기존 첨부 조회로 가져온다. 이미지 바이트나 변경 가능한 첨부 상태를 불변 event에 넣지 않는다.
- 질문 원문 링크는 아직 로드되지 않은 경우 무응답으로 두지 않는다. 다음 이전 페이지를 명시적으로 불러올 수 있는 안내를 제공하고, 대화 전체를 링크 클릭만으로 무제한 재조회하지 않는다.
- `useVirtualHistory`의 안정적인 event key·최신 따라가기·hash 이동과 `InvestigationView`의 새 메시지 버튼을 유지한다.
- 문서 사본: 전체 이력·진입 조회 2곳은 `docs/FRONTEND-ARCHITECTURE.md:177,179`, 캐시 커서 재사용 1곳은 같은 문서 `:179`, 자동 전체 조회 4문장은 같은 문서 `:40` 두 문장과 `docs/planning/delivery-and-validation.md:68` 두 문장이다. 정본 frontend 절은 새 동작으로 갱신하고 delivery의 과거 측정 기록은 수정하지 않는다. `docs/API-SPEC.md:113,208`, `docs/DB-SCHEMA.md:126`, `docs/BUSINESS-LOGIC.md:223-225`의 기존 read/read-recovery 계약은 그대로 두고 새 전용 API를 별도로 기술한다. 문서 소유 조직은 unstated이며 변경 책임 범위는 이 저장소다. 검색은 docs 정본과 관련 guides/planning에 한정하고 archive는 변경하지 않는다.

## Implementation Steps

### [x] Step 1: 제한된 최근/이전 조회 계약과 DB 경계

- POST `/api/chat-history` 요청은 `protocol`, `expectedUserId`, `roomId`, `beforeSequence`(최근 조회 시 null)를 정확히 검증한다. 숫자는 안전한 정수이며 0 이하와 범위를 벗어난 커서를 거절한다.
- 기존 사람 read 경로의 현재 Auth·membership·scope/room 잠금·reconcile을 재사용한다. 새로운 넓은 권한이나 service-role 조회를 도입하지 않는다. 기존 읽기 결과의 현재 snapshot/recovery를 이용하되 이전16개 이벤트를 새 최근 페이지의 정본으로 잘못 사용하지 않는다.
- 같은 transaction에서 확정한 high-water 이하 최신 이벤트를 역순으로 최대40개 읽고 응답은 오름차순으로 반환한다. 이전 페이지는 `sequence < beforeSequence`인 엄격한 경계를 사용한다. `(room_id,sequence)` 기존 인덱스를 사용하고 OFFSET·전체 이력 집계를 피한다.
- 응답에는 최신 상태용 기존 검증 가능한 snapshot과 별도 window events·oldest/upper boundary·hasOlder를 둔다. 기존 read-recovery의 이벤트 배열 상한을 늘리지 않는다.
- 전체 JSON 응답은 256KiB 이내로 제한한다. 메타데이터를 먼저 계산하고 남은 예산에 맞는 연속된 최신 이벤트 부분만 선택한다. 한 이벤트도 담을 수 없는 비정상 응답은 오류로 처리하며 빈 페이지를 무한 재시도하지 않는다. Unicode 바이트 수로 검사한다.
- 복구 기록 조회 커서는 기존 read-recovery의 독립 커서로 유지한다. 새 snapshot의 recovery를 누락하거나 UNKNOWN·retired를 성공으로 바꾸지 않는다.
- 새 RPC는 공개 실행 기본 권한을 취소하고 authenticated에만 허용하며 함수 내부에서도 현재 접근을 검증한다. 롤백은 웹의 기존 경로 복원 후 새 함수만 제거하며 데이터 삭제는 하지 않는다.

### [x] Step 2: 최근 범위와 실시간 추가 조회 분리

- 초기화는 최신 범위 조회 1회로 화면을 채운다. 성공한 응답의 high-water까지 cursor를 설정하되 0부터 존재하지 않는 이벤트를 누락으로 판단하지 않는다. 범위의 연속성·방·중복 ID 검증이 선행한다.
- 이후 실시간 알림과 정기 재확인은 기존 `read-recovery(afterSequence=liveCursor)`를 사용한다. 최신 범위 이전의 미로딩 기록은 live gap과 구분한다. 실제 최신 이벤트 중간 누락은 기존 추가 조회로 복구한다.
- 이전 조회는 live cursor를 변경하지 않는다. 지연된 이전 응답도 현재 snapshot을 덮어쓰지 않는다. 이전 조회 중 받은 새 메시지와 서로 덮어쓰거나 중복되면 안 된다.
- 최초 인증 확인 전 캐시를 표시하지 않는다. 재입장에서는 캐시 전체를 다시 렌더링하지 않고 새 최근 범위를 가져오며, 오래된 요청은 generation/AbortController로 폐기한다. 로그아웃·방 전환·권한 철회 시 이전 요청도 취소하고 숨긴다.
- 이전 페이지 요청은 한 번에 하나만 실행한다. 실패 시 기존 화면과 커서를 보존하며 명시적 재시도 UI를 제공한다. 첫 화면이 상단과 하단에 동시에 닿는 작은 방에서 전체 기록을 연쇄 자동 조회하지 않는다.

### [x] Step 3: 상단 로딩과 스크롤 안정성

- 사용자가 위로 이동해 상단 근처에 도달했을 때만 이전 페이지를 요청한다. 키보드·터치·휠 모두 지원하며 버튼 재시도도 제공한다.
- prepend 전 보이는 첫 메시지 ID와 viewport 내 위치를 유지한다. 가상화의 측정값 변동과 이미지 늦은 로딩에도 이전 위치가 과도하게 이동하지 않도록 기존 anchor 기능과 중복 보정을 피한다.
- 아래에서 최신을 읽는 사용자는 기존 follow 동작을 유지한다. 과거 기록을 읽는 사용자는 새 메시지가 와도 아래로 강제 이동하지 않는다.
- 아직 불러오지 않은 원문으로 이동하려는 경우 이전 내역 로딩 안내를 보여 준다. 과거 데이터를 현재 상태라고 오인시키는 안내를 만들지 않는다.

### [ ] Step 4: 검증·문서·배포

- 아래 필수 검사를 수행하고 독립 reviewer가 권한·커서·상태·경쟁 조건을 검토한다. 수정 후 영향받는 검사를 반복한다.
- 기존 승인된 운영 배포 절차로 DB 확장 → 웹 배포 순서로 반영한다. 기존 복구 수정 PR65가 배포에서 빠지지 않도록 배포 통합 기준을 확인한다. main 병합은 별도 명시적 승인 없이 하지 않는다.
- 테스트용 로컬 DB만 필요할 때 실행하고 검증 종료 후 정리한다. 사용자 실행 기록이나 운영 채팅을 삭제하지 않는다.

## Tests

- 새 계약: 잘못된 필드·순서·중복·방·cursor·상한·UTF-8 payload·응답 초과 거절.
- SQL 통합: 10,000개 합성 이벤트에서 최초 최신 최대40, 이전40, 끝페이지, 빈방, 페이지 사이 새 이벤트 삽입, 남의 방/observer/정지 계정/사용자 교체, 기존 read-recovery 응답 호환.
- controller: 초기 한 페이지 이후 과거 자동 전수조회 0회, upward demand마다 한 페이지, 중복 scroll 합치기, 실패 후 동일 경계 재시도, 재입장·late response·권한 상실, 실시간 gap 복구와 retirement cursor 독립성.
- history: 초기 floor에서 연속성, prepend 후 live cursor 불변, 최신/이전 응답 역순 도착, event identity 충돌 거절, 최신 runs/snapshot 보존.
- 브라우저: 1440/390px, 최근 메시지 첫 표시, 상단 추가 후 읽던 메시지 유지, 이미지/Markdown 높이 변화, 새 메시지 알림과 최신 따라가기, 미로딩 원문 링크 안내.
- 수용 기준: 첫 조회량은 방 총이력과 무관하게 최대40·256KiB, 사용자가 과거 이동을 하지 않으면 과거 event 페이지 추가 요청 없음. 로컬 합성 10,000개에서 초기 메시지 표시를 위한 API 요청1회. 실제 운영 지연은 별도로 측정하고 보장하지 않는다.

## Risks

- 최근 범위를 cursor0부터 연속 기록으로 취급하면 무한 backfill이 된다. 범위 floor와 live cursor를 분리하고 실패 재현 테스트로 고정한다.
- 과거 페이지가 최신 실행 상태를 덮어쓰면 중단·복구 표시가 틀린다. snapshot freshness 및 같은 요청의 최신 상태 우선 규칙을 유지한다.
- 새 API의 권한 검증 누락은 다른 방 노출로 이어진다. 기존 권한 경로 재사용과 실제 DB/HTTP 거절 검증이 필수다.
- UI 페이지 크기40은 표시 메시지40을 보장하지 않는다. 내부 상태·중복 이벤트 제외와 바이트 예산에 따라 적게 보일 수 있다.

## Verification

- `npm run format`, `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- 신규 격리 DB 통합 테스트 및 해당 브라우저 테스트. 기존 연결기 계약 변경이 없으면 지난 연결기 전체검사 결과를 재사용한다.
- 독립 계획·구현 리뷰, 운영 migration/배포 상태와 실제 배포 파일 확인.

## Review Notes

독립 reviewer 계획 검토 완료. CRITICAL/HIGH 차단 지적 없음. 기존 최신32 run 요약에 없는 과거 상태도 oldest부터 live high-water까지 연속 범위를 유지하면 이후 terminal 이벤트를 이미 보유하므로 sequence 우선 규칙으로 보존할 수 있음을 확인했다.

구현 리뷰 1회차: 마지막 이전 페이지에서 목록 앞의 버튼 영역이 사라져 읽던 메시지가44px 위로 이동하는 지적을 ACCEPTED했다. 실제 브라우저 테스트 `should preserve the reading anchor when the final older page removes the loader`에서 delta -44로 재현했다. 마지막 페이지에서도 같은 높이에 `대화 시작`을 표시하여 가상 목록의 시작 위치를 유지한다. 2회차 독립 reviewer가 RESOLVED를 확인했다.

같은 1회차의 최근 초기화 분기 이후 gap 복구·독립 정리 커서 검증 누락도 ACCEPTED했다. 초기61..100/정리32 → 이벤트102 먼저 도착/정리64 → 이전21..60 → 이벤트101복구를 controller 테스트로 추가했다. cursor102·정리64·gapfalse·이전floor21을 확인했다. 2회차 독립 reviewer가 RESOLVED를 확인했다. 다른 C/H 지적 없음. 변경되지 않은 권한·계약 코드는 1회차 리뷰를 재사용했다.
