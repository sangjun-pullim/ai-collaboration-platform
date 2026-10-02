# AI 협업 조사 플랫폼 — 제품 설계 문서

두 개발자의 로컬 저장소와 코딩 AI를 연결해, 공동 문제를 조사하고 개발자가 실시간으로 관찰·질문·개입하는 제품의 설계안이다.

특정 업무 도메인에 종속되지 않는 저장소 간 AI 협업 도구를 목표로 한다. 사용자가 든 수집기·관리자 사례는 첫 파일럿 후보이며 제품의 필수 구조가 아니다. 초기에는 두 개발자·두 AI로 검증한다.

- 작성일·공식 자료 확인일: **2026-09-30**
- 상태: **설계와 단계별 구현 진행 중**. 첫 런타임 실험(001)은 실제 대화 재개·중단을 확인했다. 파일 도구 확장(003)을 포함한 런타임은 51개 격리 테스트·독립 재리뷰를 통과했고, 제한된 두 도구의 실제 callback과 저장 세션에서 새 파일 표식 읽기를 확인했다. 웹 모의 화면은 9개 상태 검사·20개 브라우저 검사와 독립 재리뷰를 통과했다. 실제 사람 인증·그룹/방 권한은 통합 14개·Auth browser 4개가 통과했고 독립 구현 리뷰 3도 통과했다. 두 저장소의 공동 실행·제품 배포는 미완료다.
- 현재 기기 등록: macOS·Node 24 CLI의 코드 승인·저장소/session 별칭 등록·회전/취소·receipt 복구를 구현해 실제 DB·HTTP·CLI 12개와 기존 Auth 통합 14개 재검사가 통과했다. Auth browser 4개와 기기 browser 4개 재검사도 통과했으며 독립 구현 재리뷰 2도 통과했다. 등록 상태는 `codex/unverified`이며 각자의 Claude/Codex·모델·effort 선택과 실제 공동 실행은 후속 범위다.
- 현재 실행 조정: 내구 질문·공유 답변·origin 후속 요청·lease/fence·기본 중단/UNKNOWN과 웹 공개 이력 polling을 구현했다. 실제 로컬 DB·HTTP·가짜 driver 통합 18개와 workflow browser 4건을 통과했고 독립 구현 리뷰 round1도 미해결 CRITICAL/HIGH 없이 통과했다. 실제 provider 실행기·참가자별 실행 설정·Realtime는 이어 구현한다.
- 현재 로컬 실행기: [007](docs/impl-spec/007-owned-codex-workflow-runner.md)에서 Codex 소유 세션·binding별 모델/effort·선택 파일·내구 실행/복구 명령을 구현 중이다. 실제 서버 통합·provider 왕복·기존 설정 유지·독립 구현 리뷰를 진행 중이며, 사용자 확정에 따라 기존 개인·프로젝트 설정을 유지하는 방식으로 보정 중이다. 웹 설정·Claude·Realtime·두 PC 검증은 이어지는 범위다.
- 사용자 요구: 서로 다른 저장소의 AI 간 직접 질문/응답, 웹 접속, AI 발신 과정 표시, 자기 AI에 대한 개인 질문과 방향 수정, 사람이 대화 과정을 관찰하며 개입, Vercel 활용 검토.
- 초기 사용 전제: 사용자가 **개인·비상업용**으로 확인했다. **Vercel Hobby + Supabase Free**의 무료 한도 안에서 두 사용자 실험을 시작하는 것을 기준으로 한다. 회사 업무용 확장은 후속 범위다.
- 제품 위치: 조사 대상 저장소들과 독립된 제품 저장소·배포를 권고한다. 대상 서비스의 업무 데이터나 배포에 제품 자체를 결합하지 않는다.

## 추천하는 첫 구조

**Vercel 웹/제어 API + Supabase 인증/Postgres/Realtime + 각 PC의 로컬 연결 프로그램 + 연결 프로그램이 관리하는 AI 세션**.

초기 호스팅·DB 요금은 무료 한도 안에서 0원을 목표로 한다. AI 구독/API 사용 비용은 별도이며 전체 서비스의 무제한 무료 운영을 뜻하지 않는다. 전송 묶음·저장량·사용량 확인·휴면 복구 기준은 [무료 플랜 운영 기준](docs/constraints-and-security.md#무료-플랜-운영-기준)을 따른다.

Postgres에 공동 기록과 요청 상태를 보관하고, Realtime은 변경 알림과 작성 중 표시를 담당한다. 각 PC가 바깥으로 연결을 열며 코드는 로컬 AI가 조사한다. 초기에는 읽기·조사·수정 제안까지 지원하고 실제 파일 변경은 각 담당자의 기존 개발 흐름에서 수행하는 것을 권고한다.

가장 먼저 검증할 것은 **기존 AI 작업 맥락을 어느 수준까지 연결할 수 있는가**이다. 저장된 세션 이어가기와 실행 중인 다른 앱의 세션에 동시에 붙는 기능을 구분한다. 화면·소켓 구현만으로 이 문제가 해결되지는 않는다.

## 문서 역할과 정본

| 문서 | 역할·정본 소유권 |
|---|---|
| [PRD](docs/PRD.md) | 제품의 문제·사용자·범위·비목표·성공 기준 정본 |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 시스템 경계·모듈·데이터 흐름·통합 구조의 설계 제안 정본 |
| [BUSINESS-LOGIC](docs/BUSINESS-LOGIC.md) | 상태 전이·revision/epoch/fence·라우팅·복구·한도의 동작 불변식 정본 |
| [ADR](docs/ADR.md) | 확정된 중요한 결정의 이유·대안 기록 |
| [BUG-FIXES](docs/BUG-FIXES.md) | 구현 중 재현·수정·검증한 주요 오류의 기록 |
| [FRONTEND-ARCHITECTURE](docs/FRONTEND-ARCHITECTURE.md) | 실제 웹 모듈·상태·라우팅·검사와 남은 통합 범위 |
| [DB-SCHEMA](docs/DB-SCHEMA.md) | 사람·그룹·방 모델의 이유, RLS·초대·취소 제약과 마이그레이션 경계 |
| [API-SPEC](docs/API-SPEC.md) | 실제 웹의 인증·방 접근 action, 요청·응답·고정 오류 계약 |
| [GLOSSARY](docs/GLOSSARY.md) | 웹 경로·AI 연결·저장 세션·활성 실행을 구분하는 용어 정본 |
| [AI 연동](docs/ai-runtime-integration.md) | Codex/Claude 제약, 세션 연결 수준, 맥락 이전, 인증·과금 연구 |
| [로컬 AI 연결 조사](docs/local-ai-connection-research.md) | 브라우저·로컬 실행 경계, 각자 접속 순서, 공식 원격 기능, 로컬 확인 결과 |
| [화면과 상호작용](docs/interaction-design.md) | 공동 대화, AI 발신, 개인 입력, 설명·방향 수정·승인 설계 |
| [첫 사용 설정](docs/onboarding-and-settings.md) | 웹 접속, PC·저장소·계정·세션 연결, 준비 상태·오류 안내 |
| [제약과 보안](docs/constraints-and-security.md) | 실패·권한·정보 공유·운영·비용·환경 제약 |
| [개발·검증 순서](docs/delivery-and-validation.md) | 실험, 단계별 출시, 의미 있는 검증, 성공 측정 |
| [첫 구현 명세](docs/impl-spec/001-local-ai-runtime-spike.md) | 런타임 실험 도구의 계획. 실제 실행·resume·중단 증거 확보, 팀 도구/L3 필요성 확인은 미결 |
| [웹 기본 흐름 명세](docs/impl-spec/archive/002-web-base-experience.md) | 완료된 모의 웹 계획의 보관 기록. 현재 구현은 frontend 구조 문서를 기준으로 확인 |
| [런타임 도구 명세](docs/impl-spec/archive/003-scoped-runtime-tools.md) | 제한 도구의 실제 새 실행·저장 세션 재개까지 검증한 완료 명세 |
| [사람 인증·방 접근 계획](docs/impl-spec/archive/004-web-auth-and-room-access.md) | 완료한 사람 인증·방 접근 계획의 보관 기록. 현재 소스·검사는 frontend/DB/API 문서 기준 |
| [기기·저장소 등록 계획](docs/impl-spec/archive/005-device-and-workspace-binding.md) | 완료한 로컬 pairing·private state·공개 등록·권한 취소 계획의 보관 기록 |
| [내구 실행 조정 계획](docs/impl-spec/archive/006-durable-investigation-coordinator.md) | 질문·답변·run·기본 중단과 공개 이력 polling의 완료 계획 보관 기록 |
| [Codex 실행기 계획](docs/impl-spec/007-owned-codex-workflow-runner.md) | 로컬 소유 맥락·모델/effort·실제 workflow 실행과 장애 복구의 진행 중 계획 |
| [결정과 미결 항목](docs/decisions-and-open-items.md) | 검토 중인 기술안·아직 선택할 사항·실험 과제 |
| [출처](docs/sources.md) | 공식 자료와 확인 범위 |
| [문서 정리 기록](docs/document-maintenance.md) | 제품 요구와 분리한 과거 정리·리뷰 범위와 한계 |

## second-brain 규칙 적용 상태

| 표준 문서 | 생성 조건 | 현재 적용 |
|---|---|---|
| `PRD.md` | 제품 문서 요청 | 작성됨. 문제·목표·범위·비목표·성공 기준 |
| `ARCHITECTURE.md` | 항상 | 작성됨. 설계와 실제 구현을 구분하며 Git 부재로 stamp의 commit 검증은 불가 |
| `ADR.md` | 항상 | 작성됨. 확정 결정만 기록하고 미선택 기술안은 미결 문서로 분리 |
| `BUG-FIXES.md` | 항상 | 작성됨. 구현 중 재현·보정한 주요 오류를 기록 |
| `BUSINESS-LOGIC.md` | 복잡한 업무 동작 | 작성됨. 상태 전이·제어·복구·공유 규칙 |
| `GLOSSARY.md` | 용어 혼동 발생 | 작성됨. 표 형식으로 문서에서 사용하는 개념 식별자를 구분 |
| `DB-SCHEMA.md` | DB 모델링·제약·마이그레이션 의도 구체화 | 작성됨. 실제 사람·방·private 기기/binding 모델의 이유와 권한·receipt·삭제 제약을 설명 |
| `API-SPEC.md` | 외부 소비자에게 제공할 API 계약 정의 | 작성됨. 사람 cookie Auth와 connector bearer의 별도 고정 action·공개 정보 계약 |
| `FRONTEND-ARCHITECTURE.md` | React/Next.js 구조·라우팅 구체화 | 작성됨. 실제 모의 웹 모듈·입력 상태·검사와 후속 실제 연동 경계 |

DB/API/frontend의 선택과 구체적인 설계 의도가 생기면 해당 조건을 다시 판단한다. 소스 코드가 완성될 때까지 문서 생성을 일괄 미루지는 않는다. 연구·화면·온보딩 등의 별도 문서는 표준 문서와 공존한다.

규칙은 코드에서 유도되는 `ARCHITECTURE.md`에 freshness stamp를 요구한다. 현재 Git 저장소가 없어 commit 기반 `verified-against`를 기록하지 못한다. 설계 제안과 실제 소스·검사로 확인한 구현 범위를 구분하고, 확인하지 않은 commit hash를 쓰지 않는다. 이 한계를 규칙의 예외나 전체 준수 완료로 표시하지 않는다.

## 웹 모의 체험 실행

루트에서 Node.js 24 LTS를 사용한다.

```sh
npm ci
npm run dev
```

`http://localhost:3000`에서 준비·공동 기록·개인 설명·방향 수정·정지 단계·결과를 체험한다. 실제 로그인/저장소/AI와 연결되지 않으며 새로고침하면 초기화된다. 검사는 `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`로 실행한다. 브라우저 검사를 처음 실행할 때는 `npx playwright install chromium`이 필요하다. 현재 구조와 확인 범위는 [프런트엔드 문서](docs/FRONTEND-ARCHITECTURE.md)를 따른다.

## 실제 로컬 로그인과 방 접근

`/login`에서 이메일 코드를 확인하고 `/app`에서 그룹·방 생성과 초대 참가를 사용한다. `/app/connections`에서 로컬 CLI의 코드를 승인하고 방에서 공개 등록과 공동 이력을 확인한다. [제품/검사 설정](docs/onboarding-and-settings.md#현재-구현한-로컬-로그인과-조사방), [로컬 등록 순서](docs/onboarding-and-settings.md#현재-로컬-기기와-저장소-등록), [고정 API](docs/API-SPEC.md), [DB/RLS](docs/DB-SCHEMA.md)를 따른다. 제품 서버에는 Supabase URL·publishable key·신뢰 app origin만 전달한다. 로컬 Codex 실행 명령과 남은 검증은 [실행 준비](docs/onboarding-and-settings.md#로컬-codex-실행-준비)에 기록한다. Realtime·개인 설명은 후속 구현이다.

## 로컬 런타임 실험 도구

Node.js 24 LTS에서 다음을 실행한다.

```sh
cd experiments/local-ai-runtime
npm ci
npm run typecheck
npm test
npm run probe
```

기본 검사는 실제 AI 질문을 실행하지 않는다. 모델 호출을 명시한 실험과 계정·권한·합성 저장소 조건은 [001 검증 절](docs/impl-spec/001-local-ai-runtime-spike.md#verification)을 따른다. 실제 대화 재개·중단 증거와 아직 미확인인 파일 읽기·두 PC 왕복은 [연결 조사](docs/local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)를 따른다.

## 읽는 순서

PRD → ARCHITECTURE → AI 연동 → BUSINESS-LOGIC → 화면과 상호작용 → 제약과 보안 → 개발·검증 순서.

첫 구현 전에는 [결정과 미결 항목](docs/decisions-and-open-items.md)을 확인한다. 이 문서는 가능한 모든 미래 제약을 보장하는 목록이 아니라, 현재 요청과 공식 자료를 기준으로 식별한 제품화 제약 및 검증 과제다.

## 근거의 수준

- **확정 요구**: 사용자 대화에서 확인한 제품 의도.
- **검증 사실**: 공식 자료와 실제 소스·실행·검사 증거로 확인한 범위만 기록. 합성 단일 PC 실험과 실제 제품 통합·두 PC 파일럿을 구분한다.
- **제안**: 설계 판단. 구현 승인이나 기술 선택 확정으로 취급하지 않는다.
- **실험 필요**: 실제 실행·두 PC·계정 환경에서 확인해야 하는 항목.

수집기 저장소의 판매 채널 연동은 현실적인 파일럿 문제의 예다. 관리자 저장소의 실제 구현은 열람하지 않았다. 로컬 런타임의 합성 추론 실험과 웹 모의 화면 검증을 진행했고, 검증용 로컬 Supabase 환경도 준비했다. 제품용 클라우드 계정 생성·자원 구매·서비스 배포는 아직 수행하지 않았다. 실제 호환성 확인 범위는 [연결 조사](docs/local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)와 단계별 명세를 따른다.
