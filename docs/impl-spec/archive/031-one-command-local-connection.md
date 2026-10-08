---
status: done
date: 2026-10-07
risk-surface: auth, permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 명령 한 번으로 내 Mac의 AI 연결

## Context

사용자는 기존 Claude/Codex를 유지하고 별도 앱 설치·프로젝트 복제 없이 웹의 명령 한 번으로 연결 코드를 임시 실행하는 방식을 허용했다. [PRD의 로컬 AI 연결](../../PRD.md#로컬-ai-연결)과 [연결 방식 조사](../../research/local-ai-connection-research.md#별도-연결-프로그램-설치를-없애는-대안)를 따른다.

원격 MCP는 외부 도구 연결이며 이 제품에 필요한 웹 모델·effort 변경, 실행 중단, 소유 실행 기록과 읽기 권한을 함께 제공하는 공통 실행 제어 계약이 아니다. 기존 중앙 질문·설정 API와 로컬 실행기를 재사용하고 배포·첫 연결만 바꾼다. Node의 별도 설치도 요구하지 않는다. 필요한 경우 공식 고정 버전의 실행 파일을 임시 폴더에서 실행한다.

이 계획은 022·029·030의 실행 정책과 남은 실제 수용을 대체하지 않는다. 다운로드와 등록 성공은 실제 Claude 답변·후속 질문·중단·두 PC 수용의 증거가 아니다. 인증·설정 파일, 원래 저장소, 개인 AI 기본값과 기존 프로필은 변경하지 않는다.

목표 흐름은 **웹에서 방과 기기 이름 선택 → 명령 복사·실행 → 웹에서 기기 승인 → 터미널에서 승인 계정·방 확인 → 웹에서 AI·폴더·모델·effort 설정**이다. 사용자의 2026-10-07 계속 진행 지시에 따라 검토를 마친 이 범위를 이어간다. 사용자가 미완료 작업을 끝까지 계속하라고 재확인했으므로 main 병합과 독립적인 동일 채팅 연결 구현을 현재 작업 위치에서 이어간다. 완료된42개 커밋의 고정 병합 범위는 유지하며 새 구현을 포함한 현재 HEAD 전체를 완료된 main 범위로 사용하지 않는다. 다른 작업은 기준 브랜치 정리가 가능한 뒤 별도 브랜치로 시작한다. 실제 AI 추가 입력 상한과 기존 승인 경계는 변경하지 않는다.

## Affected Files

1. `packages/local-connector/src/cli/connect-command.ts` — 첫 연결과 기존 연결 재접속을 묶는 명령 구현.
2. `packages/local-connector/src/cli.ts` — `connect` 분기와 기존 설정 관리 루프의 연결.
3. `packages/local-connector/src/cli/parse-options.ts` — 연결 대상 방·조직 인자의 명시적 허용.
   `packages/local-connector/src/cli/settings-lock.ts` — 새 connect에도 기존 retired profile 재등록 차단 적용.
4. `scripts/build-local-connection.mjs` — 운영 모듈만 포함한 배포 파일·검증값 생성.
5. `scripts/local-connection-bootstrap.sh` — macOS 임시 실행·검증·정리.
6. `packages/local-connector/tsconfig.distribution.json` — 테스트를 배포에서 제외하는 컴파일 입력.
7. `src/features/device-binding/local-connection-command.ts` — 배포 정보 검증과 안전한 명령 생성.
8. `src/features/device-binding/local-connection-guide.tsx` — 첫 연결·재접속의 명령 복사 안내.
9. `src/features/device-binding/connection-manager.tsx` — 안내 조합, 기기 코드의 임시 입력과 승인 완료 안내.
10. `src/app/app/connections/page.tsx` — 검증한 앱 origin과 현재 사용자의 프로필 구분 값 전달.
    `src/features/runtime-settings/runtime-settings-form.tsx` — 이미 실행 중인 connect 유지 안내와 수동 manage 안내의 분리.
11. `scripts/dev-local-web.mjs` — 사전 점검 뒤 실제 웹 시작 전에 배포 파일 생성. `--check`는 생성하지 않음.
12. `package.json`, `.gitignore` — 배포 생성 명령·빌드/개발 실행 연결과 생성 파일 제외.
13. `docs/ARCHITECTURE.md`, `docs/guides/onboarding-and-settings.md`, `docs/planning/delivery-and-validation.md`, `docs/README.md` — 구현 후 현재 동작과 검증 상태 갱신.

## Affected Dependents

- `Connector.pair/status/exchange`와 `StateStore` — 같은 요청·프로필의 기존 복구와 비밀 저장을 재사용한다. 공개 `Scope`에는 소유자 UUID가 없으므로 UUID 검증을 했다고 주장하지 않는다.
- `SettingsManager.run`과 `withSettingsDeviceLock` — 기기 설정 잠금과 실행 수명을 유지한다. 연결 준비의 잠금을 반환한 다음 기존 관리 루프가 잠금을 다시 획득하며 경합은 기존 충돌로 종료한다.
- `provider-adapter.ts`, `WorkflowRunner`, Codex/Claude 실행기 — 배포 파일의 상대 import가 완결되어야 한다. 실행 정책과 관찰 계약은 변경하지 않는다.
- `/api/connections`, `/api/connector`, `/api/runtime-settings`, `/api/workflow` — 기존 본문·응답·권한 검사·요청 크기 제한을 유지한다. 공개 API 계약·SQL·마이그레이션은 추가하지 않는다.
- `RuntimeSettingsForm` — 기존 공급자 선택, 폴더 승인과 적용 상태를 그대로 사용한다. 이미 실행 중인 connect를 유지하도록 안내하고 수동 manage 명령은 펼침 영역에 남긴다.
- `tests/helpers/settings-browser-fixture.ts`, `tests/e2e/device-workspace-binding.spec.ts`, `playwright.device.config.ts` — 기존 기기 러너에서 수동 연결과 사용자별 기기 소유권을 계속 검증한다.
- `tests/unit/runtime-settings-view.test.ts:443–446,568–607` — 고정 UI import mock과 ConnectionManager props를 보완하면서 기존 기기·방 선택과 질문자 회귀를 유지한다.
- 현재 실행 중인 개발 서버와 사용자가 변경한 `next-env.d.ts` — 프로세스를 재시작하거나 사용자 변경을 덮어쓰지 않는다.

## Implementation Steps

### [x] Step 1: 임시 실행용 배포 파일 생성

**File**: `scripts/build-local-connection.mjs`, `packages/local-connector/tsconfig.distribution.json`, `.gitignore`

- 현재 패키지는 `rootDir: .`에 운영 소스와 테스트를 함께 컴파일한다. 별도 컴파일 설정으로 새 임시 디렉터리에 운영 소스만 빌드한다. 기존 `dist` 전체를 복사하지 않는다.
- 결과는 운영 `.js` 파일과 `type: module`인 최소 package manifest만 포함한 표준 `.tar.gz`다. 원본 `.ts`, 테스트, 실험, 개인 상태·설정·인증·환경 파일과 symlink를 포함하지 않는다. 상대 import는 모두 배포 안에서 해석되고 외부 import는 Node 내장 모듈뿐인지 검사한다.
- 파일명은 SHA-256 검증값으로 고정하고 `public/local-connection/` 아래에 배포한다. 생성 명세에는 형식 버전, 코드·bootstrap의 고정 상대 URL, 바이트 수, SHA-256만 둔다. URL·파일명에 사용자 입력을 넣지 않는다.
- 정렬한 파일 목록과 동일한 권한·시간을 사용한다. 생성은 임시 경로에서 완료한 뒤 manifest를 마지막에 교체한다. 실행 중 새 버전을 자동 적용하지 않는다.
- 코드 압축 파일은 16MiB, 해제 후 파일은 64MiB 이내로 제한한다. 배포 파일의 생성 여부와 검증은 AI를 실행하지 않는다.

### [x] Step 2: 추가 설치 없는 Mac 임시 실행

**File**: `scripts/local-connection-bootstrap.sh`, `src/features/device-binding/local-connection-command.ts`

- macOS 13.5 이상, arm64/x64를 지원한다. 운영체제·CPU를 확인하며 지원 밖이면 다운로드와 실행 전에 종료한다.
- macOS 기본 도구의 고정 경로와 인자 배열/안전한 shell 인용을 사용한다. origin은 HTTPS 또는 개발용 loopback HTTP만 허용한다. URL 자격증명·경로·query·fragment, redirect·다른 출처의 코드 다운로드를 거절한다.
- 사용자가 복사하는 명령에는 bootstrap의 SHA-256과 방·조직·프로필·기기 별칭만 둔다. 회사 코드, 기기 승인 코드, 공급자 토큰과 파일 경로를 포함하지 않는다. 웹이 입력한 값을 shell 코드로 평가하지 않는다.
- shell·Node를 실행하기 전에 preload 환경으로 코드가 실행되지 않게 한다. 새 shell의 `BASH_ENV/ENV`와 Node의 `NODE_OPTIONS` 및 동적 라이브러리 주입 변수를 차단하며, 공급자의 기존 설정·로그인 파일은 건드리지 않는다. PATH와 HOME 등 실제 실행에 필요한 환경은 실행 프로세스 안에서만 다룬다.
- 명령이 bootstrap을 임시 파일로 받고 검증한 뒤 실행한다. bootstrap은 코드 배포 파일을 같은 origin에서 받아 검증한다. digest 누락·형식 오류·불일치와 크기 초과는 실행 전에 종료한다.
- 현재 Node가 지원되는 24.x이면 사용한다. 없다면 Node `24.21.0`의 공식 `nodejs.org` macOS `.tar.gz`를 고정 주소와 아래 SHA-256으로 검증해 임시로 실행한다. 사용자 PATH·전역 프로그램·쉘 설정을 변경하지 않는다.
  - arm64: `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`
  - x64: `1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097`
- Node 압축 파일에서는 정확한 실행 파일과 LICENSE만 꺼낸다. 코드 압축 파일도 절대 경로·상위 경로·symlink를 거절하고 전용 0700 임시 디렉터리에 해제한다. 다운로드는 연결·전체 제한시간과 크기 한도를 둔다.
- 임시 Node의 bin 경로는 해당 연결 프로세스의 PATH에만 추가한다. `/usr/bin/env node`로 시작하는 기존 CLI에도 실행 환경을 제공하되 사용자 shell의 PATH와 설정 파일은 바꾸지 않는다.
- 종료 신호는 실행 중 연결기로 전달한다. 연결기와 소유 하위 프로세스의 종료를 확인한 뒤 임시 코드·Node를 제거한다. 연결기 실행 뒤 nonzero/signal 종료 또는 종료 확인 부재는 보수적으로 임시 경로를 보존하고 오류를 표시한다. 현재 CLI의 `CLEANUP_INCOMPLETE`도 이 경로에 포함한다. 기존 private profile·소유 이력·UNKNOWN 기록은 삭제하지 않는다.

### [x] Step 3: 기기 승인부터 설정 관리까지 한 명령으로 연결

**File**: `packages/local-connector/src/cli/connect-command.ts`, `packages/local-connector/src/cli.ts`, `packages/local-connector/src/cli/parse-options.ts`, `packages/local-connector/src/cli/settings-lock.ts`

- `cli.ts:130–246`의 pair/status/exchange를 재사용한다. 새 모듈에는 연결 준비·승인 대기만 두고 provider 실행 로직을 복제하지 않는다. CLI dispatch는 기존 `manage`와 같은 SettingsManager 생성을 사용한다.
- 웹의 현재 사용자 구분 값·origin·방으로 안정적인 40자 이하 프로필 이름을 만든다. 사용자 구분 값은 프로필 충돌 방지용이며 승인 소유자 UUID를 검증한 근거가 아니다. 기존 수동 프로필은 덮어쓰지 않는다.
- 새 프로필은 기기 코드를 만들고 `/app/connections#...`을 기본 브라우저로 연다. 코드와 방 ID는 fragment에만 둔다. 브라우저 열기 실패 시 직접 입력할 코드·주소를 터미널에 안내한다. 코드·proof·credential을 서버 URL query나 진단 로그에 넣지 않는다.
- 기존 연결 준비 상태는 같은 pairing과 pending operation을 재사용한다. 만료·취소·다른 origin/방·지원 밖 pending은 기존 복구 오류로 종료한다. 새 프로필·코드·AI 입력을 자동으로 만들어 재시도하지 않는다.
- `settings-lock.ts:21`의 retired profile 보호 대상에 `connect`를 추가한다. 인증 profile이 없는데 SettingsStore의 기존 설정·이력이 남아 있으면 pairing 전에 거절한다. 디렉터리·이력 삭제나 새 profile 생성으로 이 보호를 우회하지 않는다.
- 승인 대기는 2초 간격의 입력 없는 상태 조회이며 pairing 만료나 사용자 종료로 끝난다. 지연 응답 뒤 중복 exchange를 만들지 않는다.
- 승인 scope의 조직·방 ID를 예상 값과 비교한다. ownerAlias·조직·방·기기 이름을 안전하게 표시하고 로컬 사용자가 확인해야 exchange한다. 비대화형 실행·EOF·거절은 교환하지 않는다. 표시 이름만으로 암호학적 소유자 확인을 했다고 주장하지 않는다.
- 연결된 프로필의 재실행은 scope를 다시 확인하고 기존 관리 루프에 연결한다. 다른 연결기가 실행 중이면 잠금 충돌로 종료한다. 연결 잠금을 반환한 뒤 관리 잠금을 획득하는 사이에 다른 프로세스가 선점하면 오류로 끝내며 우회하지 않는다.
- Ctrl+C는 기존 untilStopped/SettingsManager/WorkflowRunner 종료 흐름을 사용한다. 등록 상태를 실제 AI 실행 준비 완료로 표시하지 않는다.

### [x] Step 4: 웹에 실제 복사 가능한 연결 안내 제공

**File**: `src/features/device-binding/local-connection-guide.tsx`, `src/features/device-binding/local-connection-command.ts`, `src/features/device-binding/connection-manager.tsx`, `src/app/app/connections/page.tsx`, `src/features/runtime-settings/runtime-settings-form.tsx`

- 서버의 `APP_ORIGIN`과 검증된 로그인 사용자의 구분 값, 현재 접근 가능한 방만 사용한다. origin이 유효하지 않거나 배포 파일이 없으면 복사 버튼 대신 구체적인 준비 상태를 표시한다.
- 기존 6단계의 수동 안내(`connection-manager.tsx:110–128`)를 ‘방·기기 이름 선택 / 명령 복사·실행 / 웹에서 승인 / 로컬 승인 확인 / AI 설정’으로 바꾼다. shadcn Button/Input과 현재 화면 구조를 재사용한다.
- 생성 manifest를 no-store로 읽고 크기·필드·URL·digest를 검증한다. 고정 경로를 벗어나는 주소로 명령을 만들지 않는다. 명령에는 방 제목·개인 경로·인증 정보가 들어가지 않는다.
- 명령을 읽고 복사할 수 있는 펼침 영역을 제공한다. clipboard 실패 시 선택·수동 복사를 안내한다. ‘연결 코드 실행이 필요함’, ‘터미널을 열어 둬야 함’, ‘질문만 하는 참가자는 필요 없음’을 짧게 표시한다.
- fragment의 기기 코드와 방을 한 번 읽고 URL에서 즉시 제거한다. 알려진 방·유효한 코드만 승인 폼에 미리 넣는다. 자동 승인하거나 범위 확인 checkbox를 자동 선택하지 않는다.
- 승인 완료 안내는 터미널의 확인 단계와 웹 AI 설정으로 이어진다. 수동 연결 이용자에게도 기존 exchange/manage 경로를 펼쳐 볼 수 있게 한다.
- `runtime-settings-form.tsx:105–108`의 항상 별도 manage 실행을 요구하는 안내를 바꾼다. 새 연결에서는 실행 중인 connect 터미널을 유지하면 되고 추가 manage를 실행하지 않는다. 기존 수동 연결은 펼침 영역의 manage 안내를 사용한다. 공급자·폴더·모델 선택 동작은 그대로 유지한다.

### [x] Step 5: 개발·빌드 연결과 검증·문서 마감

**File**: `package.json`, `scripts/dev-local-web.mjs`, 관련 테스트와 문서

- `build:local-connection`을 추가하고 웹 build/dev 전에 생성한다. `dev-local-web.mjs --check`의 DB 변경 없음·파일 생성 없음·AI 입력 없음 의미는 유지한다. 실제 start만 사전 점검 뒤 생성하며 현재 서버를 중지하지 않는다.
- 배포 파일은 생성물로 Git에서 제외한다. 로컬 기존 웹 프로세스는 재시작하지 않고 파일·구성 변경과 실제 새 실행 필요 여부를 보고한다.
- 아래 테스트와 필수 검사를 수행하고 새 reviewer가 인증·다운로드·권한·종료를 검토한다. 기존 실행 정책의 코드·입력이 같은 검사 결과는 재사용하고 변경한 연결 부분은 추가 검증한다.
- 온보딩·아키텍처를 실제 구현과 맞춘다. 개발·검증 상태에 실제 수행한 것과 환경상 남은 실제 Mac/두 PC 수용을 구분해 기록한다. 이 계획의 테스트·검사·리뷰가 완료되면 archive로 이동하되 030의 미완료 실제 수용을 완료 처리하지 않는다.

## Tests

- `packages/local-connector/tests/connect-command.test.ts` — should preserve the pairing operation after response loss; should refuse a mismatched room or organization; should require local scope confirmation before exchange; should refuse confirmation without a terminal; should resume the same connected profile; should refuse a competing manager; should stop polling on expiry or abort; should not create a new profile or model input on uncertain recovery; retired profile refusal and retained history are verified by the existing cli-settings.test.ts for connect, pair and exchange.
- `tests/unit/local-connection-distribution.test.ts` — should include the transitive production modules without tests or private files; should refuse symlinks and external runtime dependencies; should publish the manifest only after complete assets; should run an isolated distribution without checkout or npm installation;
- `tests/unit/local-connection-command.test.ts` — should quote Unicode and hostile shell input without execution; should reject a foreign origin or unsafe manifest path; should omit secrets from the command; should namespace profiles by user and room; should reject an invalid digest or unsupported manifest version.
- `tests/unit/local-connection-bootstrap.test.ts` — should reuse a supported runtime; should verify the official runtime and pinned download metadata for both Mac architectures before execution; should refuse corrupt, oversized, redirected or path-escaping downloads; should preserve state on cleanup; should retain temporary files when owned shutdown is uncertain; should prevent shell and Node preload code before validation and execution. For `BASH_ENV`, `ENV`, `NODE_OPTIONS` and dynamic-library injection variables, use marker fixtures and verify they are blocked before launching shell/Node or validation tools. Pin both marker nonexecution and absence from the child environment. Use temporary fixtures and injected downloader/runtime processes; no live provider input.
- `tests/unit/runtime-settings-view.test.ts` — update the guide import mock and required origin/user props; keep existing live-owned-device, accessible-room selection and question-only participant assertions; verify setup guidance does not start an approval automatically; should instruct connect users to keep the existing process and show manage only in manual setup guidance. Exercise rendered semantics rather than matching a full fixed sentence.
- `tests/unit/local-web-environment.test.ts` — existing check-only tests remain valid; add a meaningful start-path check if startup orchestration changes.
- `tests/e2e/device-workspace-binding.spec.ts` — copy a valid command for an accessible room, consume/clear a valid fragment without auto-approval, reject an unknown room and malformed code, approve with the owner session, keep manual pairing usable. Run with the current `playwright.device.config.ts`; report actual browser execution separately if the environment cannot launch it.

## Risks

- Temporary execution downloads code. The UI-provided bootstrap digest, same-origin immutable artifacts, pinned official Node digests, size/path limits and reviewer are required. Verification values are not credentials and do not independently protect a compromised trusted website.
- Downloads require access to the website and, when needed, `nodejs.org`. A blocked corporate network yields a clear error; no package mirror, permission bypass or hidden installer fallback is introduced.
- Existing public Scope exposes ownerAlias rather than owner UUID. Preserve explicit local identity/scope confirmation; do not automate that decision or add an unplanned API/DB change.
- Closing the terminal disconnects the AI. This phase provides a foreground process, not a background daemon or login item. Re-running the same command resumes the existing local profile.
- Personal agent settings stay on the PC. Existing restrictions on unverified hooks/plugins/MCP and native admission stay in effect; easier startup does not prove product subscription eligibility or actual effort application.

## Verification

- Node 24: `npm run build:local-connection`; inspect the generated file inventory and SHA-256, then import/execute an isolated fixture from the unpacked distribution with no checkout access.
- Node 24: root unit runner, connector typecheck/build and connector tests for connect, CLI/settings locks, pairing recovery and settings manager. Do not turn a known unrelated baseline cancellation into a claim of full success.
- Run TypeScript checks with the existing generated Next types; do not overwrite user `next-env.d.ts` by running Next typegen. Run lint, `npm run format`, `npm run format:check`, `git diff --check` and Markdown relative-link checks.
- Validate the shell script with `/bin/bash -n`; run bootstrap fixtures with fixed tool paths/injected test harness and assert child exit and cleanup ordering.
- Browser/DB and actual arm64/x64 Mac run are separate evidence. Do not start Docker, reset DB, modify personal AI files or use live model inputs to make isolated tests pass.
- Independent plan reviewer before approval and implementation reviewer after code verification. Report review scope/results and any remaining findings.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Round 1: connect 경로의 retired profile 보호 누락 | HIGH | ACCEPTED | Step 3과 settings-lock 영향 파일·회귀 테스트에 기존 재등록 차단을 명시했다. |
| Round 1: 기기 browser 테스트 경로와 러너 불일치 | HIGH | ACCEPTED | 실제 device-workspace-binding.spec.ts와 playwright.device.config.ts로 바로잡았다. |
| Round 1: 기존 ConnectionManager 단위 테스트 영향 누락 | MEDIUM | ACCEPTED | runtime-settings-view의 mock·props 갱신과 기존 assertion 유지 기준을 추가했다. |
| Round 2: preload 환경 차단의 회귀 테스트 누락 | HIGH | ACCEPTED | bootstrap 테스트에 네 환경 주입 경로의 marker 비실행·자식 환경 부재 검증을 명시했다. |
| Round 2: 설정 화면이 추가 manage 실행을 유도 | HIGH | ACCEPTED | RuntimeSettingsForm을 영향 파일·Step 4에 추가하고 connect 유지와 수동 manage 안내의 의미를 UI 회귀로 검증한다. |

최종 계획 리뷰 Round 3은 PASS, C0/H0/M0/L0/INFO0이다. 기준 HEAD는 `8535ce2`이며 환경 주입·화면 안내 보정을 확인하고 앞선 운영 배포·종료·소유 scope 검토의 변경 없는 부분을 재사용했다. 구현·테스트 실행이나 실제 AI 수용의 통과 결과는 아니다. 구현은 Context에 정한 같은 채팅 연결 작업의 실행 순서를 따른다.

### 구현 리뷰 1회와 보정

결과 C0/H2/M0/L0/INFO0. shasum의 Perl 환경 주입(H1)과 curl 기본 설정 적용(H2)을 수용했다. 각각 실제 실패 테스트를 먼저 기록했다. Perl startup/import 변수를 첫 새 프로세스 전과 bootstrap에서 제거하고 두 curl 호출의 첫 인자를 --disable로 고정한다. 개인 설정 파일을 변경하지 않으며 연결 다운로드에만 기본 curl 설정을 적용하지 않는다. 실제 Perl marker 비실행·자식 환경 부재·임시 CURL_HOME의 추가 URL 무시 회귀를 검증하고 새 reviewer로 재검토한다.

### 최종 완료 검증

구현 리뷰2는 PASS C0/H0/M0/L0/INFO0. 변경 없는18개 파일의1회 검토를 재사용하고 보정6개 파일·영향 범위를 새 reviewer가 검토했다. H1/H2는 모두 해소했다. 웹 unit332/332, 연결·CLI옵션·잠금·복구·설정 관리·저장 검사148/148, 웹/테스트/브라우저/통합/연결기 타입, lint, format/check, bash 구문, diff 검사가 통과했다. 현재 코드의 격리 웹 build, 운영 배포 생성, 프로젝트/npm 없는 실제 배포 import·입력 없는 실행 거절도 통과했다. 실제 AI 입력0.

새 device 브라우저 회귀는 desktop/mobile 총6개로 현 러너가 인식했다. 현재 환경의 LOCAL_STACK_UNVERIFIED 때문에 실제 DB/HTTP/browser 실행은 이번 통과에 포함하지 않는다. 합성 arm64/x64 런타임은 공식 주소·고정 digest·임시 PATH 처리의 검증이며 두 CPU의 실제 공식 바이너리 실행 수용과 다르다. 실제 Claude 답변·재개·중단과 두 PC 수용은030·022·009에 남긴다. 이 계획은 배포·첫 연결 개선의 완료 기록이다. Git 쓰기와 Github접속 제한으로 이번 신규 변경의 커밋/PR/main 포함은 미완료다.

원문 patch·파일 hash·RED/GREEN·검사·리뷰 로그: /private/tmp/ai-collab-031-verification-20261007-99jxryqv/. 기존 사용자 next-env.d.ts와 실행 중인 웹, 개인 로그인·설정·대화 기록을 유지했다.
