---
status: done
date: 2026-10-06
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code. Current implementation and native acceptance must be verified separately.

# Claude 실행 정책과 소유 이력 공급 연결

## Context

[022](../022-owner-local-ai-setup.md)의 Claude adapter와 중단 복구는 합성 검사를 통과했지만, 운영 호출자 세 곳은 실행 정책과 소유 이력을 공급하지 않는다. `cli/runtime-context.ts:17`, `cli/runtime-command.ts:29`, `settings/manager.ts:371`의 `new ClaudeAdapter()` 또는 reservation-only 생성이 그 지점이다. 상대 AI에 사람이 질문하는 [PRD](../../PRD.md)의 기본 흐름을 완성하려면 이 운영 공급이 필요하다.

이 계획은 현재 전체 구현 목표에 포함된 소스 연결이다. 022를 대체하거나 실제 Claude 지원의 완료 기준을 낮추지 않는다. 시작 정책·파일 이력·생성 호출자를 연결하고 합성 실행으로 검증한 뒤, 009의 별도 실제 입력 승인과 설치 버전의 검증을 거쳐 운영 admission을 연다. 그 전까지 기본 `POLICY_UNCONFIRMED`와 실제 입력 0회를 유지한다. 소스 작성이나 합성 증거로 실제 허용을 만들지 않는다.

범위 조사는 기존 `claude_native_admission_scope`의 호출자·역참조 결과와 추가 `claude_policy_primary_scope`의 공식 자료 조사를 재사용한다. 개인 설정이나 비공개 native 실험 이력은 이 계획 작성·합성 검증의 조사 입력이 아니다. 개인 로그인과 설정 파일을 수정·복사하지 않는다.

완료 기준:

- 운영 Claude 생성 세 곳이 같은 생성 함수에서 정책과 exact owned history를 받는다. 설정 관리자의 catalog 예약은 기존 내구 저널을 그대로 사용한다.
- 정책의 시작 확인·실행 중 변경 확인·명령 인자·환경 변수·이력 위치를 한 내부 구현이 소유한다. 호출자가 관련 CLI 인자나 경로를 조립하지 않는다.
- 검토된 설치 버전·실행 파일·설정 우선순위 근거가 없는 기본 실행은 child/사용자 입력/개인 이력 조회를 시작하지 않는다. 합성 증거는 공식 실행 파일의 admission을 열 수 없다.
- 읽기 전용 제한은 승인한 제품 MCP 도구에 한정된다. 개인 지침을 없애는 `--bare`, `--restricted`, 별도 로그인 프로필은 사용하지 않는다.
- 같은 소유 UUID의 읽기 전용 관찰·재개에만 정확한 transcript 경로를 사용한다. 다른 프로젝트·개인 세션 목록을 검색하지 않는다. 경로를 확정할 수 없으면 미확인이다.

## Official Evidence and Limits

- [설정 우선순위](https://code.claude.com/docs/en/settings): 세션의 `--settings`는 user/project/local보다 높고 managed보다 낮다. 권한 목록은 병합되므로 빈 allow 목록으로 읽기 전용을 보장할 수 없다. local 설정에는 main checkout root와 이전 cwd 파일이 적용될 수 있고, 실행 중 새 설정 파일도 반영된다.
- [훅](https://code.claude.com/docs/en/hooks#disable-or-remove-hooks), [플러그인 로딩](https://code.claude.com/docs/en/plugins/loading): managed 훅과 강제 플러그인은 개인 task overlay만으로 끌 수 없다. 모든 적용 source와 우선순위를 확인하지 못하면 실행을 허용하지 않는다.
- [CLI](https://code.claude.com/docs/en/cli-reference): `--tools`는 built-in 도구만 제한하며 MCP는 별도 제어가 필요하다. 재개에 절대 JSONL 경로를 지정할 수 있다. 새 session ID와 기존 transcript 재개를 구분한다.
- [소유 세션 저장](https://code.claude.com/docs/en/agent-sdk/sessions): 기본 경로는 현재 `CLAUDE_CONFIG_DIR` 또는 `~/.claude` 아래 `projects/<encoded-cwd>/<session-id>.jsonl`이다. 짧은 cwd는 비영숫자를 `-`로 바꾼다. [공식 Python 구현](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py)의 `_find_project_dir`는 긴 경로에서 CLI의 Bun hash와 SDK hash가 달라 prefix 검색으로 보정한다고 명시한다. 이 검색 알고리즘은 제품에 복사하지 않는다. 확인한 layout으로 exact 경로를 정할 수 없는 설치·긴 경로는 `CONTEXT_UNCONFIRMED`다.

위 자료는 현재 공식 문서의 설계 근거다. 과거 고정 설치 버전 `2.1.287`의 실제 시작·reload·재개·중단 수용 증거를 대신하지 않는다. 지원 범위 확정과 운영 허용은 실제 설치의 별도 검토 근거가 있어야 한다.

## Affected Files

1. 신규 `packages/local-connector/src/claude/launch-policy.ts` — 검토된 admission 근거, 실행 source snapshot, task overlay, 정확한 이력 위치와 변경 확인의 내부 책임.
2. 신규 `packages/local-connector/src/claude/configuration.ts` — canonical root·user/project/local/managed source 목록과 bounded 읽기, 존재하지 않은 파일의 생성·교체·링크 변경 확인. 인증 원문은 출력하거나 저장하지 않는다.
3. 신규 `packages/local-connector/src/provider-adapter.ts` — Codex/Claude 생성과 정책/history/catalog 공급. native 근거는 신뢰한 내부 코드에서만 공급하며 web/CLI flags/env에서 읽지 않는다.
4. `packages/local-connector/src/cli/runtime-context.ts`, `cli/runtime-command.ts`, `settings/manager.ts` — 기존 Claude 생성 세 곳과 같은 파일의 legacy Codex 생성을 공통 생성 함수로 교체한다. Codex 설정/runner 동작과 관리자의 catalog reservation 계약을 유지한다.
5. `packages/local-connector/src/cli.ts` — standalone capability 조회에 소유 profile과 catalog 예약을 공급하고 legacyRunner의 Codex 생성에도 같은 profile의 미해결 catalog guard를 적용한다.
6. 신규 `packages/local-connector/src/claude/catalog-store.ts` — standalone의 zero-input catalog context를 profile 아래에 내구 예약한다. settings 관리자의 기존 예약을 대체하지 않는다.
7. `packages/local-connector/src/claude/adapter.ts` — 새 context UUID 예약 직전의 optional 내부 guard 접점만 추가해 child-free validate/observe와 startup을 구분한다. 023의 중단·저장·종결 계약은 유지한다.
8. 신규/기존 connector 검사와 관련 정본 문서 — 아래 Tests 및 실제 미완료 조건에 한정한다.

## Affected Dependents

- `claude/adapter.ts`의 capabilities/prepare/validate/execute/observe는 기존 `ClaudePolicy` 및 `history` 접점을 사용한다. 도구 없는 중단의 내구 저장·barrier·UNKNOWN 복구를 변경하지 않는다.
- `claude/owned-history.ts`는 예약한 UUID basename, canonical parent, 소유 UID·단일 링크·group/other 권한 없음·16MiB·UTF-8·변경 검사와 full records를 유지한다. 현재 검사는 정확한0600 동등성 검사가 아니다. SDK의 요약 message나 최근 세션 조회로 대체하지 않는다.
- `settings/store.ts`와 `settings/manager.ts:328–366`의 catalog 저널은 generation/root/version/policy fingerprint를 유지한다. 기본 정책 거절은 예약과 child를 만들기 전에 발생한다.
- `cli/settings-lock.ts`는 profile의 기기 설정 잠금을 먼저 얻는다. standalone catalog와 같은 PC의 manage/legacy runtime 경쟁도 이 기존 순서를 따른다.
- `codex-adapter.ts`, `workflow-runner.ts`, `runtime-store.ts`, web/API/SQL 계약은 변경 대상이 아니다. 기존 Codex v1·owned outbox와 023 중단 증거의 타입·저장·종결 의미를 유지한다.
- 공개 capability에는 version/model/effort/policy 결과만 나온다. 실행 파일·config/history 절대 경로·credential·설정 원문은 중앙에 보내지 않는다.

## Implementation Steps

### [x] Step 1: 실행 source와 확인된 layout의 내부 정책
**File**: 신규 configuration.ts, launch-policy.ts

- 신뢰한 constructor 근거로만 정책을 생성한다. 기본 운영의 검토 근거는 아직 없으므로 기본 native admission은 닫힌다. version/hash 형식만 맞는 객체, 사용자 flag, 환경의 enable 값, 실험의 synthetic admission을 근거로 삼지 않는다.
- 합성 근거는 Node 합성 fixture 실행에만 적용한다. 같은 근거를 공식 Claude 실행 파일로 바꾸면 `POLICY_UNCONFIRMED`이며 공식 child/입력은0회다. 실험의 세 입력 budget과 store는 import하지 않는다.
- 근거는 설치 version·실행 파일 identity/hash·정책 구현 revision·확인한 설정 source/layout과 시작/reload 우선순위의 검토 범위를 결합한다. 정책 fingerprint는 source/root와 같은 의미를 가진 결정적 값이며 재시작 시 다시 확인한다.
- 설정 source는 user/project/local/managed 및 적용 instruction source를 분리한다. canonical cwd, git root/main checkout local/legacy local, 현재 config directory와 우선 source를 확인하지 못하면 거절한다. managed policyHelper·원격/MDM source의 완전성이나 실행 우선순위가 미확인이면 파일 부재만으로 NO_CONFLICT를 만들지 않는다.
- 파일은 canonical 부모·소유/링크·bounded 읽기·strict UTF-8·JSON을 검증한다. source의 부재도 snapshot에 포함하고 새 파일/폴더·교체·실행 파일·source 목록 변경에서 `SNAPSHOT_CHANGED` 또는 기존 미확인으로 닫는다. 개인정보 원문은 snapshot에 저장하지 않는다. 인증 갱신과 실행 정책 변경을 같은 것으로 판단하지 않도록 인증 파일의 실행 관련 부분만 사용한다.
- 명령은 shell 없이 공식 비변조 실행 파일을 호출한다. 개인 설정 source를 유지하고 task overlay로 확인한 hook/plugin을 제한한다. built-in 도구를 비우고 exact 제품 MCP allowlist·strict MCP·dontAsk를 적용한다. DIRECT에서는 `ask_peer`를 열지 않는다. 추가 provider fallback·background/subagent·권한 우회 flag·입력 prompt CLI arg는 넣지 않는다.
- 환경은 기존 provider 로그인/설정 선택을 유지하고 제품 DB/admin/bearer/LOCAL_ACCESS_/LOCAL_DEVICE_/LOCAL_WORKFLOW_/AI_COLLAB_ 값을 제거한다. 실행에 영향을 주는 shell 환경과 모든 source의 `env` 값을 정책 snapshot과 우선순위 확인에 포함한다. debug 로그에 개인 설정·인증·prompt를 남기지 않는다.
- 명시적인 선택 effort에는 세션의 child 환경과 task overlay `env.CLAUDE_CODE_EFFORT_LEVEL`을 같은 선택값으로 고정하고 `--effort`를 전달한다. 기존 개인 파일은 수정하지 않는다. [공식 환경 변수 문서](https://code.claude.com/docs/en/env-vars)에 따르면 이 환경 변수는 `--effort`보다 우선하므로 인자만으로 선택을 보장하지 않는다. managed 또는 실행 중 reload의 다른 값이 이 고정을 덮어쓸 수 있는 설치/source는 child 전에 거절한다. nullable effort에는 `--effort`를 생략하고 값을 임의로 채우지 않는다. 해당 모델에 inherited effort가 적용되지 않는다는 근거도 없으면 충돌값이 있는 null 선택을 거절한다. 설치별 실제 우선순위가 미확인인 상태를 합성 검사로 확정하지 않는다.
- 새 입력에는 예약 UUID의 `--session-id`를 사용한다. 재개에는 확인된 exact owned JSONL 경로의 `--resume`만 사용한다. 현재 config directory와 해당 설치에서 확인한 encoding/override가 없으면 다른 폴더를 검색하지 않고 미확인으로 남긴다.

### [x] Step 2: 세 생성 지점과 소유 catalog 예약 연결
**File**: provider-adapter.ts, runtime-context.ts, runtime-command.ts, manager.ts, cli.ts, catalog-store.ts, claude/adapter.ts의 context 생성 guard 접점

- 같은 생성 함수가 provider별 adapter를 반환한다. Claude에는 Step1 정책과 그 정책이 정한 exact history reader, 주어진 catalog reservation을 함께 공급한다. Codex는 기존 transportFactory 접점에서 미해결 catalog guard 확인 후 현재와 같은 CodexTransport를 생성한다. 기존 constructor/options와 wire 계약은 유지한다. 운영 호출자의 임의 실행 명령/정책 원문/secret 인자는 추가하지 않는다.
- SettingsManager의 기존 reserve callback은 그대로 사용한다. 기존 정책 미확인 검사에서 reserve callback·native child가0회인 기대를 보존한다. configuredRunner는 현재 generation의 저장된 root/context를 검증하는 정책/history를 받는다.
- standalone runtime-capabilities는 기존 기기 설정 잠금 안에서 profile-owned catalog ledger를 사용한다. root identity/version/fingerprint/generation/session UUID의 RESERVED context를 child 전에 file+directory fsync한다. 저장 실패는 child/입력0회다. 이 zero-input 예약은 등록된 binding 권한이나 MATERIALIZED/ready의 증거가 아니다.
- catalog ledger는 profile의 private 저장소 아래만 쓴다. 파일0600·디렉터리0700·canonical/UID/no links, bounded schema와 원자적 교체를 기존 저장 패턴대로 검증한다. 다른 profile/root/fingerprint의 예약을 재사용하지 않는다. 실패·미확인 child 정리를 새 UUID·다른 세션·자동 재시도로 숨기지 않는다. ledger/child 정리와 실행 잠금의 수명을 함께 검증한다.
- 기기 설정 잠금의 죽은 PID 회수는 native child 정리의 증거가 아니다. 같은 profile의 공통 guard는 standalone ledger의 미해결 RESERVED/UNKNOWN을 확인해, 프로세스 재시작 후 manage/catalog/current/legacy runtime 및 Codex 전환에서도 새 native session UUID·child를 차단한다. root/fingerprint 변경이나 catalog 파일·디렉터리의 이름 교체로 이 기록을 버리지 않는다. profile 부모의 별도 내구 identity 파일로 catalog 디렉터리의 이동·교체도 확인한다. 현재 standalone 작업만 자신의 정확한 reservation token/context로 통과할 수 있으며 PID 일치만으로 통과하지 않는다. 모든 운영 adapter 생성은 이 guard를 공유한다. native child를 만들지 않는 상태·로컬 이력 관찰의 허용 범위는 별도로 유지하고, Codex observe처럼 child를 만드는 경로는 guard를 통과해야 한다. 기본 Claude admission 거절은 guard의 ledger IO보다 먼저 처리한다. 정리 미확인 해소는 exact owned cleanup 증거가 생긴 경우에만 가능하며 실패한 기존 프로세스나 PID를 추정해서 죽이지 않는다.
- 공개 capabilities의 accountEligibility/finalInputIsolation 미확인 표시는 유지한다. native 모델 목록이나 세션 예약만으로 실제 질문 수용 완료를 표시하지 않는다.
- `ClaudePolicy.admit`는 validate/observe에서도 사용하는 정책 검사다. profile catalog guard를 여기에 넣어 child-free 소유 이력 관찰까지 막지 않는다. 새 prepare의 UUID 예약 직전에 optional 내부 guard를 호출하고, catalog 예약·native child 생성은 공통 생성 함수의 각 기존 접점에서 검사한다.

### [x] Step 3: 실제 adapter와 합성 저장소의 실행 연결 검사
**File**: 아래 connector 검사와 기존 fixture

- Step1/2의 모든 Tests를 실제 ClaudeAdapter+새 공통 생성 함수로 검사한다. 단순 결과 반환 adapter로 정책/history의 연결을 대신하지 않는다.
- 기본 정책은 개인 설정/이력 접근·catalog 저장·child·사용자 입력이 모두0회임을 확인한다. 합성 허용에서는 source snapshot/설정 보존·내구 catalog·동일 입력 observe/재개·중단 증거와 cleanup을 검사한다.
- 테스트가 실제 CLI나 personal profile을 발견하지 않게 constructor IO/transport를 기존 fixture에 주입한다. 모든 파일과 env는 소유 tmp fixture에 한정한다. compile·connector 전체·영향받은 root 소비 타입을 검사한다.

### [x] Step 4: 독립 리뷰와 운영 활성화의 남은 조건 기록
**File**: 관련 docs와 이 명세

- 새 독립 reviewer는 이 diff와 default admission, 합성 제한, 세 운영 호출자, source 목록/변경, exact transcript, catalog 내구·cleanup·잠금과 비밀 정보 projection을 검토한다. 실제 Claude/DB/두 Mac 검사를 하지 않은 범위를 명시한다.
- 소스·합성 연결과 리뷰가 끝나면 그 결과를 정본 문서와022의 공급 미완료 항목에 반영한다. 실제 검토 근거가 여전히 없으면 운영 admission 활성화와022의 실제 수용은 계속 미완료다.
- 이 소스 연결의 모든 Step와 필수 검사를 마친 경우에만024를 보관한다. 실제 native 검증·정책 활성화는022/009의 원래 성공 기준과 추가 입력 승인 경계에서 이어간다. Docker/Git 제한을 우회하거나 main을 병합하지 않는다.

## Tests

- 신규 `claude-launch-policy.test.ts`: should reject absent or malformed native evidence before any source or child access; should confine synthetic evidence to its exact Node fixture; should preserve user/project instructions while restricting exact product tools; should preserve provider auth and omit product credentials; should pin selected effort against inherited shell and settings env without changing defaults; should reject conflicting managed effort and unconfirmed nullable effort; should reject effort source changes during reload; should reject managed conflicts and unconfirmed sources; should detect existing and newly created policy sources and binary replacement; should distinguish authentication-only changes from policy changes; should use one exact owned transcript and reject unconfirmed long-path layout without scanning; should use reserved ID for first input and absolute owned transcript for resume.
- 신규 `claude-catalog-store.test.ts`: should durably reserve the exact root/version/fingerprint/session before the catalog child; should send nothing after file or directory sync failure; should reject foreign reservations and unsafe links; should preserve UNKNOWN and refuse automatic new reservations after incomplete cleanup; should reject ledger or catalog directory rename and replacement; should serialize same-profile catalog and settings commands.
- 신규 `provider-adapter.test.ts`: should preserve Codex construction; should supply policy and exact history to Claude setup/current/standalone callers; should retain default policy rejection with zero catalog/native/personal IO; should block new manage/current/legacy/native reservations after a dead standalone process leaves UNKNOWN; should block root or fingerprint changes and Codex transitions without owned cleanup; should allow only the exact current catalog reservation token; should recover the same tool-free interrupted input through the composed real adapter without another input.
- 기존 `runtime-settings.test.ts`와 `cli-settings.test.ts`: 기본 Claude의 catalog 예약0/child0, 현재 generation 선택, 보관 이력의 새 실행 금지, settings 잠금과 기존 Codex 명령을 유지한다. 새 검사 이름은 영어 `should + behavior` 형식을 따른다.
- 신규 provider 회귀는 미해결 catalog에서도 child-free Claude의 정확한 소유 이력 관찰을 허용하면서 새 prepare/catalog/child는 차단하는지 검사한다.
- 023의 `claude-adapter.test.ts`, `claude-runner-intent.test.ts`, `provider-runtime-store.test.ts` 대상47개와 전체 connector 회귀의 기대값을 유지한다. 실제 native/DB 입력은0회다.

## Risks

- 현재 공식 자료와 고정 구버전의 실행은 다르다. 기본 admission은 닫고 실제 설치 호환성을 웹 자료나 합성 증거로 자동 확정하지 않는다.
- managed 훅·플러그인과 새 source는 overlay보다 우선할 수 있다. source나 우선순위가 미확인이면 거절하고 허위 CONFIRMED 결과를 만들지 않는다.
- 긴 cwd의 JSONL hash는 공식 구현 간에도 차이가 있다. exact layout이 미확인이면 prefix나 전체 session 검색을 하지 않는다.
- catalog는 사용자 입력이 없는 관리 세션이다. host 예약·native 파일·실제 system/init·AI ready를 구분하고 기존 authority/intent 순서를 유지한다.
- 새 모듈은 별도 공개 설정 프로토콜이나 실험 store를 추가하지 않는다. 기존 RuntimeAdapter/ClaudePolicy/history/catalog 접점에서만 연결하고 권한 경계를 독립 검토한다.

## Verification

- Node24 connector TypeScript build와 신규 대상 Node test를 실행한다. 이후 connector 전체를 `--test-timeout=180000 --test-concurrency=1`로 검사한다.
- application/integration/E2E TypeScript를 검사한다. root unit207 결과는 대상 코드와 입력이 같을 때만 재사용한다.
- lint 경고0, `npm run format`, `npm run format:check`, `git diff --check`와 관련 문서 링크를 확인한다.
- 공식 Claude/Codex·Docker/DB/browser를 실행하거나 개인 native history를 읽지 않는다. Git metadata는 쓰지 않는다. 이 검증은022의 실제 현장 수용을 대신하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan1: unresolved standalone catalog across process restart | HIGH | ACCEPTED | Step2 requires a profile-wide guard for every current/legacy/manage/provider startup, including Codex transportFactory, exact own reservation token and restart/root/fingerprint/provider-change regression cases. Dead lock PID does not prove child cleanup. |
| Plan1: effort environment outranks CLI selection | HIGH | ACCEPTED | Step1 snapshots shell/settings/managed env, pins the explicit effort in child and task overlay, rejects unprovable managed/reload/null conflicts before child, and adds conflict/reload tests. Current docs remain separate from installed native proof. |
| Plan1: history mode described as exactly0600 | INFO | ACCEPTED | Affected Dependents now describes the existing group/other permission check accurately; the reader and its current contract are unchanged. |

계획 리뷰1: REVISE C0/H2/M0/L0/INFO1. 위 세 지적을 채택해 본문과 검사에 반영했다.

계획 리뷰2: PASS C0/H0/M0/L0/INFO0. 명세·기준 소스·보관본35개 hash와 Claude 생성3곳·Codex 생성5곳을 대조했다. source 연결 구현을 진행하며 실제 native admission은 닫힌 상태를 유지한다.

구현 중 접점 보정: 정책 admit가 prepare/validate/observe에서 공용인 것을 확인했다. Step2의 startup 한정 차단과 child-free 이력 관찰을 함께 유지하려고 adapter의 context 생성 직전 guard 하나를 소유 범위에 추가했다. 외부 동작·계약 확장이 아니며 구현 독립 리뷰는 이 추가 diff와 회귀를 포함한다.

## Implementation Review

구현 리뷰1: PASS C0/H0/M0/L0/INFO0. 신규 독립 reviewer가 운영9개·검사/fixture6개 diff와 입력36개 SHA를 시작·종료에 확인했다. 기본 정책의 IO 이전 거절, 정확한 Node fixture 제한, 공통 생성 함수, source/환경 변경·비밀정보 제거·effort 고정·소유 JSONL, catalog 내구 예약·token/UNKNOWN·부모 identity·Codex 전환과 child-free 관찰을 확인했다. 023 중단 증거 계약은 유지한다. 차단 지적과 남은 MEDIUM/LOW는 없다.

마지막 catalog 디렉터리 이동·교체 보정 뒤 Node24 build와 영향 검사55/55, 전체connector443/443(실패·취소0), application/integration/E2E 타입·lint 경고0·format/check·diff를 확인했다. rootunit207 결과는 영향받지 않은 소스·입력 범위에서023의 통과를 재사용했으며 새 실행으로 주장하지 않는다. 보정 전118/442는 역사적 검사로 보존하고 마지막 변경의 근거로 확대하지 않았다. 정본 문서는 모듈 경계·업무 규칙·검증 상태를 갱신했다.

이 종료는 정책·이력 공급의 소스와 합성 연결만 완료한다. 기본 운영은 실제 설치의 검토 근거가 없어 POLICY_UNCONFIRMED이며 공식CLI·개인 설정/이력·DB/HTTP/browser·두 Mac 검증과 Git metadata 쓰기는0회다. 009의 추가3회 사용자 승인은 유지하지만 현재 파일 쓰기 제한과 원본 first-probe/설치 identity 누락으로 실제 실행 조건을 충족하지 못했다. 022의 실제 수용은 계속 active이며 이 명세를 그 성공 근거로 사용하지 않는다.
