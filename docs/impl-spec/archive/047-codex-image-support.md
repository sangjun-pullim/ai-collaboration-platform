---
status: done
date: 2026-10-19
risk-surface: permission
---
> NOTE: This is the plan, not a description of current behavior. Archived 046 remains frozen.

# Codex 이미지 입력 검증과 활성화

## Context

046의 승인 범위였던 Codex 이미지 입력을 마무리한다. 사용자는 실제 검증과 구현 완료를 재요청했다. 기존 승인된 Codex 실제 입력 최대1회는 아직 사용하지 않았다. 전역 Codex0.163.0을 변경하지 않고 임시 npm prefix의 공식0.159.1을 PATH로 선택해 현재 생산 transport와 기존 로그인·설정으로 검증한다. 모델 입력 없는 capabilities 검사는0.159.1에서 통과했다.

## Affected Files

- `packages/local-connector/src/codex-adapter.ts`: 검증된 버전의 capability와 이미지 사전 검사.
- `packages/local-connector/src/workflow/image-file.ts`: 요청별 소유 파일 기록과 재시작 후 정리.
- `packages/local-connector/src/workflow-runner.ts`: 요청별 파일 생성, 확정 종결 후 정리 및 compaction 전 재시도.
- 관련 connector tests, 현재 동작의 문서와 검증 현황.

## Affected Dependents

- `workflow-runner.ts`의 prepareAttachment/refreshReady/poll/claim은 adapter capability를 사용한다.
- `runtime/record-schema.ts`와 기존 Codex native ACK·terminal/ownedTurns 계약은 유지한다. Claude 전용 nativeIntent 계약을 Codex에 억지로 적용하지 않는다.
- 파일 소유 정보는 별도 private metadata로 저장한다. 서버 DB/API와 기존 runtime record 형식은 변경하지 않는다.
- `docs/planning/delivery-and-validation.md`의 Codex 비활성 문구1곳(this repo)을 갱신한다. 정본 API/프런트 문서의 이미지 지원 범위도 확인한다. archive046은 역사로 보존한다.

## Implementation Steps

### [x] Step 1: 실제 Codex 이미지 검증

- 공식0.159.1을 별도 임시 위치에 준비한다. 합성 저장소·합성 이미지에만 입력 최대1회. 이미지 안의 식별 문자열을 질문 텍스트에 넣지 않는다.
- 생산 CodexAdapter의 prepare/run/observe로 ACK, 답변, 정확한 thread/turn 종결과 재시작 후 이력 조회를 확인한다. private 증거를 저장하고 입력 횟수를 내구 예약한다. 불명확하면 추가 입력하지 않는다.
- 기능 광고는 성공 이후에만 활성화한다. 앱의 기존 버전 정책과 설치 버전 차이를 숨기거나 완화하지 않는다.

### [x] Step 2: 소유 이미지 정리 복구

- agentId와 journal key로 구분한 요청별 디렉터리에 이미지·소유 정보(dev/ino/hash)를 저장한다. 기존 WeakMap 브랜드 검사는 유지한다.
- 저장된 소유 정보는 크기 제한·일반 파일·소유자·0700/0600·symlink/hardlink·정확한 요청/descriptor/파일 identity를 검증한다. 다른 요청/agent의 파일을 정리하지 않는다.
- 생성은 요청별 `.image-<owner>.pending`에서 수행하고 이미지·metadata를 fsync한 뒤 최종 디렉터리로 원자적 rename한다. 미공개 pending은 AI에 전달하지 않는다. 확정 종결 시 정확한 요청의 pending에 있는 고정 파일 이름·소유자·권한·크기·일반파일을 확인해 부분 생성도 정리한다. UNKNOWN은 양쪽 경로 모두 보존한다.
- 성공/실패/중단 terminal 또는 확정 NOT_STARTED 증거가 있는 요청만 정리한다. UNKNOWN과 진행 중 요청은 보존한다. 종결 뒤 재시작·서버 응답 유실·정리 중 종료에도 재시도 가능하게 하며 compaction이 소유 연결을 잃지 않게 한다. 정리 실패는 확정된 답변 결과를 바꾸지 않는다.
- 검증된 Codex capability 및 preflightImage를 추가한다. 기존 텍스트와 Claude 경로는 유지한다.

### [x] Step 3: 검증·리뷰·배포

- 실패 재현부터 파일 정리·재시작·교체·권한·다른agent·UNKNOWN보존 테스트를 추가한다. capability/poll/claim 및 실제 adapter의 이미지 경로를 검증한다.
- connector 전체 검사, 웹 관련 계약 검사, format/format:check/typecheck/lint/build를 실행한다. 기존 웹/SQL 권한 리뷰는 동일 계약이므로 재사용하고 변경된 파일 소유/런타임 경계는 독립 reviewer가 검토한다.
- 기존 승인에 따라 PR/main/배포까지 완료하고 코드 배포 파일 무결성을 확인한다. 현재 동작 문서와 현황을 갱신한다.

## Tests

- 재시작 후 확정 종결 파일 정리, 정리 재시도, UNKNOWN/다른agent 보존, symlink·inode/hash 변조 거절.
- Codex 사전 검사에서 미소유/변조 이미지 거절; 기존 localImage 입력 및 thread/turn 종결 회귀.
- capability 광고와 imageVersion poll/claim, 텍스트 호환.

## Risks

- 글로벌 CLI와 제품 허용 버전이 다르므로 전역 설치를 덮어쓰지 않는다. 버전 업그레이드 자체는 이번 범위가 아니다.
- 실제 결과가 불명확하면 지원 광고를 활성화하지 않는다. 기존 UNKNOWN 기록은 지우지 않는다.

## Verification

- Node24 connector test, root typecheck/lint/build/format/format:check, 관련 웹 계약 검사.
- 합성 이미지 실제 Codex 입력 최대1회와 추가 입력 없는 observe/재시작 검증.
- 독립 리뷰, PR/main, 운영 배포 파일 검증.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 계획 Round1 | — | No issues found | 독립 reviewer가 별도 metadata, 확정 종결 정리, compaction 보류 경계를 확인했다. |
| 구현 Round1: 이미지 생성 중단 후 소유 metadata 부재로 정리·compaction 영구 보류 | HIGH | ACCEPTED — Round2 해소 확인 | input만 남은 상태의 ENOTEMPTY를 테스트로 재현했다. 생성 중인 파일을 별도 pending 경로에 두고 완성된 디렉터리만 원자적으로 게시하도록 보완했다. |
| 구현 Round2 | — | No issues found | 이전 HIGH 해소와 수정 영향 경로를 독립 검토했다. 추가 MEDIUM/LOW도 없다. |

### 실행 증거

- [PR61](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/61)을 main `55c908c`에 병합하고 운영 배포 `dpl_d73uwHkgHjosLGuSdFg1LLX5n1KC`를 확인했다. 운영 연결기 압축 해제 내용이 검증한 빌드와 일치하며 bootstrap 무결성과 로그인200을 확인했다. 증거는 `/private/tmp/codex-image-finish.lb7VJK/production-verification.json`에 보관한다.
- `/private/tmp/codex-image-finish.lb7VJK/result.json`: 공식Codex0.159.1, 실제 이미지 입력1회, 이미지 속6284 인식, ACK·COMPLETED·재시작 후 observe 확인. 추가 모델 입력0회로 파일 삭제 뒤 validate/resume도 통과(`resume-result.json`).
- 파일 소유권 재시작 테스트는 구현 전 owner.json ENOENT로 실패했다. 수정 후 관련74개 검사를 통과했다. 전역Codex0.163.0 및 사용자 설정은 변경하지 않았다.
- 기존 v1 Codex 계약은 thread/turn ACK와 종결 이력을 기준으로 유지한다. Claude 전용 이미지 nativeIntent/hash 계약을 Codex 저장 형식에 추가하지 않았다.
- 연결기 전체1279개 중1276개 통과, 시간 민감한 기존2개 실패·1개 취소는 해당 두 파일의 순차 재검사161개 전부 통과로 확인했다. 보정 후 영향 범위81개 전부 통과(새 부분 생성 검사7개 포함). 나머지 변경 영향 없는 통과 결과는 재사용했다. 관련 웹 계약15개와 format/format:check/typecheck/lint/build도 통과했다. 기존 lint 경고1개는 범위 밖으로 유지했다.
