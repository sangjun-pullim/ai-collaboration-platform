---
status: active
date: 2026-10-06
risk-surface: auth, permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code. Current implementation and acceptance must be verified separately.

# 답변의 당시 저장소와 파일 관찰 연결

## Context

[PRD의 기본 채팅 수용 기준](../PRD.md#기본-채팅의-기능-수용-기준)은 코드 근거가 붙은 답변을 요구한다. 입력 직전 SourceObservation v1과 029의 실제 반환 파일 관찰은 로컬 저널에 남지만 중앙 답변·채팅 화면에는 연결하지 않는다. 질문 대상의 공개 별칭도 예약 시점에 고정해야 한다.

전체 구현의 기존 승인과 사용자가 확정한 선택 폴더 자동 탐색을 적용한다. 026의 입력 관찰, 028의 안전한 I/O, 029의 소유자 승인·실제 도구·내구 관찰은 그대로 소비한다. 개인 설명·방향 수정·구조화 결과·실제 Claude/두 Mac 수용은 별도 범위다. 기존 Git/DB/browser/native 제한과 실제 입력 예산을 넓히지 않는다.

기존 계획 리뷰2의 PASS는 SELECTED 입력 관찰에 대한 역사적 근거다. AUTO_CODE의 공개 투영·전송·화면은 새 영향 범위를 독립 검토했다. 읽기 전용 조사2건에서 바이트 상한·문자열·peer 의미를 확인했다. 029 소스 검토와 새 계획 리뷰3을 통과해 구현을 착수했다. 현재 단계의 완료 여부는 아래 Step 표시와 개발 현황에서 확인한다.

완료 기준:

- 요청 예약 시 사람·AI·저장소·세션 별칭과 agent/epoch를 고정한다. 입력 관찰 시각과 구분하고 과거 요청에 현재 정보를 채우지 않는다.
- 새 complete/observe 작업을 만들기 전에 같은 attempt/fence의 불변 공개 manifest 전체를 중앙에서 확인한다. 관찰 없는 과거 저널·이미 존재하는 작업·migration 전 요청의 원래 발행은 유지한다.
- 입력 전 허용 집합, 실제 도구가 저장한 반환 발췌, 공동 질문 전 근거 검증을 구분한다. 저장한 관찰이 모델의 사용·답변 인용·질문 수락·테스트 통과까지 입증한다고 표시하지 않는다.
- 로컬 승인·native 식별자·절대 경로·설정·파일 본문은 발행하지 않는다. 공개 범위에는 상대 경로/hash·Git 관찰·실제 발췌의 byte 범위와 별도 요청 줄만 포함한다.

## Affected Files

1. `src/features/investigation-coordinator/contracts.ts`, `packages/local-connector/src/workflow-contracts.ts` — 기존 protocol1을 유지하며 고정 source action과 작은 내부 계약 모듈을 연결한다.
2. 신규 `src/features/investigation-coordinator/source-contracts.ts`, `packages/local-connector/src/workflow/source-contracts.ts` — 순수 공개 형식·JSON token·상한·응답 검사를 소유한다. 독립 배포되는 앱/연결기의 기존 mirror 방식으로 같은 내용을 유지하며 일치 검사를 추가한다. 브라우저 모듈은 파일 I/O·Node crypto를 가져오지 않는다.
3. 신규 `supabase/migrations/20261006001300-shared-input-source-history.sql` — 요청 대상 snapshot, packet·확정 manifest·flat file index·이벤트 연결과 고정 RPC. 029의 SQL012 뒤 신규 migration이며 과거 SQL은 수정하지 않는다.
4. 신규 `packages/local-connector/src/workflow/source-manifest.ts` — 검증한 로컬 기록의 공개 투영·canonical bytes·바이트 계산을 소유한다. 리뷰의 성능 보정은 내부 `record-snapshot.ts`와 `source-publication-guard.ts`로 분리한다. 실행기가 채택하는 기록은 외부 참조를 복제하고 모든 하위 객체를 동결한 뒤 저장한다. 자료 전송의 매 경계에서 현재 권한·저널·scope·attempt/fence를 확인하고, 기록이 교체됐을 때만 원래 자료의 bytes/hash와 재투영 결과를 비교한다.
5. 신규 `packages/local-connector/src/workflow/source-publisher.ts` — 결정적 packet/ID, 전체 확인·부분 재개와 ACK 검사를 소유한다.
6. `packages/local-connector/src/workflow-runner.ts`, `workflow-client.ts` — 새 실행 전 지원 확인과 기존 publish에 작은 호출을 연결한다. source 기기 응답의 실제 stream에16KiB 상한을 적용한다. 다른 실행기 책임이나 기존 action 응답 한도는 바꾸지 않는다.
7. 신규 `src/features/investigation-coordinator/run-source-view.tsx`, `source-view-controller.ts`, 기존 `chat-timeline.tsx`, `chat-presentation.ts`, `investigation-view.tsx`, `investigation-client.ts` — 메시지별 당시 대상·파일 관찰과 lazy pagination을 연결한다. 내부 controller는 불변 조회 주소·페이지 검증·요청 취소를 소유하고 기존 사람 RPC를 주입받는다. source-read의 실제 응답 stream은16KiB 이내여야 한다. 자료 조회에서 확인된 접근 거절은 부모의 기존 요청 중단·이력 제거에 전달한다.
8. 신규 connector `source-manifest.test.ts`, `source-publisher.test.ts`, `source-publication-runner.test.ts`, `record-snapshot.test.ts`, `source-publication-guard.test.ts`, 기존 `runner-fixture.ts`, `workflow-client.test.ts` — 공개 투영·발행/복구·권한과 실제 응답 byte 한도를 기존 fixture로 검사한다. 동결 전 외부 참조 분리, 기록 교체 시 재검증, 모든 전송 경계의 권한 확인과 필요한 조각만 만드는 동작을 추가 검사한다.
9. 신규 root `shared-source-contracts.test.ts`, `run-source-view.test.ts`, 기존 `chat-presentation.test.ts`, `chat-view.test.ts`, `investigation-client.test.ts`, `tests/integration/shared-input-source-history.test.ts`, 별도 `tests/integration/shared-input-source-upgrade.test.ts`와 owned fixture, `tests/e2e/shared-input-source-history.spec.ts` — 계약·화면·실제 수용 정의를 추가한다. 업그레이드 전용 검사는 기존001–012 조건과 driver를 유지하고 SQL013 적용 후의 표준 설정 회귀에서 제외한다. 기존 coordinator E2E와 workflow Playwright의 testMatch를 lazy 상세 조회에 맞게 연결한다. `tsconfig.e2e.json`은 기존 integration과 같은 `rewriteRelativeImportExtensions`로 동일 helper의 `.ts` import를 검사한다. 독립 구현 리뷰의 보정으로 기존 workflow 부모 broker와 내부 `source-browser-fixture.ts`·관련 단위 검사를 연결한다. 순수 자료 생성은 `source-manifest-fixture.ts`에 분리해 브라우저 준비와 별개로 양쪽 계약을 검사한다. 소유 DB·기기·자료 준비는 부모가 담당하고 브라우저 child에 관리자 설정을 전달하지 않는다. 그 밖의 타입 설정과 script는 필요한 항목만 바꾼다.
10. 부모가 README·API/DB/업무/화면/architecture·용어·온보딩·delivery와 이 활성 계획을 갱신한다. 표준 second-brain 문서는 docs 바로 아래에 유지한다.

운영 코드 기본 범위는15개이며 독립 리뷰의 성능 보정으로 내부 모듈2개를 더해 현재17개다. Step3의 역참조 조사에서 접근 거절을 부모에 전달하는 파일1개와 기존 설정 controller 패턴의 요청 상태 관리 모듈1개를 포함했다. 고정 클라이언트2개도 source 응답의 실제 byte 상한을 처리한다. 파싱 후 재직렬화한 길이만으로 외부 응답의 공백을 제외하지 않는다. 권한 규칙이나 공개 계약을 추가로 넓히는 변경은 아니다. RuntimeStore·RuntimeContracts·028 reader·로컬 승인·stored SourceObservation v1에 별도 source 상태나 원문 복제 필드를 만들지 않는다. packet마다 일반 outbox operation을 추가하지 않는다. 이 변경이 필요하면 먼저 영향 검토와 계획을 보완한다.

## Affected Dependents

- WorkflowClient·callInvestigation·고정 API route/service는 기존 기기/사람 인증 분리와16KiB 요청 한도를 유지한다. source 응답도 실제 외부 JSON bytes로 검사한다.
- RuntimeStore의 operation 불변성·unresolvedRuntime·completedRequests·archive, settings manager와 local removal은 source 실패가 남은 TERMINAL을 미완료로 처리하는 기존 동작을 유지한다.
- 029의 RepositoryToolObservation·PeerEvidenceObservation·RepositoryToolIntent와 NativeToolCancellation은 발행 입력이다. 원래 결과 문자열이나 모델 답변에서 관찰을 추측하지 않는다.
- SQL006/007/010/011/012의 claim·start·complete/observe·DIRECT·입력 일시정지·설정·history는 기존 본문·receipt·권한·잠금 의미를 유지한다. source 기능은 lease·실행·adoption·카운터를 바꾸지 않는다.
- history-state·chat-presentation은 기존 event를 보강하거나 최신 attempt로 해석하지 않는다. source-read는 불변 event ID를 사용해32개 run 요약 밖에서도 작동한다.
- 두 provider의 UNKNOWN 관찰·보관 복구는 원래 기록을 소비한다. 발행 때문에 Git·파일·native를 다시 실행하지 않는다.

## Public Manifest and Bounds

공개 manifest는 `version:2`, `kind:"RUN_SOURCE_MANIFEST"`, `readMode`, `input`, `calls`만 갖는 정확한 객체다. whole hash는 이 객체의 stableJson canonical UTF-8 bytes의 SHA-256이며 manifest 내부에 넣지 않고 wire의 `manifestHash` scalar로 전달한다. 기존 workflow protocol1과 별개인 source 자료의 버전이다.

`input`은 원래 SourceObservation v1이다. ref는 `refJson`, 파일 path는 `pathJson`으로 바꿔 각각 원래 문자열의 JSON.stringify 결과를 문자열 값으로 담는다. 나머지 version/kind/Git/시각/pathBase/hash는 그대로 유지한다. 중앙은 검증한 token으로 원래 입력의 canonical manifestHash/observationHash도 재계산한다. 원래 입력의32개/128KiB 검사는 decoded v1에 적용하며 token wrapper를 새128KiB로 제한하지 않는다.

`calls`는 원래 저널 배열의0..255 callIndex 순서다. RepositoryToolObservation은 kind/tool/resultHash와 반환 files만 투영한다. list는 files0개, read는 최대1개, search는 최대16개다. PeerEvidenceObservation은 kind/purpose와 불변 questionOperationId·검증 files1..4개를 투영한다. 파일은 원래 순서의 excerptIndex와 pathJson/hash/readAt/byteStart/byteEnd/excerptHash를 한 번만 갖는다. peer는 lineCount와 requestedStartLine/requestedEndLine을 추가한다. 요청 줄은 실제 반환 byte 범위와 다른 의미다.

로컬 generation·approvalHash·repository observationHash·native call/thread/turn ID·intent/인자·결과 본문·settings와 변경 가능한 peer receipt/state는 제외한다. resultHash는 원본 결과가 없는 중앙에서 재검산할 수 없는 보고된 digest다. questionOperationId도 소유 scope 안의 보고된 연결이며 같은 attempt/fence의 실제 전달 증명으로 표시하지 않는다. peer result:null의 선행 관찰은 원래 불변 자료로 포함할 수 있다.

| 경계 | 상한과 의미 |
|---|---|
| 로컬 저장 | 기존 record2MiB·일반512KiB·입력 v132/128KiB 유지 |
| 공개 전체 | canonical manifest4,194,304bytes; metadata 한 번·root 순증분256bytes 이하 |
| 호출/파일 | calls256, AUTO 전체 발췌4096; search16/read1/list0/peer4. 서버 수락 질문1회가 로컬 peer proof1개를 뜻하지 않음 |
| 파일 byte/줄 | 실제 byte범위0..2MiB, peer 줄수1..2MiB+1; 원래 file/hash와 요청 줄 검증 유지 |
| 원문 chunk | 최대8192bytes; nonfinal은 정확8192; count1..512와 totalBytes/마지막 길이 일치 |
| 외부 packet | base64 최대10924bytes + 키·metadata·중첩 escaping4096bytes 이하 =15020bytes 이하; 실제 요청 전체16KiB 검사 |
| 화면 조회 | flat 파일 index 최대4개/외부 JSON16KiB. 업로드 chunk 개수와 별개 |

4MiB의 근거는 최종 projector에서 검사한다. pathJson/refJson 속성은 원래 path/ref 속성의2배 이하이며, 발췌 metadata의 여유가 excerptIndex와 요청 줄 key 증가를 흡수한다. call의 native/private 필드 제거 여유는 callIndex와 questionOperationId·root wrapper 증가를 흡수한다. input-only도 원래 v1 최소396bytes의 여유로 root256bytes를 흡수한다. 따라서 metadata를 반복하지 않는 이 형식의 공개 bytes는 검증한 원래 record bytes의2배 이하로 제한된다. 전체 validated fixture와 속성별 최악 escaping의 바이트 계산 검사가 필수다. 이 계산이 성립하지 않으면 합법 관찰을 잘라 보내지 않고 projector/계획을 보완한다.

PostgreSQL17 jsonb는 NUL 이스케이프와 올바르지 않은 surrogate pair를 거절한다. inner token을 다시 jsonb로 decode하지 않고 SQL의 bounded scanner로 UTF-16 정수 codeunit 배열을 검증한다. 원래 path/ref 정책·512단위·순서와 JSON.stringify의 canonical token을 유지한다. valid pair는 일반 supplementary 문자로, lone surrogate는 escape로 보존한다. slash escape·불필요한 Unicode escape·대문자 hex·escaped valid pair 등 비정규 token은 거절한다. [PostgreSQL17 JSON 문서](https://www.postgresql.org/docs/17/datatype-json.html)

## Implementation Steps

### [x] Step 1: 공개 계약과 중앙의 불변 자료

> 선행 조건 완료: 029 독립 구현 리뷰3과 이 계획의 새 영향 계획 리뷰3이 모두 PASS다. 기존 전체 구현 위임에 따라 소스 구현을 착수한다. 실제 SQL·HTTP·브라우저 수용은 Step5에 남아 있다.

**File**: contracts/source-contracts mirror, 신규 SQL013, 계약·통합 검사

- 고정 기기 action은 source-support/source-upload/source-confirm, 사람 action은 source-read다. source-support는 현재 agent/epoch의 소유 scope를 확인하고 정확한 version2 지원을 반환한다. source-upload는 원래 attempt identity·operation UUID와 bounded JSON packet 문자열을 받는다. source-confirm은 같은 identity/manifestHash의 전체 확정·nextMissingIndex를 읽는다. source-read는 roomId/eventId와 nullable afterIndex로 첫 페이지/이후 flat index를 읽는다. unknown field·null/수·UUID/hash·UTF16/token/base64 상한을 정확히 검사한다.
- 두 고정 클라이언트는 source 응답의 실제 stream을16,384bytes에서 제한한다. 유효 envelope에 붙은 공백도 포함하며 초과할 때 reader를 취소한다. 기존 action의65,536/262,144byte 응답 한도와 오류는 유지한다.
- packet은 version2/index/count/totalBytes/manifestHash/chunkHash와 canonical standard base64 bytes를 가진다. decode→encode가 동일해야 하며 공백·URL alphabet·오버패딩·잘못된 pad bits를 거절한다. 각 chunk를 text로 decode하지 않고 모두 bytea로 결합한 뒤 strict UTF-8·정확한 schema·canonical bytes와 whole hash를 확인한다. jsonb::text를 stableJson 대체물로 쓰지 않는다. 중복 JSON key·공백·비정규 number 표기도 원래 canonical bytes와 비교해 거절한다.
- 요청 예약 AFTER INSERT trigger가 당시 사람·세션 별칭과 공개 repositoryAlias/runtime/agent/epoch를 저장한다. claim 때 현재 값을 덮어쓰지 않으며 migration 전 요청에는 NO_TARGET_SNAPSHOT을 반환한다. 과거 요청·이벤트에는 현재 정보나 새 관찰을 소급 붙이지 않는다.
- source-upload는 기존 credential·admission·membership·agent·epoch·request·attempt·fence·start-intent와 EXECUTING/동일 UNKNOWN의 발행 경계를 확인한다. 기존 잠금 순서·오류 우선순위를 대조하며 lease·실행·카운터·adoption을 바꾸지 않는다. 새 자료 잠금은 해당 attempt/manifest/packet에 한정하고 방의 모든 과거 source rows를 잠그지 않는다.
- private 저장은 packet 주소/operation의 같은 bytes에 같은 ACK를 재생하고 다른 내용은CONFLICT로 거절한다. packet ACK의 과거 partial 상태는 전체 완료 증거가 아니다. 모든 packet이 모인 한 트랜잭션에서 전체 canonical/schema/hash를 확인하고 불변 manifest와 정렬된 flat index를 한 번 확정한다. nextMissingIndex==count만으로 확정하지 않는다.
- 입력 v1의 길이/순서는 JS UTF-16 codeunit 기준이며 원래32/128KiB/hash를 검증한다. AUTO의 반복 path·offset/hash/시각·callIndex gaps와 excerptIndex를 보존하고 정렬/중복 제거하지 않는다. SELECTED는 auto calls없음, AUTO_CODE는 input의 selected entries없음을 확인한다. 승인용 hash/root는 중앙 필드에 없다.
- 새 private 표는 직접 anon/authenticated/service-role 공개 조회를 허용하지 않으며 Auth/device/workspace 삭제로 역사 자료를 지우는 FK를 추가하지 않는다. 기존 방·역사 자료 수명과 삭제 정책을 따른다. security-definer RPC는 빈 search_path와 고정 이름·실제 사람/기기 권한을 사용한다. 기존 history 응답과 complete/observe receipt bytes는 바꾸지 않는다.
- 공개 terminal 이벤트는 생성 시점의 정확한 attempt와 이미 확정된 manifest를 연결한다. ANSWER/SPEECH/terminal RUN_STATE·새 adoption 이벤트를 포괄한다. 최신 attempt로 과거 event를 보강하지 않는다. partial·terminal 전 자료는 공개하지 않는다.
- QUESTION target은 questionId의 예약 PEER snapshot이다. 공동 AI QUESTION의 event.requestId는 발신 요청이므로 수신자와 혼동하지 않는다. 생성 당시 target만 고정하고 이후 recipient/origin의 manifest는 소급 붙이지 않는다. peer operation UUID는 room/actor scope에서만 연결하며 수락·전달을 주장하지 않는다.

### [x] Step 2: 불변 투영·확인과 결과 발행 복구

**File**: source-manifest.ts/source-publisher.ts, runner와 connector 검사

- projector는 RuntimeStore가 검증한 원래 input·저널의 typed observation만 투영한다. AUTO의 원래 generation/root에 묶인 경로/hash 공유 동의를 확인한다. native/body/개인 설정을 복제하거나 raw JSON에서 실제 읽기 자료를 추측하지 않는다. pending intent·취소 뒤 미채택 결과를 새 관찰로 만들지 않는다. 기존 source가 없으면 legacy 발행을 유지한다.
- publisher는 canonical manifest와 동일8192-byte slices에서 결정적으로 packet/UUID를 만든다. ID는 domain/version과 원래 attempt 주소·index에 묶고 내용 hash만으로 새 주소를 만들지 않는다. readonly source-confirm 선조회에서 같은 전체 확정을 확인하면 전송하지 않는다. partial은 같은 identity/hash의 nextMissingIndex부터 재개하고 모든 ACK 뒤 whole-confirm을 다시 확인한다.
- 각 요청/ACK/확정마다 원래 scope/저널/identity/manifestHash와 live guard를 대조한다. 마지막 ACK 유실·중단·재시작은 같은 ID/body/bytes만 재생한다. packet마다 RuntimeStore.operations나 새 source journal fields를 추가하지 않는다. 전송 중 transient canonical bytes만 유지한다.
- 새 source-capable 실행은 현재 scope의 지원을 claim/native 입력 전에 확인한다. source-support가 없거나 정확한 version2가 아니면 기존 not-ready/오류로 새 입력을 시작하지 않는다. 같은 scope의 지원 확인을 불필요하게 매 poll 반복하지 않는다. 기존 입력 일시정지·ready·설정·권한·용량 검사는 유지한다.
- complete/observe 작업이 없는 새 publish는 먼저 같은 attempt/fence manifest 전체를 확정한다. 확인 실패에는 기존 TERMINAL을 유지하며 complete 생성/전송·UPLOADED로 진행하지 않는다. 재시작은 기존 TERMINAL 복구에서 같은 자료를 발행한다. 새 native 입력·세션·추가 예산·Git/파일 수집을 하지 않는다.
- 이미 존재하는 complete/observe operation은 state와 무관하게 원래 body/hash를 그대로 사용한다. 관찰 없는 저널·migration 전 NO_TARGET_SNAPSHOT·UPLOADED/보관 자료는 원래 발행/복구를 유지하고 뒤늦게 source를 붙이지 않는다. 발행 실패는 기존 unresolved·삭제·설정 교체·보관 차단에 남으며 기존 종료 대기/lease/종결 예약을 바꾸지 않는다.

### [x] Step 3: 메시지별 당시 대상과 파일 관찰

> 소스와 관련 격리 검사를 완료했다. 당시 별칭·파일 관찰의 상세 조회와 권한 거절·페이지·종료 처리를 연결했다. 전체 포맷·lint와 기존 연결기 입력의 검증 재사용을 확인했으며 독립 구현 리뷰는 Step4에서 진행한다. 실제 브라우저 수용은 Step5에 남아 있다.

**File**: run-source-view.tsx/source-view-controller.ts/chat-timeline.tsx/chat-presentation.ts/investigation-view.tsx와 UI 검사

- 사용자가 메시지의 저장소·자료 보기를 열 때 그 event/room의 source-read를 조회한다. 모든 메시지의 source를 polling마다 읽지 않는다. 새 adoption 이벤트는 그 새 ID로 읽으며32개 run 요약 밖의 이력도 지원한다.
- 내부 controller는 실제 화면과 같은 작은 인터페이스로 첫 조회·다음 페이지·닫기/종료를 처리한다. 기존 사람 RPC와 테스트의 합성 응답을 주입하며 지연 응답·취소·페이지 불일치를 직접 검증한다. React hook을 흉내 낸 검사에 요청의 동작 증명을 맡기지 않는다.
- 당시 사람·AI·저장소·세션·예약 시각을 현재 연결과 구분한다. 자료 없음/조회 실패에서는 현재 binding을 당시 target으로 채우지 않는다. AI QUESTION 발신자를 수신자로 표시하는 기존 실패를 먼저 재현하고 정확한 QUESTION→PEER target을 사용한다.
- 입력 전 선택 집합·도구 반환 기록·공동 질문 전 파일 검증을 구분한다. Git/file 시각은 원래 관찰이며 dirty/없음은미확인이다. AUTO의 빈 입력 선택 집합을 실제 읽기0건으로 해석하지 않는다. list의 files0도 읽은 파일 목록으로 만들지 않는다.
- 공개 경로 token을 JS로 decode하고 제어문자/lone surrogate는 안전한 escape로 표시한다. hash와 실제 byte범위·별도 요청 줄의 의미를 유지한다. 저장한 기록을 모델 사용/인용/질문 수락/전달/테스트 성공으로 표시하지 않는다. 구현 번호·프로토콜·native/개인 오류 원문을 제품 화면에 넣지 않는다.
- flat index0..4095를 최대4개·실제16KiB 이내로 읽고 다음 페이지에도 같은 event/hash를 유지한다. 작은 byte 한도에서는4개보다 적게 반환한다. 같은 파일의 다른 발췌를 유지하며 늦은 응답·방 변경·권한 취소가 다른 화면 상태를 덮어쓰지 않는다. 기존 shadcn/ui·Tailwind와 접근성·이력 병합을 유지한다.
- source-read의 FORBIDDEN·UNAUTHENTICATED·NOT_FOUND는 부모의 기존 접근 거절 처리에 전달한다. 현재 방의 요청을 중단하고 이력·자료를 비우며 이후 입력을 막는다. 일시적인 조회 오류에는 같은 처리를 적용하지 않는다.

### [x] Step 4: 소스 검증·독립 리뷰와 문서

> 독립 구현 리뷰1은 REVISE C0/H3/M1/L0/INFO0이다. 합성 자료의 정확한 형식, 브라우저 검사의 부모 준비 경로, AUTO·canonical·UNKNOWN/채택의 수용 정의와 발행 guard의 반복 계산을 보완했다. 최종 격리 검사와 새 독립 리뷰2 PASS C0/H0/M0/L0/INFO0을 확인했다. 위 네 지적은 소스·검사 정의에서 해소됐다. Step5의 실제 수용은 별도 미완료이며 계획은 active로 유지한다.

- Node24로 projector/publisher/provider/runner·root 계약/UI 및 전체 관련 검사, connector compile/type·root app/unit/integration/E2E compile·lint 경고0·format/check·diff·문서 링크를 확인한다. 통과 입력은 hash가 같으면 재사용한다. 원본 실패/취소는 보존하고 기대값·fixture 크기·timeout을 완화하지 않는다.
- 부모가 actual diff·호출자·worker 결과를 확인한 뒤 새 독립 reviewer가 권한·잠금·canonical/UTF16·byte ledger·partial/확정·정확한 event·복구/제거/교체·UI를 검토한다. 같은 입력의026/028/029 검토만 재사용하며 새 공개 연결은 독립 검토한다.
- 정본에는 실제 동작을 쓰고 검증 수치는 delivery 한 곳에 둔다. 현재 소스와 실제 수용을 구분한다. 새 웹 build/typegen/restart로 미리보기를 바꾸지 않는다. Git 쓰기가 불가능하면 patch/입력/검사/리뷰를 보존하고 미커밋으로 보고한다.

### [ ] Step 5: 실제 SQL·HTTP·브라우저 수용

> 현재 실행 환경에서 Docker socket/HTTP/browser 접근 제한으로 실제 실행0이다. 실행 조건이 바뀌지 않으면 정의·컴파일·합성 결과와 실제 수용을 구분하며 이 Step을 완료 표시하지 않는다.

- owned 격리 DB에서 SQL013 신규 설치와001–012 warm upgrade, 실제 RLS/RPC·동시성·token/canonical JS-SQL 벡터·역사 연결을 확인한다. 설치된 공유/운영 DB를 이 검사에 사용하지 않는다.
- 두 사용자 HTTP/browser에서 같은 event의 당시 target/자료와 소유권을 확인한다. source-read는 다른 방·비멤버·취소된 신원을 거절한다. 실제 AI 입력은 필요하지 않는다.
- API/DB 먼저, connector 뒤 순서로 지원 기능을 설치하는 안내를 작성한다. 모든 Step·필수 실제 검사·독립 리뷰가 끝나기 전 계획을 보관하거나 제품 완료로 표시하지 않는다.

## Tests

- 공개 계약: mirror 일치·고정 action/사람/기기 분리·unknown fields·UUID/수/hash/시각/token/base64 거절·기존 protocol1/complete/observe 본문 호환·외부 요청/응답16KiB.
- token/canonical: lone high/low/연속 surrogate·valid pair·NUL/control·quote/backslash·511/512/513 UTF16·emoji/E000 순서·ref null/문자열 null·비정규 escape/숫자·중복 key·unknown field·strict UTF8. 원래 v1 hash와 공개 whole hash의 JS/SQL 일치.
- 투영: SELECTED0/1/32, AUTO list/read/search/peer-only와혼합·private필드0·opaque resultHash·원래 inputhash·callIndex gaps/excerptIndex/같은path반복·requested lines vsactualbytes·mutable peer state/receipt 후bytes/hash동일.
- byte ledger: 속성별2배·root256·packetmetadata4096·최악path·input-only/혼합256call·전체validatedrecord→public4MiB 지배식. 정상64search×8반환의128KiB 초과를 수용하고 source/body를 자르지 않음.
- chunk/발행:8191/8192/8193bytes·4MiB/초과·512/513count·UTF8 2/3/4byte 분할·비정규 base64/pad bits·주소/index/길이/hash 조작·역순/중복/누락/충돌·ACK유실/과거partial ACK·전체확정 선조회와nextMissingIndex. 이미 확정/대상 없는 자료의 조각 생성0, 마지막 조각만 누락된4MiB 자료의 생성1과 전송 중 원본 Buffer 변경의 무영향을 검사한다.
- runner: 양 provider·source미지원에서claim/input0·전체확정뒤만complete 생성/UPLOADED·TERMINAL 재시작·원래native/Git/파일I/O0·source fields/일반operations 추가0·source 실패의교체/삭제/보관차단·guard/중단/epoch상실·legacy관찰없음/원래operation/migration전 원문 유지.
- SQL/HTTP: 직접/공동/CONTINUATION/RESUME 요청 snapshot·예약뒤별칭변경·QUESTION→수신PEER·정확한terminal attempt/기존 PEER의새ANSWER채택event·UNKNOWN의observe/HISTORICAL과사람resume의새요청분리·다른방/비멤버/취소/epoch/fence·start-intent·partial비공개·service-role직접조회금지·scoped reportedquestionOperationId·행잠금/동시업로드/warmupgrade.
- UI/browser: lazy 첫조회/다음page·최대4/16KiB·자료없음vs실패·지연응답/권한취소/방변경·최신binding/attemptfallback없음·반복파일/요청줄의의미·제어문자표시·현재구성변경금지.

현재 계약에는 과거 결과를 사람이 명시적으로 채택하는 RPC가 없다. 이 계획의 새 채택 이벤트 검사는 기존 PEER의 PENDING→ACCEPTED에서 생성되는 ANSWER를 뜻한다. UNKNOWN의 관찰은 HISTORICAL로 유지하고 사람의 resume은 새 요청을 예약한다. 이를 사람의 과거 결과 채택 구현으로 표시하지 않는다.

## Verification

검증 명령과 결과는 해당 입력의 manifest·원본 로그·상대 patch·dependency map으로 남긴다. source-local 결과와 실제 실행을 나눠 기록하며 필수 독립 리뷰를 완료한다. 전체 connector의 기존 실패·취소는 같은 입력·원인 근거만 재사용하고 변경 발행 경로는 새 검토한다. source-support/read의 version2 자료는 현재 workflow protocol1과 혼동하지 않는다.

## Review Notes

아래 검토 결과는 각 검토 시점의 기록이다. 현재 구현·수용 상태는 위 Step 표시와 [개발·검증 상태](../planning/delivery-and-validation.md#현재-진행-상태)에서 확인한다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Plan1 H1: AI QUESTION의 발신 요청을 수신 대상으로 해석 | HIGH | ACCEPTED | QUESTION→예약 PEER 대상과 terminal→실제 실행 attempt를 별도로 고정한다. presentation/Timeline과 직접·공동 질문의 실패 재현 검사를 범위에 추가했다. 질문 이벤트의 source 소급 연결은 금지한다. |
| Plan1 M1: UTF-16 경로의 중앙 길이·순서·digest 벡터 미명시 | MEDIUM | ACCEPTED | 원래 JS 코드 단위 범위를 유지하고 보충 문자와 E000 순서·511/512/513 길이·전체 JS/SQL hash 벡터를 Tests에 명시했다. |
| Impl1 H1: 합성 공개 관찰에 원래 ref 필드가 남음 | HIGH | ACCEPTED / RESOLVED | refJson 투영과 원래 v1 hash를 보존하고 실제 생성 fixture의 공개 계약 단위 검사를 추가한다. |
| Impl1 H2: 브라우저 child가 소유 DB fixture를 직접 준비 | HIGH | ACCEPTED / RESOLVED | 기존 부모 broker에 고정 자료 장면·전송·변경·정리를 연결한다. child의 관리자 환경 제거 경계는 유지한다. |
| Impl1 H3: AUTO·canonical 거절·UNKNOWN/채택 수용 정의 누락 | HIGH | ACCEPTED / RESOLVED | 전체 source RPC 경로의 유효 혼합 자료·파일 순서·요약, hash가 맞는 비정규 bytes 거절과 rollback, 정확한 과거 실행의 이벤트 연결을 정의한다. 실제 실행은 별도 유지한다. |
| Impl1 M1: 각 발행 guard의 전체 재투영과 선행 packet 할당 | MEDIUM | ACCEPTED / RESOLVED | 검증한 불변 자료의 투영을 재사용하되 현재 권한·scope·attempt/fence 검사는 매 경계 유지한다. 전체 확인 선조회 뒤 필요한 조각만 만든다. |

계획 리뷰1: REVISE C0/H1/M1/L0/INFO0. 입력44개·원본 snapshot44개 hash와 absent3개를 확인한 새 독립 검토다. 두 지적을 위 본문에 반영했다. packet ACK의 불변 재생과 전체 확정 조회를 분리하기 위해 읽기 전용 source-confirm도 구체화했으며 변경 입력으로 새 계획 재검토를 진행한다. 구현·실제 DB/HTTP/browser/native 실행0이다.

계획 리뷰2: PASS C0/H0/M0/L0/INFO0. 새 독립 reviewer가 현재44개·snapshot44개·absent3개를 재확인하고 불변43개 검토를 재사용했다. QUESTION의 수신 PEER와 terminal의 실행 attempt, UTF-16 경계/hash 벡터, packet ACK와 전체 확정 조회의 분리를 확인했다. 실제 구현·검사 통과 판정은 아니다. 이후 사용자 폴더 자동 탐색 결정은 위 Context와 실행 보류에 기록했으며, 그 선행 구현으로 바뀌는 계약은 별도 추가 검토한다.


자동 탐색 재계획: 읽기 전용 범위 조사2건의 공개 byte/codeunit/peer 검증 의미를 반영해 위 본문을 보완했다. 기존 v132/128KiB와 typed 실제 관찰을 분리하고 공개4MiB/8192-byte chunk/512packet, token·whole hash·복구·flat UI의 경계를 정했다. 원래 전체 구현 승인으로 계획을 보완하지만 과거 리뷰2를 새 계약의 승인으로 확대하지 않는다. 새 독립 계획 리뷰3는 PASS이며029 소스 검토는 대기 중이다. 027 운영 코드 구현·실제 실행은0이다.

독립 자동 탐색 계획 리뷰3: PASS C0/H0/M0/L0/INFO0. 현재 관찰 생산자·runner·SQL 질문 예약과 새 공개 계약을 대조했다. 입력296개·고정본290개·부재6개가 일치했고 부모의029 정본 보강5개는 판정에 영향이 없었다. 원래v1·관찰 순서·공개 byte 상한·token/UTF16/hash·partial/확정·정확한 event 대상·권한·복구·lazy 조회의 필수 검사 범위를 확인했다. 이 판정은027 구현이나 실제SQL·브라우저 수용의 통과가 아니다. 029 소스 검토의 선행 조건을 유지한다.

독립 구현 리뷰1: REVISE C0/H3/M1/L0/INFO0. 현재 입력278개·고정본278개·원본 산출물125개·상대 delta42개가 일치했다. 연결기 입력93개의 기존 통과와 최종 화면 입력 검사를 재사용하되 새 공개 연결은 직접 검토했다. 위 네 지적의 보정과 다음 독립 검토를 진행한다. 절대 성능 지연·lease 실패는 측정하지 않았으며 실제 SQL·HTTP·브라우저 실행은0이다.

구현 리뷰1 보정: H1의 정확한 공개 fixture·원래 v1 hash, H2의 기존 부모 broker·관리자 환경 제거, H3의 AUTO 혼합·올바른 hash의 비정규 전체 자료10종·UNKNOWN/HISTORICAL과 기존 PEER 채택 정의, M1의 소유 동결 기록·기록 교체 시 재투영·확정 선조회·누락 조각 생성이 코드에 반영됐다. 원본 실패를 보존했으며 최종 격리 검사 결과는 [개발 현황](../planning/delivery-and-validation.md)에 기록한다. 실제 실행을 검사 정의나 컴파일 통과로 대체하지 않는다. 독립 리뷰2 PASS를 확인했다. Step1–4는 소스·검사 정의·독립 리뷰 범위에서 완료했으며 실제 수용인 Step5는 미완료다.

독립 구현 리뷰2: PASS C0/H0/M0/L0/INFO0. 입력285개·고정본285개·원본 산출물233개와 이전 publisher 검증 파일54개, 총괄 명령 로그23개의 hash와 크기가 일치했다. 리뷰1의 불변 입력265개는 범위를 제한해 재사용했고 변경13개·신규7개와 관련 adapter/store를 직접 확인했다. HIGH3건·MEDIUM1건은 RESOLVED다. 현재 최종 코드의 연결기 검사와 문서 갱신을 확인했으며 실제 SQL·HTTP·브라우저·AI·Git 실행은0이다. Step5를 완료하거나 계획을 보관하지 않는다.
