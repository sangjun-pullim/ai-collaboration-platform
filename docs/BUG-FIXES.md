# 버그 수정 기록

재현 증거와 코드 변경·검증 결과가 있는 주요 오류만 기록한다. 설계 리뷰의 문서 보완은 코드 버그 수정으로 분류하지 않는다.

## 2026-10-01 — 런타임 실험의 단일 실행 잠금 해제 경합

- 현상: A가 manifest 잠금을 보유한 상태에서 같은 PID의 B가 거절된 뒤, 별도 프로세스 C가 잠금에 진입했다. 미종결 실행의 중복 호출을 막는 경계가 깨졌다.
- 원인: 기존 SQLite 파일을 검증하려고 연 raw descriptor를 닫으면 같은 프로세스가 그 파일에 보유한 POSIX lock도 해제된다. [SQLite의 설명](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_)
- 수정: [experiment-policy.ts](../experiments/local-ai-runtime/src/experiment-policy.ts)는 기존 파일을 `lstat`으로 검증하고 raw open/close를 최초 exclusive 생성에만 사용한다. 잠금 파일을 삭제하는 회수는 하지 않는다.
- 검증: A 보유 → B 거절 → 외부 C 거절 → A 해제 → 다음 holder 진입 순서의 회귀 검사를 먼저 실패시킨 후 통과시켰다. Node 24.21.0 타입 검사·34/34 런타임 테스트·실제 initialize-only probe와 독립 구현 리뷰 3을 통과했다.

## 2026-10-01 — 중단·종료 과정의 종결 보존과 오류 수거

- 현상: 실제 terminal 뒤 늦은 interrupt ACK 오류가 UNKNOWN으로 덮이거나, 종료 요청 뒤 준비 중인 실행이 새 client/turn을 시작할 수 있었다. 닫힌 stdin과 오류 응답 write 실패도 처리되지 않는 경로가 있었다.
- 수정: [codex-runtime.ts](../experiments/local-ai-runtime/src/codex-runtime.ts)는 종결 증거를 우선 보존하고 영구 취소 상태로 신규 진입을 막는다. 이미 시작한 실행은 UNKNOWN 영속화와 소유 child 정리를 기다린다. [stdio-client.ts](../experiments/local-ai-runtime/src/stdio-client.ts)는 stdin/write 실패를 transport 오류로 수거한다.
- 검증: ACK 지연·오류·유실, 미해결 준비, 실제 subprocess SIGINT, fd0 종료 및 write 실패를 격리 회귀 검사로 확인했다. 최종 34/34 검사와 독립 리뷰에서 해당 변경의 통과 결과를 재사용했다. interrupt ACK만으로 도구·자식 프로세스 전체 종료를 보장하지 않는다.

## 2026-10-01 — 미제출 개인 입력의 공개 방향 수정 전환

- 현상: 개인 설명을 입력한 뒤 제출하지 않고 방향 수정으로 바꾸면 그 원문이 공개 textarea에 나타났다. 방향 수정 제출로 공동 기록에 노출될 수 있었다.
- 원인: [room-view.tsx](../src/features/investigation-prototype/room-view.tsx)의 Composer가 두 입력에 같은 `text` 상태를 사용했다. 기존 검사는 개인 설명을 먼저 제출해 해당 전환을 놓쳤다.
- 수정: `speak`·`explain`·`steer`별 초안으로 분리해 모드 왕복 시 보존하고 제출한 초안만 비운다.
- 검증: 수정 전 desktop/mobile에서 실패를 재현했다. 모드 왕복·개인 초안 보존·공동 기록/발신 비노출 회귀를 포함한 20/20 브라우저 검사와 독립 재리뷰 2를 통과했다. 타입·lint·build를 재확인하고 변경 없는 9개 상태 검사와 시각 검토 결과를 재사용했다.

## 2026-10-01 — 정지·삭제 계정의 기존 JWT 직접 접근

- 현상: 실제 Auth로 로그인한 합성 계정을 정지하면 웹과 RPC는 거절했지만 기존 JWT로 직접 PostgREST 조회가 가능했다. soft delete의 `deleted_at` 행에서는 웹 거절 후 직접 조회와 bootstrap RPC도 성공했다.
- 수정: [정지 보정 migration](../supabase/migrations/20261001000200-deny-inactive-auth-reads.sql)은 RLS helper에 현재 Auth 상태를 결합한다. [삭제 보정 migration](../supabase/migrations/20261001000300-deny-soft-deleted-auth.sql)은 조회·actor·초대 발급자에 `deleted_at is null`을 추가한다. 이미 적용한 초기 migration과 execute grants는 유지한다.
- 검증: 정지/soft-delete의 기존 서명 JWT 실패를 실제 로컬 Auth·DB로 먼저 재현했고, 네 public 모델·RPC·웹·초대 미소비와 정상 사용자 positive control을 포함한 통합 14개가 보정 후 통과했다. 물리 삭제의 실제 membership·옛 JWT 직접 네 조회/RPC·웹 차단과 정상 owner 회귀도 보완해 통합 14개가 다시 통과했다. 실제 Auth browser 4건도 통과했으며 독립 구현 리뷰 3도 추가 지적 없이 통과했다.

## 2026-10-01 — 로그인 redirect의 loopback origin 변경

- 현상: forwarded proto가 있는 보호 요청에서 Next가 신뢰하는 `127.0.0.1` 로그인 Location을 `localhost`로 바꿨다. 다른 공격자 origin으로 이동하는 현상은 관찰되지 않았다.
- 수정: [next.config.ts](../next.config.ts)의 공개 `skipProxyUrlNormalize` 설정으로 configured origin을 유지한다. 테스트는 상대·절대 Location을 같은 신뢰 origin 기준으로 해석해 origin·고정 path·query 부재를 검사한다.
- 검증: 위조 Host/forwarded header의 실제 HTTP 실패를 먼저 확인했다. 보정 후 해당 회귀를 포함한 통합 14개와 기존 모의 browser 20개가 통과했다. 독립 구현 리뷰 3도 추가 지적 없이 통과했다.

## 2026-10-01 — Auth browser 실패 산출물의 민감 입력

- 현상: trace·screenshot·video를 꺼도 locator 실패의 DOM snapshot이 `error-context.md`에 초대 원문을 남길 수 있었다. 성공한 fill step의 reporter 제목에도 OTP가 들어갈 수 있었다.
- 수정: [auth-browser-artifact-policy.ts](../tests/helpers/auth-browser-artifact-policy.ts)는 artifact teardown 전 오류 payload를 제거하고 reporter의 step·cause·message를 고정 문구로 정제한다. fallback copy prompt도 비활성화한다.
- 검증: 실제 계정 대신 합성 초대/OTP marker를 사용한 고의 실패 4종을 실행했다. baseline/corrected 각각 4개 DOM-render positive control과 15개 산출물·내장 ZIP을 검사해 노출 파일 11개 → 0개를 확인했다. 고정된 단계와 HTTP status만 기록하는 안전한 진단으로 실제 Auth browser 선택자 오류를 확인·보정한 뒤 4건도 통과했다.

## 2026-10-01 — 실제 Auth browser 선택자와 검증 범위

- 현상: 초대 역할의 nested label에는 option 텍스트도 포함돼 exact label 선택자가 0개를 찾았다. 보호 오류의 전체 alert 선택자도 Next의 route announcer와 겹쳤다.
- 수정: [Auth E2E](../tests/e2e/web-auth-room-access.spec.ts)는 exact combobox 접근성 이름과 의도한 제품 오류 alert를 사용한다. 미리 등록한 응답 waiter로 old invite의 HTTP 409를 확인하고 오류 표시·포커스·Tab·mobile 검사를 유지한다.
- 검증: 실제 Auth timeout과 후속 observer 실패를 보존했다. 합성 Chromium DOM control로 label 0/combobox 1, 전체 alert 2/제품 오류 1을 확인했다. 보정 후 실제 Auth browser 4/4가 통과했다. 독립 리뷰 2가 지적한 물리 삭제의 기존 JWT 직접 네 조회/RPC·정상 사용자 회귀도 보완해 통합 14/14가 재통과했다. 최종 독립 리뷰는 진행 중이다.

## 2026-10-01 — 기기 public RPC의 저장 hash 인증

- 현상: 초기 기기 SQL 후보에서 저장 credential/proof hash 자체가 public RPC 인증 입력으로 사용될 수 있었다.
- 수정: [기기 migration](../supabase/migrations/20261001000400-device-workspace-binding.sql)의 public wrapper가 원문 bearer를 hash한 뒤 private helper에 전달하도록 보정했다. 이 후보는 적용 전에 수정했으며 이미 적용한 사람 Auth SQL은 유지했다.
- 검증: 소유 합성 DB transaction에서 수정 전 실패를 재현한 뒤 저장 hash 거절·원문 보유자 양성·private 직접 접근 거절을 확인하고 rollback했다. 적용 후 실제 기기 통합 12개에서도 직접 public RPC의 저장 hash 거절과 원문 양성 대조가 통과했다.

## 2026-10-01 — 등록된 기기·계정 삭제의 receipt FK 충돌

- 현상: 실제 기기 통합 첫 실행에서 등록 binding의 credential receipt FK가 즉시 검사되어 기기 cleanup과 등록 계정의 삭제 cascade가 충돌했다. 초기 결과는 4통과·8실패였다.
- 수정: [후속 migration](../supabase/migrations/20261001000500-device-cascade-integrity.sql)은 정확한 세 receipt 참조만 `DEFERRABLE INITIALLY DEFERRED`로 바꾸고 NO ACTION을 유지한다. 이미 적용한 SQL 네 파일·권한·함수·다른 제약은 유지했다. fixture는 원래 검사 실패와 cleanup 실패를 구분하고 최소 private 복구 identity를 남긴다.
- 검증: 실제 등록 hard-delete·기기/조직 물리 정리, 세 참조를 가진 정상 binding과 독립 credential 삭제 거절을 포함해 보정 후 기기 12/12·Auth 14/14가 통과했다. 소유 관계가 복구된 첫 실패 fixture 여섯 개만 정리했으며 식별이 불충분한 anonymous 데이터는 지우지 않았다. browser·독립 재리뷰는 진행 중이다.

## 2026-10-01 — 외부로 연결된 보호 설정 경로 우회

- 현상: 등록 root만 canonicalizing하면 `.claude` 같은 보호 설정 자체가 외부로 symlink된 target을 등록할 수 있었다. `..cache` 같은 정상 이름의 하위 경로도 parent traversal로 잘못 판정했다.
- 수정: [workspace-registration.ts](../packages/local-connector/src/workspace-registration.ts)는 보호 경로의 canonical target을 함께 검사하고 실제 `..` 경로 구성 요소만 바깥 경로로 판정한다. metadata I/O 실패는 고정 오류로 거절한다.
- 검증: 합성 symlink target·하위/상위 경로와 prefixed-dot 회귀를 먼저 실패시킨 후 connector unit 5개가 통과했다. 정상 저장소 등록·독립 profile 보존도 유지했다. 개인 설정 내용은 읽지 않았다.

## 2026-10-01 — 신규 기기 upstream의 HTTP 인증 전송 허용

- 현상: 기존 Supabase URL 설정 검증만 재사용하면 새 raw proof/credential 전송 경로에서 외부 HTTP를 허용할 수 있었다. 실제 외부 전송을 관찰한 것은 아니다.
- 수정: [device-client.ts](../src/features/device-binding/device-client.ts)는 HTTPS 또는 canonical loopback HTTP origin만 허용하고 URL 인증정보·query/fragment·redirect를 거절한다. 사람 Auth·proxy 설정은 바꾸지 않았다.
- 검증: unsafe upstream이 합성 fetch에 도달하는 실패를 먼저 재현한 뒤 거절 요청의 fetch 0과 HTTPS/loopback 양성·redirect 정책을 확인했다. root unit 11개와 실제 loopback 기기 통합 12개가 통과했다.

## 2026-10-01 — 최초 pairing ACK 유실의 복구 안내

- 현상: 서버에서 `begin`을 반영한 뒤 응답이 유실되면 같은 hash 재요청은 409이고 로컬에는 pairing UUID가 없는데도 `status`가 동일 명령 재시도를 안내했다.
- 수정: [CLI](../packages/local-connector/src/cli.ts)는 해당 pending begin에 local profile 제거·새 pairing·새 사람 승인을 안내한다. 자동 새 연결을 만들지 않으며 다른 mutation의 receipt 복구는 유지한다.
- 검증: commit 이후 응답 유실과 같은-hash 409·원래 journal 보존·명시적 제거 후 새 승인의 양성 대조를 synthetic RED 뒤 connector unit에서 통과시켰다.

## 2026-10-01 — 인증·기기 보정의 최종 독립 검토

- 사람 Auth004의 최종 독립 리뷰 3은 추가 지적 없이 통과했다. 앞선 항목의 리뷰 진행 표시는 당시 기록이다.
- 기기005는 HIGH3·MEDIUM3을 보정하고 독립 구현 재리뷰 2에서 추가 지적 없이 통과했다. 실제 기기12·Auth14·기기 browser4·Auth browser4·모의 browser20 검사도 통과했다. 실제 provider 실행·Realtime·두 PC의 완료 증거로 확대하지 않는다.

## 2026-10-01 — 빈 inline 설정 뒤 외부 실행 훅의 누락

- 현상: 공식 Codex의 inline 훅 배열은 비어 있어도 같은 cwd의 `hooks/list`에는 외부 JSON에서 발견한 enabled 훅 19개가 있었다. config만으로 훅 부재를 판정할 수 없었다. 실제 모델 입력 유출을 관찰한 것은 아니다.
- 수정: [Codex adapter](../packages/local-connector/src/codex-adapter.ts)는 exact cwd의 hook 발견·오류·metadata를 검사하고, 활성 훅의 source/환경/입력 범위를 증명하지 못하면 준비를 거절한다. trusted·managed·matcher 이름·빈 inline 배열로 예외를 만들지 않는다. 외부 instruction/compaction/catalog 파일도 검사한다.
- 검증: 외부 JSON·malformed/missing/wrong cwd·unknown 주입·필수 훅 보존·재개/재실행 재검사·늦은 응답의 7개 회귀와 외부 지침 source 회귀를 포함해 parent connector 48/48이 통과했다. 별도 독립 증거 감사는 현재 passive/matcher 예외의 환경·실행 바이트·도구·첫 입력 증명이 부족하다고 판정했다. 전체 구현 리뷰와 실제 provider 수용은 남아 있다.

## 2026-10-01 — 대기 중 준비 갱신 receipt의 저널 용량 소진

- 현상: ready를 갱신할 때마다 confirmed operation을 계속 보관하면 장시간 idle만으로 1024개 저널 한도를 채워 준비 갱신을 거절할 수 있었다. 실제 수 시간 대기를 실행한 결과가 아니라 source와 한도 fixture로 재현한 문제다.
- 수정: [로컬 저장](../packages/local-connector/src/runtime-store.ts)과 [runner](../packages/local-connector/src/workflow-runner.ts)는 최신 confirmed ready와 참조·미확인 작업을 보존하며 오래된 미참조 confirmed ready만 정리한다. 한도와 실행 증거의 보존을 유지하고 durable intent의 순서 변경을 거절한다.
- 검증: 수정 전 외부 source·한도 회귀 2개가 실패했고, 수정 뒤 parent connector 48/48이 통과했다. receipt 저장 실패의 transmitted intent 보존·동일 작업 복구, 최신/참조 receipt·질문/종결/관찰 삭제 거절도 검사했다. 준비·실행·업로드 중 ready 갱신 공백은 별도 보정 중이다.

## 2026-10-01 — 개인 설정 적용 정책의 명시적 변경

앞선 외부 훅·지침 격리 검증은 당시 초안 정책의 기록이다. 이후 사용자가 기존 개인 PC의 에이전트 설정을 그대로 적용하도록 확정했다. 활성 훅·전역 지침의 존재만으로 거절하는 정책을 대체하며 [ADR-005](ADR.md#adr-005--각-pc의-기존-에이전트-설정과-공동-정보-공개를-분리)에 설정 유지와 공동 공개 경계를 기록한다. 필수 승인·관리 정책 비우회와 raw config/credential 비노출은 유지한다. 보정 구현·독립 검증은 진행 중이다.

## 2026-10-01 — 모델 호출 없는 준비 문맥의 저장 누락

- 현상: 설치된 공식 Codex 0.159.1에서 no-turn `thread/start`만 수행하면 rollout이 아직 생성되지 않아 즉시 full history read가 실패하고 새 프로세스의 같은 ID resume도 실패했다. 실제 설치 runtime의 exact owned 합성 thread로 재현했다.
- 보정: 같은 새 connector-owned ID에 공식 `thread/name/set`으로 고정 제품명을 지정하고 저장된 zero-turn full history를 검증한 뒤 candidate를 전달한다. 이름 설정/저장 실패에 새 thread나 priming turn을 자동 생성하지 않는다.
- 검증: root no-turn probe는 이름 설정 전 실패와 설정 후 저장·full read·별도 프로세스 동일 ID resume 성공을 확인했다. 모델 호출·로그인·auth 복사·개인 설정 변경은 없었다. 제품 회귀 테스트와 전체 검증은 진행 중이며 [S24](research/sources.md#s24)의 설치 근거와 실제 공동 조사 수용을 구분한다.

## 2026-10-02 — 기본 paginated 이력과 준비 문맥 계약의 불일치

- 현상: 공식 Codex의 기본 이력 형식이 paginated인 환경에서 새 문맥의 legacy full history를 기대한 준비 검사가 실패했다. 실제 수용 검사는 모델 호출 전에 종료됐다.
- 수정: [Codex adapter](../packages/local-connector/src/codex-adapter.ts)의 새 `thread/start`에 `historyMode: "legacy"`를 명시했다. 공급자가 이 요청을 무시하면 추가 생성 없이 거절한다.
- 검증: 실패 회귀를 먼저 재현했다. 준비·저장·같은 ID의 별도 프로세스 재개를 모델 호출 없이 확인했다. 원래 전체 connector 검사와 해당 보정의 독립 리뷰를 통과했다. 이전 준비 문맥의 저장 보정도 현재 제품 검증에 포함된다.

## 2026-10-02 — 실제 왕복 검사의 답변 이벤트 개수 오판

- 현상: 실제 세 실행이 정상 종결·업로드된 뒤, ANSWER 이벤트를 하나로 기대한 검증 스크립트가 `2 !== 1`로 실패했다. 중앙 계약은 같은 답변의 PENDING과 ACCEPTED를 각각 기록한다.
- 판정: 원본 실패는 보존했다. 도달한 제어 흐름과 정확한 소유 문맥의 공식 native 이력으로 세 정상 종결·최종 답변·업로드를 확인하고 별도 독립 검토를 받았다. 정리된 DB 이벤트 원문을 다시 검증했다고 주장하지 않는다.
- 검증: 남은 실제 중단 검사에서는 중앙 ACK를 정확한 request/attempt/fence와 대조하고 typed INTERRUPTED·업로드·소유 프로세스 정리를 확인했다. 합성 검사와 실제 모델 호출의 수치·범위는 [진행 상태](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.

## 2026-10-05 — 모바일 메뉴의 새 채팅방과 폐기된 로그인 복구

모바일 목록의 새 방 버튼이 바깥 생성 Dialog 대신 안쪽 Sheet의 Radix 문맥을 사용해 메뉴만 닫혔다. 실제 브라우저에서 수정 전 두 사례가 같은 지점에서 실패했다. 목록 버튼을 고정 callback으로 바꾸고 Sheet의 종료 뒤 생성 Dialog를 열며 취소할 때 보이는 메뉴 버튼으로 포커스를 돌린다.

폐기된 Auth 세션은 기존 cookie를 보존하면서 401을 반환했으나 입장 화면에서 명시적인 logout을 선택할 수 없어 재입장이 막혔다. 확인된 UNAUTHENTICATED에만 이전 계정·AI 소유권의 복구 한계를 설명하고 기존 logout API를 사용자가 직접 실행하도록 제공했다. 503·알 수 없는 오류에서는 기존 ID를 유지하고 일반 재시도를 제공한다. 새 사용자의 자동 생성이나 자동 재전송은 하지 않는다.

단위 회귀를 먼저 실패시킨 뒤 보정했고 실제 Auth 계정 폐기→기존 cookie 유지→사용자 logout→새 ID 입장과 모바일 생성·포커스 복귀를 브라우저에서 확인했다. 최종 검사 수치와 독립 리뷰 처분은 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태)를 따른다.

## 2026-10-05 — 한 답변의 상태 변경을 중복 메시지로 표시

실제 DB를 사용하는 채팅 검사에서 하나의 질문·하나의 실행에 답변 메시지 두 개가 나타났다. 서버의 PENDING→ACCEPTED 이벤트는 정상 감사 기록이지만 화면이 각각을 새 답변으로 렌더링했다.

같은 방·request·question·agent·bindingEpoch를 가진 답변은 가장 큰 sequence의 상태로 한 번만 표시하도록 고쳤다. 원본 이력과 서로 다른 실행은 보존한다. 브라우저의 원래 실패와 수정 전 결과는 보존했으며 원본 불변·늦은 이벤트·다른 실행을 확인하는 단위 회귀를 추가했다. 최종 브라우저·독립 리뷰 결과는 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태)에 기록한다.

## 2026-10-07 — 기본 Claude 연결과 같은 대화 후속 질문의 누락

기본 Claude factory가 합성 Node fixture만 신뢰하는 정책을 사용해 공식 설치·기존 로그인에도 실제 admission을 만들지 못했다. [native 정책](../packages/local-connector/src/claude/native-policy.ts)을 기본 factory에 연결하고 공식 설치·로그인·설정을 확인하는 모듈을 분리했다. 비활성 builtin AGENTS reader가 읽지 않는 Codex 지침을 별도 source로 요구하던 경로도 실패 재현 뒤 보정했다.

저장 native JSONL을 stdout init/result 형식으로 가정하면 정상 답변 뒤 대화 재개 검증이 실패한다. [native 이력 증명](../packages/local-connector/src/claude/native-history-proof.ts)은 정확한 소유 session의 저장 행을 실시간 입력·메시지·실제 host 도구 반환과 대조한다. 이력 확인 실패 뒤에도 검증한 typed terminal과 답변을 보존하며 다음 resume 입력만 차단한다. 도구 결과 위조를 먼저 실패시킨 뒤 실제 반환 receipt의 대조를 보완했다.

구현 리뷰에서 설정 import 충돌·custom authentication headers·대화 기록 비활성화 상속·쓰기 가능한 설치 상위 경로를 재현하고 보정했다. 개인 설정 파일은 유지하고 채팅 작업의 기록을 켜며 같은 UUID resume를 사용한다. 격리 회귀와 독립 재리뷰를 마쳤고 현재 수치·기존 전체 검사 취소·실제 Claude 수용의 미완료 조건은 [검증 정본](planning/delivery-and-validation.md#현재-진행-상태)에 기록한다.

## 2026-10-08 — 웹 준비 검사에서 Docker 연결 실패의 원인 누락

Docker 접근이 거절되어도 웹 준비 명령은 `LOCAL_STACK_UNVERIFIED`를 출력했다. DB 점검 모듈이 다른 모듈의 오류를 감싸면서 웹 실행기의 `LOCAL_DOCKER_UNAVAILABLE` 분류가 사라졌다.

[웹 실행기](../scripts/dev-local-web.mjs)는 자신의 Docker 실행 함수에서 확인한 고정 오류 분류만 보존한다. 원본 stderr·키·임의 오류 코드는 출력하지 않으며 기존 DB·게이트웨이 확인 순서와 실행 조건을 유지한다.

실제 명령을 실행하는 격리 회귀가 수정 전 실패했고 수정 후 통과했다. Docker 실패의 고정 JSON·비공개 출력 부재·Next 미실행을 확인했다. 관련 검사와 독립 리뷰 결과는 [검증 정본](records/verification-history-20261008.md#2026-10-08-goal-재개와-실행-환경-확인)에 기록한다. 실제 실행 환경에서도 명령은 `LOCAL_DOCKER_UNAVAILABLE`로 종료했으며 Docker가 꺼졌다는 의미로 해석하지 않는다.

## 2026-10-08 — 설치된 DB의 자료 이력 검사에 업그레이드 검사 포함

일시정지·자료 이력을 설정 검증 명령에 연결할 때 SQL013 설치 전 DB를 요구하는 검사를 함께 선택했다. 안내대로001–013이 설치된 DB에서 실행하면 기존 업그레이드 guard가 정상적으로 거절해 설정 회귀 명령이 실패한다.

[자료 이력 회귀](../tests/integration/shared-input-source-history.test.ts)는 설치 완료 상태의8개 검사만 유지하고, 기존 업그레이드1개는 [별도 파일](../tests/integration/shared-input-source-upgrade.test.ts)로 옮겼다. 검사 본문·제한 시간·기존 guard·정리 driver는 유지했다. 통합 명령은 설치된 DB의4개 파일을 선택하고 업그레이드 검사는 선택하지 않는다.

검사 선언과 기존 guard를 사용하는 합성 재현에서 잘못된 선택의 실패와 보정 후 제외를 확인했다. 실제 DB 검증의 완료는 주장하지 않는다. 독립 재검토와 원문 보존 근거는 [검증 정본](records/verification-history-20261008.md#2026-10-08-설정-검증-보완과-커밋)에 기록한다.

## 2026-10-08 — 실제 설정과 자료 이력의 DB 함수 오류

실제 DB·HTTP 검사에서 모델 목록의 SQL 별칭, 자료 요약의 JSON 연산자, 설정 적용의 receipt 변수 이름이 기존 함수와 충돌했다. 유효한 목록 등록·자료 확정·binding 적용이 각각 거절됐다.

기존 SQL010·013을 덮어쓰지 않고 [목록 검증 보정](../supabase/migrations/20261008001400-runtime-settings-catalog-validation.sql), [자료 요약 보정](../supabase/migrations/20261008001500-source-history-summary-validation.sql), [적용 receipt 보정](../supabase/migrations/20261008001600-runtime-settings-binding-receipt.sql)을 추가했다. 함수 계약·권한·기존 데이터를 유지하고 모호한 식별자와 연산 순서만 보정한다. [로컬 설치 helper](../scripts/apply-local-ai-settings.mjs)는 같은 transaction 안에서도 기존 상태와 함수 원문을 확인하며 설치 완료 상태에 SQL을 다시 적용하지 않는다.

각 오류의 원본 실패와 rollback 검증 뒤 실제 DB·HTTP 회귀 및 독립 리뷰를 통과했다. 기존 DB의 warm upgrade와 최종 수치는 [진행 정본](planning/delivery-and-validation.md#현재-진행-상태)에 기록한다.

## 2026-10-08 — Claude 갱신 캐시와 새 내장 플러그인의 실행 확인 실패

공식 2.1.293이 모델 목록 캐시와 `additionalModelOptionsAnsweredAt`을 함께 갱신해 권한 변경으로 오판했고 입력 전에 준비를 거절했다. [설정 비교](../packages/local-connector/src/claude/configuration.ts)는 이 캐시 시각만 실행 권한 비교에서 제외한다. 계정·조직·실행 권한·알 수 없는 설정의 변경은 계속 거절한다.

이후 실제 첫 입력의 초기화 응답에는 2.1.293의 새 내장 `cc-plugin-plugin-authoring`이 남아 빈 플러그인 목록 조건을 통과하지 못했다. [작업 정책](../packages/local-connector/src/claude/native-policy.ts)에 이 버전의 내장 플러그인 비활성화만 추가했다. 2.1.288의 설정과 엄격한 초기화 검증은 유지하고 개인 설정 파일은 수정하지 않는다.

실패 입력은 UNKNOWN으로 보존하고 소유 프로세스 종료를 확인했다. 보정 소스·격리 회귀·독립 리뷰는 통과했으며 실제 새 입력 성공으로 표시하지 않는다. 기존 입력 예산과 자동 재시도 금지를 유지한다.

## 2026-10-08 — lease 충돌 경계에서 정확한 중단 요청 누락

중단 요청이 저장된 뒤 lease 갱신이 CONFLICT를 반환하면 실행 감시가 현재 중단 요청을 확인하기 전에 실패할 수 있었다. [실행기](../packages/local-connector/src/workflow-runner.ts)는 로컬 종결이 없는 이 충돌에서만 guarded poll을 수행한다. 현재 실행과 정확히 같은 시도·미만료 lease·REQUESTED 제어를 요구하며 검증된 ACK를 저장한 뒤에만 중단 전달을 확인한다.

다른 요청·시도·만료·거절·ACK 오류는 성공으로 처리하지 않는다. 로컬 종결과 결과 발행 복구도 유지한다. 시계·응답을 고정한 실패 재현과 경계 회귀, 실제 DB·HTTP의 가짜 Claude 도구 중단 검사 및 독립 리뷰를 확인했다. 이 결과를 공식 Claude의 실제 중단 성공으로 해석하지 않는다.

## 2026-10-08 — 연결 화면의 새 코드 링크와 개발 모드 코드 유실

- 현상: 연결 화면을 열어 둔 상태에서 새 연결 링크를 열면 URL의 코드가 남거나 이전 코드가 유지됐다. 재방문 처리를 보정하는 첫 후보는 개발 모드의 effect 재실행에서 첫 코드를 잃었다.
- 원인: 첫 진입만 읽던 effect에 해시 변경 처리가 없었다. 첫 후보에서는 URL을 지운 뒤 예약한 상태 갱신을 StrictMode 정리가 취소했다.
- 수정: [connection-manager.tsx](../src/features/device-binding/connection-manager.tsx)는 새 링크를 읽고 URL에서 즉시 제거한다. 아직 적용하지 않은 코드는 컴포넌트에 잠시 보존해 effect 재실행에서 다시 검증한다. 잘못된 코드와 이전 승인 체크를 지우고, 화면을 벗어난 뒤에는 상태를 갱신하지 않는다. 승인 API는 사용자의 직접 승인을 요구한다.
- 검증: 두 실패를 단위 검사로 재현한 뒤 관련23건을 통과했다. 최신 독립 빌드의 desktop/mobile 기기 연결 화면6건과 독립 리뷰2가 모두 통과했다. 이전 빌드로 실행한 브라우저 실패 로그는 보존하며 최신 코드의 수용 근거에서 제외했다.

## 2026-10-08 — Mac 폴더 선택 창의 취소 오류 분류

- 현상: 실제 폴더 선택 창에서 취소를 눌러도 `CANCELLED` 대신 `FAILED`가 반환됐다.
- 원인: `execFile`은 오류와 stderr를 callback의 별도 인자로 전달한다. 기본 실행 함수가 오류만 보존해 취소 코드 `-128`을 확인하지 못했다.
- 수정: [folder-picker.ts](../packages/local-connector/src/settings/folder-picker.ts)는 callback과 소유 child의 종료를 모두 확인한 뒤 크기가 제한된 비공개 진단 정보로 분류한다. 원문 오류·경로·stderr는 공개 응답에 포함하지 않는다. 시간 제한·중단·크기 제한·선택 경로 검증은 유지한다.
- 검증: 취소·권한 거절·크기 초과·종료 순서의 단위21건과 독립 리뷰를 통과했다. 실제 Mac 창에서 지정한 검증용 폴더의 선택과 취소를 각각 확인했으며 AI 입력은0이다. 최초 실패 결과도 보존한다.

## 2026-10-08 — Claude 2.1.293의 도구 메타와 사용량 알림

- 현상: 실제 입력의 초기화와 입력 접수 기록은 확인했으나 최신 `tools/call` 메타 형식을 거절해 `UNKNOWN`으로 종료했다. 같은 실행에서 최신 사용량 알림도 관찰했다.
- 원인: 기존 도구 검증은 이전 메타 형식만 허용했고 `rate_limit_event` 처리가 없었다. 첫 보정의 독립 리뷰에서는 입력 접수 기록 저장이 보류된 동안 먼저 도착한 알림을 뒤의 종결 메시지가 봉인하는 경합도 확인했다.
- 수정: [input-proof.ts](../packages/local-connector/src/claude/input-proof.ts)는 현재 입력에서 이미 확인한 도구 ID·이름·인자와 최신 메타를 대조한다. 기존 메타 호환과 중복 호출 차단을 유지한다. 사용량 알림은 공식 SDK의 알려진 필드를 제한된 비공개 관찰로만 검증한다. [adapter.ts](../packages/local-connector/src/claude/adapter.ts)는 알림을 수신 순서대로 검증한 뒤 입력 접수 기록 저장과 권한 재검사를 기다린다. 종결 이후 알림은 거절하며 알림으로 도구·입력·종결 권한을 만들지 않는다.
- 검증: 실제 메시지의 읽기 전용 재생과 도구·형식·순서·입력 접수 기록 실패의 회귀를 확인했다. 독립 리뷰1의 HIGH1건을 수정했고 리뷰2는 C0/H0/M0/L0/INFO1로 통과했다. 실제 정상 답변·동일 대화 재개·중단은 별도 수용이다. 기존 `UNKNOWN`5개와 예산·승인·실행 기록은 보존한다.

## 2026-10-08 — Claude 자동 업데이트 이후 검증 버전 선택

개인 CLI 링크가 지원 범위 밖 버전으로 자동 업데이트되면 이미 설치된 검증 버전도 선택하지 못해 입력 전에 연결이 거절됐다. [설치 선택](../packages/local-connector/src/claude/native-installation.ts)은 지원되는 현재 버전을 우선하고, 미지원 현재 링크에서는 같은 개인 설치의 검증된 지원 버전을 선택한다. 개인 링크·설정은 바꾸지 않으며 선택한 실행 파일의 소유권·서명·해시·변경 검사는 유지한다. 실패 재현·관련 회귀·독립 리뷰를 통과했다.

## 2026-10-08 — Claude 대화의 보조 기록 대조

2.1.293의 실제 native JSONL에는 대화 외에도 입력 queue·환경·개인 지침·사용량 보조 기록이 저장된다. 이를 모르는 형식으로 거절해 typed 정상 완료 뒤 후속 대화를 차단했다. [보조 기록 검증](../packages/local-connector/src/claude/native-history-records.ts)을 분리하고 queue 짝·입력 본문 hash·부모 UUID·소유 세션과 알려진 형식만 검증한다. 전체 prefix hash·실시간 대화·실제 도구 반환 대조는 유지한다. 기존 미확인 보고는 보존하고 원래 typed 완료·저장 대화의 읽기 전용 재대조로 확인된 결과를 별도 기록한다. 실패 재현·관련 회귀·독립 리뷰를 통과했다.

## 2026-10-08 — Claude 중단의 공식 MCP 알림과 native 취소 기록 거절

- 현상: 실제 읽기 대기에서 중단하면 공식 `notifications/cancelled` 알림에 JSON-RPC 요청 `id`가 없어 처리기가 UNKNOWN으로 끝났다. typed result가 없는 원래 실행은 미확정으로 보존했다.
- 수정: [input-proof.ts](../packages/local-connector/src/claude/input-proof.ts)와 [adapter.ts](../packages/local-connector/src/claude/adapter.ts)는 취소할 요청 번호를 이미 확인한 입력·도구·내구 중단에 연결한다. 종결 수신 전의 소유 읽기만 취소하고 늦은 도구 응답은 보내지 않는다. [native-interruption-records.ts](../packages/local-connector/src/claude/native-interruption-records.ts)는 native 취소 설명을 입력·읽기·종결을 만들지 않는 보조 기록으로 분리한다. 원본 전체 이력 해시는 유지한다.
- 리뷰 보정: 첫 독립 리뷰에서 종결 수신 뒤 취소가 내구 증거에 추가되는 경합을 확인했다. 진입과 ACK 저장 대기 뒤 모두 차단하고 실패 재현 회귀를 통과시켰다. 두 번째 독립 소스 리뷰에서 해소를 확인했다.
- 검증: 신규 경계·adapter 재접속 회귀와 전체 연결기·타입·lint·format/check를 통과했다. 수치와 실제 중단의 남은 조건은 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다. 이 소스 검증을 실제 INTERRUPTED 수용으로 표시하지 않는다.

## 2026-10-09 — Mac 연결의 중복 실행과 AI 설정 갱신 누락

- 현상: 웹의 연결 명령이 먼저 `INVALID_BODY`를 출력했다. 웹 승인 뒤 터미널 확인이 거절되면 `FORBIDDEN`으로 종료했고, 등록이 끝나도 웹의 모델·effort 설정 진입이 갱신되지 않았다. 만료된 미등록 프로필은 같은 코드로 계속 연결을 시도했다.
- 원인: `node -e` 실행 인자가 CLI의 직접 실행 조건과 겹쳐 `main`이 두 번 실행됐다. 빈 확인 입력은 거절로 처리했고 웹 승인 뒤 갱신은 터미널 등록보다 먼저 끝났다. 기존 만료 프로필에는 명시적 재연결 경로가 없었다.
- 수정: [bootstrap](../scripts/local-connection-bootstrap.sh)에 직접 실행 조건과 구분되는 인자를 넣었다. [터미널 연결](../packages/local-connector/src/cli/connect-command.ts)은 `yes`·`no`를 구분하고 빈 입력을 다시 안내한다. 미등록 만료 상태는 서버와 보존 기록을 확인한 뒤 사용자가 `restart`를 입력한 경우만 새 코드로 연결한다. [로컬 보관](../packages/local-connector/src/state-store.ts)은 원본 파일의 동일성과 내구 보관을 확인하며, 저장·중단·교체 실패 뒤 새 등록을 시작하지 않는다.
- 화면: [기기 연결](../src/features/device-binding/connection-manager.tsx)은 웹 승인 뒤 실제 기기 등록을 제한된 시간 동안 확인한다. 등록 뒤 AI 프로그램 선택이 자동으로 표시되며, Mac 폴더 승인 뒤 실제 모델·effort를 조회한다. 숨겨진 탭에서는 갱신 요청을 보내지 않는다.
- 검증: 실패를 재현한 뒤 단위·실제 DB/Auth 브라우저·Mac 터미널과 독립 리뷰2회를 통과했다. 첫 리뷰의 보관 실패 검사 지적을 보완했고 소스 동일성을 확인해 검토 결과를 재사용했다. 원래 실패 로그와 사용자의 프로필·임시 실행 파일·개인 설정은 보존한다. 상세 수치·실제 HTTP 배포 파일 확인·실제 AI 입력0·미확정 시간 제한 이력은 [검증 정본](planning/delivery-and-validation.md#기기-연결-실패와-ai-설정-표시-보정)을 따른다.


## 2026-10-09 모델 표시 이름 누락과 이름 변경의 설정 거절

- 현상: Claude/Codex가 제공한 모델 표시 이름이 연결기에서 사라져 웹에 실행 값만 보였다. 표시 이름을 보존하더라도 폴더 선택과 적용 사이 이름이 바뀌면 전체 목록 비교가 같은 실행 설정을 거절했다.
- 수정: [설정 계약](../src/features/runtime-settings/contracts.ts)은 선택적 `displayName`을 검증하고 의미 hash에서 이 필드만 제외한다. native adapter는 안전한 이름을 보존하고 [설정 관리자](../packages/local-connector/src/settings/manager.ts)는 별도로 검증한 두 카탈로그의 의미 hash를 비교한다. 모델·ID·effort·기본값은 유지한다.
- 화면: [AI 설정](../src/features/runtime-settings/runtime-settings-form.tsx)은 확인한 목록의 이름과 실행 값을 함께 표시한다. 선택값은 원래 실행 값이며, 다른 runtime·snapshot의 이름을 요청·적용 정보에 붙이지 않는다. 없는 이름은 실행 값으로 표시한다. 최신 버전을 임의로 하드코딩하지 않는다.
- DB·용량: 후속 SQL017은 기존 함수만 교체한다. 이름이 전체 응답 상한을 넘길 수 있으면 이름만 생략하며 모델 목록은 자르지 않는다. 기존 저장 JSON·권한·함수 속성과 원래 상한을 유지한다.
- 검증: 누락·hash·화면·이름 변경의 실패를 먼저 재현하고 보정했다. 이전 기록의 읽기·쓰기, 의미 변경 거절, 실제 PostgreSQL의 문자·hash·반복 적용과 함수 속성, 실제 HTTP 응답의 상한을 확인했다. 실행 결과와 독립 리뷰 범위는 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태)에 유지한다.
