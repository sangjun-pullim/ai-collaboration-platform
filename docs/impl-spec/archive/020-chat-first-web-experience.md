---
status: done
date: 2026-10-04
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 사람이 상대 AI에게 질문하는 채팅 화면

## Context

사용자는 초기 의도를 ‘채팅방을 만들어 각자의 AI에게 사람이 직접 질문하는 플랫폼’으로 다시 확인했다. 현재 `/`는 모의 조사 화면이고 실제 방은 설정·관리·공동 조사·직접 질문 폼을 한 페이지에 나열한다. 경로·AI·모델·effort 웹 설정은 미구현이다. [PRD](../../PRD.md)의 질문자 AI 없이 직접 질문하는 요구를 기본 흐름으로 올린다. 제품에서 방을 부르는 이름은 **AI 채팅방**으로 통일한다. 내부 `Room`, investigation API·DB 이름은 이 명세에서 바꾸지 않는다.

조사 기준은 HEAD `88db6862b9e29f4fdce17d9c8f280e4b8e7ef555`다. 로컬 연결 범위는 읽기 전용 planner의 코드 조사에 근거한다. 2026-10-05 사용자의 “끝까지 빨리 진행해..”로 020/021 구현 승인을 확인했고 `feat/chat-first-experience`에서 구현한다.

완료 기준:

- 기본 URL에서 실제 접속 화면으로 들어간다. 예제 체험은 `/demo`로 구분한다.
- 화면은 shadcn/ui와 Tailwind CSS를 실제 사용한다. 왼쪽 채팅방 목록, 가운데 대화·입력창, 오른쪽 참가자·선택 AI 정보로 구성한다. 모바일은 대화 우선이며 목록·상세는 Sheet로 연다.
- 자기 AI가 없는 참가자도 준비된 상대를 골라 질문한다. 선택한 상대만 한 번 답하며 자동 AI 왕복을 시작하지 않는다.
- 현재 질문 대상은 `사람 · AI · 저장소 · 작업 영역`으로 표시한다. 기존 요청의 대상·epoch를 고정하고 전송 결과 미확정의 같은 요청 확인·중단을 보존한다. 과거 메시지에 저장된 대상 정보가 없으면 현재 연결의 정보로 채우지 않는다.
- 방 만들기는 이름 입력을 중심으로 한다. 조사 양식과 고급 공동 조사·관리 기능은 기본 대화에서 분리한다.
- 내 AI 연결은 선택 사항으로 안내한다. 경로·AI·모델·effort의 실제 적용은 후속 로컬 설정 단계로 연결하며 미연결 값을 실행 가능으로 표시하지 않는다.
- 인증 변경은 [회사 코드 입장](021-team-code-entry.md)에서 별도 구현·검증한다. 이 화면 변경만으로 인증·Claude·로컬 설정 완료를 주장하지 않는다.

## Affected Files

1. `package.json`, `package-lock.json`, 신규 `postcss.config.mjs`, `components.json`, `src/lib/utils.ts` — Tailwind v4와 필요한 shadcn/ui 의존성·설정. 기존 Next.js·React를 교체하지 않는다.
2. 신규 `src/components/ui/{button,input,textarea,label,select,dialog,sheet,avatar,badge,separator,scroll-area}.tsx` — 공식 shadcn/ui registry의 필요한 컴포넌트만 추가한다.
3. `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, 신규 `src/app/demo/page.tsx`, 신규 `src/features/investigation-prototype/prototype.css` — 공통 디자인 토큰·메타데이터·실제 진입과 격리된 예제 화면.
4. `src/features/room-access/{login-form,access-dashboard,room-access-view,client-actions}.tsx` — 입장·목록·새 채팅방·초대·관리의 기본 흐름.
5. 신규 `src/features/room-access/chat-shell.tsx` — 채팅방 탐색과 모바일 Sheet의 레이아웃 책임. 채팅 상태·HTTP·권한 판단을 복제하지 않는다.
6. `src/features/investigation-coordinator/investigation-view.tsx`, 신규 `src/features/investigation-coordinator/{chat-timeline,chat-composer,advanced-controls}.tsx` — 현재 상태 소유자를 유지하고 표시 책임을 나눈다.
7. `src/features/device-binding/{connection-manager,room-bindings}.tsx`, `src/app/app/rooms/[roomId]/page.tsx` — 사람에게 필요한 연결 상태와 대상 정보, 본인 설정 안내.
8. 관련 unit·e2e와 docs — 아래 Tests와 Verification에 한정한다. 소스 파일을 늘리는 범위는 구현 중 총괄이 판단하고 의미 있는 책임이 없으면 컴포넌트를 따로 만들지 않는다.

## Affected Dependents

- `src/features/investigation-coordinator/{investigation-client,direct-intents,history-state,polling-policy}.ts` — 동일 HTTP 검증·요청 복원·이력 병합·조회 정책을 그대로 소비한다.
- `src/features/investigation-coordinator/{contracts,service,request-policy}.ts`와 investigations/workflow route — 기존 action·body·응답·권한·lease 계약을 유지한다.
- `src/features/room-access/{access-service,contracts,request-policy}.ts` — 기존 제목·방 준비 필드를 받는 API는 유지한다. 방 이름만 입력한 경우 클라이언트가 명시적인 미입력 기본값을 만든다.
- `src/features/device-binding/{contracts,service}.ts`, local connector — 기존 PublicBinding·기기 인증·실행 정책을 변경하지 않는다.
- `src/features/investigation-prototype/{prototype-state,mock-scenario,setup-view,room-view}.ts*` — 예제의 기능·개인/공동 입력 경계를 유지한다.

## Implementation Steps

### [x] Step 1: shadcn/ui·Tailwind 기반과 예제 분리
**File**: 패키지·PostCSS·components 설정, 공통 UI, globals, layout, page, demo

- [Tailwind Next.js 공식 설치](https://tailwindcss.com/docs/installation/framework-guides/nextjs)와 [shadcn/ui 기존 프로젝트 설치](https://ui.shadcn.com/docs/installation/next)의 순서를 사용한다. 설치 시 registry·버전을 확인하고 lockfile에 고정한다. 다른 프로젝트를 생성하거나 Next/React를 재초기화하지 않는다.
- registry 기본 컴포넌트는 원본 패턴을 유지한다. 프로젝트의 상대 import 관례를 사용해 Node 테스트에 새로운 runtime alias 의존성을 만들지 않는다. 별도의 UI 상태 관리자나 AI SDK는 추가하지 않는다.
- 흰색·중립색·얇은 구분선·작은 제목·제한된 강조색으로 디자인한다. 큰 홍보 문구, 초록/보라 그라데이션, 장식용 상태 카드 나열은 사용하지 않는다.
- 현재 `src/app/page.tsx:1-16`의 모의 앱 진입을 `/demo`로 옮기고 `/`는 실제 세션에 따라 `/app` 또는 `/login`으로 보낸다. 코드 입장 명세 전에는 기존 인증을 유지하고 이후 같은 진입을 새 세션에 연결한다.
- 기존 예제 CSS를 예제의 부모 선택자로 한정해 앱 전역 form·h1·main을 덮지 않게 한다. `/demo` 방문 후 실제 화면으로 돌아오는 CSS 누출도 확인한다.

### [x] Step 2: 입장·채팅방 목록·간단한 방 생성
**File**: login-form, access-dashboard, client-actions, chat-shell

- 입장 후 내 AI 미연결을 오류로 표시하지 않는다. ‘질문만 하기’와 선택 사항인 ‘내 AI 연결’을 구분한다. 실제 방 권한은 기존 세션·RPC로 판단한다.
- 현재 dashboard의 참가 방·초대·그룹 생성 폼 나열을 목록과 ‘새 채팅방’ Dialog로 바꾼다. 새 방 이름만 필수로 받는다. 목표 기본값은 ‘참가자 간 AI 채팅’, 관찰 근거·환경 기본값은 ‘입력하지 않음’으로 보내고 상세 화면에도 미입력으로 표시한다. 실제 관찰 사실을 만들어내지 않는다.
- 기존 organization의 본인 owner가 있으면 기존 room action을 사용하고 없으면 bootstrap으로 기본 그룹을 만든다. 방/그룹의 역할을 임의 승격하지 않는다. 본인의 표시 이름은 회사 코드 입장 명세의 저장된 이름을 사용한다.
- 초대는 채팅방 관리 Dialog에서 발급하고 링크 복사로 전달한다. URL의 일회용 방 초대는 기존 join action으로 확인·참가한다. 회사 입장 코드와 방 초대를 같은 코드로 취급하지 않는다. 초대 값을 서버 로그·analytics·페이지 제목에 넣지 않고 참가 뒤 URL에서 제거한다.

### [x] Step 3: 질문 중심 대화와 입력창
**File**: investigation-view, chat-timeline, chat-composer

- 현재 `investigation-view.tsx:228-265`의 speak/ask를 같은 채팅 입력창의 수신 대상 선택에 연결한다. 기본 동작은 AI 질문이며 ‘방 참가자에게 메시지’는 별도 선택이다. 자기 binding이 없어도 ask를 호출한다.
- 상태·mutation·polling·pendingDirect·세션 전환의 단일 소유자는 InvestigationView로 유지한다. 컴포넌트는 값과 제한된 callback만 받고 별도 fetch·storage·timer를 만들지 않는다.
- 현재 `329-416`의 대상 선택·epoch 고정·같은 요청 확인·중단 의미를 보존한다. 준비된 상대가 하나이면 기본 선택하며 여러 명이면 사람이 선택한다. 만료·교체된 선택을 다른 대상으로 자동 전환하지 않는다.
- 질문과 연결된 답변, 작성자, 저장된 대상 식별자·epoch와 요청 상태를 메시지 안에서 보여준다. 현재 PublicEvent/RunSummary에는 역사적 저장소 snapshot이 없으므로 ‘질문 당시 저장소’를 만들어 표시하지 않는다. 같은 agentId·epoch에 대조한 공개 metadata는 ‘현재 연결 정보’로만 표시한다. epoch가 다르거나 연결이 해제되면 저장된 식별 정보만 사용하고 ‘당시 저장소 정보 없음’으로 표시한다. 새로고침 뒤에도 현재 별칭으로 과거 질문을 다시 라벨링하지 않는다. 역사적 snapshot 저장·wire 변경은 후속 설정 명세로 분리한다.
- 응답 유실을 전송 성공처럼 보이게 하거나 기존 요청으로 다른 본문을 보내지 않는다.
- Enter는 전송, Shift+Enter는 줄바꿈이며 한글 composition 중에는 전송하지 않는다. 빈 본문·권한 없음·대상 미준비·방 중단·미확정 기존 요청을 기존 규칙대로 처리한다.
- 새 메시지는 하단에 있을 때만 따라간다. 과거 기록을 읽는 중에는 위치를 유지하고 새 메시지 알림을 제공한다. 조회 때문에 입력 초안·대상·focus가 초기화되지 않는다.

### [x] Step 4: 참가자·본인 연결·고급 기능 분리
**File**: room-access-view, room-bindings, connection-manager, advanced-controls

- 방 역할·초대·제거는 메뉴/Dialog에 둔다. 공동 조사 시작·방 일시정지·재개는 ‘공동 조사’ 상세에 두며 직접 질문을 시작하기 위해 열 필요가 없다.
- 상대 AI는 사람 이름·Claude/Codex·저장소·작업 영역·실제 관찰한 연결 상태로 표시한다. 등록·최근 통신·응답 준비·답변 중·미확인을 구분한다. 모든 연결을 항상 ‘미검증’으로만 표시하거나 설치 완료를 ready로 처리하지 않는다.
- ‘내 AI 연결’ 화면은 질문-only 사용자를 막지 않는다. 현재 코드에서 Codex CLI 등록·prepare만 가능한 사실을 안내한다. 후속 설정의 실제 endpoint·receipt가 준비되기 전 가짜 model 선택을 저장·성공 처리하지 않는다.
- 공유 경로 기본값은 저장소 별칭이다. 로컬 절대 경로·공급자 인증정보·native session은 상대 카드와 메시지에 추가하지 않는다.

### [x] Step 5: 회귀·접근성·반응형 확인
**File**: 관련 unit/e2e

- 기존 실제 unit과 browser fixture를 사용한다. JSX import 변경 때문에 VM 테스트 loader 보정이 필요하면 rendering 의존성만 보정하고 요청 복원·actor 분리·본문/UUID 검증의 기대값을 유지한다.
- 실제 Auth·DB·HTTP + 가짜 provider의 browser로 질문자 미연결 → 대상 선택 → 한 번 질문 → 해당 대상 답변과 같은 요청 복원/중단을 확인한다. 예제 화면으로 대신 증명하지 않는다.
- 1440px·768px·390px에서 읽기·전송·대상 선택·내 AI 설정·메뉴의 키보드 focus·모달 focus 복귀·overflow·한글 입력을 확인한다.

### [x] Step 6: 리뷰·문서와 수명주기
**File**: PRD, GLOSSARY, FRONTEND-ARCHITECTURE, onboarding, delivery, README

- 사용자 용어 ‘AI 채팅방’을 현재 문서와 실제 UI에 반영한다. archived 명세의 당시 ‘조사방’ 문구는 보존한다. backend 식별자 rename은 별도 범위다.
- 구현 상태·검증 결과는 delivery 정본에만 갱신한다. [회사 코드 입장](021-team-code-entry.md)과 로컬 설정 단계가 끝나기 전 전체 사용자 흐름 완료로 표시하지 않는다.
- 독립 reviewer가 권한·미확정 요청·UI 연결·회귀 근거를 검토한다. 전 단계·필수 검사·리뷰 완료 후 이 명세만 done/archive 처리한다.

## Tests

- `tests/e2e/web-base-experience.spec.ts` — 예제 기능 검사는 `/demo`에서 유지하며 실제 진입은 모의 화면을 표시하지 않는지 확인한다.
- `tests/e2e/investigation-coordinator.spec.ts` — 자기 connector 없이 지정 AI의 단일 질문·답변, stale 대상, 같은 요청 복원, 계정·쿠키 변경 격리와 중단을 보존한다. 질문 뒤 연결 교체·해제·새로고침에도 과거 메시지에 현재 저장소 별칭이 붙지 않는지 확인한다.
- `tests/e2e/device-workspace-binding.spec.ts` — 본인 기기 관리와 상대 정보 비노출, 역할 제한이 새 레이아웃에서도 동작한다.
- `tests/e2e/web-auth-room-access.spec.ts` — 방 이름만으로 생성·초대 링크·관찰자 쓰기 제한·멤버 제거. 코드 인증 검사는 다음 명세에서 바꾼다.
- `tests/unit/human-direct-intents.test.ts`, investigation-client/history 테스트 — 기존 actor/body/retry/상한/abort 의미를 유지한다.
- `tests/e2e/investigation-coordinator.spec.ts`의 completed replacement/detach case — 한글 composition, 읽는 중 scroll 유지, 전송 후 focus와 과거 대상 보존. `web-auth-room-access.spec.ts`의 모바일 메뉴·Dialog, `web-base-experience.spec.ts`의 예제 CSS 누출 검사와 `tests/unit/chat-presentation.test.ts`의 원본 이력 불변·답변 상태 투영 검사를 함께 사용한다.

## Risks

- 구조 변경으로 폴링·mutation 소유자가 복제될 수 있다. 기존 InvestigationView의 단일 상태 소유와 클라이언트를 유지한다.
- 코드 입장 전후 인증 화면이 다르다. 단계별 완료와 최종 수용을 구분하고 기존 인증 세션을 mock으로 대체하지 않는다.
- 지원 선택 UI만 만들어 실행 성공처럼 보일 수 있다. 로컬 capability·적용 receipt가 없으면 준비 미완료와 실제 다음 동작을 표시한다.
- 예제 CSS와 Tailwind preflight가 섞일 수 있다. 실제/예제 왕복을 browser로 확인한다.

## Verification

- Node 24에서 root `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run format`, `npm run format:check`.
- 현재 격리 stack의 Auth·device·workflow browser와 필요한 실제 HTTP 회귀. 운영 DB·외부 메일·실제 AI를 실행하지 않는다.
- 변경 없는 connector 검사는 source/config/test 입력 hash가 같을 때만 재사용한다. 새로운 브라우저 검사를 실제 두 PC·Claude의 증거로 쓰지 않는다.
- `git diff --check`, docs 링크 검사, 새 독립 reviewer. 이전 source 리뷰는 새 UI 리뷰를 대신하지 않는다.

## Review Notes

계획 round 2의 새 독립 reviewer가 과거 대상 정보 보정과 현재 계약·호출부를 확인했다. 결과는 **PASS, C0/H0/M0/L0/INFO0**이다. 구현 승인과 새 코드의 검증·독립 리뷰는 별도 단계다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| round 1: historical target metadata vs unchanged contract | HIGH | ACCEPTED | 현재 event/run 계약에는 역사적 저장소 snapshot이 없다. 현재 연결 정보와 과거 저장 정보를 구분하고 없는 과거 값은 미확인으로 표시한다. snapshot 저장은 후속 범위다. |

### 최종 구현 리뷰 — 2026-10-05

새 독립 reviewer가 모바일 생성 Dialog·포커스 복귀와 단일 답변 표시를 확인했다. 최종 결과는 **PASS, C0/H0/M0/L0/INFO0**이다. 이전 구현 리뷰의 모바일 중첩 Dialog HIGH를 수용해 고쳤고 수정 전 실패와 수정 후 실제 브라우저 결과를 보존했다. 답변의 PENDING→ACCEPTED 두 감사 이벤트는 원본 이력에 유지하며 같은 실행의 답변을 화면에서 한 번만 표시한다.

변경된 운영 코드 6개·테스트/fixture 7개와 호출부를 검토했다. 이전 리뷰의 입력 61개는 현재 hash가 같아 backend 보정 검토를 재사용했다. 필수 검사와 문서 상대 링크·diff 검사를 통과했다. 웹의 실제 로컬 폴더·Claude/Codex·모델·effort 설정과 실제 Claude·두 PC 검증은 이 명세의 완료 범위가 아니다. 현재 수치와 다음 단계는 delivery 정본을 따른다.
