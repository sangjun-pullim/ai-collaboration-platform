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
| 질문할 참가자 | 상대 등록 연결·질문 | 웹 AI 채팅방 | 상대 사람·AI·저장소·준비 상태, 확인된 공유 범위 |
| 공동 조사 참가자 | 사용할 등록 연결·공유 scope·문제 | 웹 AI 채팅방 | AI별 저장소/branch/session, 준비 상태, 공동 목표 |

서비스의 DB password/service-role key를 일반 개발자 설정값으로 보여주지 않는다. 공급자 인증은 공급자가 허용하는 로컬 흐름으로 진행하고 웹 입력칸에 기존 AI 로그인 토큰을 붙여넣게 하지 않는다.

초기 운영의 권고 후보는 개인·비상업용 실험에 맞춘 Vercel Hobby와 Supabase Free다. 참여자는 서비스 운영자와 별도로 유료 호스팅 계정을 만들 필요가 없다. 설정 화면에는 현재 플랜·사용량 확인 시각·남은 한도와 AI 과금 경로를 구분해 보여준다. 측정값이 없으면 무료 운영이 보장되는 것처럼 표시하지 않고 '사용량 확인 필요'로 안내한다.

## 개발 단계별 계정 준비

Vercel/Supabase 후보를 선택하더라도 구현 시작 전에 클라우드 계정·프로젝트가 모두 준비돼 있어야 하는 것은 아니다. 계정 준비는 서비스 운영자 작업이며 AI 채팅방 참여자마다 호스팅 계정을 만들지 않는다.

| 단계 | 필요한 준비 | 클라우드 계정 필요 여부 |
|---|---|---|
| 화면·모의 runtime·connector 로컬 구현 | 선택한 언어/프레임워크와 개발 도구 | Vercel/Supabase 계정 없이 시작 가능 |
| 로컬 DB·Auth·Realtime 통합 | Supabase CLI와 Docker 호환 container runtime | 클라우드 프로젝트 없이 로컬 stack으로 개발·검증 가능 |
| Vercel 배포·Supabase 클라우드 연동 | 운영자의 Vercel 계정/프로젝트, Supabase 계정/프로젝트와 환경 설정 | 실제 클라우드 연결 검증 전에 필요 |
| 실제 AI 실행 실험 | 각 사용자의 설치된 runtime와 공급자가 허용한 인증·과금 경로 | 호스팅 계정 준비와 별개이며 실제 호출 전에 필요 |

Supabase의 신규 로컬 개발 흐름은 CLI·container runtime으로 시작하고, 원격 프로젝트를 연결할 때 로그인·프로젝트 연결을 수행한다. Vercel 배포에는 Vercel 계정이 필요하다. [공식 준비 조건](../research/sources.md#s15)

권고 순서는 로컬 핵심 흐름 검증 → 선택한 클라우드의 계정·프로젝트 준비 → 배포·로그인·기기 연결·두 PC 왕복 검증이다. 클라우드 단계에서는 서비스 주소, 인증 redirect, 환경 변수, 방·기기 권한도 실제 배포 기준으로 확인한다. 질문만 하는 참여자는 제품 계정·방 권한을 준비한다. AI를 제공할 참여자만 자기 AI 인증과 로컬 연결을 추가한다.

## 현재 웹 입장과 AI 채팅방

실제 웹 경로는 `/login`, `/app`, `/app/rooms/<roomId>`, `/app/connections`다. 회사 공용 입장 코드와 표시 이름으로 접속한다. 같은 브라우저에서는 session을 유지하고 로그아웃·cookie 유실 후에는 새 사용자로 입장한다. 같은 이름으로 이전 방·기기 소유권을 복구하지 않는다. 새 채팅방은 이름만 입력해 만들고 participant/observer 초대로 동료를 초대한다. 현재 코드 입장과 DB membership으로 권한을 확인한다. 기기 코드 승인·공개 저장소/session 등록은 가능하다. 실제 AI 실행은 아래의 명령 한 번 연결과 웹 AI 설정으로 준비하며, 등록만으로 실행 준비가 완료되지는 않는다.

방의 대화는 DB cursor polling으로 복원한다. 준비된 상대 AI를 선택해 직접 질문하거나 방 참가자에게 메시지를 보낸다. 내 AI 연결 없이 질문할 수 있다. 공동 조사·중단·방/조사 재개는 별도 제어에서 사용할 수 있다. driver가 없는 binding은 미검증 안내를 유지한다. 중앙 조정과 실제 Codex의 한 PC 왕복·중단을 검증했다. 검사 수치와 실제 두 PC·Claude의 남은 범위는 [진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

개발자는 Node 24에서 `npm ci` 후, [환경 변수 예시](../../.env.example)의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`을 프로세스 환경에 전달해 `npm run dev`를 실행한다. `APP_ORIGIN`은 브라우저로 접속할 정확한 origin이어야 한다. 제품 웹 서버에는 admin/service-role key·DB password·AI 공급자 인증을 전달하지 않는다. 실제 설정을 파일로 만들 때는 개인 자격증명을 저장소에 포함하지 않는다.

### 내 AI를 제공하는 Mac 연결

질문만 하는 참가자는 이 절차 없이 상대 AI를 선택해 질문한다. 답변을 제공하는 참가자는 macOS 13.5 이상에서 기존 Claude Code 또는 Codex CLI의 설치·로그인을 사용한다. 별도 연결 앱·프로젝트 복제·npm 설치는 필요 없다. 연결 명령이 운영 코드를 임시 실행하며, Node 24가 없으면 공식 고정 실행 파일을 검증해 임시로 사용한다.

1. AI를 제공할 개발자는 웹의 **내 AI 연결**(`/app/connections`)을 연다. 참가한 채팅방을 고를 수 있다.
2. 개발자는 **AI를 제공할 채팅방**과 **내 기기 이름**을 선택한다. **연결 명령 복사** 버튼이 준비되면 사용할 수 있다.
3. 개발자는 자기 Mac의 터미널에 복사한 명령을 붙여 넣어 실행한다. 기기 승인 주소가 열리고, 열리지 않으면 터미널의 주소를 직접 연다.
4. 개발자는 웹의 계정·방·공개 정보 안내를 확인하고 확인란을 선택한 뒤 **기기 승인**을 누른다. 주소에 들어온 기기 코드는 자동 입력되며 URL에서는 즉시 제거된다. 자동 승인하지 않는다.
5. 개발자는 실행 중인 터미널에 표시된 자기 계정·조직·방·기기를 확인하고 `yes`를 입력한다. 등록 확인 뒤 웹 AI 설정을 진행할 수 있다.
6. 개발자는 웹의 본인 기기 AI 설정에서 폴더·Claude/Codex·모델·추론 강도를 선택하고, 해당 Mac에서 폴더 읽기·공유 범위를 승인한다. 요청 접수와 PC 적용 완료는 서로 다른 상태다.
7. 개발자는 답변을 제공하는 동안 PC와 해당 터미널을 열어 둔다. 새 명령은 설정 관리까지 이어지므로 추가 `manage`를 실행하지 않는다. 재접속하면 같은 서비스·사람·방의 연결 프로필을 사용한다.

복사가 거절되면 **명령 확인·직접 복사**를 펼쳐 선택된 명령을 직접 복사한다. 종료 확인이 불완전하면 터미널이 임시 실행 파일의 보존 위치를 알린다. 기존 개인 설정·인증·대화 기록을 삭제하거나 새 AI 입력을 자동 시도하지 않는다. 기존 수동 `pair`·`exchange` 이용자는 화면의 **기존 수동 연결을 사용하는 경우**와 **수동 연결의 AI 설정 실행 방법**을 따른다.

연결 명령과 기기 등록 성공은 실제 AI 답변의 검증과 다르다. 현재 지원 범위·검사 결과·실제 Mac과 두 PC에서 남은 확인은 [개발·검증 상태](../planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

### 이 개발 Mac의 웹 실행

로컬 DB의010–013 적용 뒤에는 프로젝트 루트의 Node.js 24 터미널에서 아래 명령을 사용한다. 지정한 OrbStack DB의 설치 표식과 API 게이트웨이의 프로젝트·고정 ID·로컬 포트·같은 작업 위치를 확인한다. 검증한 게이트웨이 ID로 실제 실행 설정을 읽고 공개 `anon` 키 하나만 웹에 전달한다. 설정은 Supabase가 컨테이너 안에 만드는 [Kong 설정](https://github.com/supabase/cli/blob/v2.54.11/internal/start/start.go)에 있으며 파일 내용은 메모리에서만 처리한다. 관리자 키와 설정 원문은 출력·파일 저장·웹 전달을 하지 않는다. 이 개발 스택의 웹 실행 준비는 Docker만 사용하며 Supabase CLI·npm 캐시·임시 `config.toml`에 의존하지 않는다.

웹의 세 필수 설정을 채워 `127.0.0.1:4318`에서 현재 코드를 실행한다. 개인 설정 파일에 키를 쓰지 않으며, 상위 터미널의 관리자·DB·AI 키와 임의 서버 주소를 웹 프로세스에 전달하지 않는다. Next.js가 별도 설정을 자동 로딩하지 않도록 프로젝트 루트의 네 개발 환경 파일은 존재 여부만 확인한다. 파일이 있으면 원문을 읽거나 수정하지 않고 `ENVIRONMENT_FILES_PRESENT`로 시작을 거절한다.

```sh
node scripts/dev-local-web.mjs
```

운영자는 이전에 직접 실행한 웹 서버가 있으면 그 터미널에서 `Ctrl+C`로 종료한 뒤 새 명령을 실행한다. 새 명령은 다른 프로세스를 종료하지 않는다. `STARTING`은 설정 점검 완료와 실행 시작이며 실제 HTTP 준비 완료와 다르다. Next.js의 `Ready` 뒤 `http://127.0.0.1:4318/app/connections`를 연다. `BLOCKED`면 공개 진단 코드만 보존하고 원인을 확인한다. `GATEWAY_PUBLIC_KEY_UNAVAILABLE`은 검증한 게이트웨이의 설정을 읽을 수 없다는 뜻이다. `GATEWAY_PUBLIC_KEY_UNVERIFIED`는 공개 키 하나를 안전하게 확정하지 못한 상태다. 설정은 최대64KiB·중첩24단계로 제한한다. YAML 구조를 읽어 `anon` consumer의 `keyauth_credentials`와 활성 `request-transformer`의 지정된 header/querystring 경로만 검사한다. 공식 변환 표현식은 실행하지 않고 형식과 반환 문자열만 확인한다. 관리자 키·여러 줄 설명 속 예시 키·자격증명 앞뒤의 다른 문자열·서로 다른 여러 공개 키는 사용하지 않는다. 이 명령은 DB를 변경하거나 AI를 실행하지 않는다.

플러그인은 `enabled` 누락 또는 YAML의 `true`·`True`·`TRUE` 값일 때만 사용한다. 비활성 표기와 확인할 수 없는 값은 사용하지 않는다.

아래 읽기 전용 점검은 같은 준비 검사를 수행하고 Next 서버를 시작하지 않는다. `CHECKED`는 설정 확인이고 실제 웹 접속 성공과 다르다. 문제가 있으면 공개 JSON만 제공한다. 게이트웨이 설정 원문·키·개인 경로는 표시하지 않는다. 이전 `LOCAL_STATUS_UNAVAILABLE`·`diagnostic` 출력은 Supabase CLI를 사용하던 실행 방식의 이력이며 현재 방식에서는 출력하지 않는다.

```sh
node scripts/dev-local-web.mjs --check
```

주소·공개 키가 없거나 관리자 키가 잘못 설정돼 있으면 웹은 ‘서비스를 준비 중입니다’라는503을 반환한다. 시간 경과로 해결되지 않는 실행 설정 오류이며 설정을 갖춰 서버를 다시 실행해야 한다. DB·웹·Claude의 실제 검증 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

아래는 새로 만든 격리 로컬 Supabase의 준비 절차다. 공유 DB·운영 Auth에서는 운영자가 대상과 변경을 확인한 후 실행한다. 잘못된 DB에 적용하면 다른 사용자의 접근 정책과 인증 설정이 바뀐다.

1. 운영자는 해당 로컬 DB에 [첫 migration](../../supabase/migrations/20261001000100-web-auth-room-access.sql)부터 [회사 코드 입장](../../supabase/migrations/20261004000900-team-code-entry.sql)까지 001–009 아홉 파일을 이름 순서대로 적용한다. 직접 질문·발신자 검증·입장 권한이 함께 준비된다. 기존 DB에는 미적용 후속 파일만 적용하며 reset·기적용 파일 수정/재적용을 하지 않는다.
2. PostgREST가 실행 중이면 운영자는 같은 DB에 `NOTIFY pgrst, 'reload schema';`를 보내 새 함수와 schema cache를 반영한다.
3. 운영자는 해당 로컬 Auth에서 anonymous sign-in을 활성화한다. 이메일 없는 내부 사용자 ID를 생성할 수 있게 된다.
4. 운영자는 아래 [회사 코드 운영 설정](#회사-코드-운영-설정)에 따라 표준 입력으로 코드를 설정한다. 코드와 표시 이름으로 입장할 수 있다. 현재 제품은 OTP 메일 template이나 메일 발송 준비를 요구하지 않는다.

현재 실제 검사는 소유권을 확인한 로컬 Docker project의 여섯 container와 API/DB/Mailpit의 고정 loopback port를 사용한다. `test:integration`, `test:e2e:auth`의 test-parent 환경은 [local-access-stack](../../tests/helpers/local-access-stack.ts)이 제한하며 일반 `npm test`·모의 browser 검사와 분리된다. parent에만 `LOCAL_ACCESS_PROJECT`, `LOCAL_ACCESS_STACK_WORKDIR`, `LOCAL_ACCESS_DB_URL`, `LOCAL_ACCESS_MAIL_URL`, `LOCAL_ACCESS_ADMIN_KEY`, `LOCAL_ACCESS_SIGNING_JWK`가 필요하다. browser에는 scope가 제한된 fixture bridge만 전달하고 제품 child에는 위 세 제품 설정만 전달한다. 설정이 원격이거나 다른 project이면 fixture 생성·삭제를 거절한다. 정리는 생성한 합성 ID와 inbox만 대상으로 한다.

### AI 설정·일시정지·자료 이력의 통합 검사

이 검사는 확인된 격리 DB에 합성 계정·방·기기·자료를 생성하고 소유한 데이터만 정리한다. 개발자는 위 부모 프로세스용 환경과 SQL010–013, fixture의 `TEST_TEAM_CODE`가 준비된 로컬 DB에서 실행한다. 운영 DB에 실행하지 않는다.

현재 코드의 운영 빌드와 통합 검사에 사용할 웹 서버가 필요하다. 개발자는 별도 검증 폴더에서 빌드를 준비하고 검증용 웹을 `127.0.0.1:4318`에 실행한다. 원래 사용자 웹과 `.next`를 보존한다. 아래 브라우저 명령은 같은 포트에 자체 검증 서버를 시작하므로 통합 검사 종료 뒤 직접 시작한 검증용 웹만 종료해야 한다.

1. 개발자는 Node24를 사용하는 프로젝트 터미널에서 아래 명령을 실행한다. AI 설정·합성 Claude 실행기·새 답변 일시정지·답변 자료 이력의 네 통합 검사 파일이 순차 실행된다.

   ```sh
   npm run test:integration:settings
   ```

2. 개발자는 DB 검사 통과 뒤 직접 시작한 검증용 웹의 터미널에서 `Ctrl+C`로 종료한다. 브라우저 검사 서버가 사용할4318 포트가 비어 있어야 한다.
3. 개발자는 같은 검증 폴더에서 `npm run test:e2e:workflow`를 실행한다. 실제 채팅·일시정지·자료 이력 화면을 desktop/mobile에서 확인한다.
4. 개발자는 `npm run test:e2e:settings`를 실행한다. AI 설정·선택 폴더·자동 코드 탐색 화면을 desktop/mobile에서 확인한다.

위 명령은 공식 Claude/Codex 모델을 호출하지 않는다. 합성 실행기의 답변과 실제 DB·HTTP·브라우저 검사를 구분하며 실제 Claude 답변·같은 대화 재개·두 PC 수용은 별도로 검증한다. 업그레이드 전용 `own-ai-input-upgrade.test.ts`와 `shared-input-source-upgrade.test.ts`는 이 명령에 포함하지 않는다. 각각 아직 SQL011이 없는 소유001–010 DB와 아직 SQL013이 없는 소유001–012 DB에서만 실행한다. DB reset·기적용 SQL 재적용으로 조건을 만들지 않는다.

### 검증 상태

사람 인증·방 접근과 기기 등록의 통합·브라우저 검사 및 독립 리뷰를 완료했다. 두 PC·Claude·Realtime·개인 설명의 제품 통합은 후속 범위다. 현재 검증 수치와 순서는 [개발 순서와 검증 계획](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 회사 코드 운영 설정

운영자는 Supabase의 anonymous Auth를 사용 가능하게 설정하고 회사 코드 migration을 적용한다. 코드 원문은 제품 웹 환경이나 소스에 넣지 않고 `scripts/configure-team-entry.mjs`의 표준 입력으로 설정한다. 관리자 DB 연결은 이 설정 프로세스에서만 사용하며 제품 웹·브라우저에는 전달하지 않는다. 스크립트는 `--apply`를 요구하고 원문이나 verifier를 출력하지 않는다. 기존 admitted 사용자 session은 코드 교체로 자동 해제되지 않는다. 공유 DB의 migration·코드 변경은 운영자 확인 후 실행한다.

## CLI가 필요한 참가자

질문만 하는 참가자는 브라우저만 사용한다. 로컬 AI를 제공하는 참가자는 자기 Mac에 로컬 연결 프로그램과 지원하는 공식 AI CLI·로그인을 준비한다. Codex 실행기와 Claude의 기본 native 연결 정책이 있으며 Claude의 초기 지원 조건은 아래 [연결 확인](#claude-연결-확인)을 따른다. 웹 폴더·모델·effort의 실제 적용과 공급자 수용은 [현재 진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)에서 구분하며 선택 화면만으로 완료를 표시하지 않는다.

## 자료 이력 기능의 설치 순서

아래 절차는 새 소스의 설정·자료 이력 기능을 준비하는 순서다. 앞의 001–009는 입장·방·직접 질문의 기본 준비 범위다. 자료 이력의 실제 SQL·HTTP·브라우저 수용 결과는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에서 별도로 확인한다.

공유 DB·운영 Auth에 적용하면 다른 사용자의 접근 정책과 실행 계약이 바뀐다. 운영자는 대상과 변경을 확인한 뒤 적용한다.

1. 운영자는 해당 DB의 미적용 SQL을 번호 순서로 적용한다. [소유자 설정](../../supabase/migrations/20261005001000-owner-local-ai-setup.sql)·[새 답변 제어](../../supabase/migrations/20261006001100-own-ai-input-pause.sql)·[자동 탐색 승인](../../supabase/migrations/20261006001200-owner-approved-repository-access.sql)·[자료 이력](../../supabase/migrations/20261006001300-shared-input-source-history.sql) 뒤에 [모델 목록 검증 보정](../../supabase/migrations/20261008001400-runtime-settings-catalog-validation.sql)·[자료 요약 보정](../../supabase/migrations/20261008001500-source-history-summary-validation.sql)·[설정 적용 영수증 보정](../../supabase/migrations/20261008001600-runtime-settings-binding-receipt.sql)까지 010–016 순서로 설치한다. 이미 설치한 SQL은 재적용하지 않고 남은 번호만 적용한다. DB를 reset하지 않는다.
2. 운영자는 같은 DB의 PostgREST schema cache를 갱신한다. 고정 자료 RPC를 사용하는 중앙 API가 준비된다.
3. AI를 제공하는 개발자는 중앙 API·DB 준비 뒤 자기 Mac의 연결 프로그램을 갱신한다. 연결 프로그램은 현재 연결의 자료 버전 지원을 확인한 뒤 새 입력을 허용한다.

자료 전송 실패는 원래 실행 기록으로 복구한다. 새 AI 입력으로 자동 재시도하지 않는다. 새 자료 기능의 설치는 Claude 실행 정책·두 PC 왕복 검증의 통과를 대신하지 않는다.

### 로컬 DB의 설치 표식 확인

운영자는 로컬 Docker를 실행하는 개발 Mac의 터미널에서 아래 명령으로 이 프로젝트 DB의 설치 표식을 확인한다. 읽기 전용 트랜잭션에서 함수의 존재와 자동 탐색 분기만 조회하며 사용자 데이터·인증정보를 출력하지 않는다. JSON의 네 값은 SQL010–013에 대응한다. 모두 `true`여도 전체 migration 적용·권한·HTTP·브라우저 동작의 통과를 뜻하지 않으며 실제 검증을 이어가야 한다.

```sh
docker exec -i supabase_db_ai-collab-txxcvm61 \
  psql -X -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT json_build_object(
  'aiSettings',
    to_regprocedure('public.runtime_settings_human(text,jsonb)') IS NOT NULL
    AND to_regprocedure('public.runtime_settings_device(text,jsonb,text)') IS NOT NULL,
  'aiPause',
    to_regprocedure('public.workflow_human_input_control(jsonb)') IS NOT NULL
    AND to_regprocedure('public.workflow_device_admission(jsonb,text)') IS NOT NULL,
  'folderAutoRead', EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'runtime_settings_private'
      AND p.proname = 'validate' AND p.pronargs = 2 AND p.prokind = 'f'
      AND position('AUTO_CODE' IN pg_get_functiondef(p.oid)) > 0
  ),
  'answerSources',
    to_regprocedure('public.workflow_device_source_support(jsonb,text)') IS NOT NULL
    AND to_regprocedure('public.workflow_device_source_confirm(jsonb,text)') IS NOT NULL
    AND to_regprocedure('public.workflow_human_source_read(jsonb)') IS NOT NULL
);
ROLLBACK;
SQL
```

`false` 또는 오류가 있으면 해당 출력으로 설치 상태를 먼저 확인한다. 이 점검은 migration을 적용하거나 DB를 reset하지 않는다. Docker 접근이 거절되면 DB가 없다고 해석하지 않으며 같은 프로젝트를 운영하는 Mac에서 확인한다.

### 이 개발 Mac의 AI 설정 DB 적용

**로컬 DB 스키마를 변경하는 명령이다.** 기존 입장·방·대화 데이터를 보존하면서 AI 설정 기능을 추가한다. 이 프로젝트의 지정한 OrbStack 개발 DB만 대상으로 하며 공유·운영 DB에는 사용하지 않는다.

1. 운영자는 이 프로젝트 루트의 Node.js 24 터미널에서 아래 명령을 실행한다. 컨테이너의 프로젝트·고정 ID·로컬 DB 포트·소유한 임시 작업 위치와 SQL 파일 hash를 검사한다. 기존001–009의 필수 함수, SQL005의 기기 삭제 관련 외래키 3개의 지연 검사 설정, SQL008의 질문자 확인 함수·공개 호출 함수의 원문을 먼저 조회하고 적용 transaction에서도 같은 조건을 확인한다. 새 설정 schema가 없으면 SQL010–016을 한 transaction으로 적용한다. SQL010–013이 이미 설치된 DB는 현재 함수 원문이 검토한 기존·보정 상태와 정확히 일치할 때만 남은 SQL014–016을 적용한다. 다른 원문·부분 schema·알 수 없는 설치 상태는 거절하며 SQL 오류는 전체 rollback한다. PostgREST cache 갱신 알림도 같은 commit에 포함한다.

   ```sh
   node scripts/apply-local-ai-settings.mjs --apply
   ```

2. 운영자는 출력의 `status`와 `features`를 확인한다. `APPLIED`와 네 값 `true`는 이 명령의 DB 적용·재조회 완료이며 실제 웹·Claude 답변 통과와 구분한다. `ALREADY_PRESENT`는 기능 표식과 SQL014–016의 보정된 함수 원문을 확인한 상태이며 쓰기·SQL 재적용은 하지 않는다.
3. `BLOCKED`나 `APPLY_NOT_CONFIRMED`이면 운영자는 출력을 보존한다. `--apply` 없이 같은 명령으로 설치 표식만 다시 조회하며 자동 재시도·DB reset·이미 적용한 SQL의 덮어쓰기는 하지 않는다. `BASELINE_NOT_READY`는 기존 필수 조건 누락으로 적용 전에 거절한 상태다. 부분 적용이나 다른 작업 위치는 별도 상태 확인이 필요하다.

이 명령은 AI CLI·모델을 실행하거나 웹 서버를 재시작하지 않는다. 현재 실제 검증과 남은 적용 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 현재 로컬 기기와 저장소 등록

현재 CLI는 macOS·Node 24를 지원한다. 루트에서 아래처럼 준비한다.

```sh
npm --prefix packages/local-connector ci
npm --prefix packages/local-connector run build
node packages/local-connector/dist/src/cli.js pair --server https://your-service.example --profile my-device --device-alias '내 개발 PC'
```

출력한 일회용 코드를 `/app/connections`에서 자기 계정·AI 채팅방·공개 범위를 확인하고 승인한다. 같은 server/profile로 `status`를 실행해 승인된 소유자와 방을 확인한 뒤 `exchange --confirm-scope <room-uuid>`를 실행한다. 개발용 HTTP는 canonical loopback만 허용한다. proof·credential을 웹에 입력하지 않는다.

기존 `register`는 같은 server/profile에 `--root`, `--native-session`, `--repository-alias`, `--session-alias`, `--confirm-public yes`를 받는다. 실제 경로와 native 식별자는 로컬에 저장하고 공개 별칭·Git branch/commit만 전송한다. Git 변경 여부는 현재 `unknown`이며 등록의 native 식별자를 실제 실행 소유권으로 인정하지 않아 `codex/registered/unverified`로 표시한다. 기존 Codex 모델·effort는 별도의 로컬 실행 준비에서 선택한다. 웹의 공급자·모델·effort 설정은 아래 [내 Mac의 AI 설정](#웹에서-내-mac의-ai-설정)을 따른다. Claude의 실제 실행 허용과 수용 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에서 확인한다.

private profile은 기본적으로 사용자의 `Library/Application Support/ai-collab/connector` 또는 명시한 state-dir에 둔다. 디렉터리 0700·파일 0600, 소유권·symlink·process lock과 atomic journal을 검사한다. broad root와 개인 인증/설정 경로 및 외부로 연결된 해당 symlink target은 등록할 수 없다.

`rotate`·등록·교체의 응답 유실은 저장한 같은 operation으로 복구한다. 최초 `begin`의 응답을 잃어 scope를 확인할 수 없으면 `status` 안내에 따라 `revoke-local`로 그 profile을 제거하고 새 code와 사람 승인을 받는다. 자동으로 새 기기·key를 만들지 않는다. 웹의 취소/제거·membership 제거·credential 만료 뒤에도 새 승인이 필요하다. `revoke-local`은 자기 로컬 profile만 제거하며 원격 취소는 웹에서 별도로 수행한다.

## 로컬 Codex 실행 준비

[007](../impl-spec/archive/007-owned-codex-workflow-runner.md)의 CLI 구현을 기준으로 한 로컬 절차다. 기존 설정 파일을 유지한 공식 Codex의 왕복·중단을 한 PC의 합성 저장소에서 확인했고 독립 구현 리뷰를 완료했다. 실제 두 PC·다른 계정의 검증은 남아 있다. 현재 공개 binding에는 모델·effort나 검증 완료 표시를 추가하지 않았다.

같은 server/profile의 `runtime-capabilities --root <등록한-root>`로 설치 버전·지원 모델/effort를 확인한다. 모델 목록은 계정의 실제 호출 성공을 뜻하지 않는다. 기존 개인·프로젝트 지침과 설정 파일을 유지하고, 사용자가 후속 확정한 읽기 전용 우선에 따라 권한을 검증하지 못한 MCP·플러그인·훅 실행은 조사 세션에서 제한한다. 전용 Codex 로그인 프로필을 필수로 만들지 않으며 기존 공식 CLI 로그인과 관리 정책·승인 규칙을 유지한다. 관리자가 강제한 기능과 작업 제한이 충돌하면 준비를 거절하며 이를 우회하지 않는다. 토큰을 복사하지 않는다. [설정 유지와 공유 경계](../research/ai-runtime-integration.md#기존-개인-에이전트-설정-유지)

`runtime-prepare`에는 `--agent-id`, 등록 root, `--model`과 `--effort` 또는 `--runtime-default yes`, `--files '["상대/파일.ts"]'`, 선택한 `--handoff`, `--confirm-new-context yes`, `--confirm-public yes`를 지정한다. 자동 질문을 허용할 때 `--confirm-auto-questions yes`도 지정한다. 준비는 새 owned 맥락을 만들고 binding epoch를 교체하며 모델 turn을 실행하지 않는다. 제품이 전달하는 자료는 선택한 파일과 인계이며 로컬 AI는 기존 개인·프로젝트 지침도 사용한다. L1으로 시작하고, 종결 뒤 같은 소유 thread를 재개하면 L2다. 임의 등록 session을 자동 resume하지 않는다.

공유 확인은 해당 방·조사 목적·선택 근거에 관한 AI 생성 결론과, 별도 동의한 생성 질문의 자동 전송을 허용한다. 기존 개인 설정이 답변에 영향을 줄 수 있지만 설정·훅 원문이나 인증정보 공개를 승인하는 것은 아니다. 제품은 알려진 민감값과 미확정 출력을 보류하며 문구 전체의 출처를 증명하거나 매번 소유자가 직접 승인했다고 표시하지 않는다.

`runtime-run --agent-id <agent-uuid>`은 해당 binding의 요청을 처리하며 SIGINT/SIGTERM으로 종료한다. `--once yes`는 현재 대기 요청 한 건 또는 준비 보고만 처리한다. `runtime-status`는 로컬 요청값·보고값·종결/채택 상태를 보여준다. Codex의 turn effort는 현재 프로토콜이 보고하지 않아 `UNVERIFIED`로 남긴다. UNKNOWN에서는 새 호출·맥락 교체·로컬 증거 삭제를 차단하고, `runtime-observe`로 같은 소유 turn의 저장된 종결 증거를 확인한다. 중단 ACK만으로 종결 처리하지 않는다.

공급자 인증·절대 경로·native 식별자·private 결과는 PC에 둔다. 선택 파일의 변경이나 scope/lease 상실은 새 도구·입력을 차단한다. 위 명령 지원은 Claude·웹 설정·다른 PC의 계정·클라우드 배포까지 검증했다는 뜻이 아니다.

## 웹에서 내 Mac의 AI 설정

022의 설정 화면과 `manage` 명령은 소스에 구현돼 있다. DB 적용 상태와 HTTP·브라우저·실제 답변 검증 결과는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에서 확인한다. DB 적용 보고와 PC의 AI 실행 준비 완료는 별도로 확인한다.

1. 자기 Mac에서 Node.js 24로 기존 pairing·웹 승인·`exchange`를 완료한다. 웹과 PC에 같은 사람·방의 기기가 연결되어야 한다.
2. 자기 Mac에서 `node packages/local-connector/dist/src/cli.js manage --profile my-device`를 실행한다. 기존 프로필에 저장한 웹 주소로 설정 요청을 확인한다.
3. 웹의 ‘내 AI 연결’에서 참가 방과 본인 기기를 선택한다. 다른 사람의 기기는 편집할 수 없다.
4. 웹에서 Claude 또는 Codex를 고르고 ‘Mac에서 폴더 선택’을 누른다. 해당 Mac에서 폴더와 공유 별칭을 선택하고 필요한 코드의 자동 탐색 범위를 승인한다. 파일을 미리 고를 필요는 없다.
5. PC가 보낸 모델 목록에서 모델과 지원되는 추론 강도를 선택한다. 추론 강도가 없는 Claude 모델은 별도 값을 만들지 않는다.
6. 웹에서 적용을 요청한다. 기존 질문이 진행 중이면 완료를 기다리고, PC의 확정과 실행 준비 보고를 각각 확인한다.

AI를 제공하는 Mac에는 선택한 공식 CLI와 기존 로그인이 필요하다. 질문만 하는 참가자는 로컬 경로·AI 연결을 생략하고 준비된 상대 AI에 질문한다. 동료들이 각자 Supabase Docker를 실행할 필요는 없다. Supabase 컨테이너는 이 프로젝트의 로컬 서버 개발·검증에 사용한다.

개인 설정 파일을 바꾸거나 로그인 토큰을 웹으로 복사하지 않는다. 경로는 PC에 보관하고 웹에는 공유 별칭과 참조 ID를 전달한다. 취소 요청 후에는 PC의 정리 확인까지 기다린다. 결과가 미확정이면 같은 요청을 복구하며 새 AI 입력으로 자동 재시도하지 않는다.

자동 탐색 승인은 해당 폴더와 새 연결 설정에만 적용한다. 비밀·인증·에이전트 설정 자료, 폴더 밖 접근과 파일 수정은 제한한다. 옛 선택 파일 연결은 새 폴더 확인 없이 자동 탐색으로 바뀌지 않는다. 당시 승인·설정·완료 이력은 보존하며 새 설정으로 과거 읽기 권한을 넓히지 않는다.

기본 Claude 실행은 해당 Mac의 공식 설치·게시자·로그인·설정을 검증하는 native 정책을 사용한다. 검증 실패는 실행 허가로 바꾸지 않는다. 실제 연결 확인은009의 별도 native 검증과 제품 수용 절차를 통과해야 한다. 합성 검사에 사용하는 policy·transport 주입은 CLI 옵션이나 웹 입력으로 제공하지 않는다.

### Claude 연결 확인

현재 native 실행 지원 버전은2.1.288·2.1.293이다. 개인 CLI 링크가 자동 업데이트되었어도 같은 개인 설치에 남아 있는 검증된 지원 버전을 선택할 수 있다. 개인 링크·설정을 변경하지 않는다. 지원 버전이 설치되어 있지 않으면 실행을 거절하고, 단순 설치 점검과 실제 답변 수용은 [현재 진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)에서 구분한다.

현재 native 지원 범위는 macOS, 공식 native 설치 2.1.288·2.1.293, 기존 Pro/Max 구독 로그인과 기본 `~/.claude` 프로필이다. 개인 설정·지침·인증 파일은 그대로 둔다. 다른 버전·설치 방식·사용자 지정 프로필과 managed 정책은 검증된 지원 범위에 추가하기 전까지 미지원이다. 파일을 새 프로필로 옮기는 방식으로 해결하지 않는다.

다음 점검은 AI 질문을 보내지 않는다. 진단은 실패 단계만 출력하며 인증·설정 원문을 출력하지 않는다.

1. 답변 제공자는 자기 Mac의 프로젝트 루트에서 Node.js 24로 `npm --prefix packages/local-connector run build`를 실행한다. 연결기만 컴파일된다.
2. 같은 위치에서 아래 명령을 실행한다. `VERIFIED`는 입력 없는 설치·설정 점검 통과이고 실제 답변·재개·중단 통과와 구분한다. 실패하면 `INSTALLATION`, `PUBLISHER`, `VERSION`, `MANAGED_POLICY`, `LOGIN` 단계 또는 설정 오류를 확인한다.

```sh
node --input-type=module <<'JS'
import { NativeClaudePolicy } from './packages/local-connector/dist/src/claude/native-policy.js';
try {
  const policy = new NativeClaudePolicy();
  await policy.admit(process.cwd(), () => {});
  console.log(JSON.stringify({ admission: 'VERIFIED', version: policy.version, modelInputs: 0 }));
} catch (error) {
  console.log(JSON.stringify({ admission: 'UNVERIFIED', code: error.code ?? 'UNKNOWN', stage: error.stage ?? null, modelInputs: 0 }));
  process.exitCode = 1;
}
JS
```

게시자 검증 실패는 macOS의 공식 설치 서명·신뢰 확인이 필요하다는 뜻이다. 이 점검은 재로그인·CLI 업데이트·설정 변경·질문 재시도를 실행하지 않는다. 현재 검증 결과와 승인된 실제 입력의 남은 조건은 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

`revoke-local`은 설정·실행·세션 잠금과 소유 기록을 확인한 뒤 로컬 인증을 제거한다. 022로 설정한 프로필의 이전 대화·설정 기록은 보존한다. 보존한 프로필을 다른 사람이나 새 기기 인증으로 덮어쓰지 않으며, 다시 연결할 때는 새 프로필 이름을 사용한다.

## 내 AI의 새 답변 일시정지

실제 채팅 경로에 본인 제어 소스를 추가하고 있다. 실제 DB·HTTP·브라우저 검증과 현재 제공 여부는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

1. 자기 AI가 연결된 참가자는 AI 채팅방에서 해당 AI 별칭을 확인한다. 질문만 하는 참가자는 자기 AI를 연결하지 않아도 된다.
2. 새 답변을 받지 않으려면 ‘내 AI 새 답변 일시정지’를 선택한다. 서버 요청을 저장하며 이미 실행 준비를 시작한 답변은 계속된다.
3. 연결 프로그램의 적용 보고를 확인한다. ‘요청됨 · 연결 프로그램 대기’는 PC 적용 완료를 뜻하지 않는다.
4. 응답이 미확정이면 ‘같은 요청 확인’을 선택한다. 원래 요청을 확인하며 새 제어 요청을 자동으로 만들지 않는다.
5. 새 답변을 다시 받으려면 ‘내 AI 새 답변 재개’를 선택한다. 방 전체가 정지된 경우 방은 계속 정지되어 있다.

진행 중인 답변을 멈추려면 해당 실행의 중단 제어를 사용한다. 새 답변 제어의 적용 보고와 실제 실행 종결은 별도로 확인한다.

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
| 로그인/초대 필요 | 이 AI 채팅방에 접근할 계정이 필요함 | 로그인·초대 요청 |
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

<a id="조사방에서-확인할-값"></a>
## AI 채팅방에서 확인할 값

참가자 카드와 질문 작성란은 `사람 · AI · 프로젝트 표시명 · 작업 영역 별칭`으로 대상을 표시한다. 예: `민수 · Claude · 주문 관리자 · 백엔드`. 같은 레포의 서로 다른 연결도 별칭으로 구분하며 표시명만으로 라우팅하지 않는다. 상대 경로는 소유자가 공유를 확인한 경우만 추가하고 절대 경로·Git remote URL·개인 session 제목을 자동 공개하지 않는다. 현재 질문 대상의 표시와 과거 메시지의 예약 당시 대상은 구분한다. 채팅 자료 기록은 당시 별칭·연결 버전과 저장한 파일 관찰을 사용하며 현재 설정으로 과거 정보를 채우지 않는다. 입력 전 허용 파일·도구 반환 발췌·질문 전 근거 확인을 실제 인용이나 검증 통과로 표시하지 않는다. 화면 연결과 실제 수용 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

- 문제·기대 동작·대상 환경, 필요한 요청/상품/명령 ID.
- 상대 AI의 저장소 별칭, branch/worktree, session 별칭, 연결 수준, 준비 상태. 내 AI 정보는 연결한 경우에만 표시.
- 공개 범위, 읽기·테스트 등 실행 범위, 이번 조사 사이클의 자동 진행 한도.
- 공동 대화와 개인 설명의 공개 대상, 방향 수정이 공동 입력이라는 안내.

상대가 아직 준비되지 않아도 방 생성·초대·증상 기록은 가능하다. 단방향 질문에는 상대 연결의 준비만 필요하고, 양쪽 자동 조사는 두 연결이 준비된 이후 시작한다. 자기 AI만으로 먼저 조사한다면 상대 응답 없이 진행한 범위를 표시한다.

## 입력 최소화와 기본값

자동 감지 후보: 도구 설치 여부/버전, root의 Git 상태·branch·worktree, connector 상태, 이전 등록, snapshot 변경 여부.

사용자가 선택해야 하는 값: 실제 조사 폴더·session, 계정/과금 경로, 공개 범위, 조사 목표, 기존 기록과 다른 새 세션 사용 여부. 도구·branch를 자동 감지해도 실행 대상은 선택한 binding으로 고정한다.

초기 권고: 현재 팀 OS 우선 지원, 공식 공급자 인증, 읽기/제안 범위, 명시적 초대, 한 AI 채팅방의 단방향 질문부터 검증한 뒤 두 AI 공동 조사로 확장. 확정하지 않은 값은 완료처럼 표시하지 않는다.

웹 URL은 중앙 서비스의 배포 주소다. 일반 사용자에게 Supabase·DB endpoint·관리자 key·저장소 원격 URL을 입력하게 하지 않는다. connector는 pairing으로 서비스 주소와 자기 scope를 전달받고 등록된 설정을 보관한다.

## 필요한 온보딩 검증

- 아무 설정 없이 로그인한 사람이 관찰 기능과 AI 실행에 필요한 항목을 구분한다.
- 설정 미완료 상태에서 실행 버튼은 필요한 항목과 이유를 표시한다.
- 잘못된 PC/저장소/session으로 질문이 실행되지 않는다.
- 다른 개발자의 준비 상태에는 공유된 metadata만 보인다.
- 재접속 시 이미 완료한 등록을 반복하지 않고 상태를 다시 확인한다.
- 설치/계정/경로/session 오류마다 실제로 가능한 복구 행동이 있다.
- 설정 변경·토큰 취소·session 교체 후 기존 run의 소유권과 epoch가 올바르게 정리된다.
