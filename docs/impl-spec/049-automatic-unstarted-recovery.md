---
status: active
date: 2026-10-20
risk-surface: public-api, permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place; once archived it is frozen.

# 실행 전 취소 요청의 자동복구

## Context
질문 #310은 2026-10-20 09:44:11 접수 후 09:46:11 CANCELLED가 됐고 서버 attempts와 claim receipt가 없다. 로컬에는 claim TRANSMITTED, snapshot/native 없음, UNKNOWN/AUTHORITY_LOST가 남았다. 격리 fixture에서 `ready=true → admission 일시 실패 → ready=false → 복구 직후 claim` 순서를 재현했다. 서버는 준비되지 않은 claim을 CONFLICT로 거절하며 로컬은 UNKNOWN으로 전환한다. 현재 recoverUnstarted는 준비 갱신 전에 같은 claim을 재전달하므로 정체가 지속된다.

사용자는 실행되지 않은 요청의 기록을 보존하면서 다음 질문을 받을 수 있도록 자동복구하는 동작을 승인했다. 불확실한 실행의 자동 재전송, 질문 재생성, 기록 삭제, 기기 인증 취소는 범위 밖이다.

## Affected Files
1. `packages/local-connector/src/workflow-runner.ts` — claim 전 준비 보고 및 서버가 확정한 시작 전 취소의 정리.
2. `supabase/migrations/20261020002800-unstarted-claim-recovery.sql` — 기존 claim/restore의 내구 거절 확장. 새 테이블은 만들지 않는다.
3. `src/features/investigation-coordinator/contracts.ts` — claim-only REQUEST_CANCELLED/409.
4. `packages/local-connector/src/workflow-contracts.ts` — 동일 전송 계약.
5. `src/features/investigation-coordinator/rpc-response-policy.ts` — 정확한 SQL marker만 해당 오류로 투영.
6. `packages/local-connector/src/runtime-contracts.ts` — SERVER_REQUEST_CANCELLED 종료 근거.
7. `packages/local-connector/src/runtime/record-schema.ts` — 근거 형식.
8. `packages/local-connector/src/runtime/record-validation.ts` — 근거 및 CLOSED operation 검증.
9. `packages/local-connector/src/runtime/record-transitions.ts` — 기존 실행 증거가 없는 경우만 NOT_STARTED 전환.
10. 관련 unit/connector/integration 테스트와 `docs/API-SPEC.md`, `docs/DB-SCHEMA.md`, `docs/BUSINESS-LOGIC.md`의 복구 설명.

## Affected Dependents
- `settings/manager.ts` startRunner/restart: 기존 루프가 복구를 실행하며 새 관리 프로세스나 자동 AI 입력을 만들지 않는다.
- `runtime-store.ts`, `runtime-archive.ts`: 새 근거가 기존 검증·아카이브 경로를 통과해야 한다. 기존 근거 형식은 유지한다.
- `workflow/input-admission.ts`: 실패 시 허용을 닫는 규칙은 유지한다.
- `own_input_private.claim`, `workflow_private.restore`, `chat_attachments_private.device`: 기존 인증·현재 scope·원래 receipt·이미지 wrapper를 유지한다.
- 확정 거절 기록의 문서 사본 5개: `docs/BUSINESS-LOGIC.md:213`(소유자 미명시), `docs/API-SPEC.md:127`(이 저장소 RPC 응답 정책), `docs/ARCHITECTURE.md:123,199`(연결 프로그램/WorkflowRunner), `docs/DB-SCHEMA.md:107`(서버 저장/restore). API·DB·업무 정본을 갱신하고 ARCHITECTURE의 적용 범위는 정본 링크로 연결한다.
- 입력 제어 실패 뒤 재허용 규칙 사본 3개: `docs/BUSINESS-LOGIC.md:211`, `docs/API-SPEC.md:123`, `docs/ARCHITECTURE.md:123`(모두 기기/연결 프로그램 책임). 실행 불확실 UNKNOWN의 자동 재호출 금지(`BUSINESS-LOGIC.md:185,187,193`)는 유지한다. 검색 범위는 src/packages/supabase 및 README가 연결한 현재 docs 정본·guides·planning이며 archived 명세는 수정하지 않는다.
- 이 브랜치는 origin/main ae383be에서 시작한다. 운영 통합에는 미병합 PR65/66 변경을 유지한다. main 병합은 수행하지 않는다.

## Implementation Steps
### [x] Step 1: 실패 재현 고정
- 기존 runner fixture를 이용해 admission 실패 후 회복 시 ready=true가 claim보다 먼저 확정되는 테스트를 추가하고 현 코드에서 실패시킨다.
- 실제 DB 조건에 맞춰 fixture의 claim이 reportedReady=false일 때 거절하게 한다. 기존 fake가 이 조건을 생략해 회귀를 놓쳤음을 기록한다.
- cancelled/noattempt의 기존 UNKNOWN이 다음 질문을 막는 경로를 테스트한다. 실제 Claude/Codex 호출은 하지 않는다.

### [x] Step 2: 준비 보고 순서 수정
- 새 claim 직전 현재 admission과 준비 상태를 확인한다. 준비 보고 실패/미허용이면 claim intent를 기록하거나 실행을 시작하지 않는다.
- 일반 polling 및 장시간 실행 중 readiness 갱신 규칙을 유지한다. 로컬 상태만 보고 서버 ready=true를 가정하지 않는다.

### [x] Step 3: 서버의 정확한 시작 전 취소 증거
- 기존 claim 요청 body/operation ID를 사용한다. `REQUEST_CANCELLED`는 정확한 `{claimDenied:"REQUEST_CANCELLED"}` marker를 현재 인증된 기기에 반환하는 claim-only 409다.
- 현재 기기 인증, 같은 방·기기·agent·epoch를 검증하고 기존 scope→room 잠금 순서를 유지한다. 요청의 원래 scope가 다르면 거절한다.
- 동일 operation의 기존 receipt가 있으면 action/body hash를 확인하고 그것을 먼저 복구한다. 성공한 claim receipt를 취소 근거로 바꾸지 않는다.
- 새 marker는 같은 요청이 CANCELLED이고 attempts가 하나도 없고 성공 claim 기록이 없음을 확인했을 때만 기존 receipts에 원자적으로 저장한다. 기한 경과의 정리는 기존 reconcile을 사용한다. QUEUED/LEASED/RUNNING/UNKNOWN이나 request 부재는 증거가 아니다.
- 동일 operation 재조회는 같은 marker를 반환하며, 다른 action/body 재사용은 CONFLICT다. 실패 중에는 변경을 commit하지 않는다.
- 일시정지 INPUT_PAUSED와 성공 claim의 기존 처리·권한은 유지한다. 새 marker의 restore는 정확한 모양과 claim action만 허용한다.
- 이미지 wrapper는 현재 인증·동일 scope·원래 receipt action/hash 검증 후, capability/version 및 이미지 lock_request 검사보다 먼저 **취소 증거만 판정하는 내부 경로**를 호출한다. CANCELLED+attempt 0+성공 claim 없음의 판정은 일반 claim과 이 경로가 같은 내부 함수를 사용한다. 이 내부 경로는 LEASED attempt 생성·준비 보고·새 AI 입력을 하지 않으며 조건 불충족이면 기존 이미지/claim 경로로 돌아간다. 기존 성공 receipt는 취소 증거로 변환하지 않는다. capability가 만료되거나 이미지가 DELETING/DELETED여도 정확한 취소 증거는 재조회 가능하다.

### [x] Step 4: 로컬 정리와 다음 질문 재개
- 실행 단계 및 recoverUnstarted에서만 REQUEST_CANCELLED를 처리한다. 현재 claim이 TRANSMITTED/result=null이고 동일 request/epoch/operation에 연결돼야 한다.
- snapshot/nativeIntent/native/terminal/receipt/toolCalls 및 다른 실행 작업이 없는 경우에만 SERVER_REQUEST_CANCELLED 근거를 저장하고 NOT_STARTED로 전환한다. 원래 claim은 CLOSED로 보존한다. 저장 실패는 복구 완료가 아니다.
- 기존 UNKNOWN의 정리는 같은 원래 claim을 조회하는 경로로 제한한다. 확인 실패/권한 상실/다른 epoch는 그대로 보존한다.
- 성공 후 현재 입력 허용과 준비 보고를 갱신하여 다음 새 질문을 받는다. 취소된 질문은 다시 보내거나 AI에 입력하지 않는다.
- 확인 불가 복구 재시도는 기존 관리 루프를 이용하며 무한 즉시 재시도는 만들지 않는다.
- 아직 QUEUED인 기존 요청을 이번 복구로 다시 실행하지 않는다. 기존 기한에 따라 CANCELLED가 된 뒤 증거를 확보한다. NOT_STARTED-only 기록의 장기 보관 정책은 기존 동작을 유지하며 이번 범위에 아카이브 정책 변경을 섞지 않는다.

### [ ] Step 5: 검증·출시
- 독립 reviewer 구현 검토 및 차단 지적 해소.
- SQL → 웹 API → 연결 프로그램 순으로 호환성을 확인한다. 구버전 연결기는 새 오류를 일반 실패로 다루며 잘못된 종결로 해석하지 않아야 한다.
- 버전별 공개 artifact의 digest 검증과 운영 미인증 차단 확인. 새 로컬 코드는 기존 터미널에 자동 반영되지 않으므로 새 명령으로 재실행이 필요함을 보고한다. 실행 중인 사용자 터미널을 임의 종료하지 않는다.
- PR65/66를 보존한 통합 배포를 검증하고 별도 PR을 만든다. 문서 정본 갱신 및 완료 시 이 계획 archive. 검사 Docker는 종료한다.

## Tests
- readiness 회복 뒤 claim 순서, admission/ready 실패 중 native 입력 0회, 정상 다음 질문 처리.
- 실제 HTTP/DB: cancelled/noattempt/no-success-receipt에만 marker 저장, 동일 operation 재조회, action/body 충돌, 다른 기기/방/epoch 거절, 권한 해제 거절.
- QUEUED·성공 claim·ABANDONED 포함 attempt 존재·native 실행 이력은 새 근거로 닫지 않음. 동시 claim/취소 순서는 room lock 아래 원자성 검증.
- 이미지 요청의 capability 만료·version 0·DELETING/DELETED 상태에서도 정확한 취소 근거 재조회. 동일 조건의 아직 실행 가능한 요청은 기존 이미지 권한/버전/보관 검사에 계속 막힘을 검증.
- 로컬 UNKNOWN/TRANSMITTED 복구, 원본 보존, 기록 재로드 검증, 저장 실패 시 재시도, 조작된 근거·다른 operation·snapshot/nativeIntent 존재 거절.
- 구형 INPUT_PAUSED/ABANDONED/preinput/image 종료 회귀, API 계약 복사 동등성.
- 요청 #310 운영 기록은 읽기 전용으로 확인한다. 운영 데이터 직접 변경이나 실제 AI 호출로 검증하지 않는다.

## Risks
- 서버 거절을 일반화하면 중복 실행 위험: 새로운 근거는 CANCELLED+attempt 0+성공 claim 없음에 한정한다.
- 로컬/서버 버전 차이: 서버부터 배포하고 구버전의 fail-closed 동작을 검증한다.
- 일시 장애의 최초 원인은 기록만으로 모두 특정하지 못했다. 이번 범위는 일시 장애가 영구 정체로 증폭되는 재현된 결함을 고친다.

## Verification
- `npm run format`, `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- `npm --prefix packages/local-connector test`와 격리 DB의 own-ai-input-pause/새 복구 integration.
- 독립 리뷰 결과, 재현 전후 결과, 운영 배포 Ready·공개 connector 파일 검증을 보고한다.

## Review Notes
5개 이상 운영 파일 및 공개 API 계약 변경 경계에 따라 리뷰 완료 후 구체적 계획을 제시한다.

| 회차 | 지적 | 심각도 | 판정 | 조치 |
|---|---|---|---|---|
| 1 | 이미지 capability 만료/보관 정리 시 취소 증거 조회가 wrapper에 차단됨 | HIGH | ACCEPTED | Step 3에 실행권 생성 없는 취소 증거 전용 내부 경로와 기존 receipt 우선순위를 명시하고 실제 DB 이미지 복구/차단 회귀 검증 추가. 2회차 독립 리뷰에서 해소 확인. |
| 2 | 수정 결과 및 영향 범위 재검토 | — | 통과 | No issues found. 열린 차단 지적 없음. |

구현 독립 리뷰 1회차: PASS / No issues found. 현재 권한 해제 뒤 proof 재조회 거절, 이미지 capability가 유효해도 삭제 상태의 새 실행 거절, 기존 QUEUED 요청의 native 실행 0회 검사를 포함해 검토했다. 미해결 지적 없음.
