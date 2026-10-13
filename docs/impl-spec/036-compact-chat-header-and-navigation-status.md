---
status: active
date: 2026-10-13
risk-surface: none
---
> NOTE: 이 문서는 구현 계획이다. 현재 동작의 증거가 아니다. 완료 후 보관하며 현재 화면은 코드와 프론트엔드 구조 문서를 따른다.

# 채팅 제목 통합과 왼쪽 메뉴의 내 AI 연결 표시

## Context

상단 연결 표시, 방 제목, 내 역할, 방 상태가 네 줄을 차지한다. 사용자는 역할·방 상태를 제목과 합치고 연결 정보를 왼쪽 메뉴에 넣어 대화를 넓게 보길 요청했다. 기존 질문·답변·중단·미확인 요청 정리 및 읽기 권한은 그대로 유지한다.

## Affected Files

1. `src/app/app/layout.tsx` — 서버에서 조회한 연결 표시를 공통 탐색 영역의 ReactNode 슬롯으로 공급한다. 페이지 본문을 조회 때문에 막지 않는다.
2. `src/features/room-access/chat-shell.tsx` — 연결 슬롯의 공통 공급자, 제목 옆 역할·접수 상태, 동적 방 제어의 제목 슬롯을 소유한다. 왼쪽 메뉴 아래 연결 상태를 표시하고 모바일은 같은 기능을 접근 가능한 메뉴로 제공한다.
3. `src/features/device-binding/connection-status-bar.tsx` — 좁은 메뉴에 맞게 연결 요약과 재확인을 표시한다. 조회 시각·기기 상세는 펼쳐서 확인한다.
4. `src/features/room-access/room-access-view.tsx` — 별도 역할 줄을 제거하고 제목에 역할·읽기 전용 정보를 전달한다.
5. `src/features/investigation-coordinator/investigation-view.tsx` — 별도 방 상태 줄을 제거하고 현재 상태와 기존 공동 조사 제어를 제목 슬롯에 렌더링한다.

## Affected Dependents

- `src/features/device-binding/owned-connection-status.tsx` — 현재 인증과 본인 연결만 조회하는 서버 컴포넌트는 유지한다. 조회 횟수를 늘리지 않는다.
- `src/features/room-access/access-dashboard.tsx`, `src/app/app/connections/page.tsx`, `src/features/device-binding/connection-manager.tsx`, `src/features/room-access/room-access-view.tsx` — 같은 ChatShell을 쓰는 네 호출자의 방 목록·연결·채팅 화면 모두 연결 표시를 제공한다.
- `src/app/app/page.tsx`, `src/app/app/rooms/[roomId]/page.tsx` — 조회 실패 분기는 ChatShell 없이 일반 main을 렌더링한다. provider는 탐색 호스트가 없는 페이지에서도 연결 확인 UI를 제공해야 한다. 페이지 분기와 인증 동작은 바꾸지 않는다.
- `src/features/investigation-coordinator/advanced-controls.tsx` — 기존 Dialog·폼·실행 조건과 소유권은 유지한다. 제목 슬롯의 이동은 폼 제출을 복제하지 않는다.
- `tests/unit/connection-status-bar.test.ts`, `connection-navigation.test.ts`, `team-entry-ui.test.ts`, `chat-view.test.ts` — 공통 layout·shell·동적 조사 화면의 mock과 회귀 검사를 갱신한다.
- `tests/e2e/web-auth-room-access.spec.ts`, `device-workspace-binding.spec.ts` — 역할·연결 영역의 접근 가능한 이름을 보존하거나 새 위치에 맞춘다.
- `tests/e2e/investigation-coordinator.spec.ts` — 조사 본문 내부로 제한된 공동 조사 버튼·방 상태 선택자를 페이지의 제목 영역으로 갱신한다.
- 문서 사본: 이 저장소의 `docs/FRONTEND-ARCHITECTURE.md:42,48`, `docs/guides/onboarding-and-settings.md:116,122,132,136`에 상단 연결 배치를 설명한 두 파일의 여섯 문단을 찾았다. 새 위치를 갱신하고 현황은 `docs/planning/delivery-and-validation.md`에 기록한다. 검색 범위는 src/tests/docs이며 보관 명세와 과거 검증 기록은 고치지 않는다.

## Change Map

`AppLayout --supplies server slot--> ChatShell navigation --renders--> ConnectionStatusBar`

`RoomAccessView --metadata--> ChatShell title`

`RoomInvestigation --renders controls--> ChatShell title slot`

`FRONTEND-ARCHITECTURE / onboarding-and-settings --restates--> navigation connection placement`

## Implementation Steps

### [x] Step 1: 회귀 검사와 공통 연결 슬롯

별도 상단 연결 행이 사라져도 본문·입력 상태와 Suspense가 유지되는 실패 검사를 먼저 작성한다. 서버 ReactNode를 client context에 전달해 모든 ChatShell 호출자가 동일한 조회 결과를 사용한다. 조회·권한 API는 수정하지 않는다.

### [x] Step 2: 메뉴 연결 표시와 모바일 접근

데스크톱 메뉴 하단에 초록·빨간·회색 표시, 짧은 통신 요약, 다시 확인을 둔다. 시각·기기 목록·판정 설명은 기본 접힌 상세로 제공하며 넘치는 상세는 스크롤한다. 모바일에서는 제목의 작은 연결 표시에서 상세를 열 수 있어 메뉴가 닫혀 있어도 상태를 확인한다. 타이머·자동 조회는 추가하지 않는다.

연결 표시는 한 인스턴스만 렌더링한다. 화면 폭에 따른 이동은 CSS로 처리하거나 단일 연결 슬롯을 사용한다. 모바일 탐색 Sheet와 제목에 전체 연결 컴포넌트를 중복으로 넣지 않는다. ChatShell 없는 조회 실패 화면은 공급자에서 연결 확인 UI로 대체하되 정상 채팅에는 별도 상단 행을 만들지 않는다.

### [x] Step 3: 제목·역할·방 상태 통합

제목 옆에 내 역할과 읽기 전용 여부를 표시한다. 방 상태와 공동 조사 제어는 ChatShell이 소유하는 제목 슬롯에 한 번 렌더링한다. 기존 조사 컴포넌트가 폼·실행 상태를 계속 소유하며 효과로 ReactNode를 등록해 매 조회마다 재마운트하는 방식은 피한다. Portal을 사용할 경우 최초 호스트 준비·정리·독립 렌더링 fallback을 검사한다. 모바일의 제목 길이·버튼 폭을 제한하고 메뉴의 키보드·포커스 접근을 유지한다.

### [ ] Step 4: 검증·리뷰·배포 및 문서 정리

기존 테스트와 실제 브라우저에서 1440/1920/390px 너비를 확인한다. 이전 기록과 상태 안내가 포함된 현실적인 fixture를 사용하고 제목이 한 행인지, 대화 높이·입력 위치·가로 넘침을 측정한다. 독립 리뷰에서 위치 이동·폼 보존·모바일 접근·회귀 범위를 확인한다. 승인된 GitHub Flow에 따라 커밋·PR·일반 병합·운영 배포를 확인하고 계획을 보관한다.

## Tests

- 공통 layout: 연결 슬롯 조회가 느려도 페이지를 렌더링하고 별도 상단 공간을 만들지 않는다.
- 내 AI 표시: 초록/빨간/회색·기기 집계·수동 refresh·pending·조회 시각·상세와 연결 관리 접근을 유지한다.
- 제목: owner/participant/observer 역할·읽기 전용과 방 활성/일시정지/조회 실패를 구분한다.
- 제목 슬롯: 단일 제어, 초기 렌더링, 모바일 메뉴, 폼 입력·닫기/다시 열기·취소 버튼 동작을 확인한다.
- 화면 폭 변경: 조사 Dialog가 열린 상태로 방향 textarea·공유 확인·연결 선택을 입력한 뒤 1440→390→1440px로 바꿔 열림·입력·포커스와 단일 실행 제어를 확인한다.
- 조회 실패: ChatShell 없는 방 목록·방 페이지에서도 본인 연결 확인을 사용할 수 있고 상태를 추가로 조회하지 않는다.
- 회귀: 질문 전송·중단·정리 후보·권한 상실·미확정 동일 요청 재확인 기존 검사를 재사용한다.

## Risks

- 모바일에서 연결 상태가 메뉴 뒤에 숨는 문제: 제목에 연결 표시를 유지하고 상세로 접근한다.
- 제목 버튼이 대화 폭을 줄이는 문제: 모바일 역할은 짧게 보이고 공동 조사·상세 정보는 메뉴에 넣는다.
- Portal의 호스트 변경으로 폼 상태를 잃는 문제: 안정적인 단일 호스트와 기존 조사 상태 소유권을 유지한다.
- 연결 상태의 의미 오인: 최근 통신·마지막 조회·실제 답변 준비와 다르다는 설명을 상세에 유지한다.

## Verification

- Node 24에서 `npm test`, `npm run lint`, `npm run format`, `npm run format:check`.
- 사용자 `next-env.d.ts`를 보존하는 격리 빌드에서 `npm run build`와 관련 TypeScript 검사.
- Chromium으로 실제 변경 컴포넌트를 hydrate한 격리 fixture에서 제목 통합·대화 높이·좁은 화면·메뉴 상세·키보드·폭 변경 중 폼 보존을 검사한다. 테스트용 snapshot·서버 연결 슬롯·room chat controller·router refresh를 mock해 DB 없이 실행한다. 정적 렌더링만으로 포커스·폼 보존을 통과했다고 하지 않는다.
- 기존 DB fixture를 쓰는 e2e 선택자 수정은 TypeScript 검사와 동일 UI를 사용하는 위 격리 브라우저 검사로 검증한다. 실제 AI 호출과 운영 DB 변경은 없다. 격리 DB 기반 검사를 추가로 실행하면 그 범위를 따로 보고한다.
- 독립 코드 리뷰와 정상 PR 병합 후 정확한 main commit의 Vercel READY 및 공개 주소 확인.

## Review Notes

계획 독립 검토 통과: gpt-6.1-sol xhigh 읽기 전용 reviewer, CRITICAL 0 / HIGH 0 / MEDIUM 0. 2026-10-13 사용자의 “진행해. 빠르게.”로 구현·검증·병합·배포 승인. 네이티브 planner 생성은 `agent thread limit reached`로 실패해 같은 저장소의 읽기 전용 Orca CLI planner로 전환했다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 같은 표시의 중복 인스턴스와 shell 없는 실패 화면 | 범위 보완 | ACCEPTED | 단일 연결 표시와 실패 화면 fallback을 Step 2 및 테스트에 명시했다. |
| 공동 조사 본문에 한정된 선택자와 DB 없는 상호작용 검증 | 범위 보완 | ACCEPTED | workflow e2e 선택자 변경을 포함하고 hydrate한 mock fixture에서 Dialog·입력·포커스 보존을 검사한다. |
| 구현 리뷰 1회: shell 없는 실패 화면에서 데스크톱 연결 상세가 위로 열려 잘림 | HIGH | ACCEPTED · 2차 해소 확인 | 배치 정보로 상세 방향을 구분하고 1440/390px fallback 상세·수동 재확인을 실제 브라우저에서 확인했다. 보정 후 단위591/591·빌드·lint·타입·포맷·hydrated 브라우저가 통과했다. |
| 데스크톱 기능 메뉴의 닫힌 native details가 관리·로그아웃을 숨김 | 보정 | ACCEPTED | 실패 검사 뒤 버튼/상태 제어와 단일 제어 인스턴스로 바꿨다. 2차에서 모바일 입력·포커스·메뉴와 데스크톱 제어 가시성을 확인했다. |
| 모바일 관찰자 검사에서 기능 메뉴를 열기 전 참가자 버튼 가시성을 판정 | 테스트 보정 | ACCEPTED · 2차 해소 확인 | 메뉴를 연 뒤 Sheet/sidebar를 구분한다. 해당 E2E 타입·lint·포맷과 실제 구성요소 검사를 통과했다. |

구현 독립 리뷰2회: 최종 CRITICAL0/HIGH0/MEDIUM0. 변경하지 않은 조회·권한·폼 검토는 1차를 재사용하고 변경된 배치·제어·검사와 정본만 추가 검토했다. Step4의 검증·리뷰·정본 갱신 완료, PR 병합·운영 배포 확인과 보관 진행 중이다.
