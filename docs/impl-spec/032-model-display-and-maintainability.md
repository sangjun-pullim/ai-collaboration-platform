---
status: active
date: 2026-10-09
risk-surface: public-api, permission, db-schema
---
> 이 문서는 구현 계획이며 현재 코드의 증거가 아니다. 진행 중에는 갱신하고 완료·보관한 뒤에는 당시 기록으로 유지한다.

# 모델 표시와 실행·저장·채팅 모듈 정리

## Context

사용자가 모델 이름 누락과 유지보수 문제를 지적하고 “알아서 보완 및 정리해. 끝까지.”라고 요청했다. 직전 검토에서 확인한 모델 표시 누락, `WorkflowRunner.execute`, 로컬 기록 검증, `RoomInvestigation`의 책임 분리를 한 작업으로 진행한다. 변경 범위는 기존 AI 연결·개인 설정·읽기 권한·질문 전달·실행 기록을 유지하는 보정이다. 새 실제 AI 입력, 두 Mac 검증, 운영 배포는 포함하지 않는다.

현재 Claude의 공식 모델 목록은 표시 이름을 제공하지만 연결기가 버리고, 웹은 실행 값인 `opus`만 표시한다. 표시 이름을 실행 설정 해시에 포함하면 이름 변경만으로 기존 설정을 다른 설정으로 판단할 수 있다. 따라서 표시 이름은 선택값·설정 해시와 분리한다. 특정 최신 버전을 하드코딩하지 않는다. 목록에 표시된 이름을 실제 답변에서 관찰한 실행 모델이라고 주장하지 않는다.

범위 조사는 읽기 전용 `planner`의 보고와 코드 확인을 사용했다. 큰 파일을 다른 큰 파일로 옮기는 데 그치지 않고, 순수 검증과 부수효과, 실행 권한과 실행 순서, 채팅 데이터 처리와 표현을 분리한다. 리팩터를 이유로 공개 클래스나 API를 늘리지 않는다.

## Affected Files

1. `packages/local-connector/src/runtime-contracts.ts` — 선택적 모델 표시 이름.
2. `packages/local-connector/src/claude/adapter.ts`, `codex-adapter.ts` — 공급된 표시 이름 보존, 기존 실행 값과 해시 유지.
3. `packages/local-connector/src/settings/contracts.ts`, `src/features/runtime-settings/contracts.ts` — 동일한 계약·검증·표시 정보 제외 해시.
4. `packages/local-connector/src/settings/store.ts`, `settings/manager.ts`, `runtime/record-schema.ts` — 이전 기록과 선택적 표시 이름 호환, apply 전 카탈로그의 의미 비교.
5. `src/features/runtime-settings/runtime-settings-form.tsx` — 표시 이름과 실행 값 구분, 이름이 없는 목록 호환.
6. `supabase/migrations/20261009001700-runtime-model-display-names.sql` — 기존 카탈로그 함수의 후속 확장. 이전 migration·기록·테이블·권한 유지.
7. `scripts/apply-local-ai-settings.mjs` — 검토한 이전/현재 함수만 후속 migration으로 갱신하고 이후 버전을 이전 것으로 되돌리지 않는 검사.
8. `packages/local-connector/src/runtime-store.ts`, `runtime/record-schema.ts`, `record-validation.ts`, `record-transitions.ts`, `record-helpers.ts` — 파일 저장과 로컬 기록의 순수 검증 모듈.
9. `packages/local-connector/src/workflow-runner.ts`, `workflow/attempt-authority.ts` — 실행 권한·도구·중단 콜백 구성과 순서 분리. 복구 로직은 증거 확인 책임별 내부 헬퍼로 나눈다.
10. `src/features/investigation-coordinator/investigation-view.tsx`, `use-room-chat.ts`, `room-chat-controller.ts` — 채팅 데이터·폴링·질문 전송과 표현 분리. 컨트롤러와 hook의 필요성은 기존 패턴에 맞춰 하나의 폴링 소유자를 유지하는 방식으로 확정한다.
11. 관련 unit·connector·DB·browser 테스트와 검증 fixture — 기존 assertion을 유지하고 공개 동작을 검증한다.
12. `docs/ARCHITECTURE.md`, `FRONTEND-ARCHITECTURE.md`, `API-SPEC.md`, `DB-SCHEMA.md`, `BUG-FIXES.md`, `guides/onboarding-and-settings.md`, `planning/delivery-and-validation.md`, `README.md` — 현재 구조·모델 표시·검증 근거 갱신. 진행 수치는 개발·검증 상태에만 쓴다.

## Affected Dependents

- `settings/manager.ts`의 catalog 처리, CLI 설정 명령: 실행 모델·effort 선택과 준비/확인 영수증을 유지한다.
- `settings/contracts.ts`의 `projectCapability`와 로컬 archive 검증: 표시 정보가 없는 과거 기록과 같은 설정 해시를 유지한다.
- 웹 설정 controller/client/route와 DB 설정 적용 함수: 모델 ID와 실행 값은 유지하고 `displayName`만 선택적으로 허용한다.
- `cli/runtime-context.ts`, `cli/runtime-command.ts`, `settings/manager.ts`, `cli/remove-local-profile.ts`: `WorkflowRunner`, `RuntimeStore`, 기존 공개 함수의 호출 방식은 유지한다.
- `workflow/local-removal.ts`, `workflow/record-snapshot.ts`: 같은 기록 상태·정리 가능성 판정을 사용한다.
- 채팅 room page, `ChatTimeline`, `ChatComposer`, `AdvancedControls`, source 상세 controller: 공개 props, 대상 고정, 접근 철회와 입력 이력 의미를 유지한다.
- `chat-view.test.ts`, `human-direct-intents.test.ts`: hook 순서에 의존한 기존 harness를 새 경계로 바꾸되 재전송·대상 변경·접근 철회의 검증을 삭제하지 않는다.

## Implementation Steps

### [ ] Step 1: 모델 표시 버그 재현과 선택·해시 호환 보정

- 먼저 공급자가 `displayName`을 주는데 목록에 남지 않고 웹에서 이름을 보여주지 않는 실패 테스트를 작성한다.
- `displayName?: string`을 제한된 표시 정보로 추가한다. 제어 문자·경로·인증 정보와 지나치게 긴 값은 표시 이름으로 채택하지 않고 기존 실행 값을 표시한다. 미지원 필드는 계속 거절한다.
- 실행 값 `model`, 식별자 `id`, effort 목록·기본값·선택값은 바꾸지 않는다. 표시 이름이 실행 값과 다르면 `표시 이름 (실행 값)`으로 보여준다.
- 계약의 카탈로그 해시는 모델의 `displayName`만 제외한다. 기존 목록의 해시는 동일해야 하며 의미가 다른 모델/effort는 다른 해시여야 한다. Codex native snapshot도 같은 원칙을 사용한다.
- `SettingsManager.prepare`의 전체 카탈로그 비교도 표시 정보를 제외한 검증된 설정 identity로 비교한다. 폴더 선택 때 이름 A, apply 때 이름 B여도 같은 모델·effort·설정이면 준비를 계속하고, 의미가 바뀌면 기존처럼 `SNAPSHOT_CHANGED`로 거절한다.
- 과거 v1/v2 기록과 설정 journal을 읽고 다시 쓰는 호환성을 검증한다. 카탈로그 크기 제한을 늘리지 않는다. 표시 정보 때문에 카탈로그·LOCAL_CONFIRMATION receipt·SQL response(16,200바이트)·HTTP envelope(16,384바이트) 중 하나라도 초과할 수 있으면 표시 이름만 생략한다. PostgreSQL jsonb 표현의 공백과 envelope overhead도 계산하고 실행 가능한 목록·기본값은 보존한다. 중앙 response에서 receipt의 catalog와 applied catalog가 null인 기존 조건도 유지한다.

### [ ] Step 2: 중앙 카탈로그 검증과 로컬 적용 검사

- 후속 migration은 `runtime_settings_private.catalog_ok(jsonb)`만 교체한다. 선택적 표시 이름의 길이·문자 검증과 해시에서 제외하는 처리를 Node/Web 계약과 일치시킨다.
- 기존 객체, 함수 속성·search path·권한, 의미 검증, 예외 거절을 유지한다. 기존 migration 파일과 저장한 JSON을 수정하지 않는다.
- 적용 도구는 현재 설치된 함수의 검토한 소스 지문과 설치 이력을 확인한다. 알 수 없는 소스·버전이면 거절한다. 새 함수를 기존 014 함수로 내리지 않는다.
- 격리된 실제 PostgreSQL에서 이전/새 목록 수용, 위조된 의미 해시·잘못된 표시 정보 거절, 재적용의 안정성을 확인한다. 공유 DB reset은 하지 않는다.

### [x] Step 3: 로컬 기록 검증 모듈 정리

- 스키마 검증, 기록 내부 관계 검증, 이전→다음 상태 전환 검증을 내부 모듈로 나눈다. 파일 I/O와 잠금·archive·정리는 `RuntimeStore`에 둔다.
- 큰 관계 검증은 스레드·시도·도구·영수증·Claude 상태 책임별 함수로 나누고 원래 검사 순서와 오류를 유지한다. 공개 인터페이스를 추가하지 않는다.
- `write`의 잠금 전 기본 검증과 잠금 뒤 상태 검증을 유지한다. 완료 기록을 archive로 옮기는 `compact`의 별도 경로를 보존한다.
- 중복 탐색은 의미와 순서가 같은 지역 인덱스로 개선할 수 있을 때만 바꾸고, 의미 회귀 테스트와 반복 가능한 측정 근거를 남긴다. 성능을 측정하지 못하면 최적화 완료라고 쓰지 않는다.

### [x] Step 4: 실행 권한과 실행·복구 순서 정리

- `WorkflowRunner`가 현재 기록, serialized mutation, 활성 실행, 도구 호출, 예약의 단일 소유자로 남는다. 내부 authority 구성 모듈은 필요한 좁은 포트로 같은 상태를 참조하고 복제하지 않는다.
- ACK·도구 취소·중단 증거·입력 전 검사의 긴 콜백을 책임별 함수로 나눈다. 취소된 도구의 `closed=true` 설정은 기존처럼 대기보다 먼저 실행한다.
- `execute`의 claim→server intent→provider intent→실행→결과 저장→게시 순서, monitor 중단·대기, 저장 종료 fence, `finally`의 호출·예약 정리를 유지한다.
- 시작 전 복구의 기존 증거 확인을 내부 헬퍼로 나눈다. 원래 scope·generation·fence와 서버 영수증이 확인되지 않으면 새 입력을 만들거나 실행을 재시도하지 않는다.
- 지연 ACK, 중단·도구 race, 저장 실패, stale generation, 같은 미시작 시도 복구 테스트로 결과를 확인한다.

### [ ] Step 5: 채팅 데이터 처리와 화면 분리

- 데이터 처리 모듈이 폴링 timer·abort와 질문 mutation을 소유한다. 화면은 입력 초안·스크롤·컴포넌트 배치 책임을 갖는다.
- 하나의 폴링 소유자와 같은 간격 정책을 유지한다. mutation 동안 폴링을 멈추고 완료 시 다시 시작한다. unmount와 접근 철회는 모든 요청을 중단하며 늦게 온 결과가 상태를 복구하지 못하게 한다.
- actor/room별 대기 중 질문을 HTTP보다 먼저 저장하고 확정된 결과에만 지운다. 같은 입력 재전송, responder epoch 고정, 답변 제공자 변경 시 초안 보존, source 상세 접근 철회 처리를 유지한다.
- 테스트는 hook 인덱스 대신 새 데이터 모듈의 공개 동작과 렌더 결과를 검증한다. browser에서 실제 질문 제출·답변 표시·재전송·설정 표시를 확인한다.

### [ ] Step 6: 검증·리뷰·문서·GitHub Flow 종료

- 필수 검사를 완료하고 독립 `reviewer`가 전체 변경·권한·DB·호환성·정리 시퀀스를 검토한다. 차단 지적을 보정하고 영향받은 검사를 다시 실행한다.
- 표준 문서는 `docs/` 바로 아래에 유지한다. 새 실제 AI 호출 없이 확인한 사실과 실제 Claude 중단/두 Mac 검증 대기를 구분한다.
- 모든 단계·테스트·리뷰 완료 후 이 계획을 archive로 옮긴다. 기능·정리·문서의 논리적 커밋을 만들고, 기존 main 병합 요청에 따라 검증한 PR의 exact head를 일반 병합한다. main 포함 확인 뒤 이번 브랜치와 소유한 worker pane을 정리한다.

## Tests

- 설정 계약: 이름이 있는/없는 목록, 표시 정보만 바뀐 해시, 의미 변경, 잘못된 표시 정보, 미지원 필드, web/local 복사본 일치.
- 표시 정보 용량: 기존에는 수용 가능한 상한 근처 목록·receipt·response를 준비해 이름 추가 시 의미 필드가 빠지지 않고 표시 이름만 생략되는지 검증한다. PostgreSQL jsonb 표현 크기와 HTTP envelope 상한을 실제 DB/HTTP 경계에서도 확인한다.
- Claude/Codex adapter: native 이름 보존, 안전하지 않은 이름의 fallback, ID/실행 모델/effort 유지, 기존 snapshot과 실행 검증 유지.
- SettingsManager: 폴더 선택과 apply 사이 표시 이름만 변경된 실제 준비 흐름은 허용하고, 같은 시점에 실행 설정이 변경된 흐름은 거절한다.
- 설정 UI: 이름과 실행 값 표시, 선택 이벤트 값 유지, applied/requested 일치, 이름이 없는 이전 목록 호환.
- RuntimeStore/settings store: 이전 v1/v2 기록 roundtrip, 새 선택적 이름, 동일한 상태 전환 오류, archive·정리·용량·원자 쓰기 유지.
- 적용 도구·실제 DB: 이전/새 함수 지문, 후속 설치, 반복 적용, 알 수 없는 함수 거절, JS/SQL 유효성·해시 일치.
- WorkflowRunner: 기존 전체 회귀와 지연 콜백·중단·시작 전 복구·예약 해제의 기존 assertion 유지.
- 채팅 controller/view/browser: 하나의 poll, mutation 직렬화, unmount/접근 철회, uncertain 질문 보존·동일 질문 재전송, 대상 epoch·초안·스크롤 유지.

## Risks

- 표시 정보가 설정 identity를 바꾸면 Claude가 다음 질문을 거절한다. 이전 hash fixture와 표시 정보만 다른 목록을 비교한다.
- 표시 이름은 공급자가 주는 목록 정보다. alias가 실제 사용한 버전인지 확정하지 않고 실행 관찰과 구분한다.
- 분리 중 state나 abort 권한을 복제하면 늦은 도구가 실행될 수 있다. 기존 소유자·guard·기록 순서를 유지하고 race 회귀를 돌린다.
- hook 분리 중 기존 VM harness가 동작을 우회할 수 있다. controller 직접 테스트와 실제 browser를 함께 사용한다.
- 사용자의 `next-env.d.ts`, 실행 중인 웹·연결기·다른 worktree·다른 프로젝트 Docker는 수정·종료하지 않는다. build와 browser는 별도 임시 checkout·포트에서 실행한다.

## Verification

- Node 24에서 root unit, connector unit/build/typecheck, web/test/e2e/integration typecheck, lint, `npm run format`, `npm run format:check`.
- 새 migration을 포함한 격리 DB 설정 integration과 실제 설정·workflow browser 테스트.
- production build와 명령 한 번 연결 artifact 검증은 별도 임시 checkout에서 실행한다.
- 이전 체크의 재사용은 코드·입력이 같을 때만 한다. 이 작업의 실제 AI 입력은 0회이며 실제 AI 수용 검증을 대신하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 범위 조사 완료 | INFO | RECORDED | planner `quality032_scope`: 모델 계약·SQL·설치기, 기록 validation/transition, runner callback, 채팅 effect의 호출자를 확인했다. |
| 존재하지 않는 카탈로그 모듈 경로 | MEDIUM | ACCEPTED | 현재 구현인 `settings/manager.ts`의 catalog와 `settings/contracts.ts`의 projectCapability로 호출부 목록을 수정했다. |
| apply 전 전체 카탈로그 비교가 표시 이름 변경을 거절 | HIGH | ACCEPTED | `settings/manager.ts`를 영향 파일에 추가하고 해시뿐 아니라 이 비교와 실제 manager 흐름 회귀를 Step 1에 명시했다. |
| 카탈로그보다 전체 receipt·response의 용량 제한이 먼저 걸릴 수 있음 | HIGH | ACCEPTED | 표시 정보 생략 기준에 jsonb 공백·receipt·SQL response·HTTP envelope를 포함하고 상한 근처 실제 경계 회귀를 추가했다. |
| 보정한 계획의 독립 검토 | INFO | PASS | `quality032_plan_review`가 반영된 경로·비교·용량 보정과 기록·실행·채팅 경계를 확인했다. 새 차단 지적 없음. |
| 동작 보존 분리의 승인 범위 | INFO | RECORDED | 사용자에게 전체 계획 승인을 요청했다. 답변을 기다리는 동안 AGENTS의 기계적 변경 예외에 해당하는 Step 3·4만 실행했다. 모델 표시·API·DB와 채팅 화면 분리는 아직 실행하지 않았다. |
| 실행 기록·권한 콜백 분리 검토 | INFO | PASS | `quality032_mechanical_review`가 기존 스키마·관계·상태 전환과 ACK·취소·중단 본문을 대조해 C0/H0/M0/L0로 통과했다. |
| 실행·미시작 복구 헬퍼 검토 | INFO | PASS | `quality032_runner_review`가 변경 없는 저장·권한 모듈의 앞선 리뷰를 재사용하고 새 private helper 14개를 대조했다. 대기·검사·저장·전송·finally와 기존 소유권이 유지되며 C0/H0/M0/L0다. |
