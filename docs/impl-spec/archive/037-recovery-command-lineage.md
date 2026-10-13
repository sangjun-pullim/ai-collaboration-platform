---
status: done
date: 2026-10-13
risk-surface: auth, permission
approval: existing-034-corrective-rework
---
> 이 문서는 계획이며 현재 코드의 증거가 아니다. 034에서 승인한 웹 명령·기기 재승인의 실패 보정이다. 기존 복구·승인·검증·병합·배포 승인을 재사용한다. 보관된034는 수정하지 않는다.

# 실행하지 않은 복구 세대가 끼어 있는 Mac 연결의 복구

## Context

사용자 명령의 새 프로필과 직접 이전 프로필이 이 Mac에 모두 없다. 같은 방의 실제 연결 기록은 다른 세대에 남아 있다. 웹 nextConnectionSelection은 준비할 때마다 세대를 추가하지만 명령은 마지막 부모만 전달한다. 따라서 중간 명령을 실행하지 않으면 이전 기록을 찾지 못하고 expired(undefined)가 FORBIDDEN을 내어 권한 문제로 잘못 안내한다. 여러 번 명령 준비·재복사·실행 지연·다른 Mac의 미사용 선택을 제품 경계에서 검증한다.

기준코드 `9655d4db8bffaae1604b42207cf77f24f5d8d06c`. 실제 로컬 파일과 제한된 읽기 전용 방 멤버 조회로 확인했다. 인증·기록 원문과 토큰은 출력하거나 복사하지 않았다. 이번 보정은034의 승인된 운영 경로 중8개를 사용한다. 새 DB·웹 API·회원 소유권 정책은 추가하지 않는다. 구현 리뷰1차에서 보존 파일의 귀속과 등록 직전 재검사가 빠진 경로를 확인해 같은 승인 범위의 후속 보정으로 반영한다.

## Affected Files

1. `src/features/device-binding/local-connection-command.ts` — 기존에 검증한 전체 ConnectionSelection을 복구 명령의 추가 인자로 전달한다. 기존5개 및7개 인자의 의미를 유지한다.
2. `scripts/local-connection-bootstrap.sh` —8개 인자의 복구 선택 JSON을 크기 제한 후 선택 옵션으로 전달한다. 기존7개 관계 검증·다운로드 hash·임시 파일 보존을 유지한다.
3. `packages/local-connector/src/cli/parse-options.ts` — 선택 옵션의 정확한 형태·최대32세대·16KiB·각 hash 연결과 마지막 기존 인자를 확인한다. 다른 명령이나 단독 옵션은 거절한다.
4. `packages/local-connector/src/cli/connection-recovery.ts` — 전달된 계보 안에서 실제로 존재하는 가장 가까운 부모를 찾는다. 누락된 부모의 설정·런타임·catalog·잠금·보존 기록은 버리지 않는다. 원래 만료된 연결의 검사·보호·새 승인 흐름을 유지한다.
5. `packages/local-connector/src/cli/connect-command.ts` — 선택형 계보 입력과 단계별 오류 안내를 연결한다. 기존 인터랙티브 확인과 scope 검사를 유지한다.
6. `packages/local-connector/src/cli.ts` — 계보상 현재 연결이 유효하면 같은 실제 프로필로 기존 연결 경로를 사용한다. 계보 전체가 한 번도 실행되지 않았으면 기존 기본 프로필의 첫 승인으로 연결한다. 만료된 실제 부모는 기존 복구를 사용한다.
7. `src/features/device-binding/local-connection-guide.tsx` — 준비한 세대와 실제 실행 기록은 다름을 안내한다. 새 연결은 기존 기록 검사 또는 현재 연결 재사용으로 진행하며 복사/다른 탭 보호는 유지한다.
8. `packages/local-connector/src/state-store.ts` — 새 만료 pairing 보존 파일은 프로필을 파일명에 포함해 귀속을 구분한다. 원문 bytes와 내구 저장·잠금 검사는 유지하고 기존 UUID 전용 파일은 바꾸지 않는다.

## Affected Dependents

- `StateStore`, `SettingsStore`, `RuntimeStore`, `ClaudeCatalogStore`: 이름·OS 소유자·모드·symlink·link수·기기/런타임/native 잠금·원래 기록 보존 검사를 유지한다.
- `prepareConnection`의 기존 직접 테스트와 bootstrap: 계보가 없는 기존 명령은 원래 의미로 동작한다. 없는 부모를 무조건 새 프로필로 우회하지 않는다.
- `ConnectionSelection`은 기존 version1·32세대 구조를 유지한다. 새 옵션은 CLI 내부 계약이며 공개 서버 요청·응답과 migration은 변경하지 않는다.
- 같은 규칙을 설명한 이 저장소 `docs/guides/onboarding-and-settings.md`의 새 승인 절차, `docs/FRONTEND-ARCHITECTURE.md`의 웹 명령, `docs/planning/delivery-and-validation.md`의 검증 상태를 갱신한다. 검색 범위src/packages/scripts/tests/docs, 보관된034와 과거 기록은 유지한다.

## Implementation Steps

### [x] Step1: 실패 재현과 계보 전달

웹에서 세대를 여러 번 준비하고 중간 명령은 실행하지 않은 fixture를 먼저 실패시킨다. 명령→bootstrap→CLI 경계를 실제 생성 문자열로 검사한다. 현재 부모 옵션과 전체 계보의 마지막 관계가 다르면 다운로드/등록 전 또는 CLI 입력 검증 단계에서 거절한다. 문자열은 shell 인자로만 전달하고 코드로 평가하지 않는다.

### [x] Step2: 실제 기록 선택과 기존 보호 재사용

대상에 pairing·pending·credential이 있는지 먼저 분류한다. 현재 대상에 기록이 있으면 그 기록을 보존하고 원래 복구를 유지한다. 명령의 직접 부모와 실제 보호할 부모를 분리한다. hash 검증에는 원래 마지막 이전/복구ID/대상을 사용하고, 로컬 보호에는 검증된 계보에서 선택한 실제 부모만 사용한다. 실제 부모의 origin·org·room이 다르거나 손상됐다면 더 옛 부모로 우회하지 않는다.

예비 읽기로 가장 가까운 실제 부모를 찾되 이는 실행 권한이 아니다. 실제 선택한 부모의 기기 잠금 아래에서, 건너뛸 누락 세대의 기기 잠금을 계보의 오래된 쪽부터 새 쪽으로 잡는다. 원래 만료 복구 순서는 **실제 부모 기기 → 미실행 중간 기기 → 원래 런타임/세션 검사 및 반환 → 새 대상 기기**다. 재사용/첫 승인에서는 **사용할 프로필 기기 → 나머지 누락 세대 기기** 순서로 잡는다. 선택을 잠금 아래에서 재검증하고 모든 건너뛴 기기 잠금을 사람의 확인과 연결 준비가 끝날 때까지 유지한다. 기존 준비 함수의 같은 기기 잠금을 재획득하지 않도록 보호한 private 작업을 분리하며, 외부에서 임의로 잠금 검사를 생략하는 boolean 옵션은 만들지 않는다. 관리 루프는 준비의 잠금들이 반환된 뒤 기존 방식으로 원래 기기 잠금을 획득한다.

원본 프로필이 없는데 runtime/settings/catalog·잠금·알 수 없는 파일이 있으면 등록 전에 차단한다. 실패한 최초 준비가 만든 `settings/<profile>/` 및 그 아래 빈 `generations/` scaffold만 허용한다. 빈 runtime root 디렉터리는 strict store 검사를 통과한 경우만 허용한다. catalog 디렉터리나 identity 파일의 존재는 비어 있어도 차단한다. 잠금은 기존 안전한 기기 잠금 acquire/recovery로 처리하고 그외 프로필/런타임/세션 잠금은 부재로 간주하지 않는다.

파일 부재를 ‘한 번도 실행하지 않음’이라고 단정하지 않는다. `.expired-pairing-<UUID>.json` 보존 파일에 프로필 귀속이 없다는 기존 제약을 고려한다. 안전하게 읽어 origin·scope가 이번 연결과 다름을 증명한 보존 파일만 관련 없는 기록으로 처리한다. 같은 origin과 같은/불명 scope, 읽기 실패·손상·unsafe 저장 등은 누락 세대의 귀속을 확인하지 못하므로 차단한다. 기록을 삭제·변환하거나 다른 profile로 옮기지 않는다. 첫 승인 분기는 이 검사와 각 이름 공간 보호 아래 등록·실행·귀속 불명 기록이 없음을 확인한 경우만 사용한다.

유효한 부모 연결의 재시작은 기존 연결과 동일 프로필·동일 기기·동일 설정으로 진행하며 새로운 세션·등록·AI 질문을 만들지 않는다. 첫 실행이 전혀 없는 계보는 기존 기본 프로필의 첫 연결로 처리한다. 유효성 판단과 실제 잠금 안의 준비에서 다시 검사해 경쟁을 거절한다. 만료 부모는 기존 expired/보존/원래 기기 해제 확인과 대상 프로필 잠금을 적용한다. 기존 UNKNOWN·원래 예산·도구·실행 기록은 보존한다. 어떤 단계도 질문을 자동 재실행하지 않는다.

### [x] Step3: 제품 경계 검증과 독립 리뷰

Node24로 단위·연결기·타입·lint·format/check·격리 빌드를 수행한다. 기존 HTTP fake fixture와 실제 bootstrap/PTY를 사용해 첫 승인·중간 미실행·유효 연결 재사용·만료 기록 복구·다른 scope·orphan·live lock·미확인 기록 보존·같은 명령 재시도를 자동 검증한다. 실제 AI 입력0회, 개인 원본 수정0. worker sandbox에서 macOS 브라우저/PTY가 막히면 반복하지 않고 권한 있는 부모 실행 환경에서 검사한다.

코드 `024eb7edee46adf5f5f6af7a25187e472aeacb0b`: 웹594/594, 연결기1031/1031(동시4), 보정 집중84/84를 통과했다. 수정 전 계보 전달·CLI 옵션과 중간 pairing2개·확인 대기 중 변화4개를 실패시켰다. 실제 생성 명령→bootstrap→CLI→Mac PTY→가짜 HTTP를 프로젝트 단위 검사에 보존하고 첫 승인·유효 연결·만료 복구 각각 같은 명령 재실행까지6번 자동 검증했다. 실제 Native 브라우저 열기만 가짜 실행기로 대체했고 기본 저장 경로는 자식의 합성 HOME으로 격리했다. 실제 AI 입력0회·개인 원본 수정0. root 사용자 next-env.d.ts는 원래 hash `0f70629890b72a0a82e91972cc032c04b658b26c265373cb711cf576bfbf8fcc`를 유지했다. 격리 production/distribution build·웹/E2E/통합 TypeScript·연결기 타입·lint·format/check·diff 검사도 통과했다. 첫 전체 병렬 연결기 검사의 기존 pending 준비 검사1개는15초 시간 제한으로 실패했고, 동시4로 부하를 제한한 두 번의 전체 검사에서1027/1027과1031/1031이었다. 실패 기록은 보존하고 다른 운영 동작은 변경하지 않았다.

### [x] Step4: 병합·운영 반영과 보관

독립 reviewer가 인증/소유권/기존 잠금/호환성과 오류 재현의 해소를 확인한다. 기존 승인으로 일반 PR 병합·배포·배포물 hash와 정확한 main 검증을 완료한다. 완료한 계획은 archive로 옮기고 소유 브랜치·worker 터미널만 정리한다.

[PR25](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/25)의 검토 head `f8e2ff781828d8fd9e3af956c4f97001976347af`가 Preview SUCCESS 후 일반 병합됐다. main `11bc182a983f8fd43970a56a1fbd49536d4dbe44`의 Production `dpl_3DSKQYHzsNR2TjrjqtYTbvALidKB`가 READY이고 공개 alias를 확인했다. 2026-10-13T06:43:27Z의 공개9개 검사에서 입장·인증 redirect·manifest·bootstrap·connector·미인증 API 거절을 통과했다. 배포 connector는168960bytes, bootstrap은9928bytes이다. code의 gzip OS byte19(macOS)/3(Linux)를 제외한 tar 원문이 검증한 빌드와 일치했고 bootstrap hash도 일치했다. 완료 계획을 archive에 보관한다. 후속 문서 커밋은 같은 운영 코드·배포물 검증을 재사용한다.

## Tests

- 웹 여러 세대 준비·새로고침·재복사에서 같은 전체 계보 전송. 변조·scope 변경·길이·hash 불일치·legacy 명령 호환.
- 실제 부모+미실행2세대: 적절한 원래 보호/승인 경로를 사용하고 파일 bytes를 보존한다.
- 실제 유효 부모: 원래 프로필 재사용, 새 begin/exchange 없음, 살아 있는 manager를 종료하거나 우회하지 않음.
- 모두 미실행: 기본 첫 승인. orphan 파일/설정/잠금/기록/변경이 있으면 등록 전에 차단한다.
- 여러 실제 부모: 가장 가까운 부모의 오류를 더 옛 부모로 우회하지 않음. origin/org/room 불일치 거절.
- UNKNOWN/원래 기록/현재 credential/pairing/pending 정상 회귀 및 경쟁 중 namespace 변화 차단.
- 원본 프로필 없는 보존 pairing 기록은 같거나 불명 origin/scope이면 차단하고, 안전하게 확인한 다른 origin/scope 기록만 무관 처리한다. 빈 catalog·알 수 없는 scaffold·낯선 잠금·사람 확인 대기 중 중간 세대 실행을 거절한다.
- 생성한 명령→실제 bootstrap→실제 CLI→가짜 HTTP·PTY 왕복. AI 입력 없이 준비/승인/등록/중단·재실행과 정리까지.

## Risks

구현 리뷰 보정: 새 보존 파일 `.expired-pairing-<profile>-<UUID>.json`은 안전한 원문 검사 후 해당 profile에만 귀속한다. 선택한 실제 프로필의 정상 재시작에서 생성한 보존 파일은 누락 세대의 파일로 오인하지 않는다. 누락 세대에 귀속한 파일과 기존 UUID 전용의 같거나 불명 origin/scope는 계속 차단한다. 확인 이후와 새 begin/exchange 직전에 선택·누락 세대·보존 기록을 잠금 아래 재검사한다. 실제 명령·Mac PTY·가짜 HTTP 검사는 프로젝트 테스트에 보존한다.

구현 리뷰2차의 새 회귀 보정: 중간 pairing 세대가 승인된 보존 후 잠시 원본 파일이 없는 동안에는 잠금 아래 선택한 프로필을 유지한다. 초기의 정확한 pairing 원문, 준비 중 새로 생성한 귀속 보존 파일 한 개, 그 파일의 안전한 identity·bytes, 원본을 제외한 설정·runtime·catalog 이름 공간의 불변성을 모두 확인한 경우만 인정한다. 기존 archive-only 기록으로 재접속하거나 다른 부모로 이동하지 않는다. 누락 세대·공통 보존 기록과 등록 직전 검사는 계속 적용하며 새 public skip 옵션을 만들지 않는다.

- 누락을 무조건 새 승인으로 바꾸면 미확인 기록을 우회할 수 있다. 검증된 계보 내의 실제 기록만 선택하고 orphan·잠금·scope·변경은 fail closed한다.
- 현재 유효 연결을 다른 프로필로 옮기면 설정/실행을 잃는다. 원래 프로필을 그대로 사용하며 live manager를 우회하지 않는다.
- 긴 JSON과 따옴표는 shell 소스로 실행하지 않는다. bounded argv만 사용한다.

## Verification

웹 `npm test`, 연결기 `npm --prefix packages/local-connector test`, 타입·lint·root format/check, 사용자 next-env를 보존하는 격리 `npm run build`.
실제 명령/PTY와 mock HTTP 통합·웹 상태 검사, 개인 파일의 before/after hash, 독립 계획·구현 리뷰. 공개 주소와 새 bootstrap/connector 배포물, 정확한main Production READY 확인.

## Review Notes

계획1차 C0/H2/M1을 보정했고 독립2차 검토에서 세 지적의 해소와 C0/H0/M0을 확인했다. 검토 세션 `01a133c6-c10c-7df0-af7c-606024009d39`, gpt-6.1-sol/xhigh/read-only. 기존034 기능의 동일 경로에서 발생한 실패 보정으로 승인 범위를 재사용한다. 선택을 바꾸는 소유권·외부 API 변경이 필요하면 구현을 멈추고 별도로 확인한다.

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 누락 세대의 전후 검사만으로 동시 pairing 차단 불가 | HIGH | ACCEPTED | 실제 부모부터 누락 세대·새 대상 순서의 기기 잠금과 준비/확인 전체 보호를 명시했다. |
| 원본 파일 부재로 최초 실행을 단정하고 귀속 불명 expired pairing을 무시함 | HIGH | ACCEPTED | 귀속 불명 보존 기록을 차단하고 허용한 scaffold 경로만 인정한다. 빈 catalog는 차단한다. |
| hash의 직접 부모와 보호할 실제 부모를 혼용 | MEDIUM | ACCEPTED | 기존 명령 관계를 유지하고 보호용 실제 부모를 분리하며 대상 journal을 먼저 분류한다. |
| 만료 pairing의 새 archive가 누락 세대의 사후 검사와 충돌 | HIGH | ACCEPTED | 새 파일명에 profile을 포함하고 원문 bytes를 유지한다. 기존 UUID 전용은 계속 보수적으로 검사하며2차 구현 리뷰에서 해소 확인했다. |
| 확인 대기 중 변화가 begin·exchange 뒤 차단됨 | HIGH | ACCEPTED | 등록 직전 검증을 연결하고 만료 복구의4개 실패 재현·보정 검사를 추가했다.2차 구현 리뷰에서 해소 확인했다. |
| 유효 연결 재사용에도 기존 기기 취소 안내 | MEDIUM | ACCEPTED | 취소를 만료 연결의 새 승인에 한정했다.2차 구현 리뷰에서 해소 확인했다. |
| 중간 pairing의 보존→새 승인 중 선택한 프로필을 잃음 | HIGH | ACCEPTED | 정확한 새 귀속 archive와 설정·runtime·catalog 증거로 잠금 아래의 자기 전환만 인정한다. 기본 프로필 없는/유효한 경우와 변경 증거 거절4개를 추가하고3차 구현 리뷰에서 해소 확인했다. |

구현 독립 리뷰1차 C0/H2/M1(`01a133d9-b2fc-7f92-8346-dbe08f5366ef`)의 세 지적은2차에서 해소 확인했다.2차의 신규 HIGH1(`01a133e7-d8d2-75b0-bb7f-375ff24c7e52`)은 승인된 중간 pairing 전환의 선택 손실이었다.3차(`01a133f4-48e5-79b0-8e72-de0591b194bd`)가 해당 보정·테스트·제출 patch 일치를 확인해 C0/H0/M0으로 통과했다. 변경 없는1·2차의 권한·기존 UNKNOWN·잠금·갱신·CLI 검토는 재사용했다. 모든 완료 CLI 워커와 reviewer 보고를 저장한 뒤 해당 Orca 터미널만 닫았다. 기본 브랜치 병합·배포는 Step4에서 확인한다.
