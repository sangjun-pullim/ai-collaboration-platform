---
status: active
date: 2026-10-16
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# Claude 자동 업데이트와 앱 실행 버전 분리

## Context

기기 등록 후 AI 설정이 `POLICY_UNCONFIRMED`로 실패한다. main `a73b3d2`에서 사용자 폴더의 `NativeClaudePolicy.sourceSnapshot`은 통과했고, `admit`은 `NativeAdmissionError.stage=VERSION`으로 실패했다. 개인 launcher는 2.1.301을 가리키지만 허용된 2.1.288·2.1.293은 개인 설치 폴더에 없다. 2.1.301의 게시자 서명·버전·기존 Max 로그인은 입력 없이 확인했다. 따라서 재승인이나 공유 동의 반복으로 해결되지 않는다.

단순 새 버전 허용은 다음 자동 업데이트 때 재발한다. 미래 패치를 일괄 허용하지 않는다. 현재 adapter의 native identity 검사는 입력 뒤 도착하는 init도 처리하므로 모델 목록 handshake만으로 미래 실행 정책의 안전성을 증명할 수 없다.

추천: 이미 검증한 공식 2.1.293을 앱 전용 캐시에 보관하는 fallback을 추가한다. 기존 지원 버전이 개인 설치에 있으면 기존 선택을 유지한다. 없으면 공식 고정 URL에서 검증한 실행 파일만 준비한다. 개인 launcher·로그인·설정은 변경하지 않는다. 새 버전이 필요한 모델/기능 또는 공급자 보안 수정은 별도 호환 검증 후 앱의 고정 버전을 갱신한다.

초기 내려받기 약 236MB(arm64)/245MB(x64)의 디스크 공간과 네트워크가 추가된다. 별도 앱 설치, npm 설치, 새 로그인은 없다. 자동 다운로드를 포함하므로 이 계획은 승인 전 실행하지 않는다.

## Affected Files

운영 코드 5개:

1. `packages/local-connector/src/claude/native-runtime-cache.ts` (신규) — 고정된 공식 실행 파일의 제한된 다운로드·검증·원자적 캐시 공개.
2. `packages/local-connector/src/claude/native-installation.ts` — 개인 설치 선택과 앱 캐시 선택, 실행 중 파일 검증, 안전한 실패 단계.
3. `packages/local-connector/src/settings/manager.ts` — 로컬 상태 콜백에 실패 단계 전달. 작업 변경 시 초기화. 공개 계약과 journal 구조는 유지.
4. `packages/local-connector/src/cli/settings-status.ts` — 다운로드/서명/버전/로그인/관리 정책에 맞는 안내. 알려진 enum만 출력.
5. `src/features/connection-setup/setup-status.tsx` — `POLICY_UNCONFIRMED`를 공유 동의 문제라고 단정하지 않고 터미널의 프로그램 검증 원인을 안내.

테스트: 신규 `claude-native-runtime-cache.test.ts`, 기존 `claude-native-policy.test.ts`, `claude-native-admission-regression.test.ts`, `runtime-settings.test.ts`, `settings-status.test.ts`, bootstrap 배포 테스트. 테스트 fixture 보완은 필요 범위만 수행한다.

문서: `docs/research/ai-runtime-integration.md`, `docs/guides/onboarding-and-settings.md`, `docs/ARCHITECTURE.md`, `docs/BUG-FIXES.md`, `docs/planning/delivery-and-validation.md`의 실행 파일 선택·제약·오류와 검증 현황. 사용자 개인 설정과 보관 계획은 편집하지 않는다.

## Affected Dependents

- `claude/native-policy.ts:95,130` — admit/assertLive 호출. 기존 정책·개인 설정 fingerprint와 읽기 제한을 유지한다.
- `claude/adapter.ts:138,192,435` — admission·모델 조회·실제 입력. 새 코드로 실제 AI 질문은 보내지 않는다.
- `claude/native-history-proof.ts:87,105,131,431` — 2.1.293의 기존 대화·중단 형식을 그대로 사용하므로 변경하지 않는다.
- `claude/configuration.ts:393` — 실행 파일 최대 256MiB·소유권 검증을 유지한다.
- `packages/local-connector/src/cli.ts:532,610,620,667` — status callback 소비와 최종 JSON 출력. 추가 단계는 `reportStatus` 콜백 payload에만 담고 `status()`·`run()` 반환 JSON 계약은 유지한다.
- `scripts/build-local-connection.mjs` — 신규 순수 Node 모듈이 배포 archive에 포함돼야 한다. 바이너리 자체는 웹 배포에 넣지 않는다.
- `settings/setup-contracts.ts`, 웹의 동명 계약, 기존 SQL 설정 보고 allowlist — 변경하지 않는다. 기존 실패 code와 공개 reason을 유지하며 원시 오류·설정·경로는 전송하지 않는다.
- 현재 지원 범위의 문서 사본: `docs/research/ai-runtime-integration.md:85`, `docs/guides/onboarding-and-settings.md:374,376`, `docs/ARCHITECTURE.md:90`, `docs/BUSINESS-LOGIC.md:80`. 모두 이 저장소 소유. 검색 범위는 현행 docs와 connector 소스. BUSINESS-LOGIC의 공식 게시자·지원 버전 검증 규칙은 유지하고, 개인 설치에만 의존한다는 설명이 있는 문서만 보정한다. archive는 당시 사실로 보존한다.

## Implementation Steps

### [x] Step 1: 현재 실패와 캐시 경계 재현

- 공식 새 개인 버전이 설치되고 이전 지원 파일이 모두 없는 fixture를 만든다. 현재 코드가 모델 조회 전에 VERSION으로 실패하는 것을 확인한다.
- 다운로드는 fake transport로 검사한다. 테스트가 실제 브라우저·CLI·네트워크를 호출하지 않도록 기존 child-process mock의 promisify 경계를 유지한다.

### [x] Step 2: 검증된 실행 파일 캐시

**File**: `packages/local-connector/src/claude/native-runtime-cache.ts`

- 경로는 실제 home 아래 `Library/Application Support/ai-collab/runtimes/claude/2.1.293/<platform>/claude`로 고정한다. 사용자/서버가 URL·버전·해시·대상 경로를 지정할 수 없다.
- 공식 기반 URL: `https://downloads.claude.ai/claude-code-releases/2.1.293`. installer 스크립트나 `claude install`은 실행하지 않는다.
- 2026-10-16 공식 manifest 조회 결과:
  - darwin-arm64: 236330608 bytes, SHA256 `4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e`.
  - darwin-x64: 244819072 bytes, SHA256 `267af22d4eb187b8d65d1592e6fabf57b1df6c254913d5a6c5d8b956a02cd002`.
- 소유자·권한·canonical 부모 검증, symlink/hardlink 거절, 실행 전 정확한 길이/hash 및 기존 Anthropic 코드 서명 요구를 적용한다. 디렉터리 0700·최종 파일 0700, 고유 partial 파일은 배타 생성한다.
- HTTPS 고정 origin, redirect 거절, 응답200, stream 크기 상한, 총120초·읽기 정체 제한으로 bounded 다운로드한다. 전체 파일을 메모리에 적재하지 않는다. 기존 검증 모듈의 파일 상한도 유지한다.
- 내려받기→hash→서명 검사 완료 뒤 같은 파일 시스템의 고유 0700 후보 디렉터리 전체를 최종 플랫폼 디렉터리로 atomic rename한다. 최종 파일을 직접 덮어쓰는 rename은 금지한다. 이미 존재하는 비어 있지 않은 최종 디렉터리 때문에 publish가 실패하면 경쟁 실행의 완성 파일을 다시 검증해 재사용한다. 기존 빈/잘못된 디렉터리도 임의로 삭제·대체하지 않는다. 최종 파일은 nlink=1을 유지한다. 실패 시 본인이 만든 후보 디렉터리만 정리한다. 다른 프로세스가 쓰는 캐시를 삭제하지 않는다.
- 다운로드 대기 중에도 최대 1초 간격으로 기존 `check()`를 호출한다. 취소/종료 시 네트워크와 소유 stream을 닫고 후보 정리를 기다려 반환한다. 이 주기 검사는 모델·AI 호출이 아니다. 별도 장기 lock이나 잠금 미확인 상태를 만들지 않는다.
- 캐시 재사용 시 다운로드하지 않는다. 실행 파일은 코드 해시/identity로 검증하며 손상·교체를 검증 통과로 바꾸지 않는다. 캐시 버전의 자동 정리·업데이트는 이번 범위 밖이다.

### [x] Step 3: 설치 admission과 실행 중 검증 연결

**File**: `packages/local-connector/src/claude/native-installation.ts`

- 기본 개인 native 설치와 환경 검증을 유지한다. 지원 개인 설치 파일이 없고 개인 entry가 정상적인 공식 버전 경로인 경우에만 앱 캐시를 준비한다. 개인 설치 권한/경로가 잘못된 경우를 fallback으로 숨기지 않는다.
- `NativeClaudeInstallation`에 소스(`PERSONAL`/`APP_CACHE`)를 내부적으로 구분한다. caller가 만든 객체를 허용하지 않는 WeakSet 검증은 유지한다.
- 개인 파일 소스는 기존 launcher 변경 검사를 유지한다. 앱 캐시 소스의 assertLive는 해당 admit에서 고정한 캐시 경로·버전·identity·hash를 검사하고 개인 launcher의 이후 패치 업데이트와 분리한다. assertLive는 다운로드·재설치를 하지 않는다. 실행 중 다른 버전으로 교체하지 않는다.
- 서명 뒤 version/auth status를 제한된 프로세스로 조회한다. 기본 프로필, Pro/Max 로그인, 관리 정책/환경 및 개인 설정 스냅샷 검사는 동일하다.
- 캐시 다운로드/검증 실패를 안전한 NativeAdmissionError 단계로 구분한다. CLI stderr·인증 응답은 출력하지 않는다.

### [x] Step 4: 실패 위치에 맞는 안내

**Files**: `settings/manager.ts`, `cli/settings-status.ts`, 웹 `setup-status.tsx`

- manager의 `reportStatus` 로컬 콜백 payload에 optional admission 단계만 담는다. `status()`·`run()` 반환에는 추가하지 않아 manage 명령의 최종 JSON 계약을 유지한다. reason이 달라지거나 작업이 변경/취소/완료되면 오래된 단계를 제거한다. RuntimeError.code·공개 보고 enum·저널 스키마는 유지한다.
- 터미널은 알려진 단계에 해당하는 복구 행동을 보여준다. 버전 문제에는 앱 연결 프로그램 준비 문제임을 표시하고 기기 삭제·재승인을 지시하지 않는다. 다운로드 실패에는 네트워크를, LOGIN에는 기존 Claude 로그인을, MANAGED_POLICY에는 관리 정책 지원 여부를 안내한다.
- 웹에서는 공유 동의가 원인이라고 단정한 문구를 바로잡는다. 세부 원인은 로컬 터미널에서 확인하고 원시 설정은 웹에 공유하지 않는다.
- 기존 durable journal은 실패 code를 보존한다. 새 상세 단계는 실행 중 로컬 안내이며 재시작 뒤에도 보존된다고 주장하지 않는다. 독립 진단 저장 포맷 확대는 이번 변경에 포함하지 않는다.

### [ ] Step 5: 검증·배포·현재 실패 복구

- 독립 reviewer가 운영 변경과 입력 없는 실제 검증 드라이버를 검사한다.
- 승인 이후 실제 Mac에서 캐시 수급·길이/hash/서명·version/auth를 확인한다. 개인 launcher·설정의 불변을 확인한다. 새 AI 질문0회.
- 격리된 합성 저장소/앱 상태에서 기존 제품 factory로 모델 목록만 조회하고 소유 프로세스 종료를 확인한다. user message를 전송하는 메서드는 차단한다. 종료가 미확인이면 다음 실행을 하지 않는다.
- 새 runtime 동작이 아니라 기존 2.1.293 실행 파일의 공급 위치 변경이다. 기존 정상/후속/중단 검증은 동일 실행 파일·정책·프로토콜인 경우에만 재사용하고 새 입력 검증을 했다고 보고하지 않는다.
- connector 회귀·필수 build/lint/format·독립 리뷰 후 PR, 기존 사용자 승인에 따른 main 병합·운영 배포·manifest 확인.
- 사용자의 현재 설정은 FAILED이고 실제 모델 입력 전 실패했다. 먼저 기존 실행에서 설정 취소와 정리 확인을 마치고 같은 기기의 새 연결 명령으로 갱신한다. 기기 제거/새 이름/저널 삭제로 우회하지 않는다. 실제 UI에서 취소가 완료되지 않으면 원인을 별도 확인하고 강제 종결하지 않는다. 새 설정은 사용자가 다시 선택하며 실패 요청을 자동 재실행하지 않는다.

## Tests

- 현재 개인2.1.301·지원 개인 파일 없음 → 수정 전 VERSION 실패, 수정 후 검증된 앱2.1.293 선택. 개인 launcher/설정 불변.
- 지원 개인 설치의 기존 선택과 검증은 유지. 캐시 source는 개인 자동 업데이트 후 동일 파일로 유지. 캐시 교체·권한 변경·개인 정책 변경은 거절.
- 다운로드 실패/redirect/timeout/초과·부족 bytes/틀린hash/서명불일치/잘못된 소유권/symlink/hardlink/경쟁 publish/중단 정리. 실패한 파일의 실행0.
- 캐시 hit에서 network0, 완성파일 없는 두 동시 준비의 안전한 수렴, 재시도는 사용자 새 설정 실행에서만 수행.
- manager 단계 보존·scope 초기화·관찰자 오류 격리, sink 안전 enum·중복 제거·실패 후 정상 안내. 원시 stderr/auth/env 비노출.
- 신규 파일의 배포 archive 포함, 기존 모델 조회/정상/이력/중단 회귀와 fallback publisher 거절 유지.

## Risks

- 검증된 이전 CLI가 최신 기능/모델을 제공하지 못할 수 있다. 서버가 보고한 지원 모델만 표시하며 새로운 CLI 기능은 검증 후 고정 버전을 올린다.
- 이전 버전에 긴급 보안 수정이 필요하면 기존 버전을 계속 고집하지 않고 지원 버전을 갱신한다. 공식 배포 파일 제거 시 다운로드 실패를 정확히 보고한다.
- 캐시 확보와 실행 파일 선택은 보안 경계다. 미래 버전 일괄 허용·서명/정책 검사 완화는 하지 않는다.
- 자동 업데이트는 개인 launcher·설정과 앱 캐시를 분리해 해결한다. 기기 인증·이전 미확인 질문 문제를 해결한 것으로 확대하지 않는다.

## Verification

- connector tsc, 대상 `node --test` 회귀(수정 전 실패→후 통과), 배포 패키지 테스트.
- `npm run build`, `npm run lint`, `npm run format`, `npm run format:check`. 기존 사용자 `next-env.d.ts` 변경은 보존하고 커밋하지 않는다.
- 실제 입력 없는 version/auth/capability + 프로세스 종료 검증. Docker는 시작하지 않는다.
- 독립 코드/검증 리뷰. PR 미리보기 성공 후 병합, production READY와 main SHA·배포 archive 일치 확인.

## Review Notes

독립 reviewer `claude_cache_plan_review`의 계획 검토 PASS. CRITICAL/HIGH 0건. 사용자가 계획을 승인했다. 운영 코드와 회귀 테스트를 구현했다. 구현·드라이버 독립 검토에서 CRITICAL/HIGH0건이었다. 실제 캐시 다운로드와 입력 없는 모델 조회1회를 실행해 모델13개·개인 설정/launcher 불변·REAPED·catalog 예약 정리·입력0을 확인했다. 캐시 오류 분류 MEDIUM1건은 보완 후 새 reviewer의 추가 검토 PASS로 해소했다. 최종 관련458/458·웹699/699·build/lint/format/check 통과. 배포와 기존 사용자 설정 갱신은 Step5에 남긴다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 존재하지 않는 CLI 소비자 경로와 최종 JSON 영향 | MEDIUM | ACCEPTED | 실제 `cli.ts` 소비자 위치로 교체했다. 상세 단계는 reportStatus 콜백에만 추가하고 status/run 반환 JSON은 유지하도록 Step 4에 반영했다. |

| 캐시 손상 오류가 개인 설치 문제로 잘못 안내됨 | MEDIUM | ACCEPTED | 캐시 준비의 파일시스템 오류와 UNSAFE_STORAGE를 CACHE_INTEGRITY로 변환한다. 취소·종료·서명·snapshot RuntimeError는 유지한다. missing binary/symlink parent 제품 회귀를 먼저 실패 확인한 뒤 보완했다. |
