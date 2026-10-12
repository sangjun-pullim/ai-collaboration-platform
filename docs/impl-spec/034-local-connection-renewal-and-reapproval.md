---
status: active
date: 2026-10-12
risk-surface: auth, permission, db-schema
approval: approved
---
> 이 문서는 구현 계획이다. 현재 동작의 근거로 사용하지 않는다. 2026-10-12 사용자가 계획대로 구현·검증·배포를 승인했다. 독립 계획 검토를 통과했으며 완료 시 archive로 옮긴다.

# 기기 인증 갱신과 만료 후 재승인

## Context

기기 인증은 발급·갱신 후 1시간 동안 유효하다. 현재 접속 상태 보고는 인증을 갱신하지 않는다. 만료된 등록 프로필은 `disconnected`로 남으며 같은 웹 연결 명령을 다시 실행해도 새 승인 전에 `CONFLICT`로 거절된다. 현재 기기·실행·설정 이력을 지우지 않고 재접속할 수 있어야 한다. 제품 범위는 [PRD](../PRD.md)의 각 PC에 있는 AI에 질문하는 흐름을 따른다.

기준 코드: `3fa0ef42f6937284cd1e53aaa35b1ceb168c4599`. 사용자가 올린 실행 파일의 공개 배포 hash가 이 코드의 배포물과 같고, 해당 Mac의 등록 인증 만료·끊김 상태를 읽기 전용으로 확인했다. 실제 모델 입력은 사용하지 않았다. 사용자는 기기 연결 시간 연장도 요청했다. 새 기기 인증·회전은 7일을 기준으로 하고 기존 만료 인증은 새 승인으로 복구한다. 현재 수정 대상은 아래 운영 코드·migration 14개와 관련 테스트다. 왼쪽 메뉴 유지 변경은 별도 변경이며 이 계획의 인증 동작에 포함하지 않는다.

## Affected Files

1. `packages/local-connector/src/connection-renewal.ts` — 새 파일. 같은 기기의 갱신을 직렬 실행하고 진행 중 작업과 종료를 공유한다.
2. `packages/local-connector/src/cli.ts` — 공통 갱신 기능을 연결 준비·설정 관리·답변 실행에 전달한다.
3. `packages/local-connector/src/settings/manager.ts` — 대기·설정 창·실행 중 갱신, 같은 설정 요청의 제한된 복구와 오류 표시를 연결한다.
4. `packages/local-connector/src/workflow-runner.ts` — 프로필 잠금 밖에서 갱신을 기다리고 입력 허용 확인의 인증 교체 경쟁도 처리한다.
5. `packages/local-connector/src/cli/remove-local-profile.ts` — 삭제와 분리한 소유 기록 검사. 기존 제거 기능의 잠금·소유권 검사를 재사용한다.
6. `packages/local-connector/src/cli/connection-recovery.ts` — 새 파일. 만료된 이전 프로필 검사와 새 프로필 이름 검증을 맡는다.
7. `packages/local-connector/src/cli/connect-command.ts` — 실패 이유와 새 승인 절차를 안내하며 기존 등록·만료 pairing 절차를 유지한다.
8. `packages/local-connector/src/cli/parse-options.ts` — 이전 프로필·복구 식별자 옵션만 추가하고 기존 엄격한 옵션 검증을 유지한다.
9. `scripts/local-connection-bootstrap.sh` — 기존 5개 인자와 복구용 7개 인자를 구분해 검증·전달한다.
10. `src/features/device-binding/local-connection-command.ts` — 기존 프로필 생성은 유지하고 명시적으로 고른 복구 세대를 검증해 명령을 생성한다.
11. `src/features/device-binding/local-connection-guide.tsx` — 새 승인 선택과 기존 연결 종료 안내, 세대 보관·재복사를 제공한다.
12. `src/features/device-binding/connection-manager.tsx` — 같은 이름의 기기를 구별하도록 본인 연결 카드에 공개 연결 ID를 표시한다. 기존 연결 취소·기기 제거의 권한과 요청은 유지한다.
13. `supabase/migrations/20261012001800-seven-day-device-credentials.sql` — 신규 발급·회전의 유효기간과 저장 제약을 7일로 변경한다. 이전 migration을 고치지 않는다.
14. `scripts/apply-local-ai-settings.mjs` — 같은 신규 기간 migration을 로컬 설치·검사 경로에 포함한다. 이미 적용된 DB를 되돌리지 않으며 기존 010–017 업그레이드와 설치 판정을 유지한다.

## Affected Dependents

- `packages/local-connector/src/cli/runtime-context.ts` — 같은 연결 객체를 configured/current runner에 전달한다. 새 갱신 옵션은 선택적으로 추가해 기존 호출을 유지한다.
- `packages/local-connector/src/cli/settings-lock.ts` — 기기 잠금이 가장 먼저 잡히며, 제거한 프로필을 다시 등록하는 차단을 유지한다.
- `packages/local-connector/src/state-store.ts` — 회전 journal·후보 인증·프로필 transaction이 기존 내구 저장을 사용한다. 프로필 잠금 대기는 2초다.
- `packages/local-connector/src/settings/store.ts`, `runtime-store.ts` — 기존 현재·보존 세대와 실행 기록 형식을 바꾸지 않는다.
- `packages/local-connector/src/settings/connection-heartbeat.ts` — 늦은 상태 보고 오류가 갱신된 인증을 끊지 않도록 현재 직렬·종료 대기를 유지한다.
- `packages/local-connector/src/{central-client,workflow-client}.ts`, `settings/client.ts` — 기존 HTTP 본문·scope·응답 검증과 제한을 유지한다.
- `scripts/build-local-connection.mjs` — 신규 TS 모듈을 기존 배포 빌드로 포함한다. 배포물·manifest hash를 다시 생성한다.
- `supabase/migrations/20261001000400-device-workspace-binding.sql`, `20261001000600-durable-investigation-coordinator.sql`, `20261005001000-owner-local-ai-setup.sql`, `20261008001600-runtime-settings-binding-receipt.sql` — 현재 회전·취소・설정 확정의 정본이다. 같은 회전의 2분 결과 재수신, 활성 기기 10개·동일 소유자/조직/방 활성 AI 연결 2개 한도를 유지한다. 인증 만료만으로 서버 등록은 취소되지 않는다. 기간 연장 migration 이외의 서버 API·권한 변경은 없다.

## Implementation Steps

### [x] Step 0: 신규 기기 인증을 7일로 발급
**File**: `supabase/migrations/20261012001800-seven-day-device-credentials.sql`
- 현재 010에서 발급 본체로 이름을 바꾼 `device_binding_private.connector_010_runtime(text,jsonb,text)`의 exchange·rotate 발급 시간을 1시간에서 7일로 바꾼다. 외부 `connector`의 설정 변경 중 충돌 검사와 호출 전달은 유지한다. 발급 본체의 그 외 본문·signature·security definer·search_path·ACL·owner/room 검사·idempotency는 유지하고 정본과 비교한다.
- credentials의 expires_at 기본값·기간 상한 check를 7일로 확장한다. 실제 제약 이름·정의와 현재 함수 본문을 격리 DB에서 확인한다. 하나의 transaction으로 적용한다.
- 기존 행의 expires_at·revoked_at·current_hash는 수정하지 않는다. 이전 만료·취소 인증을 되살리지 않으며, 이미 만료된 이 Mac은 아래 새 승인 절차로 연결한다.
- 로컬 적용 스크립트의 고정 migration 목록과 보정 설치 검사를 018까지 연결한다. 현재 wrapper와 발급 본체를 혼동하지 않고 신규 발급·제약을 판정한다. 010–017의 기존 판정·보정 순서와 JSON 오류 계약은 유지하며, 미적용 DB와 018 적용 DB 모두에서 검사·반복 적용·부분 설치 실패를 검증한다. 클라우드 준비 스크립트의 자동 migration 탐색도 같은 018을 포함하는지 확인한다.
- 신규 발급·회전 7일, 7일 초과 제약 거절, 기존 1시간 기록의 바이트·시각·철회 보존, 취소·권한 상실 즉시 거절, 같은 회전 2분 재수신을 실제 로컬 DB에서 검증한다.
- 배포는 검증·독립 리뷰 후 기존 클라우드 migration 준비 절차를 사용한다. 기간을 되돌릴 때는 새 발급 시간만 1시간으로 되돌리는 보정 migration을 사용하고 이미 발급한 7일 기록을 삭제·수정하지 않는다.

### [x] Step 1: 같은 기기의 갱신을 한 번만 실행
**File**: `packages/local-connector/src/connection-renewal.ts`, `cli.ts`
- 등록된 같은 기기에 대해 만료 5분 전부터 기존 `Connector.rotate()`를 사용한다. 만료·취소·권한 상실 인증으로 새 회전을 시작하지 않는다.
- 같은 프로필의 진행 중 Promise를 공유한다. 다른 pending 작업·등록 작업은 바꾸지 않는다. 이미 저장된 회전은 같은 operation ID·후보 인증으로만 재개한다.
- 프로필 transaction 안에서 coordinator를 다시 호출하지 않는다. 회전의 기존 10초 HTTP 제한과 2초 잠금 대기를 혼동하지 않는다. 대기자는 프로필 잠금에 들어가기 전에 진행 중 갱신을 기다린다.
- 중단 후 새 갱신을 시작하지 않는다. 이미 시작한 갱신의 정리·저장 종료를 기다린다. 결과 유실 시 pending 증거를 보존하고 새 회전 식별자를 만들지 않는다.
- 아직 등록되지 않은 프로필은 갱신을 시도하지 않는다. 연결 준비에서 pending 회전을 복구할 때도 같은 서비스·조직·방을 먼저 확인한다.

### [x] Step 2: 설정 관리와 답변 실행에 갱신 연결
**File**: `settings/manager.ts`, `workflow-runner.ts`, `cli.ts`
- 설정 관리 시작·poll/receipt 전과 30초 접속 상태 보고 주기에 갱신을 연결한다. 폴더·동의 창을 기다리는 동안에도 인증을 유지한다. `connected()` 전체에 갱신을 넣지 않는다. 이 함수는 기존 프로필 transaction 내부에서도 호출된다.
- runner의 프로필 조회는 잠금을 잡기 전에 진행 중 갱신을 기다린다. `RuntimeConnections`의 새 옵션은 선택적으로 두어 기존 합성 테스트·legacy 호출을 유지한다.
- 설정 poll/receipt와 실행의 일반 요청·admission/admission-ack는 이전 인증으로 실패했을 때, 실제 인증이 바뀌었고 같은 기기·조직·방·필요한 agent/epoch임을 확인한 경우만 동일 본문·operation ID로 1회 재수신한다. 기존 lease·입력 허용 확인의 deadline을 늘리지 않는다.
- 인증 불변·다른 scope·취소·기한 만료이면 재시도하지 않는다. 모델 입력·새 질문·새 native session은 재시도 대상이 아니다.
- 회전 중 admission 실패 때문에 허용 확인 없이 입력하지 않는다. 입력 ACK·일시정지 revision·같은 lease 검증을 유지한다.
- 이미 닫힌 설정 journal에서도 인증 만료·권한 상실 이유를 보여 준다. 늦은 이전 인증의 heartbeat 오류가 현재 프로필을 끊지 않게 한다.

### [x] Step 3: 이전 기록을 보존하는 복구 사전 검사
**File**: `cli/remove-local-profile.ts`, `cli/connection-recovery.ts`, `cli.ts`
- `revokeConfiguredProfile()`의 검사 부분을 내부 공통 guard로 분리한다. 기존 `revoke-local`은 같은 검사 뒤 기존 삭제 동작을 계속 수행한다. 복구에서는 삭제 callback을 실행하지 않는다.
- 설정 파일이 없는 기존 등록 프로필은 별도 분기로 처리한다. 기존 `revokeLocalProfile()`과 `guardLocalRemoval()`의 소유 실행 검사·최종 snapshot 검증을 삭제 없이 재사용한다. 실제 legacy 기록의 종결·소유권·매핑을 확인하며, 설정 파일을 인위적으로 만들어 검사를 통과시키지 않는다. 원래 제거 명령의 legacy 삭제 의미는 유지한다.
- 복구 대상은 같은 서비스·조직·방의 실제 만료된 등록 프로필이며 다른 pending·registration이 없어야 한다. 아직 유효한 이전 연결을 새 이름으로 우회하지 않는다.
- 이전 기기 잠금, 현재·보존·legacy 실행 잠금과 native session 잠금, 정확한 owner/epoch/mapping, 종결·정리 증거를 확인한다. `UNKNOWN`, 미완료 설정·입력, 누락·외부·교체된 증거, 살아 있는 manager는 새 pairing 전에 거절한다.
- settings 목록의 세대뿐 아니라 실제 세대 디렉터리와 legacy 목록이 일치하는지 확인한다. 목록 밖 세대·알 수 없는 실행 기록은 검사 범위를 빠져나가게 하지 않고 거절한다. symlink·잘못된 uid/mode·위치·식별자도 거절한다.
- 원래 profile/settings/runtime/history의 바이트를 보존한다. 토큰·기존 native session·AI 설정을 새 기기로 복사하거나 원래 미완료 질문을 재실행하지 않는다. 새 기기의 폴더·모델 설정은 웹에서 다시 선택한다.
- 새 pairing 직전 snapshot 동일성을 검사한다. 기기 잠금은 항상 runtime/session/프로필 잠금보다 먼저 잡는다. 사전 검사와 승인 대기 사이에도 이전 기기 잠금을 유지하되, 이전 runtime/session/프로필 잠금 안에서 새 기기 잠금을 획득하지 않도록 검사와 승인 구간을 분리한다. 완전히 만료된 이전 인증은 다시 사용할 수 없다는 조건을 계속 검사한다.
- 소유 기록 검사가 성공하면 터미널에서 이전 기기의 공개 연결 ID·별칭·방을 안내한다. 사용자가 웹의 같은 ID인 본인 연결을 **연결 취소**한 뒤 터미널에서 완료를 확인해야 새 pairing을 시작한다. 로컬 인증·설정·실행 기록 삭제는 수행하지 않는다. 기존 웹의 권한 검증과 명시적 취소를 사용하고 만료 credential로 서버 취소를 시도하지 않는다.
- 취소는 서버의 활성 기기·AI 연결 한도를 비운다. 활성 AI 연결 2개·기기 10개에서도 이전 기기를 취소한 뒤 새 승인이 가능해야 한다. 다른 기기를 자동 취소하거나 한도를 늘리지 않는다. 서버 취소 뒤에도 기존 공유 이력과 로컬 원본은 보존한다.
- 새 프로필이 이미 등록됐으면 동일 새 기기의 재개만 수행한다. 기존 등록과 scope를 확인하고 이전 세션을 다시 만들어 주지 않는다.

### [x] Step 4: 웹에서 명시적으로 새 승인 선택
**File**: `local-connection-command.ts`, `local-connection-guide.tsx`, `connection-manager.tsx`
- 기본 명령은 기존 `connectionProfile(origin,userId,roomId)`와 동일하다. 사용자가 **새 승인으로 다시 연결**을 고르고 기존 연결 종료를 확인한 경우만 복구 세대를 만든다.
- 공개 UUID인 복구 식별자와 이전 프로필로 새 프로필 hash를 만든다. 새 프로필·이전 프로필·복구 식별자 관계를 CLI에서도 재계산해 검증한다. 서버·사용자·방을 바꿔 재사용하지 않는다.
- 브라우저에는 비밀 없는 이전/현재 프로필 선택 정보만 origin·사용자·방별로 보관한다. 새로고침·재복사는 같은 세대를 사용한다. 다음 명시적 복구는 현재 세대를 이전 것으로 연결한다. 페이지 로드나 실패만으로 세대를 새로 만들지 않는다.
- 다른 탭의 변경은 새 명령으로 자동 교체하지 않고 복사를 막아 사용자가 현재 선택을 다시 확인하게 한다. 저장소 읽기·쓰기·형식 오류는 상태를 알리고 복구 명령을 비활성화한다. 새 명령 준비 중 이전 명령을 복사할 수 없게 한다.
- 기존 기록을 보존하되 새 기기의 AI 설정은 다시 선택한다는 내용을 먼저 안내한다. 자동 웹 승인·자동 터미널 확인은 없다.
- 연결 카드의 공개 ID와 터미널의 이전 ID를 대조해 해당 연결만 취소하도록 안내한다. 같은 별칭을 가진 기기도 구별할 수 있게 하며, 아직 실행 중인 다른 기기는 자동 선택하지 않는다. 서버의 한도 거절은 **이전 연결 취소 여부 확인**으로 안내한다.

### [x] Step 5: 호환되는 명령 전달과 실패 안내
**File**: `local-connection-bootstrap.sh`, `cli/parse-options.ts`, `cli/connect-command.ts`, `cli.ts`
- bootstrap의 기존 5개 인자를 계속 지원한다. 복구의 추가 2개 인자는 이전 프로필·복구 식별자만 받으며, 부분 입력·동일 프로필·잘못된 hash/UUID·위조 관계를 실행 전에 거절한다.
- CLI는 `--previous-profile`, `--recovery-id`를 `connect`에서만 사용한다. 알 수 없는 옵션·중복·누락·다른 명령에 사용한 복구 옵션은 거절한다.
- 다운로드·hash·크기·ustar 경로 검증·직접 CLI 이중 실행 차단·stdin TTY·명시적 계정 확인·signal 전달·종료 증명·실패 파일 보존을 유지한다. 새 기기 승인은 기존 begin/approve/exchange 절차를 그대로 사용한다.
- 끊김·만료·pending 회전·미완료 실행을 구분해 사람이 취할 위치를 안내한다. 오류 JSON의 기존 code 계약을 바꾸지 않고 secret·절대 저장소 경로·native 식별자를 노출하지 않는다. bootstrap catch에도 같은 안내가 적용되는지 검증한다.

### [ ] Step 6: 검증·리뷰·배포·문서 종료
**File**: 관련 테스트, `docs/guides/onboarding-and-settings.md`, `docs/ARCHITECTURE.md`, `docs/DB-SCHEMA.md`, `docs/API-SPEC.md`, `docs/BUSINESS-LOGIC.md`, `docs/BUG-FIXES.md`, `docs/planning/delivery-and-validation.md`
- 아래 회귀를 먼저 실패시킨 뒤 보정한다. 실제 AI 호출은 없이 기존 합성 adapter·소유 로컬 DB/Auth·HTTP·Mac bootstrap fixture를 사용한다.
- 독립 reviewer가 인증 갱신·복구 증거·재시도·모델 입력 횟수 불변과 전체 diff를 검토한다. 필수 지적을 보정하고 영향을 받은 검사만 다시 실행한다.
- 원본 개인 설정·사용자 프로세스·next-env.d.ts를 보존하며 격리 검증 포트와 synthetic 데이터를 정리한다. 커밋 전 root format/check를 수행한다.
- GitHub Flow로 PR을 준비한다. 기존 사용자 병합·배포 승인에 따라 기간 연장 migration을 검증한 클라우드 대상에 적용하고 normal merge 후 Production의 정확한 main SHA·공개 자산 hash·접속을 확인한다. 회사 코드·AI 로그인·개인 설정은 바꾸지 않는다.
- 동작 정본과 버그 기록·검증 정본을 갱신하고 모든 단계·테스트·리뷰가 완료되면 계획을 archive로 옮긴다. 두 Mac 현장 수용은 동료 참여가 필요하므로 실제 검증과 합성 검증을 구분한다.
- DB·API·업무 정본의 인증 유효기간을 7일로 바꾼다. 최근 통신 90초의 접속 판정과 인증 만료를 구분하고 이전 만료 인증의 새 승인 필요를 안내한다.

## Tests

- 신규 기간 migration의 실제 DB 테스트: 새 exchange/rotate 7일, 7일 초과 제약 거절, 이전 만료·철회·기록 불변, 즉시 revoke, 함수 속성·ACL·동일 회전 2분 재수신 유지. 기존 인증과 최근 통신 90초 판정은 서로 분리한다.
- `tests/unit/local-ai-settings-upgrade.test.ts`와 기존 로컬 설치 검증 fixture: 018 미설치·이미 설치·중간 보정 누락·반복 적용·기존 설정 설치 판정과 클라우드 migration manifest 포함을 검증한다. 새 테스트 파일명은 실제 기존 러너에 맞춰 정한다.
- 신규 `connection-renewal.test.ts`: 5분 경계·정상 1회 갱신·동시 대기·3초 이상 응답·pending 동일 재개·결과 유실·2분 경계·다른 pending/registration·만료/취소 거절·중단과 종료 대기. 실제 모델 입력 0.
- `runtime-settings.test.ts`, `cli-settings.test.ts`: idle·폴더 창·실행 중 갱신, nested transaction 없음, poll/receipt 본문·operation ID 동일한 1회 복구, 인증 불변·scope 변경·권한 상실 거절, 늦은 heartbeat, 닫힌 journal의 오류 표시.
- `workflow-runner.test.ts`, `input-admission.test.ts`: 일반 요청·admission/ACK 회전 경쟁, pause revision·agent/epoch·lease·deadline 유지, ACK 미확인 시 provider 입력 0, 정상 경합 전후 provider 입력 횟수 동일.
- 신규 `connection-recovery.test.ts`, 기존 `cli-settings.test.ts`: 현재·보존·legacy/orphan 세대, **설정 파일 없는 실제 legacy 프로필**의 성공·거절·바이트 보존, native 잠금·owner·mapping 검증, UNKNOWN/미완료/없는 증거/살아 있는 manager 차단, 원본 모든 바이트 보존, 기존 revoke-local의 제거 의미 유지, 승인 대기 중 이전 manager 경쟁 차단.
- `connect-command.test.ts`, `cli-options.test.ts`: 기본 연결·만료 미등록 pairing·동일 새 프로필 재개, 새 웹 승인·터미널 확인 유지, old/new/nonce 관계 위조·외부 scope·부분 옵션·다른 명령 거절.
- `tests/unit/local-connection-{command,bootstrap,distribution}.test.ts`: 기존 5개/복구 7개 인자·쉘 입력·hash/경로·다운로드 상한·중복 main 방지·종료 증명·신규 JS 포함·정제 오류. 사용자 실패 파일은 건드리지 않는다.
- `tests/e2e/device-workspace-binding.spec.ts`: 명시적 새 승인 선택, 같은 이름 기기의 ID 대조·해당 기기 취소, 취소 전 새 코드 발급 없음, stale 명령 비활성화, origin/user/room 분리, 새로고침·재복사·탭 변경·storage 손상/읽기/쓰기 실패, 자동 승인·모델 호출 없음.
- 소유 로컬 DB/HTTP 통합: 기존 기기에 실제 rotate 후 old credential 거절/new credential 성공, 새 기기 begin/approve/exchange와 foreign owner/observer 거절, fresh approval 없이 만료 인증 복구 불가. **활성 AI 연결 2개·기기 10개**에서 이전 기기만 취소해 한도를 비운 뒤 새 승인·AI 설정 확정 성공과 원본 바이트 보존을 확인한다. 공유 클라우드 DB의 테스트 데이터는 만들지 않는다.

## Risks

- 회전의 HTTP 요청을 프로필 잠금보다 늦게 기다리면 기존 실행이 2초 잠금 경쟁으로 실패한다. coordinator 대기는 잠금 밖에서 하고 같은 진행 중 작업만 공유한다.
- 갱신과 승인 복구를 섞으면 만료·취소 인증을 우회할 수 있다. 새 회전은 유효 인증, 완전 만료 복구는 새 웹 승인과 종료 증거를 각각 요구한다.
- 새 이름만 생성하면 미완료 AI 입력을 우회할 수 있다. 이전 기록과 실행 소유권 검사 전에 새 pairing을 시작하지 않는다.
- 브라우저의 복구 UUID는 소유권 증거가 아니다. CLI 증거·서버의 현재 사람 권한·사용자의 터미널 확인을 모두 유지한다.
- 다중 탭·원본 파일 교체·중단·부분 쓰기는 새 입력으로 덮지 않는다. 같은 journal만 복구하고 불명확한 결과는 보존·차단한다.
- 7일 인증은 접속 여부를 의미하지 않는다. 인증이 남아 있어도 최근 통신이 없으면 끊김으로 표시하며, 연결 취소와 권한 상실은 만료까지 기다리지 않고 즉시 거절한다.

## Verification

- Node 24: connector typecheck/build/test, web unit·e2e typecheck, lint, Production build와 local-connection distribution 검증.
- 격리 로컬 통합·기기 browser 검증과 synthetic bootstrap. 통과 결과는 동일 입력이면 재사용한다.
- Root `npm run format`, `npm run format:check`, `git diff --check`.
- fresh-context 독립 계획 검토와 구현 검토. 계획은 승인됐으며 단계 표시와 소스·관련 검사·리뷰를 대조한다.
- 최종 main·Vercel Production SHA·공개 manifest/code/bootstrap hash, 개인 파일 hash·프로세스·검증 데이터 정리 확인.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 계획 승인 | REQUIRED | APPROVED | 2026-10-12 사용자가 계획대로 끝까지 구현·검증·배포하도록 승인했다. 메뉴 변경을 병합한 최신 main `01765e3`에서 새 작업 브랜치로 실행한다. |
| 1차: 만료 등록이 활성 한도에 누적 | HIGH | ACCEPTED | 서버 등록 취소와 로컬 기록 보존을 분리했다. 기존 웹에서 해당 ID만 명시적으로 취소한 뒤 새 코드를 발급하며, 활성 AI 2개·기기 10개 경계의 통합 검사를 추가했다. |
| 1차: 설정 없는 legacy 복구 누락 | HIGH | ACCEPTED | settings 유무에 따른 검사 분기와 삭제 없는 기존 legacy guard 재사용, 실제 무설정 legacy fixture를 명시했다. |
| 1차 부연: 기기별 취소가 새 승인 대기까지 취소 | INFO | REJECTED | 현재 cancel의 조건은 `d is null or device_id=d`다. 기기별 revoke는 non-null 이전 ID를 전달하므로 아직 device ID가 없는 새 pairing은 이 조건에 해당하지 않는다. 다만 한도를 확보하고 복구 순서를 단순하게 하기 위해 이전 취소를 새 발급 전에 수행한다. 004:154,186·006:407. |
| 2차: 발급 본체와 wrapper 구분·로컬 설치 포함 | REQUIRED | ACCEPTED | 실제 발급 본체 `connector_010_runtime`만 변경하고 SQL018을 로컬 적용·설치 판정에 포함한다. 기존 설정 충돌 wrapper는 유지한다. |
| 독립 계획 검토 | REQUIRED | PASS | 2차 최종 C0/H0/M0/L0/INFO0. 1차 갱신·재시도·증거·명령 호환 검토를 재사용하고 한도·무설정 분기·7일 발급·로컬 설치 보완을 검토했다. 일시적인 reviewer 모델 capacity 오류를 보존하고 같은 미완료 검토를 이어가 최종 판정을 받았다. |
| 구현 중: 기간 변경 이외의 runtime 본문 변화 | HIGH | ACCEPTED | 실제 로컬 PostgreSQL의 발급 본체가 현재 SQL010과 동일함을 대조했다. 생성한 SQL018의 runtime 두 줄 변경과 잘못된 기존 body hash는 적용 전에 source guard가 거절했다. 현재 SQL010을 그대로 보존하고 발급 간격 두 곳만 바꿔 보정했으며 관련 단위108개와 실제 DB/HTTP3개가 통과했다. 최초 거절은 transaction rollback으로 보존했다. 클라우드는 아직 변경하지 않았다. |
| 구현 1차 H1: 적용 전 검사에서 신규 기능 요구 | HIGH | RESOLVED | 기존 네 기능의 설치 여부와 018 적용 후 7일 기능 판정을 구분한다. 실제 DB에서 생성한 upgrade SQL을 실행해 전환을 검증한다. |
| 구현 1차 H2: 정상 요청에 이전 lease 기한 적용 | HIGH | RESOLVED | 첫 요청은 현재 유효 lease·절대 요청 기한을 사용하고 인증 재시도는 원래 lease 제한도 유지한다. 인증 조회 대기 중 lease 연장 경합을 재현한다. |
| 구현 1차 H3: 설정 변경이 갱신 대기를 생략 | HIGH | RESOLVED | transaction 밖의 withIdle·bootstrap에서 공유 갱신을 기다린 뒤 연결을 확인한다. 느린 회전과 설정 변경의 경합으로 UNKNOWN 발생을 재현한다. |
| 구현 2차 R2-1: 보호 대상 밖의 현존 매핑 | HIGH | RESOLVED | current/retained의 보호되는 pointer 하나와 현존 mapping을 일대일로 대조한다. runtime 잠금 안에서 소유권·epoch·root/native를 검증하며 누락·추가·중복·불일치 회귀를 먼저 실패시킨 뒤 보정했다. 기존 H1–H3은 2차 reviewer가 모두 해소 확인했다. 이 복구 지적은 첫 구현 검토이므로 연속 반복 설계 실패가 아니다. |
| 최종 독립 구현 검토 | REQUIRED | PASS | 3차 C0/H0/M0/L0/INFO0. R2-1 해소와 추가 fixture·DB/HTTP 복구·문서를 검토했다. 동일 운영13파일과 SQL018·갱신/재시도·기존 H1–H3의 이전 검토를 재사용했다. 검토 당시 미완료인 배포·보관은 Step6 완료 뒤 기록한다. |
