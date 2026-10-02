# 공식 출처와 확인 범위

기본 확인일: **2026-09-30**. 개별 항목의 추가 확인일을 별도로 기록한다. 제품 문서는 출처에서 확인한 사실과 설계 권고를 구분한다. 계정 적격성, 실제 세션 연결, 요금, 가용성은 구현 시점·사용 계정으로 다시 확인한다.

## S1

**Vercel WebSocket**

- [WebSockets](https://vercel.com/docs/functions/websockets): 현재 베타 지원, Fluid Compute, 연결 수명·다중 인스턴스·외부 상태, framework 연결 방식.
- [Function limitations](https://vercel.com/docs/functions/limitations): runtime/플랜별 최대 실행시간·운영 한도.

과거 ‘Vercel Functions는 WebSocket 서버를 지원하지 않는다’라는 설명을 현재 제약으로 그대로 사용하지 않는다. 최신 전용 문서를 기준으로 확인했다. 한도 숫자는 이 설계에 고정하지 않았다.

## S2

**Vercel 주소·접근·플랜**

- [Generated URLs](https://vercel.com/docs/deployments/generated-urls): 배포 URL 제공과 domain 선택.
- [Deployment Protection](https://vercel.com/docs/deployment-protection): 보호 수단·적용 범위, production 접근은 별도 확인.
- [Hobby plan](https://vercel.com/docs/plans/hobby): 개인·비상업 용도 조건. 사용자가 확인한 초기 용도에 맞춰 Hobby를 기준으로 설계한다.
- [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines): Hobby의 개인·비상업 조건과 무료 자원 한도. 회사 업무용 확장은 별도로 적격성을 확인한다.

## S3

**Codex 로컬 실행·세션·관찰·개입**

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): thread start/resume/fork/read, turn start/steer/interrupt, 이벤트·approval·로컬 통신.

로컬 설치된 `codex app-server --help`로 stdio와 app-server 명령 지원도 확인했다. 이번 보완에서는 schema 생성과 별도 stdio handshake도 확인했다. 실제 제품 검증용 inference나 타 앱의 실행 중 session attach를 수행한 것은 아니다. 확인 버전·범위는 [로컬 확인 기록](#s14)을 따른다.

## S4

**OpenAI 구독 인증 통합 범위**

- [SIWC token sharing overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Codex app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server/)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations/)

공개된 제품 형태·사용자 동의·구독 인증 범위와 일반 API 권한을 구분하는 근거다. Vercel 웹과 로컬 실행을 결합한 본 제품의 적격성을 확인했다고 주장하지 않는다.

## S5

**Claude Agent SDK 실행과 세션**

- [Hosting](https://code.claude.com/docs/en/agent-sdk/hosting): SDK/runtime subprocess와 실행 환경.
- [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions): 저장 세션, resume/fork, 보존 범위.
- [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage): 기록 저장·host 이동·동시 쓰기 조건.

## S6

**Claude 관찰·입력·중단**

- [Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output): text/tool 이벤트, 하위 실행 표시에 대한 범위.
- [Streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): persistent 입력·중단과 실행 형태.
- [Python SDK](https://code.claude.com/docs/en/agent-sdk/python): client·query·interrupt API.

이 제품에서 선택할 언어/SDK 버전의 기능을 별도로 통합 검증한다. Python 인터페이스의 기능을 모든 TypeScript 버전에 동일하게 제공된다고 가정하지 않는다.

## S7

**Claude 제품 인증**

- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)

- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

SDK overview는 사전 승인 없는 제3자 제품의 claude.ai 로그인·구독 한도 제공을 제한한다. 별도 도움말의 2026-06-15 업데이트는 SDK/비대화형 CLI의 과금 변경 보류를 설명한다. 그 아래 과거 월간 credit 안내를 현재 시행 정책으로 취급하지 않는다. 개인 SDK 사용의 과금 안내와 이 제품의 구독 인증 제공 적격성은 구분하며, 본 제품의 구독 통합 허용은 아직 확인하지 않았다.

## S8

**Supabase 실시간 전달과 복구**

- [Realtime](https://supabase.com/docs/guides/realtime): Broadcast·Presence·Postgres Changes.
- [Broadcast](https://supabase.com/docs/guides/realtime/broadcast): ack 의미와 제한된 replay.
- [Presence](https://supabase.com/docs/guides/realtime/presence): 접속 상태 동기화.
- [Postgres Changes troubleshooting](https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting): 구독·전달 제약.

일반 알림과 내구 요청 상태를 구분하는 근거다. 제한된 Broadcast replay가 있더라도 업무 DB의 명시적인 catch-up 조회를 설계한다.

## S9

**Supabase 실시간 권한**

- [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization): Broadcast/Presence private 권한과 RLS.
- [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes): 테이블 구독과 접근 정책.

## S10

**Supabase 키 경계**

- [API keys](https://supabase.com/docs/guides/getting-started/api-keys): publishable/secret/service-role와 서버 키 취급.

## S11

**운영 비용**

- [Vercel Function usage and pricing](https://vercel.com/docs/functions/usage-and-pricing)
- [Vercel Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines): Hobby의 호출·CPU·메모리·전송 한도.
- [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase pricing](https://supabase.com/pricing): Free의 DB·파일 저장·전송·Realtime 한도, 휴면·백업 제약.
- [Realtime Messages usage](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages): Broadcast 발신/수신·Postgres Changes 수신자별 집계와 Presence 포함.

초기 호스팅·DB 무료 운영의 한도를 확인한 근거다. AI 비용과 향후 가격을 고정한 견적이 아니며 실제 사용량·계정·플랜으로 확인한다.

## S12

**웹과 로컬 실행의 경계** — 2026-09-30 추가 확인

- [Chrome File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access): 사용자가 선택·허용한 파일과 폴더에 접근하는 브라우저 API.
- [MDN showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker): 폴더 handle, HTTPS·사용자 동작, 브라우저 지원 제약.
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access): 공용 웹에서 로컬/loopback 요청에 필요한 허용과 secure context.
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): 확장과 설치된 native host의 통신; 웹페이지만의 기능과 구분.
- [Node.js child_process](https://nodejs.org/api/child_process.html): 로컬 Node 프로세스에서 child process를 argument 배열과 cwd로 실행하는 인터페이스.

파일 접근 handle이 OS 프로세스 실행이나 제품 connector 등록을 대신하지 않는다는 판단의 근거다. 브라우저별 실제 폴더 선택·localhost bridge는 실행하지 않았다.

## S13

**공식 원격 접속과 제품 연동의 차이** — 2026-09-30 추가 확인

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): remote TUI, stdio·WebSocket·Unix socket transport. WebSocket 경로의 experimental/unsupported 상태와 인증·네트워크 노출 조건.
- [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands): daemon·remote-control·proxy 등 로컬 프로세스 관리와 client 연결.
- [Claude Remote Control](https://code.claude.com/docs/en/remote-control): 공급자 웹/모바일에서 기존 로컬 session을 이어가는 공식 기능과 계정·실행 환경 조건.

이 기능들을 현재 사용 앱에 연결하거나 우리 공동 웹의 third-party API로 연동해 본 결과는 아니다. 저장 session resume, 같은 host에 client 연결, 임의의 독립 프로세스 attach를 구분한다.

## S14

**개인 지침·SDK 설정과 로컬 확인 결과** — 2026-09-30 추가 확인

- [Claude SDK의 Claude Code 기능](https://code.claude.com/docs/en/agent-sdk/claude-code-features): cwd와 settingSources에 따른 지침·설정·도구 로딩 범위, 별도로 읽는 managed/global 설정.
- 로컬 `codex-cli 0.159.1`: `app-server --help`, `daemon --help`, `proxy --help`, `generate-json-schema`를 확인했다. thread start/resume·turn start의 cwd/권한 필드와 interrupt 식별자가 schema에 있다.
- 별도 로컬 stdio 프로세스의 `initialize` 성공과 `initialized` 전송을 확인했다. thread·turn 생성, 개인 session 열람, 제품 검증용 inference는 수행하지 않았다.
- 로컬 `Claude Code 2.1.285`: `--version`과 `--help`만 확인했다. SDK 실행·resume·Remote Control 활성화는 수행하지 않았다.

재현 절차·검증의 한계는 [로컬 AI 연결 조사](local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)에 둔다. 임시 schema·probe 출력은 정본 문서가 아니며 이 절과 조사 결과 표가 확인 기록이다.

## S15

**로컬 개발과 클라우드 계정 준비 시점** — 2026-09-30 확인

- [Vercel Getting started](https://vercel.com/docs/getting-started-with-vercel): Vercel 계정으로 로그인하고 프로젝트를 배포하는 준비 조건.
- [Supabase Local Development](https://supabase.com/docs/guides/local-development): CLI와 Docker 호환 container runtime으로 로컬 서비스를 시작하는 조건.
- [Supabase Local development workflow](https://supabase.com/docs/guides/local-development/cli-workflows): 신규 로컬 프로젝트는 `init`/`start`로 시작하고 원격 프로젝트 연결은 로그인·link 단계로 구분.
- [Supabase Next.js quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs): 클라우드 프로젝트 생성·연결 정보와 애플리케이션 환경 설정.

로컬 화면·connector 구현과 클라우드 배포 준비를 구분하는 근거다. 실제 계정·프로젝트를 만들거나 배포한 결과는 아니다. 준비 담당과 시점은 [첫 사용 설정](onboarding-and-settings.md#개발-단계별-계정-준비)이 정본이다.

## S16

**첫 실험의 Node 실행 환경·테스트** — 2026-09-30 확인

- [Node.js Releases](https://nodejs.org/en/about/previous-releases): Node 24는 LTS, Node 20은 EOL 상태. 첫 실험은 Node 24 환경으로 검증한다.
- [Node test runner](https://nodejs.org/api/test.html): `node:test`와 `node --test`로 subprocess 기반 격리 테스트를 구성하는 근거.
- 당시 기본 `node --version`은 `v20.19.5`였다. 이후 구현·격리 검사·실제 로컬 검증은 별도로 준비한 Node 24.21.0을 명시해서 수행했다. 기본 shell의 Node 버전이 바뀌었다고 표현하지 않는다.
- 로컬 Codex 0.159.1 schema를 다시 생성해 thread start의 `sandbox`, turn start의 `sandboxPolicy`, interrupt의 `threadId`/`turnId`, 승인 응답의 `decision` 필드를 확인했다. 실제 turn 실행 증거는 아니다.

구체적인 구현·검증 범위는 [첫 구현 명세](impl-spec/001-local-ai-runtime-spike.md)를 따른다. 이 확인 과정에서 Node 설치 변경·계정 인증 변경·모델 호출은 수행하지 않았다.

## S17

**동적 도구 등록과 저장 도구 보존** — 2026-10-01 확인

- [공식 Codex app-server](https://learn.chatgpt.com/docs/app-server): `dynamicTools`와 `item/tool/call`은 experimental API이며 opt-in이 필요하다. 공식 문서는 도구를 thread rollout metadata에 보관하고 resume에서 복원하는 동작을 설명한다.
- 설치된 Codex 0.159.1의 stable 314개·experimental 440개 생성 schema에서 등록·callback·응답 형식을 확인했다. 이후 003에서 소유 합성 thread의 제한된 두 namespace 도구 callback·파일 표식 읽기와 별도 process의 동일 thread/cwd resume를 실제 확인했다. 질문 상대는 합성 fixture이며 사용자 저장소·실제 다른 AI 왕복을 검증한 결과는 아니다.

이 환경의 실제 확인 범위는 [연결 조사](local-ai-connection-research.md#이번에-실제-확인한-로컬-증거)와 [완료한 003 호환성 명세](impl-spec/archive/003-scoped-runtime-tools.md)에 기록한다. 공식 동작 설명과 실제 실행 증거는 구분한다.

## S18

**참가자별 모델·effort 선택** — 2026-10-01 추가 확인

- [Codex app-server 모델 목록](https://learn.chatgpt.com/docs/app-server#list-models-modellist): 모델별 지원 effort·기본값과 실제 client/account에 따른 반환값 사용.
- [Codex turn 설정](https://learn.chatgpt.com/docs/app-server#start-a-turn): `turn/start`의 model·effort 적용 표면.
- [Codex SIWC app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server): 해당 인증 구성에서 model catalog와 실제 inference 접근 확인의 구분.
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config): 모델 선택, effort, 모델/조직 제한과 요청값·적용값 차이.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started): 제3자 제품의 인증 조건 재확인. 개인 구독 사용 안내와 제품 인증 제공 적격성을 구분한다.
- [공식 Claude Agent SDK 0.3.286 배포물](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.286.tgz): 공개 `Query`·`ModelInfo`·`Options`·hook 타입과 구현을 읽기 전용으로 확인. 이 배포의 `claudeCodeVersion`은 2.1.286이며 현재 PC에 확인한 2.1.285와 구분한다.

공식 웹 문서와 이미 생성한 이 PC의 Codex 0.159.1 `ModelListResponse`·`TurnStartParams` schema를 대조했다. schema의 effort는 모델이 광고한 비어 있지 않은 문자열이며 고정 공통 enum으로 확정하지 않는다. Claude TypeScript 웹 참고 페이지는 수집 도구의 크기 제한·직접 요청 403으로 가져오지 못해 공식 배포 선언·구현으로 보완했다. SDK catalog는 초기화 시 목록이고 setter 수락은 적용값을 반환하지 않는다. 조건부 hook의 effort는 native harness의 관찰값이며 공급자 서버 내부 추론값의 독립 증거로 확대하지 않는다. 구현에 존재하지만 공개 `Query` 선언에 없는 `getSettings()`는 제품 계약의 근거로 사용하지 않는다.

이번 확인은 설치·스크립트 실행·새 inference·Claude SDK 실행·모델 entitlement 검사·개인 설정 변경을 포함하지 않는다. 모델 선택·effort의 실제 적용·interrupt는 해당 버전과 사용자 계정에서 통합 검증해야 한다. 제품의 의도는 [실행 설정](ai-runtime-integration.md#참가자별-도구모델effort-선택)에 둔다.

## S19

**Realtime 인증과 HttpOnly 사람 session의 접점** — 2026-10-01 추가 확인

- [Realtime setAuth](https://supabase.com/docs/reference/javascript/setauth): 표준 인증 입력은 JWT다. opaque device credential을 직접 scoped JWT로 사용할 수 있다는 계약은 없다.
- [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization): Broadcast/Presence 권한은 channel join/새 JWT에서 계산·캐시한다. membership 변경만으로 매 메시지 재검사된다고 가정하지 않는다.
- [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes): 각 event/subscriber 권한 검사와 DELETE의 RLS 예외. client filter/select가 tenant 권한 경계를 대신하지 않는다.
- [Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies): HTTP stream이 시작된 뒤에는 cookie를 설정할 수 없다.
- [Vercel Function limits](https://vercel.com/docs/functions/limitations): stream 응답도 function 수명·운영 한도의 적용 대상이다.

설치된 Supabase JS/Realtime 2.117.2의 JWT callback·deprecated WebSocket headers와 Auth SDK의 만료 전 session 갱신을 읽기 전용으로 대조했다. 현재 제품은 HttpOnly cookie를 강제하고 browser JSON에 session을 반환하지 않으며 browser JWT/Realtime client가 없다. Node fixture의 cookie decoder는 browser 기능의 증거가 아니다.

cookie/bearer durable polling과 서버 내부 JWT를 사용하는 bounded SSE hint relay는 후속 후보이며 새 stream·publication·live RLS를 실행한 결과는 아니다. 추가 signer/admin key 없이 현재 경계를 유지할 수 있는지 token 만료/갱신·권한 취소·재접속·resource 정리를 실제 검증해야 한다. connector polling을 connector Realtime 완료로 표현하지 않는다.

## S20

**Claude 기존 구독과 공식 CLI의 제품 실행 조건** — 2026-10-01 재확인

- [Claude Code 제품 실행 조건](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products): 비변조 공식 바이너리, Commercial Terms, 내장 인증 유지, 각 최종 사용자의 직접 인증·과금 조건. 자기 Claude 구독도 명시된 인증 경로다.
- [인증과 credential 사용](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): 제3자 자체 로그인·구독 요청 중개·token 취급 제한과 비변조 CLI의 사용자 직접 구독 로그인을 구분한다.
- [공식 인증](https://code.claude.com/docs/en/authentication): 사용자가 자기 계정으로 Claude Code에 로그인하는 흐름.
- [SDK 제품 인증 조건](https://code.claude.com/docs/en/agent-sdk/overview#get-started): 개인 SDK 사용과 제3자 제품의 로그인 제공 조건을 구분하는 근거.
- [비대화형 CLI와 bare mode](https://code.claude.com/docs/en/headless): `-p`·구조화 출력·중단 동작. `--bare`는 OAuth/keychain과 구독 로그인을 사용하지 않으며 일반 `-p`는 로컬 지침·hook·MCP 설정을 불러올 수 있다.
- [SDK 구독 과금 안내](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): 6월 15일 변경은 보류됐고 현재 SDK·`-p` 사용량은 구독 한도에서 차감된다. 보존된 옛 월간 credit 안내는 시행 증거로 사용하지 않는다.

사용자는 기존 구독 로그인을 우선 검토하도록 선택했다. 각 PC의 공식 CLI가 직접 인증을 소유하는 방식을 우선 후보로 둔다. 웹+connector의 공동 요청 전달이 공식 제품 실행 조건과 구독 요청 중개 제한을 모두 만족하는지는 제품 구조의 적격성 검증 항목이다. 이번 확인은 웹 문서 조사이며 CLI/SDK 실행·계정 권한·모델 호출·구독 과금의 실제 검증을 포함하지 않는다.

## S21

**Codex 공개 세션의 자동 지침과 로컬 설정 격리** — 2026-10-01 추가 확인

- [Codex AGENTS 탐색](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance): 전역·project 지침의 합성 순서와 `project_doc_max_bytes`의 합계 제한.
- [공식 config reference](https://learn.chatgpt.com/docs/config-file/config-reference): process/session 설정, 지침 크기와 project trust·sandbox의 역할. 일반 설정 응답은 최종 모델 입력 자체의 증거가 아니다.
- 설치된 Codex 0.159.1의 생성 config schema에서 skills instruction/bundled, memory 사용·생성·전용 도구, developer instructions 설정을 확인했다. 해당 설치 버전의 process-local `config/read`에서 지침 최대 0, 빈 developer instructions, skills/memory 제한과 MCP/plugin 비활성 값을 확인했다. 개인 설정 파일은 수정하지 않았다.
- 사용자 인증을 공식 CLI에 둔 상태에서 account 인식과 새 owned thread의 cwd·reported model/effort, read-only thread 조회만 확인했다. 모델 turn은 호출하지 않았고 최종 prompt·실제 적용·계정 entitlement를 증명하지 않는다. 즉시 rollout 조회는 아직 생성되지 않은 파일로 실패했고 다음 probe에서도 종료 후 rollout이 없었으므로 저장 prompt 관찰 증거로 사용하지 않는다.
- [공식 hook 탐색과 출력](https://learn.chatgpt.com/docs/hooks), [app-server hook 목록](https://learn.chatgpt.com/docs/app-server): `hooks/list`는 config 외부 JSON 등에서 발견한 hook을 조회한다. SessionStart·UserPromptSubmit 등의 출력이 모델 맥락을 추가할 수 있어 지침 최대 크기 설정만으로 이 경로까지 차단했다고 판단하지 않는다.
- hooks 객체의 존재나 비어 있는 inline event 배열만으로 실제 실행 hook을 판정하지 않는다. 이 PC의 별도 `hooks/list`는 user source의 enabled/trusted command hook 19개를 발견했다. 조회·source의 읽기 전용 대조만 수행했으며 모델 실행에서 어떤 출력을 전달했는지는 검증하지 않았다. 필수 hook/approval을 끄거나 우회하지 않았고 발견한 command·source path는 공개 DTO에 넣지 않는다. 자동 context 주입과 managed 정책은 별도 admission 검증 대상이다.
- 설치 experimental schema의 `thread/start.environments=[]`·`turn/start.environments=[]`는 native 환경 접근을 제거하는 값이다. no-turn probe에서 실제 `thread.environments=[]`를 확인했다. 같은 응답의 `instructionSources`는 지침 최대 0·빈 developer instructions에도 runtime-home의 전역 AGENTS 출처 하나를 보고했다. 실효 config만으로 이 경로의 부재를 확정하지 않는다. 모델 turn·최종 입력은 확인하지 않았다.
- owned 임시 Codex state directory에서 제품의 process-local 설정을 적용한 인증 전 probe는 활성 훅 0·지침 출처 0·native 환경 0을 보고했다. 로그인하지 않았고 auth를 복사하지 않았다. 모델 목록과 no-turn thread 생성이 가능해도 실제 계정 적격성·로그인 뒤 cloud requirements·최종 입력의 격리를 증명하지 않으므로 인증 후 다시 검사해야 한다.

실제 공개 실행기는 선택 맥락·프로세스 정책·owned session을 검증해야 하며 기존 scoped 도구 실험의 성공만으로 개인 context 격리를 확정하지 않는다. 이 확인은 제품 실행기 구현·실제 공동 조사 왕복의 완료 증거가 아니다.

## S22

**Codex의 별도 로컬 실행 프로필과 공식 직접 로그인** — 2026-10-01 추가 확인

- [공식 환경 변수](https://learn.chatgpt.com/docs/config-file/environment-variables): `CODEX_HOME`은 config·auth·logs·sessions 등의 state root이며 지정한 directory가 먼저 존재해야 한다.
- [공식 인증 저장](https://learn.chatgpt.com/docs/auth#credential-storage): 공식 CLI가 file 또는 OS credential store를 소유한다. 관리자가 강제한 인증 방식·workspace·credential store를 user 설정으로 덮어쓰지 않는다.
- [config/state 위치](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations): config profile은 기존 base 설정 위의 layer다. 개인 지침 분리를 위해 별도의 state root를 사용하는 것과 같은 base의 `--profile`은 구분한다.

별도 state root의 직접 로그인은 검토했던 후보이며 실제 수행하지 않았다. 이후 사용자가 기존 개인 에이전트 설정을 적용하도록 확정하여 필수 전용 프로필 제안은 채택하지 않았다. 기존 auth 파일 복사·symlink 공유, 개인 설정 파일의 변경, managed 정책 생략은 사용하지 않는다. 공동 조사 실행 기능은 후속 읽기 전용 우선 선택에 따라 작업에서 제한한다. 인증 전 합성 probe의 결과를 기존 계정 적격성·실제 모델 실행의 증거로 취급하지 않는다.

## S23

**기존 개인·프로젝트 에이전트 설정 적용** — 2026-10-01 사용자 확정과 공식 문서 대조

- [Claude 일반 print 실행](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode): `--bare`가 없으면 개인·작업 directory의 지침·hooks·skills·plugins·MCP 등을 로드한다. bare는 구독 로그인도 사용하지 않는다.
- [Claude 설정 우선순위](https://code.claude.com/docs/en/settings#settings-precedence): 사용자·프로젝트·local·managed 설정과 실행 flag의 적용 관계.
- [Claude 지침 로딩](https://code.claude.com/docs/en/memory#how-claudemd-files-load): 개인 `~/.claude/CLAUDE.md`와 프로젝트/상위 directory 지침. AGENTS 호환은 설치 버전과 기존 CLAUDE 지침의 존재에 따라 달라진다.
- [Codex app-server 설정과 승인](https://learn.chatgpt.com/docs/app-server): thread/turn override와 기존 설정, approval request/response 경계. 제품 도구 추가를 개인 설정 제거의 근거로 사용하지 않는다.

설치된 공식 Claude Code 2.1.286의 읽기 전용 인증 상태 명령에서 기존 로그인과 구독 metadata가 있음을 확인했다. 인증 원문·토큰을 저장하거나 복사하지 않았으며 모델 실행 권한·제3자 연결의 구독 적격성·실제 왕복의 증거로 확대하지 않는다.

사용자는 각 PC의 에이전트 설정을 유지하도록 명시했다. 로컬 지침 로딩과 공동 정보 공개를 분리하고 모델·effort를 연결별 작업 선택으로 적용하며 개인 설정 원문·인증을 중앙에 복제하지 않는다. 공동 조사 범위는 읽기·격리 검증·수정 제안으로 확정했으므로 그 세션의 권한은 축소한다. 후속 선택은 읽기 전용 우선이며 권한을 검증하지 못한 MCP·플러그인·훅 실행을 조사 동안 제한한다. 개인 설정 파일의 변경과 작업 권한 상한은 구분한다. 기존 S21 격리 probe는 당시 실험이고 현재 정책의 수용 증거가 아니다. 공식 문서 대조는 제품 CLI에서 실제 설정·승인·모델 실행을 검증한 결과와 구분한다.

## S24

**Codex no-turn 준비 문맥의 저장과 재시작** — 2026-10-01 설치 0.159.1에서 확인

설치된 공식 CLI와 exact owned 합성 state/thread만 사용한 no-turn probe에서 `thread/start` 직후 rollout이 없고 full history read와 새 프로세스 resume가 실패했다. 같은 새 owned ID의 `thread/name/set` 이후 저장 rollout과 zero-turn full read를 확인했고, graceful shutdown 뒤 별도 공식 프로세스의 같은 ID read/resume도 성공했다. 생성 schema의 이름 요청·빈 acknowledgement와 대조했으며 [공식 thread API](https://learn.chatgpt.com/docs/app-server)의 user-facing name 설정 표면을 사용했다.

이 검증은 모델 turn, auth 복사·로그인, 개인 설정 변경이나 임의 기록 탐색을 포함하지 않는다. 제품 adapter의 저장 보완과 회귀 검증은 진행 중이며 no-turn 저장 성공을 실제 공동 질문 왕복의 성공으로 확대하지 않는다.

## S25

**개인 설정 유지와 공동 조사 권한 상한** — 2026-10-01 사용자 확정·설계 리뷰·설치 설정 조회

[공식 MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)과 [플러그인 MCP 설정](https://developers.openai.com/plugins/build/plugins)은 서버·도구별 승인 설정을 제공한다. `writes`는 read-only 표시가 없는 도구에 승인을 요구하는 분류이며 외부 서버의 무부작용 증명이 아니다. 기존 `prompt`와 비활성 상태를 보존하고 작업의 자동 승인·reviewer 우선순위를 함께 확인해야 한다.

설치 Codex 0.159.1의 기존 프로필에서 모델 호출 없이 작업의 read-only/never/user와 MCP 기본 승인 상한을 조회했다. 주요 개인 설정 필드의 유지와 일곱 적용값을 확인했고, 개인 설정·인증은 변경하지 않았다. 인자가 따옴표 포함 dotted key로 전달되면 별도 MCP 이름으로 해석되어 시작에 실패했으며 top-level TOML map으로 전달한 조회는 통과했다. 이 결과는 설정 수용 증거다. 제품 실행기·실제 승인 경로·전체 도구 활성 상태·외부 부작용의 검증을 완료한 것으로 표시하지 않는다.

## S26

**Codex 플러그인 설치 상태와 상세 정보의 조회 범위** — 2026-10-01 설치 0.159.1 대조

[공식 설치 버전의 플러그인 처리 코드](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/app-server/src/request_processors/plugins.rs)는 `plugin/installed`의 요청 cwd와 local `plugin/read`의 marketplace parent를 서로 다른 설정 조회에 사용한다. 실제 로컬 metadata에서 일부 플러그인의 두 응답은 설치·활성 boolean만 달랐고 나머지 summary 필드는 같았다. 이 근거에 따라 선택한 cwd의 설치 catalog를 상태 기준으로 쓰고 상세 정보는 identity·source·정책·selector를 대조하는 보정을 검토했다. 두 원본 응답의 이후 변화는 계속 거절한다. 이 판단은 조회 범위와 관찰에 근거한 구현 결정이며 모든 버전의 응답이 같다는 보장이 아니다.

같은 공식 코드의 설치 조회는 native bundle sync를 시작할 수 있다. 제품이 install/reconcile 요청을 보내지 않았다는 사실을 native 내부 cache가 전혀 변하지 않았다는 주장으로 확대하지 않는다. 제품의 모델 없는 설정 조회는 metadata 비교에서 거절됐으며 실제 공동 왕복·승인 경로의 통과 증거가 아니다.

## S27

**Codex 실행 권한 검증의 한계와 읽기 전용 우선 선택** — 설치 0.159.1 소스 대조·독립 설계 리뷰, 2026-10-02 사용자 보완

[공식 플러그인 loader](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/core-plugins/src/loader.rs)와 [MCP 호출 승인 처리](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/core/src/mcp_tool_call.rs)는 서버 기본 승인보다 도구별 승인을 우선한다. manifest의 도구별 자동 승인을 빠뜨린 기본 `writes` 제한은 충분하지 않다. [공식 MCP 상태 조회](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/app-server/src/request_processors/mcp_processor.rs)는 해결된 서버 목록을 제공하지만 모든 출처·설치 상태의 완전성과 실행 중 불변성을 보장하는 계약은 아니다. 설치된 기존 프로필의 모델 없는 조회에서 일반 서버 3개를 확인했으나 이를 전체 작업 권한 검증으로 채택하지 않았다.

독립 리뷰는 manifest 우선순위, 상태 목록의 출처 구분·원자성, 실행 중 bundle 갱신 문제로 초기 overlay 설계를 거절했다. 해당 설계로 실제 모델 turn을 실행하지 않았다. 사용자는 개인·프로젝트 지침과 설정 파일을 유지하면서 권한을 검증하지 못한 MCP·플러그인·훅 실행을 공동 조사에서 제한하는 방식을 선택했다. 이 선택에 따른 작업 전용 제한 구현과 설치 버전의 실제 적용 검증은 진행 중이다.

[공식 정규화 관리 flag](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/core/src/config/managed_features.rs)와 [최초 app-server 생성](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/app-server/src/message_processor.rs)은 관리 pin과 검사 전 plugin 시작을 구분해야 한다는 근거다. [공식 features list 경로](https://github.com/openai/codex/blob/rust-v0.159.1/codex-rs/cli/src/main.rs#L1805)는 app-server·MCP·훅 런타임 없이 공식 auth·cloud 설정을 로드하고 정규화 flag를 출력한다. 모든 child 이전에 이 경로를 검사하는 보완 설계3는 독립 검토에서 차단 지적 없이 통과했다. 설치 CLI의 모델 없는 선행 검사에서 요구 실행 flag 13개가 지원되고 모두 false임을 확인했고 app-server·thread·모델은 생성하지 않았다. 이 두 공식 프로세스는 같은 원자 snapshot을 공유하지 않으므로 admission 중 안정된 설정을 기준으로 한다. 제품 구현·실제 native 공동 왕복·정식 구현 리뷰의 증거와 구분한다.

## 참고하되 첫 구현에 포함하지 않은 방향

- [A2A specification](https://a2a-protocol.org/latest/specification/): 표준 agent 간 메시지·task·artifact·취소 모델. 공급자 세션 연결·로컬 권한·사내 UI를 대신하지 않으며 MVP의 필수 기술로 확정하지 않았다.
- [Claude Managed Agents events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming): cloud 관리 session의 관찰·개입 대안. 기존 로컬 session에 연결하는 것과 실행 위치가 다르다.
