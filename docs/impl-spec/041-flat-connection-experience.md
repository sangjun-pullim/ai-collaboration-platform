---
status: active
date: 2026-10-15
risk-surface: auth
---
> NOTE: 구현 계획이며 현재 코드의 증거가 아니다. 완료 후 보관한다.

# 연결 재개 보정과 단계별 연결 화면

## Context
사용자가 040 완료 화면의 중첩 접기·반복 설명·불분명한 다음 행동을 거부하고 전면 개선을 승인했다. 기존 승인·연결 권한을 유지하면서 같은 작업을 보정한다. 추가 AI 호출·개인 기록 삭제·DB 변경은 하지 않는다.

## Affected Files
1. `packages/local-connector/src/cli/connection-recovery.ts` — 이미 승인된 복구 대상의 미완료 설정을 일반 연결과 같은 manager에 인계한다.
2. `scripts/local-connection-bootstrap.sh` — 실패 코드·배포 해시·제한된 소스 위치를 0600 진단 파일에 기록한다.
3. `src/features/device-binding/connection-manager.tsx` — 평면 연결 단계, 현재 단계 우선 배치, 별도 기기 관리.
4. `src/features/device-binding/local-connection-guide.tsx` — 실행 안내와 복사 버튼 우선, 부가 설정은 명시적인 버튼으로 접근.
5. `src/features/connection-setup/setup-status.tsx` — 중복 보고 제거, 실패 원인과 다음 행동을 한곳에 표시.
6. `src/features/runtime-settings/runtime-settings-form.tsx` — AI·폴더와 모델 선택 단계, 적용 후 설정 요약/변경 동작.
7. 위 기능의 기존 unit tests 및 `tests/e2e/device-workspace-binding.spec.ts`, `tests/e2e/owner-local-ai-setup.spec.ts`의 details 의존 helper/선택자를 새 버튼·영역으로 갱신한다.
8. 관련 guides/frontend/bug/delivery 문서.

## Affected Dependents
- `src/app/app/connections/page.tsx`의 ConnectionManager, RuntimeSettingsForm의 SettingsController, guide의 SetupController: 공개 인자·서버 계약 유지.
- `tests/unit/connection-navigation.test.ts`, `local-connection-guide.test.ts`, `runtime-settings-view.test.ts`: UI 구조·focus·scope 변경 검증.
- `packages/local-connector/tests/connection-recovery.test.ts`, `connect-command.test.ts`, `tests/unit/local-connection-bootstrap.test.ts`: 소유·잠금·정리와 실행 증거 유지.
- `tests/e2e/device-workspace-binding.spec.ts`, `owner-local-ai-setup.spec.ts`: 기존 폼 이름과 승인/설정 동작 유지.
- 문서 사본 탐색: `docs/FRONTEND-ARCHITECTURE.md:44,50`, `docs/guides/onboarding-and-settings.md:107`, `docs/planning/delivery-and-validation.md:40`의 기존 펼침/단계 설명(this repo)을 갱신한다. archive는 역사이므로 유지. 검색은 이 화면 관련 문서와 소비자를 대상으로 하며 외부 문서 소유를 선언하지 않는다.

## Implementation Steps
### [x] Step 1: 연결 복구와 진단
- 두 재현 테스트에서 승인된 복구 대상의 미완료 설정이 assertIdle에 막히는 것을 확인한다. 대상도 readConnectSettingsOwner를 사용하되 이전 기록 검증·scope·credential·lock은 유지한다.
- 실패 원문/인자/비밀값 없이 code 해시, 허용된 src 상대 위치 최대8개, 시간·버전을 JSON으로 보존한다. 진단 기록 실패가 원래 오류 처리를 바꾸지 않는다.
- 실제 bootstrap+CLI 회귀 검사에서 터미널 중단 후 cleanup 증거가 VERIFIED인데 Bash가130을 반환하는 경우를 재현했다. 중단 요청·실제 child 종료·정확한 종료 증거가 모두 있는130/143만 정상 정리로 취급하고 그 외 오류/불명확 상태는 보존한다.
### [x] Step 2: 연결 화면 재구성
- 중첩 details를 제거한다. 첫 단계는 연결 전 복사/터미널 실행/승인 안내를 보여준다. 최근 통신이 있으면 단계 요약과 설정을 보여준다.
- Mac 연결 명령과 기기 승인은 다른 상태다. 명령 보고로 인증 완료나 설정 완료를 추론하지 않는다.
- 승인 fragment와 수동 코드 입력 접근, 명시적 checkbox 확인을 유지한다. 문제가 생겼을 때만 복구·기기 관리·원문을 열 수 있다.
- clipboard 실패 시 직접 복사 영역을 보이고 focus/select한다. #mac-connection/#ai-settings 이동을 유지한다.
- AI·폴더 선택은 현재 단계의 폼으로 표시한다. 모델은 catalog 확인 후에 표시하고 미완료 요청 동안 변경 잠금을 유지한다. 적용 후에는 설정 요약과 채팅 시작, 명시적 설정 변경을 보여준다.
- 실패 원인과 가능한 행동을 묶는다. RUNTIME_BUSY로 살아 있는 프로세스를 단정하지 않는다.
### [ ] Step 3: 검증·리뷰·배포
- 상태별 테스트와 실제 브라우저의 데스크톱/모바일 렌더링을 확인한다. 독립 리뷰 후 문서 갱신·커밋·PR·승인된 main 병합·배포를 진행한다.

## Tests
- 이미 승인된 복구 대상의 미완료 설정: 한 세대/여러 세대 재연결, 기존 파일 불변, 새 승인 및 AI 실행0.
- 진단 파일: 0600, bounded src frames, code hash, raw secret/message/path 배제.
- 화면: 처음 연결에서 기본 행동만 보임, 승인 링크 입력 유지, 연결 후 명령은 부가 동작, 모델 전 단계 이동, 적용 후 변경 접근, 취소/미확정 잠금 유지.
- 직접 복사 실패 대체와 scope 변경 시 기존 명령 무효화 유지.
- 실제 브라우저: 새 연결/실패/폴더/모델/적용/취소 대기, 1440px와390px, 가로 넘침 없음, 기본 화면에 details 없음.

## Risks
- 서버 관찰과 실제 연결을 혼동하지 않도록 기존 판정·authority separation을 유지한다.
- UI 정리는 요청 취소·실행 결과 확인 규칙을 완화하지 않는다.
- 테스트는 합성 상태로 수행한다. 사용자 로컬 credential의 실제 서버 거절은 별도 진단이며 UI 변경으로 해결했다고 주장하지 않는다.

## Verification
- Node24: format/format:check, typecheck, lint, web tests, connector build/해당 테스트, production build.
- 브라우저 상태별 interaction/screenshot; 진단·소유 경계 독립 reviewer.
- 배포 READY와 공개 manifest/bootstrap/code 무결성 확인.

## Review Notes
사용자의 기존 끝까지 구현·검증·배포 승인과 이번 전면 UX 보정 요청을 적용한다. frozen040은 수정하지 않는다.

독립 계획 리뷰: CRITICAL/HIGH 없음. MEDIUM E2E helper 범위 누락을 수용해 변경 파일에 명시했다.

구현 리뷰1의 HIGH(승인 fragment의 존재하지 않는 버튼 선택)와 MEDIUM(재적용 후 변경 폼 유지)을 수용했다. 명령 검사를 fragment 진입 전에 수행하고, 새 폴더 요청 시 편집 상태를 초기화했다. 독립 리뷰2에서 두 지적 해소와 종료 증거·진단 정보 보호 PASS를 확인했다. 추가 테스트 독립 리뷰는 No issues found이며 전체695/695 결과를 확인했다. 인증·scope·진단 구현 리뷰의 변경 없는 범위는 재사용한다.

웹 단위695/695, 연결 복구·명령107/107, build/typecheck/lint/format/check 통과. 실제 DB/Next 기기·명령 브라우저12/12 통과. 새 연결·실패·폴더·모델·적용·취소 대기의 PC1440px/모바일390px 화면을 직접 확인했다. 실행 중지의 valid/missing/corrupt proof와 소유한 중단 요청 없음은 별도 회귀 테스트로 확인했다. 실제 AI 입력0회, 사용자 연결 파일 수정0회다.
