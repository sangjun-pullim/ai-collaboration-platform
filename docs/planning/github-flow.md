# GitHub Flow 운영

`main`과 짧은 작업 브랜치를 사용하는 [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)를 따른다. 별도 장기 개발·릴리스 브랜치는 두지 않는다. `main`은 검토와 관련 검증을 마친 변경의 기준이며 전체 제품 출시 완료와는 구분한다.

## 일반 작업

1. 로컬 에이전트가 프로젝트에서 `git fetch --prune origin`을 실행한다. 원격 기준과 삭제된 브랜치 정보를 갱신한다.
2. 로컬 에이전트가 최신 `origin/main`에서 `feat/<작업>`, `fix/<작업>`, `docs/<작업>`, `chore/<작업>` 브랜치를 만든다. 하나의 작업을 하나의 브랜치로 검토한다.
3. 로컬 에이전트가 구현·관련 검증·필수 독립 리뷰를 완료한다. 진행 중인 같은 작업의 보정은 같은 브랜치에서 이어간다.
4. 로컬 에이전트가 논리 단위로 커밋한다. 커밋 전 프로젝트 루트에서 `npm run format`, `npm run format:check`를 통과시킨다.
5. 로컬 에이전트가 작업 브랜치를 origin으로 push한다. 변경을 원격에 보존한다.
6. 로컬 에이전트가 `main` 대상 PR을 만든다. 문제·변경·검증·남은 범위를 설명하고 준비 중인 변경은 draft로 표시한다.
7. 로컬 에이전트가 리뷰 지적을 보정하고 영향받은 검증을 다시 수행한다. 변경 없는 검증과 독립 리뷰는 입력 일치 범위에서 재사용한다.
8. 사용자가 준비된 PR의 병합을 명시적으로 요청한다. 이 요청 전 에이전트는 PR 병합·자동 병합·기본 브랜치 직접 push를 하지 않는다.
9. 병합 후 로컬 에이전트가 원격을 갱신하고 로컬 `main`을 fast-forward로 동기화한다. 병합된 변경을 다음 작업의 기준으로 사용한다.
10. 병합 후 로컬 에이전트가 커밋 포함 여부와 다른 worktree 사용 여부를 확인하고 완료 브랜치를 정리한다. 포함되지 않은 작업은 삭제하지 않는다.

문서 변경은 내부 링크·경로·상태와 지침의 독립 리뷰를 확인한다. 소스 변경은 해당 명세의 타입·lint·빌드·테스트를 확인하며 실제 AI·DB 통합의 결과와 격리된 검사를 구분한다. 필수 검사를 생략한 PR은 준비 완료로 표시하지 않는다. 이 문서는 별도 CI나 자동 배포를 설정했다는 뜻이 아니다.

## 누적 작업의 전환 결과

사용자는 “개발 완료된거 main에 잘 합치고”라고 요청했다. 기존 병합 승인을 재사용해 2026-10-08에 검토된 세 PR을 정상 merge commit으로 병합했다. 원래 커밋의 포함 관계를 보존했으며 `--admin`이나 강제 push는 사용하지 않았다.

| PR | 포함한 검토 tip | main의 병합 커밋 |
|---|---|---|
| [1 · 누적 구현](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/1) | `04db9d00e4e28f9733d61bade79758b8f9cb0760` | `a9d9ef8d65665734ed8dc33de7ce003b7fbb5c7e` |
| [2 · 문서 정리](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/2) | `88db6862b9e29f4fdce17d9c8f280e4b8e7ef555` | `2066e12612f48dcbcd260426f62b59db3d9e9329` |
| [3 · 채팅 화면과 회사 코드 입장](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/3) | `782c3b3cb33751934d4d62b656eeac42707e0802` | `7a26120b73cb4de88170d1aadb5368be1968d322` |

각 tip이 `origin/main`의 조상임을 확인했다. 완료된 `chore/implementation-baseline`, `docs/organize-project-docs`는 로컬·원격에서 정리했다. 이 전환 시점의 로컬 `main`과 `origin/main`은 세 번째 병합 커밋을 가리켰다. 최신 병합 상태는 아래 PR의 GitHub 기록으로 확인한다.

## 현재 작업 브랜치

로컬 AI 설정·Claude·폴더 탐색·자료 이력·명령 한 번 연결은 `feat/local-ai-chat-20261008`과 [PR4](https://github.com/sangjun-pullim/ai-collaboration-platform/pull/4)에서 검토한다. 검토된 main을 작업 브랜치에 병합한 커밋은 `671760ee264d64f0c7462ec37953bf7c2152dbb2`다. 이후 보정도 같은 작업 브랜치에 기록하고 필수 검사·리뷰 뒤 기존 사용자 승인으로 정상 병합한다. 실제 최신 open/draft/merged 상태와 병합 커밋은 PR의 GitHub 기록을 기준으로 확인한다. 완료된 세 PR의 고정 범위에 후속 변경을 추가하지 않았다.

`feat/chat-first-experience`의 로컬 tip에는 아직 main에 포함되지 않은 후속 변경이 있다. 이 브랜치는 포함 관계 확인 전까지 유지한다. `feat/team-code-entry`는 별도 worktree에서 사용 중이며 그곳의 사용자 변경을 보존한다. 다른 worktree나 미병합 tip을 현재 작업 정리의 대상으로 삭제하지 않는다.

PR4의 필수 검사·리뷰와 준비된 변경을 확인한 뒤 기존 사용자 요청에 따라 병합한다. 실제 Claude 수용, 두 Mac 검증과 제품 배포의 완료는 코드 병합과 별도로 판정한다. 병합한 현재 기능과 남은 수용은 [개발·검증 상태](delivery-and-validation.md#현재-진행-상태)에서 확인한다. 새 작업은 이 전환 작업을 끝낸 뒤 최신 `origin/main`에서 짧은 브랜치로 시작한다.

환경 전환 전의 Git·GitHub 접근 실패는 [과거 실행 기록](../records/verification-history-20261008.md#2026-10-08-goal-재개와-실행-환경-확인)에 남겼다. 현재 실행 환경에서는 정상 커밋·push·PR 생성·main 병합을 실제로 확인했다. GitHub Flow 전환이 Claude 입력 예산이나 UNKNOWN 실행의 재시도 제한을 변경하지는 않는다.
