---
status: active
date: 2026-10-07
risk-surface: auth, permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 공식 Claude 연결과 같은 대화의 후속 질문

## Context

[PRD의 AI 채팅방](../PRD.md#ai-채팅방)과 022의 실제 Claude 연결을 끝내기 위한 보정이다. 사용자는 2026-10-07 사람이 원하는 상대 AI에게 질문하고 답변 뒤 계속 채팅하는 의도를 다시 확인했다. 자동 공동 조사의 방향 수정과 개인 설명의 별도 저장은 이 기본 채팅의 선행 조건이 아니다. 질문자의 AI·경로는 계속 선택 사항이다.

기준 코드는 `9276f867ed845119b2ffad4520b9233f13b18fc9`다. 제품의 기본 Claude factory는 실제 설치 근거를 만들지 않고, 합성 Node fixture만 신뢰하는 정책을 사용한다. 공식 설치와 기존 로그인은 있어도 기본 경로는 `POLICY_UNCONFIRMED`로 끝난다. 실제 설치를 발견하고 검증하는 경로를 추가한다. 합성 검증의 boolean을 공식 실행 허가로 바꾸지 않는다.

또한 현재 `proveOwnedHistory()`는 저장 JSONL에도 stdout의 init/result가 있다고 가정한다. 실시간 완료와 저장 대화의 재개 검증을 구분해야 한다. 실제 typed result를 확인한 입력에는 정확한 native 기록의 체크포인트를 남긴다. 저장 assistant 본문만으로 미확정 실행을 완료 처리하지 않는다.

이 보정은 사용자의 전체 구현·감독 위임과 승인된 022의 재작업 범위에서 진행한다. 기존 009의 추가 최대3회 승인 묶음은 첫 입력1개의 UNKNOWN 뒤 중지했다. 2026-10-08 사용자는 새 검증 최대3회·전체상한7회를 승인했다. 새 묶음의 첫 입력1개는 공식 초기화·입력 ACK 확인 뒤 최신 도구 metadata에서 UNKNOWN이 됐다. 두 묶음 모두 다음 입력 자동 실행0이며, 원래 UNKNOWN·예산·lock·메시지·승인은 불변 보존한다. 실제 수용은 Step4에서 확인하며 수치와 현재 상태는 검증 정본에 유지한다.

## Affected Files

1. 신규 `packages/local-connector/src/claude/native-installation.ts` — macOS 공식 설치 발견, 실행 파일 identity·지원 버전·게시자·읽기 전용 로그인 상태 검증, 실제 설정 위치와 managed source 확인.
2. 신규 `packages/local-connector/src/claude/{native-policy,native-sources}.ts`, 기존 `configuration.ts` — 공식 admission·설정 발견과 작업별 제한을 분리한다. 실행 파일을 제한된 크기로 해시하고 정확한 owned transcript와 UUID resume를 제공한다. 기존 합성 `launch-policy.ts`는 변경하지 않는다.
3. `packages/local-connector/src/provider-adapter.ts` — 세 운영 호출자가 공유하는 factory에 기본 native 정책 공급. 합성 constructor seam과 catalog 차단은 유지.
4. 신규 `packages/local-connector/src/claude/{native-history-proof,native-interruption-records}.ts`, `claude/{adapter,input-proof,owned-history,history-proof}.ts` — native JSONL 전용 검증·체크포인트와 실시간 typed result 연결. 기존 합성 stream 이력 증명은 보존.
5. `packages/local-connector/src/{runtime-contracts,runtime-store,workflow-runner}.ts` — Claude 전용 선택적 native 이력 체크포인트를 정상 완료 입력에 내구 저장하고 보관 뒤에도 재개에 사용. Codex v1과 기존 Claude 증거의 호환을 유지.
6. 관련 connector 테스트·fixture와 `docs/{README,PRD,ARCHITECTURE,BUSINESS-LOGIC}.md`, `docs/guides/onboarding-and-settings.md`, `docs/research/ai-runtime-integration.md`, `docs/planning/{delivery-and-validation,decisions-and-open-items}.md` — 회귀 검사, 기본 채팅의 완료 조건과 실제 미검증 조건 정리.

## Affected Dependents

- `settings/manager.ts`, `cli/{runtime-context,runtime-command}.ts` — factory 생성자·공급자 선택 계약을 유지한다. native 설치가 없거나 지원되지 않으면 고정 오류를 반환한다.
- `claude/{catalog-store,transport,input-proof,policy}.ts` — 생성 전 내구 예약, exact MCP·ACK·도구·중단·typed terminal, 소유 child 정리와 UNKNOWN 차단을 유지한다.
- `codex-adapter.ts`, `runtime-archive.ts`, 설정 generation 저장 — Codex 이력·terminal·v1 디코더와 보관 계약을 변경하지 않는다.
- 웹의 DIRECT 예약·대상 epoch·단일 답변·재전송 — 웹/DB/API 계약을 바꾸지 않는다. 답변 제공자의 기존 runner가 계속 처리한다.
- 활성 009/022/027/029 — 이 계획의 소스 통과와 실제 공급자·DB·두 Mac 수용을 구분한다. 완료되지 않은 수용을 완료로 표시하지 않는다.

## Implementation Steps

### [x] Step 1: 실제 설치와 설정을 검증하는 기본 실행 정책

**File**: native-installation, native-policy, native-sources, configuration, provider-adapter

- 회귀 검사에서 기본 factory가 공식 설치의 검토 근거를 공급할 수 없는 현상을 먼저 재현한다.
- macOS native 설치의 entry symlink와 canonical target을 구분한다. 실행은 확인한 target만 사용한다. 파일·상위 디렉터리·소유권·쓰기 권한·크기·변경 여부를 확인한다. 코드 서명 검증은 고정 `/usr/bin/codesign`과 Anthropic 식별자로 수행한다. 실패나 확인 불가는 성공으로 바꾸지 않는다.
- 공식 CLI의 `--version`과 `auth status`는 bounded 읽기 전용 child로 확인한다. stderr·이메일·조직 이름·인증 원문을 공개하지 않는다. 새 로그인·토큰 복사·업데이트를 실행하지 않는다. 현재 서명된 2.1.288·2.1.293의 지원 근거를 확인하고 검토하지 않은 버전은 거절한다. inherited/settings의 미검증 custom authentication headers는 probe 전에 거절한다.
- auth status가 보고한 실제 config/projects 위치를 대조한다. 초기 지원은 기본 `~/.claude` 프로필이며 다른 `CLAUDE_CONFIG_DIR`는 global config 위치를 검증하기 전까지 거절한다. 기존 프로필을 이동하거나 복사하지 않는다. user/project/local 및 root/worktree local 설정을 발견한다. 임의 추가 working directory, 환경의 별도 설정 source, command helper 등 실행 권한을 확정하지 못하는 조합은 이유를 보존해 거절한다.
- 초기 검증 범위는 macOS의 개인 Claude 구독 로그인이다. Team/Enterprise의 원격 managed policy와 미검증 endpoint-managed policy는 무조건 개인 구독으로 해석하지 않는다. managed 파일·drop-in·MDM·remote cache의 존재·변경과 로그인 유형을 확인한다. 검증할 수 없는 managed source는 명시적으로 미지원이다. 조직 정책을 끄거나 우회하지 않는다.
- 전역·프로젝트 지침과 설정 파일은 그대로 둔다. native 실행의 작업별 overlay로 hooks와 확인하지 않은 configured/builtin plugin 실행을 제한한다. built-in tool set을 비우고 strict MCP·dontAsk·정확한 제품 도구만 적용한다. managed 우선순위와 설정 재적용에 관한 공식 문서 근거를 기록한다.
- 선택 모델·effort를 해당 실행에만 적용한다. effort null은 개인 기본값 유지로 처리하고 실제 관찰은 계속 UNVERIFIED로 구분한다. 자동 재개·배경 실행·transcript GC 등 소유 입력/이력 검증을 깨는 작업별 동작을 고정한다. 대화 기록을 끄는 상속 설정은 개인 파일을 바꾸지 않고 작업 환경·overlay에서 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=0`으로 고정한다.
- Claude 자체가 갱신하는 로그인·캐시·시작 횟수를 실행 권한 변경으로 오판하지 않도록 native global config의 권한 관련 projection을 정의한다. 계정·조직 전환과 실제 실행 설정 변경은 계속 검출한다. 합성 source 정책의 의미는 유지한다.
- executable hash는 파일 전체를 한 Buffer에 올리지 않고 고정 크기 descriptor 읽기로 계산한다. identity가 같으면 기존 hash를 재사용하고 변경되면 안전하게 중단한다.
- 변경 없는 지침의 import 목록은 재사용한다. 매 권한 검사에서 각 파일 identity와 새로운 설정·지침의 생성을 확인하고 변경은 차단한다. 게시자·버전·관리 정책·로그인 실패는 비밀 원문 없이 고정 단계 이름으로 구분한다.

### [x] Step 2: 정상 완료의 native 기록 체크포인트

**File**: native-history-proof, owned-history, runtime-contracts, runtime-store

- 정확한 예약 UUID의 native JSONL만 기존 bounded reader로 읽는다. 다른 개인 대화를 탐색하거나 수정하지 않는다. native 형식은 stream 형식과 명시적으로 구분한다.
- native user/assistant의 session·cwd·UUID·부모 연결·순서·중복·입력 본문을 검증한다. 허용하는 보조 행은 지원 버전별로 명시한다. 모르는 형식은 성공으로 보정하지 않는다.
- 실시간에서 검증한 user/assistant·도구 결과와 native 기록을 대조한다. typed result가 있는 정상 종결에만 해당 기록의 prefix 길이/hash와 입력 연결을 체크포인트로 만든다. 단순히 읽은 파일을 해시해 신뢰하지 않는다.
- native 이력 증거는 Claude 전용 선택 필드이며 VERIFIED 체크포인트 또는 UNVERIFIED 상태를 promptHash·resultHash·owned turn과 함께 불변 저장한다. VERIFIED는 형식 버전·기록 prefix 길이/hash를 포함한다. UNVERIFIED는 private 경로나 원문을 포함하지 않는 고정 이유만 저장한다. 기록 보관 이후에도 같은 context에서 사용할 수 있게 한다. Codex/v1과 기존 stream형 Claude 기록은 그대로 읽는다.
- 기존 prefix 변경·삭제·삽입·외부 입력·다른 세션·누락·실시간 본문 불일치는 거절한다. native JSONL에 init/result가 없다는 이유만으로 이미 확인된 정상 완료를 미확정으로 바꾸지 않는다.

### [x] Step 3: 같은 대화에서 후속 질문 실행

**File**: adapter, history-proof, workflow-runner, native-policy

- 실제 native 이력과 정상 완료 체크포인트의 재개 검증을 기존 stream 이력 재생과 분리한다. `NativeInputProof`의 실시간 검증을 느슨하게 바꾸지 않는다.
- 정상 typed result와 소유 child 정리를 확인한 뒤 정확한 native 이력을 대조해 VERIFIED 체크포인트를 terminal에 연결한다. 이력 누락·읽기 거절·대조 실패는 terminal의 UNVERIFIED 상태로 기록한다. 이미 검증한 live typed result를 버리거나 UNKNOWN으로 바꾸지 않는다. runner는 기존 terminal 내구 저장과 ownedTurns 확정에서 이 상태를 보존하며 terminal 게시·동일 게시 재시도는 그대로 수행한다. 소유 child 정리 실패와 권한 상실의 기존 처리 의미는 바꾸지 않는다.
- UNVERIFIED 이력은 다음 resume 입력만 차단한다. 정상 완료 기록과 이력 미확인을 구분하며 새 session이나 새 입력으로 자동 우회하지 않는다. 이력 검증 실패를 해결하더라도 기존 완료 증거와 UNVERIFIED 기록을 덮어쓰지 않는다.
- 두 번째 DIRECT 입력 전에 이전 체크포인트와 전체 소유 입력을 검증한다. 같은 context의 exact UUID를 `--resume`에 사용하며 새 session을 만들지 않는다. 절대 경로 문자열을 display name으로 해석하는 resume에 기대지 않는다.
- 로컬 typed terminal이 없는 UNKNOWN에 native assistant 본문만 있으면 관찰 결과는 계속 미확정이다. 재전송·새 입력·새 맥락을 자동 생성하지 않는다. 기존 durable terminal의 게시 재시도는 유지한다.
- 정상 답변·후속 질문·중단·동일 UUID 재접속, 보관 뒤 검증과 실패 뒤 provider 전환 차단을 회귀 검사한다.

### [ ] Step 4: 기존 승인 범위의 실제 수용 준비와 실행

**File**: 격리 검증 산출물, 실제 실행의 준비 기록

2026-10-08 같은 승인 묶음의 첫 정상 답변과 같은 UUID의 후속 답변은 실제 typed COMPLETED·도구·이력 대조·REAPED와 독립 리뷰를 통과했다. 보조 기록 형식 때문에 driver가 남겼던 원래 UNKNOWN은 불변 보존하고 검증된 상태만 별도 projection에 연결했다. 세 번째 중단 입력은 공식 MCP 취소 알림 뒤 typed result가 없어 UNKNOWN이다. 입력3/3과 누적상한8을 소비했으며 다음 실제 입력은 자동 실행하지 않는다. 보정 소스·회귀·독립 리뷰는 통과했지만 실제 중단 수용과 종료 검토가 남아 Step4는 `[ ]`다. 구체적 증거와 현재 입력 승인 상태는 [진행 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

- 최종 소스·설치 identity·공식 프로토콜·정확한 설정/이력 위치·합성 root/state·기존 승인·입력 예산과 소유 정리 조건을 묶어 독립 리뷰를 받는다.
- 현재 환경에서 서명·이력 쓰기·개인 설정 보존을 확인할 수 있는지 실제 결과로 판단한다. 도구의 제한을 외부 터미널·새 프로필·권한 확대·토큰 복사로 우회하지 않는다.
- 실행 시점에 확인한 사용자 승인·묶음별 예산·누적 상한 안에서 정상 도구 답변 → 같은 UUID 후속 질문 → 중단을 확인한다. 처음부터 준비한 순서대로만 실행하며 한 번이라도 종결/정리가 미확정이면 다음 입력을 중지한다. 과거 UNKNOWN 묶음의 남은 슬롯을 자동으로 새 검증에 사용하지 않는다.
- 실행할 수 없으면 입력 0회와 구체적인 환경 조건을 기록하고 준비된 동일 검증 명령을 제공한다. 실제로 실행하지 않은 수용은 [x]로 바꾸지 않는다. 두 Mac 실제 질문·답변은 별도 현장 수용으로 유지한다.

### [x] Step 5: 문서·리뷰·작업 기록 정리

**File**: 정본 문서, 이 계획, 검증 기록

- 기본 채팅의 완료 조건에 사람의 후속 질문을 명시한다. 자동 공동 조사의 방향 수정과 개인 설명은 후속 기능으로 표시한다. 기존 자동 조사 기능은 삭제하지 않는다.
- 실제 소스 상태, 합성 검사, 공급자 실행, DB/browser/두 Mac 수용을 구분하고 진행 수치는 delivery 한 곳에 유지한다. 기존 UNKNOWN·실패·보관 명세는 수정하지 않는다.
- 필수 검사와 독립 reviewer의 권한·native 이력·저장 호환 검토를 완료한다. 통과한 unchanged 검사는 재사용한다. 커밋 전에 format·format:check를 실행한다. 기본 브랜치 병합은 하지 않는다.
- 실제 수용을 포함한 이 계획의 모든 항목이 완료된 경우에만 done/archive로 옮긴다.

## Tests

- `claude-mcp-cancellation.test.ts` — 소유 입력의 typed MCP ID·내구 중단과 cancellation 결합, 다른 입력·반복·늦은 취소와 ACK 경합 차단.
- `claude-native-interruption.test.ts` — 취소 설명은 종결·읽기 권한이 아닌 보조 기록이며 typed interruption과 같은 도구의 내구 취소에 결합한다. 실제형 adapter의 checkpoint·소유 종료·재접속을 격리 검사한다.

- `should admit a verified native Claude installation through the default factory` — 공식/합성 분리, 기본 경로의 실제 정책 공급.
- `should reject unverified installation, publisher, version, managed sources and account changes before model input` — 위조 객체·설치 교체·미지원 managed/login·다른 config·새 source/command helper·drift.
- `should preserve personal settings and instructions while applying read-only task overrides` — 실제 native argv에 fixture가 없음, hooks/plugins/MCP/tools 제한, 모델·effort·기본값과 파일 불변.
- `should ignore native bookkeeping refresh and retain authority drift detection` — 시작 횟수/캐시·정상 인증 갱신 허용, 계정/조직·명령·설정 변경 거절.
- `should checkpoint native conversation only after a matching live terminal` — init/result 없는 native 대화, 실시간 메시지·도구·prompt/result 연결, 삭제/변조/다른 입력/불완전 기록 거절.
- `should resume a second direct question with the same native session after archival` — 정확한 UUID와 앞선 checkpoint, v1/Codex/합성 호환.
- `should keep native history without durable terminal unknown` — 저장 assistant·process exit·interrupt ACK만으로 완료/재입력하지 않음.
- `should preserve live terminal when native checkpoint cannot be verified` — typed result 뒤 이력 누락·읽기 거절·내용 불일치에서도 terminal과 owned turn에 UNVERIFIED를 저장하고 게시·게시 재시도를 유지하며 다음 native 입력은0회. adapter/runner/store와 보관 뒤 재접속을 함께 확인한다.
- 기존 provider factory·launch policy·adapter·owned history·runner·runtime store·선택/자동 코드 도구 검사를 유지한다.

## Risks

- 공식 CLI의 저장 형식과 공개 stdout 형식은 다르다. 설치·경로·형식 가정을 실제 수용으로 확인할 때까지 실제 통과로 표시하지 않는다.
- managed 정책과 개인 설정의 우선순위가 실행 중 바뀔 수 있다. 검증하지 못하는 managed 조합은 거절하고 사용자 정책을 편집하지 않는다.
- checkpoint만으로 UNKNOWN을 정상 완료로 만들면 오판한다. live typed terminal과 그 입력의 내구 증거가 필수다.
- source snapshot이 CLI의 정상 bookkeeping 갱신을 차단할 수 있다. auth/global projection을 명시적으로 제한하고 권한 필드 변경은 별도로 검출한다.
- 긴 session과 큰 실행 파일은 메모리를 소모한다. 현재 bounded JSONL 제한과 streaming binary hash, metadata cache를 유지한다.

## Verification

- Node24로 connector의 관련 회귀 RED → GREEN, 전체 connector test·typecheck·build.
- root unit·기존 HTTP 계약 회귀에 영향이 있는 경우 해당 검사. 웹·DB 계약은 변경하지 않는다.
- 루트 typecheck는 기존 `.next` 입력으로 실행하고 preview 재시작·Next build/typegen은 하지 않는다.
- lint·format·format:check·diff check, 독립 plan/implementation review.
- 실제 CLI 입력 횟수·정리·개인 설정 불변·동일 session 후속 질문의 실행 기록. 환경상 불가한 항목은 구체적으로 남긴다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| checkpoint 실패가 확인한 live terminal을 잃게 함 | HIGH | ACCEPTED | Step2/3과 통합 회귀에 VERIFIED/UNVERIFIED 내구 저장을 추가했다. 이력 실패는 다음 resume만 차단하며 terminal 저장·게시 재시도와 UNKNOWN의 의미를 유지한다. |
| 지침 import가 구조화된 설정 검사를 제거함 | HIGH | ACCEPTED | 같은 경로의 user/project/local/auth 항목과 projection을 유지한다. import 충돌의 helper 거절·plugin 제한 회귀를 추가했다. |
| custom headers가 기존 로그인 확인을 우회함 | HIGH | ACCEPTED | inherited/settings env 양쪽의 미확인 `ANTHROPIC_CUSTOM_HEADERS`를 probe 전에 거절한다. |
| 대화 기록을 끄는 설정이 후속 질문을 차단함 | HIGH | ACCEPTED | 작업 env·overlay에서 기록을 켜고 같은 UUID resume 인자를 유지한다. 개인 파일은 바꾸지 않는다. |
| 실행 파일 상위 디렉터리의 교체가 가능함 | HIGH | ACCEPTED | 전체 상위 경로의 소유권·쓰기 권한을 admission과 재검증에서 확인한다. private 경로는 본인 소유를 요구하고 외부 root-owned sticky 시스템 디렉터리의 조건을 명시한다. |
| 입력 접수 기록 저장 중 동시 수신한 알림이 뒤 종결의 봉인을 먼저 봄 | HIGH | ACCEPTED | 최신 CLI 메시지 보정의 독립 리뷰1에서 확인했다. 사용량 알림만 수신 즉시 검증하고 내구 기록 저장·권한 재검사를 기다리도록 보정했다. 실제로 늦게 도착한 알림은 거절하며 새 독립 리뷰2에서 해소를 확인했다. |
| 종결 수신 뒤 도착한 native MCP 취소가 내구 종결 증거를 늘릴 수 있음 | HIGH | ACCEPTED | 수신 진입과 ACK 저장 대기 뒤 terminalReceived를 검사하고 두 경합의 실패 재현을 보정했다. 별도 소스 리뷰2에서 해소를 확인했다. |

### 2026-10-08 최신 CLI 메시지 보정

실제 입력에서 관찰한 최신 도구 메타와 사용량 알림을 소유 입력의 검증에 연결했다. 이전 메타 호환과 도구 ID·이름·인자 대조를 유지한다. 상태 알림은 입력·도구·종결 권한을 만들지 않는다. 동시 수신 경합을 추가 보정한 뒤 독립 리뷰2를 통과했다. 관련 검사와 실제 수용의 구분은 [검증 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다. 기존 미확인 실행과 예산을 보존하며 Step4는 미완료로 유지한다.

## Completion State

Step1–3의 소스와 Step5의 정본 문서·필수 검사·독립 리뷰를 완료했다. 구현 리뷰1의 HIGH4를 수용해 보정했고 재리뷰2는 ACCEPTED다. 기존 계획 리뷰의 terminal 손실 HIGH도 유지·보정한 상태다. 전체 검사의 기존 timeout과 실제 수용 미완료는 INFO로 보존한다. 이 명세는 Step4가 남아 있어 active로 유지하며 완료 보관하지 않는다. 현재 수치·실행 조건·원본 실패와 후속 범위는 [검증 정본](../planning/delivery-and-validation.md#현재-진행-상태)을 따른다.
