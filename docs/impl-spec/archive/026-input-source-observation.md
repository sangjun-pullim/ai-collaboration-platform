---
status: done
date: 2026-10-06
risk-surface: permission
completion-scope: local-source-only
---
> NOTE: This is the plan, not a description of the code. Current implementation and acceptance must be verified separately.

# AI 입력 당시의 저장소 관찰 기록

## Context

[제품의 결과 요구](../../PRD.md#결과와-다음-작업)와 [근거 규칙](../../BUSINESS-LOGIC.md#근거와-결론)은 답변을 당시 저장소 버전과 파일 근거에 연결한다. 실제 실행 기록에는 질문·종결·공유 문장이 있지만, 입력 당시 commit/ref와 선택 파일 hash를 묶은 기록은 없다. 등록 저장소의 현재 정보나 AI 답변 hash는 과거 파일의 근거가 아니다.

전체 구현을 계속하라는 기존 승인으로 이 계획을 작성한다. 독립 계획 리뷰 후 구현한다. 필수 planner 조사의 실제 저장 경계·호출부를 아래 단계에 반영했다. 이번 단계는 로컬 입력 관찰의 내구 보존까지다. 중앙의 당시 공유 별칭·답변 이력 연결, 결과 분류·사람의 해결 확인은 다음 경계에서 다룬다. 이 단계만으로 PRD의 공동 결과 수용을 완료했다고 표시하지 않는다.

개인 설명의 저장 위치와 방향 수정의 적용 범위는 사용자 답변을 기다린다. 실제 Claude 실행·두 Mac 수용, Docker/HTTP와 개인 이력 쓰기의 현재 제한, 승인된 실제 입력 예산은 바꾸지 않는다.

완료 기준:

- 두 provider의 기존 `beforeSubmit`에서 허용한 root·파일을 다시 검증한 뒤 관찰을 한 번 저장한다. `PROVIDER_INTENT`와 관찰을 같은 저장으로 확정한 뒤에만 adapter가 native 입력을 진행한다.
- 관찰은 선택 root 기준 상대 경로와 SHA256, 파일 검증 시각, 해당 root를 포함하는 Git 저장소의 commit/ref·Git 관찰 시각을 포함한다. Git을 확인할 수 없으면 null로 보존하고 dirty는 `unknown`으로 유지한다.
- 관찰은 당시 허용 파일 집합의 기록이다. 모든 파일의 원자적 snapshot, AI가 실제 인용한 파일, 도구 실행·검증 통과 또는 native 입력 성공의 증거로 표시하지 않는다.
- 새 관찰을 추가할 공간을 첫 claim 전부터 계산하고 provider 저장까지 예약한다. 기존 2MiB·종결 예약·작업 한도를 유지한다. 크기가 작은 파일 집합에 일률적인 최대 예약을 적용하지 않는다.
- 저장 후 관찰은 불변이다. UNKNOWN·terminal·정확한 outbox 재전송·observe·archive·설정 교체를 거쳐 보존한다. 과거 기록에 관찰이 없으면 현재 저장소 정보로 채우지 않는다.

## Affected Files

1. `packages/local-connector/src/runtime-contracts.ts` — 로컬 `SourceObservation`과 AttemptJournal의 선택 필드 정의.
2. `packages/local-connector/src/workflow/source-snapshot.ts` — 신규 내부 모듈. 제한된 수집·검증·hash·직렬화 크기 계산을 묶는다.
3. `packages/local-connector/src/runtime-store.ts` — 두 저널 버전의 exact schema, 관찰 추가 경계·불변·현재 generation 대조.
4. `packages/local-connector/src/workflow-runner.ts` — claim 전 용량, provider 직전 수집과 원래 mutation의 저장·예약 해제 연결.
5. 신규 `packages/local-connector/tests/source-snapshot.test.ts` — 관찰·Git 실패/취소·경로와 크기 경계.
6. 신규 `packages/local-connector/tests/source-observation-store.test.ts` — 기존 store fixture로 schema·전이·세대 보존·보관 검증.
7. 신규 `packages/local-connector/tests/source-observation-runner.test.ts`, 필요 시 `tests/runner-fixture.ts` — 두 provider와 저장 실패·권한 상실·복구 검사. 기존 fixture 확장만 사용한다.
8. `docs/ARCHITECTURE.md`, `docs/BUSINESS-LOGIC.md`, `docs/GLOSSARY.md`, `docs/README.md`, `docs/planning/delivery-and-validation.md` — 부모가 담당하는 현재 경계·용어·탐색·검증 기록. 기존 보관 명세는 수정하지 않는다.

운영 코드 범위는 위 4개다. CLI·provider adapter·registration·공개 계약·DB·브라우저는 이 계획의 변경 대상이 아니다.

## Affected Dependents

- `codex-adapter.ts:938`와 `claude/adapter.ts:321`의 파일 검증 및 `beforeSubmit` 호출: 현재 검증 뒤 다른 await가 있어 공통 runner 경계에서 다시 대조한다. callback·native ACK 계약은 유지한다.
- `workflow-runner.ts:348–357,769–782,1421–1453`: admitExecution·ready·provider-intent가 변경되는 연결점이다. active monitor·lease·terminal·UNKNOWN·observe·outbox는 기존 권한과 순서를 유지한다.
- `runtime-store.ts:240–280,938–1198`: v1/v2 journalSchema와 validateChange가 선택 필드를 검증한다. 기존 NOT_STARTED·UPLOADED·nativeIntent 제약은 유지한다.
- `runtime-store.ts:1565–1645`와 `runtime-archive.ts`: 원래 저널 전체 byte를 보관·복원하므로 별도 projection을 추가하지 않는다. 새 hash의 보관 증거를 기존 파일 hash와 혼동하지 않는다.
- `runtime-file-policy.ts:62–209`: root는 `record.context.root`, 파일은 `record.settings.files`다. RuntimeSettings에는 cwd가 없다. root identity와 선택 파일 검증을 그대로 사용한다.
- `workspace-registration.ts:84–129`: 기존 제한된 readonly Git 실행 패턴을 참고한다. 현재 registration의 commit/branch/dirty 값으로 과거 관찰을 채우지 않는다.
- `cli/runtime-command.ts`, `settings/manager.ts`, 원래 runner/store/Claude 보관 검사와 integration fixture: 기존 생성자 호출과 과거 저널의 호환성을 유지한다.

## Implementation Steps

### [x] Step 1: 작은 관찰 계약과 제한된 수집 모듈
**File**: runtime-contracts.ts, 신규 workflow/source-snapshot.ts와 source-snapshot.test.ts

- `AttemptJournal.sourceObservation?: SourceObservation`을 정의한다. 별도 로컬 version1 관찰은 `kind: INPUT_SOURCE_OBSERVATION`, `git: { observedAt, commit, ref, dirty: unknown }`, `files: { validatedAt, pathBase: SELECTED_ROOT, entries: { path, hash }[], manifestHash }`, `observationHash`만 받는다. null은 Git commit/ref의 미확인값에만 쓴다. 절대 root·dev/ino/mtime·파일 내용·개인 설정·native ID·현재 별칭을 넣지 않는다.
- 시각은 UTC ISO의 정규 형식이고 commit은 소문자 40/64hex 또는 null, ref는 기존 isBranch의 120자 ASCII 경계 또는 null이다. 파일은 기존 isSelectedPath·SHA256·최대32개·중복 금지 경계를 적용한다. entries는 상대 경로의 코드 단위 순서로 정렬한다. `manifestHash = digest(stableJson(entries))`, `observationHash = digest(stableJson(관찰에서 observationHash를 제외한 객체))`다. 중복·알 수 없는 필드·hash 불일치는 저장 경계에서 거절한다.
- 모듈이 수집과 유효성·용량 계산을 숨긴다. runner/store가 각각 Git·경로·hash 규칙을 복제하지 않는다. 필요한 작은 함수만 내부 패키지에 노출하고 외부 API·CLI 옵션을 추가하지 않는다. 검증은 예외 없는 predicate 또는 일관된 기존 RuntimeError 변환으로 사용한다.
- `/usr/bin/git`의 제한된 `rev-parse --verify HEAD`, `symbolic-ref --quiet --short HEAD`, 마지막 HEAD 재확인을 순차 실행한다. 전체 관찰에 하나의 3초 deadline, 각 명령 최대2초·4096byte를 적용한다. 원래 프로세스별 system/global config·fsmonitor/hook/attributes 제한과 optional lock 비활성화를 사용하며 config 파일을 수정하지 않는다. transport를 금지하고 lazy fetch를 제한해 조회가 네트워크 실행을 만들지 않게 한다. CLI Git이 그 조건을 지원하지 않거나 안전하게 확인할 수 없으면 Git 정보를 null로 남긴다. 원래 source root가 Git 하위 폴더인 경우도 허용한다.
- Git 실패·미설치·비정상 출력·비 Git root·관찰 중 HEAD 변경은 Git 부분을 미확인으로 보존한다. 출력·오류 원문을 journal에 저장하지 않는다. `git status`, 파일 목록 탐색·diff·fetch·index 갱신은 실행하지 않는다. dirty는 기존 정책과 같은 `unknown`이다. 선택하지 않은 파일의 변경 상태를 확인했다고 주장하지 않는다.
- 모든 await 전후에 기존 실행 권한 guard를 확인한다. 각 Git child를 시작하기 전에 `RuntimeFilePolicy.root`로 현재 root를 검증하고 예상 `record.context.root`의 path/dev/ino/uid와 대조한다. child 종료 뒤에도 root를 대조하며 root 교체·권한 변화는 SNAPSHOT_CHANGED로 전파한다. 실행 권한 guard만으로 root 신원을 확인했다고 판단하지 않는다. child의 deadline과 authority.signal을 연결해 자신의 Git child만 정리한다. 권한 상실·중단·root 검증 실패를 Git 미확인으로 삼켜 입력을 계속하지 않는다. 본인 새 입력 일시정지 gate는 이미 claim된 이 수집과 입력을 취소하는 조건이 아니다.
- Git 관찰 뒤 `RuntimeFilePolicy.assertUnchanged(check)`로 선택한 전체 파일을 다시 검증하고 검증 시각을 기록한다. hash는 실제 검증한 기존 FileSnapshot에서 상대 경로·hash만 투영한다. 파일 변조·root 교체·취소는 기존 오류로 전파하며 관찰 없이 native 입력으로 넘어가지 않는다.
- 관찰 직렬화는 최대128KiB다. 예약은 같은 entries의 실제 JSON byte와 최대2KiB 고정 필드 여유, 선택 필드명·구분자의 byte를 사용한다. 제어문자·최대 경로·32개 파일의 escaping 및 최대 commit/ref·시각을 포함해 실제 저장 증가분이 예약 안에 드는 것을 테스트로 확인한다.

### [x] Step 2: 관찰의 한 번 추가와 과거 저널 보존
**File**: runtime-store.ts, 신규 source-observation-store.test.ts

- `journalSchema`의 공통 선택 필드로 두 저널 버전을 지원한다. 관찰이 없는 원래 저널과 보관 기록은 바꾸지 않고 읽는다. 필드가 존재하면 exact shape·hash·순서·크기를 전체 검증한다.
- `RuntimeStore.write`에서 이전 저널 파일이 없으면 전이 검사가 실행되지 않으므로, 최초 쓰기의 attempt에 관찰을 직접 삽입하는 것을 별도로 거절한다. v1/v2 모두 적용하고 관찰 없는 기존 최초 쓰기는 유지한다. 이미 저장한 저널·archive 원문의 읽기와 기존 보관 복원 경로를 새로운 관찰 생성으로 취급하지 않는다.
- 관찰은 성공 start-intent가 있는 `SERVER_INTENT_CONFIRMED → PROVIDER_INTENT`에서만 한 번 추가한다. 최초 CLAIM_PENDING·CLAIMED·NOT_STARTED·denial proof·복구 UNKNOWN/terminal에 뒤늦게 붙일 수 없다. 추가에는 현재 context generation·epoch와 같은 성공 claim snapshot이 필요하며 그 generation의 선택 entries와 일치해야 한다.
- 하나의 저장에서 provider-intent와 관찰·Claude의 기존 nativeIntent를 확정한다. 관찰만 먼저 저장하거나 callback이 재호출돼 새 Git 관찰로 기존 관찰을 덮어쓰지 않는다.
- 기존 관찰은 state 전환·terminal·receipt·owned turns·설정 교체 뒤에도 삭제·변경할 수 없다. 현재 generation의 관찰은 현재 파일 선택과 대조하고, 과거 generation의 관찰은 현재 설정으로 대조하지 않는다. 과거 관찰을 재수집하거나 새 provider/generation에 이관하지 않는다.
- 기존 unstartedClosure의 native 부재·저널 전체 불변 제약에 관찰도 포함한다. appended attempt에 관찰을 넣는 직접 저장을 거절한다. 미확인 native 실행의 판정이나 실행 budget을 관찰 필드로 바꾸지 않는다.
- 원래 archive 흐름이 추가 필드를 포함한 원래 byte/hash를 그대로 보관하고 읽는지 테스트한다. sourceObservation을 terminal·publish body·archive index에 복사하지 않는다. 보관 없이 attempt를 제거하는 기존 금지도 유지한다.

### [x] Step 3: claim 전 예약과 두 provider의 내구 입력 경계
**File**: workflow-runner.ts, 신규 source-observation-runner.test.ts, 필요 시 runner-fixture.ts, 관련 정본 docs

- `admitExecution`과 ready의 admission 용량 검사에 선택 파일 관찰의 정확한 예약 byte를 반영한다. claim 및 그에 따른 서버 allowance 소비 전에 수용 가능성을 확인한다. 정리 뒤에도 부족하면 기존 RUNTIME_CAPACITY/not-ready 처리로 남기며 새 claim·native 입력을 전송하지 않는다.
- 허용된 새 attempt에 관찰 예약을 잡고 기존 lease·ready·작업 응답의 예약과 합산한다. provider-intent의 실제 관찰 byte가 기록에 포함되면 해당 예약만 대체한다. 예약 해제는 owned 디스크에서 같은 관찰의 저장을 확인한 뒤에만 한다. 다른 작업 예약·종결 예약을 앞당겨 해제하지 않는다.
- claim이 INPUT_PAUSED로 거절되어 native 입력이 시작되지 않은 경우도 별도로 정산한다. 기존 sealInputPaused가 종료 attempt 전체와 CLOSED claim 전체를 구성한 뒤, 성공 저장 또는 실패 후 확정 디스크 채택에서 두 기록이 정확히 일치할 때만 해당 source:key 예약을 해제한다. 저장 전 실패·불일치·다른 source/lease/ready 예약은 유지한다. 일반 mutate·예약 공개 계약은 넓히지 않는다. 같은 runner가 여러 거절 뒤 재개해도 예약이 누적되지 않게 한다.
- 기존 `beforeSubmit` callback에 모듈의 제한된 수집을 연결한다. 성공 server intent·현 scope/generation·deadline을 수집 전후와 저장 전후에 확인한다. 기존 mutate의 queued guard, 저장 실패 후 committed record 채택과 UNKNOWN 보존을 그대로 사용한다. 임의 예외에서 새 native 입력·세션·예산으로 자동 재시도하지 않는다.
- 관찰을 같은 provider-intent 저장에 넣고 저장이 확정된 뒤에만 callback을 반환한다. Codex·Claude 모두 같은 공통 경계를 통과하되 기존 Claude intent 검증과 공식 admission의 POLICY_UNCONFIRMED는 유지한다.
- 이전 UNKNOWN을 observe하거나 기존 terminal outbox를 재전송할 때 수집하지 않는다. 정확한 기존 publish body·operation은 그대로 사용한다. 파일이나 Git 정보가 현재 바뀌어도 당시 관찰의 hash는 유지한다. sourceObservation 유무로 종결이나 공유 채택을 확정하지 않는다.
- 전체 검사에서 드러난 완료·제어 조회 경합을 같은 runner 안에서 보정한다. monitorInput의 이미 시작한 조회/ACK는 현재 connector 권한과 정확한 active authority·scope·context generation/threadId/root/epoch가 같은지 검증한다. 완료된 attempt의 lease/deadline·UPLOADED 또는 정상 monitor signal 종료를 이 제어 조회의 취소 사유로 삼지 않는다. signal 종료 후 새 조회는 시작하지 않는다. 실제 stop·권한/잠금 상실·scope/맥락 교체는 계속 거절한다. credential·중앙 admission read/ACK 검증, native live·monitorAttempt·monitorReady의 원래 lease/deadline·종결 검사는 유지한다. 제어 ACK를 다음 claim이나 native 입력의 허용 증거로 바꾸지 않는다.
- architecture의 local journal 경계, business의 당시 근거/미확인 조건, glossary의 `sourceObservation`을 부모가 갱신한다. 현재 상태와 검사 수치는 delivery 한 곳에 기록하고 README에는 탐색 링크만 둔다. archived 계획은 유지한다.
- 변경 전후 입력·diff·검사 log/SHA와 dependency map을 기록한다. 새 독립 reviewer가 파일 권한·child/guard·저장 전이·예약·provider·UNKNOWN·archive 보존을 대조한다. 이 계획의 로컬 수용이 통과해도 022/025 실제 DB·UI, 009 공식 Claude·두 Mac과 전체 제품 완료를 주장하지 않는다.

## Tests

- `source-snapshot.test.ts`: Git 정상·detached·하위 root·비 Git·비정상 ref/hash·HEAD 변경·timeout·취소를 검증한다. 실제 격리 Git fixture와 bounded 실행 seam을 사용하며 사용자 저장소·설정·네트워크·native는 건드리지 않는다. 허용 command/환경, side effect 없음과 owned child 정리를 검증한다. 수집 전에 root를 교체하면 Git child0이며, child 사이 root 교체는 다음 child 시작 전에 거절한다.
- 같은 collector 검사: 실제 선택 파일 재검증, root/파일 변조·취소 거절, 상대 경로와 hash만 보존, 정렬/hash·최대32개/512자 escaping·unknown fields·크기 상한과 예약 충분성.
- `source-observation-store.test.ts`: v1/v2 optional 호환, 최초 쓰기의 관찰 직접 삽입 거절, 정상 provider-intent의 단일 추가, 잘못된 state/generation/epoch/start-intent·선택 파일·hash 거절, 기존 관찰의 제거/변경/추가 금지, 원래 NOT_STARTED/UPLOADED 불변.
- 같은 store 검사: 새 설정 generation으로 전환 뒤 과거 관찰 보존, 원래 UNKNOWN/outbox 필드 유지, archive 전체 byte/hash와 오래된 관찰 없음의 유지. 현재 파일로 past observation을 채우지 않음.
- `source-observation-runner.test.ts`: 두 provider의 실제 공통 callback 앞 저장 순서, Git 미확인과 선택 파일 보존, 수집 전 root 교체에서 Git child0/native 입력0, 관찰 실패·권한 상실·저장 전/후 실패에서 native 입력0/UNKNOWN 및 확정 저장 채택, duplicate callback의 추가 입력 금지.
- 같은 runner 검사: 관찰 저장까지 예약 유지·다른 lease/ready 예약 보존, claim 전 부족에서 claim/native0, 작은 파일 집합의 수용 및 큰 escaping 집합의 정확한 차단, 저장 뒤 예약 이중 계산 금지, terminal/outbox/observe/archive 재시작의 재수집0, 이미 claim한 입력에 본인 새 입력 일시정지 적용 시 계속함.
- 같은 runner 검사: 거절 closure의 저장 전 실패는 관찰 예약을 유지하고, 정상 저장·rename 뒤 directory sync 실패의 확정 기록 채택에서는 해당 관찰 예약만 해제한다. 다른 lease/ready/source 예약을 보존한다. 같은 once:false runner의 두 claim 거절→세 번째 재개를 고정하고, native finally의 전체 정리 전에 새 source 예약이 하나만 있음을 확인한다.
- 같은 runner 검사: source-backed 완료 뒤 보류 admission 조회를 반환하는 경합과 중앙 receipt 뒤 UPLOADED 저장 전 monitor 종료·ACK 경합을 deferred로 고정한다. 실제 stop/epoch·generation 상실에서는 gate가 열리지 않으며 정상 완료에서는 ready false/true를 불필요하게 추가하지 않는다. 원래 공유 ready schedule의 count2·15초 cadence·timeout·기대값은 유지한다.
- 원래 connector 전체 검사와 현재025 관련 gate/runner/store 검사의 기대값을 유지한다. 기존15초 제거 검사 취소·최대 continuation의 간헐 UNKNOWN은 독립 처분을 유지하되 이번 변경의 실패는 별도 분석한다. timeout 확대·fixture 축소·assertion 완화로 통과시키지 않는다.

## Risks

- Git은 선택 root의 바깥 containing repository 정보를 읽을 수 있다. 이미 등록한 root로 명령을 한정하고 metadata만 저장한다. readonly 옵션·transport 금지·작은 출력·deadline을 사용한다. 안전 조회 실패는 null이고 dirty는 unknown이다.
- Git과 파일 검사는 원자적이지 않다. 관찰 시각과 의미를 제한하고 최종 파일 재검증을 유지한다. 관찰 뒤의 외부 변경까지 잠갔다고 표시하지 않는다.
- 저장소 관찰 실패를 삼키면 변조된 파일로 입력할 수 있다. Git 미확인과 실행 권한·선택 파일 오류를 구분한다. 후자는 callback을 거절하고 기존 UNKNOWN 처리로 간다.
- 관찰을 반복 복사하거나 고정 최대 byte로 예약하면 기존 용량 문제를 재현한다. journal 한 곳에만 보존하고 실제 entries 크기로 예약하며 종결 공간을 유지한다.
- 과거 저널을 현재 설정으로 검증하면 설정 변경 뒤 읽기·복구가 깨진다. 동일 generation 추가 시만 현재 선택 파일과 결합하고 저장한 관찰 자체는 불변으로 검증한다.

## Verification

- Node24의 기존 npm CLI로 connector build/typecheck, 새 collector/store/runner target와 현재025 관련 검사, connector 전체를 실행한다.
- root unit·application/integration/E2E TypeScript compile·lint 최대경고0·format/format:check·git diff --check를 완료한다. 정확히 같은 입력의 기존 통과만 재사용한다. 로컬 Next preview를 재빌드·재시작하지 않는다.
- owned scratch에 현재 baseline·전체 변경 inventory·상대 diff·검사 exitCode/log hash·기존 비정상 결과의 처분을 보존한다. Git metadata의 쓰기를 우회하지 않는다. 실제 DB/HTTP/browser/native0과 합성 Git fixture를 구분한다.
- Tests의 정의·실행과 새 독립 리뷰를 대조하고 상대 문서 링크를 확인한다. 세 Step와 로컬 Tests·리뷰가 모두 완료될 때만 이 계획을 done/archive한다. 다음 중앙 연결을 구현한 것으로 표시하지 않는다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---|---|---|---|
| 계획 리뷰1 H1: Git child가 root 재검증보다 먼저 시작할 수 있음 | HIGH | ACCEPTED | 각 child 시작 전·종료 뒤 예상 RootIdentity와 현재 root를 대조하고 교체를 실행 실패로 전파한다. 수집 전 교체의 child0/native0과 child 사이 교체 회귀를 Step1/Tests에 추가했다. |
| 계획 리뷰1 H2: previous 없는 첫 write에서 관찰 직접 삽입 가능 | HIGH | ACCEPTED | 최초 쓰기에서 새 관찰을 거절하는 별도 경계를 Step2와 v1/v2 회귀에 명시했다. 관찰 없는 원래 최초 쓰기와 저장·보관 원문의 읽기는 유지한다. |
| 전체 검사: 정상 완료와 진행 중 admission 조회의 guard가 경합해 ready false가 추가됨 | HIGH | ACCEPTED | 정확한 이전·현재 코드의 제한 비교와 보류 조회 회귀를 보존했다. 이전 코드에서도 경합을 재현했지만 이번 await로 기존 count2 검사에서 드러나 실제 보정 대상으로 유지한다. Step3의 제어 조회 guard만 현재 binding/맥락에 결합하고 native 권한 검사는 유지한다. |
| 최종 전체 검사: 기존 native-tools 검사의 단발 저널 읽기가 UNSAFE_STORAGE로 거절됨 | INFO | REJECTED_AS_026_REGRESSION | 독립 구현 리뷰1이 변경 전·후의 동일 읽기/저장 경합과 같은 UNKNOWN을 확인해 026 신규 운영 회귀로 기각했다. 자연 실패의 거절 stat 값은 미확인이고 원본 실패·전체 종료 코드1은 유지한다. 원래 테스트·fixture·보안 검사는 변경하지 않았다. |
| 독립 구현 리뷰1 H1: INPUT_PAUSED 거절 뒤 source:key 예약 누수 | HIGH | ACCEPTED | 같은 once:false runner에서 native finally를 지나지 않아 예약이 누적되는 경로를 보정했다. sealInputPaused가 소유 디스크에 저장·채택된 정확한 미시작 attempt와 CLOSED claim에서만 해당 관찰 예약을 정산한다. 정상 저장·저장 전/후 실패·다른 예약 보존·같은 runner의 연속 거절 후 재개와 불일치 증거 회귀를 통과했다. 독립 구현 리뷰2가 수정과 검사·현재 문서를 확인해 해소했다. |
| 독립 구현 리뷰1 I2: 기존15초 제거 검사 취소의 재사용 범위 | INFO | RETAINED | 원래 테스트 byte·timeout·기대값과 변경 전 취소의 역사적025 처분만 재사용한다. 해당 fixture의 runner 실행에는 현재026 경로도 있을 수 있으므로 현재 runner 변경은 새 독립 리뷰로 평가했다. 취소·전체 비정상 종료는 유지한다. |

## Completion Record

2026-10-06 세 Step의 로컬 구현·관련 격리 검증과 독립 구현 재검토를 완료했다. 독립 구현 리뷰2는 PASS C0/H0/M0/L0/INFO2다. 첫 리뷰의 예약 누수를 실제 실패로 재현하고 같은 실행기의 연속 거절 후 재개·확정 저장 채택에 맞춰 보정했다. 원래 native 권한·저장 계약·기존 검사 기대값을 유지했다.

이 계획의 완료 범위는 로컬 입력 당시 관찰의 저장·보존이다. 현재 검사 수치와 원본 비정상 결과·별도 실행의 한계는 [개발·검증 상태](../../planning/delivery-and-validation.md#현재-진행-상태)에 유지한다. 기존 전체 취소와 보고 누락을 통과로 바꾸지 않았다. 중앙 근거 연결·결과 분류·사람 해결 확인, 실제 Claude·두 Mac·022/025 실제 수용은 완료 범위에 포함하지 않는다.

현재 실행 환경의 `.git` 읽기 전용 제한으로 이번 코드는 미커밋 상태다. 원본·상대 patch·실행 로그·독립 리뷰 입력을 보존했다. Git metadata를 변경하지 않고 문서 파일만 archive로 이동했다.
