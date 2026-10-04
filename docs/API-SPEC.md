---
verified-against: 1eac6aee424d6acdc4ba89afac4e3683db04828d
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
---
# 사람 인증·조사방·기기·실행 조정 계약

2026-10-02의 Git 기준 소스와 작업트리를 확인했다. 이 문서는 현재 사람 cookie Auth·기기 bearer·내구 조사 계약을 설명한다. 실행 보고와 실제 provider 종결의 검증은 구분한다. 진행 상태와 검증 수치는 [개발 순서와 검증 계획](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## 공통 요청과 응답

모든 mutation은 POST·`application/json`·실제 수신 크기 최대 16 KiB·unknown-field 거절을 적용한다. 사람 action은 `Origin`이 `APP_ORIGIN`과 정확히 일치해야 하며 cookie로 현재 사용자를 확인한다. connector action은 별도의 bearer로 인증하고 cookie를 신원으로 사용하거나 갱신하지 않는다. actor·owner·RPC 이름·외부 redirect를 본문으로 선택할 수 없다. 계약의 세부 validator가 정본이다.

성공은 `{"ok":true,"data":{...}}`, 실패는 `{"ok":false,"error":{"code":"..."}}`이며 예외 원문이나 SQL 오류를 반환하지 않는다. 응답은 `private, no-store`다. 사람 응답은 Cookie/Origin, connector 성공은 Authorization을 Vary에 포함하며 framework 토큰이 함께 올 수 있다. connector는 Cookie Vary·Set-Cookie를 사용하지 않는다.

인증 session은 서버가 관리하는 HttpOnly·SameSite=Lax cookie로 전달하고 HTTPS에서는 Secure를 적용한다. 브라우저 JSON에 session 원문을 반환하지 않는다. 보호 화면의 미인증 redirect는 고정 `/login`으로 해석되어야 한다.

## Auth action

| 경로 | body | 성공 data |
|---|---|---|
| `/api/auth/code` | `email` | `{}`. 메일의 6자리 코드를 요청한다. 첫 가입을 허용한다 |
| `/api/auth/verify` | `email`, `code` | `{}`. 실제 OTP를 검증하고 session cookie를 설정한다 |
| `/api/auth/logout` | `{}` | `{}`. 현재 Auth session을 signOut하고 모든 cookie chunk를 지운다 |

로그아웃의 cookie 삭제가 같은 요청의 갱신보다 우선한다. 이후 웹 보호 요청과 refresh 재사용은 거절되어야 한다. 이미 발급된 모든 access JWT의 즉시 폐기를 보장하지 않는다. 그룹·방 권한 취소와 Auth 계정 정지는 별도로 검사한다.

## Access action

`/api/access/<action>`은 아래 여섯 action만 허용한다. 모든 요청에서 현재 Auth 사용자와 live DB 권한을 확인한다.

| action | body | 성공 data·권한 |
|---|---|---|
| `bootstrap` | `groupName`, `title`, `goal`, `observation`, `environment`, `displayAlias` | `organizationId`, `roomId`. 로그인한 사람이 자기 그룹과 첫 방을 만든다 |
| `room` | `organizationId`, `title`, `goal`, `observation`, `environment` | `roomId`. 해당 그룹 owner만 방을 추가한다 |
| `invite` | `roomId`, `role` (`participant/observer`) | `code`, `expiresAt`. 현재 방 owner만 발급한다 |
| `join` | `code`, `displayAlias` | `roomId`. 유효한 초대를 원자적으로 소비한다 |
| `revoke-room-member` | `roomId`, `userId` | `removed`. 방 owner가 owner 이외의 멤버를 제거한다 |
| `revoke-group-member` | `organizationId`, `userId` | `removed`. 그룹 owner가 owner 이외의 그룹 멤버를 제거한다 |

초대 원문은 발급 응답과 발급자의 일시적인 화면 상태에만 존재한다. URL·로그·다른 사용자의 HTML에 넣지 않는다. 활성 room membership으로 재참가하면 초대 미소비·기존 role 보존과 함께 `ALREADY_MEMBER`를 반환한다. 재초대와 취소의 저장 규칙은 [DB-SCHEMA](DB-SCHEMA.md)를 따른다.

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

사람의 `/api/investigations/<action>`은 `read`, `speak`, `start`, `interrupt`, `pause`, `resume`, `ask`, `cancel`만 허용한다. 현재 cookie 사용자·방 역할로 권한을 계산한다. 공동 발언은 실행을 만들지 않는다. `start`는 자기 origin과 다른 참가자의 peer binding·현재 epoch/revision·준비 보고·공유 확인을 요구한다. `resume`의 room mode는 intake만 재개하고 cycle mode는 원래 origin 소유자의 명시적 새 generation을 만든다. observer는 읽기만 가능하다.

`ask`는 질문자 AI·기기·경로 없이 다른 소유자의 준비된 대상 하나에 질문한다. 본문은 `protocol:1`, `roomId`, `operationId`, `expectedUserId`, `targetAgentId`, `targetEpoch`, `expectedRoomRevision`, `publicText`, `confirmed:true`다. `cancel`의 본문은 `protocol:1`, `roomId`, `operationId`, `expectedUserId`, `requestId`, `expectedRoomRevision`이며 질문자나 대상 소유자가 해당 직접 질문 하나만 취소·중단할 수 있다. UUID `expectedUserId`는 화면을 연 뒤 로그인 주체가 바뀌지 않았다는 사전 조건이다. 서버는 현재 Auth가 없으면 `UNAUTHENTICATED`, 식별자가 다르면 `FORBIDDEN`을 반환한다. 이 필드로 다른 사용자의 권한을 얻을 수 없다. 원본 본문의 크기·필드를 검사한 뒤 사전 조건을 제거하고 실제 Auth를 기준으로 기존 권한·receipt를 처리한다. 동일 사람·operation·정규화 본문의 재전달은 저장된 결과를 반환한다.

직접 질문의 cycle은 `mode:DIRECT`, `targetAgentId`, `targetEpoch`, `generation:1`, `runsReserved:1`, `peerRoundsReserved:0`, `canInterrupt`를 반환한다. HUMAN 질문 하나에 기존 PEER 실행 하나만 연결하고 자동 continuation은 만들지 않는다. 원래 AI_PAIR cycle과 기기의 PEER wire 형태는 유지한다. 실제 검증 범위와 남은 provider 연동은 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

기기의 `/api/workflow/<action>`은 `ready`, `poll`, `claim`, `start-intent`, `lease`, `question`, `complete`, `interrupt-ack`, `observe`만 허용한다. 현재 opaque bearer에서 자기 binding scope를 계산하고 각 attempt의 requestId·attemptId·fence·bindingEpoch를 대조한다. 중앙 API가 native session ID·명령·모델 설정을 받지 않는다.

본문은 `protocol:1`의 exact schema이며 mutation에는 operation UUID를 사용한다. read/poll은 receipt를 만들지 않고, ready/lease의 재전달은 최초 효과만 반환한다. 새 갱신에는 새 operation이 필요하다. 공개 text는 UTF-8 8 KiB·4,000 codepoint, 전체 body는 16 KiB다. 고정 DTO와 상태별 nullable 필드는 [contracts](../src/features/investigation-coordinator/contracts.ts), 로컬 mirror는 [workflow-contracts](../packages/local-connector/src/workflow-contracts.ts)가 정본이다.

조회는 공개 event의 방별 sequence·cursor와 bounded snapshot을 반환한다. 질문/답변과 terminal 보고는 구분하며, 완료한 origin/continuation/resume의 공유 text도 correlated AGENT SPEECH으로 보관한다. UNKNOWN의 `observe`와 늦은 결과는 종결 사실·과거 기록만 남기고 자동 후속 실행을 만들지 않는다. `ready`와 `RUNNING`은 기기의 보고이며 실제 공급자 readiness·모델 적용의 독립 증거가 아니다.

## 사람의 기기 관리

`/api/connections/<action>`은 `approve`, `revoke`, `remove`만 허용한다. 승인에는 일회용 code·organizationId·roomId·공개 범위 확인, 취소/제거에는 자기 deviceId를 받는다. 해당 사람의 현재 권한과 소유 관계를 DB에서 확인한다. observer는 승인할 수 없다. 승인 code만으로 connector credential을 가져갈 수 없다.

## 로컬 connector

`/api/connector/<action>`은 [공개 contracts](../src/features/device-binding/contracts.ts)의 고정 아홉 action만 허용한다. `begin`은 별칭·protocol 1과 서로 다른 code/proof hash, `pairing-status`/`exchange`는 원문 proof bearer, 나머지는 원문 device bearer를 사용한다. 그 bearer는 정확한 64자리 hex이며 Authorization header로 전달한다. 사람 cookie로 이 인증을 대체할 수 없다.

`workspace`/`agent`/`replace`에는 확인한 공개 metadata와 opaque ID/operation/epoch만 받는다. 임의 owner/tenant·root·native session·provider key·RPC·명령·callback URL은 받지 않는다. exchange·rotate·등록·교체 receipt는 동일 operation/payload와 현재 credential·scope·epoch 조건을 만족할 때 제한된 시간 동안 복구한다. 후속 회전·교체·권한 취소 뒤 옛 결과를 재사용하지 않는다.

현재 공개 binding은 `codex`, `registered`, `unverified`로 표시한다. 007의 모델/effort·owned context는 로컬 private 계약이며 기존 서버 DTO에 원시 설정이나 실행 명령을 추가하지 않는다. 웹의 설정 계약·Claude·Realtime는 후속 범위다. 내구 질문·실행 보고는 별도의 workflow 계약을 사용한다. 제품의 device upstream과 CLI server는 HTTPS 또는 canonical loopback HTTP만 허용하고 redirect를 거절한다. CLI의 private state와 복구 순서는 [온보딩](guides/onboarding-and-settings.md#현재-로컬-기기와-저장소-등록)을 따른다.
