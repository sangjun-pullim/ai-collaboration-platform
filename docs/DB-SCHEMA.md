---
verified-against: 3e84d8cd2f3754a33154083a23869ca0f5c8cfe8
sources:
  - supabase/migrations/**
  - src/features/room-access/access-service.ts
  - src/features/device-binding/service.ts
  - src/features/investigation-coordinator/service.ts
  - src/features/runtime-settings/service.ts
---
# 입장·AI 채팅방·기기·실행 조정 데이터 모델

검증 기준 커밋의 모델 소스를 설명한다. 이 문서는 모델의 이유와 제약을 설명하며 실제 DDL은 [마이그레이션](../supabase/migrations/20261001000100-web-auth-room-access.sql)이 정본이다. 진행 상태와 검증 수치는 [개발 순서와 검증 계획](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## 모델 경계

| 모델 | 책임과 주요 제약 |
|---|---|
| `public.organizations` | 사람이 소유하는 그룹. Auth 사용자 FK와 별도 `access_version`을 가진다 |
| `public.organization_members` | 그룹별 사용자 한 행. `owner/member`, `active/removed`와 화면 별칭을 보관한다 |
| `public.rooms` | 그룹에 속한 AI 채팅방. 목표·관찰·환경, 소유자와 별도 `access_version`을 가진다 |
| `public.room_members` | 방별 사용자 한 행. `owner/participant/observer`, `active/removed`. 그룹 membership과 방의 복합 FK로 tenant를 일치시킨다 |
| `room_access_private.room_invites` | 초대 SHA-256 hash·역할·발급자·유효 기간·소비 상태와 발급 시 access version. 원문 코드를 저장하지 않는다 |
| `room_access_private.access_audit` | 성공한 권한 변경의 actor·역할·대상·시각. 변경과 동일한 transaction으로 기록한다 |

Auth 계정은 Supabase의 `auth.users`가 소유한다. 제품은 이메일이나 provider credential을 위 여섯 모델에 복제하지 않는다. UUID는 소유권 증거가 아니며, 접근할 때 현재 membership과 Auth 상태를 다시 확인해야 한다.

## 회사 코드 입장

[회사 코드 migration](../supabase/migrations/20261004000900-team-code-entry.sql)은 `team_entry_private`에 configuration·admissions·attempts·global_attempts를 추가한다. 원문 코드를 SHA-256으로 먼저 처리한 뒤 bcrypt verifier만 저장하므로 긴 UTF-8 코드도 bcrypt의 72바이트 절단에 영향을 받지 않는다. private schema의 사용·직접 조회·변경은 anon/authenticated에 허용하지 않는다.

`team_entry_admit`은 실제 `auth.uid()`와 현재 계정의 정지·삭제 상태를 검사하고 입장 코드·표시 이름을 확인한다. 전역→사용자 시도 기록을 같은 transaction에서 잠그며 거절 결과도 카운터와 함께 확정한다. `team_entry_status`는 해당 사용자의 입장 여부만 반환한다. 기존에 확인된 일반 Auth 사용자는 migration 시 한 번 입장을 이관하며 미래 사용자에게 자동 입장을 부여하지 않는다. 기존 Auth ID·membership·기기 소유자를 바꾸지 않는다.

그룹·방 조회와 actor, 기기의 live 권한에 admission 조건을 추가한다. 유효한 Auth session이나 bearer가 있어도 입장이 취소된 사용자는 기존 데이터·기기·workflow 권한을 얻지 못한다. 방의 membership 조건은 계속 별도로 적용한다.

## 조회와 변경

네 public 모델의 authenticated 조회에는 RLS가 적용된다. 그룹에 참가해도 초대되지 않은 방은 읽지 못한다. private 두 모델에는 사용자 직접 SELECT 권한이 없다. 익명 조회와 사용자 직접 INSERT/UPDATE/DELETE를 허용하지 않는다.

변경은 `access_bootstrap`, `access_room`, `access_invite`, `access_join`, `access_revoke_room_member`, `access_revoke_group_member`의 고정 RPC만 사용한다. actor는 본문의 값이 아닌 `auth.uid()`에서 계산한다. `SECURITY DEFINER` 함수는 빈 `search_path`와 schema-qualified 참조를 사용한다. 제품 서버는 publishable key와 현재 사용자 session으로 호출한다.

계정 정지의 직접 조회 경계는 [후속 migration](../supabase/migrations/20261001000200-deny-inactive-auth-reads.sql)과 실제 통합 검사로 보정했다. `auth.users.deleted_at`을 남기는 삭제 방식의 옛 JWT 조회/RPC와 삭제된 발급자의 초대 소비도 실제 실패를 재현한 뒤 [별도 migration](../supabase/migrations/20261001000300-deny-soft-deleted-auth.sql)으로 보정했다. 조회 helper·actor·초대 발급자 모두 현재 계정의 정지·삭제 상태를 확인해야 한다. 실제 hard-delete·ban·soft-delete 및 발급자 회귀는 통과했다. 독립 구현 리뷰 3도 추가 지적 없이 통과했다. 이 완료는 사람 인증·방 접근 범위이며 기기·AI 실행은 별도다.

## 초대와 취소의 원자성

초대는 256-bit 난수의 64자리 hex 원문이며 발급 응답에서 한 번만 전달한다. DB에는 hash만 보관하고 최대 24시간·단일 사용으로 제한한다. 그룹과 방의 접근 version, 발급자의 현재 권한과 Auth 상태를 소비 시 다시 확인한다.

관련 변경은 그룹→방→membership/초대 순서로 잠근다. 초대 소비·membership 반영·감사는 모두 성공하거나 모두 rollback한다. 활성 방 멤버의 재참가는 `ALREADY_MEMBER`이고 원래 역할과 초대를 유지한다. removed 멤버는 취소 이후 발급한 유효한 새 초대로 해당 방에 참가할 수 있다. 다른 방의 removed 상태는 유지한다.

방 제거는 해당 방을, 그룹 제거는 그룹의 모든 방을 취소한다. 이때 접근 version을 올려 옛 초대를 무효화한다. `access_version`은 후속 실행의 `roomRevision`·`bindingEpoch`와 다른 식별자이며 런타임 중단 완료를 뜻하지 않는다.

## 마이그레이션과 보관

현재 모델은 raw SQL이며 Prisma를 도입하지 않았다. 이미 적용한 migration은 덮어쓰지 않고 보정 DDL을 후속 파일로 추가한다. 로컬 검사는 지정한 loopback Docker stack과 합성 사용자·그룹에만 적용한다.

초기 FK에는 삭제 cascade가 있다. 그룹 소유 Auth 계정을 관리 경로에서 삭제하면 해당 그룹·방·초대·감사도 삭제된다. 장기 보관·소유권 이전·제품의 계정 삭제 흐름은 후속 운영 설계에서 다룬다. 현재 UI에는 계정 삭제 기능이 없다.

## 기기와 등록 binding

[기기 migration](../supabase/migrations/20261001000400-device-workspace-binding.sql)은 private schema에 기기·pairing·credential·workspace·agent·operation·secret hash·연결 감사의 여덟 모델을 둔다. 사람이 관리하는 연결 목록과 방의 공개 roster는 고정 RPC projection으로만 제공한다. anon/authenticated의 private schema 사용·테이블 직접 조회/변경은 허용하지 않는다.

기기·credential·binding의 복합 scope는 소유자·조직·방·기기를 일치시킨다. 사람 cookie Auth와 별도의 원문 bearer 인증을 사용하며 DB는 hash만 저장한다. 저장 hash 자체를 public RPC bearer로 제시해도 인증되지 않는다. 절대 root·native locator·공급자 key는 중앙 모델에 저장하지 않는다.

같은 mutation의 제한된 receipt는 현재 credential·scope·epoch가 유효할 때만 복구한다. `operations`는 device별 operation UUID 재사용을 추적해 다른 action/payload의 재사용을 거절한다. 감사는 성공 상태 변경과 같은 transaction에 기록하고 receipt 재전달로 새 감사를 만들지 않는다.

기기 변경과 기존 membership 취소는 공통 advisory guard를 먼저 취득한다. 취소는 대상 사람·방/그룹 scope의 기기와 승인 pairing을 영구 취소하고 재참가로 복구하지 않는다. 다른 참가자의 기기는 유지한다. 최근 heartbeat와 `registered/unverified`는 provider 실행이나 runtime 종결의 증거가 아니다.

[receipt FK 보정](../supabase/migrations/20261001000500-device-cascade-integrity.sql)은 세 credential 참조의 NO ACTION 검사를 transaction 종료까지 연기한다. 기기/조직/Auth 계정 전체 삭제는 기존 cascade로 완료하고, 살아 있는 binding이 참조하는 credential만 독립 삭제하는 동작은 계속 거절한다. 이미 적용한 SQL 네 파일은 수정하지 않았다.

등록 binding을 가진 계정의 hard-delete/ban/soft-delete, 물리적 기기·조직 정리와 정상 소유자 유지를 실제 기기·Auth 통합에서 검사했다. 브라우저 검사와 독립 구현 리뷰도 완료했다. 검증 수치는 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태), 상태 불변식은 [BUSINESS-LOGIC](BUSINESS-LOGIC.md)을 따른다.

## 내구 질문과 실행 조정

[workflow migration](../supabase/migrations/20261001000600-durable-investigation-coordinator.sql)은 private 정본 아홉 테이블과 공개 event/run 두 projection을 추가한다. 소유한 로컬 DB에 적용했고 신규 권한·제약 및 기존 catalog 보존을 확인했다. 실제 통합·브라우저·독립 구현 리뷰와 기존 Auth·기기 회귀를 통과했다. 현재 검증 수치는 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

방 control은 revision·commit 순서의 event counter를, cycle은 평생 실행/왕복 예약과 deadline을 소유한다. generation은 양쪽 epoch·revision·공유 입력의 immutable snapshot이다. request와 attempt는 별도로 저장하고 start intent·lease·fence·UNKNOWN·terminal을 구분한다. question별 peer/continuation 유일 제약은 중복 답변이나 종결 순서 차이에도 자동 후속 요청을 하나로 제한한다.

공개 projection은 현재 live room RLS 아래 authenticated SELECT만 허용한다. private schema와 사용자 직접 DML은 차단하며 고정 definer RPC가 현재 권한을 재검사한다. 공개 text·별칭·correlation·typed 상태만 반환하고 원문 key/hash·경로·native locator·provider event·개인 설명은 포함하지 않는다.

room/org 삭제는 workflow 자식을 cascade한다. 과거 actor/binding 식별자는 Auth/device FK로 묶지 않아 멤버·기기 물리 삭제가 공동 이력을 없애거나 기존 삭제 순서를 뒤집지 않는다. read/소비에서 현재 scope 부재를 재확인해 미시작 요청은 취소하고 시작 의도가 있는 미종결 attempt는 UNKNOWN으로 남긴다. 삭제를 runtime terminal의 증거로 사용하지 않는다. 개인 설명 DB는 후속 범위이며 로컬 실행 저널은 PC의 private state에 저장한다.

## 본인 AI의 새 답변 상태

[새 답변 제어 migration 소스](../supabase/migrations/20261006001100-own-ai-input-pause.sql)는 `own_input_private.states`에 agent별 desired revision·paused와 현재 epoch의 적용 보고를 보관한다. agent·room 삭제는 cascade하고 anon/authenticated의 private 테이블·함수 직접 접근은 허용하지 않는다. 사람은 현재 Auth·membership·agent 소유권으로 제어하고, 연결 프로그램은 현재 bearer·agent·epoch를 확인한다.

제어·기기 ACK·최초 claim과 설정 교체는 기존 scope→방 잠금을 사용한다. 일시정지가 먼저 확정되면 새 claim을 거절하고, 성공 claim이 먼저 확정되면 기존 실행을 유지한다. attempts의 신규 INSERT만 보호하며 기존 lease·종결 UPDATE는 막지 않는다. desired 행은 같은 agent의 epoch 교체 뒤에도 유지하고 과거 적용 보고는 projection에서 숨긴다.

사람 제어의 receipt와 확정 claim 거절은 기존 `workflow_private.receipts`를 사용한다. room·actor kind·actor ID·operation ID의 공통 유일 키와 본문 hash를 유지해 다른 action이나 다른 본문으로 operation을 재사용할 수 없다. claim 거절은 SQL 예외로 rollback하지 않고 marker와 함께 commit한다. 기존 성공 receipt와 DIRECT·adoption 복원은 원래 restore 함수에 위임한다. 방 revision·공동 이벤트·설정 generation은 이 제어의 저장 대상이 아니다. 실제 migration 설치·기존 함수 upgrade·경합 검증은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 사람의 직접 질문

[직접 질문 migration](../supabase/migrations/20261002000700-human-direct-questions.sql)은 기존 cycle에 `mode`를 추가하고 기존 행을 `AI_PAIR`로 유지한다. `DIRECT`는 실제 질문자를 `origin_owner_id`에 저장하고 `origin_agent_id`·`origin_epoch`는 null로 둔다. 대상은 기존 peer 식별자와 epoch로 고정한다. generation은 1, 실행 예약은 1, AI 간 질문 왕복 예약은 0이다.

question의 `source:HUMAN`에는 `requester_user_id`가 있고 origin request·epoch는 null이다. transaction 종료 시 검사하는 graph 제약은 한 DIRECT cycle에 generation·HUMAN question·PEER request가 각각 하나인지 확인한다. 대상·질문자·revision과 질문 본문을 바꾸거나 가짜 origin·continuation을 추가할 수 없다. 직접 질문의 이력과 기존 AI_PAIR의 이력·receipt는 같은 정본 안에서 보존한다.

접수와 결과 채택은 현재 질문자의 참가 권한, 대상 scope·epoch, 방 revision을 확인한다. 현재 유효한 대상의 늦은 결과는 과거 기록으로 남길 수 있지만 새 후속 실행을 만들지 않는다. UNKNOWN과 미종결 실행은 기존 한 방 한 작업 규칙으로 보호한다.

[계정 전환 사전 조건 migration](../supabase/migrations/20261002000800-human-direct-actor-precondition.sql)의 private `human_actor`는 원본 16KiB·정확한 필드·UUID를 검사하고 `expectedUserId`를 현재 `auth.uid()`와 대조한다. 사전 조건을 제거한 본문은 기존 `human`에 위임한다. 기존 `human/validate` 정의와 실제 Auth 기준 receipt·정규화 hash를 보존한다. 두 공개 wrapper의 authenticated 권한은 유지하고 private helper의 직접 실행은 차단한다. `questions(cycle_id)` 일반 B-tree 인덱스는 HUMAN 부분 인덱스와 별도로 모든 모드의 cycle 조회를 지원한다. 기존 데이터·권한·query plan의 검증 범위는 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)를 따른다.


## 소유자의 로컬 AI 설정

[설정 migration 소스](../supabase/migrations/20261005001000-owner-local-ai-setup.sql)는 `runtime_settings_private.configurations`와 `operations`를 정의한다. configurations는 기기별 설정 revision·capability catalog·적용 receipt를, operations는 같은 기기·operation의 단계별 본문·후보·서버 확정·PC 적용 receipt를 보관한다. 직접 조회·변경과 private 함수 실행은 anon/authenticated에 허용하지 않는다. 사람은 고정 human RPC로 자기 기기를, PC는 현재 device bearer로 자기 기기만 처리한다. 경로·native session·선택 파일 원문·provider key는 저장하지 않는다.

[자동 탐색 모드 migration 소스](../supabase/migrations/20261006001200-owner-approved-repository-access.sql)는 기존 receipt·후보·apply의 정확한 본문 검사에 선택적인 `readMode:"AUTO_CODE"`를 연결한다. absent는 기존 선택 파일 모드이며 승인 receipt와 apply·COMMITTED·APPLIED 사이의 모드를 임의로 추가하거나 제거하지 못한다. 새 로컬 승인 객체와 root hash는 중앙 설정 모델에 저장하지 않는다. 기존 기기 소유권·설정 revision·binding epoch·미종결 예약·새 입력 제어는 계속 적용한다. 소스 정의와 실제 설치·upgrade 통과는 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)에서 구분한다.

기기별 유일 제약은 미종결 설정을 하나로 제한하며 `CANCELLED`도 PC 정리 receipt가 없으면 미종결로 취급한다. 현재 권한·credential·scope를 재검사하며 credential 회전을 과거 operation 삭제나 새 설정으로 바꾸지 않는다. 공개 binding의 runtime 제약·projection은 Codex와 Claude를 표현하되 연결 수준·`unverified`와 실제 공급자 실행 검증을 분리한다.

예약은 공통 기기 guard→scope→방 잠금 아래 관련 cycle 전체의 실행·pending adoption·control·미종결 요청을 확인한다. 재개 가능한 `AI_PAIR/HUMAN_INPUT_REQUIRED`는 poll이 비어도 교체를 막는다. 종결 DIRECT도 미해결 증거가 있으면 막으며 모두 닫힌 경우에만 새 설정을 허용한다. 예약 동안 새 workflow 요청과 legacy replace/새 ready를 막아 옛 generation의 실행 대상이 바뀌지 않게 한다.

binding 교체·epoch 증가·설정 revision·`COMMITTED` receipt는 같은 DB transaction으로 확정한다. PC는 이를 확인한 뒤 로컬 generation 기록과 현재 pointer를 영속 저장하고 `APPLIED`를 보고한다. 서버 확정 이후 취소로 되돌리지 않으며 같은 operation으로 복구한다. 설정 migration은 기존 history wrapper와 DIRECT/AI_PAIR 이력의 구분을 보존한다. 실제 DB 설치·upgrade·권한·경합 검증은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)을 따른다.

## 채팅의 당시 대상과 자료 기록

[자료 이력 migration 소스](../supabase/migrations/20261006001300-shared-input-source-history.sql)는 `source_history_private`에 다음 정본을 정의한다. 기존 workflow 이벤트·실행 본문과 설정 모델은 그대로 사용한다.

| 테이블 | 책임과 주요 제약 |
|---|---|
| `targets` | 실행 요청별 예약 당시 대상의 공개 정보. 요청 생성과 같은 transaction에서 고정한다 |
| `manifests` | attempt별 원래 request·agent·epoch·fence와 전체 hash·조각 수·바이트 수·확정 여부·요약. 전체 검증이 끝나야 요약을 저장한다 |
| `packets` | attempt/index별 원문 조각·원래 operation·ACK. 같은 room/device/operation의 다른 본문과 같은 index의 다른 내용을 거절한다 |
| `files` | 확정 자료의 순서를 유지하는 파일 관찰 index와 공개 행. 최대 4,096개이며 같은 파일의 다른 발췌를 합치지 않는다 |
| `events` | 공개 event별 당시 대상과 해당 실행의 확정 자료 연결. 질문은 예약한 수신 대상만 연결하며 나중 자료를 소급 연결하지 않는다 |

전체 자료는 원래 입력 관찰과 typed 도구 기록의 공개 투영이다. 서버는 조각을 모두 모아 전체 UTF-8·canonical hash·원래 입력 hash·JSON token·파일 범위·상한을 검사한 뒤 요약과 파일 index를 같은 transaction에서 확정한다. 부분 전송은 화면에 공개하지 않는다. 경로와 ref는 JSON 문자열 token으로 저장해 원래 JavaScript UTF-16 범위·순서·hash를 유지한다. 파일 본문·로컬 root·승인 객체·설정·native 식별자는 저장하지 않는다.

자료 쓰기는 현재 device bearer·소유 agent·epoch와 해당 attempt/fence를 확인한다. 사람 조회는 현재 회사 입장·Auth·그룹·방 membership을 다시 확인하며 observer의 읽기를 허용한다. public/anon/authenticated/service-role의 private schema·테이블·함수 직접 접근은 차단하고 고정 RPC만 노출한다. Auth·device·workspace의 물리 삭제로 과거 대상을 지우는 FK를 추가하지 않는다. 과거 요청에 snapshot이 없으면 현재 정보를 채우지 않는다.

조회 주소는 `roomId/eventId`이며 다음 페이지에도 같은 대상·자료 hash·요약을 사용한다. 응답은 파일 관찰 최대 4개와 실제 외부 JSON 16KiB 안에서 구성한다. 기존 화면의 run 요약 개수와 독립적이다. 소스 정의와 실제 설치·warm upgrade·권한·동시성·브라우저 통과는 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)에서 구분한다.
