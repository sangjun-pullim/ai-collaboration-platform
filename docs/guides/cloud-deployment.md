# Vercel·Supabase 배포

개인·비상업용 테스트의 웹은 Vercel Hobby, DB와 인증은 Supabase Free에 둔다. 동료는 배포 주소와 회사 공용 입장 코드로 참여하며 Vercel·Supabase 계정을 만들 필요가 없다. AI 답변을 제공하는 Mac만 기존 Claude/Codex 로그인과 웹의 연결 명령을 사용한다.

웹·DB가 배포돼 있으면 개발자의 로컬 웹 서버와 Docker를 켜둘 필요는 없다. 로컬 AI가 답변하려면 해당 Mac과 연결 명령은 실행 중이어야 한다. 다른 Mac의 실제 질문·답변 검증은 배포 접속 검증과 별개이며 [개발·검증 상태](../planning/delivery-and-validation.md)에서 확인한다.

## 배포 대상

| 항목 | 값 |
|---|---|
| Supabase 프로젝트 | `ai-collaboration-platform` / `tcljbegdguixopfcaycs` |
| DB 지역 | Singapore / `ap-southeast-1` |
| Vercel 프로젝트 | `ai-collaboration-platform` / 개인 Hobby 계정 |
| 웹 주소 | `https://ai-collaboration-platform.vercel.app` |
| 실행 환경 | Node.js 24, Next.js |
| 웹 함수 지역 | `vercel.json`의 `sin1`. DB와 같은 지역을 사용 |

계정의 브라우저 로그인과 CLI 로그인은 별개다. CLI 자격증명은 운영자의 Mac에 보관한다. 관리자 키·DB 비밀번호·AI 로그인은 웹 환경 변수로 전달하지 않는다.

## DB 준비

저장소의 기존 SQL 파일은 `날짜-이름.sql` 형식이다. 현재 Supabase CLI는 `날짜_이름.sql`만 인식하므로 원본 위치에서 `db push`를 실행하면 17개를 건너뛰면서 최신 상태라고 표시할 수 있다. 다음 준비 명령은 임시 사본의 파일명만 바꾸며 원본 SQL, migration version, 내용 hash를 보존한다. DB 연결·변경·AI 호출은 하지 않는다.

1. 운영자는 프로젝트 루트에서 준비 명령을 실행한다. `PREPARED`, 임시 `workdir`와 SQL 목록이 출력된다.

   ```sh
   node scripts/prepare-supabase-cloud.mjs
   ```

2. 운영자는 출력된 `workdir`을 아래 명령의 경로로 넣어 적용 예정 목록을 확인한다. 새 프로젝트는 SQL 17개가 보여야 한다. 기존 프로젝트는 이미 적용한 version을 제외한 목록이 보여야 한다.

   ```sh
   npx --yes supabase@2.118.0 db push --linked \
     --project-ref tcljbegdguixopfcaycs \
     --workdir '<출력된 workdir>' \
     --skip-vault --dry-run
   ```

공유 DB에 다음 명령을 실행하면 테이블·함수·권한이 변경된다. 운영자는 정확한 프로젝트, 기존 앱 테이블·migration 이력·Auth 사용자와 적용 예정 파일을 확인해야 한다. 알 수 없는 기존 상태가 있으면 적용을 중단한다. 기존 DB를 reset하거나 과거 migration을 재적용하지 않는다.

3. 운영자는 검토한 같은 사본에 미적용 SQL만 적용한다. 실제 적용 version이 준비 목록과 일치해야 한다.

   ```sh
   npx --yes supabase@2.118.0 db push --linked \
     --project-ref tcljbegdguixopfcaycs \
     --workdir '<검토한 workdir>' \
     --skip-vault
   ```

인증 설정을 변경하면 이 프로젝트의 접속 정책에 영향을 준다. 다른 서비스의 프로젝트를 사용하거나 필요하지 않은 Auth 설정을 함께 바꾸지 않는다.

4. 운영자는 이 Supabase 프로젝트의 anonymous sign-in을 활성화한다. 내부 사용자 ID를 발급하는 설정이며 앱 입장에는 회사 코드와 기존 입장·방 권한 검사가 계속 필요하다. Auth의 Site URL은 위 웹 주소로 설정한다. 이메일 발송은 필요하지 않다.

5. 운영자는 [회사 코드 운영 설정](onboarding-and-settings.md#회사-코드-운영-설정)에 따라 회사 코드를 준비한다. 코드 원문은 저장소나 웹 환경에 넣지 않는다. 새 프로젝트의 초기 설정과 기존 코드 교체를 구분하고, 기존 코드는 임의로 교체하지 않는다.

## 웹 배포

| Production 환경 변수 | 값 |
|---|---|
| `SUPABASE_URL` | `https://tcljbegdguixopfcaycs.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | 해당 프로젝트의 publishable key 또는 `anon` 키 |
| `APP_ORIGIN` | `https://ai-collaboration-platform.vercel.app` |

세 변수는 서버에서 사용한다. `NEXT_PUBLIC_` 접두사를 붙이지 않는다. secret/service-role 키, DB 비밀번호와 AI 인증 정보를 추가하지 않는다. Preview에서 같은 운영 DB를 자동 사용하도록 설정하지 않는다.

배포는 외부에서 접속할 수 있는 웹을 생성한다. 운영자는 DB·입장 설정과 검토한 커밋을 확인한 뒤 Production에 배포한다.

1. 운영자는 Vercel 프로젝트를 Next.js·Node.js 24로 설정하고 위 Production 환경 변수 세 개를 등록한다. 빌드 명령은 `npm run build`, 설치 명령은 `npm ci`다.
2. 운영자는 검토한 커밋을 배포한다. `prebuild`가 연결 명령에 필요한 다운로드 파일을 생성하므로 별도로 생성물을 Git에 넣지 않는다.
3. 운영자는 Vercel 로그인 없는 브라우저에서 Production 주소에 접속한다. 앱의 코드 입장 화면이 보여야 한다. Preview 보호는 유지하며 동료에게는 Production 주소를 공유한다.
4. 운영자는 잘못된 코드·미입장 접근의 거부, 올바른 코드 입장·세션 유지·방 생성·초대와 기기 승인 동작을 확인한다. 다운로드 파일의 내용 hash도 확인한다. 이 접속 검증은 실제 AI 입력 없이 진행할 수 있다.

GitHub 연결 이후 Production 기준 브랜치는 `main`이다. 새 변경은 짧은 작업 브랜치와 PR로 검토하고 승인된 병합 뒤 반영한다. DB migration은 웹 자동 배포와 별개이므로 새 migration이 있으면 호환 순서와 DB 적용 결과를 먼저 확인한다.

현재 배포·검증 결과와 남은 두 Mac 확인은 [개발·검증 상태](../planning/delivery-and-validation.md)에 유지한다. 공급자 사용량은 각 대시보드에서 확인한다. 무료 플랜의 최신 조건은 [Vercel Hobby](https://vercel.com/docs/plans/hobby)와 [Supabase 요금](https://supabase.com/pricing)을 따른다.
