---
verified-against: null
sources:
  - src/app/**
  - src/features/**
  - src/lib/supabase/**
  - src/proxy.ts
  - tests/e2e/**
---
# 프런트엔드 구조

2026-10-01 현재 실제 웹 소스를 기준으로 작성했다. 루트는 Next.js 16.3.7 App Router·React 19.3.0·TypeScript이며 모의 체험과 실제 사람 인증·방 접근·기기 관리·공동 기록 polling 화면이 있다. 사람 인증·기기 단계는 실제 검사와 독립 리뷰를 완료했다. 공동 조사 browser 4건과 기존 Auth/기기 browser 각 4건·모의 browser 20건의 재검사는 통과했고 독립 구현 리뷰 round1도 미해결 CRITICAL/HIGH 없이 통과했다. provider 실행기·Realtime는 후속 범위다. Git 저장소가 없어 commit 기반 freshness stamp를 검증할 수 없으며 확인하지 않은 hash를 쓰지 않는다.

## 화면과 모듈 경계

[page.tsx](../src/app/page.tsx)의 `/`는 client 진입점 [PrototypeApp](../src/features/investigation-prototype/prototype-app.tsx)을 렌더링한다. [layout.tsx](../src/app/layout.tsx)가 한국어 문서 언어·metadata와 공통 CSS를 제공한다.

`/login`의 `LoginForm`은 이메일 OTP를, `/app`의 `AccessDashboard`는 현재 그룹·방 조회와 생성/초대 참가를, `/app/rooms/[roomId]`의 `RoomAccessView`는 방 준비 정보·역할·owner의 초대/멤버 제거를 담당한다. 서버 page는 요청별 Supabase client로 현재 Auth 사용자와 RLS 결과를 조회한다. 화면 입력은 고정 POST action으로 전달하며 권한 판정을 브라우저 상태에 맡기지 않는다. [API 계약](API-SPEC.md)과 [데이터 모델](DB-SCHEMA.md)을 따른다.

실제 인증 화면은 `src/features/room-access/`에 있고 기존 prototype reducer를 import하지 않는다. Auth/접근 API와 Next proxy는 `src/lib/supabase/`의 요청별 cookie client를 사용한다.

`/app/connections`의 [ConnectionManager](../src/features/device-binding/connection-manager.tsx)는 자기 참가 방 선택·연결 코드 승인·기기 취소/제거와 최근 수신·만료를 표시한다. 방의 [RoomBindings](../src/features/device-binding/room-bindings.tsx)는 공개 저장소/session 별칭·Git metadata·runtime·epoch·미검증 상태만 보여 주며 observer도 읽을 수 있다. 기기 credential·proof·절대 경로·native locator는 props/HTML/RSC에 포함하지 않는다. heartbeat와 등록을 AI 실행 가능으로 표시하지 않는다.

```mermaid
flowchart TD
    Page["/ · page"] --> App["PrototypeApp · reducer 소유"]
    App --> Setup["SetupView · 목표/환경/예제 연결"]
    App --> Room["RoomView · 공동/개인/실행/결과"]
    Setup --> State["prototype-state · 순수 전이"]
    Room --> State
    State --> Mock["mock-scenario · 공개 합성 자료"]
```

- [prototype-app.tsx](../src/features/investigation-prototype/prototype-app.tsx)는 `useReducer`로 화면 수명을 소유하고 지속적인 모의 안내와 짧은 접근성 상태 알림을 제공한다. 새로고침하면 초기화된다.
- [prototype-state.ts](../src/features/investigation-prototype/prototype-state.ts)는 입력 검증·공개/개인 action·정지 집계·사람 판단을 처리한다. presentation state이며 서버 권한이나 API 계약이 아니다.
- [setup-view.tsx](../src/features/investigation-prototype/setup-view.tsx)는 일반적인 목표·현상·기대 동작·환경·공유 범위와 예제 연결을 입력받는다. 실제 PC 경로나 공급자 비밀 입력은 없다.
- [room-view.tsx](../src/features/investigation-prototype/room-view.tsx)의 내부 컴포넌트는 공동 기록·발신 초안·개인 입력·각 실행 확인·결과를 표시한다. 외부 공개 컴포넌트 표면은 `RoomView`로 유지한다.
- [mock-scenario.ts](../src/features/investigation-prototype/mock-scenario.ts)는 결정적 예제만 제공한다. 버튼으로 이벤트를 재생하며 실제 AI 호출·자연 종결을 흉내 내는 background timer는 없다.

## 상태 소유권과 입력

실제 방은 [InvestigationView](../src/features/investigation-coordinator/investigation-view.tsx)의 공개 이력을 함께 렌더링한다. [history-state](../src/features/investigation-coordinator/history-state.ts)는 eventId 중복 제거·sequence gap 복구와 typed 과거 run 재생을 담당한다. 방 전환·권한 거절 시 이력을 초기화하고 늦게 도착한 snapshot이 최신 상태를 되돌리지 않도록 처리한다. 이 상태는 prototype reducer와 분리한다.

공동 발언·명시적 origin/peer 조사 시작·자기 interrupt·방 pause·방/조사 재개를 제공한다. 준비와 실행은 기기 보고로 표시하며 provider 미검증·UNKNOWN·과거 미채택을 구분한다. observer는 읽기 화면을 사용한다. polling은 활동/추가 이력 조회 시 2초, idle 10초, 숨김 30초이며 실패 시 최대 30초 backoff를 적용한다. 동시 조회를 제한하고 화면 종료·mutation·권한 거절 때 진행 중 요청을 abort한다.

공동 확정 이벤트 `shared`, 미확정 발신 `draft`, 개인 설명 `privateHistory`는 reducer에서 서로 다른 필드다. 개인 기록을 공동 배열에 넣고 CSS로 숨기는 구조가 아니다. 설명·방향 수정·공동 발언의 제품 의미는 [상호작용 정본](interaction-design.md#개발자-입력의-종류)을 따른다.

Composer의 미제출 초안은 컴포넌트 로컬 상태에서 `speak`·`explain`·`steer`별로 보관한다. 개인 설명/방향 수정 전환은 각 초안을 유지하고 제출은 해당 초안만 비운다. 개인 원문을 공개 입력으로 자동 복사하지 않는다. 개인 설명의 공개 전환은 명시적인 별도 action이다.

자기 AI 정지는 A만 대상으로 하며 전체 pause는 A/B의 실제 모의 terminal을 모두 기다린다. requested·acknowledged·unknown·terminal을 구분하고 ACK를 완료로 표시하지 않는다. 예제 observer는 UI와 reducer에서 쓰기를 거절하지만 실제 인증·접근 제어 검증을 대신하지 않는다.

## 표시와 접근성

[globals.css](../src/app/globals.css)는 desktop 공동/개인 2열과 390px 모바일 탭을 제공한다. 정지·실행 확인은 모바일 탭 밖에서도 접근 가능하다. label·상태 텍스트·focus 스타일을 사용하고 새 로그 전체를 live region에서 반복 읽지 않는다. Enter 제출은 composition 상태에서 차단하고 Shift+Enter는 줄바꿈이다.

## 검사와 남은 통합

Node 24.21.0에서 웹/unit/E2E 타입·lint·production build를 확인했다. [상태 검사](../tests/unit/prototype-state.test.ts) 9개, [브라우저 수용 검사](../tests/e2e/web-base-experience.spec.ts) 10개를 desktop/mobile에서 실행한 20건이 통과했다. 개인 미제출 초안 전환은 수정 전 양쪽 실패를 먼저 재현했고 수정 후 검사와 독립 재리뷰를 통과했다. CSS/layout 변경이 없는 보정에서는 기존 6개 desktop/mobile 직접 시각 검토를 재사용했다.

웹·단위·브라우저는 각 tsconfig로 타입 검사한다. 독립 `experiments/local-ai-runtime/`은 웹 import/build/lint/test에 포함되지 않는다. 외부 폰트·AI·클라우드 계정 없이 웹 검증을 수행한다.

실제 연동에서는 이 mock reducer를 서버 정본으로 승격하지 않는다. 사람 인증·방 접근은 실제 Auth/Postgres/HTTP 14개·Auth E2E desktop/mobile 4건과 독립 리뷰 3을 통과했다. 기기 통합은 DB·HTTP·별도 CLI process 12개가 통과했고 실제 기기 browser 4개와 기존 Auth browser 4개 재검사도 통과했다. 모의·Auth·기기 browser는 각각 `playwright.config.ts`, `playwright.auth.config.ts`, `playwright.device.config.ts`로 분리한다. 기기 browser의 parent broker는 자기 합성 pairing·등록·heartbeat만 지원하고 제품/브라우저 child에 admin·DB·JWK를 전달하지 않는다. 민감 artifact 정제와 trace/screenshot/video 비활성 정책을 재사용한다.

workflow browser는 `playwright.workflow.config.ts`로 분리하며 parent broker가 자기 fixture의 고정 fake-driver 동작만 제공한다. 실제 runtime 제어와 참가자별 모델/effort·Realtime·개인 설명은 [개발 순서](delivery-and-validation.md#단계별-명세-범위)의 후속 범위다. 현재 등록은 `codex/unverified`이며 모델 선택 기능은 아직 없다. 현재 mock 역할과 상태는 실제 권한 검증의 증거가 아니다.
