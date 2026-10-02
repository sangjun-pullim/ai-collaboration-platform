---
status: done
date: 2026-09-30
risk-surface: none
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 002 — 웹 기본 흐름과 모의 조사 경험

## Context

[PRD의 공동 조사방](../../PRD.md#공동-조사방), [실시간 관찰과 개입](../../PRD.md#실시간-관찰과-개입), [결과와 다음 작업](../../PRD.md#결과와-다음-작업)을 실제 브라우저에서 체험한다. [단계별 명세 범위](../../delivery-and-validation.md#단계별-명세-범위)의 두 번째 단계이며 실제 공동 조사 전체를 완료하는 명세가 아니다.

001은 `experiments/local-ai-runtime/`의 독립 실험이다. 현재 루트에는 웹 package·소스·러너가 없다. 002는 해당 실험을 import하거나 실행하지 않고, 명확히 표시된 결정적 모의 이벤트로 입력 의미와 화면 상태를 검증한다. 실제 공급자·계정·기존 앱 연결 선택을 기다리는 동안 진행할 수 있는 범위다. L3 필수 답변이 오면 실제 연동 순서를 조정하며 이 화면으로 연결 가능성을 증명하지 않는다.

Next.js App Router·React·TypeScript·npm·일반 CSS를 사용한다. Node.js는 001과 같은 24 LTS다. 2026-09-30 npm registry에서 Next.js 16.3.7, React 19.3.0, Playwright 1.63.0을 확인했다. 실제 의존성·peer 호환성을 설치 시 확인하고 lockfile에 고정한다. 자동 scaffold가 `AGENTS.md`나 개인 설정을 만들거나 Git을 초기화하게 하지 않는다. 웹 외 독립 실험을 루트 TypeScript·lint·테스트 대상에 포함하지 않는다.

공식 기준: [Next.js 설치](https://nextjs.org/docs/app/getting-started/installation), [Playwright 검증](https://nextjs.org/docs/app/guides/testing/playwright). 외부 글꼴 다운로드·클라우드 계정·AI 호출 없이 빌드와 기본 검증이 가능해야 한다.

### 범위와 완료 기준

- `/`에서 준비 화면 → 방 생성 → 공동/개인 표시 → 정지 전이 → 결과 초안 확인이 동작한다.
- 모든 화면에 모의 체험임을 표시하며 실제 로그인·저장소 연결·AI 실행이 완료됐다는 표현을 하지 않는다. 예제 참가자는 실사용자의 인증 상태가 아니다.
- 방 입력은 조사 목표·관찰한 현상·기대 동작·대상 환경·두 예제 연결·공유 범위다. 판매/관리 도메인 필드는 요구하지 않는다. 예제 binding 별칭 선택만 제공하며 브라우저에 실제 로컬 경로나 공급자 토큰 입력칸을 만들지 않는다.
- 공동 기록, 내 AI의 미확정 발신 초안, 개인 설명, 공개 방향 수정, 공동 발언을 분리한다. [입력의 의미](../../interaction-design.md#개발자-입력의-종류)를 기준으로 표시한다.
- 정지 요청·connector 확인·runtime 종결을 모의로 따로 재생한다. 미확인 상태를 정지 완료로 표시하지 않는다.
- 결과는 저장소별 근거·가설·제안·담당자·다음 검증으로 표시하고 사람의 해결/추가 조사/보류 선택을 남긴다. 이 선택으로 실행하지 않은 검증이 통과한 것처럼 표시하지 않는다.
- desktop과 390px 화면에서 키보드 조작·초점 보존·한글 IME 제출 방지가 검증된다.

이번 observer는 명시적인 **체험 역할**이다. connector 없이 공동 기록을 볼 수 있음을 표현하되 실제 보안 권한의 증거가 아니다. 실제 인증·초대·권한·DB·기기 등록·중앙 API·두 브라우저 동기화·runtime·저널·재접속은 로드맵의 공동 조사·사용자 개입/복구 단계로 남긴다. 이 화면의 state/action을 공개 API DTO로 고정하지 않는다.

## Affected Files

아래 경로는 신규 예정이며 기존 코드 행 번호를 주장하지 않는다.

1. `package.json`, `package-lock.json`, `.node-version`, `.gitignore` — 루트 웹 package와 scripts, 산출물 제외.
2. `tsconfig.json`, `tsconfig.test.json`, `tsconfig.e2e.json`, `next-env.d.ts`, `next.config.ts`, `eslint.config.mjs`, `playwright.config.ts` — 독립 웹 빌드·상태 테스트·브라우저 테스트 설정.
3. `src/app/layout.tsx`, `page.tsx`, `globals.css` — 한국어 App Router 진입점과 반응형 화면.
4. `src/features/investigation-prototype/prototype-state.ts`, `mock-scenario.ts` — 내부 presentation state/reducer와 공개 가능한 결정적 예제.
5. `src/features/investigation-prototype/prototype-app.tsx` — 화면 상태와 모의 진행 수명 관리.
6. `src/features/investigation-prototype/setup-view.tsx`, `room-view.tsx` — 준비/조사/결과 화면. 책임이 응집된 내부 컴포넌트는 같은 파일에 둔다.
7. `tests/unit/prototype-state.test.ts`, `tests/e2e/web-base-experience.spec.ts` — 순수 전이와 브라우저 수용 검증.
8. `README.md`, `docs/FRONTEND-ARCHITECTURE.md`, `docs/ARCHITECTURE.md` — 실행법·현재 웹 경계·남은 실제 연동 범위. 문서 갱신은 총괄이 담당한다.

## Affected Dependents

- 기존 루트 코드 caller/export/route/DB 소비자는 없다. `/` → `prototype-app` → 두 view와 state/scenario의 내부 의존 방향을 유지한다.
- `prototype-state` 변경은 두 view와 unit/E2E 테스트에 영향을 준다. 모의 state는 서버 권한 판정으로 재사용하지 않는다.
- 화면의 접근성 role/name은 Playwright가 소비한다. 테스트 편의를 위해 사용자 표현을 임의로 바꾸지 않는다.
- `experiments/local-ai-runtime/**`의 package·src·tests·lockfile은 변경하거나 루트 import graph에 포함하지 않는다.
- README의 현재 구현 설명과 구조 문서는 새 화면을 참조한다. PRD·BUSINESS-LOGIC·온보딩 문서는 동작 의미의 정본이며 동일 규칙을 복제하지 않는다.

## Implementation Steps

### [x] Step 1: 독립 웹 package와 검증 기반
**File**: 루트 package/config 파일
- Next.js·React·React DOM과 필요한 개발 의존성만 설치한다. UI 프레임워크·원격 폰트·외부 상태 라이브러리는 추가하지 않는다.
- `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e` scripts를 정의한다. Next 16의 제거된 `next lint` 대신 ESLint CLI를 사용한다.
- 상태 테스트는 기존 Node `node:test` 원칙을 재사용한다. `tsconfig.test.json`으로 순수 state/scenario와 unit tests를 별도 `.test-build/`에 컴파일하고 Node가 JS를 실행한다. Vitest는 필요하지 않다.
- Next tsconfig의 include를 웹 src·Next 생성 types·관련 설정으로 제한한다. 실험 코드·E2E·unit의 별도 환경이 서로 컴파일에 섞이지 않게 한다.
- `typecheck`는 `next typegen`으로 라우트 타입을 생성한 뒤 웹·unit·E2E를 각각 `tsc --noEmit`으로 검사한다. `tsconfig.e2e.json`은 E2E와 Playwright 설정을 포함한다. Playwright의 실행 변환을 TypeScript 타입 검사로 간주하지 않는다.
- Playwright는 전용 localhost 포트에서 production build/start를 검증한다. 기존 사용자 서버를 `reuseExistingServer`로 재사용하지 않는다. 기본 Chromium desktop/mobile 프로젝트를 사용하고 실제 모델·클라우드 요청을 하지 않는다.

### [x] Step 2: 분리된 상태와 결정적 모의 진행
**File**: `prototype-state.ts`, `mock-scenario.ts`, `tests/unit/prototype-state.test.ts`
- 공동 확정 event, 자신의 발신 draft, private explanation, 사람의 공개 intervention을 서로 다른 저장 필드로 유지한다. private/draft를 shared 배열에 넣고 렌더링에서 숨기지 않는다.
- 목표/현상/기대 동작/환경과 공유 범위 검증을 구현한다. 두 예제 저장소의 alias·branch·dirty snapshot·근거 유형을 도메인과 무관한 자료로 제공한다.
- 공개 발언은 사람 event만 추가하며 AI run·발신 초안을 자동 시작하지 않는다. 개인 설명은 선택한 공동 메시지 snapshot을 대상으로 private history만 갱신한다.
- 방향 수정은 공개 intervention과 pending direction으로 기록한다. 실행 중이면 모의 정지 확인 후에만 새 방향이 적용됐다고 표시한다. private 입력을 방향 수정에 자동 복사하지 않는다.
- pause 단계는 requested → acknowledged → terminal이며 terminal의 completed/failed/interrupted를 실제로 구분한다. UNKNOWN/offline 시에는 종결 확인 필요를 유지한다. 방 pause 완료는 필요한 예제 run의 종결 확인 이후다.
- 내 AI stop은 자기 run에만 적용하고 상대 run을 바꾸지 않는다. 전체 pause는 두 예제 run을 대상으로 한다. A가 terminal이어도 B가 ACK/UNKNOWN이면 방 pause는 미확인 상태이고, 모두 terminal일 때만 완료된다.
- 모의 진행은 명시적인 재생 버튼으로 결정적으로 전진시킨다. 이벤트 종류와 user-visible 상태를 맞추고 timer 기반 자연 완료로 정지 중간 상태가 지나가 버리지 않게 한다.
- observer action은 reducer에서도 실행/입력을 거절한다. 이것은 체험 모드의 일관성 검증이며 서버 보안 테스트가 아니다.
- 결과 초안은 사실·가설·제안과 저장소별 담당자·근거·다음 검증을 분리한다. 사람의 결정은 별도 event로 남기고 AI 동의만으로 solved로 전환하지 않는다.

### [x] Step 3: 준비 화면과 조사방
**File**: `layout.tsx`, `page.tsx`, `prototype-app.tsx`, `setup-view.tsx`, `room-view.tsx`
- 한국어 문서 언어와 지속적인 모의 체험 표시를 제공한다. setup에 실제 경로·키·토큰을 요구하지 않고 예제 연결을 선택하도록 한다.
- 준비 카드에는 [온보딩 정본](../../onboarding-and-settings.md#웹에서-보여줄-준비-카드)의 항목을 모의 정보로 보여준다. connector 없는 관찰 진입도 제공한다.
- 공동 목록에는 발신자 종류/소유자/수신자, 질문·답변·근거·사람 결정, 확정 여부·코드 snapshot 상태를 표시한다.
- 내 AI 영역에는 초안·수신자·공개 검사 상태·최근 실행 확인을 표시한다. 미확정 초안은 공동 목록에 보이지 않으며 모의 확정 시에만 shared event로 이동한다.
- 세 입력은 탭 또는 분명한 선택으로 구분하고 각 공개 대상을 입력 가까이에 표시한다. 개인 설명 공개는 명시적으로 선택한 내용에만 별도 action을 제공한다.
- 전체 pause와 내 AI stop을 구분한다. 요청 직후, ACK 이후, 종결 이후, UNKNOWN을 각각 표시한다. 버튼 클릭을 실제 runtime 완료로 표현하지 않는다.
- 결과 초안과 사람 결정 UI를 추가한다. 공유된 코드 위치는 repository alias·commit/snapshot 표시로 제공하고 상대 PC 절대 경로 링크를 만들지 않는다.

### [x] Step 4: 반응형·접근성·브라우저 수용 검증
**File**: `globals.css`, `tests/e2e/web-base-experience.spec.ts`, 관련 view
- desktop은 공동 대화/내 AI 2열, 모바일은 탭을 제공한다. 전체 pause와 실행 확인 상태는 탭과 무관하게 접근 가능해야 한다.
- 시각적 위계와 텍스트 상태, 명확한 focus 스타일, 폼 label, 버튼 이름, 오류 연결을 제공한다. 색상만으로 상태를 전달하지 않는다.
- 새 event가 추가돼도 입력 포커스를 유지한다. 전체 로그를 live region으로 매번 재낭독하지 않고 짧은 상태 변경만 polite로 알린다.
- `isComposing`/composition event 중 Enter 제출을 방지한다. 명시적 제출 버튼과 Enter 동작을 별도 검증한다.
- browser E2E에서 생성·세 입력 격리·draft 확정·pause 전 단계·observer·결과·모바일 탭·초점·IME를 검증한다. 렌더링된 desktop/mobile screenshot을 남겨 총괄이 직접 확인하고 overflow/겹침을 고친다.

### [x] Step 5: 독립 리뷰와 문서 수명주기
**File**: `README.md`, `docs/FRONTEND-ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, 이 명세
- 전체 검증 후 fresh-context `reviewer`가 실제 구현과 이 명세를 대조한다. 자기 검사를 독립 리뷰로 대체하지 않는다.
- README에 실제 실행법과 prototype의 한계·후속 실제 연동을 기록한다. frontend 구조 문서는 모듈 경계와 상태 소유권 위주로 얇게 유지한다.
- Git 저장소가 없어 commit freshness stamp를 만들 수 없음을 명시하고 확인하지 않은 hash를 쓰지 않는다. 현재 파일·검사 증거와 설계 의도를 구분한다. Git 준비는 이 변경의 필수 동작이 아니다.
- 모든 step·test·검증·리뷰가 완료된 경우에만 명세를 done/archive로 옮긴다. 001의 실제 호환성 실험 상태와 제품 전체 완료를 대신하지 않는다.

## Tests

unit은 `tests/unit/prototype-state.test.ts`, browser는 `tests/e2e/web-base-experience.spec.ts`에 구현한다. 이름은 `should + behavior`를 사용한다.

| 계층 | 이름 | 검증할 동작 |
|---|---|---|
| unit | `should require a generic investigation goal and environment` | 도메인 필드 없이 유효한 방 생성, 미입력 거절 |
| unit | `should keep private explanations out of shared events and drafts` | private 원문·응답이 shared/draft에 포함되지 않음 |
| unit | `should publish a human statement without starting an ai run` | 공개 발언이 run을 만들지 않음 |
| unit | `should publish only a finalized outbound draft` | draft/검사 단계에서 shared 비노출, 확정 이후만 채택 |
| unit | `should apply public steering after terminal confirmation` | 방향 변경 pending과 실제 모의 적용 구분 |
| unit | `should distinguish pause acknowledgement from terminal state` | 요청/ACK가 종결로 변하지 않음, 완료 경합·UNKNOWN 처리 |
| unit | `should stop only the owned ai and await all room terminals` | 자기 stop의 scope와 두 run의 방 pause 집계; 한 run의 ACK/UNKNOWN은 완료 아님 |
| unit | `should reject writing actions in observer mode` | 버튼 외 reducer 경계에서도 체험 쓰기 거절 |
| unit | `should record a human decision without inventing validation evidence` | 결과 선택과 실제 검증 여부 분리 |
| browser | `should create a generic room with visibly simulated bindings` | 유효한 생성·준비 카드·지속 mock 표시 |
| browser | `should separate public speech private explanation and steering` | 각각 위치·공개 대상 확인 및 명시적 공개 전환 |
| browser | `should keep unsent private and steering drafts separate` | 미제출 개인 입력과 공개 방향 입력을 모드 왕복에도 분리 보존하고, 방향 수정 제출에 비공개 원문이 포함되지 않음 |
| browser | `should keep outbound previews out of the shared timeline` | 미확정 공유 비노출과 확정 이벤트 표시 |
| browser | `should show pause request acknowledgement and terminal separately` | UI 전 단계 및 UNKNOWN에서 거짓 완료 없음 |
| browser | `should separate owned stop from pause across both simulated runs` | 상대 run 유지, A 종결/B ACK·UNKNOWN에서 방 완료 비표시, 모두 종결 후 완료 |
| browser | `should allow observation without a connector or writable controls` | 관찰 진입·이력 표시·제어 비활성 |
| browser | `should show evidence proposals owners and next validation` | 결과 초안과 사람 판단, 미검증 유지 |
| browser | `should preserve controls and focus on a narrow screen` | 390px overflow 없음·모바일 탭·공통 pause·키보드·초점 유지 |
| browser | `should not submit an input while korean composition is active` | composition Enter와 정상 제출의 차이 |

## Risks

- client 체험 역할을 실제 권한이나 제품 인증으로 오해할 수 있다. 지속 mock 표시와 실제 서버·provider 미연결 안내를 유지한다.
- 초안/private를 공용 배열에 섞으면 후속 통합의 경계가 흐려진다. state 자체를 분리하고 실제 격리는 공동 조사·사용자 개입/복구 단계에서 서버/runtime까지 검증한다.
- pause를 UI 클릭으로 완료하면 핵심 상태 의미가 깨진다. 결정적 단계 재생과 UNKNOWN을 별도 수용 기준으로 둔다.
- 향후 실시간 업데이트와 actual source-of-truth 연결은 이 reducer를 서버 계약으로 간주하지 않는다. 해당 통합 명세에서 별도 설계·permission/auth/DB/API 리뷰가 필요하다.
- 001 실제 실험 결과나 팀 도구의 L3 필요성은 아직 열려 있다. 이 화면을 실제 연결 성공 근거로 삼지 않는다.

## Verification

프로젝트 루트에서 Node 24를 사용한다. 아직 통과 결과가 아닌 구현 후 실행 기준이다.

```sh
node --version
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

- CI/E2E는 localhost 앱과 공개 합성 fixture만 사용한다. 공급자·클라우드 호출을 기본 검증에 포함하지 않는다.
- desktop/mobile 렌더링을 직접 확인한다. 브라우저 합성 composition 검증은 실제 OS IME의 모든 동작을 증명한다고 주장하지 않는다.
- 실행 환경으로 검증 불가능한 항목은 명시하고 step을 미완료로 유지한다. passing checks는 관련 코드와 입력이 변하지 않았을 때 재사용한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| E2E 타입 검사 누락 | MEDIUM | ACCEPTED | 별도 E2E tsconfig와 next typegen 이후 웹/unit/E2E 타입 검사를 명시했다. |
| 자기 stop/전체 pause 범위·다중 종결 집계 테스트 부족 | MEDIUM | ACCEPTED | 두 run의 scope와 ACK/UNKNOWN 집계를 unit/browser 수용 기준에 추가했다. |
| 최초 계획 독립 리뷰 | — | PASS | CRITICAL/HIGH 없음. 위 두 보완 외 계획 범위와 모의/실제 경계 검토 결과를 재사용한다. |
| 보완 범위 추가 계획 리뷰 | — | PASS | 별도 타입 검사와 두 run 정지 집계를 재검토했으며 추가 지적 없음. |
| 구현 검증 | — | VERIFIED | Node 24.21.0에서 npm ci·웹/unit/E2E 타입·lint·9/9 단위·production build 통과 결과를 재사용. 워커의 localhost listen EPERM은 코드 실패로 분류하지 않고 총괄 환경에서 production 서버·18/18 Chromium desktop/mobile E2E를 통과. desktop 준비·방·결과, 390px 공동/개인·결과 캡처를 직접 확인. 독립 구현 리뷰와 문서 수명주기는 별도 |
| 구현 리뷰 1: 미제출 private 입력이 공개 방향 수정으로 자동 복사 | HIGH | ACCEPTED | desktop/mobile 회귀를 먼저 실제 실패시켰다. 모드별 draft 분리 후 타입·lint·build와 20/20 browser 검사 통과. 독립 재리뷰 2에서 해소 확인 |
| 구현 리뷰 2 | — | PASS | 변경된 view와 회귀 검사를 독립 검토하고 시작/종료 21개 파일 SHA-256이 inventory-002-2와 일치. 변경 없는 초기 리뷰·9개 unit·6개 직접 visual 검토를 재사용. 새 지적 없음 |
| 문서 수명주기 | — | VERIFIED | 실행법·FRONTEND-ARCHITECTURE·현재 ARCHITECTURE·버그 이력을 실제 증거 기준으로 갱신. 19개 named test 존재와 전체 Step 완료 확인 후 done/archive 이동. 실제 인증·두 PC 연결·제품 완료와 구분 |
