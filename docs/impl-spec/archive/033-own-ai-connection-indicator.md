---
status: done
date: 2026-10-12
risk-surface: permission
---
> NOTE: This is the plan, not a description of the code — never read it as evidence of current code state. While `status: active`, edit it in place as the plan changes; once archived it is frozen.

# 어디서든 보이는 내 AI 연결 표시

## Context

사용자는 내 로컬 AI의 연결 상태를 초록불·빨간불로 한눈에 확인하고 자동 갱신은 추가하지 말아 달라고 요청했다. 현재 채팅 탐색에는 설정 링크만 있고, 기기 등록과 수신 기록을 현재 연결로 해석할 수 없다. 기준 소스는 `e014f6d`다.

초록불은 **본인 PC 연결 프로그램과 최근 통신을 확인했다**는 뜻이다. 답변 준비·입력 일시정지와 분리한다. 답변 중이거나 입력이 일시정지돼도 연결 통신이 있으면 초록이다. 기존 `reportedReady`를 연결 자체로 해석하지 않는다. 등록만 된 기기를 초록으로 표시하지 않는다.

입장 후 `/app`, `/app/rooms/[roomId]`, `/app/connections`에서 같은 상단 표시를 제공한다. 마지막 조회 시각을 표시하고 사람이 누르는 ‘다시 확인’을 제공한다. 이 기능에 주기 조회·Realtime·경로 변경 감지에 따른 자동 새로고침을 추가하지 않는다. 현재 화면의 승인·기기 변경에서 발생하는 기존 `router.refresh()`는 유지한다.

**구현 시작 조건:** 운영 코드 7개를 바꾸므로 사용자가 이 계획을 승인한 뒤에만 운영 코드를 수정한다. 2026-10-12 사용자가 “만들어진 계획 끝까지 진행해줘”로 승인했다. 계획·PR의 검토 통과는 사용자 승인을 대신하지 않는다. 병합은 사용자가 앞서 요청한 “브랜치는 개발 완료된거 main에 잘 합치고”를 재사용하며, 관련 검증과 독립 리뷰를 통과한 PR의 정확한 head만 정상 병합한다. 기존 승인과 [GitHub Flow 운영](../../planning/github-flow.md)을 따른다.

## Affected Files

운영 코드 7개다. 기존 DB·공개 API·인증·개인 설정·AI 실행 정책은 변경하지 않는다.

1. `packages/local-connector/src/settings/connection-heartbeat.ts` — 생존 통신의 간격·단일 요청·중단과 대기 수명.
2. `packages/local-connector/src/settings/manager.ts` — 승인된 기기 관리 수명 안에서 생존 통신 시작·종료.
3. `packages/local-connector/src/cli.ts` — 기존 `CentralClient.call('heartbeat', {}, credential)`을 사용하는 쓰기 없는 통신 callback 전달. 수동 `Connector.heartbeat()`는 유지.
4. `src/features/device-binding/connection-presence.ts` — 기기별 연결 판정과 표시용 본인 상태 요약.
5. `src/features/device-binding/owned-connection-status.tsx` — 기존 요청별 세션과 `ownedConnections()`로 상태 조회. 서버 전용.
6. `src/features/device-binding/connection-status-bar.tsx` — 색·텍스트·기기별 상세·마지막 조회·직접 다시 확인. 조회 timer 없음.
7. `src/app/app/layout.tsx` — 공통 표시와 화면 높이·스크롤 배치. 로그인·모의 화면에는 본인 정보를 표시하지 않음.

검사 파일: 새 heartbeat·연결 판정·서버 조회·표시 단위 검사, 기존 `runtime-settings.test.ts`, `cli-settings.test.ts`, `device-workspace-binding.spec.ts`의 관련 검사를 추가한다. 필요하면 기존 소유 browser fixture의 고정 heartbeat 동작만 재사용한다.

## Affected Dependents

- `src/app/app/page.tsx`, `src/app/app/rooms/[roomId]/page.tsx`, `src/app/app/connections/page.tsx` — 같은 입장 후 layout을 사용하며 기존 접근·오류 처리를 유지한다.
- `src/features/room-access/chat-shell.tsx`, `src/features/room-access/access.module.css` — 채팅의 `h-dvh`와 연결 화면의 문서 스크롤을 새 wrapper 안에서 유지한다. 불필요하게 수정하지 않는다.
- `src/features/device-binding/service.ts:60`와 `contracts.ts:186` — 본인 목록·프로젝션을 그대로 재사용한다. 다른 사용자 ID·관리자 키를 요청하지 않는다.
- `packages/local-connector/src/cli.ts:382`, `central-client.ts:45` — 기존 heartbeat 계약과 10초 요청 제한을 유지한다.
- `SettingsManager` 생성자·`run()`의 CLI 및 `runtime-settings.test.ts` 소비자 — 새 callback은 선택적이고 기존 once 실행은 보존한다.
- `RoomChatController`·`SettingsController`·`OwnInputControls` — 채팅·설정·일시정지 polling을 이 표시와 결합하지 않는다.
- 명령 한 번 연결의 배포 산출물 — 원본 bootstrap·내용 해시 검사를 유지하고 새 빌드의 연결 코드에 생존 통신을 포함한다.

## Implementation Steps

### [x] Step 1: 기기 관리 수명에 생존 통신 연결

**File**: `settings/connection-heartbeat.ts`, `settings/manager.ts`, `cli.ts`

- 기존 heartbeat는 CLI의 수동 명령이다. manager의 장기 수명에서 초기 1회와 이후 30초 간격으로 기존 호출을 사용한다. 웹 상태의 자동 갱신과 구분한다.
- 통신은 AI·폴더·사용자 확인과 독립적으로 진행해 답변·긴 폴더 확인·일시정지 동안 유지한다. 실제 AI 입력이나 새 세션은 만들지 않는다.
- 같은 reporter의 요청은 1개만 진행한다. 실패 뒤 즉시 재시도하지 않고 다음 간격까지 기다린다. 비밀·원문 오류를 기록하지 않는다.
- 옵션 callback이 없거나 `once` 실행이면 기존 동작을 유지한다. 이미 중단된 signal로는 시작하지 않는다.
- manager의 기존 `connected()`로 기기·인증·만료·서버·본인 scope를 검증하고 현재 credential의 snapshot을 얻는다. 이 조회와 네트워크 통신은 `StateStore.transaction` 밖에서 한다. 공유 프로필 잠금을 잡은 채 네트워크를 기다리지 않는다.
- CLI의 선택적 callback은 전달받은 credential로 기존 `CentralClient.call('heartbeat', {}, credential)`만 호출한다. 배경 callback은 프로필을 쓰지 않으며 인증 오류도 로컬 상태·credential에 반영하지 않는다. 기존 설정·runner의 인증/권한 오류 처리와 수동 `Connector.heartbeat()`의 동작은 유지한다. 늦은 옛 credential의 오류가 새 프로필을 disconnected로 만들 수 없다.
- reporter의 소유 signal을 callback에 전달하고 프로필 조회 뒤에도 중단을 다시 확인한다. 새 네트워크 요청 직전에 signal을 확인하며 종료 중 추가 호출을 시작하지 않는다. 이미 진행 중인 요청은 기존 10초 제한 안에서 끝날 때까지 대기한다.
- manager의 기기 잠금 획득·본인 연결 검증 뒤 시작한다. 종료 시 새 호출과 timer를 차단하고 진행 중인 소유 요청을 대기한다. 기존 10초 요청 상한을 재사용한다. runner·adapter의 종료 실패는 생존 통신 정리로 덮어쓰지 않는다.

### [x] Step 2: 한 번 조회한 본인 연결 상태 판정

**File**: `connection-presence.ts`, `owned-connection-status.tsx`

- 기존 요청별 `requestClient()`와 owner-only `ownedConnections()`를 한 번 사용한다. workflow·모델 설정 조회와 새 API·DB migration은 필요하지 않다.
- 활성 기기 중 인증이 유효하고 마지막 통신이 조회 시각의 **90초 미만**일 때 초록이다. 미래 시각의 허용 차이는 최대 5초다. 유효하지 않은 시각은 초록으로 처리하지 않는다.
- 활성 등록 없음·인증 만료·통신 없음·오래된 통신은 빨강 ‘연결 확인 안 됨’이다. 과거 취소·제거 기기는 현재 연결 개수에서 제외한다. 조회 실패는 중립색 ‘확인 불가’로 구분한다.
- 본인 기기마다 이름과 연결한 방, 색과 짧은 이유를 구분한다. 여러 기기를 단일 ‘모두 연결됨’으로 요약하지 않는다. 상세의 표시 행은 제한하고 전체 개수와 연결 관리 링크를 제공한다.
- 조회 시각과 마지막 통신 시각은 별개다. 연결 종료가 즉시 감지되는 것으로 표현하지 않는다. 마지막 보고의 90초 유효 범위와 화면의 마지막 조회를 설명한다.
- 클라이언트에는 표시에 필요한 별칭·시각·상태만 전달한다. 기기 ID·인증 정보·실제 경로·설정 원문·Supabase client를 넘기지 않는다. 오류 원문도 넘기지 않는다.
- 세션·권한·서비스 오류는 기존 페이지의 인증 처리나 사용자 신원을 변경하지 않고 중립 상태로 표시한다.

### [x] Step 3: 입장 후 모든 화면의 공통 표시

**File**: `layout.tsx`, `connection-status-bar.tsx`

- 공통 상단에 초록·빨간 점과 텍스트를 항상 배치한다. 상세에서 본인 기기·방별 상태를 확인하고 연결 관리로 이동한다. 색만으로 상태를 전달하지 않는다.
- 마지막 조회 시각을 보여 준다. 서버가 표시용 시각을 정하거나 명시적 시간대를 사용해 hydration 시각 차이를 피한다.
- ‘다시 확인’은 사람의 클릭에서만 `router.refresh()`를 호출한다. timer·마운트 effect·pathname effect·자동 재시도를 추가하지 않는다. 일반 화면 이동에서는 마지막 조회 결과를 유지해도 되며 시각을 숨기지 않는다.
- 공유 layout은 페이지 이동 시 상태와 채팅 입력을 불필요하게 다시 마운트하지 않는다. Next의 layout 재사용·직접 refresh 동작은 실제 브라우저에서 확인한다.
- layout의 전체 높이를 `h-dvh` flex column으로 만들고 상단은 `shrink-0`, 본문은 `min-h-0 flex-1 overflow-y-auto`로 나눈다. 본문 wrapper의 직접 `main`에 `h-full`·`min-height: 0`을 적용해 ChatShell의 자체 `h-dvh`를 남은 높이로 제한한다. 채팅 내부의 스크롤은 원래 대화가 소유하고 긴 연결 문서의 스크롤은 본문 wrapper가 소유한다. 기존 ChatShell·공유 CSS의 광범위 수정은 하지 않는다.
- 모바일·desktop에서 하단 채팅 입력과 전송 버튼의 실제 가시성·긴 설정 끝까지 스크롤·가로 넘침 없음과, 직접 refresh 및 조회 실패 전후의 채팅 초안 보존을 확인한다.
- 상태 조회가 느리거나 실패해도 기존 화면이 불필요하게 차단되지 않도록 loading/오류 경계를 둔다.

### [x] Step 4: 관련 검증·문서·종료

**File**: 검사 파일, `docs/FRONTEND-ARCHITECTURE.md`, `docs/ARCHITECTURE.md`, `docs/guides/onboarding-and-settings.md`, `docs/planning/delivery-and-validation.md`

- 아래 검사를 완료하고 독립 reviewer로 전체 변경·종료 수명·본인 정보 경계·화면 상태를 검토한다. 실제 AI 입력은0이다.
- 정본에는 연결 통신과 답변 준비의 차이, 색과 마지막 조회의 의미, 수동 재확인, 기존 연결 코드의 업데이트 방법을 설명한다. 진행 수치는 검증 정본 한 곳에 기록한다.
- 이미 실행 중인 예전 연결 코드를 자동으로 종료하거나 교체하지 않는다. 새 통신 표시가 필요하면 사용자가 기존 연결 명령을 종료하고 웹의 새 명령을 다시 실행하도록 안내한다. 로그인·개인 설정·등록을 초기화하지 않는다.
- 관련 검사·독립 리뷰·정본 갱신을 마친 뒤 계획을 archive로 옮기고 논리 단위로 커밋한다. 기존 프로젝트의 병합·배포 승인을 적용하되 검토하지 않은 소스를 main에 직접 push하지 않는다.

## Tests

- `should report connection presence without creating an AI input` — 관리 수명의 첫 통신과 다음 간격, provider·세션 호출0.
- `should keep reporting while settings confirmation or an answer is pending` — 설정·runner 지연이 생존 통신을 차단하지 않음.
- `should serialize reports and stop before releasing the device lock` — 느린 호출·중단·대기와 잠금 해제 순서, 중단 후 추가 호출0.
- `should keep runner profile transactions available during a slow heartbeat` — 2초보다 긴 합성 heartbeat가 진행되는 동안 같은 프로필의 실제 runner 조회·권한 갱신 transaction이 계속되고 중단되지 않음.
- `should ignore a late heartbeat authentication failure after credential replacement` — profile credential을 교체한 뒤 옛 요청의 인증 오류가 도착해도 새 프로필과 credential을 변경하지 않음.
- `should preserve once mode and wait after a failed report` — 기존 once·callback 없음과 실패의 간격, 오류 비밀 비노출.
- `should mark only a current authenticated recent device green` — 90초 경계·5초 미래 허용·만료·null·잘못된 시각·취소·제거·혼합 기기.
- `should project only the owned connection snapshot and fail closed` — 한 번의 기존 RPC, 다른 사용자 지정 없음, 표시용 값만 전달, 조회 실패의 중립 상태·기존 세션 보존.
- `should refresh only after an explicit status action` — 시간 경과·일반 렌더링으로 새 요청 없음, 사람이 누르는 재확인만 실행, 색과 텍스트·확인 시각·상세의 일치.
- desktop/mobile의 실제 browser — 세 경로의 표시·본인과 다른 참가자의 격리·새 보고 뒤 직접 재확인·일반 이동의 snapshot·로그아웃 후 다른 사람의 이전 값 비노출·채팅 입력과 긴 설정 화면의 스크롤·가로 넘침 없음.

기존 기기 RPC의 소유권·철회·heartbeat 검증은 동일 SQL·계약을 유지하는 범위에서 재사용한다. 원격 실제 두 Mac·AI 입력은 이 표시 기능의 검사에 포함하지 않는다.

## Risks

- 녹색은 조회한 시점의 최근 통신 증거다. 갑작스러운 종료는 마지막 통신의 90초 범위와 직접 재확인 뒤에 드러난다. ‘현재 답변 가능’으로 표시하지 않는다.
- 과거 연결 프로그램에는 지속적인 heartbeat가 없다. 최근 통신이 확인되지 않으면 연결을 단정하지 않고 ‘연결 확인 안 됨’을 표시한다. 새 명령 재실행은 본인이 수행하며 기존 프로필을 유지한다.
- reporter가 프로필 쓰기나 설정/실행 종료를 경쟁하면 저장·잠금의 경계가 바뀔 수 있다. 배경 통신은 프로필을 쓰지 않고 네트워크 동안 프로필 잠금을 잡지 않는다. 소유 기기 잠금·단일 요청·종료 대기와 지연된 인증 오류 회귀로 고정한다.
- owner-only 데이터와 오류 원문이 UI에 과도하게 전달될 수 있다. 기존 RPC와 최소 projection을 사용하고 다른 사용자의 연결·클라이언트·인증 값은 노출하지 않는다.
- 공유 layout의 높이나 캐시가 채팅을 손상시킬 수 있다. 동일 입력·페이지 이동과 desktop/mobile을 실제 렌더링으로 확인한다.

## Verification

- 새/영향받은 connector 단위 검사, 연결기 typecheck·build·기존 관련 전체 검사.
- 웹 `npm test`, lint·typecheck·production 및 연결 코드 distribution build. 원래 웹과 `next-env.d.ts`를 보존하도록 별도 검증 사본에서 빌드한다.
- 기존 소유 Auth/기기 browser fixture의 관련 desktop/mobile 검사. 새 DB reset·운영 데이터·실제 AI 호출 없이 수행한다.
- 커밋 전 `npm run format`, `npm run format:check`, task diff·문서 링크·민감 값 비노출 검사.
- 계획과 구현의 새 독립 reviewer PASS. 동일 소스·SQL·계약의 검증은 hash 일치 범위에서 재사용한다.
- 승인된 PR의 정상 main 병합·작업 브랜치 정리 후 Vercel 자동 배포와 공개 주소·연결 파일 내용을 확인한다. 정확한 private 배포 설정과 기존 Production 환경을 재사용한다.

## Review Notes

2026-10-12 새 독립 reviewer의 2회차 계획 검토는 ACCEPTED(C0/H0/M0/L0/INFO0)다. 1회차의 HIGH 1개·MEDIUM 2개를 아래와 같이 보정했다. 같은 날 사용자가 계획 구현을 승인했다. 구현·검증 결과와 남은 종료 절차는 아래에 기록한다.

Step1–3의 운영7개·관련 검사6개를 구현했다. 웹435/435·최신 연결기 전체919/919·기기 browser desktop/mobile8/8과 타입·production/distribution 빌드·lint를 통과했다. 입력/버튼·설정 끝 스크롤·직접 조회와 중립 표시 전후의 초안·사용자별 격리·로그아웃/새 입장/뒤로가기를 실제 화면에서 확인했다. 익명 경로의307도 유지했다. 실제 AI 입력0이며, 사용자 웹·프로필·next-env·기존 Docker는 보존했다. 기능 PR11을 정상 main 병합하고 Production READY·sin1·공개 경로/연결 파일7건을 확인했다. 이 계획은 정본 갱신 후 보관했다.

독립 구현 검토1회차는 C0/H2다. 제목 부재 지적은 `connection-manager.tsx`의 실제 `h2`를 근거로 기각하되 페이지 도착 선택자는 `h1`로 좁혔다. 상단 링크로 문서 끝을 검사한 지적은 수용해 실제 마지막 링크·viewport·본문 끝을 확인했다. 일반 사용자 이동의 시각 고정은 계약이 아니므로 본인 정보·유효 시각을 검증하고 안정된 화면의120초 자동 갱신 금지·명시적 조회 검사는 유지했다. 후속 새 reviewer는 변경 없는 운영·단위·구조/사용 정본의 검토를 재사용하고 browser 보정을 추가 확인해 ACCEPTED(C0/H0/M0/L0/INFO0)로 통과했다. 미해결 지적은 없다.

최초 실패와 재검사·합성 중립 표시의 범위·검증 실행 순서 보정은 [검증 정본](../../planning/delivery-and-validation.md#어디서든-보이는-본인-pc-연결-표시)에 유지한다. 코드·기대값·시간 제한을 바꿔 기존 연결기 간헐 실패를 숨기지 않았다.

범위 조사자는 기존 준비 조회의 연결 의미 차이·통신 기록의 수동 갱신·이력/설정 조회의 부수 효과·복수 기기 대응과 화면 높이·기존 refresh를 확인했다. 이 계획은 기존 heartbeat와 본인 기기 목록만 사용해 불필요한 조회를 피한다.

기준 공식 자료: [Next layout 재사용](https://nextjs.org/docs/app/getting-started/layouts-and-pages), [직접 router.refresh](https://nextjs.org/docs/app/api-reference/functions/use-router). 코드와 실제 브라우저 결과를 최종 근거로 사용한다.

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 배경 통신이 프로필 잠금을 10초 점유해 runner의 2초 대기와 충돌 | HIGH | ACCEPTED | 네트워크를 잠금 밖에서 수행하고 배경 callback의 프로필 쓰기를 없앴다. 기존 manager의 connected 검증과 CentralClient의 통신만 재사용한다. 느린 통신과 늦은 인증 오류 회귀를 명시했다. |
| 공유 높이 적용 방식과 초안·긴 문서 검사가 미정 | MEDIUM | ACCEPTED | layout의 남은 높이·main override와 본문 스크롤 소유를 구체화하고 하단 입력·수동 refresh·조회 실패 전후의 초안 검사까지 명시했다. |
| 사용자 계획 승인과 PR 검토·병합 승인의 구분 | MEDIUM | ACCEPTED IN PART | 운영 코드 변경 전 사용자 계획 승인을 명시했다. 병합 권한이 없다는 해석은 이전 사용자의 명시적 “브랜치는 개발 완료된거 main에 잘 합치고” 요청과 기존 GitHub Flow 운영 기록을 근거로 기각한다. 검증·리뷰와 사용자 승인은 분리하며 기존 승인을 재사용한다. |
| 기존 승인 대기 refresh와 본인 정보 최소 projection | INFO | ACCEPTED | 기존 refresh는 유지하며 새로운 자동 조회로 취급하지 않는다. 본인 표시값만 전달하고 로그아웃·다른 사람 입장·뒤로가기를 browser 검사에 유지한다. |

2026-10-12 종료: [PR11](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/11)의 정확한 검토 head를 정상 병합했고, main `5e241bf`의 자동 Production 배포·READY·sin1·공개 alias를 확인했다. 공개7건 검사에서 새 생존 통신을 포함한 연결 파일의 manifest/hash를 검증했다. macOS와 Linux gzip의 OS 구분 바이트만 다르며 압축 해제한 tar 전체는 검증 빌드와 동일하다. 소스 작업 브랜치는 main 포함을 확인한 뒤 원격/로컬에서 정리했다. 별도 문서 종료 PR은 코드·계약을 바꾸지 않으며 기존 검증·리뷰를 재사용한다. 실제 두 Mac의 질문 왕복은 이 계획의 완료 조건이 아닌 별도 현장 수용으로 남는다.
