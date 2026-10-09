---
verified-against: cecc55c213c3d34b2c6480de55aa20ac10d9b0b9
sources:
  - src/app/**
  - src/features/**
  - src/lib/supabase/**
  - src/proxy.ts
  - tests/e2e/**
---
# 프런트엔드 구조

검증 기준 커밋의 화면 소스를 설명한다. 웹은 Next.js 16.3.7 App Router·React 19.3.0·TypeScript와 Tailwind 4.3.3·shadcn/ui 구성 요소를 사용한다. 모의 체험과 실제 사람 인증·방 접근·기기 관리·공동 기록 polling 화면이 있다. 진행 상태·검증 수치·남은 통합은 [개발 순서와 검증 계획](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## 화면과 모듈 경계

[page.tsx](../src/app/page.tsx)의 `/`는 실제 입장 상태에 따라 `/app` 또는 `/login`으로 보낸다. 모의 체험 [PrototypeApp](../src/features/investigation-prototype/prototype-app.tsx)은 `/demo`에서 제공한다. [layout.tsx](../src/app/layout.tsx)가 한국어 문서 언어·metadata와 공통 CSS를 제공한다.

`/login`의 `LoginForm`은 회사 입장 코드·표시 이름을 입력받고 제출 직후 코드 입력을 비운다. `/app`의 `AccessDashboard`는 채팅방 목록과 이름만 받는 새 방 Dialog·초대 참가를, `/app/rooms/[roomId]`의 `RoomAccessView`는 채팅과 별도 관리 Dialog를 제공한다. 목표·관찰·환경은 채팅 진입의 필수 입력이 아니다. 이름에서 실제 관찰을 만들어 내지 않고 고정 기본값을 사용한다. 서버 page는 요청별 Supabase client로 현재 Auth 사용자와 RLS 결과를 조회한다. 화면 입력은 고정 POST action으로 전달하며 권한 판정을 브라우저 상태에 맡기지 않는다. [API 계약](API-SPEC.md)과 [데이터 모델](DB-SCHEMA.md)을 따른다.

실제 인증 화면은 `src/features/room-access/`에 있고 기존 prototype reducer를 import하지 않는다. Auth/접근 API와 Next proxy는 `src/lib/supabase/`의 요청별 cookie client를 사용한다.

채팅의 원본 이벤트는 append-only 이력에 보존한다. 같은 방·request·question·agent·bindingEpoch의 ANSWER 상태 변경은 `chat-presentation.timelineEvents`에서 가장 큰 sequence를 선택해 한 답변으로 표시한다. 서로 다른 실행과 식별 정보가 부족한 이벤트는 합치지 않는다. 이 표시는 서버 이력·요청·실행 횟수를 바꾸지 않는다.

`/app/connections`의 [ConnectionManager](../src/features/device-binding/connection-manager.tsx)는 자기 참가 방 선택·연결 코드 승인·기기 취소/제거와 최근 수신·만료를 표시한다. 방의 [RoomBindings](../src/features/device-binding/room-bindings.tsx)는 공개 저장소/session 별칭·Git metadata·runtime·epoch·미검증 상태만 보여 주며 observer도 읽을 수 있다. 기기 credential·proof·절대 경로·native locator는 props/HTML/RSC에 포함하지 않는다. heartbeat와 등록을 AI 실행 가능으로 표시하지 않는다.

```mermaid
flowchart TD
    Page["/demo · page"] --> App["PrototypeApp · 모의 상태 소유"]
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

채팅 화면의 내부 책임은 다음 모듈로 나눈다. 공동 이력·직접 질문 전송·미확정 저장은 RoomChatController가 소유한다. useRoomChat은 같은 controller를 React 구독과 start/stop에 연결하며, InvestigationView는 대상 선택·입력 초안·스크롤을 맡는다. 본인 AI의 새 답변 상태와 제어 intent는 별도 OwnInputControls가 소유한다. 표시용 컴포넌트는 이 상태나 조회를 복제하지 않는다.

| 모듈 | 책임 |
|---|---|
| [investigation-view.tsx](../src/features/investigation-coordinator/investigation-view.tsx) | 입력 초안·대상과 epoch 선택·스크롤·화면 배치 |
| [room-chat-controller.ts](../src/features/investigation-coordinator/room-chat-controller.ts) | 공개 이력·단일 조회 timer·직렬 전송·요청 취소·사용자/방별 미확정 저장과 동일 요청 복구 |
| [use-room-chat.ts](../src/features/investigation-coordinator/use-room-chat.ts) | 같은 controller의 구독·start/stop을 React 화면 수명에 연결 |
| [investigation-client.ts](../src/features/investigation-coordinator/investigation-client.ts) | `callInvestigation` 함수 하나로 요청 검증·fetch·응답 읽기·오류 전달 |
| [direct-intents.ts](../src/features/investigation-coordinator/direct-intents.ts) | 사용자·방 저장 키, 복원 검증, 새 요청과 동일 재시도 본문 생성 |
| [chat-presentation.ts](../src/features/investigation-coordinator/chat-presentation.ts) | 연결 상태와 질문 대상 표시. 공동 AI 질문의 발신 요청을 수신 대상으로 해석하지 않는다 |
| [chat-timeline.tsx](../src/features/investigation-coordinator/chat-timeline.tsx) | 메시지·질문/답변 연결·자료 상세 진입·이전 이력 스크롤과 새 메시지 표시 |
| [run-source-view.tsx](../src/features/investigation-coordinator/run-source-view.tsx) | 메시지별 저장소·자료 열기와 당시 대상·Git 관찰·파일 범위 표시 |
| [source-view-controller.ts](../src/features/investigation-coordinator/source-view-controller.ts) | 고정 event 조회·다음 페이지·응답 일치 검사·요청 취소·접근 거절 전달 |
| [chat-composer.tsx](../src/features/investigation-coordinator/chat-composer.tsx) | 질문 대상·입력·공개 안내·전송·한글 조합·포커스 표시 |
| [advanced-controls.tsx](../src/features/investigation-coordinator/advanced-controls.tsx) | 명시적으로 펼친 공동 조사와 중단·재개 제어 |
| [own-input-controls.tsx](../src/features/investigation-coordinator/own-input-controls.tsx) | 본인 AI의 새 답변 상태 조회·일시정지/재개·미확정 제어 intent 수명 |
| [own-input-control-state.ts](../src/features/investigation-coordinator/own-input-control-state.ts) | 사용자·방별 intent 검증, 같은 요청의 receipt 확인, revision/epoch 상태 채택 |

[ChatShell](../src/features/room-access/chat-shell.tsx)은 채팅방 탐색·모바일 Sheet·참가자 정보 배치만 맡는다. HTTP·저장·polling과 권한 상태를 복제하지 않는다. shadcn/ui의 기본 요소는 `src/components/ui/`에 둔다.

브라우저 HTTP 모듈은 요청을 검증한 뒤 POST JSON을 전송한다. 호출자 중단과 10초 제한을 결합하고 응답의 실제 수신 바이트를 최대 262,144바이트로 제한한다. JSON content type, 엄격한 UTF-8과 기존 BOM 처리, 오류 우선순위 및 reader 정리를 유지한다. 서버의 16KiB 요청 읽기 모듈과 실행 환경·상한이 다르다. 직접 요청 정책은 저장값의 읽기·거절을 수행한다. controller가 HTTP 전에 미확정 요청을 저장하고, 확정 결과에서만 삭제한다. 재전달은 화면의 명시적 동작으로 시작하며 새 질문을 자동 생성하지 않는다.

공동 발언·명시적 origin/peer 조사 시작·자기 interrupt·방 pause·방/조사 재개를 제공한다. 준비와 실행은 기기 보고로 표시하며 provider 미검증·UNKNOWN·과거 미채택을 구분한다. observer는 읽기 화면을 사용한다. polling은 활동/추가 이력 조회 시 2초, idle 10초, 숨김 30초이며 실패 시 최대 30초 backoff를 적용한다. 동시 조회를 제한하고 화면 종료·mutation·권한 거절 때 진행 중 요청을 abort한다.

직접 질문 폼은 질문자의 AI 연결 없이 표시한다. 준비된 상대 연결이 하나면 기본 선택하고 여러 연결이면 명시적으로 선택한다. 선택 목록에는 저장소·세션·소유자 별칭과 runtime을 표시한다. 대상 epoch 교체나 offline 상태를 확인하면 재선택을 요구한다. 입력창의 명시적 전송으로 질문·공개 공유를 제출하고 같은 질문의 답변과 실제 종결 상태를 조회한다. 질문과 답변은 방 참가자에게 공유된다는 안내를 표시한다. 별도의 매 질문 checkbox는 없다. Enter는 전송, Shift+Enter는 줄바꿈이며 한글 조합 중 Enter는 전송하지 않는다. 성공 전송 후 입력이 다시 활성화된 시점에 포커스를 돌리고 polling으로 초안·선택 범위를 지우지 않는다.

공동 조사의 내 AI·상대 AI 선택 목록도 개발자·runtime·공개 저장소 별칭·세션 별칭을 함께 표시한다. 선택 항목의 값은 기존 agent ID이며 같은 참가자의 다른 저장소를 표시할 때도 등록된 공개 정보를 사용한다. 모델·effort의 웹 선택과 적용 상태는 기기 관리의 별도 설정 폼이 담당한다. 질문 대상 선택은 저장된 agent ID와 epoch를 사용하며 설정 초안으로 대상을 바꾸지 않는다.

응답이 유실된 직접 질문은 sessionStorage에 같은 operation·본문을 보관하고 사용자가 `같은 요청 확인`을 실행하면 그대로 재전달한다. 서버에서 인증한 사용자 ID와 방 ID를 저장 키에 포함하고 복원한 본문의 `expectedUserId`도 대조한다. 예전 방 ID만 있는 항목은 제거하며 새 계정에서 채택하지 않는다. 쿠키만 다른 계정으로 바뀐 이전 화면의 요청도 서버의 실제 Auth 대조에서 거절한다. 화면 종료나 늦은 응답이 다른 사용자의 미확정 기록을 지우지 않도록 처리한다. 새 질문으로 자동 재시도하지 않는다. 직접 질문의 중단 요청은 `canInterrupt`가 허용한 실행 하나만 대상으로 하며 ACK와 typed 종결을 구분한다. 실제 브라우저 검증 범위는 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

## 메시지의 당시 저장소와 자료

각 메시지의 ‘저장소·자료’를 열면 해당 `roomId/eventId`의 자료를 처음 조회한다. 다음 파일 관찰도 같은 event·대상·자료 hash·요약에 묶인다. 새 결과 채택 이벤트는 새 event ID로 조회하고 run 요약 밖의 오래된 메시지도 읽을 수 있다. 전체 메시지의 자료를 polling마다 조회하지 않는다.

SourceViewController는 실제 사람 RPC를 주입받으며 첫 조회·다음 페이지·닫기·화면 종료를 소유한다. 화면이 다시 렌더링되어도 controller와 열린 자료의 조회를 다시 만들지 않는다. 닫기·방 전환·종료 때 진행 중 요청을 취소하고 늦은 응답을 무시한다. 다음 페이지의 대상·hash·요약·index가 원래 자료와 다르면 채택하지 않는다. 접근 거절 `FORBIDDEN/UNAUTHENTICATED/NOT_FOUND`는 부모에 전달해 현재 조회·mutation을 중단하고 이력을 비우며 입력을 막는다. 일시적인 오류에는 자료 재조회만 제공한다.

자료 상세는 예약 당시 사람·AI·저장소·세션 별칭과 현재 같은 연결의 정보를 구분한다. 당시 대상이나 자료가 없으면 그 상태를 표시하고 현재 정보를 대신 넣지 않는다. 입력 전 허용 파일·실제 도구 반환 발췌·질문 전 근거 확인을 구분하며 반복 파일의 다른 범위를 유지한다. 도구의 실제 반환 바이트와 질문 전에 확인한 바이트, 별도로 요청한 줄도 구분한다. Git 관찰 실패와 dirty는 미확인이다. 경로·ref의 제어문자와 짝이 없는 surrogate는 escape로 표시하고 개인 오류·절대 경로·native ID·파일 본문을 화면에 넣지 않는다. 실제 DB·브라우저 수용 여부는 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 모의 개인 입력과 방향 수정

아래 `shared`·`draft`·`privateHistory`와 개인 설명·방향 수정은 `/demo`의 모의 체험 규칙이다. 실제 개인 설명의 제품 연결은 후속 범위다.

공동 확정 이벤트 `shared`, 미확정 발신 `draft`, 개인 설명 `privateHistory`는 모의 reducer에서 서로 다른 필드다. 개인 기록을 공동 배열에 넣고 CSS로 숨기는 구조가 아니다. 설명·방향 수정·공동 발언의 제품 의미는 [상호작용 정본](guides/interaction-design.md#개발자-입력의-종류)을 따른다.

Composer의 미제출 초안은 컴포넌트 로컬 상태에서 `speak`·`explain`·`steer`별로 보관한다. 개인 설명/방향 수정 전환은 각 초안을 유지하고 제출은 해당 초안만 비운다. 개인 원문을 공개 입력으로 자동 복사하지 않는다. 개인 설명의 공개 전환은 명시적인 별도 action이다.

자기 AI 정지는 A만 대상으로 하며 전체 pause는 A/B의 실제 모의 terminal을 모두 기다린다. requested·acknowledged·unknown·terminal을 구분하고 ACK를 완료로 표시하지 않는다. 예제 observer는 UI와 reducer에서 쓰기를 거절하지만 실제 인증·접근 제어 검증을 대신하지 않는다.

## 내 AI의 새 답변 제어 상태

실제 채팅방의 OwnInputControls는 본인 binding만 표시하고 질문자에게 AI 연결을 요구하지 않는다. 연결 프로그램의 현재 revision/epoch 보고가 없으면 “요청됨 · 연결 프로그램 대기”, 확인되면 “일시정지 적용 보고” 또는 “재개 적용 보고”로 표시한다. 조회 실패는 “상태 확인 불가”이며 “이미 실행 준비를 시작한 답변은 계속됩니다”를 함께 표시한다.

각 버튼의 접근 가능한 이름에 공개 저장소 별칭·세션 별칭과 동작을 함께 넣는다. 해당 AI의 적용 상태를 버튼 설명과 연결하므로 본인 AI가 두 개여도 어떤 저장소의 답변을 제어하는지 구분할 수 있다.

제어 intent는 현재 userId/roomId별 sessionStorage에 전송 전에 저장한다. 응답 유실 뒤 사용자는 같은 operation/body를 확인하며 읽기 projection만으로 pending을 지우거나 새 요청을 자동 생성하지 않는다. 오래된 epoch/revision의 receipt는 최신 상태를 덮어쓰지 않는다. 조회는 방별로 묶고 pending·적용 보고 대기, idle·hidden과 실패 backoff를 구분한다. 화면에 보이지 않는 추가 본인 상태는 유효한 서버 응답으로 인정하고 현재 표시 binding만 채택한다. 실제 브라우저 검증은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 소유자 설정의 화면 상태

`/app/connections`의 [RuntimeSettingsForm](../src/features/runtime-settings/runtime-settings-form.tsx)은 자기 기기마다 공급자·Mac 폴더 선택 요청·모델·effort·공개 세션 별칭·적용·취소를 제공한다. 브라우저는 실제 경로를 입력받지 않으며 폴더와 공유 파일 범위는 해당 Mac의 관리 프로그램에서 확인한다. 확인된 동일 capability snapshot만 선택 목록으로 사용하고 effort가 없는 모델의 `null`을 유지한다.

[SettingsController](../src/features/runtime-settings/settings-controller.ts)가 조회·mutation·선택 초안·같은 operation 추적을 소유한다. 동시 조회를 제한하고 화면 종료 시 조회와 mutation을 중단하며 늦은 응답을 채택하지 않는다. 결과가 미확정이면 같은 요청을 조회하고 자동 재적용하지 않는다. 서버 확정 대기와 PC 적용 완료, 취소 요청과 PC 정리 완료를 별도로 표시한다. 적용 receipt의 configRevision·agent/workspace·bindingEpoch가 현재 연결과 일치할 때만 현재 적용값으로 보여 준다. 등록·heartbeat·웹 요청 성공을 AI 준비 완료로 표시하지 않는다. [설정 계약](API-SPEC.md#소유자의-로컬-ai-설정)·[검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

폴더 선택 안내는 필요한 코드의 자동 탐색과 파일 수정 제한을 설명한다. 실제 승인된 본인 receipt가 자동 모드를 포함할 때만 ‘필요한 코드 자동 탐색’을 표시한다. 과거 선택 파일 receipt에는 자동 탐색 표시를 붙이지 않는다. apply는 본인 receipt의 동일 모드를 전달하며, 화면의 임의 경로·모드 입력으로 PC의 범위를 넓히지 않는다.

설정 폴더 요청이 서버에서 확정 거절되면 해당 요청의 화면 예약을 해제하고 최신 설정 버전을 다시 조회한다. 응답 유실 등 결과가 불명확한 오류에서는 동일 요청 ID를 유지해 다른 요청을 중복으로 만들지 않는다. 취소의 PC 정리 완료는 해당 요청의 취소 receipt를 정확 조회한 뒤 표시한다.

## 표시와 접근성

[globals.css](../src/app/globals.css)는 Tailwind와 실제 웹의 공통 UI 색상·기본 스타일을 제공한다. 실제 채팅은 desktop의 탐색·대화·참가자 정보와 모바일 Sheet를 사용한다. 모의 체험의 기존 CSS는 `prototype.css`에서 `.prototype-demo` 아래로 제한하며 `/login`·실제 채팅으로 돌아왔을 때 화면을 덮어쓰지 않는다. 모의 체험은 desktop 공동/개인 2열과 390px 모바일 탭을 제공한다. 정지·실행 확인은 모바일 탭 밖에서도 접근 가능하다. label·상태 텍스트·focus 스타일을 사용하고 새 로그 전체를 live region에서 반복 읽지 않는다. Enter 제출은 composition 상태에서 차단하고 Shift+Enter는 줄바꿈이다.

## 검사와 남은 통합

웹·단위·브라우저의 타입·lint·빌드와 동작 검사를 수행한다. 현재 검증 수치는 [개발 순서와 검증 계획](planning/delivery-and-validation.md#현재-진행-상태)을 따른다. 개인 미제출 초안 전환의 실패 재현과 보정은 [오류 기록](BUG-FIXES.md#2026-10-01--미제출-개인-입력의-공개-방향-수정-전환)에 남긴다. CSS/layout 변경이 없는 소스 보정에서는 이전 직접 시각 검토를 재사용한다.

웹·단위·브라우저는 각 tsconfig로 타입 검사한다. 독립 `experiments/local-ai-runtime/`은 웹 import/build/lint/test에 포함되지 않는다. 외부 폰트·AI·클라우드 계정 없이 웹 검증을 수행한다.

실제 연동에서는 mock reducer를 서버 정본으로 승격하지 않는다. 모의·Auth·기기 browser는 각각 `playwright.config.ts`, `playwright.auth.config.ts`, `playwright.device.config.ts`로 분리한다. 기기 browser의 parent broker는 자기 합성 pairing·등록·heartbeat만 지원하고 제품/브라우저 child에 admin·DB·JWK를 전달하지 않는다. 민감 artifact 정제와 trace/screenshot/video 비활성 정책을 재사용한다. 각 단계의 진행 상태와 재검사 결과는 개발 순서 문서에서 관리한다.

workflow browser는 `playwright.workflow.config.ts`로 분리하며 parent broker가 자기 fixture의 고정 fake-driver 동작만 제공한다. 소유자 설정 browser는 `playwright.settings.config.ts`로 분리한다. 설정 화면과 검사 소스가 있다는 사실은 실제 Auth/DB·Mac·provider 동작 검증 완료를 뜻하지 않는다. 실제 runtime 수용·Realtime·개인 설명과 브라우저 실행 근거는 [개발 순서](planning/delivery-and-validation.md#현재-진행-상태)를 따른다. 현재 mock 역할과 상태는 실제 권한 검증의 증거가 아니다.
