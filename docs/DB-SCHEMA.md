---
verified-against: null
sources:
  - supabase/migrations/**
  - src/features/room-access/access-service.ts
  - src/features/device-binding/service.ts
  - src/features/investigation-coordinator/service.ts
---
# 인증·조사방·기기·실행 조정 데이터 모델

2026-10-01의 구현 소스를 확인했다. Git 기준 commit이 없어 freshness stamp를 검증할 수 없으며 `verified-against`를 비워 둔다. 격리된 실제 Auth·DB·HTTP 통합 14개와 Auth browser 4개가 통과했으며 독립 구현 리뷰 3도 추가 지적 없이 통과했다. 이 문서는 모델의 이유와 제약을 설명하며, 실제 DDL은 [마이그레이션](../supabase/migrations/20261001000100-web-auth-room-access.sql)이 정본이다.

## 모델 경계

| 모델 | 책임과 주요 제약 |
|---|---|
| `public.organizations` | 사람이 소유하는 그룹. Auth 사용자 FK와 별도 `access_version`을 가진다 |
| `public.organization_members` | 그룹별 사용자 한 행. `owner/member`, `active/removed`와 화면 별칭을 보관한다 |
| `public.rooms` | 그룹에 속한 범용 조사방. 목표·관찰·환경, 소유자와 별도 `access_version`을 가진다 |
| `public.room_members` | 방별 사용자 한 행. `owner/participant/observer`, `active/removed`. 그룹 membership과 방의 복합 FK로 tenant를 일치시킨다 |
| `room_access_private.room_invites` | 초대 SHA-256 hash·역할·발급자·유효 기간·소비 상태와 발급 시 access version. 원문 코드를 저장하지 않는다 |
| `room_access_private.access_audit` | 성공한 권한 변경의 actor·역할·대상·시각. 변경과 동일한 transaction으로 기록한다 |

Auth 계정은 Supabase의 `auth.users`가 소유한다. 제품은 이메일이나 provider credential을 위 여섯 모델에 복제하지 않는다. UUID는 소유권 증거가 아니며, 접근할 때 현재 membership과 Auth 상태를 다시 확인해야 한다.

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

실제 기기 DB·HTTP·CLI 통합 12개와 기존 Auth 통합 14개가 통과했다. 등록 binding을 가진 계정의 hard-delete/ban/soft-delete, 물리적 기기·조직 정리와 정상 소유자 유지도 검사했다. Auth browser 4개·기기 browser 4개도 통과했으며 독립 구현 재리뷰 2도 통과했다. 상태 불변식은 [BUSINESS-LOGIC](BUSINESS-LOGIC.md), 다음 순서는 [로드맵](delivery-and-validation.md#단계별-명세-범위)을 따른다.

## 내구 질문과 실행 조정

[workflow migration](../supabase/migrations/20261001000600-durable-investigation-coordinator.sql)은 private 정본 아홉 테이블과 공개 event/run 두 projection을 추가한다. 소유한 로컬 DB에 적용했고 신규 권한·제약 및 기존 catalog 보존을 확인했다. 실제 통합 18개·workflow browser 4건을 통과했으며 독립 구현 리뷰 round1도 미해결 CRITICAL/HIGH 없이 통과했다. 기존 Auth 14개·기기 12개와 각 browser 4건의 재검사도 통과했다.

방 control은 revision·commit 순서의 event counter를, cycle은 평생 실행/왕복 예약과 deadline을 소유한다. generation은 양쪽 epoch·revision·공유 입력의 immutable snapshot이다. request와 attempt는 별도로 저장하고 start intent·lease·fence·UNKNOWN·terminal을 구분한다. question별 peer/continuation 유일 제약은 중복 답변이나 종결 순서 차이에도 자동 후속 요청을 하나로 제한한다.

공개 projection은 현재 live room RLS 아래 authenticated SELECT만 허용한다. private schema와 사용자 직접 DML은 차단하며 고정 definer RPC가 현재 권한을 재검사한다. 공개 text·별칭·correlation·typed 상태만 반환하고 원문 key/hash·경로·native locator·provider event·개인 설명은 포함하지 않는다.

room/org 삭제는 workflow 자식을 cascade한다. 과거 actor/binding 식별자는 Auth/device FK로 묶지 않아 멤버·기기 물리 삭제가 공동 이력을 없애거나 기존 삭제 순서를 뒤집지 않는다. read/소비에서 현재 scope 부재를 재확인해 미시작 요청은 취소하고 시작 의도가 있는 미종결 attempt는 UNKNOWN으로 남긴다. 삭제를 runtime terminal의 증거로 사용하지 않는다. 개인 설명 DB·실제 로컬 실행 저널은 후속 범위다.
