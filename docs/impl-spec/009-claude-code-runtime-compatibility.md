---
status: active
date: 2026-10-02
risk-surface: auth, permission
---
> NOTE: 이 문서는 구현 계획이다. 현재 Claude가 제품에 연결되었다는 증거가 아니다. 계획 검토와 승인을 마친 뒤 실행한다.

# macOS Claude Code 런타임 호환성 검사

## Context

[PRD](../PRD.md)의 Claude 지원을 웹 모델 선택보다 먼저 검증한다. 동료 대부분이 macOS에서 Claude를 사용하고, 두 번째 PC도 Claude만 사용할 수 있다. 먼저 공식 로컬 실행의 권한·저장 맥락·질문 도구·종결을 확인한다. 서버 등록과 실제 두 PC 왕복은 다음 구현 단위다.

기존 Codex 실험의 `thread/start` 계약을 Claude에 복사하지 않는다. 신규 독립 실험에서 공식 비변조 Claude Code를 직접 실행한다. 사용자는 기존 공식 CLI 로그인으로 인증하며 제품이 인증 토큰을 읽거나 전달하지 않는다. 최초 조사는 CLI 2.1.286과 SDK 0.3.286의 공개 타입을 기준으로 했다. 2026-10-02 실행 전 실제 설치 버전이 2.1.287로 변경되어 공식 SDK 0.3.287의 타입을 추가 대조한다. SDK를 실행하거나 자체 로그인 화면을 제공하지 않는다. 버전이 달라지면 호환성 근거를 다시 확인한다.

이 단계는 한 Mac의 합성 저장소에서 진행한다. 개인 지침과 user/project/local 설정 파일은 유지한다. 공동 조사의 실행 권한을 제한하는 일시적 설정만 적용한다. 웹 설정, 서버 enum·migration, 다자 방, 회사 코드와 기존 개인 세션의 자동 채택은 포함하지 않는다.

## Affected Files

신규 디렉터리는 `experiments/claude-code-runtime/`다. 운영 소스 5개와 독립 package·검사 설정을 만든다.

1. `src/native-transport.ts` — 공식 CLI stream-json 입출력, control/MCP 연결, 제한 시간과 소유 프로세스 정리.
2. `src/task-policy.ts` — 시작 전 설정 우선순위, 일시적 실행 제한, managed 정책 충돌과 설정 변경 검사.
3. `src/owned-probe-store.ts` — 새 세션 UUID·root·실행 의도·관찰 증거의 private 내구 기록과 잠금.
4. `src/native-runtime.ts` — 초기화·실제 입력·도구·재개·중단·typed result의 연결과 호환성 판정.
5. `src/cli.ts` — 명시적인 `preflight`, `probe-zero`, `probe-tools`, `probe-interrupt` 명령과 비밀을 제외한 결과 출력.
6. `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs` — Node 24, TypeScript 5.9.3, `node:test`와 전용 lint 설정. 현재 root의 `experiments/**` 제외 설정을 가져오지 않는다.
7. `test/*.test.ts`, `test/fixtures/fake-claude.mjs` — Claude 형식의 합성 subprocess와 실패 지점 검사.
8. `README.md`, `../../docs/planning/delivery-and-validation.md`, `../../docs/research/ai-runtime-integration.md` — 실행 방법·관찰 결과·후속 연결 조건.

개인 설정·AGENTS·스킬·훅 파일과 기존 migration은 편집하지 않는다. MCP 연결은 이 실험이 소유한 두 도구만 등록하며 전역 설치하지 않는다.

## Affected Dependents

- `packages/local-connector/src/runtime-contracts.ts` — 후속 provider 통합의 참조 경계다. 이 단계에서 Codex의 필수 model/effort와 owned context 형식을 바꾸지 않는다.
- `packages/local-connector/src/workflow-runner.ts` — 현재 조정·복구 흐름을 유지한다. Claude 실제 증거를 얻기 전 adapter를 주입하지 않는다.
- `experiments/local-ai-runtime/` — 기존 Codex 실험은 독립적으로 유지한다. 잠금·fsync·파일 읽기·child 정리의 검증된 규칙만 참고한다.
- 웹·DB·device/workflow 계약 — 새 실험을 import하거나 Claude 등록 성공으로 표시하지 않는다.

## Implementation Steps

### [x] Step 1: 독립 러너와 내구 실행 기록
**File**: `package.json`, `tsconfig.json`, `src/owned-probe-store.ts`, `src/cli.ts`
- 기존 실험의 Node 24·TypeScript·`node:test` 형식을 따른다. 공식 실행 파일 경로는 로컬에서만 해석하고 shell 문자열을 받지 않는다.
- 새 root·세션 UUID와 모델 호출 전 실행 의도를 0700/0600 저장소에 fsync한다. 프로세스 잠금 아래 한 입력만 실행한다.
- supervisor가 승인된 probe 전체에 하나의 approval ID·고정 예산 저장소를 만든다. 각 명령은 같은 예산 ID를 요구하며 생성·reset 명령을 제공하지 않는다. 새 root·새 프로세스·다른 명령에서도 같은 예산을 사용한다. 입력 전송 직전 예산 잠금 아래 슬롯 소비와 입력 의도를 함께 fsync한다. 모호한 전송·정상 완료 뒤에도 슬롯을 되돌리지 않는다. 최대 3개 슬롯을 초과하거나 예산 identity·파일 소유권이 다르면 전송하지 않는다.
- host의 UUID 예약, native 초기화 확인, native 이력 생성, 입력 ACK, typed 종결을 별도 상태로 기록한다. host 파일의 존재를 native 세션 생성으로 표시하지 않는다.
- 개인·기존 세션을 탐색하거나 임의 ID를 재개하지 않는다. 부분 실행·UNKNOWN은 보존하고 자동 재시도하지 않는다.

> Step 1 검증: 내구 기록·단일 입력·공유 예산의 합성 검사와 독립 보정 리뷰를 통과했다. supervisor가 고정 상한의 실제 승인 예산 하나를 만들었다. 현재 소비와 실행 허가·관찰 결과는 [진행 상태](../planning/delivery-and-validation.md#현재-진행-상태)에 유지하며 host 예약과 실제 native 생성은 구분한다.

### [ ] Step 2: 개인 설정을 유지하는 실행 제한
**File**: `src/task-policy.ts`, `src/native-transport.ts`
- user/project/local 설정과 CLAUDE.md 로딩을 유지하고 파일을 변경하지 않는다. 다른 로그인 profile, `--bare`, `--safe-mode`, `--restricted`를 사용하지 않는다.
- 시작 전에 설정 source와 managed 우선순위를 확인한다. 일시적 overlay로 실행 훅을 끄고 알려진 plugin을 비활성화하며 strict MCP와 제한된 도구 목록을 적용한다.
- 빈 객체·배열이 상속 설정을 삭제한다고 가정하지 않는다. managed 필수 실행이나 적용 근거를 확인하지 못하면 native 조사 프로세스와 모델을 시작하지 않고 구체적인 미확인 항목을 남긴다.
- MCP는 이 실험의 파일 읽기·합성 상대 질문 두 개만 허용한다. built-in 쓰기·셸·네트워크 도구와 미검증 MCP/plugin/hook 실행을 허용하지 않는다.
- 환경은 개인 native 인증을 유지하면서 제품·DB·관리자 fixture 값을 제외한다. startup·새 입력·callback 시 설정 fingerprint와 권한을 다시 확인한다. 실행 기간에도 task 제한이 유지되는 해당 버전의 native 우선순위·변경 적용 근거를 확인하며, 그 근거가 없으면 시작을 거절한다.
- 활성 입력 동안 설정 source를 최대 100ms 간격으로 관찰하고 callback이 없어도 drift에 반응한다. 감지 즉시 입력·callback·공개 결과를 폐쇄하고 해당 child만 stdin 종료→250ms 대기→TERM→1초 대기→KILL→1초 reap한다. 확인된 종결은 보존하고 미확인 입력은 `UNKNOWN`, 정리 실패는 별도 `CLEANUP_INCOMPLETE`로 기록한다. 늦은 결과는 공개하지 않는다. 외부 소유자·관리자의 동시 변경을 원자적으로 막았다고 주장하지 않는다.

### [ ] Step 3: 무입력 초기화와 native 저장 조건 확인
**File**: `src/native-transport.ts`, `src/native-runtime.ts`, `src/owned-probe-store.ts`
- 공식 CLI의 stream-json과 조사한 control 형식을 사용한다. 1MiB line, 최대 32 pending 요청, 요청별 10초·전체 probe 60초를 넘으면 종료·미확인으로 기록한다.
- Step 2의 시작 전 제한이 확인된 뒤 열린 무입력 stream에서 초기화한다. SessionStart의 자동 입력이나 모델 실행이 나타나면 0-call 성공으로 처리하지 않는다.
- host UUID·프로세스 cwd와 native가 보고한 ID·cwd를 대조한다. 해당 UUID의 native 기록만 읽으며 다른 세션 목록을 검색하지 않는다.
- 무입력 native 이력이 생성되면 소유 child를 종료한 뒤 같은 ID의 새 프로세스 read/resume를 확인한다. 이력이 없으면 `NATIVE_NOT_MATERIALIZED`로 기록한다. 빈 이력 반환과 파일 없음은 구분한다.
- 첫 실제 입력에서 이력이 생성되는 공급자라면 예약·native 생성·첫 실행을 구별하는 후속 adapter 계약이 필요하다고 기록한다. 가짜 첫 질문, `shouldQuery:false` 입력, rename으로 성공을 만들어내지 않는다.
- model 요청을 생략한 native 기본값과 응답별 model 관찰을 기록한다. effort의 누락·null은 미확인으로 남기며 Codex 기본값으로 채우지 않는다.

> 관찰: 공식 CLI가 무입력 초기화에 응답하고 자신의 MCP 응답을 재출력하는 경로를 확인했다. 무입력의 native ID 보고·이력 파일은 생성되지 않았다. 첫 실제 입력 전송 뒤 새로운 command 상태 형식을 거절해 native 초기화·입력 ACK·typed 종결은 확인하지 못했다. 정리 후 정확한 예약 UUID의 native 이력 생성과 해당 입력 UUID·본문 hash의 사용자 기록을 읽기 전용으로 확인했다. 저장 사실을 정상 실행이나 재개 근거로 바꾸지 않으며 이 Step의 나머지 수용 조건은 미완료다.

### [ ] Step 4: 실제 도구·저장 맥락·중단의 제한 검사
**File**: `src/native-runtime.ts`, `src/native-transport.ts`, `src/cli.ts`
- 합성 검사에서 권한·상관관계·종결 거절 조건을 먼저 통과한다. 그 뒤 공식 로그인과 새 합성 저장소에서 승인된 probe 전체의 내구 예산으로 최대 3개의 직접 사용자 입력만 실행한다. 공급자 내부·배경 사용량의 hard cap을 보장하지 않는다.
- 첫 입력은 선택 파일 읽기와 합성 상대 질문을 수행한다. 합성 답변은 도구 연결 증거이며 실제 상대 AI 왕복 증거가 아니다.
- 입력 UUID·native session·assistant tool-use·MCP dispatch·result를 기록한다. MCP/control ID나 모델이 보낸 세션 인자를 권한 증거로 사용하지 않는다. 하나의 활성 입력과 실제 native 증거로 연결되지 않는 callback은 거절한다.
- 같은 session·입력 UUID의 `command_lifecycle`은 고정 상태 정보로만 읽는다. exact 필드·문자열 enum·중복·개수 상한을 검사하고 입력 ACK·도구 권한·typed 완료/중단이나 재시도 근거로 사용하지 않는다.
- 실제 파일 callback은 canonical root·선택 파일 identity·크기·내용 hash를 검사한다. 다른 파일, 링크, 변경된 파일, 늦은 callback과 다른 입력의 재사용을 거절한다.
- 첫 정상 종결 뒤 소유 child를 종료한다. 두 번째 입력은 같은 native ID를 새 프로세스에서 재개해 이전 대화의 합성 표식과 새 파일 표식을 확인한다. 이전 표식을 prompt에 다시 넣지 않는다.
- 첫 child의 종료·reap을 확인한 뒤 host가 소유한 합성 파일만 실행 잠금 아래 교체한다. 두 번째 입력 의도를 만들기 전에 새 inode·크기·hash를 fsync한다. 이 예정된 입력 사이 변경은 새 snapshot으로 확인하며, 입력 중 임의 변경을 snapshot 갱신으로 허용하지 않는다.
- 세 번째 입력의 성공한 파일 callback 응답을 잠시 보류하고 interrupt한다. ACK/queue 취소와 해당 입력의 native typed 종결을 구별한다. typed 중단 근거가 없으면 `UNKNOWN`으로 남긴다.
- 공개 결과는 소유한 같은 입력의 실제 최종 결과와 완료 근거가 일치할 때만 만든다. assistant 중간 text, process exit, model-less 결과만으로 완료를 표시하지 않는다.
- 부분 실행 후 자동 새 입력·새 세션·추가 예산으로 재시도하지 않는다. 처음 보는 native 형식은 private 증거를 남기고 해석·검사 보정부터 한다.

#### 검토한 후속 범위와 실제 실행 결과

- 첫 미확인 실행의 세션·입력·UNKNOWN·소비 슬롯은 그대로 보존한다. 그 세션을 재전송하거나 재개하지 않는다. 상태 메시지 해석 보정과 합성 검사·독립 리뷰는 실제 재실행 승인과 구분한다.
- 원래 승인 ID·예산 ID와 전체 직접 입력 상한 3회를 유지한다. 새 합성 저장소 한 곳에서 남은 최대 2회로 정상 도구 실행과 같은 native ID의 새 프로세스 재개만 검증하는 안이다. 예산을 초기화하거나 추가하지 않는다.
- 첫 후속 입력은 선택 파일 읽기와 합성 상대 질문을 확인한다. 정상 typed 종결·소유 child의 완전한 정리·정확한 이력 저장을 확인한 경우만 파일 snapshot을 갱신하고 다음 입력을 실행한다. 두 번째는 이전 대화 표식과 현재 파일 표식을 확인한다. 실패·미확인·정리/저장 오류가 발생하면 즉시 멈추며 추가 입력을 만들지 않는다.
- 구체적인 사용자 결정 기록과 검토한 드라이버·원래 UNKNOWN/슬롯의 hash를 실행 permit에 결합한다. 사용자의 “이 프로그램의 의도대로 동작되게 해줘”를 앞서 제시한 후속안의 진행 지시로 기록하고 해당 범위만 실행했다. 선택지 클릭을 받았다고 기록하지 않는다. 실행 중 이전 UNKNOWN과 첫 슬롯의 불변 조건을 확인했다.
- 이 안에는 실제 interrupt 입력이 없다. 실제 중단, 공개 CLI의 native 실행 허용, 제품 adapter와 두 PC 지원은 별도의 미완료 범위로 유지한다. 앞 항목의 자동 재시도 금지는 계속 적용한다.

> 후속 실행 관찰: 새 합성 저장소의 첫 입력 전송 뒤 native 시작 응답에 기본 활성화된 내장 plugin 두 개가 포함되어 엄격한 시작 검사가 `NATIVE_IDENTITY`로 거절했다. 입력 ACK·assistant·도구·typed 종결은 확인하지 못했고 재개 단계는 실행하지 않았다. 원래 UNKNOWN/첫 슬롯, 새 UNKNOWN/두 번째 슬롯을 보존하고 소유 child REAPED와 개인 설정 hash 불변을 확인했다. 실행 permit은 다시 FALSE로 종료했다. 공식 소스에서 두 내장 plugin의 작업별 설정 키를 확인했으며, 빈 plugin 조건을 완화하지 않고 시작 설정을 보정한다. 최신 수치는 [개발·검증 상태](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

### [ ] Step 5: 호환성 판정과 다음 provider 계약
**File**: `README.md`, `../../docs/planning/delivery-and-validation.md`, `../../docs/research/ai-runtime-integration.md`
- 권한 제한, 설정 보존, native 저장·재개, callback 연결, 기본값, 완료·중단을 각각 확인/미확인/미지원으로 기록한다. 합성 검사와 실제 검사를 구분한다.
- 무입력 영속화·optional effort 등 Codex와 다른 native 사실을 후속 계약에 반영한다. 미확인 상태를 Codex의 `CONNECTOR_CREATED`나 확인된 effort로 바꾸지 않는다.
- 실제 검사 결과·필요한 private 증거는 보관하고 종료된 child·완료한 합성 파일과 임시 실행 설정을 정리한다. 개인 native 이력은 임의 삭제하지 않는다.
- 독립 구현 리뷰와 문서 검사를 마친다. 단계별 진행 상태는 delivery 문서에만 유지한다. Claude 등록·제품 adapter·두 PC 왕복은 이 결과를 바탕으로 다음 작은 명세를 작성한다.

## Tests

1. `should reject unconfirmed startup execution before launching native CLI` — managed 충돌·상속 훅·자동 첫 입력·누락된 정책 근거에서 모델을 시작하지 않는다.
2. `should preserve personal settings while enforcing the task tool boundary` — user/project/local 파일·일반 환경 보존, 일시적 훅/plugin/MCP/도구 제한, reserved credential 제외와 drift 시 거절.
3. `should distinguish host reservation from native session persistence` — UUID·초기화·파일 없음·빈 이력·다른 cwd/ID·다른 이력을 구별한다.
4. `should persist input intent before submission and retain ambiguous attempts` — fsync 실패 시 호출 0, ACK/종결 유실·재시작 뒤 UNKNOWN과 추가 호출 0.
5. `should correlate native input tool dispatch and typed result` — 다른 session/입력/tool-use/MCP dispatch·늦은 callback 거절, 중복 같은 호출의 멱등 처리.
6. `should read only unchanged selected files` — 경로 이탈·링크·파일 교체·내용 변경·크기 한도 거절.
7. `should separate interruption acknowledgement from native terminal evidence` — ACK만 받은 상태, 자연 완료와 interrupt 경합, 종결 누락, child 종료를 구별한다.
8. `should leave missing default effort unverified` — alias/resolved model·요청/관찰 구분, optional/null effort·지원 밖 형식 거절.
9. `should bound protocol IO and reap only owned processes` — 초과 line/pending·잘못된 UTF-8·종료·timeout·stdin 오류·미수거 rejection과 자신의 child 정리.
10. `should retain one approval budget across commands processes and roots` — 정상 완료 후 네 번째 입력·동시 명령·새 root·ACK 유실·재시작·예산 identity 바꾸기로 상한을 초기화하지 않는다.
11. `should close callbacks and reap the owned child after callback-free policy drift` — callback 없는 변경·늦은 응답에서 공개 결과 차단, UNKNOWN과 cleanup 실패 분리.
12. `should replace only owned fixture snapshots between reaped inputs` — host의 계획된 합성 파일 교체·새 snapshot 내구 저장과 입력 중 임의 변경 거절.
13. `should keep native command fate separate from execution evidence` — 같은 입력의 known enum·exact/reordered 중복, 변조·외부 UUID·본문 확장·개수 상한과 typed 종결 후 metadata를 검사한다. 실제 수집 frame의 offline 해석은 UNKNOWN·예산을 변경하지 않는다.

실제 수용은 합성 테스트와 별도로 개인 파일 hash 보존, 0-input 관찰, 실제 두 도구, 같은 세션 재개, typed 중단과 정리의 결과를 기록한다. native 조건이 성립하지 않으면 해당 Step을 미완료로 유지하고 후속 설계가 필요한 근거를 제시한다.

## Risks

- 공식 CLI 직접 로그인과 제품의 구독 인증 제공은 조건이 다르다. 이 실험은 개인의 native 인증을 사용한다. 범용 제품 배포의 적격성은 [AI 연동](../research/ai-runtime-integration.md)의 조건과 별도로 판단한다.
- CLI/SDK control 필드는 버전별로 달라질 수 있다. 명시적 관찰과 constructor-only 합성 transport를 사용하고 확인되지 않은 필드는 성공으로 해석하지 않는다.
- managed 필수 설정과 공동 조사 제한이 양립하지 않으면 제한을 제거하지 않는다. native 실행 전에 원인과 필요한 정책 변경 주체를 보고한다.
- native 도구 callback과 입력의 연결, 무입력 저장, typed 중단이 미지원이면 제품 provider 계약의 변경이 필요할 수 있다. 이 단계에서 서버·runner를 먼저 확대하지 않는다.

## Verification

- Node 24에서 `npm --prefix experiments/claude-code-runtime ci` 후 `run typecheck`, `test`, `run build`, `run lint`.
- 전용 `eslint.config.mjs`는 `src/**/*.ts`, `test/**/*.ts`, `test/fixtures/**/*.mjs`를 대상으로 한다. 현재 설치 기준 ESLint 9.39.5·`@typescript-eslint/parser` 8.71.0을 고정한다. `lint`는 실험 cwd에서 `eslint --config eslint.config.mjs src test`를 실행하며 `--debug`의 실제 검사 파일 목록을 소스 inventory와 대조한다. root의 ignore 설정이나 ignored 경고를 통과로 처리하지 않는다.
- 기존 Codex/웹 소스와 검사 입력이 같으면 기존 PASS를 재사용한다. 신규 실험의 root import·서버 연결이 없는지 확인한다.
- 실제 CLI는 명시적 opt-in 합성 root에서 단계별로 실행한다. private 원문 대신 호출 수·관찰 유형·hash·종료/정리 여부만 공개한다.
- 설정/권한·내구성·callback·종결과 실제 증거의 독립 reviewer 검토, 문서 링크 검사. 계획 승인만으로 실제 수용을 통과 처리하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan round1: runtime policy drift | HIGH | ACCEPTED — ROUND2 PASS | 실행 중 제한 유지의 native 근거, callback 없는 관찰, callback·공개 결과 폐쇄와 bounded owned child 종료·UNKNOWN/cleanup 실패를 Step 2와 test 11에 추가했다. |
| Plan round1: durable global probe budget | HIGH | ACCEPTED — ROUND2 PASS | 같은 approval ID의 예산 잠금·fsync와 명령/root/재시작 간 불변 상한을 Step 1·4와 test 10에 추가했다. |
| Plan round1: lint ignored experiment | MEDIUM | ACCEPTED — ROUND2 PASS | 전용 설정·고정 parser/ESLint·정확한 명령과 실제 파일 inventory 검사를 Verification에 명시했다. |
| Plan round1: owned fixture snapshot refresh | MEDIUM | ACCEPTED — ROUND2 PASS | 첫 child reap 뒤 host 합성 파일만 교체하고 다음 입력 전 새 snapshot을 fsync한다. test 12에 입력 중 변경과의 구별을 추가했다. |
| Independent plan round2 | INFO | PASS | C0/H0/M0/L0. 이전 네 지적을 해소했다. 실제 native 호환성과 구현 승인은 아직 확인 전이다. |
| Implementation source1: pending control response | HIGH | ACCEPTED — SOURCE2 REVIEW PASS | 지원 밖 control subtype를 검증하기 전에 pending과 timeout을 제거해 Promise가 남는 결함을 독립 reviewer가 재현했다. 실패 회귀·정리·잠금 해제를 보정했고 scoped 재검토를 통과했다. |
| Implementation source1: native enum coercion | HIGH | ACCEPTED — SOURCE2 REVIEW PASS | effort·terminal reason의 배열/객체를 String으로 변환해 유효한 native 근거로 해석했다. 원래 타입 검사와 UNKNOWN 보존 회귀를 추가했고 scoped 재검토를 통과했다. |
| Private input preparation: unresolved state·cleanup·signals | HIGH | ACCEPTED — LIFECYCLE REVIEW PASS | 현재 미확인 입력의 내구 UNKNOWN, handler-incomplete 거절, SIGINT/SIGTERM과 저장 실패의 bounded child 정리를 보정했다. 저장 실패와 실제 정리 결과를 별도 보존하고 다음 입력을 차단한다. |
| Actual first input: command lifecycle | INFO | OBSERVED — OFFLINE REVIEW PASS | 공식 CLI가 같은 session·입력 UUID의 queued 상태를 보냈다. 거절된 실행·UNKNOWN·소비 슬롯은 보존했다. 고정 schema와 수집 frame의 해석 보정·합성 검사·독립 리뷰를 통과했다. 상태 정보를 ACK·종결·도구 권한으로 바꾸거나 새 실제 실행의 승인으로 사용하지 않는다. |
| Remaining-two followup preparation | INFO | PREPARATION REVIEW PASS — USER DECISION PENDING | 원래 예산·UNKNOWN·첫 슬롯 보존, 별도 결정 hash와 드라이버 hash의 실행 조건, 정상 도구→같은 ID 재개의 두 단계 및 첫 오류 중지를 독립 검토했다. 실제 실행은 승인하지 않았으며 interrupt·제품·두 PC와 전체 수용은 미완료다. |
| Actual followup input: default-enabled builtin plugins | HIGH | ACCEPTED — STARTUP CORRECTION IN PROGRESS | 작업 overlay가 개인 설정에 존재하는 plugin 키만 제한해 내장 agents-md/telemetry의 기본 활성화를 놓쳤다. 실제 입력은 즉시 UNKNOWN으로 보존하고 정리했다. 공식 소스의 정확한 두 설정 키를 작업 overlay에 추가하며, 내장 메타데이터를 허용 목록으로 바꿔 실행 권한을 확대하지 않는다. |

#### 시작 제한 보정 뒤 남은 한 번의 관찰

공식 소스와 새 회귀 검사·독립 리뷰를 거쳐 작업별 설정에 두 내장 plugin의 비활성화를 명시했다. 사용자의 정상 구현 진행 지시에 따라 총괄이 원래 남은 1회를 수동 보정 검사로 선택했다. 기존 두 UNKNOWN·슬롯과 원래 승인/예산/상한을 그대로 보존하고 세 번째 새 합성 저장소에서 한 정상 도구 입력만 전송했다. 새 선택지 클릭이나 추가 예산 승인을 받았다고 기록하지 않는다.

세 번째 시작 응답은 plugin 0개·허용한 소유 MCP 도구 2개·정확한 version/cwd/session·dontAsk 조건을 통과했다. 다음 `system/thinking_tokens` 상태 알림이 현재 드라이버의 미지원 분기로 들어가 `TOOL_REJECTED`로 종료됐다. 입력 ACK·assistant·도구 callback·typed 종결은 확인하지 못했다. 세 번째 UNKNOWN/terminal null, 이전 두 기록의 불변·개인 설정 불변·소유 child REAPED·permit 종료를 확인했다. 이 알림은 실행 허가가 아니며 ACK·종결·재시도 근거로 사용할 수 없다. 실제 수치를 진행 정본에 유지한다.

원래 입력 상한은 모두 소비했고 자동으로 늘리지 않는다. 먼저 공식 버전의 상태 알림 형식과 도구 메시지를 구분하는 해석·합성 검사를 보정한다. 이후 실제 정상·재개·중단 검사는 원래 기록을 보존한 별도 구체적 범위와 승인 조건에서만 진행한다. 이 단계가 Claude 제품 지원이나 두 PC 검증의 완료를 뜻하지 않는다.

#### 추가 실제 검사 전 보정과 실행 조건

private 검증 드라이버에 `system/thinking_tokens` 상태 정보와 소유한 보류 파일 callback의 `control_cancel_request` 해석을 적용했다. 정상 진행 알림은 개수와 마지막 값만 보관한다. 형식·입력 UUID가 맞지 않는 알림은 기존 private 원문 상한 안에 보존하고 같은 거절 오류를 유지한다. 취소 정보는 같은 활성 입력에서 실제 연결된 소유 도구 요청에만 적용하며, 도구 결과나 typed 종결로 사용하지 않는다.

실제 transport·엄격한 입력/도구 proof·정리·내구 저장을 합성 Node 실행기의 stdio에 연결했다. 정상 도구→같은 ID 재개→보류 callback의 취소·중단 종결·정리와, 종결 유실·외부 취소·신호 중단·저장 실패의 UNKNOWN/슬롯 보존을 검사했다. 신호 검사에는 중단 함수의 전달 지점을 사용하며 실제 OS 신호나 native 이력의 재개를 입증하지 않는다. 모든 실패를 허용하던 음성 검사는 각 원인의 정확한 코드와 다음 입력 차단 사유를 확인하도록 보정했다. 독립 구현 재검토의 차단 지적은 없으며 현재 수치는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

검토한 추가안은 원래 세 UNKNOWN·종결 없음·소비 슬롯·승인/예산/설정 hash를 유지한 별도 최대 3회다. 새 합성 저장소의 정상 도구 입력 1회, 완전한 정리 뒤 같은 native ID의 새 프로세스 재개 1회, 보류 파일 callback에서 중단 확인 1회로 구성한다. 전체 직접 입력의 최대 합계는 6회다. 하나라도 미확인·저장/정리 오류가 있으면 다음 입력을 만들지 않는다. 원래 예산을 변경하거나 이전 UNKNOWN을 재전송하지 않는다.

이는 준비안이며 추가 실행 허가는 FALSE로 유지한다. 검토한 코드·별도 입력 상한·사용자 결정 hash를 실행 조건으로 결합하며, 추가 입력 3회의 명시적 확인 전에는 새 승인/예산·root·state를 생성하거나 공식 Claude를 실행하지 않는다. 기존 계획 승인과 합성 PASS를 추가 실제 입력의 승인으로 해석하지 않는다. 실제 도구·저장/재개·중단의 수용과 공개 CLI·제품 provider·두 PC 검증은 계속 미완료다.


#### 공개 보정 뒤 실제 검사 준비 참조 갱신

[공개 프로토콜 보정](archive/018-claude-runtime-protocol.md)을 완료하면서 TaskPolicy의 컴파일 hash가 달라졌다. 원래 준비안과 실제 입력 기록은 고정하고, 별도 준비 파일에서 현재 코드 hash와 permit·사용자 결정·추가 승인·단회 예약·최종 저장의 파일 참조를 갱신했다. 도구 실행·같은 대화 재개·보류 파일 중단의 제어 흐름과 기존 입력 증명·정리·저장 계약은 유지한다.

변경 대상의 격리 검사를 새로 실행하고 새 독립 리뷰를 통과했다. 변경 없는 검증 모듈과 공개 TaskPolicy의 기존 리뷰는 hash가 같은 범위에서 재사용했다. 검증 수치와 현재 준비 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

현재 준비 파일도 실행 허가는 FALSE이며 사용자 결정·새 승인/예산·root·state·단회 예약은 생성하지 않았다. 이 참조 갱신은 추가 실제 입력 승인이나 실제 Claude·두 PC 수용을 만들지 않는다. 원래 세 UNKNOWN과 입력 상한·기록을 보존하고, 위에 정한 추가 실제 입력의 명시적 확인 조건을 유지한다.
