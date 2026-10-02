# 웹에서 로컬 저장소와 각자의 AI 연결 조사

확인일: **2026-10-01**. 공식 인터페이스, 로컬 프로토콜과 합성 저장소의 실제 실행 결과를 기록한다. 제품의 connector, 실제 웹 제어, 두 PC 협업은 아직 구현하지 않았다. 세션 연결 수준의 정본은 [AI 런타임 연동](ai-runtime-integration.md), 실행 규칙의 정본은 [비즈니스 로직](BUSINESS-LOGIC.md)이다.

## 조사 결론

**웹에서 각 PC의 로컬 저장소를 대상으로 AI를 실행하고 결과를 관찰하는 구조는 구현 가능하다.** 각 PC에 설치한 connector가 저장소를 등록하고 로컬 AI 프로세스를 제어하며, 웹은 등록된 연결을 선택하고 작업 요청을 보낸다. 이것은 공식 런타임 기능을 조합한 설계 판단이며 이 제품의 동작을 검증한 결과는 아니다.

| 사용자가 기대하는 동작 | 판단 | 확인 범위 |
|---|---|---|
| 웹에서 등록한 내 PC·저장소의 AI 실행 | 구현 가능한 경로 있음 | 로컬 프로세스 실행, cwd 설정, 입력·출력·중단 인터페이스 |
| 웹 입력칸에 경로만 넣고 설치 없이 로컬 CLI 실행 | 일반 웹페이지만으로 제공할 수 없음 | 폴더 접근 권한과 OS 프로세스 실행은 다른 기능 |
| 평소 쓰던 저장 세션 이어가기 | 공식 resume/fork 경로 있음 | 맥락·설정·cwd·동시 사용은 실제 버전으로 확인 필요 |
| 실행 중인 임의의 IDE/CLI 세션에 우리 웹이 연결 | 앱별 검증 필요 | 공급자의 공식 원격 기능이 제3자 연동 API를 보장하지 않음 |
| 각 개발자가 서로 다른 공급자 사용 | adapter별 구현 가능 | 상대 AI에 직접 로그인하지 않고 자기 runtime만 연결 |
| 기존 개인 구독을 그대로 제품에서 사용 | 적격성 미확정 | 제품 형태·공급자 인증 조건·각 계정 확인 필요 |

## 브라우저에서 로컬 경로를 설정한다는 의미

웹의 경로 문자열은 접근 권한도 실행 권한도 아니다. 일부 브라우저의 `showDirectoryPicker()`는 사용자가 선택한 폴더의 handle을 반환하지만 일반 OS 절대 경로나 CLI 실행 수단으로 취급할 수 없다. 지원 브라우저, HTTPS, 사용자 동작·허용이 필요하다. [폴더 접근 근거](sources.md#s12)

폴더 선택 handle을 Node.js의 cwd로 바로 전달하는 설계를 쓰지 않는다. 웹에서는 등록된 저장소 별칭을 선택하고, 실제 canonical path는 connector가 자기 PC에서 확인해 로컬 매핑으로 유지하는 것을 권고한다.

| 위치 | 보관·처리하는 값 |
|---|---|
| 로컬 connector | 실제 root·worktree 경로, 공급자 session locator, 공급자 인증, 실행 권한 |
| 중앙 서비스 | 사람·기기·방·binding의 식별자, 공유 별칭·branch·연결 수준, 확정 질문·답변 |
| 웹 | 내가 선택한 기기·저장소·AI/session, 준비 상태, 공유 범위, 실행·개입 상태 |

원격 셸 문자열이나 임의의 절대 경로를 웹에서 받아 바로 실행하지 않는다. 등록된 binding만 해석하고 root와 session cwd가 일치하는지 로컬에서 다시 검사한다. 웹 사용자 인증은 자기 PC의 실행 허용을 대신하지 않는다.

## 권고 연결 방식과 대안

전체 연결도와 처리 경계는 [아키텍처](ARCHITECTURE.md#추천-구조)가 정본이다. 웹은 등록된 binding의 작업을 요청하고 각 PC의 connector가 자기 runtime를 실행한다. connector의 outbound 연결에는 PC의 외부 공개 포트가 필요하지 않다. 모델 호출은 해당 공급자로 나간다.

| 방식 | 가능한 범위 | 부담·선택 |
|---|---|---|
| Outbound connector | 웹 제어·각 PC의 runtime 실행·공동 기록 | 설치 필요. 첫 구현 권고 |
| 웹 → localhost bridge | 설치한 로컬 서비스에 직접 요청 | Origin·인증·CSRF·브라우저 로컬 네트워크 권한·재접속 검증 필요 |
| 브라우저 확장 + Native Messaging | 확장이 설치된 native host와 통신 | 확장과 native host 둘 다 배포해야 함 |
| 클라우드에서 저장소 clone 후 실행 | 웹만으로 별도 실행 환경 제공 | 로컬 미커밋 파일·현재 도구·실행 중 session을 그대로 유지하지 않음 |

Chrome은 공용 웹에서 loopback/로컬 네트워크로 보내는 요청에 별도 허용 체계를 적용한다. localhost bridge를 모든 브라우저에서 당연히 동작하는 경로로 가정하지 않는다. Native Messaging도 웹페이지 단독 기능이 아니라 확장과 설치된 host의 연결이다. [브라우저 연결 근거](sources.md#s12)

## 각자의 AI로 접속하는 순서

접속 순서와 계정·기기·저장소·session 확인은 [최초 접속 흐름](onboarding-and-settings.md#최초-접속-흐름)에 모았다. [005](impl-spec/archive/005-device-and-workspace-binding.md)의 제품 connector 등록·교체·취소는 구현·검증했고, [007](impl-spec/007-owned-codex-workflow-runner.md)의 Codex 실행 명령은 구현·검증 중이다. 실제 provider 왕복과 기존 개인 설정 유지의 최종 검증은 아직 완료하지 않았다.

A가 Codex, B가 Claude여도 각자의 adapter가 같은 제품 메시지를 runtime 입력으로 바꾼다. 상대 AI가 상대 저장소를 직접 읽는 방식이 아니라, 소유자의 AI가 자기 저장소에서 근거를 만들어 공유한다.

## Codex의 연결 지점

공식 app-server를 connector의 child process로 실행하고 stdio JSON-RPC를 사용하는 경로가 있다. Node.js는 `spawn`의 argument 배열과 cwd로 프로세스를 실행할 수 있다. 경로·입력을 shell 문자열에 보간하지 않는다. [런타임·프로세스 근거](sources.md#s3), [Node.js](sources.md#s12)

| 목적 | 인터페이스 | 제품에서 확인할 것 |
|---|---|---|
| 연결 시작 | `initialize` → `initialized` | protocol/client 버전, 지원 capability |
| 저장 세션 선택 | `thread/list`, `thread/read` | 후보만 로컬에서 조회하고 선택한 별칭만 공유 |
| 새 세션/이어가기 | `thread/start`, `thread/resume`, `thread/fork` | 등록 cwd, 연결 수준, 지침·도구·권한 |
| 조사 실행 | `turn/start` | 지정 thread·입력·현재 epoch, read-only scope |
| 출력 관찰 | `item/*`, `turn/*` notification | 공개 필드만 선택, 실제 종결 확인 |
| 중단 | `turn/interrupt` | 응답 성공과 실제 작업 종료를 구분 |

현재 Codex에는 동일 app-server에 접속하는 remote TUI와 Unix socket/daemon/proxy 경로도 있다. 따라서 실행 중 연결을 원천적으로 불가능하다고 단정하지 않는다. 선택한 앱이 같은 app-server를 공유하는지, 현재 thread를 관찰·제어할 수 있는지, 동시 입력·승인이 어떻게 동작하는지는 별도 실험이다. 임의의 독립 CLI 프로세스에 자동 연결된다는 뜻은 아니다. [공식 접속 근거](sources.md#s13)

## Claude의 연결 지점

Agent SDK는 connector가 운영하는 프로세스에서 Claude Code 실행을 관리하는 후보다. 공식 문서에서 cwd·저장 session 조회·resume·fork·stream·interrupt 경로를 확인할 수 있다. 개인 지침과 설정의 로딩 범위도 검증해야 하며 원래 앱과 동일한 도구·개인 맥락이 보존된다고 자동 표시하지 않는다. [SDK 근거](sources.md#s5), [설정 근거](sources.md#s14)

Claude Remote Control은 **공급자의 웹/모바일과 로컬 세션을 이어 쓰는 공식 기능**이다. 기존 세션에서 활성화하는 경로가 있고 PC와 프로세스가 계속 실행돼야 한다. 이 기능의 존재만으로 우리의 공동 웹에 직접 연결할 공개 API나 두 사용자의 AI 간 자동 라우팅이 확보되었다고 볼 수 없다. Agent SDK와 Remote Control을 서로 대체 가능한 인증·세션 API로 취급하지 않는다. [공식 Remote Control](sources.md#s13)

## 세 종류의 인증과 비용

| 인증 | 목적 | 분리 기준 |
|---|---|---|
| 사람 로그인 | 조사방 읽기·발언·자기 AI 제어 | 제품 계정과 방 멤버십 |
| connector 기기 인증 | 요청 수신·상태 보고·자기 scope 실행 | 취소 가능한 제한된 device token |
| AI 공급자 인증 | 모델 호출과 공급자 과금 | 공급자가 허용한 사용자별 로컬 인증 경로 |

OpenAI의 ChatGPT plan usage는 공개된 로컬/오픈소스 범위와 hosted app의 적격성을 구분한다. Vercel 공동 웹과 로컬 실행을 결합한 이 제품에 구독을 사용할 수 있는지는 아직 확정하지 않았다. 인증 성공이 구독 통합 허용이나 기존 ChatGPT 대화 접근을 뜻하지 않는다. [인증 근거](sources.md#s4)

Claude는 SDK overview의 제3자 제품 인증 조건과 도움말의 개인 구독 SDK 사용 안내를 함께 확인해야 한다. 도움말에는 2026-06-15 과금 변경을 보류했다는 최신 설명이 있고, 그 아래 예전 월간 credit 안내는 시행된 현재 정책으로 인용하면 안 된다. 이 제품의 구독 연동 허용까지 확인한 것은 아니다. [두 공식 자료](sources.md#s7)

## 이번에 실제 확인한 로컬 증거

| 확인 | 결과 | 증명하지 않는 것 |
|---|---|---|
| `codex --version` | `codex-cli 0.159.1` | 상대 PC 버전 |
| `claude --version` | `2.1.285 (Claude Code)` | Agent SDK 설치·연동·계정 적격성 |
| `codex app-server --help` | stdio·Unix socket·WS, schema 생성·daemon·proxy 명령 표시 | 제품 연결·운영 지원 보장 |
| `generate-json-schema` | start/resume/turn의 cwd·권한 필드, interrupt의 threadId·turnId 확인 | 실제 호출·도구 중단 성공 |
| 별도 stdio 프로세스의 `initialize` | 성공 후 `initialized` 전송, 프로세스 종료 | thread 생성·resume·추론·공동 조사 |
| TypeScript 실험 도구 | Node 24.21.0 타입 검사·34/34 격리 테스트·initialize-only probe, 독립 구현 리뷰 통과 | 제품 connector·DB·기기 인증 |
| 허용된 파일·질문 도구 확장(003) | 기존 34개와 도구 검사 17개를 합친 51/51 격리 검사·타입 검사·독립 재리뷰 통과. 최종 빌드와 동일한 제한 namespace initialize-only probe 확인 | 실제 사용자 저장소·상대 AI·내구 전달·두 PC 왕복 |
| 합성 저장소의 실제 새 질문 | Codex 0.159.1, `gpt-6.1-sol`, 기존 로컬 로그인에서 `COMPLETED` 관찰 | 실제 코드 조사·다른 PC·제품의 구독 통합 적격성 |
| 실험이 만든 저장 thread의 순차 resume | 별도 process의 `COMPLETED`, 실제 thread/cwd 일치, 대화에만 있던 표식을 재전달 없이 회수 | 임의 개인 session·L3 live attach·모든 지침/도구 보존 |
| 실제 실행 중 interrupt | ACK 수신 이후 `turn/completed`의 `INTERRUPTED` 확인 | 이미 수행한 작업의 취소·모든 도구/하위 process 종료 |
| 실제 모델의 파일 읽기 시도 | 명시적인 합성 파일 읽기 질문에 `READ_UNAVAILABLE`, 저장 기록에 `commandExecution` 없음 | 파일 읽기 성공으로 판정하지 않음. 제한된 파일 도구 노출을 후속 검증 |
| experimental 도구를 등록한 실제 새 실행 | `COMPLETED`, 정책 확인 통과. 소유 rollout에 `read_workspace_file`·`ask_peer` 두 정의 저장. 실제 callback은 0회이고 파일 표식 증거는 불일치 | 모델은 도구 불가 취지로 응답했다. 파일 읽기 성공·resume 보존으로 판정하지 않으며 원인 확인 전 같은 호출을 반복하지 않음 |
| 고정 namespace로 보정한 실제 새 실행 | `ai_collaboration_scoped`의 파일 읽기 2회·로컬 질문 1회, 정책 확인·`COMPLETED`·파일-only 표식의 현재 turn 최종 응답 일치. 소유 `thread/read`에서도 도구 namespace·완료·success 확인 | 질문 상대는 로컬 fixture이며 다른 AI가 아님. 실제 ModelInfo의 모드와 최초 실패의 단일 원인까지 증명한 것은 아님 |
| 제한 도구의 별도 process resume | 같은 소유 thread/canonical cwd·새 attempt, 파일 표식을 교체한 뒤 읽기 2회·로컬 질문 1회와 새 최종 응답 일치. 저장 도구 실제 사용 확인 | 임의 개인 세션·모든 지침/도구 보존·L3 live attach |
| 실행 전 sandbox·도구 정책 검사 | `read-only`·승인 `never`, MCP/plugin 활성 0, 앱·웹 검색 등 비활성. 별도 `command/exec`로 공개 fixture 읽기 허용·쓰기 차단 확인 | 모델의 읽기 도구 가용성·root 밖 읽기 차단·모든 PC의 동일 정책 |

스키마 생성과 handshake는 종료 코드 0으로 완료했다. protocol probe는 thread 생성·모델 호출·개인 세션 열람·토큰 출력 없이 실행했다. 실제 turn 실험은 이와 별도로 명시적으로 수행했다.

실제 실행은 이 도구가 생성한 공개 합성 root에서만 수행했다. 공급자 인증 파일을 복사하거나 개인 설정·승인 훅을 바꾸지 않았고, 원래 개인 thread 목록도 조회하지 않았다. 소유한 실험 thread만 `thread/read`로 확인해 실제 cwd·식별자를 대조했다. 원본 대화 표식·hash·native ID·절대 경로는 이 문서에 남기지 않는다. 중단 실험의 CLI 종료 코드 1은 성공 완료가 아닌 `INTERRUPTED`를 반환한 결과이며, 중단 판정은 실제 terminal을 기준으로 했다.

대화 재개·중단 성공과 파일 읽기 성공은 다르다. 현재 제한 설정에서 모델의 파일 읽기를 확인하지 못했으므로 실제 저장소 조사 준비 완료로 표시하지 않는다. 이 PC의 기존 로그인에서 호출이 수락된 사실을 hosted 제품의 구독 통합 허용으로 확대하지 않는다.

설치 버전의 기본 schema에는 `thread/start.dynamicTools`가 없지만 `generate-json-schema --experimental` 생성본에는 해당 배열과 `item/tool/call` callback 계약이 있다. 현재 공식 문서는 experimental opt-in과 도구의 rollout 저장·resume 복원을 설명한다. 첫 flat 등록은 callback 없이 끝났고 그 실패 기록을 보존했다. 이후 두 도구를 고정 namespace에 등록하고 process-local `features.code_mode.direct_only_tool_namespaces`를 그 한 항목으로 제한한 후보에서 실제 new/resume 도구 사용을 검증했다. 셸·code mode host 등 14개 기능 차단과 MCP/plugin 비활성화는 유지했다. 설치 tag에는 직접 namespace 노출 분기가 있지만 실제 내부 ModelInfo를 조회하지 않았으므로 최초 실패의 원인은 가설로 구분한다. [완료한 003 명세](impl-spec/archive/003-scoped-runtime-tools.md), [공식 설명과 로컬 schema의 구분](sources.md#s17), [설치 tag의 도구 노출 코드](https://raw.githubusercontent.com/openai/codex/rust-v0.159.1/codex-rs/core/src/tools/spec_plan.rs)

재현 절차는 `codex --version`, `codex app-server --help`, `codex app-server generate-json-schema --out <임시 디렉터리>`로 schema를 생성하고, stdio 프로세스에 `initialize`/`initialized`만 보내는 것이다. 생성 파일은 임시 산출물이며 이 조사 문서에 확인 결과를 남긴다.

## 구현 전에 닫을 실험

공급자별 미확인 항목은 [런타임 실험 목록](ai-runtime-integration.md#실제-실험으로-닫을-항목), 두 PC 왕복·인증·중단·복구·private 격리의 실행 순서와 통과 근거는 [제품 성립 조건 실험](delivery-and-validation.md#0-제품-성립-조건-실험)과 [필수 검증](delivery-and-validation.md#의미-있는-필수-검증)에 모았다.

이 PC의 CLI 설치 사실로 두 사람의 평소 앱·버전·OS를 추정하지 않는다. 측정 전 무료 운영·구독 재사용을 완료 상태로 표시하지 않는다.

이후 결과는 이 문서의 확인 표와 [미결 항목](decisions-and-open-items.md)에 반영한다. 구조와 불변식이 바뀌면 ARCHITECTURE/BUSINESS-LOGIC, 기술 선택이 확정되면 ADR을 갱신한다. 코드 수준 계획은 실제 구현 요청 후 `docs/impl-spec/`에 작성한다.
