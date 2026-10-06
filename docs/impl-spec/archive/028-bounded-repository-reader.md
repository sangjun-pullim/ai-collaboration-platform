---
status: done
date: 2026-10-06
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 승인한 저장소의 제한된 목록·검색·읽기 모듈

## Context

[PRD의 로컬 AI 연결](../../PRD.md#로컬-ai-연결)에 따라 사용자는 2026-10-06 선택한 폴더 안의 필요한 코드 자동 탐색을 확정했다. 현재 `RuntimeFilePolicy`는 승인 때 선택한 최대 32개·64KiB 파일만 읽는다. 폴더 선택 화면만 바꾸어서는 코드 탐색을 지원할 수 없다.

이번 단계는 파일 검사 중복 없이 목록·문자열 검색·부분 읽기를 담당하는 깊은 내부 모듈을 구현한다. 다음 단계에서 새 설정 세대의 폴더 읽기 승인, 두 provider의 도구·이력, runner의 내구 기록·예산 예약에 연결한다. 이번 모듈을 기존 설정에 자동 적용하지 않는다. 웹/중앙 source 이력 027은 이 후속 연결을 반영한 뒤 다시 진행한다.

전체 구현의 기존 사용자 위임과 이번 자동 탐색 선택을 적용한다. 권한 경계의 독립 계획·구현 리뷰는 필수다. `.git`은 읽기 전용이므로 현재 `feat/chat-first-experience` 체크아웃의 원본 파일과 상대 patch를 별도 기록하고 Git 쓰기를 하지 않는다. Git 기록을 완료했다고 표시하지 않는다.

## Affected Files

1. `packages/local-connector/src/runtime-file-policy.ts` — 기존 선택 파일의 검사·읽기를 공통 내부 I/O에 위임한다. 선택·snapshot 비교·공개 문자열 검사의 외부 계약은 유지한다.
2. `packages/local-connector/src/workspace/safe-file-reader.ts` — 새 내부 모듈. root/조상·descriptor·경로 식별자와 일반 파일·소유권·링크·내용 검사를 단일화한다.
3. `packages/local-connector/src/workspace/repository-path-policy.ts` — 새 내부 모듈. 코드/일반 문서 판별과 자동 탐색에 추가되는 제외 규칙을 소유한다.
4. `packages/local-connector/src/workspace/repository-reader.ts` — 새 내부 모듈. `RepositoryReader`의 `list`, `search`, `read`와 실행 한 번에 누적되는 예산·결과 기록을 소유한다.
5. `packages/local-connector/tests/repository-reader.test.ts` — 새 인터페이스의 유의미한 실행 검증.
6. `packages/local-connector/tests/runtime-file-policy.test.ts` — 기존 파일 접근 검사의 assertion·timeout을 보존하며 공통화의 추가 회귀를 검증한다.
7. `docs/ARCHITECTURE.md`, `docs/planning/delivery-and-validation.md`, `docs/README.md` — 실제 구현 범위와 다음 통합 단계의 위치를 설명한다. 검사 수치는 delivery 한 곳에서 유지한다.
8. `packages/local-connector/src/workspace/automatic-content-policy.ts` — 리뷰2 성능 보완으로 추가하는 순수 내부 모듈. 자동 모드의 quoted key·literal 검사를 소비한 위치를 전진하는 선형 scan으로 소유한다. 선택 파일과 공개 문자열의 기존 패턴은 바꾸지 않는다.

## Affected Dependents

- `workflow-runner.ts:900,1003,1806-1873` — 기존 `RuntimeFilePolicy` 선택 파일 읽기, 변경 감지와 도구 결과 재생을 유지한다. 이번 단계에서 새 모듈을 연결하지 않는다.
- `codex-adapter.ts:845,938`, `claude/adapter.ts:262,321` — 기존 파일 정책 준비·검증을 유지한다. 도구 광고와 허용 목록은 변경하지 않는다.
- `settings/manager.ts:485,610,681`, `settings/local-confirmation.ts:52,78`, `settings/folder-picker.ts:116` — 선택 파일 승인과 root 확인은 계속 같은 의미를 갖는다.
- `provider-adapter.ts:55`, `cli/runtime-command.ts:32,64-77` — `files: []`는 기존 root 검사이며 자동 폴더 읽기 승인이 아니다.
- `workflow/source-snapshot.ts:109,193`, `runtime-store.ts:714-732,1089-1109` — `SourceObservation v1`의 입력 전 선택 파일 관찰과 hash·세대 불변성을 유지한다.
- `tests/runtime-fixture.ts`, `tests/workflow-file-capacity.test.ts`, `tests/workflow-runner.test.ts`, `tests/source-observation-*.test.ts` — 기존 fixture·파일 읽기 예약·권한·저장 결과 검사를 재사용한다.

## Implementation Steps

### [x] Step 1: 공통 읽기와 기존 선택 파일 계약 보존

**File**: `workspace/safe-file-reader.ts`, `runtime-file-policy.ts`, `tests/runtime-file-policy.test.ts`

- 기존 `runtime-file-policy.ts:47-60,101-199`의 root·조상 확인과 파일 descriptor 읽기/정리를 내부 모듈로 옮긴다. 기존 `RuntimeFilePolicy.root/select/assertUnchanged/read` 서명과 오류 코드를 유지한다. 공개 문자열 검사와 파일 내용 검사에 같은 비밀 패턴을 사용한다. 내부 재사용 함수만 export하고 root 진입 파일의 공개 인터페이스를 늘리지 않는다.
- 기존 모드의 64KiB 파일/전체 선택 512KiB/32개 한도, strict UTF-8, 비밀/제어 문자 거절, root canonical identity, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, UID·공유 쓰기·하드링크·FIFO 거절과 읽기 전후 inode/dev/size/mtime/ctime 검사를 유지한다. 열린 descriptor는 모든 종료에서 닫는다.
- 자동 탐색의 조상 디렉터리는 symlink·다른 사용자·공유 쓰기를 거절하고, 승인 root 아래 각 조상의 identity를 읽기 전후 대조한다. 기존 mode의 승인 파일에 대한 기존 거절을 약화하지 않는다. 모드별 상한은 검증한 내부 상수에서 전달하며 상대 AI가 상한을 늘릴 수 없다.
- root와 실행 권한을 모든 I/O 앞·뒤에 검사한다. 외부 `check()`가 던지는 `AUTHORITY_LOST` 등 원래 오류를 바꾸지 않는다. 읽기 중 root/경로 교체와 비정규 descriptor를 거절한다. Node 경로 기반 읽기를 원자적인 파일시스템 동결이나 native 전체의 접근 제한으로 표현하지 않는다.
- 내용은 허용된 최대 파일 크기+1까지만 읽고 초과·short read를 거절한다. 다음 단계가 사용하는 자동 모드도 전체 허용 파일의 UTF-8·비밀 내용 검사를 완료한 뒤 부분 내용을 반환한다. 선택 파일 모드는 같은 전체 원문과 같은 snapshot을 반환해야 한다.

### [x] Step 2: 목록·문자열 검색·부분 읽기와 누적 예산

독립 구현 리뷰3의 JWT 검사 성능 HIGH1을 보완했고 사용자가 승인한 추가 독립 리뷰4가 통과했다. 이 완료는 제한된 파일 탐색 모듈에 한정된다. 실제 채팅 실행기 연결은 029에서 진행한다.

독립 구현 리뷰1의 HIGH4개와 리뷰2의 문자열 scan 성능 HIGH1을 보완했다. 원본 공개 재현에서 허용107,520바이트 읽기가3,752.61ms 뒤 RUNTIME_CAPACITY였고524,288바이트는 소유 test child의10초 상한에서 정리됐다. 같은524,288바이트 회귀는 수정 전 실패·수정 후 통과했으며 최종 모듈44/44가 통과했다. 순수 내부 automatic-content-policy 모듈의 유한 key-prefix와 전진하는 값 검사로 반복 suffix scan을 제거했다. 10초는 test child의 정리 상한이며 제품의 물리적 응답 기한으로 주장하지 않는다.

**File**: `workspace/repository-path-policy.ts`, `workspace/repository-reader.ts`, `workspace/automatic-content-policy.ts`, `workspace/safe-file-reader.ts`, `tests/repository-reader.test.ts`

- 작은 진입 인터페이스를 제공한다: 승인된 `RootIdentity`와 필수 실행 `check`로 reader 한 개를 생성하고 `list({directory?, after?})`, `search({query, directory?})`, `read({path, offset?, expectedHash?})`를 호출한다. root를 복사해 보관한다. 생성만으로 사용자 승인·실행 권한이 생기지 않으며, 현재 provider/runner는 이를 사용하지 않는다. clock 주입 등 내부 시험 경계는 필요한 최소 범위로 제한한다.
- root 안의 상대 경로만 허용한다. 기존 `isSelectedPath`는 선택 파일 모드의 거절 동작 그대로 유지한다. 자동 모드에는 별도의 구조 경로 검사와 디렉터리/파일별 보호 이름 판정을 둔다. `src/auth/login.ts` 같은 일반 인증 구현 코드는 허용하지만 `auth.json`·credential 자료는 거절한다. 숨김 경로, `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `mcp.json`, agent의 settings 파일과 인증·credential·secret 자료 파일, 생성물·vendor·build·dist·coverage·캐시·바이너리를 목록·검색·읽기에서 제외한다. `.env`·키·DB·개인 도구 폴더는 기존대로 거절한다. 코드와 일반 문서는 명시적 확장자 허용 목록으로 판단하며 `package.json`, `tsconfig*.json` 등 일반 프로젝트 설정은 내용 검사를 통과한 경우만 읽는다. 안전한 코드 확장자의 인증 구현 파일과 인증 자료 파일을 같은 이름 규칙으로 묶지 않는다. 보호 이름은 대소문자에 무관하다. `isSelectedPath` 자체를 바꾸어 과거 승인을 다시 해석하지 않는다.
- 목록은 해당 디렉터리의 직접 자식 중 허용된 파일·디렉터리만 반환한다. 파일 내용은 읽지 않는다. 출력 순서와 `after` cursor는 JavaScript UTF-16 코드 단위 문자열 순서이며 `localeCompare`를 사용하지 않는다. cursor는 상대 경로이고 현재 조회의 위치일 뿐 고정 Git snapshot을 뜻하지 않는다. 목록은 최대 64개·실제 JSON UTF-8 8KiB 중 작은 상한을 지키고 `nextCursor`/`truncated`를 표시한다.
- 검색은 최대 256 코드 단위의 비어 있지 않은 literal 문자열이며 정규식·shell·외부 프로세스를 사용하지 않는다. 제한된 tree를 탐색하고 전체 내용 검사를 통과한 파일에서 최대 16개 일치 줄의 제한된 발췌만 반환한다. 거절·대형 파일·예산/출력 한도로 범위를 완주하지 못하면 `truncated`를 표시한다. 반환할 항목에는 상대 경로·1기반 줄 번호·발췌·전체 파일 SHA-256·읽은 ISO 시각·원본 `byteStart/byteEnd`·발췌 hash를 연결한다. 발췌 byteStart를 후속 read의 offset으로 사용할 수 있어야 한다. 검색했던 모든 파일을 AI가 읽었다고 표시하지 않는다.
- 읽기는 파일 최대 2MiB이며 offset은 UTF-8 byte 경계만 허용한다. `expectedHash`가 있으면 전체 파일 hash 불일치에서 `SNAPSHOT_CHANGED`다. 전체 허용 파일을 먼저 검사·hash한 뒤 실제 JSON UTF-8 8KiB에 맞는 code point 발췌를 반환한다. 자동 모드의 offset·범위·hash는 원본 bytes 기준이다. UTF-8 BOM도 원본 bytes와 반환 문자열에 보존하고 BOM 내부 offset 1·2는 거절한다. 기존 선택 파일 모드의 BOM 제거 동작은 유지한다. 결과에 상대 경로·전체 hash·전체 크기·전체 `lineCount`·읽은 시각·`byteStart/byteEnd`·발췌 hash·`nextOffset`·`truncated`를 포함한다. JSON escape 확대와 astral 문자를 포함해 offset/범위를 검증한다. 파일 뒤쪽의 비밀 내용도 전체 읽기를 거절한다. 자동 모드에서는 일반 JSON/YAML과 코드 object literal의 quoted sensitive key/password/API key/credential에 nonempty literal 값이 있으면 짧은 값도 거절한다. 기존 선택 파일·publicText의 패턴 동작은 유지한다. `lineCount`는 전체 검증한 원문의 `split('\n').length` 의미를 따른다. 빈 파일은 1줄이며 마지막 개행도 계산한다. 발췌로 전체 줄 수를 추정하지 않는다. 2MiB 초과는 몰래 자른 성공으로 반환하지 않는다.
- reader 한 개는 실행 한 번 동안 유지한다. 호출 256회, 동시 작업 4개, 관찰한 디렉터리 엔트리 20,000개, 방문 디렉터리 512개, 파일 content I/O 총 32MiB, 논리 호출 3초와 전체 활성 작업 경과 30초를 고정 상한으로 적용한다. 3초는 후속 I/O와 성공 반환을 차단하는 기한이며 OS I/O의 물리 중단·호출자 반환 기한이 아니다. 전체 30초는 reader에 활성 호출이 한 개 이상인 구간의 합집합으로 계산하고 호출 사이 idle 시간과 병렬 구간의 중복 합산은 제외한다. `performance.now()` 기준의 monotonic clock을 사용한다. 디렉터리는 bounded streaming으로 열어 전체 무제한 `readdir` 배열을 만들지 않는다.
- 호출·동시성·bytes는 I/O 전에 동기적으로 예약하고, 실제 관찰/읽기를 한 실패에서는 소비한 예산을 환불하지 않는다. 중복·새 query·새 도구에서 누적 예산을 초기화하지 않는다. 동시성은 소유 descriptor/디렉터리 handle 정리가 끝난 후 해제한다. 상한 초과는 기존 `RUNTIME_CAPACITY`, 동시성 초과는 `RUNTIME_BUSY`, 정책·입력 거절은 `TOOL_REJECTED`, 관찰 변경은 `SNAPSHOT_CHANGED`로 구분한다.
- await 이후 clock·외부 `check()`를 재검사하고 시간 초과/권한 상실 뒤 성공 결과를 반환하지 않는다. 물리적으로 끝나지 않는 OS I/O를 timer만으로 중단했다고 주장하지 않는다. 검색·목록의 제한된 부분 결과와 접근 권한 상실은 구분하며 후자는 성공 결과를 반환하지 않는다.
- 스트림의 엔트리 읽기도 `await` 전에 동기적으로 예약한다. 관찰 뒤 검사 실패로 예약을 환불하지 않는다. 반환하는 검색 발췌에는 전체 literal 검색어가 반드시 포함되어야 한다. 남은 JSON 예산에 검색어 전체를 넣을 수 없으면 그 항목을 생략하고 `truncated`를 반환한다. 자동 모드의 quoted 민감 key는 표준 escape를 해석하고 비어 있지 않은 일반 template literal도 검사한다. 빈 placeholder와 코드 참조는 유지한다. 외부 `check()`의 최초 오류를 보존해 이후 모든 guard에서 다시 던지고 정책 거절의 부분 검색 결과로 삼키지 않는다.
- 자동 내용 검사에서는 escaped quote마다 전체 suffix를 재시도하는 정규식을 제거한다. 읽은 위치를 전진시키는 scan 또는 먼저 유한한 sensitive key 후보를 확인하는 방식으로 전체 파일에 선형인 처리를 한다. 일반 quoted 값과 YAML 모두 같은 반복 스캔을 피한다. 코드 평가는 하지 않으며 기존 escaped key/template/빈 값/코드 참조·뒤쪽 비밀 거절을 유지한다. 새 순수 내용 모듈은 I/O·전역 변경을 하지 않고 안전 읽기 모듈의 자동 mode에서만 호출한다.
- 리뷰3 보정안은 자동 모드의 JWT 검사만 전진하는 token 검사로 분리한다. 긴 token에 있는 각 eyJ에서 남은 전체 문자열을 다시 검사하지 않는다. 기존 selected/publicText 정규식과 key·기타 비밀 감도는 유지한다. 같은524,288바이트 공개 읽기의 실패→통과, 실제 JWT의 거절과 boundary/최소 길이·끝부분 비밀을 검증하고 관련 검사를 변경된 입력에 맞게 다시 확인한다. 사용자가 승인한 추가 독립 리뷰는 이 보정과 영향받는 부분을 검토한다.
- 읽기 자료는 현재 코드 내용에 대한 로컬 관찰이다. root 전체를 한 시점에 동결한 증거, 실제 provider가 사용한 증거, 코드 수정·테스트·공동 공개 승인으로 재사용하지 않는다. 기존 `SourceObservation v1`·저장 schema·provider 도구 계약은 이번 단계에서 변경하지 않는다.

### [x] Step 3: 관련 검증·독립 리뷰와 통합 준비

**File**: 이번 단계 전체 및 문서

- 아래 관련 검사를 실행하고 변경 때문에 실패한 검사는 수정한다. 기존 assertion·fixture·timeout을 줄여 통과시키지 않는다. source와 입력이 같은 검사는 hash 대조 뒤 재사용한다.
- 공통 파일 I/O를 사용하는 기존 선택 파일·runner 파일 읽기/변경/재생·입력 관찰 검사와 새 reader의 권한·예산 검사를 독립 reviewer에게 전달한다. source 비교 patch는 `.git` 갱신 없이 baseline과 현재 파일로 만든다.
- 기존 전체 connector의 15초 CLI 제거 취소와 native-tools의 파일 읽기/저장 경합은 원본 기록을 유지한다. 실제 검사 실패는 결과에서 숨기지 않으며 이번 파일 I/O 변경의 영향을 새로 판단한다. 영향 없음 판정은 과거 리뷰 문구만으로 재사용하지 않는다.
- Architecture는 새로운 내부 seam과 아직 운영 연결을 하지 않은 범위를 설명하고 delivery에는 현재 검사와 다음 단계만 기록한다. 모든 Step·검사·필수 리뷰를 완료하면 로컬 모듈 범위로 계획을 보관한다. 다음 단계의 동의·설정·runner·양 provider 연결 계획을 작성하여 계속 실행한다. 사용자에게 폴더 자동 읽기나 실제 Claude·두 PC 완료로 보고하지 않는다.

## Tests

- `runtime-file-policy.test.ts` — 기존 FIFO·descriptor/path 교체·공유 쓰기·링크/하드링크·비밀·UTF-8·64KiB·선택 snapshot 변경 검사와 원문 반환을 유지한다. 공통화의 새 동작에는 먼저 거절 재현을 작성한다.
- `repository-reader.test.ts` — 파일을 미리 선택하지 않은 owned fixture에서 목록→literal 검색→읽기가 코드 내용을 찾는다. 32개를 넘는 코드 파일을 목록과 cursor로 탐색한다.
- 같은 테스트 — 밖/absolute/상위 이동/backslash/NUL 경로, 보호 폴더·숨김·지침·인증 자료·생성물·바이너리와 filename 대소문자를 목록/검색/읽기에서 차단한다. `src/auth/login.ts`는 자동 모드의 목록·검색·읽기에서 허용하고 `auth.json`·credential 자료는 거절하며 기존 선택 파일 모드는 auth 디렉터리를 계속 거절한다. symlink·하드링크·FIFO·UID·공유 쓰기·root/조상/descriptor/path 교체를 거절하고 handle 정리를 확인한다.
- 같은 테스트 — 64KiB를 넘는 코드와 2MiB 경계, 전체 파일 뒤쪽 비밀·invalid UTF-8·control 문자를 확인한다. quoted sensitive key의 JSON/YAML/code literal·파일 뒤쪽·짧은 값·legacy 보존을 검증한다. 전체 lineCount의 큰 파일·빈 파일·BOM·CRLF·마지막 개행과 BOM fixture의 offset 0·3·후속 발췌와 원본 범위/hash를 검증하고 offset 1·2를 거절한다. 발췌 hash·전체 hash·범위·code point cursor·변경된 파일 expectedHash, JSON escape 8KiB 상한을 검증한다.
- 같은 테스트 — literal regex 문자를 코드로 해석하지 않음, 줄 번호·검색 byte 범위·발췌 hash와 후속 read의 연결·출력 16개/8KiB, 부분 검색의 `truncated`를 확인한다. 목록의 UTF-16 정렬은 astral 문자/`\uE000`로 검증한다.
- 같은 테스트 — 동시 4개의 I/O 예약과 5번째 거절, 실패/권한 상실 뒤 예산과 handle 상태, I/O·호출·엔트리·디렉터리 상한, injected clock의 호출·전체 시간 한도, 지연 I/O 완료 뒤 성공 차단을 검증한다. 시험 mock은 원래 메서드를 복원한다.
- 같은 테스트 — 엔트리 잔여 예산1에서 동시4개 읽기의 총 관찰이20,000개를 넘지 않음, 관찰 직후 외부 검사 실패의 소비 유지, 앞 결과가 예산을 소진해도 모든 검색 발췌에256 코드 단위 query 전체가 포함됨, escaped 민감 key·noninterpolated template literal의 거절과 빈 값/참조/legacy 유지, 검색 중 one-shot 외부 `RuntimeError("TOOL_REJECTED")` 원본 객체의 보존을 수정 전 RED→수정 후 PASS로 검증한다.
- 같은 테스트 —107,520바이트와524,288바이트의 허용 UTF-8 escaped-quote 반복 파일을 공개 `read`로 읽어 실제 JSON8KiB·전체 hash·원본 범위를 정상 반환한다. 유효 코드의 큰 quoted 문자열도 확인한다. 기존 replay/감도 검사를 약화하지 않고 새 회귀를 먼저 RED로 기록한다. 물리 반환 deadline을 새로 보장하는 검사로 해석하지 않는다.
- 기존 `workflow-file-capacity`, `workflow-runner` (native-tools를 포함한 원래 검사), `source-observation-store`, `source-observation-runner`, `source-snapshot`, `local-confirmation` — 선택 파일 도구·내구 결과 재생·자료 불변성과 승인 UI 동작을 유지한다. 빈 파일 배열이 자동 폴더 권한이 되지 않은 것은 새 모듈의 운영 참조 0개와 기존 호출자/설정 source 비교로 확인한다.

## Risks

- 자동 탐색이 노출 범위를 늘린다. 이번 단계에서는 운영에 연결하지 않고 다음 단계의 명시적 세대 승인과 내구 기록이 모두 적용될 때 사용한다.
- 큰 파일의 앞부분만 검사하면 뒤의 비밀과 전체 hash를 놓친다. 2MiB 이내 전체 검사 후 작은 발췌를 반환한다.
- 탐색·동시 읽기의 비용은 누적된다. 출력·bytes·시간·메타데이터·동시성 상한을 caller 간 공유하고 모든 호출에서 소비한다.
- path 기반 I/O의 관찰 사이 변경은 원자적인 디렉터리 동결과 다르다. descriptor·조상·경로의 전후 검사와 가능한 경합 검증 범위를 명시한다.
- Git/DB/browser/native 실행은 현재 승인된 writable 위치의 제약이 있다. 소스·격리 파일 I/O의 통과로 실제 통합을 주장하지 않는다.

## Verification

Node 24 경로 `/Users/pullim/.npm/_npx/387698761821791d/node_modules/node/bin/node`와 기존 npm CLI를 사용한다. 환경 기본값을 변경하지 않는다.

- connector `npm run typecheck`와 `npm run build`.
- connector `node --test dist/tests/repository-reader.test.js dist/tests/runtime-file-policy.test.js`.
- connector 관련 검사 `workflow-file-capacity`, `workflow-runner` (native-tools를 포함한 원래 검사), `source-observation-store`, `source-observation-runner`, `source-snapshot`, `local-confirmation`.
- connector 전체 `node --test dist/tests/*.test.js`와 원래 실패/취소 영향 분석. 결과를 그대로 보존한다.
- root TypeScript compile·unit·lint 경고 0·`npm run format`·`npm run format:check`; root unit은 변경 없음이 확인되면 이전 동일 입력 결과를 재사용한다. Next preview 생성물·실행 수명은 바꾸지 않는다.
- 기준 파일과 현재 파일의 상대 patch, `git diff --check`(읽기 전용), 문서 상대 링크 확인, 독립 계획·구현 리뷰.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 계획 리뷰1 H1: 인증 구현 코드 차단 | HIGH | ACCEPTED | legacy isSelectedPath는 유지하고 자동 모드의 별도 구조/파일 정책에서 인증 구현 코드와 인증 자료를 구분한다. |
| 계획 리뷰1 M1: BOM 바이트 범위 불일치 | MEDIUM | ACCEPTED | 자동 모드 원본 bytes·BOM 보존, legacy 문자열 유지와 offset0/3·1/2 거절 검사를 명시했다. |
| 계획 리뷰1 M2: 시간 예산 의미 | MEDIUM | ACCEPTED | 논리 성공/후속 I/O 제한과 활성 구간 합집합·idle 제외를 명시했다. 물리 중단을 주장하지 않는다. |
| 구현 리뷰1 H1: 엔트리 예산 동시 예약 누락 | HIGH | ACCEPTED | 부모 공개 재현에서 관찰20,003개를 확인했다. 읽기 전 동기 예약과 관찰 후 실패의 비용 보존을 보완한다. |
| 구현 리뷰1 H2: 발췌의 검색어 잘림 | HIGH | ACCEPTED | 둘째 발췌279바이트가 전체 query를 포함하지 않은 RED를 보존했다. 전체 query를 포함할 수 없는 항목은 생략하고 truncated를 반환한다. |
| 구현 리뷰1 H3: quoted 민감 literal 표기 누락 | HIGH | ACCEPTED | 표준 escape로 표현된 key와 일반 template literal을 자동 모드에서 검사하며 빈 값/참조/legacy 회귀를 유지한다. |
| 구현 리뷰1 H4: 외부 검사 오류의 부분 결과 처리 | HIGH | ACCEPTED | 최초 외부 check 오류를 latch해 모든 guard에서 원본을 다시 던지고 검색 정책 거절과 구분한다. |
| 구현 리뷰1 I1: 전체 CLI 취소의 시간 영향 | INFO | ACCEPTED | 517개 중516통과·취소1·exit1 기록을 유지하며 변경된 공통 I/O의 실행 시간 영향은 아직 미확인이다. 전체 통과를 주장하지 않는다. |
| 구현 리뷰1 I2: 운영 통합 미완료 | INFO | ACCEPTED | core의 운영 호출0개와 다음 통합 단계의 범위를 유지한다. |
| 구현 리뷰2 H1: escaped quote의 이차 반복 scan | HIGH | ACCEPTED | 원래 H1–H4는 해소됐다. 다른 원인의 새 성능 회귀를 공개 read2개에서 재현했으며 순수 자동 내용 모듈의 선형 scan으로 보완한다. |
| 구현 리뷰2 I1: 전체 병렬 취소 원인 미확인 | INFO | ACCEPTED | 원래15초 검사 자체는 변경 전·후 각각1/1 통과했으나 전체 병렬 취소의 원인/시간 영향은 미확인으로 유지한다. |
| 구현 리뷰2 I2: 운영 연결과 Step3 미완료 | INFO | ACCEPTED | 로컬 모듈과029 동의/provider/runner 연결을 구분한다. |
| 구현 리뷰3 H1: 자동 모드의 JWT suffix 반복 | HIGH | ACCEPTED · RESOLVED | 원본524,288바이트 공개 read 실패를 보존했다. 사용자가 승인한 자동 모드의 전진 JWT 검사와 추가 독립 리뷰4가 통과했다. 같은SHA의512KiB·정확2MiB 공개 읽기가 정상 반환하며 selected/publicText의 기존 패턴과 전체 코드 투영은 같다. |
| 구현 리뷰3 I1: 전체 병렬 취소 원인 미확인 | INFO | ACCEPTED | 원본517개 중516통과·취소1·exit1 및 시간 영향UNVERIFIED를 유지한다. |
| 구현 리뷰3 I2: 운영 연결 미완료 | INFO | ACCEPTED | 운영 caller0이며029 통합의 완료 근거로 사용하지 않는다. |

독립 계획 리뷰2: PASS C0/H0/M0/L0/INFO1. 기존 27개 불변 입력·신규 미존재4개 검토를 재사용하고 수정 계획·추가7개 입력을 검토했다. 검색 발췌의 byte 범위·hash INFO 권고는 ACCEPTED로 위 Step2와 Tests에 반영했다. 구현은 전체 목표의 기존 위임과 사용자의 자동 탐색 선택으로 진행하며 실제 운영 연결 완료는 후속 단계에서 판정한다.

단계1–2 구현 확인: 운영5개·검사2개에서 공통 안전 읽기와 제한된 RepositoryReader를 구현했다. 구현 리뷰1은 REVISE C0/H4/M0/L0/INFO2였고 네 HIGH를 모두 보완했다. 구현 리뷰2는 기존 네 지적의 해소를 확인했으며 별도 성능 HIGH1을 제시했다. 이 지적도 보완해 최종 모듈44/44·타입·build·lint 경고0·format/check를 확인했다. SourceObservation/provider/runner/settings의 운영 연결은 바꾸지 않았다. 관련154/154의 재사용은 selected 분기의 정확한 동일성과 순수 import 초기화·legacy 회귀에 근거한다. root218/218·네 root compile은 변경 없는 입력의 결과를 재사용한다. 보완 전 전체517개 중516통과·취소1(exit1)은 원본 입력 범위로 유지한다. 원래 취소된 검사는 변경 전·후 단독 실행에서 각각1/1 통과했으나 전체 병렬 취소의 원인과 시간 영향은 미확인이다. Step3은 독립 구현 리뷰3·문서·최종검증이 남아 있다. 실제 동의/provider/runner 연결은029 계획으로 이어간다.

독립 구현 리뷰3: REVISE C0/H1/M0/L0/INFO2. 이전 H1–H4와 quoted/YAML 성능 보완은 해소 확인을 재사용했다. 새 JWT 반복 scan은 미해결이다. 검토 입력96개와 baseline patch의 운영5개·검사2개가 정확히 일치했고 부모의 공개 재현1회를 추가 확인했다. 실제 AI·DB·Git 실행은0이며 계획은 active로 유지한다. 상한에 도달한 모듈 구현은 멈추고 별도029의 계획과 독립 작업을 이어간다.

추가 보완 승인: 2026-10-06 사용자가 자동 모드의 JWT 성능 보완과 독립 리뷰1회 추가를 승인했다. 이 승인은 이번 보정에 한정되며 기존 리뷰의 REVISE·실패·취소 기록을 유지한다. 실제 AI 입력은 추가하지 않는다. 동일 체크아웃의 029 Step1–3 구현을 고정한 뒤 순서대로 보정한다.

추가 독립 구현 리뷰4: PASS C0/H0/M0/L0/INFO2. JWT 반복 검사를 전진 scan으로 바꾸고 원래 경계·대소문자·길이·payload·signature 감도를 보존한 것을 확인했다. 기존 HIGH 해소는 불변 부분의 이전 검토를 재사용했다. 새 검증의 입력234개·검토 입력267개·검증 로그14개 SHA가 일치했다. 모듈47/47·현재 provider/runner/selected244/244·root222/222와 유한 비교10,080개를 확인했다. build/type/lint 경고0·format/check·diff를 통과했다. 원본 전체517개 및 최근553개의 취소1·exit1은 역사적 기록으로 유지하며 최종 코드의 전체 PASS로 바꾸지 않았다. Git 쓰기·실제 AI/DB/browser 실행은0이다. 문서와 상대 링크를 갱신해 모듈 계획을 보관하며 운영 연결의 완료 여부는029에서 판정한다.
