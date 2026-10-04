# 프로젝트 작업 지침

## 포맷

- 커밋 전에 프로젝트 루트에서 `npm run format`과 `npm run format:check`를 실행한다.
- 기능 변경과 포맷 변경은 별도 커밋으로 분리한다.

## 문서 위치

- 문서 탐색은 [docs/README.md](docs/README.md)에서 시작한다. second-brain 표준 문서 `PRD.md`, `ARCHITECTURE.md`, `BUSINESS-LOGIC.md`, `FRONTEND-ARCHITECTURE.md`, `DB-SCHEMA.md`, `API-SPEC.md`, `GLOSSARY.md`, `ADR.md`, `BUG-FIXES.md`는 `docs/` 바로 아래에 유지한다.
- 보조 문서만 폴더로 묶는다. 사용 안내·제약은 `docs/guides/`, AI 조사·출처는 `docs/research/`, 개발 현황·미결 사항·브랜치 운영은 `docs/planning/`, 문서 정리 이력은 `docs/records/`에 둔다.
- 구현 계획은 기존 `docs/impl-spec/`에 두고 완료 계획은 `docs/impl-spec/archive/`에 보관한다. 현재 동작은 코드와 주제별 정본 문서로 확인한다.

## GitHub Flow

- 새 작업은 최신 `origin/main`에서 짧은 작업 브랜치로 시작하고 PR로 검토한다. `feat/`, `fix/`, `docs/`, `chore/` 접두사를 사용한다.
- 진행 중인 같은 작업은 해당 브랜치에서 이어간다. 서로 다른 작업을 미병합 브랜치에 계속 쌓지 않는다.
- `main` 병합은 사용자의 명시적 요청을 따른다. 검증한 작업 브랜치를 push하고 PR을 준비하는 것으로 병합 승인을 대신하지 않는다.
- 완료 브랜치는 변경이 `main`에 포함된 것을 확인한 뒤 정리한다. 현재 누적 작업의 일회성 전환은 [GitHub Flow 운영](docs/planning/github-flow.md)을 따른다.
