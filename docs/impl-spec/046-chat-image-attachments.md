---
status: active
date: 2026-10-19
risk-surface: permission, db-schema, public-api
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 채팅 이미지 첨부와 무료 저장 한도 관리

## Context

사람이 채팅방에 이미지를 첨부하고 지정한 Claude/Codex AI(본인 AI 포함)에 질문한다. 질문자는 AI 연결이 필요 없다. 사용자는 기존 Supabase 무료 한도 내 구현과 저장 공간 약75%에서 오래된 이미지 정리를 요청했다. S3·유료 플랜·별도 모델 API 결제는 도입하지 않는다. 현재 구현에는 이미지 저장 경로가 없으며, AI 입력과 입력 수신 증명은 텍스트만 허용한다. 기존 개인 로그인·읽기 전용 저장소 정책을 유지한다.

## Product Decisions

- 초기 범위: 일반 메시지와 사람이 지정한 AI에 보내는 직접 질문에 이미지1장. 파일 선택·붙여넣기·드롭, 전송 전 미리보기·제거, 이력의 작은 미리보기·확대 보기. 공동 조사와 AI 간 자동 질문에는 이미지를 자동 전달하지 않는다.
- PNG/JPEG/WebP만 받는다. SVG/GIF/HEIC·애니메이션·잘못된 파일은 안내 후 거절한다. 브라우저에서 최대 긴 변2048px, 압축 후512KiB로 준비한다. 서버에서도 디코딩·픽셀 수(최대4,194,304)·바이트·MIME를 확인하고 메타데이터를 제거해 다시 인코딩한다. 서버가 확정한 바이트/hash가 유일한 첨부 내용이다. 파일명·EXIF·절대경로는 공유하지 않는다.
- 저장소는 기존 Supabase의 전용 private bucket `chat-images`. 공개 URL을 만들지 않는다. 표시·다운로드는 현재 방 참가자, AI 수신은 현재 실행을 할당받은 기기에만 허용한다.
- 기본 저장 예산1,000,000,000바이트에서 **예약 포함750,000,000바이트를 넘을 업로드는 먼저 정리**, 정리 모드는600,000,000바이트 이하까지 지속한다. 다른 프로젝트·bucket 사용량을 운영 확인해 이 앱 예산을 더 낮출 수 있다. 앱 한도가 조직 전체 무료 한도를 보장한다고 표현하지 않는다.
- 전송 완료 후24시간이 지난 첨부 중 오래된 순서로 삭제한다. 아직 게시하지 않은 업로드는1시간 후 정리 대상이다. 실행/대기/종료 미확인 AI 질문에 연결된 첨부, 유효한 로컬 다운로드 임대는 보호한다. 삭제 가능한 것이 없으면 새 업로드를 차단하고 이유를 표시한다. 보호를 해제하기 위해 UNKNOWN을 성공/중단으로 바꾸지 않는다.
- 삭제된 메시지에는 `보관 기간 만료로 이미지가 정리되었습니다`를 표시한다. 메시지·답변·해시·삭제 시각은 남긴다. 삭제는 클라우드 원본에만 적용되며 이미 내려받은 파일이나 공급자 대화 이력의 이미지까지 지운다고 약속하지 않는다.
- 이미지 다운로드 월별 예산은 우선2,000,000,000바이트로 제한하고 모든 실제 공급 시도 전에 서버에서 원자적으로 예약한다. 캐시 미스·재시도·실패도 보수적으로 사용량에 포함한다. 공간 정리로 전송량 한도가 초기화되지 않는다. 무료 한도 전체에는 DB/API 등 다른 사용량도 포함된다. 초과 시 추가 이미지 전송을 막고 일반 텍스트 채팅은 유지한다.

## Affected Files

1. `src/features/chat-attachments/{contracts,server,storage,quota,cleanup,client,controller}.ts` (신규) — 첨부 식별·권한 확인·바이트 공급·정리 경계.
2. `src/app/api/chat-attachments/[action]/route.ts`, `src/app/api/chat-attachments/content/[id]/route.ts`, `src/app/api/internal/chat-attachments-cleanup/route.ts` (신규) — 사용자/기기별 명시적 입구, 바이너리 입출력, 인증된 정리.
3. `supabase/migrations/20261019002500-chat-image-attachments.sql` (신규) — private bucket, 전용 첨부·예약·전송량·capability 테이블과 권한 RPC, 기존 메시지/질문 트랜잭션 확장.
4. `src/features/investigation-coordinator/{contracts,direct-intents,chat-outbox,room-chat-controller}.ts` 및 `packages/local-connector/src/workflow-contracts.ts` — 선택적 attachmentId, 정확한 재전송 비교, 지원 기기만 이미지 요청 할당.
5. `src/features/investigation-coordinator/{chat-composer,chat-timeline,investigation-view}.tsx`, 신규 `src/features/chat-attachments/{attachment-picker,attachment-preview}.tsx` — 좁은 입력창 유지, 이미지 표시·접근 가능한 확대·만료 상태.
6. `packages/local-connector/src/{workflow-runner,workflow-client,runtime-contracts,codex-adapter}.ts`, 신규 `packages/local-connector/src/workflow/attachment-input.ts` — 실행에 귀속된 첨부 다운로드·검증·비공개 임시 파일·입력 전달.
7. `packages/local-connector/src/claude/{adapter,input-proof,history-proof,native-history-proof,native-history-records}.ts`, `packages/local-connector/src/runtime/{record-schema,record-transitions,record-validation}.ts` — 이미지 포함 입력 식별과 복구, 텍스트 이전 기록 호환.
8. `package.json`, `package-lock.json`, `vercel.json` — 이미지 디코더(sharp를 직접 고정 의존성으로 선언), 무료 플랜 범위의 하루1회 정리 cron. 업로드 시에도 제한된 정리 수행.
9. 관련 unit/integration/e2e tests와 fixtures; `docs/{API-SPEC,DB-SCHEMA,ARCHITECTURE,FRONTEND-ARCHITECTURE,BUSINESS-LOGIC}.md`, `docs/guides/{constraints-and-security,cloud-deployment}.md`, `docs/planning/delivery-and-validation.md` — 실제 구현 완료 단계에 맞춰 해당 절만 갱신.

## Affected Dependents

- `history-state.ts`는 같은 eventId의 내용 변경을 거절한다. PublicEvent에 만료 상태·URL을 섞지 않고 별도 첨부 API에서 조회한다. 오래된 클라이언트의 텍스트 이력 응답은 그대로 유지한다.
- `chat-history-cache.ts`, `use-virtual-history.ts`는 메시지 높이·재입장 성능을 담당한다. 이미지 width/height를 먼저 예약하고 로드 후 측정하며 화면에 가까운 첨부만 읽는다.
- `chat-outbox.ts`의 사용자/방별1건·주간 만료·정확한 operationId 비교와 `direct-intents.ts`의 직접 질문 미확정 보존에 attachmentId를 포함한다. 이미지 바이트·다운로드 URL은 localStorage/이벤트 JSON에 넣지 않는다.
- `src/lib/supabase/server.ts:7`은 publishable/anon만 허용한다. 이 제한은 유지하고 신규 서버 전용 Storage 모듈만 별도 secret을 사용한다. 일반 요청 클라이언트나 브라우저에 관리 키를 전달하지 않는다.
- `src/features/investigation-coordinator/request-policy.ts`의 JSON 제한은 유지한다. 업로드만 별도 바이트 제한 스트림으로 받으며 전역 요청 제한을 늘리지 않는다.
- `packages/local-connector/src/claude/transport.ts:66`의1MiB 프레임과 `adapter.ts:512`의16MiB 전체 프레임 제한을 유지한다.512KiB 이미지는 base64 약699KiB이며 텍스트·필드 포함 상한을 실제 바이트로 검사한다.
- 입력 ACK·재시작 복구·native history는 단일 텍스트 hash를 검증한다. 이미지 전송만 추가하면 UNKNOWN으로 바뀌므로 입력 증명을 함께 변경한다. 기존 텍스트 기록 hash는 그대로 둔다.
- **서버 키 규칙 사본3개**: `docs/guides/cloud-deployment.md:18`, `:64`는 관리자/secret/service-role 키를 웹 환경에 추가하지 않는다고 명시하고, `docs/DB-SCHEMA.md:45`는 제품 서버가 publishable key와 사용자 session으로만 호출한다고 기술한다. 문서상 소유자는 명시되지 않았으며 수정 범위는 이 저장소다. 이번 계획은 Storage 전용 서버 secret이라는 명시적 예외를 제안한다. 승인 전에는 키를 추가하지 않는다. 일반 브라우저/기기 배포 금지인 `docs/guides/constraints-and-security.md:74`는 유지한다.
- 메시지·직접 질문 계약 사본은 `API-SPEC.md:91,93`, 요청 크기 제한 사본은 `API-SPEC.md:29`, `ARCHITECTURE.md:161`, `FRONTEND-ARCHITECTURE.md:102`에서 확인했다. 이미지 별도 입구만 문서화하고 기존 JSON 제한은 유지한다. 첨부 정리 규칙과 이미지 capability의 기존 정본은 없다. `FRONTEND-ARCHITECTURE.md:116`의 외부 Markdown 이미지 차단은 유지한다. 이 사본들의 문서상 소유자는 명시되지 않았다.
- `workflow-runner.ts:1507` queuedRequest/claim.payload 동등성, `:156` matchAttempt의 start-intent/lease/poll 동등성을 유지해야 한다. 이미지 descriptor는 모든 snapshot에 동일하게 나타나며 claim에서만 추가하지 않는다. 구버전이 이미지 요청을 실행하지 못하는 capability/명시claim 검사와 함께 배포한다.
- 탐색 범위는 이 저장소 src/packages/supabase/tests/docs이다. 외부 프로젝트는 변경하지 않으며 집계는 위 바뀌는 규칙에 대한 발견 사본이다.

## Implementation Steps

### [x] Step 1: 입력 계약과 공급자 호환성 확인
**File**: `packages/local-connector/src/claude/input-proof.ts`, `codex-adapter.ts`, 관련 테스트
- 텍스트+이미지1개의 명세를 고정한다. descriptor는 attachmentId/MIME/bytes/width/height/sha256만 포함한다. URL·원본 파일명은 실행 계약에 넣지 않는다.
- Claude는 공식 streaming input의 text/image base64 content blocks, Codex는 App Server의 localImage를 사용한다. 현재 검증된 CLI 버전의 실제 지원·이미지 입력 ACK·native 이력 형태를 조사한다. 새 SDK로 실행기를 교체하지 않는다.
- 공급자 입력 전 텍스트와 서버 확정 이미지 hash의 순서 있는 manifest를 durable journal에 저장한다. 텍스트만이면 기존 promptHash 의미를 유지하고, 이미지 입력에는 versioned content hash를 추가한다. 이미지 누락·변조·다른 MIME는 같은 질문으로 인정하지 않는다.
- 합성 이미지의 고유 문구를 읽는 실제 검증을 Claude1회/Codex1회(총 새 입력 최대2회)로 계획한다. **이 계획 승인 시 해당 추가 입력 상한 승인도 함께 명시적으로 받는다.** 개인 저장소·기존 대화는 사용하지 않는다. 실패/미확정 시 추가 호출 없이 증거를 보존하고 해당 공급자 이미지 기능을 활성화하지 않는다.

### [x] Step 2: 저장·권한·용량 원장
**File**: 신규 migration와 chat-attachments 서버 모듈
- 업로드 원장은 `RESERVED → READY → ATTACHED → DELETING → DELETED`, 실패는 재조정 가능한 상태로 남긴다. bucket/object key는 서버 생성 ID로 고정하고 overwrite/upsert를 금지한다. 이미지 준비 이후 내용 변경은 새ID로만 가능하다.
- 사용자 업로드·게시·조회는 기존 세션과 현재 방 소속을 SQL에서 확인한다. server-only Storage 권한은 명시적인 bucket 상수에만 쓰며 임의 path/URL 입력을 허용하지 않는다. 테이블·Storage의 anonymous/authenticated 직접 접근을 차단한다. 관리 키 사용 전 사용자 또는 기기 검증 RPC가 통과해야 한다.
- 업로드 크기를 예약하는 트랜잭션에서 전역 budget행을 잠가 동시 업로드 합계가 한도를 넘지 않게 한다. 원본+재인코딩본 동시 저장 없이 서버 확정 이미지 하나만 저장한다. 저장 성공 후 DB finalize가 실패하면 예약을 유지하고 reconciliation으로 동일 object를 확인한다. 단순 예약 만료만으로 quota를 먼저 돌려주지 않는다.
- 다운로드는 사용자에게는 현재 메시지 방 소속, 기기에는 현재 device secret·agent/bindingEpoch·request/attempt/fence·기한·할당을 확인한다. origin/cookie와 bearer 입구를 분리한다. 임의 다른 요청/방 첨부는 거절한다. 서버가 바이트와 hash를 반환하고 외부 URL로 리다이렉트하지 않는다.
- 이미지 전송 예산은 Storage fetch 전 예약하고 full bytes로 보수적 계산한다. Range는 지원하지 않는다. 파일은 서버 메모리와 로컬 캐시에서 크기 상한을 지킨다. Cache-Control은 private이며 접근 거절 시 메모리/blob URL을 폐기한다. 공개 CDN 캐시는 사용하지 않는다.

### [x] Step 3: 자동 정리와 삭제 경쟁 방지
**File**: `cleanup.ts`, migration, internal cleanup route, `vercel.json`
- 신규 이미지 전용 bucket에만 oldest-first 정리를 적용한다. 다른 bucket이나 DB 텍스트 기록은 삭제하지 않는다. quota행 잠금으로 정리 임대·대상을 원자적으로 획득하고 영구 object key를 고정한다.
- 삭제 결정과 게시/AI 실행 시작은 동일 첨부행 잠금으로 직렬화한다. DELETING은 신규 게시·claim·다운로드를 거절한다. 실행 중/대기/UNKNOWN 요청과 유효한 다운로드 임대가 있으면 후보에서 제외한다.
- `Storage.remove` 성공 또는 object없음 확인 후 DB tombstone과 quota 감소를 기록한다. DB행만 삭제해 실제 Storage가 남는 동작을 금지한다. Storage 실패·응답 유실·프로세스 중단 시 DELETING/예약을 유지하고 같은 object만 재확인한다. 업로드 중 실패한 object도 동일 방식으로 정리한다.
- 하루1회 인증된 cron과 업로드 임계 도달 시 bounded batch(최대32객체/회·10초)로 실행한다. cron secret은 서버에서만 비교한다. 예약을 못 받으면 업로드는 보류 안내하며 무제한 대기/자동 유료 전환하지 않는다.24시간 보호로 제거할 대상이 없으면 명확한 용량 한도 오류를 반환한다.
- 첨부 상태 변경은 기존 room-private Realtime의 내용 없는 changed hint와 controller 재조회에 연결한다. 만료는 별도 첨부 revision으로 갱신하고 event sequence/immutable history를 변경하지 않는다.

### [x] Step 4: 메시지·직접 질문·구버전 호환
**File**: workflow contracts, migration, direct-intents, outbox, workflow-client/runner
- speak/직접 질문에 선택적인 attachmentId를 추가한다. 첨부 소유자·방·READY·만료를 검증하고 메시지 event/request와 첨부 고정을 **같은 DB 트랜잭션**에서 수행한다. operationId 재시도는 텍스트뿐 아니라 동일 attachmentId를 요구한다. HTTP 응답 유실 시 새 질문/새 첨부로 바꿔 재전송하지 않는다.
- 공개 이벤트 형태는 그대로 유지한다. 별도 API는 현재 페이지 eventId 목록(최대32개)에 대한 영구 descriptor와 가변 표시 상태를 조회한다. 서버가 방 소속과 event 관계를 검증한다. 이미지 내용·signed URL은 Broadcast와 공개 로그에 넣지 않는다.
- 신규 연결기는 binding epoch에 귀속된 `imageInputVersion=1` 지원을 별도 인증 API로 보고한다. 준비 TTL과 함께 만료한다. 질문 대상에는 지원 여부를 표시한다. 이미지 직접 질문 제출과 claim 모두 현재 버전 지원을 확인한다. **claim 호출 자체에도 명시적인 imageInputVersion이 있어야 이미지 요청을 할당**하여 구버전 프로세스가 서버의 오래된 지원 보고를 믿고 텍스트만 실행하는 경우를 막는다.
- poll도 같은 명시적 imageInputVersion으로 지원을 협상한다. 버전이 없는 poll에는 이미지 queuedRequest를 내보내지 않는다. 이미지 attempt의 start-intent/lease/recovery는 최초 claim의 버전에 귀속하며 payload를 줄이거나 변경해 구버전에 전달하지 않는다. 지원 버전을 잃으면 대기/재연결 안내로 남기며 이미지를 버린 텍스트 실행으로 대체하지 않는다.
- 텍스트만 있는 요청의 payload·기존 journal은 유지한다. 이미지 request payload에만 immutable descriptor를 포함한다. 양쪽 계약 복사본과 SQL exact-key 검증을 함께 갱신한다. 구버전 연결기에 이미지를 무시하고 텍스트만 보내지 않는다.
- 일반 메시지는 업로드 완료 descriptor를 IndexedDB outbox의 같은 operationId에 저장해 창 종료 뒤 같은 요청을 확인한다. draft 원본은 저장하지 않으며 업로드 전 종료 시 다시 선택하도록 알린다. 직접 질문은 기존 명시적 재확인 규칙을 유지한다. 이미지 만료 뒤 미전송 메시지는 사용자에게 재첨부를 요구한다.

### [x] Step 5: 로컬 AI 이미지 실행·이력 증명
**File**: attachment-input, provider adapters, runtime journal, Claude input/history proof
- 현재 할당의 descriptor를 서버에서 받고 bytes/hash/MIME를 검증한 후에만 공급자 입력 단계로 간다. 기존 Claude 전용 preinput rejection 증거는 유지한다. 별도로 연결기가 소유하는 `attachment-preinput-rejection` 증거를 정의해 Claude와 Codex 모두에 적용한다. request/attempt/fence·입력 manifest/hash·실패 단계와 공급자 호출 전 상태를 내구성 저널에 기록한다. 다운로드 실패·내용 불일치·이미지 이력 용량 부족을 구분해 표시하며 이미지를 생략한 실행은 하지 않는다.
- 첨부 준비가 끝나고 저널에 공급자 호출 경계를 기록하기 전에는 adapter를 호출하지 않는다. 이 경계 이전의 확정된 실패만 신규 증거로 SQL 실패 종결·receipt 보존·재시작 복구를 수행한다. 증거 저장이나 서버 응답이 유실되면 같은 attempt의 기록과 receipt를 재확인하며 질문을 다시 실행하지 않는다. 공급자 호출 여부가 불확실하거나 호출 경계를 넘은 실패는 이 증거로 확정 실패 처리하지 않는다. 첨부 준비 실패만으로 기기 연결이나 AI 준비 상태를 해제하지 않는다.
- Codex는 연결기 소유0700 디렉터리/0600 이미지 파일을 준비해 localImage로 전달한다. 사용자 저장소의 읽기 권한 범위를 넓히거나 사용자 경로를 대신 읽지 않는다. Claude는 검증한 동일 바이트의 base64 block을 전달한다.
- 이미지 content hash를 runtime intent·ACK·history proof·재개 판정에 일관되게 적용한다. native transcript가 저장하는 정확한 이미지 표현은 Step1 증거로 고정한다. 다른 이미지/텍스트로 변한 이력은 채택하지 않는다. 저장 한도를 무조건 올리거나 ACK 검증을 생략하지 않는다.
- `owned-history.ts:28,122`의16MiB 누적/1MiB 행 제한도 유지한다. 기존 이력 크기에 이미지 base64와 보수적인 응답 여유를 더한 사전 검사를 수행한다. 용량이 부족하면 모델 입력 전에 `이미지 대화 이력 한도에 도달했습니다. AI 설정에서 새 대화를 준비하세요`로 안내하며, 연결 자체의 통신 실패로 표시하지 않는다. 자동 새 대화/질문 재실행은 금지한다. 여러 이미지 질문 누적 후 경계에 도달하는 합성 검증을 포함한다.
- 종료 확인된 실행의 앱 임시 이미지 파일만 삭제한다. 미확인 실행은 자동 재입력 없이 보존한다. 클라우드 정리가 이미 공급자 이력에 포함된 바이트를 지우지는 않는다. 로컬 보존은 앱 상태 정리 규칙과 함께 안내한다.

### [ ] Step 6: 채팅 UX와 검증·배포
**File**: attachment UI/controller, chat-composer/timeline, docs
- 입력창 옆 이미지 버튼, 붙여넣기/드롭, 작은 미리보기(최대96px 높이)와 제거·진행·실패 표시. 첨부가 없을 때 현재 입력창 높이는 유지한다. 이미지가 있으면 텍스트 없이도 보낼 수 있게 하고 접근 가능한 기본 설명을 부여한다.
- 이미지 단독 전송은 outbox 예약 전 일반 메시지에는 `이미지를 첨부했습니다`, AI 질문에는 `첨부 이미지를 설명해주세요`를 기본 publicText로 확정하고 화면에도 같은 문구를 표시한다. 기존 publicText 비어 있음 금지 계약을 전역으로 완화하지 않는다.
- 전송 전 `오래된 이미지는 저장 공간 확보를 위해 정리될 수 있습니다`를 표시한다. 삭제된 카드에는 만료 표시를 남기고 깨진 이미지 아이콘을 노출하지 않는다. 원본 확대는 클릭할 때만 내려받고 방을 나가면 blob URL·메모리 참조를 폐기한다.
- 미리보기는 같은 압축본을 사용하고 서버 thumbnail 변환 서비스를 추가하지 않는다. viewport 기준 지연 로드와 같은세션 메모리 캐시로 중복다운로드를 줄인다. 전체 이력의 모든 이미지를 한꺼번에 받지 않는다.
- 관련 정본 문서만 갱신하고 필수 독립 리뷰·CI·브라우저 검사를 통과한 뒤 PR→승인 범위의 main 병합·운영 배포. 신규 bucket/secret/마이그레이션은 검토된 설정만 적용하고 기존 데이터 삭제·유료 설정 변경은 하지 않는다.

## Tests

- quota: 병렬예약/중복 operationId/Storage 성공 후 DB 실패/만료예약 실제object잔존/75% 시작·60% 종료/보호만남음/삭제 실패 후 재개.
- auth: 타인첨부게시·타방이미지조회·탈퇴이후접근·revoked device·다른attempt/fence·구버전claim·임의objectpath·직접Storage접근 모두 거절.
- races: 정리선점 vs 게시/claim/download, posted age24h, UNKNOWN 보호, TTL지난다운로드, 실패시byte예약유지, 월경계·동시download.
- contract/outbox: attachmentId 포함 정확한 같은 요청 재시도, 이미지 있는 빈텍스트, 일반 텍스트의 기존응답/저널 호환, 이미지 만료와 복구, logout/권한철회 초기화.
- provider: Claude 이미지ACK·native이력·다른imagehash거절·base64변조·1MiB상한·재시작·중단·이전텍스트기록; Codex localImage bytes와소유path·기한·파일정리. 합성 transport로 반복하고 실제입력은 승인된 최대2회만.
- attachment-preinput: 두 공급자 각각 다운로드 실패·hash 불일치·용량 거절에서 입력0회와 확정 실패 종결을 검증한다. 증거 쓰기 실패·종결 응답 유실·재시작에서 잘못된 FAILED나 중복 입력이 없어야 한다. 기존 Claude 전용 증거와 텍스트 실패 계약은 유지한다.
- browser: picker/paste/drop/제거/서버거절/업로드실패재시도/자기AI·동료AI·연결없는질문자/일반메시지이미지/확대·키보드닫기/만료/재입장·가상스크롤/작은화면 입력높이. 구버전AI에이미지전송불가 이유 표시.

## Risks

- 무료 한도는 조직 전체의 공유 예산이다. 배포 전 다른bucket/프로젝트 사용을 확인하고 앱 예산을 낮춘다. 공간75%정리만으로전송량을보장하지않는다. 실제플랜이Free가아니어도자동과금설정은변경하지않는다.
- 이미지에는 민감정보가 있을 수 있다. 참가자 공개 범위를 전송 전에 알리고 공급자 입력은 사용자가 지정한 AI에만 전달한다. 이미지 내용은 로그에 남기지 않는다.
- 신규 Storage secret은 권한면을 넓힌다. server-only 모듈·고정bucket·권한RPC·독립review를 필수로 한다. 현재 serverConfig 제한은 완화하지 않는다.
- 실제 공급자 지원/이력 증명이 확인되지 않으면 그 공급자의 이미지 capability는 광고하지 않는다. 기존 텍스트 기능은 유지한다.

## Verification

### 2026-10-19 구현 검증

- 코드 기준 `1bad54a`. 웹 단위829개·연결기1265개 통과. lint 오류0, 기존 `use-virtual-history`의 React 호환성 경고1개는 범위 밖으로 유지했다. format/format:check/typecheck/build 통과.
- 실제 로컬 Auth·PostgreSQL·Storage에서 원장/권한/정리/월 한도5개, 직접 질문 계약·중단 경합 후 설정 해제2개 통과. 별도 HTTP·브라우저1개에서 실제 업로드·전송·인라인 이미지·확대·ESC 닫기·타인/직접Storage 접근 거절을 확인했다. 1440px/390px 화면을 확인했다. 이미지 픽셀 축소·실제 IndexedDB 복구1개와 격리 Storage/환경 하네스8개도 통과했다.
- Claude2.1.293 합성 이미지 입력1회에서 정확한 이미지 ACK·native 이력·저장 증명 재검증을 확인했다. 재검증의 추가 입력은0회다. Codex 설치0.163.0은 제품 admission0.159.1과 달라 입력0회로 보류했고 이미지 capability를 비활성화했다.
- 런타임 구현 리뷰1회차 HIGH(미검증Claude버전 광고)는 실패 재현 후 버전 제한으로 수정했다. 2회차 독립 검토에서 해소 확인, 관련13개 통과.
- 웹/SQL 구현 리뷰1회차 HIGH(이미지 입력 전 실패와 REQUESTED 중단 경합에서 idle 미해제)는 실제DB false!=true로 재현했다. 정확한 이미지 증거를 기존 텍스트 증거와 함께 판정하도록 보완했다. 11가지 증거 변조를 포함한 재검증 및2회차 독립 검토에서 해소 확인했다.
- 비차단 MEDIUM: Codex 임시 이미지 소유 정보는 재시작 후 파일 청소를 재개하지 못한다. 현재 Codex 이미지 비활성화로 후속 보존하며 활성화 전에 해결해야 한다. 전송 전 정리 안내 누락은 승인된 Step6 요구사항으로 보완했다.
- 운영 SQL025와 서버 전용 환경 변수 등록 완료. 최종 PR/main 배포 확인 전에는 Step6를 완료로 표시하지 않는다.

- Node24: `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- 연결기: `npm --prefix packages/local-connector test`와 관련 실패 재현; 시간 민감한 전체검사는 순차 실행한다.
- DB/Storage 통합: 기존 격리 fixture에 Storage mock + 실제 격리bucket 정책 검사를 추가한다. 운영 채팅 이미지/기록에 테스트삭제를 실행하지 않는다. 로컬 Docker는 필요 구간만 실행하고 완료후 이프로젝트것만종료한다.
- browser: settings/workflow fixture와 첨부 fixture로 실행; 실제이미지시각검사1440/390. 유료서비스가입없이격리된비공개합성객체로 업로드/다운로드/정리확인.
- 독립 reviewer가 권한·동시성·입력증명·무료한도·운영코드검토. 통과 후 plan체크/정본문서갱신/커밋/PR/배포검증/완료명세archive.

## Sources

- [Supabase billing](https://supabase.com/docs/guides/platform/billing-on-supabase): Free Storage1GB. 2026-10-19 조회.
- [Supabase egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress): cached/uncached 별도 한도, Storage 외 트래픽도 포함.
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Storage deletion](https://supabase.com/docs/guides/storage/management/delete-objects): private 접근 및 실제객체삭제 API.
- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): image base64 content block. 문서는 형식 근거이며 현재 고정 CLI의 실제 수용 증거는 Step1에서 확인한다.
- [Codex App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs): localImage 입력. 실제 설치버전 schema와 함께 확인한다.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| Round 1: 기존 입력 전 실패 경로가 Claude 전용이라 Codex 첨부 준비 실패가 UNKNOWN에 남음 | HIGH | ACCEPTED — Round 2 독립 검토에서 계획 수준 해소 확인 | Step 5에 연결기 소유 첨부 준비 실패 증거와 호출 경계, SQL 종결·receipt·재시작 복구 및 양쪽 공급자 검증을 명시했다. 구현 전 계획 검토이므로 실행 재현은 구현 단계 테스트에 포함한다. |
| Round 2: 보정 및 영향 범위 재검토 | — | No issues found | 기존 Claude 계약을 유지하면서 양쪽 공급자의 신규 첨부 준비 실패 경계를 명시했음을 독립 reviewer가 확인했다. |
