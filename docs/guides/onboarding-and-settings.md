# 첫 사용 설정과 준비 상태

웹 로그인은 사람을 식별하고, 로컬 저장소와 AI 연결은 별도로 등록한다. 사용자가 접속 전에 모든 설정값을 알아야 하는 흐름으로 만들지 않는다. 웹에서 준비 상태와 안내를 확인하고 필요한 로컬 등록을 진행할 수 있게 한다.

질문만 하는 참가자는 웹 로그인과 방의 질문 권한으로 준비된 상대 AI에 질문한다. 자기 AI·로컬 경로·기기 등록은 선택 사항이다. 답변용 AI를 제공하거나 자기 AI로 공동 조사할 때만 아래 로컬 연결 절차를 진행한다. [직접 질문 구현](../impl-spec/archive/010-human-direct-questions.md)은 기존 두 AI의 조사 시작과 별도로 동작한다. 현재 검증과 남은 Claude 연동 범위는 [진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

브라우저의 폴더 접근 handle과 로컬 CLI 실행은 다르다. 실제 경로는 connector의 로컬 선택 화면/CLI에서 등록하고 웹에서는 등록된 binding을 선택한다. 설치·접속 방식과 공급자별 연결 가능 범위는 [로컬 AI 연결 조사](../research/local-ai-connection-research.md)를 따른다.

## 설정의 세 층

| 담당 | 설정 | 입력/확인 위치 | 사용자에게 보여줄 것 |
|---|---|---|---|
| 서비스 운영자 | 웹 주소, 호스팅·DB·Realtime, 인증·초대 정책 | 배포 설정·운영 화면 | 서비스 URL, 사용 가능 상태, 초대/로그인 안내 |
| 서비스 운영자 | 허용 AI/provider, 데이터 공유·보관, 기본 실행 scope·한도 | 운영 정책 | 사용할 수 있는 도구와 공유 가능한 정보, 한도 |
| 모든 참가자 | 제품 계정·방 권한 | 웹 로그인·초대 | 로그인 상태, 참가자/observer 역할 |
| AI 연결 소유자 | 기기 연결 | 웹 pairing | 연결한 사람·기기·최근 확인, 연결/취소 버튼 |
| AI 연결 소유자 | 저장소 root | 로컬 선택 화면 또는 CLI 안내 | 저장소 별칭, branch/worktree, 파일 변경 여부 |
| AI 연결 소유자 | AI 도구·인증·session | 로컬 runtime와 연결 안내 | 도구 종류/버전, 로그인 상태, session 별칭, 연결 수준 |
| 질문할 참가자 | 상대 등록 연결·질문 | 웹 조사방 | 상대 사람·AI·저장소·준비 상태, 확인된 공유 범위 |
| 공동 조사 참가자 | 사용할 등록 연결·공유 scope·문제 | 웹 조사방 | AI별 저장소/branch/session, 준비 상태, 공동 목표 |

서비스의 DB password/service-role key를 일반 개발자 설정값으로 보여주지 않는다. 공급자 인증은 공급자가 허용하는 로컬 흐름으로 진행하고 웹 입력칸에 기존 AI 로그인 토큰을 붙여넣게 하지 않는다.

초기 운영의 권고 후보는 개인·비상업용 실험에 맞춘 Vercel Hobby와 Supabase Free다. 참여자는 서비스 운영자와 별도로 유료 호스팅 계정을 만들 필요가 없다. 설정 화면에는 현재 플랜·사용량 확인 시각·남은 한도와 AI 과금 경로를 구분해 보여준다. 측정값이 없으면 무료 운영이 보장되는 것처럼 표시하지 않고 '사용량 확인 필요'로 안내한다.

## 개발 단계별 계정 준비

Vercel/Supabase 후보를 선택하더라도 구현 시작 전에 클라우드 계정·프로젝트가 모두 준비돼 있어야 하는 것은 아니다. 계정 준비는 서비스 운영자 작업이며 조사방 참여자마다 호스팅 계정을 만들지 않는다.

| 단계 | 필요한 준비 | 클라우드 계정 필요 여부 |
|---|---|---|
| 화면·모의 runtime·connector 로컬 구현 | 선택한 언어/프레임워크와 개발 도구 | Vercel/Supabase 계정 없이 시작 가능 |
| 로컬 DB·Auth·Realtime 통합 | Supabase CLI와 Docker 호환 container runtime | 클라우드 프로젝트 없이 로컬 stack으로 개발·검증 가능 |
| Vercel 배포·Supabase 클라우드 연동 | 운영자의 Vercel 계정/프로젝트, Supabase 계정/프로젝트와 환경 설정 | 실제 클라우드 연결 검증 전에 필요 |
| 실제 AI 실행 실험 | 각 사용자의 설치된 runtime와 공급자가 허용한 인증·과금 경로 | 호스팅 계정 준비와 별개이며 실제 호출 전에 필요 |

Supabase의 신규 로컬 개발 흐름은 CLI·container runtime으로 시작하고, 원격 프로젝트를 연결할 때 로그인·프로젝트 연결을 수행한다. Vercel 배포에는 Vercel 계정이 필요하다. [공식 준비 조건](../research/sources.md#s15)

권고 순서는 로컬 핵심 흐름 검증 → 선택한 클라우드의 계정·프로젝트 준비 → 배포·로그인·기기 연결·두 PC 왕복 검증이다. 클라우드 단계에서는 서비스 주소, 인증 redirect, 환경 변수, 방·기기 권한도 실제 배포 기준으로 확인한다. 질문만 하는 참여자는 제품 계정·방 권한을 준비한다. AI를 제공할 참여자만 자기 AI 인증과 로컬 연결을 추가한다.

## 현재 구현한 로컬 로그인과 조사방

실제 웹 경로는 `/login`, `/app`, `/app/rooms/<roomId>`, `/app/connections`다. 이메일 코드를 확인하면 자기 그룹·방을 만들고 participant/observer 초대를 발급하거나 코드로 참가할 수 있다. 현재 DB membership으로 권한을 확인한다. 기기 코드 승인·공개 저장소/session 등록은 가능하다. 실제 Codex 실행은 아래 로컬 CLI로 준비하며, 등록만으로 실행 준비가 완료되지는 않는다.

방의 실제 공동 이력은 DB cursor polling으로 복원한다. 참가자는 공동 발언과 조사/중단/방·조사 재개를 구분해 사용할 수 있다. driver가 없는 binding은 미검증 안내를 유지한다. 중앙 조정과 실제 Codex의 한 PC 왕복·중단을 검증했다. 검사 수치와 실제 두 PC·Claude의 남은 범위는 [진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

개발자는 Node 24에서 `npm ci` 후, [환경 변수 예시](../../.env.example)의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`을 프로세스 환경에 전달해 `npm run dev`를 실행한다. `APP_ORIGIN`은 브라우저로 접속할 정확한 origin이어야 한다. 제품 웹 서버에는 admin/service-role key·DB password·AI 공급자 인증을 전달하지 않는다. 실제 설정을 파일로 만들 때는 개인 자격증명을 저장소에 포함하지 않는다.

새 격리 로컬 Supabase에는 [첫 migration](../../supabase/migrations/20261001000100-web-auth-room-access.sql)부터 [실행 조정](../../supabase/migrations/20261001000600-durable-investigation-coordinator.sql)까지 여섯 파일을 이름 순서대로 적용한다. 기존 DB에는 아직 적용하지 않은 후속 파일만 적용하며 reset·기적용 파일 수정/재적용을 하지 않는다. 실행 중인 PostgREST에는 적용 후 DB에서 `NOTIFY pgrst, 'reload schema';`를 보내 schema cache를 갱신한다. OTP 메일 template은 [magic-link.html](../../supabase/templates/magic-link.html)의 `{{ .Token }}`을 local Auth의 magic-link·confirmation 설정에 연결한 뒤 해당 stack을 재시작해 실제 발송을 확인한다. 개발용 Mailpit을 사용하는 loopback 실험은 외부 이메일을 발송하지 않는다.

현재 실제 검사는 소유권을 확인한 로컬 Docker project의 여섯 container와 API/DB/Mailpit의 고정 loopback port를 사용한다. `test:integration`, `test:e2e:auth`의 test-parent 환경은 [local-access-stack](../../tests/helpers/local-access-stack.ts)이 제한하며 일반 `npm test`·모의 browser 검사와 분리된다. parent에만 `LOCAL_ACCESS_PROJECT`, `LOCAL_ACCESS_STACK_WORKDIR`, `LOCAL_ACCESS_DB_URL`, `LOCAL_ACCESS_MAIL_URL`, `LOCAL_ACCESS_ADMIN_KEY`, `LOCAL_ACCESS_SIGNING_JWK`가 필요하다. browser에는 scope가 제한된 fixture bridge만 전달하고 제품 child에는 위 세 제품 설정만 전달한다. 설정이 원격이거나 다른 project이면 fixture 생성·삭제를 거절한다. 정리는 생성한 합성 ID와 inbox만 대상으로 한다.

사람 인증·방 접근과 기기 등록의 통합·브라우저 검사 및 독립 리뷰를 완료했다. 두 PC·Claude·Realtime·개인 설명의 제품 통합은 후속 범위다. 현재 검증 수치와 순서는 [개발 순서와 검증 계획](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 현재 로컬 기기와 저장소 등록

현재 CLI는 macOS·Node 24를 지원한다. 루트에서 아래처럼 준비한다.

```sh
npm --prefix packages/local-connector ci
npm --prefix packages/local-connector run build
node packages/local-connector/dist/src/cli.js pair --server https://your-service.example --profile my-device --device-alias '내 개발 PC'
```

출력한 일회용 코드를 `/app/connections`에서 자기 계정·조사방·공개 범위를 확인하고 승인한다. 같은 server/profile로 `status`를 실행해 승인된 소유자와 방을 확인한 뒤 `exchange --confirm-scope <room-uuid>`를 실행한다. 개발용 HTTP는 canonical loopback만 허용한다. proof·credential을 웹에 입력하지 않는다.

`register`는 같은 server/profile에 `--root`, `--native-session`, `--repository-alias`, `--session-alias`, `--confirm-public yes`를 받는다. 실제 경로와 native 식별자는 로컬에 저장하고 공개 별칭·Git branch/commit만 전송한다. Git 변경 여부는 현재 `unknown`이며 등록의 native 식별자를 실제 실행 소유권으로 인정하지 않아 `codex/registered/unverified`로 표시한다. Codex 모델·effort는 별도의 로컬 실행 준비에서 선택하며 웹 선택 화면과 Claude는 후속 범위다.

private profile은 기본적으로 사용자의 `Library/Application Support/ai-collab/connector` 또는 명시한 state-dir에 둔다. 디렉터리 0700·파일 0600, 소유권·symlink·process lock과 atomic journal을 검사한다. broad root와 개인 인증/설정 경로 및 외부로 연결된 해당 symlink target은 등록할 수 없다.

`rotate`·등록·교체의 응답 유실은 저장한 같은 operation으로 복구한다. 최초 `begin`의 응답을 잃어 scope를 확인할 수 없으면 `status` 안내에 따라 `revoke-local`로 그 profile을 제거하고 새 code와 사람 승인을 받는다. 자동으로 새 기기·key를 만들지 않는다. 웹의 취소/제거·membership 제거·credential 만료 뒤에도 새 승인이 필요하다. `revoke-local`은 자기 로컬 profile만 제거하며 원격 취소는 웹에서 별도로 수행한다.

## 로컬 Codex 실행 준비

[007](../impl-spec/archive/007-owned-codex-workflow-runner.md)의 CLI 구현을 기준으로 한 로컬 절차다. 기존 설정 파일을 유지한 공식 Codex의 왕복·중단을 한 PC의 합성 저장소에서 확인했고 독립 구현 리뷰를 완료했다. 실제 두 PC·다른 계정의 검증은 남아 있다. 현재 공개 binding에는 모델·effort나 검증 완료 표시를 추가하지 않았다.

같은 server/profile의 `runtime-capabilities --root <등록한-root>`로 설치 버전·지원 모델/effort를 확인한다. 모델 목록은 계정의 실제 호출 성공을 뜻하지 않는다. 기존 개인·프로젝트 지침과 설정 파일을 유지하고, 사용자가 후속 확정한 읽기 전용 우선에 따라 권한을 검증하지 못한 MCP·플러그인·훅 실행은 조사 세션에서 제한한다. 전용 Codex 로그인 프로필을 필수로 만들지 않으며 기존 공식 CLI 로그인과 관리 정책·승인 규칙을 유지한다. 관리자가 강제한 기능과 작업 제한이 충돌하면 준비를 거절하며 이를 우회하지 않는다. 토큰을 복사하지 않는다. [설정 유지와 공유 경계](../research/ai-runtime-integration.md#기존-개인-에이전트-설정-유지)

`runtime-prepare`에는 `--agent-id`, 등록 root, `--model`과 `--effort` 또는 `--runtime-default yes`, `--files '["상대/파일.ts"]'`, 선택한 `--handoff`, `--confirm-new-context yes`, `--confirm-public yes`를 지정한다. 자동 질문을 허용할 때 `--confirm-auto-questions yes`도 지정한다. 준비는 새 owned 맥락을 만들고 binding epoch를 교체하며 모델 turn을 실행하지 않는다. 제품이 전달하는 자료는 선택한 파일과 인계이며 로컬 AI는 기존 개인·프로젝트 지침도 사용한다. L1으로 시작하고, 종결 뒤 같은 소유 thread를 재개하면 L2다. 임의 등록 session을 자동 resume하지 않는다.

공유 확인은 해당 방·조사 목적·선택 근거에 관한 AI 생성 결론과, 별도 동의한 생성 질문의 자동 전송을 허용한다. 기존 개인 설정이 답변에 영향을 줄 수 있지만 설정·훅 원문이나 인증정보 공개를 승인하는 것은 아니다. 제품은 알려진 민감값과 미확정 출력을 보류하며 문구 전체의 출처를 증명하거나 매번 소유자가 직접 승인했다고 표시하지 않는다.

`runtime-run --agent-id <agent-uuid>`은 해당 binding의 요청을 처리하며 SIGINT/SIGTERM으로 종료한다. `--once yes`는 현재 대기 요청 한 건 또는 준비 보고만 처리한다. `runtime-status`는 로컬 요청값·보고값·종결/채택 상태를 보여준다. Codex의 turn effort는 현재 프로토콜이 보고하지 않아 `UNVERIFIED`로 남긴다. UNKNOWN에서는 새 호출·맥락 교체·로컬 증거 삭제를 차단하고, `runtime-observe`로 같은 소유 turn의 저장된 종결 증거를 확인한다. 중단 ACK만으로 종결 처리하지 않는다.

공급자 인증·절대 경로·native 식별자·private 결과는 PC에 둔다. 선택 파일의 변경이나 scope/lease 상실은 새 도구·입력을 차단한다. 위 명령 지원은 Claude·웹 설정·다른 PC의 계정·클라우드 배포까지 검증했다는 뜻이 아니다.

## 최초 접속 흐름

1. **웹 접속·로그인:** 초대 링크 또는 서비스 URL로 접속한다. 질문 권한이 있는 참가자는 준비된 상대 AI를 선택해 질문한다. 이 흐름에는 자기 connector·경로·AI가 필요 없다. 관찰만 하는 observer는 방을 읽는다. 자기 AI를 제공하려면 선택 사항인 ‘내 AI 연결’로 이어간다.
2. **기기 연결:** 지원 OS와 설치 안내를 보여준다. connector의 일회용 code로 자기 기기를 확인한다. 이미 연결된 기기는 새 설치 대신 연결 상태를 보여준다.
3. **저장소 등록:** 로컬에서 폴더를 선택한다. root·Git/worktree·branch·dirty 상태를 확인하고 공유할 별칭을 정한다.
4. **AI 연결:** 설치된 지원 도구를 감지해 제안한다. 사용자는 Codex/Claude Code·모델·지원되는 effort와 허용된 자기 계정/과금 경로·기존/새 session을 확인한다. Claude는 기존 구독으로 각 PC의 공식 비변조 CLI에 직접 로그인하는 경로를 우선 검토한다. 제품 실행 조건과 실제 버전의 인증·권한을 확인하며 세부 근거는 [S20](../research/sources.md#s20)을 따른다. 공급자 인증은 허용된 로컬 흐름에서 처리하고 저장소 cwd·session 소유권·지침·도구·권한을 검사한다. 기존 앱이 같은 session을 사용 중이면 자동 동시 resume하지 않는다.
5. **공유 범위 확인:** 코드 발췌·검증 결과·작업 이벤트 중 허용 범위를 보여준다. 설명 대화와 인증정보는 공동 공개 범위에 포함하지 않는다.
6. **방 연결:** 내 등록 연결과 확인한 공유 범위를 방에 연결한다. 답변용 로컬 연결 프로그램이 온라인이고 AI 실행 준비가 확인되면 다른 참가자의 질문을 받을 수 있다. 두 AI의 공동 조사에는 양쪽 연결 준비를 확인한다.

2–6은 AI 연결 소유자의 절차다. 질문만 하는 참가자는 이 단계를 건너뛴다. 답변용 연결을 준비해 둔 소유자는 매 질문을 직접 입력하지 않아도 되지만 웹 로그인만으로 로컬 실행 준비가 완료되지는 않는다. 서로 다른 provider를 사용할 수 있으며 상대방의 API 키나 로그인 토큰을 받아 실행하지 않는다. 방에 지정한 binding으로만 질문을 라우팅한다. 공급자별 구현 지점과 실제 확인 범위는 [연결 조사](../research/local-ai-connection-research.md#codex의-연결-지점)를 따른다.

한 번 등록한 뒤에는 저장된 연결을 선택한다. 폴더 이동·worktree 변경·session 교체·기기 취소 등 실제 설정이 바뀔 때만 다시 확인한다. 최근 사용 연결은 추천할 수 있으나 사용자 확인 없이 잘못된 저장소를 실행하지 않는다.

도구·모델·effort는 각자의 AI 연결별로 저장한다. 웹 채팅방에서 자기 선택을 확인·변경하며 처음에는 로컬 기본값, 재입장 때는 마지막 선택을 보여준다. 같은 방의 다른 참가자는 다른 값을 선택할 수 있다. 실행 중 변경은 종결 확인 뒤 다음 실행에 적용한다. 지원 밖 조합이나 요청/적용 불일치는 준비 완료로 표시하지 않는다. 이 선택 기능은 후속 구현 요구사항이며 [실행 설정과 변경 규칙](../research/ai-runtime-integration.md#참가자별-도구모델effort-선택)을 따른다.

## 웹에서 보여줄 준비 카드

```text
내 AI 준비

사람          로그인됨
PC            내 개발 PC · 온라인 · 최근 확인 시각
저장소        repository-a
브랜치        현재 작업 브랜치 · 미커밋 변경 있음
AI            Codex · 지원 버전 확인됨
모델          선택한 모델 · 실제 적용 확인됨
effort        선택한 지원 값 · 실제 적용 확인됨
계정          로컬 로그인 확인됨 · 과금 경로 표시
세션          선택한 작업 세션 · 저장 기록 이어가기(L2)
실행 범위     읽기 · 승인된 격리 테스트 · 수정 제안
공유 범위     코드 발췌 · 검증 결과

[연결 변경] [연결 확인] [AI 연결 완료]
```

예시는 UI 내용 후보이며 실제 계정·세션을 확인한 값이 아니다. absolute path와 공급자 token/native session locator는 로컬에 둔다. 서버에는 연결에 필요한 opaque ID와 사용자가 정한 공유 별칭만 전송하는 것을 권고한다. 원래 개인 session 제목도 자동 공개하지 않는다.

준비 검사는 실제 관찰 상태를 사용한다: connector heartbeat, 경로 존재/권한, 지원 runtime 버전, 계정 사용 가능 여부, session/cwd 일치, 현재 session 소유, 허용 scope, 현재 room revision. 설치 버튼 클릭만으로 연결 성공 처리하지 않는다.

## 상태·오류·복구 문구

| 상태 | 화면에 설명할 내용 | 다음 행동 |
|---|---|---|
| 로그인/초대 필요 | 이 조사방에 접근할 계정이 필요함 | 로그인·초대 요청 |
| 내 connector 없음 | 방 권한으로 관찰·상대 AI 질문 가능; 자기 AI 실행에는 연결 필요 | 상대 대상 선택 또는 선택 사항인 내 AI 연결 |
| 기기 offline | PC/연결 프로그램의 마지막 확인 시각 | 실행·연결 확인; 대기 상태 유지 |
| 저장소 미등록 | 이 AI가 조사할 저장소가 아직 선택되지 않음 | 로컬 폴더 등록 |
| 폴더 이동/권한 없음 | 등록한 폴더를 현재 PC에서 열 수 없음 | 로컬 경로 재선택·권한 확인 |
| 지원 AI 없음 | 설치된 도구가 없거나 이번 버전 지원 범위 밖 | 공식 설치 안내·지원 도구 선택 |
| 계정 연결 필요 | 로컬 공급자 인증 또는 제품에 허용된 인증이 필요함 | 공급자 로그인/회사 계정 안내 |
| session/cwd 불일치 | 선택 session과 조사 폴더가 다름 | 맞는 session 선택·명시적 새 세션 |
| 기존 앱에서 사용 중 | 같은 session의 동시 실행이 확인/의심됨 | 지원되는 공유 호스트 방식 또는 사용자 확인 후 순차 전환 |
| 맥락 가져오기 필요 | 새 세션에는 이전 작업 배경이 없음 | 선택 요약 인계·저장 session 선택 |
| 공유 정책 확인 필요 | 아직 공개 범위에 동의하지 않음 | 공개할 범위 확인 |
| 실행 정책/호환성 미확인 | 공식 실행 프로토콜이나 적용 설정을 확인하지 못함 | 로컬 진단·지원 버전·기존 관리 정책을 확인; 전역 지침·훅의 존재만으로 다른 프로필을 요구하지 않음 |
| branch/파일 변경 | 조사 시작 snapshot 이후 코드가 달라짐 | 새 snapshot 확인·재검증 |
| 중단/실행 미확인 | 실제 runtime 종결을 확인하지 못함 | 실행 기록 확인·복구 절차 |

에러 문구는 원인과 복구 행동을 연결한다. raw 오류·토큰·절대 경로를 상대방의 화면에 표시하지 않는다. 실행 중인 기존 앱을 자동으로 종료하거나 승인 범위를 확대해 연결 문제를 해결하지 않는다.

## 조사방에서 확인할 값

참가자 카드와 질문 작성란은 `사람 · AI · 프로젝트 표시명 · 작업 영역 별칭`으로 대상을 표시한다. 예: `민수 · Claude · 주문 관리자 · 백엔드`. 같은 레포의 서로 다른 연결도 별칭으로 구분하며 표시명만으로 라우팅하지 않는다. 상대 경로는 소유자가 공유를 확인한 경우만 추가하고 절대 경로·Git remote URL·개인 session 제목을 자동 공개하지 않는다. 메시지는 질문 당시의 공개 대상 정보와 binding/epoch 관계를 남겨 연결 교체 후에도 대상을 식별해야 한다. 이 표시는 후속 웹 설정·이력 구현 요구사항이다.

- 문제·기대 동작·대상 환경, 필요한 요청/상품/명령 ID.
- 상대 AI의 저장소 별칭, branch/worktree, session 별칭, 연결 수준, 준비 상태. 내 AI 정보는 연결한 경우에만 표시.
- 공개 범위, 읽기·테스트 등 실행 범위, 이번 조사 사이클의 자동 진행 한도.
- 공동 대화와 개인 설명의 공개 대상, 방향 수정이 공동 입력이라는 안내.

상대가 아직 준비되지 않아도 방 생성·초대·증상 기록은 가능하다. 단방향 질문에는 상대 연결의 준비만 필요하고, 양쪽 자동 조사는 두 연결이 준비된 이후 시작한다. 자기 AI만으로 먼저 조사한다면 상대 응답 없이 진행한 범위를 표시한다.

## 입력 최소화와 기본값

자동 감지 후보: 도구 설치 여부/버전, root의 Git 상태·branch·worktree, connector 상태, 이전 등록, snapshot 변경 여부.

사용자가 선택해야 하는 값: 실제 조사 폴더·session, 계정/과금 경로, 공개 범위, 조사 목표, 기존 기록과 다른 새 세션 사용 여부. 도구·branch를 자동 감지해도 실행 대상은 선택한 binding으로 고정한다.

초기 권고: 현재 팀 OS 우선 지원, 공식 공급자 인증, 읽기/제안 범위, 명시적 초대, 한 조사방의 단방향 질문부터 검증한 뒤 두 AI 공동 조사로 확장. 확정하지 않은 값은 완료처럼 표시하지 않는다.

웹 URL은 중앙 서비스의 배포 주소다. 일반 사용자에게 Supabase·DB endpoint·관리자 key·저장소 원격 URL을 입력하게 하지 않는다. connector는 pairing으로 서비스 주소와 자기 scope를 전달받고 등록된 설정을 보관한다.

## 필요한 온보딩 검증

- 아무 설정 없이 로그인한 사람이 관찰 기능과 AI 실행에 필요한 항목을 구분한다.
- 설정 미완료 상태에서 실행 버튼은 필요한 항목과 이유를 표시한다.
- 잘못된 PC/저장소/session으로 질문이 실행되지 않는다.
- 다른 개발자의 준비 상태에는 공유된 metadata만 보인다.
- 재접속 시 이미 완료한 등록을 반복하지 않고 상태를 다시 확인한다.
- 설치/계정/경로/session 오류마다 실제로 가능한 복구 행동이 있다.
- 설정 변경·토큰 취소·session 교체 후 기존 run의 소유권과 epoch가 올바르게 정리된다.
