---
verified-against: cecc55c213c3d34b2c6480de55aa20ac10d9b0b9
sources:
  - src/app/api/**
  - src/features/room-access/contracts.ts
  - src/features/room-access/request-policy.ts
  - src/features/room-access/access-service.ts
  - src/features/device-binding/contracts.ts
  - src/features/device-binding/request-policy.ts
  - packages/local-connector/src/contracts.ts
  - src/features/investigation-coordinator/**
  - packages/local-connector/src/workflow-contracts.ts
  - src/features/runtime-settings/**
  - packages/local-connector/src/settings/contracts.ts
  - supabase/migrations/20261005001000-owner-local-ai-setup.sql
  - supabase/migrations/20261006001100-own-ai-input-pause.sql
  - supabase/migrations/20261006001200-owner-approved-repository-access.sql
  - supabase/migrations/20261006001300-shared-input-source-history.sql
  - supabase/migrations/20261009001700-runtime-model-display-names.sql
---
# 사람 입장·AI 채팅방·기기·실행 조정 계약

Git 기준과 작업트리의 사람 cookie Auth·기기 bearer·내구 조사·소유자 설정 계약을 설명한다. 실행 보고와 실제 provider 종결의 검증은 구분한다. 진행 상태와 검증 수치는 [개발 순서와 검증 계획](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## 공통 요청과 응답

모든 mutation은 POST·`application/json`·실제 수신 크기 최대 16 KiB·unknown-field 거절을 적용한다. 사람 action은 `Origin`이 `APP_ORIGIN`과 정확히 일치해야 하며 cookie로 현재 사용자를 확인한다. connector action은 별도의 bearer로 인증하고 cookie를 신원으로 사용하거나 갱신하지 않는다. actor·owner·RPC 이름·외부 redirect를 본문으로 선택할 수 없다. 계약의 세부 validator가 정본이다.

성공은 `{"ok":true,"data":{...}}`, 실패는 `{"ok":false,"error":{"code":"..."}}`이며 예외 원문이나 SQL 오류를 반환하지 않는다. 응답은 `private, no-store`다. 사람 응답은 Cookie/Origin, connector 성공은 Authorization을 Vary에 포함하며 framework 토큰이 함께 올 수 있다. connector는 Cookie Vary·Set-Cookie를 사용하지 않는다.

인증 session은 서버가 관리하는 HttpOnly·SameSite=Lax cookie로 전달하고 HTTPS에서는 Secure를 적용한다. 브라우저 JSON에 session 원문을 반환하지 않는다. 보호 화면의 미인증 redirect는 `/login`으로 보낸다. `/app?invite=<64자리 hex>`의 유효한 초대 목적지는 `/login?invite=...`를 거쳐 복원한다. 외부 redirect를 받지 않는다. API에서는 proxy가 인증을 먼저 갱신하지 않으며 각 route가 Origin·본문·인증과 응답 쿠키를 처리한다.

## Auth action

| 경로 | body | 성공 data |
|---|---|---|
| `/api/auth/enter` | `code`, `displayName` | `userId`, `displayName`. 실제 Auth 사용자에게 회사 코드 입장을 기록한다. 확정된 무세션에서만 anonymous 사용자를 생성한다 |
| `/api/auth/logout` | `{}` | `{}`. 현재 Auth session을 signOut하고 모든 cookie chunk를 지운다 |

`enter`의 코드는 최대 128자이며 앞뒤 공백을 그대로 검사한다. 표시 이름은 최대 80자로 앞뒤 공백을 제거한다. 제어 문자·잘못된 UTF-8·추가 필드를 거절한다. 이름은 계정 복구나 권한의 증거가 아니다. 옛 `/code`·`/verify`는 404이고 메일을 발송하지 않는다.

입장 시도는 DB에서 사용자별 15분에 5회와 서비스 전체 1분에 60회로 제한한다. 신규 anonymous 생성은 서버 프로세스별 1분에 10회로 제한하며 Auth 공급자의 별도 제한도 적용된다. 429·5xx·통신 실패를 무세션으로 해석하지 않고 기존 사용자·모든 cookie chunk를 보존한다. 오류 응답에서 SDK가 생성한 삭제만 있는 쿠키 변경을 억제하며 성공한 갱신의 옛 chunk 정리는 적용한다. 확인 실패는 503, 확정된 미인증은 401이다.

명시적 로그아웃의 cookie 삭제가 같은 요청의 갱신보다 우선한다. 이후 웹 보호 요청과 refresh 재사용은 거절되어야 한다. 이미 발급된 모든 access JWT의 즉시 폐기를 보장하지 않는다. 그룹·방 권한 취소와 Auth 계정 정지는 별도로 검사한다.

## Access action

`/api/access/<action>`은 아래 여섯 action만 허용한다. 모든 요청에서 현재 Auth 사용자·회사 코드 입장과 live DB 권한을 확인한다.

| action | body | 성공 data·권한 |
|---|---|---|
| `bootstrap` | `groupName`, `title`, `goal`, `observation`, `environment`, `displayAlias` | `organizationId`, `roomId`. 로그인한 사람이 자기 그룹과 첫 방을 만든다 |
| `room` | `organizationId`, `title`, `goal`, `observation`, `environment` | `roomId`. 해당 그룹 owner만 방을 추가한다 |
| `invite` | `roomId`, `role` (`participant/observer`) | `code`, `expiresAt`. 현재 방 owner만 발급한다 |
| `join` | `code`, `displayAlias` | `roomId`. 유효한 초대를 원자적으로 소비한다 |
| `revoke-room-member` | `roomId`, `userId` | `removed`. 방 owner가 owner 이외의 멤버를 제거한다 |
| `revoke-group-member` | `organizationId`, `userId` | `removed`. 그룹 owner가 owner 이외의 그룹 멤버를 제거한다 |

초대 원문은 발급 응답과 발급자의 일시적인 화면 상태에서 전달한다. 사용자가 받은 초대 링크로 접속한 경우 입장 전 URL과 자기 참가 Dialog에 잠시 유지하며 참가 성공 때 URL에서 제거한다. 공동 이력·로그·다른 참가자의 HTML에 저장하지 않는다. 활성 room membership으로 재참가하면 초대 미소비·기존 role 보존과 함께 `ALREADY_MEMBER`를 반환한다. 재초대와 취소의 저장 규칙은 [DB-SCHEMA](DB-SCHEMA.md)를 따른다.

## 고정 오류

| HTTP | code |
|---|---|
| 400 | `INVALID_BODY`, `BODY_TOO_LARGE`, `CODE_REJECTED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `UNSAFE_ORIGIN`, `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `INVITE_UNAVAILABLE`, `ALREADY_MEMBER`, 기기의 `CONFLICT` |
| 429 | `CODE_COOLDOWN`, 기기의 `QUOTA` |
| 503 | `UNAVAILABLE` |

존재 여부를 포함해 접근할 수 없는 방의 보호 화면은 404를 사용한다. 알 수 없는 action도 404이다. backend 오류의 자세한 원인은 이 계약에 노출하지 않는다.

실제 route·화면 경계는 [프런트엔드 구조](FRONTEND-ARCHITECTURE.md), 전체 제품 계약의 의도는 [PRD](PRD.md)와 [BUSINESS-LOGIC](BUSINESS-LOGIC.md)를 따른다.

## 내구 조사와 실행 조정

사람의 `/api/investigations/<action>`은 `read`, `speak`, `start`, `interrupt`, `pause`, `resume`, `ask`, `cancel`, `input-state`, `input-control`만 허용한다. 현재 cookie 사용자·방 역할로 권한을 계산한다. 공동 발언은 실행을 만들지 않는다. `start`는 자기 origin과 다른 참가자의 peer binding·현재 epoch/revision·준비 보고·공유 확인을 요구한다. `resume`의 room mode는 intake만 재개하고 cycle mode는 원래 origin 소유자의 명시적 새 generation을 만든다. observer는 공동 이력 읽기만 가능하며 다른 사람의 새 답변 상태를 제어하지 않는다.

`ask`는 질문자 AI·기기·경로 없이 다른 소유자의 준비된 대상 하나에 질문한다. 본문은 `protocol:1`, `roomId`, `operationId`, `expectedUserId`, `targetAgentId`, `targetEpoch`, `expectedRoomRevision`, `publicText`, `confirmed:true`다. `cancel`의 본문은 `protocol:1`, `roomId`, `operationId`, `expectedUserId`, `requestId`, `expectedRoomRevision`이며 질문자나 대상 소유자가 해당 직접 질문 하나만 취소·중단할 수 있다. UUID `expectedUserId`는 화면을 연 뒤 로그인 주체가 바뀌지 않았다는 사전 조건이다. 서버는 현재 Auth가 없으면 `UNAUTHENTICATED`, 식별자가 다르면 `FORBIDDEN`을 반환한다. 이 필드로 다른 사용자의 권한을 얻을 수 없다. 원본 본문의 크기·필드를 검사한 뒤 사전 조건을 제거하고 실제 Auth를 기준으로 기존 권한·receipt를 처리한다. 동일 사람·operation·정규화 본문의 재전달은 저장된 결과를 반환한다.

직접 질문의 cycle은 `mode:DIRECT`, `targetAgentId`, `targetEpoch`, `generation:1`, `runsReserved:1`, `peerRoundsReserved:0`, `canInterrupt`를 반환한다. HUMAN 질문 하나에 기존 PEER 실행 하나만 연결하고 자동 continuation은 만들지 않는다. 원래 AI_PAIR cycle과 기기의 PEER wire 형태는 유지한다. 실제 검증 범위와 남은 provider 연동은 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

기기의 `/api/workflow/<action>`은 `ready`, `poll`, `claim`, `start-intent`, `lease`, `question`, `complete`, `interrupt-ack`, `observe`, `admission`, `admission-ack`만 허용한다. 현재 opaque bearer에서 자기 binding scope를 계산하고 각 attempt의 requestId·attemptId·fence·bindingEpoch를 대조한다. 중앙 API가 native session ID·명령·모델 설정을 받지 않는다.

본문은 `protocol:1`의 exact schema이며 실행 mutation에는 operation UUID를 사용한다. read/poll·input-state·admission은 receipt를 만들지 않고, admission-ack는 현재 revision/epoch의 반복 보고를 별도로 처리한다. ready/lease의 재전달은 최초 효과만 반환한다. 새 갱신에는 새 operation이 필요하다. 공개 text는 UTF-8 8 KiB·4,000 codepoint, 전체 body는 16 KiB다. 고정 DTO와 상태별 nullable 필드는 [contracts](../src/features/investigation-coordinator/contracts.ts), 로컬 mirror는 [workflow-contracts](../packages/local-connector/src/workflow-contracts.ts)가 정본이다.

조회는 공개 event의 방별 sequence·cursor와 bounded snapshot을 반환한다. 질문/답변과 terminal 보고는 구분하며, 완료한 origin/continuation/resume의 공유 text도 correlated AGENT SPEECH으로 보관한다. UNKNOWN의 `observe`와 늦은 결과는 종결 사실·과거 기록만 남기고 자동 후속 실행을 만들지 않는다. `ready`와 `RUNNING`은 기기의 보고이며 실제 공급자 readiness·모델 적용의 독립 증거가 아니다.

## 내 AI의 새 답변 제어

`input-state`는 현재 사람의 방별 AI 상태만 반환한다. `input-control`은 현재 cookie 사용자와 `expectedUserId`, 자기 agent·epoch·expectedRevision을 대조하고 같은 operation/body의 저장 결과를 재전달한다. 같은 UUID의 대소문자 표현은 동일한 사용자로 판단하며 receipt 검증에 쓰는 원래 본문은 바꾸지 않는다. 다른 사람의 AI를 지정하거나 이전 계정의 화면으로 제어할 수 없다. 정확한 필드는 위 contracts를 따른다.

`InputState`의 desired revision과 paused는 서버에 저장한 요청이다. `appliedRevision`, `appliedEpoch`, `appliedAt`은 연결 프로그램의 보고이며 세 필드는 함께 null 또는 값이다. 현재 revision/epoch와 다른 적용 보고는 null로 투영한다. 기기는 `admission`으로 자기 agent의 상태를 조회하고 `admission-ack`로 현재 revision·epoch·paused를 확인한다. 오래된 ACK는 `CONFLICT`이며 이전 준비 보고만으로 새 실행을 허용하지 않는다.

허용 경계는 최초 성공 claim의 DB commit이다. 먼저 허용한 답변의 start-intent·lease·도구·종결은 일시정지 뒤에도 계속한다. 방 정지와 본인 재개는 별도 동작이다. 상태 제어는 방 revision·binding epoch·설정 generation·공동 이력을 바꾸지 않는다.

일시정지로 거절한 claim은 기존 workflow receipt에 원래 operation/body로 저장한다. 재개 후 같은 claim을 재전달해도 `INPUT_PAUSED`/409이며 다른 action으로 해당 operation을 재사용하면 `CONFLICT`다. DB 내부의 정확한 denial marker는 [RPC 응답 정책](../src/features/investigation-coordinator/rpc-response-policy.ts)이 고정 HTTP 오류로 변환한다. 응답 유실·timeout·잘못된 marker를 실행되지 않았다는 증거로 삼지 않는다. 실제 설치·HTTP·브라우저 검증은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 사람의 기기 관리

`/api/connections/<action>`은 `approve`, `revoke`, `remove`만 허용한다. 승인에는 일회용 code·organizationId·roomId·공개 범위 확인, 취소/제거에는 자기 deviceId를 받는다. 해당 사람의 현재 권한과 소유 관계를 DB에서 확인한다. observer는 승인할 수 없다. 승인 code만으로 connector credential을 가져갈 수 없다.

## 로컬 connector

`/api/connector/<action>`은 [공개 contracts](../src/features/device-binding/contracts.ts)의 고정 아홉 action만 허용한다. `begin`은 별칭·protocol 1과 서로 다른 code/proof hash, `pairing-status`/`exchange`는 원문 proof bearer, 나머지는 원문 device bearer를 사용한다. 그 bearer는 정확한 64자리 hex이며 Authorization header로 전달한다. 사람 cookie로 이 인증을 대체할 수 없다.

`workspace`/`agent`/`replace`에는 확인한 공개 metadata와 opaque ID/operation/epoch만 받는다. 임의 owner/tenant·root·native session·provider key·RPC·명령·callback URL은 받지 않는다. exchange·rotate·등록·교체 receipt는 동일 operation/payload와 현재 credential·scope·epoch 조건을 만족할 때 제한된 시간 동안 복구한다. 후속 회전·교체·권한 취소 뒤 옛 결과를 재사용하지 않는다.

기존 Codex 등록과 v1 로컬 profile은 유지한다. 설정 migration의 공개 runtime은 `codex` 또는 `claude`이며 `registered/unverified` 표시는 유지한다. owned context·native session·선택 파일의 원문은 로컬 private 계약이다. 모델/effort의 웹 선택은 별도의 runtime-settings 계약으로 전달하며 실행 명령을 받지 않는다. 실제 Claude 수용·Realtime는 후속 범위다. 내구 질문·실행 보고는 별도의 workflow 계약을 사용한다. 제품의 device upstream과 CLI server는 HTTPS 또는 canonical loopback HTTP만 허용하고 redirect를 거절한다. CLI의 private state와 복구 순서는 [온보딩](guides/onboarding-and-settings.md#현재-로컬-기기와-저장소-등록)을 따른다.


## 소유자의 로컬 AI 설정

`/api/runtime-settings/<action>`의 사람 action은 `list`, `select-folder`, `select-runtime`, `apply`, `cancel`이다. PC action은 `poll`, `receipt`다. 사람 요청은 현재 cookie Auth·Origin과 자기 기기 소유권을 확인하며 Authorization header를 거절한다. PC 요청은 현재 기기의 64자리 hex bearer를 사용하고 Cookie header를 거절한다. strict UTF-8·16KiB·정확한 필드 계약을 적용한다. 구현 정본은 [웹 contracts](../src/features/runtime-settings/contracts.ts)와 [PC mirror](../packages/local-connector/src/settings/contracts.ts)다.

`list`는 `deviceId`, `poll`은 기기 bearer로 대상을 고정한다. 두 조회는 선택적인 `operationId`로 같은 기기의 특정 요청을 조회할 수 있다. 일반 조회에서 빠지는 종결 `APPLIED`·PC 정리가 끝난 `CANCELLED`도 정확한 operation 조회로 복구한다. 이 조회는 새 receipt나 변경을 만들지 않으며 다른 기기의 operation을 노출하지 않는다.

설정 요청은 같은 operation UUID로 폴더 선택→PC 확인→모델 선택→적용을 이어간다. `expectedConfigRevision`은 기기 설정 버전, `expectedEpoch`는 교체 대상 AI 연결 버전의 사전 조건이다. 웹이 보낼 수 있는 root는 PC가 발급한 `localRootReference`뿐이다. 절대 경로·명령·provider credential·native session ID는 받지 않는다.

새 폴더의 PC 승인 receipt에는 선택적인 `readMode:"AUTO_CODE"`를 포함한다. 없는 과거 receipt는 선택 파일 모드다. 웹은 본인 receipt의 모드를 apply에 그대로 돌려주고 서버는 승인된 root 참조와 모드의 정확한 일치를 확인한다. 값을 임의로 추가하거나 삭제한 apply는 `CONFLICT`다. 모델 선택의 `select-runtime` 본문에는 이 모드를 넣지 않는다. 로컬 승인 객체·root hash·실제 파일 관찰은 PC에 보관하며 이 설정 계약으로 보내지 않는다. [후속 설정 migration](../supabase/migrations/20261006001200-owner-approved-repository-access.sql)이 기존 요청·권한·확정·복구 계약에 이 선택적 필드를 연결한다.

PC가 확인한 capability는 provider·설치 버전·모델·허용 effort·기본값·`snapshotHash`·실행 정책 검증 상태를 포함한다. 각 모델의 `displayName`은 공급자가 제공한 선택적 공개 표시 이름이다. 최대120바이트의 제한된 ASCII 이름만 수용하며 경로·제어 문자·인증 정보 형식·미지원 필드는 거절한다. `id`·실행 값 `model`·effort·기본값은 유지하고 `snapshotHash` 계산에서 `displayName`만 제외한다. 표시 이름만 바뀌면 기존 설정과 같고, 실행 설정이 바뀌면 다른 목록으로 검증한다. 이름이 없던 목록과 이전 저장 기록은 그대로 수용한다. 선택은 같은 snapshot의 지원 조합이어야 한다. Claude 모델이 effort를 지원하지 않는 경우 `effort:null`을 유지하고 Codex나 effort 지원 모델의 값으로 바꾸지 않는다. 정책 미검증 catalog는 모델과 기본값 없이 `unsupported`로 보고하며 적용을 허용하지 않는다.

표시 이름은 목록·receipt·SQL 응답·HTTP 응답의 기존 상한을 넓히지 않는다. 생산자는 PostgreSQL jsonb의 공백까지 계산한 목록이8,192바이트를 넘으면 표시 이름만 생략하며 실행 가능한 모델·기본값은 자르지 않는다. 카탈로그와 receipt는16,384바이트, SQL 응답은16,200바이트, HTTP envelope는16,384바이트를 유지한다. 응답 안의 receipt catalog와 applied catalog는 기존처럼 null로 투영한다.

응답은 `configRevision`, `catalog`, `operation`, `applied`, `current`, `currentBinding`을 구분한다. `REQUESTED`는 요청 접수, `LOCAL_CONFIRMATION`은 PC의 폴더·범위 확인, `APPLYING`은 서버 예약, `COMMITTED`는 binding과 receipt의 서버 확정, `APPLIED`는 PC의 영속 적용 보고다. `CANCELLED`라도 PC 정리 receipt가 없으면 새 설정을 막는다. `FAILED`·`UNKNOWN`을 새 operation으로 자동 재적용하지 않는다. 같은 단계·operation·본문의 재전달은 현재 인증·소유권·기기 scope 안에서 저장된 결과를 복구하고 다른 본문은 `CONFLICT`다.

적용 예약은 관련 조사·실행·후속 입력·미확정 결과가 닫혔을 때만 가능하다. 예약 중 새 질문·공동 조사 시작과 legacy replace/새 ready를 차단하며 읽기·취소·관찰·기존 결과 업로드는 유지한다. 취소는 서버 확정 전의 허용 상태에만 가능하다. `COMMITTED` 이후에는 같은 receipt로 PC 확정을 복구한다. [SQL 소스](../supabase/migrations/20261005001000-owner-local-ai-setup.sql)가 계약을 정의하며 실제 설치·upgrade·Auth HTTP·브라우저·provider 수용 여부는 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 채팅의 당시 대상과 자료 기록

기존 workflow의 고정 사람·기기 API에 아래 action을 추가한다. 사람은 현재 cookie Auth·방 membership으로 읽고, PC는 현재 device bearer·소유 agent·epoch로 처리한다. observer도 자료를 읽을 수 있다. arbitrary RPC·경로·명령·파일 본문을 받지 않는다. [공개 자료 계약](../src/features/investigation-coordinator/source-contracts.ts)과 [action 본문](../src/features/investigation-coordinator/contracts.ts)이 형식의 정본이다.

| action | 정확한 본문과 동작 |
|---|---|
| 사람 `source-read` | `roomId`, `eventId`, `afterIndex`. 첫 페이지는 `afterIndex:null`, 이후에는 이전 응답의 `nextIndex`를 사용한다 |
| 기기 `source-support` | `agentId`, `bindingEpoch`. 현재 소유 연결에 대한 자료 버전 2 지원을 확인한다 |
| 기기 `source-upload` | `operationId`, `agentId`, `bindingEpoch`, `requestId`, `attemptId`, `fence`, `packetJson`. 고정 실행 주소와 조각의 원래 본문을 저장한다 |
| 기기 `source-confirm` | `agentId`, `bindingEpoch`, `requestId`, `attemptId`, `fence`, `manifestHash`. 전체 확정과 다음 누락 조각을 읽으며 새 입력을 만들지 않는다 |

자료의 `version:2`는 기존 workflow protocol 1과 별개다. 공개 전체 객체는 `kind:"RUN_SOURCE_MANIFEST"`, `readMode`, 원래 입력 관찰 `input`, 도구 관찰 `calls`로 구성한다. 원래 입력은 version 1과 기존 hash를 유지하고 경로·ref만 `pathJson`·`refJson`의 canonical JSON 문자열 token으로 전달한다. 상대 경로·hash·시각·반환 바이트 범위와 별도의 요청 줄만 공개한다. native ID·개인 설정·로컬 승인·절대 경로·파일 원문은 포함하지 않는다.

공개 전체 canonical UTF-8 자료는 최대 4MiB, 조각은 최대 8,192바이트·512개다. 마지막 외 조각은 정확히 8,192바이트이며 base64·전체 hash·조각 hash·index·개수·길이를 대조한다. 실제 외부 요청과 source 응답은 공백을 포함해 16,384바이트 이내여야 한다. 기존 action의 응답 한도는 유지한다. 같은 실행·index의 고정 operation을 재전달하며 다른 내용은 `CONFLICT`다. 조각 ACK는 전체 확정의 증거가 아니므로 마지막에도 같은 hash의 전체 확정을 조회한다.

`source-confirm`의 상태는 `NO_TARGET_SNAPSHOT`, `ABSENT`, `PARTIAL`, `CONFIRMED`다. `nextMissingIndex`로 같은 자료의 전송을 이어간다. 새 완료·관찰 operation은 전체 확정 뒤에 만든다. 전송 실패에는 원래 종결 기록을 남기며 native·Git·파일을 다시 실행하지 않는다. 이미 만든 operation이나 자료 없는 과거 저널에는 뒤늦게 자료를 붙이지 않고 원래 본문으로 복구한다.

`source-read`는 `roomId/eventId`에 고정한 당시 대상과 `NO_TARGET_SNAPSHOT`, `NO_SOURCE`, `CONFIRMED`를 반환한다. 확정 응답의 `manifestHash`·`summary`와 페이지별 파일 관찰은 같은 자료다. 파일은 순서대로 최대 4개이며 16KiB에 맞추면 더 적을 수 있다. `nextIndex`는 마지막 반환 index이며 마지막 페이지는 null이다. 자료 없음이나 조회 실패에서 현재 binding·최신 실행을 과거 대상으로 대신 사용하지 않는다. 공동 AI 질문은 event의 발신 request와 별도로 예약한 수신 대상을 사용한다.

`INPUT`은 입력 전 허용 파일, `REPOSITORY`는 도구가 반환한 발췌, `PEER`는 상대 질문 전에 검증한 근거다. 반복 파일의 서로 다른 발췌를 보존한다. 결과 hash와 question operation ID는 보고된 자료이며 실제 모델 사용·인용·상대 수락·전달 완료·검증 통과를 뜻하지 않는다. 현재 접근 거절과 일시적 조회 오류를 구분하며 과거 자료의 직접 조회 권한은 부여하지 않는다. 실제 설치·HTTP·브라우저 검증은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.
