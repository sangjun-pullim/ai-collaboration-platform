---
status: done
date: 2026-10-20
risk-surface: permission, db-schema, public-api
---
> NOTE: This plan records intended behavior. User approved implementation, verification, and deployment on 2026-10-20.

# 긴 응답 제한과 중단 원인 안내

## Context

질문 #380은 2분 응답 기한 전에 문서 내용 검사 오탐으로 중단됐다. 이 원인은 별도 국소 수정 `fix/repository-read-denial`로 처리한다. 이 계획은 추가로 요청된 응답 시간 연장과 정확한 시간초과 안내를 다룬다.

기준 구현은 배포 통합 커밋 `e687182`이다. PR65–69의 기존 기능을 유지한다. 기존 실행 UNKNOWN은 종료 증거가 아니며 자동 재전송하지 않는다.

## Affected Files

1. 새 `supabase/migrations/20261020003000-response-stop-diagnostics.sql` — 직접 질문 기한, 정합성 처리에서 최초 중단 관찰 저장, 읽기 전용 진단 RPC.
2. `packages/local-connector/src/workspace/repository-reader.ts` — 단일 저장소 탐색 15초→30초, 누적 실제 탐색 120초→300초.
3. 새 `src/features/investigation-coordinator/run-diagnostics-contracts.ts` — 독립 요청·응답 검증. 기존 workflow 계약 변경 없음.
4. 새 `src/features/investigation-coordinator/run-diagnostics-service.ts` — 현재 사용자·방 접근을 확인하는 RPC 호출.
5. 새 `src/app/api/run-diagnostics/route.ts` — 인증·동일 Origin·본문 크기 제한·비공개 응답.
6. 새 `src/features/investigation-coordinator/run-diagnostics-client.ts` — 제한된 요청·응답과 취소 가능한 읽기.
7. `src/features/investigation-coordinator/room-chat-controller.ts` — 상태가 바뀐 실행의 진단 조회·수명·늦은 응답 격리.
8. `src/features/investigation-coordinator/chat-presentation.ts` — 확인된 중단 원인·기한 표시.
9. `src/features/investigation-coordinator/investigation-view.tsx` — 상태 표시 데이터 연결.
10. `src/features/investigation-coordinator/chat-answer-status-panel.tsx` 및 `chat-timeline.tsx` — 기존 상태 표현 재사용. 별도 대형 패널 추가 없음.

## Affected Dependents

- 최신 직접 질문 생성은 SQL020 `human`의 137–149행이다. 이미지 SQL025·사용자 사전 조건 SQL008·미시작 복구 SQL028 wrapper를 유지한다.
- SQL006 `reserve_006`가 질문 기한을 실행 요청에 복사한다. 공동 조사 상대 질문의 SQL007 120초 제한은 변경하지 않는다.
- 최신 `reconcile`은 SQL019 548–646행이다. 기존 정리된 요청 제외·중단 제어·잠금 순서를 유지한다.
- 기존 `workflow` event/run 파서는 정확한 필드 수를 검사한다. 기존 응답에 필드를 덧붙이지 않고 독립 진단 endpoint를 사용한다. 구형 웹·연결기는 기존 계약으로 계속 동작한다.
- `RepositoryTools`는 전용 탐색 시간 오류를 내용 없는 실패 결과로 공급자에 반환한다. 연결 권한·임대·실제 종료 판단은 탐색 시간 연장으로 바뀌지 않는다.
- 문서 사본: 직접 질문 120초의 현재 설명은 검색한 정본·guides·planning에서 0개. `docs/BUSINESS-LOGIC.md:234`의 10분은 공동 조사이며 변경하지 않는다.
- 원인 미기록 안내는 `docs/FRONTEND-ARCHITECTURE.md:42`(소유: humanInputNotice), `docs/guides/onboarding-and-settings.md:179`(소유 미명시)에 2개 있다. 과거 기록은 여전히 미기록일 수 있다는 조건을 유지하여 갱신한다.
- `docs/ARCHITECTURE.md:195`는 전용 탐색 시간 오류의 공급자 반환을 설명한다. 이 계획에서는 시간 수치가 설명된 경우만 갱신한다. 내용 거절 처리 문서는 별도 국소 수정과 조정한다.
- 문서 탐색은 핵심 정본 7개와 관련 guides·planning·runtime research로 제한했다. archive·ADR·records 전수 검색은 하지 않았다.

## Implementation Steps

### [x] Step 1: 제한 시간 조정
**File**: 새 migration, `repository-reader.ts`

- 신규 직접 질문만 접수 시점부터 최대 10분으로 생성한다. DIRECT cycle의 기존 10분 기한을 넘지 않는다.
- 기존 질문·실행·미확정 기록의 기한은 소급 변경하지 않는다.
- 파일 탐색은 한 호출 30초, 누적 실제 탐색 300초로 늘린다. 바이트·경로·파일 수·동시 실행 제한은 유지한다.
- 실행 임대 갱신 주기·유효 시간은 늘리지 않는다. 긴 AI 응답과 연결 유실은 별개로 처리한다.

### [x] Step 2: 서버가 관찰한 원인 저장
**File**: 새 migration

- 비공개 requests에 nullable 최초 중단 관찰(`stop_reason`, `stop_observed_at`, 해당 attempt/fence 식별)을 추가한다. 허용 값은 RESPONSE_TIMEOUT, EXECUTION_LEASE_EXPIRED, BINDING_CHANGED, CONTEXT_CHANGED로 제한한다.
- 기존 정합성 처리의 실제 분기에서만 원인을 기록한다. 살아 있는 실행의 기한 초과와 실행 임대 만료를 구분한다. 같은 관찰에서 두 시간이 지났다면 더 먼저 도래한 경계를 기록한다. 동일 시각이면 임대 만료를 우선하여 응답 시간초과를 과대 주장하지 않는다.
- 이미 UNKNOWN인 이전 기록에 현재 시각을 대입해 원인을 추정하지 않는다. 최초 원인은 후속 조회로 덮어쓰지 않는다.
- 공동 조사에서 미시작 시도의 임대가 만료되어 같은 요청이 QUEUED로 복구되는 경우에는 중단 원인을 기록하지 않는다. 재큐잉 뒤 실제 실행에서 관찰된 중단 원인을 보존한다.
- 기한 초과는 종료 증거가 아니다. 기존 시작 전 취소/시작 후 UNKNOWN·중단 제어 처리와 완료·중단 영수증 판단을 유지한다.
- 기존 RUN_STATE·HUMAN_INPUT_REQUIRED 이벤트와 공개 workflow 응답 형태는 변경하지 않는다.

### [x] Step 3: 권한 있는 진단 조회
**File**: 독립 진단 계약·서비스·route·client

- 요청: protocol 1, expectedUserId, roomId, 최대 40개의 중복 없는 requestIds.
- 현재 세션 사용자와 expectedUserId를 대조한다. 현재 방 읽기 권한으로 모든 requestId를 검사한다. 다른 방 또는 권한 없는 요청을 한 개라도 포함하면 일괄 거절한다.
- 응답은 requestId, deadline, nullable 최초 중단 원인·관찰 시각만 제공한다. 기기 인증·폴더 경로·도구 인자·개인 오류 원문은 반환하지 않는다.
- 종료 상태를 변경하거나 작업을 재실행하지 않는 읽기 전용 RPC다. 기존 전역 쓰기 잠금을 추가하지 않는다.
- 현재 상태 진단이며 특정 과거 이벤트 당시의 원인이라고 표시하지 않는다. 기존 질문도 기한은 조회할 수 있지만 원인이 없는 기록은 null로 유지한다.

### [x] Step 4: 조회 수명과 안내
**File**: controller, presentation, view와 기존 상태 컴포넌트

- 현재 화면의 상태 표시 대상 요청만 최대 40개씩 조회한다. 새로 관찰된 상태·updatedAt 변경 때 필요한 대상만 갱신하고, 동일 상태를 매 폴링마다 중복 요청하지 않는다.
- 실행 상태·updatedAt이 그대로여도 해당 요청의 HUMAN_INPUT_REQUIRED·INTERRUPT_REQUESTED 이벤트나 관련 조사 상태 변경이 새로 관찰되면 진단을 재조회한다. 이벤트 식별자로 중복 갱신을 방지한다.
- 방·사용자 변경 및 접근 상실 시 진단 요청을 중단하고 저장 상태를 비운다. 늦은 응답은 사용자·방·controller 세대와 상태 관찰 시각을 대조하여 버린다.
- 일시적 진단 조회 실패는 일반 채팅·AI 실행·기존 이력 조회를 막지 않는다. 실패 후에는 기존 조회 주기의 지연을 이용한 제한된 재조회와 사용자 재확인을 제공하며 무한 즉시 재시도하지 않는다.
- 실행 중에는 확인된 응답 기한을 표시한다. 서버 원인이 RESPONSE_TIMEOUT이면 “응답 제한 시간 초과”, EXECUTION_LEASE_EXPIRED이면 “실행 상태 갱신 중단”, 기타는 연결/설정 변경으로 표시한다.
- UNKNOWN에는 원인과 별도로 “실제 종료 확인 대기”를 유지한다. 시간초과 자체를 성공·중단 완료·재질문 허용으로 바꾸지 않는다.
- 과거 원인 null은 “중단 원인 기록 없음”으로 표시한다. PC 통신 기록 만료 문구를 AI 응답 시간초과로 재사용하지 않는다.

## Tests

- 새 직접 질문의 120초 경과 후 정상 진행, 10분 경계 처리, 기존 질문 기한 불변, 공동 조사 120초 불변.
- 기한 이전 임대 상실과 임대가 살아 있는 기한 초과의 원인 분리; 최초 원인 불변; 이전 UNKNOWN 소급 분류 금지.
- 시작 전 취소와 시작 후 UNKNOWN 보존; 실제 종료 증거 없는 자동 재실행 0회; 뒤늦은 정상 종결 보고 보존.
- 실제 DB RPC의 사용자·방·참가자·관찰자 접근, 다른 방 requestId 혼합, 권한 철회, 비인증 요청 거절.
- 구형 웹/연결기의 기존 workflow 응답 파서와 신규 독립 진단 API 호환.
- 탐색 시간 15~30초 구간의 허용, 30초/300초 경계, 기존 용량·권한·취소 guard 우선 유지.
- 상태 변화를 따라 진단 갱신, 같은 상태 중복 조회 방지, 요청 유실 후 지연 재조회, 방 전환·계정 전환의 늦은 응답 차단.
- RUNNING·updatedAt 불변인 기한 만료에서도 중단 제어 이벤트 이후 null 진단이 RESPONSE_TIMEOUT으로 갱신됨.
- 공동 조사 미시작 임대 만료 → 재claim → 실제 실행 응답 시간초과에서 이전 시도의 임대 원인이 아닌 RESPONSE_TIMEOUT 반환.
- 원인별 화면 표시와 null 안내, 과거 40개 추가 조회·실시간 이력·중단 패널 크기 유지.

## Risks

- 응답 대기 상한이 늘지만 무제한은 아니다. 실행 임대·취소 처리·권한은 그대로 유지한다.
- 인증된 진단 API와 DB 변경이므로 독립 보안 리뷰 및 실제 DB 검증이 필수다.
- 운영 DB 함수는 최신 wrapper를 보존한 새 migration으로만 바꾼다. 기존 migration과 기존 기록은 수정하지 않는다.
- 사용자 동의 없이 중단된 질문을 재전송하거나 개인 연결 프로그램을 종료하지 않는다.

## Verification

- 수정 전 실패 테스트 → 최소 구현 → 관련 단위·연결기 테스트.
- 격리 DB에서 migration·권한·구형 계약·실제 시간 경계 검증. 소유한 테스트 컨테이너만 잠시 사용하고 종료한다.
- 프로젝트 포맷·타입·lint·운영 빌드, 독립 reviewer 검토.
- 상태 표시·진단 실패·재접속을 브라우저에서 검증한다. 외부 AI 호출은 필요하지 않으면 fixture로 대체한다.
- 검증된 작업 브랜치 PR을 준비한다. main 병합 없이 기존 통합 배포 변경을 보존하여 운영 배포한다.

## Review Notes

1회차 HIGH 2건 ACCEPTED. 구현 전 계획 검토이므로 해당 경로를 코드와 기존 통합 테스트로 대조했다.

- 실행 상태가 유지되는 중단 제어 이벤트에서도 진단 갱신이 필요함: Step 4에 이벤트·조사 상태 기반 재조회 및 검증을 추가했다.
- 미시작 공동 조사 재큐잉이 이후 실제 중단 원인을 가릴 수 있음: Step 2에서 재큐잉 시 원인 기록을 제외하고 회귀 검증을 추가했다.

2회차 독립 reviewer가 두 HIGH의 해소를 확인했다. 추가 차단 지적 없음. 기준 `e687182` 대조 결과를 재사용하고 수정된 계획과 영향 부분만 재검토했다. 2026-10-20 사용자가 계획대로 구현·검증·배포를 승인했다. 구현 기준은 문서 읽기 국소 수정까지 포함한 `1ce5cbb`이며 본 계획의 계약·정합성 경로는 동일하다.

구현 1회차 HIGH 2건 ACCEPTED. 첫 구현 검토이며 정지 조건에 해당하지 않는다.

- 다른 요청의 상태 갱신 때문에 진단 조회를 취소해도 재시도 횟수가 남는 문제: 상태가 일정한 요청이 3회 취소 뒤 영구 누락되는 경로를 먼저 재현하고, 의도적 취소가 실패 예산을 소모하지 않도록 보정한다.
- UNKNOWN 이후 늦은 정상 종결 검사가 기존 `complete` 제약을 위반하는 문제: 실제 DB에서 실패를 확인했다. 운영 제약은 유지하고 동일 attempt/fence의 기존 `observe(COMPLETED)` 경로로 검증을 보정한다.

MEDIUM: `docs/ARCHITECTURE.md:195`의 탐색 시간 설명이 이전 수치다. 리뷰 루프에서는 변경하지 않고 후속 문서 동기화 항목으로 남긴다.

구현 2회차 독립 reviewer가 두 HIGH의 해소를 확인했다. 추가 차단 지적 없음. SQL·권한·API의 1회차 검토는 재사용하고 변경된 controller와 통합 검사 및 영향 부분만 재검토했다. REJECTED 지적 없음.

검증 결과:

- 수정 전 진단 취소 회귀 검사 실패 확인, 수정 후 관련 43개 통과.
- 실제 격리 DB 통합 검사 10개 통과. 기존 자동복구 6개와 시간 경계·원인 불변·권한·늦은 종결·공동 조사 재큐잉 검증을 포함한다.
- 웹 전체 851개 중 첫 실행 850개 통과. 기존 종료 신호 타이밍 실패 1개는 격리 재검사에서 통과했다. 이후 controller 변경은 위 43개 검사로 재검증했다.
- 연결기 전체 1,309개 중 첫 실행 1,302개 통과, 실패 6개·취소 1개. 수정된 시간 제한 검사 42개와 관련 50개, 나머지 타이밍 실패 3개 및 취소 1개를 분리 재검사하여 모두 통과했다.
- 1440/390 브라우저에서 진단 실패 후 재확인·원인 표시·40px 상태 줄 유지 검증 통과.
- 타입·포맷·운영 빌드 통과. lint 오류 0개, 기존 `use-virtual-history.ts`의 React Compiler 호환 경고 1개 유지.
- 테스트용 개발 서버와 격리 Docker 컨테이너 6개 종료. 실제 사용자 AI 호출·질문 재전송·연결 종료는 수행하지 않았다.

인터페이스 영향: 신규 진단 계약 → API/service/client → room controller/use-room-chat → investigation-view/상태 표시. 기존 workflow 응답 계약은 유지한다. 직접 질문 생성과 reconcile만 새 migration으로 교체하며 기존 이미지·사용자 확인 wrapper는 유지한다.
