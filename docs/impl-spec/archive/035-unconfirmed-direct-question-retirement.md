---
status: done
date: 2026-10-13
risk-surface: permission, db-schema, public-api
approval: approved
---
> NOTE: 이 문서는 구현 계획이다. 현재 구현의 증거가 아니며, 완료·보관 전까지 같은 파일을 갱신한다.

# 종료 미확인 직접 질문을 이전 기록으로 정리

## Context

질문 #9는 중단 요청이 접수됐지만 원래 실행의 종결 보고가 없어 현재 상태 카드와 방의 새 질문 차단에 계속 남는다. 기존 기능에는 이 요청을 보존하면서 현재 대화에서 분리하는 소유자 제어가 없다. 실제 Claude 이력을 별도로 확인한 결과 해당 입력 뒤의 최종 답변 본문도 발견하지 못했다. 다른 입력의 답변을 대신 표시하지 않는다.

목표는 대상 AI 소유자가 만료된 직접 질문을 **이전 요청 정리**로 분리하는 것이다. 물리적인 실행 종료와 대화에서의 분리를 구분한다. 원래 기기를 서버에서 해제한 경우에만 허용하며, 원래 질문·UNKNOWN·시도·중단 제어·receipt·예산·로컬 이력을 보존한다. 정리 후 다른 준비된 연결에 명시적으로 새 질문을 보낼 수 있다. 정리를 실제 성공·실패·중단으로 표시하거나 이전 입력을 자동 재실행하지 않는다.

기존 읽기 전용 범위 조사(`/private/tmp/ai-collab-stop-feedback-20261013-llna9e4v/retirement-scope-report.json`)의 서버 차단 위치와 종결/취소 구분을 재사용했다. 추가로 현재 main `edb559d34f8810b7b6f0539c04dbfdf6d6920f2b`의 strict 계약 검증·사용자별 저장·화면 차단을 확인했다. 운영 DB의 읽기 전용 조회에서 질문 #9는 DIRECT·UNKNOWN, 기한 만료, 원래 device=revoked, attempt=UNKNOWN/start_intent 있음, cancel=REQUESTED로 확인했다. 기존 기기 해제는 완료됐으며 현재 cycle은 아직 분리되지 않았다. 개인 토큰·질문 본문·로컬 경로는 조회/출력하지 않았다. 원래 기기가 해제되지 않은 일반 RUNNING을 숨기는 기능, 개인 파일 삭제, 실제 Claude 추가 입력, AI_PAIR 자체를 정리하는 기능은 범위 밖이다.

## Affected Files

1. `supabase/migrations/20261013001900-unconfirmed-direct-question-retirement.sql` — 새 정리 기록·권한·새 RPC와 공통 차단 판정. 이전 SQL은 수정하지 않는다.
2. `src/features/investigation-coordinator/contracts.ts` — `read-recovery`, `retire` 요청/응답 및 회복 조회 타입·검증.
3. `packages/local-connector/src/workflow-contracts.ts` — 기존 웹 계약 사본과 동일하게 갱신. 기존 `read`·기기 요청 계약은 그대로 유지한다.
4. `src/features/investigation-coordinator/direct-intents.ts` — retire의 사용자/방별 정확한 operation 보존·수동 재확인.
5. `src/features/investigation-coordinator/room-chat-controller.ts` — 회복 조회·정리 응답 검증·조회 실패/방 이동 보호.
6. `src/features/investigation-coordinator/history-state.ts` — 조회된 정리 기록을 같은 방 안에서 누적하며 늦은 과거 조회가 최신 상태를 되돌리지 않게 한다.
7. `src/features/investigation-coordinator/chat-presentation.ts` — 정리된 요청은 간결한 과거 기록으로 표시하고 종료로 해석하지 않는다.
8. `src/features/investigation-coordinator/chat-timeline.tsx` — 과거 요청의 상태 상세를 펼쳐 볼 수 있게 유지한다.
9. `src/features/investigation-coordinator/request-retirement-controls.tsx` — 정리 안내와 확인 dialog를 담당하는 작은 컴포넌트.
10. `src/features/investigation-coordinator/investigation-view.tsx` — 정리 컴포넌트 연결·새 질문 차단의 서버 판정 사용.

기존 API 라우트와 service는 humanActions 및 RPC 이름 변환을 사용하므로 신규 action이 통과하는지 확인하며 불필요하게 편집하지 않는다. 계획한 운영 코드 10개를 넘어서는 변경이 필요하면 승인한 목적 안의 필수 보정을 보고한다.

## Affected Dependents

- `src/app/api/investigations/[action]/route.ts`, `src/features/investigation-coordinator/service.ts`, `request-policy.ts`, `investigation-client.ts`, `rpc-response-policy.ts` — 인증·회사 입장·strict body/response·오류를 유지한다.
- `src/features/investigation-coordinator/use-room-chat.ts`, `advanced-controls.tsx`, `chat-composer.tsx` — 동일 controller·역할·동시 제어·명시적 전송 규칙.
- `supabase/migrations/20261002000700-human-direct-questions.sql:139,288,334,436` — 직접 중단·조회·ask 차단·reconcile. `20261001000600-durable-investigation-coordinator.sql:269`의 현존 `human_006` — start·pause·room resume 차단.
- `supabase/migrations/20261002000800-human-direct-actor-precondition.sql:5` — 실제 로그인 사용자와 expectedUserId를 대조하는 원칙. 신규 정리에서도 같은 원칙을 적용한다.
- `supabase/migrations/20261004000900-team-code-entry.sql` — guard와 live를 통한 회사 입장 및 현재 멤버 권한. 신규 RPC가 이를 우회하지 않는다.
- `supabase/migrations/20261005001000-owner-local-ai-setup.sql:165` — 최신 `history_006`는 strict v1 조회를 생성한다. **기존 read 응답에 새 필드를 추가하지 않는다.** 이전 CLI·웹이 요청하는 read는 계속 파싱된다.
- 원래 기기의 poll·claim·관찰·업로드와 runtime 설정 예약 — 인증·세대·로컬 UNKNOWN 보호를 유지한다. 새 기기는 다른 device/agent identity로 준비한다.
- 테스트: 기존 human-direct·workflow·계약 사본 일치·history-state·chat-presentation·controller 테스트와 fixture를 사용한다.

이번 규칙의 문서 사본은 `docs/`의 표준 문서·guides·planning을 UNKNOWN/미종결/중단/새 질문으로 검색했다. 직접 관련 정본은 이 저장소가 소유한다. 미확인 실행의 차단·종결 구분은 `BUSINESS-LOGIC.md:13,42,56,159,161,163`, `DB-SCHEMA.md:81,97,112`, `FRONTEND-ARCHITECTURE.md:24,86,92`, `guides/onboarding-and-settings.md:89,142,305`에서 확인했다. 각 절은 원래 로컬 실행의 차단을 유지하고 서버에서 명시적으로 정리한 DIRECT만 대화 차단에서 제외한다고 구분한다. API의 내구 조사 절과 DB의 내구 질문 절에 신규 정리 계약을 기록한다. `planning/delivery-and-validation.md`만 진행 상태의 정본이며 README는 링크만 추가한다. 보관된 impl-spec은 의도/이력이며 수정하지 않는다. 외부 팀 문서와 개인 지침은 조사/편집 범위가 아니다.

## Implementation Steps

### [x] Step 1: 실패 재현과 서버 정리 정본

**File**: 새 SQL019, `tests/integration/direct-question-retirement.test.ts`, 기존 helpers

- 해제된 대상 기기의 UNKNOWN 직접 질문이 현재 카드와 새 질문을 계속 막는 재현 테스트를 먼저 실패시킨다.
- `workflow_private`에 request당 하나의 immutable 정리 기록을 둔다. request·cycle·attempt/fence·대상 device/agent/epoch·정리한 사용자·시각·방별 정리 번호를 연결한다. request primary key와 unique(room_id, retirement_sequence) 인덱스를 둔다. 같은 방 잠금 아래 max(retirement_sequence)+1을 할당하고 safe integer 상한을 검증한다. 정리 번호는 기존 이벤트 번호와 독립적이며 rollback된 번호를 건너뛰지 않는다. request/attempt의 복합 FK 또는 동등한 트랜잭션 검증으로 다른 시도와 연결하지 못하게 한다. 사용자/기기의 물리 삭제로 이력 소유 증거가 사라지지 않도록 기존 과거 식별자 관례를 따른다.
- private schema/table/function에 public·anon·authenticated 직접 권한을 주지 않는다. public RPC는 authenticated만 허용하고 security definer의 search_path를 비운다.
- 기존 guard → scope → room 잠금 순서로 직렬화한다. 실제 Auth 사용자 = expectedUserId, 현재 쓰기 멤버, request의 원래 대상 AI 소유자여야 한다. room owner 역할만으로 다른 사람의 AI를 정리할 수 없다.
- DIRECT/PEER·정확한 cycle/agent/epoch·현재 UNKNOWN request와 UNKNOWN attempt·start_intent 존재·직접 질문의 유효 기한(min(request.deadline, cycle.deadline)) 만료·원래 device 행의 실제 revoked를 확인한다. 삭제/단순 만료/네트워크 단절/초록 표시/중단 ACK는 revoked 또는 종료의 대체 증거가 아니다.
- 기존 cancel의 유실 응답 복구도 보완한다. 현재 Auth·회사 입장·쓰기 멤버 및 저장된 cycle/request의 원래 질문자 또는 대상 소유자 관계를 먼저 확인한다. 그 다음 기존 동일 operation/action/payload hash의 receipt를 반환한다. 이 복구에서는 retired_at, 현재 target 행/epoch, 원래 device revoked 또는 달라진 expectedRoomRevision으로 이미 접수된 결과를 거절하지 않는다. 기존 SQL008의 expectedUserId 검증과 제거 뒤 본문 hash는 그대로 유지한다. receipt가 없는 새 cancel에만 현존 대상/epoch/미정리 cycle·revision 조건을 검사하며, 본인 관계인 정리된 요청의 새 cancel은 CONFLICT로 거절해 실제 방 접근을 잃은 것으로 처리하지 않는다.
- operationId+정확한 본문의 receipt를 남긴다. 같은 사용자·방의 동일 operation 재확인은 상태가 바뀌어도 원래 정리 결과를 반환하되 현재 인증/접근은 재확인한다. 다른 본문 재사용은 CONFLICT다.
- 정리 기록을 추가하고 cycle.retired_at만 설정한다. 원래 UNKNOWN·종결·텍스트·예산·control·source/receipt는 변경/삭제하지 않는다. 최초 정리에 방 revision을 증가시켜 기존 expectedRoomRevision과 늦은 snapshot을 무효화한다. 실제 현재 기기를 자동 해제하지 않는다.

### [x] Step 2: 방 차단의 단일 판정

**File**: 새 SQL019

- 정확한 정리 기록에 연결된 요청/시도만 대화의 미종결 작업에서 제외하는 private 판정 함수를 정본으로 둔다. 일반 HISTORICAL 또는 cycle.retired_at만으로 제외하지 않는다.
- 현재 `human` ask의 방 요청/시도 검사 2개, `human_006` start·resume의 요청/시도 검사, pause 순회, reconcile의 요청 순회·PAUSING 종료 검사를 이 판정에 연결한다. interrupt의 대상 선택에서도 정리한 요청을 다시 현재 작업으로 선택하지 않는다. 모두 기존 live/revision/준비/예산/방 mode 규칙을 유지한다.
- AI_PAIR 내부 advance·동일 시도의 UNIQUE·기기 claim/credential·로컬 UNKNOWN 및 원래 기기의 설정 변경 보호를 완화하지 않는다. 정리 기록의 DIRECT 경계가 다른 cycle에 예외를 만들지 않게 한다.
- 원래 기기가 revoked인 이상 늦은 업로드는 기존 인증 오류로 거절한다. 정리나 다른 방의 새 작업이 원래 입력을 채택하거나 continuation을 만들지 않는다.

### [x] Step 3: 호환되는 회복 조회와 정리 계약

**File**: 계약 사본 2개, SQL019, 계약 테스트/fixture

- 기존 `read`는 입력/응답/이벤트 종류를 변경하지 않는다. strict 계약의 구 버전 연결기가 계속 조회할 수 있어야 한다. protocol은 1을 유지한다.
- 새 `read-recovery`는 protocol/roomId/afterSequence/afterRetirementSequence를 정확히 검증한다. roomId/afterSequence로 기존 인증된 read를 수행하고, **동일 방 잠금** 안에서 recovery를 더해 반환한다. observer도 읽을 수 있지만 정리 권한을 주지 않는다. 회복 조회는 기존 read의 모든 필드와 `{hasBlockingRuns, candidate, retirements, nextRetirementCursor, highWaterRetirementSequence, hasMoreRetirements}`를 포함한다.
- candidate는 현재 DIRECT UNKNOWN의 request/cycle/attempt/fence/agent/epoch를 식별하고, 대상 소유자에게만 정리 가능 여부와 기존 기기 해제 필요 여부를 제공한다. 다른 사람에게 개인 경로나 native ID·토큰을 제공하지 않는다.
- retirements는 해당 방에서 afterRetirementSequence보다 큰 정리 번호를 오름차순 최대32개 반환한다. nextRetirementCursor는 반환한 마지막 번호 또는 입력 커서이며, highWaterRetirementSequence는 방의 마지막 확정 번호다. 입력 커서가 highWater를 넘으면 CONFLICT다. sequence/requestId/cycleId/agentId/epoch/retiredAt만 공개하고 로컬 근거는 공개하지 않는다. 최신 snapshot에 없는 요청과 이미 읽은 옛 질문의 정리도 이 별도 커서로 빠짐없이 조회한다. hasBlockingRuns는 방 전체를 서버에서 계산하므로 32개 조회 제한이나 과거 이력 누락으로 새 질문을 잘못 허용하지 않는다.
- 새 `retire` 입력은 protocol/roomId/operationId/expectedUserId/expectedRoomRevision/requestId/cycleId/attemptId/fence/agentId/bindingEpoch/confirmed:true를 정확히 검증한다. 응답은 해당 식별자·정리 sequence·retiredAt·확정 roomRevision과 `state:"RETIRED_UNCONFIRMED"`를 포함하며 실제 terminal은 만들지 않는다.
- 새 RPC의 body 크기16KiB·응답 제한과 UUID/safe integer 검사를 유지한다. action/service/라우트와 양쪽 계약을 실제 fixture로 확인한다.

### [x] Step 4: 화면 정리와 유실 응답 복구

**File**: direct-intents·controller·history-state·presentation·timeline·request-retirement-controls·investigation-view

- controller의 기존 순차 poll에서 read-recovery를 요청한다. 같은 방의 이벤트 커서와 정리 커서를 각각 유지하고 응답의 어느 쪽이든 hasMore이면 기존 추가 이력 조회로 다음 페이지를 받는다. 정리 표지는 각 페이지에서 누적하며 새로운 방/계정에서는 두 커서를 초기화한다. 원래 event schema와 이벤트 번호는 변경하지 않는다. 자동 조회 주기·동시 호출 제한·방/계정 변경 generation 보호는 유지한다. 신규 endpoint 미배포/조회 실패는 화면에서 오류로 표시하며 차단을 임의 해제하지 않는다.
- retire 의도를 기존 사용자/방별 sessionStorage에 보관한다. 전송 전 정확한 본문을 저장하고 유실 시 **같은 요청 확인**만 허용한다. 새 operation 자동 재시도나 질문 재입력을 하지 않는다.
- 현재 카드에 대상 소유자용 **이전 요청 정리**를 제공한다. 기기를 먼저 해제해야 한다면 **내 AI 연결에서 이전 기기를 해제하세요**와 연결 페이지 링크를 표시한다. 기존 중단 버튼의 접수 상태는 그대로 유지한다.
- 정리 안내/확인 상태는 request-retirement-controls의 책임으로 두고 기존 큰 view에는 연결만 추가한다. dialog는 사용자/방 및 request/cycle/attempt/fence/agent/epoch를 고정하며, 관찰 중 대상/방 revision이 바뀌면 재확인을 요구한다.
- 확인창에는 “이 질문을 답변 미확인 상태로 이전 기록에 보관합니다. 실행 종료를 확인한 것으로 처리하지 않으며 질문을 다시 보내지 않습니다.”를 표시한다. 취소하면 아무 변경도 없다.
- 검증된 정리 성공의 식별자·sequence·retiredAt를 해당 actor/room의 정리 표지에 반영해 일치하는 현재 카드는 즉시 제외한다. 새 질문은 응답의 확정 roomRevision 이상을 관찰한 회복 snapshot을 받은 뒤에만 활성화한다. 다음 조회가 실패하면 정리 성공과 조회 오류를 표시하되 새로운 목표를 자동 선택하거나 stale snapshot으로 새 질문을 허용하지 않는다. 늦은 다른 방·계정의 응답을 채택하지 않는다.
- 최신 snapshot과 별도 정리 커서·누적 정리 표지를 유지하고 오래된 backfill이 이를 지우지 않게 한다. 현재 카드에서 제거하고, 이전 질문에는 **답변 미확인 · 이전 기록**을 간결하게 표시한다. 상세를 펼치면 마지막 상태·중단 접수·정리 시각을 확인할 수 있다. UNKNOWN을 COMPLETED/INTERRUPTED로 바꾸지 않는다.
- 새 질문·공동 조사·방 재개의 차단에는 서버 hasBlockingRuns를 쓴다. 현재 기기 초록 표시와 상대 AI의 준비 상태는 별개로 유지한다. 준비된 상대가 없으면 기존 설정 안내를 계속 보여준다.

### [x] Step 5: 검증·독립 리뷰

**File**: 아래 Tests의 기존 러너와 fixture

- 안전한 소유 로컬 DB에서 현재018 → 신규019 적용/업그레이드와 RPC를 검증한다. 기존 중단된 Kong 또는 HostIp가 빈 container를 자동 재시작하거나 외부로 노출하지 않는다. 필요하면 고유 project ID의 loopback 격리 테스트 stack을 만들고 소유 리소스만 정리한다.
- 실제 React 화면의 desktop/mobile에서 현재 카드 제거·과거 기록·새 질문·역할·취소·조회 실패를 검증한다. 실제 AI 입력은0회이며 기존9회 상한을 늘리지 않는다.
- 새로운 독립 reviewer가 SQL/권한/계약/프런트엔드와 테스트를 검토한다. 최대3회, 같은 규칙의 연속 차단 지적은 AGENTS.md의 중단/설계 재검토 규칙을 따른다. CRITICAL/HIGH를 해소하기 전 병합하지 않는다.

### [x] Step 6: 문서·PR·배포

**File**: 관련 docs 정본, 이 계획의 진행 표시

- 관련 정본의 변경 절을 갱신한다. 진행 수치/실행 근거는 delivery-and-validation 한 곳에 기록한다. 보관된034와 개인 설정/next-env.d.ts/실패 실행 파일은 유지한다.
- root format/format:check 후 논리적 source/doc 커밋과 PR을 준비한다. 기존 명시적 정상 main 병합·배포 승인을 사용하며 --admin·직접 main push·자동 병합은 쓰지 않는다.
- 검토한019의 hash·기존18개 적용 상태를 확인한 뒤 cloud DB에019만 적용한다. 운영 데이터에 임의 SQL로 #9의 상태를 바꾸지 않는다. 사용자 본인이 웹에서 정리하도록 한다.
- 정확한 main SHA의 Vercel Production READY·공개 웹·배포된 read-recovery/retire 계약과 기존 연결 다운로드를 확인한다. 완료 계획을 archive로 이동하고 main 포함 확인 뒤 소유 브랜치/검증 프로세스/리뷰 pane을 정리한다.

## Tests

- `tests/integration/direct-question-retirement.test.ts`: 승인 전 새 ask 차단; 정확한 revoked 기기와 expired UNKNOWN만 정리; requester/다른 owner/observer/이탈 멤버/쿠키 사용자 교체 거절; live·만료만·삭제된 기기 거절; 잘못된 attempt/fence/epoch/cycle 거절; 원래 데이터·예산 불변; 같은 operation 복구와 다른 본문 거절; cancel 응답 유실 → 대상 소유자의 다른 브라우저에서 정리 → 기존 질문자의 같은 cancel operation 재확인 시 원래 REQUESTED 복구와 방 권한 유지; 정리 후 같은 방의 새 binding으로 명시적 질문 허용; pause/resume/start 일관성; 타 UNKNOWN은 계속 차단; 늦은 원래 업로드 거절; terminal 도착/정리·기기 해제/정리 경합.
- `tests/unit/human-direct-contracts.test.ts`, `workflow-contracts.test.ts` 및 기존 계약 fixture: 신규 strict 입력/응답과 부적합 조합·한도 거절, 사본 일치, 기존 read/CLI 계약 유지.
- `tests/unit/human-direct-intents.test.ts`, `room-chat-controller.test.ts`: retire 같은 operation 재확인·저장 실패·유실 응답·계정/방 전환·역할·응답 식별자 검증·정리 뒤 조회 실패; 기존 cancel 유실 재확인이 정리 후에도 이력을 비우거나 polling을 중단하지 않음.
- `tests/unit/investigation-history.test.ts`, `chat-presentation.test.ts`: 정리 표지 누적·늦은 조회 역행 금지·이미 읽은 질문의 정리 조회를 놓친 뒤 최신 UNKNOWN32개 밖으로 밀려도 독립 커서로 수신; 여러 정리 페이지·중복/역순 페이지·초과 커서 거부; 같은 highWaterSequence에서 높은 roomRevision의 최신 snapshot 유지; 32개 밖의 다른 UNKNOWN 차단·기존 중단 ACK 표시·과거 기록과 현재 카드 구분.
- 기존 browser fixture 또는 별도의 격리된 React 제품 화면 검증: desktop/mobile에서 소유자 정리 확인/취소, 관찰자 제어 없음, 새 질문 준비 상태 및 과거 상세 보존.

## Risks

- 정리는 Mac 프로세스의 종료 증거가 아니다. revoked인 원래 기기의 중앙 실행 권한을 차단하고 원래 로컬 UNKNOWN은 유지한다. 로컬 현재 기기 설정 보호를 완화하지 않는다.
- read에 필드를 무조건 추가하면 기존 strict CLI가 실패한다. 새 read-recovery로 명시적으로 선택하고 기존 read를 유지한다.
- 서버와 화면이 다른 차단 규칙을 쓰면 영구 차단 또는 중복 실행이 생긴다. 정확한 정리 기록 기반의 서버 판정을 정본으로 사용한다.
- 추가 DB 변경 후 웹 실패는 원래 조회가 계속 동작하도록 확장 변경으로 제한한다. 되돌리기는 검증된 이전 웹을 재배포하고 retire RPC의 authenticated 권한을 철회해 새 정리를 막되 기록과 이전 SQL은 지우지 않는 방식이다. 이미 정리한 요청은 복구처럼 재실행하지 않는다.

## Verification

- 프로젝트 기존 test/typecheck/lint 및 connector build/typecheck, 계약 사본 검사, build:local-connection/production build.
- 기존 러너의 관련 integration과 소유 DB의018→019 upgrade, 새 RPC 역할/경합/중복 테스트.
- desktop/mobile 제품 화면 검증; `npm run format`, `npm run format:check`, `git diff --check`.
- independent review C0/H0, cloud migration hash/version, GitHub 정상 merge, Vercel 정확한 main SHA READY와 공개 웹 검사.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 1차 #1: 최근 run/event 참조만 조회하면 정리 이력을 누락 | HIGH | ACCEPTED | 방별 immutable 정리 번호와 독립 커서·32개 페이지를 추가했다. snapshot 밖으로 밀린 이미 읽은 질문과 다중 페이지를 검증한다. |
| 1차 #2: 정리 후 기존 cancel receipt 복구가 FORBIDDEN | HIGH | ACCEPTED | 현재 인증/원래 소유 관계 검사 다음에 동일 기존 receipt를 복구하고, 현재 자격은 신규 cancel에만 검사한다. 신규 본인 요청의 정리 상태 충돌은 CONFLICT다. 통합/controller 회귀를 추가한다. |
| 1차 INFO: 기존 이력 테스트 파일명 | INFO | ACCEPTED | investigation-history.test.ts를 재사용하도록 바로잡았다. |
| 구현 1차: 누적 정리 기록을 실행마다 배열 탐색 | MEDIUM | ACCEPTED | requestId별 정리 Map을 추가했다. 최신583/583·위험/화면16/16을 확인한 새2차 리뷰에서 해소됐다. 변경 없는 SQL/권한/계약/controller/화면/정본 검토는 재사용했다. |
| 2차 독립 계획 검토 | INFO | PASS | 새로운 gpt-6.1-sol xhigh reviewer가 C0/H0 및 추가 지적 없음으로 확인했다. 1차의 변경 없는 revoked/원래 소유자/UNKNOWN 보존/공통 차단/기존 read 검토를 재사용하고 독립 커서·cancel 복구·응답/확인 컴포넌트를 추가 검토했다. 2026-10-13 사용자가 이 계획대로 구현·검증·배포를 승인했다. |
| 구현 2차 독립 검토 | INFO | PASS | 새 gpt-6.1-sol xhigh reviewer가 표시 최적화와 추가 권한/경합 fixture·검증문·통과 로그를 검토해 C0/H0/M0/L0으로 확인했다. 기존 코드/문서 검토와 독립 커서·cancel 복구 해소 판정을 재사용했다. 최신 production build·실제 브라우저·format/check도 통과했다. |

## Delivery Evidence

- 정상 main 병합: [PR20](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/20), main `63aaccc74f1d62f18ecb41a3cefd48db7250b08a`.
- Supabase019 적용: 기존18개 보존, 총19개. 검토 소스 SHA256 `af9af74c1fab59a4a357938bdaf723bb4bf1f3c88ce2c31788b986fd3df78283`, 기존018 실행 함수·신규 권한 확인.
- Production `dpl_343srYg7w2x8kDnjhRzrUGMBuznD` READY와 정확한 main SHA를 공식 CLI·GitHub deployment·Vercel 조회로 확인했다. 공개 접속/배포물/인증 거절9개를 통과했다.
- 질문 #9는 read-only 조회에서 UNKNOWN·이전 기록을 보존하며 본인 정리 조건을 확인했다. 운영자의 임의 정리는 실행하지 않았다.
- 전체 단위583/583, 실제 통합16/16, 기존 회귀6/6, 최신 production 화면·build/distribution·타입·lint·format/check, 새 독립2차 C0/H0/M0/L0. 실제 AI 추가 입력0회.
- 상세 진행/검증 수치는 docs/planning/delivery-and-validation.md가 정본이다. 완료 계획 보관과 정리 결과는 같은 작업의 종료 문서 커밋에 포함한다.
