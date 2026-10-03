---
status: active
date: 2026-10-03
risk-surface: none
---
> NOTE: 구현 계획이다. 현재 코드의 증거가 아니다. 완료 보관 문서와 적용된 migration은 변경하지 않는다.

# 압축된 코드 형식 정리와 포맷 검사

## Context

사용자가 긴 한 줄과 큰 함수의 유지보수 문제를 지적했다. 중간 독립 감사에서도 API route·클라이언트·실행기의 분기와 오류 처리가 한 줄에 압축된 상태를 확인했다. 구조 전체를 다시 만들지 않고 코드 형식을 먼저 정리한다. 함수 분리·HTTP 중복 제거·오류 계층 변경은 별도의 작은 후속 구현으로 진행한다.

[진행 상태](../delivery-and-validation.md#현재-진행-상태)를 정본으로 유지한다. [실행 기록 용량 보정](archive/011-local-runtime-capacity-safety.md)의 쓰기·수용 검증·독립 리뷰를 마친 뒤 고정한 기능 소스를 포맷한다. 해당 워커가 쓰는 동안 같은 파일을 포맷하지 않는다. Claude 실제 호환성의 검증 코드는 별도 입력 범위 안에서 병행한다.

이 변경은 동작·계약·권한·데이터 구조가 유지되는 기계적 포맷과 개발 도구 도입이다. 운영 파일 수의 기계적 변경 예외를 적용하며 필수 검사·독립 리뷰는 유지한다. 의미 보존 검사가 실패하면 기계적 변경으로 종료하지 않고 해당 차이를 해소한다. 기존 인증·권한·공개 계약의 동작을 바꾸지 않으며 새 프로젝트 AGENTS는 control-plane 독립 리뷰 대상이다.

## Affected Files

1. `package.json`, `package-lock.json` — root devDependency에 Prettier `3.9.9`를 정확한 버전으로 추가하고 `format`, `format:check` 명령을 추가한다. 기존 의존성 버전과 기능 명령은 유지한다.
2. 신규 `.prettierrc.json`, `.prettierignore` — root 설정과 보호 경로를 고정한다.
3. 신규 `AGENTS.md` — 프로젝트에서 커밋 전 `npm run format`과 `npm run format:check`를 실행하는 지침만 추가한다. 개인 전역 지침을 복제하거나 변경하지 않는다. 독립 control-plane 리뷰와 실제 diff 공개를 수행한다.
4. `src/**/*.{ts,tsx,css}`, `packages/local-connector/src/**/*.ts`, `tests/**/*.ts`, `packages/local-connector/tests/**/*.{ts,mjs}`, `scripts/**/*.mjs` — 고정 inventory의 코드 형식만 정리한다. 실행 가능한 mock은 코드로 검사하되 원문 JSON fixture는 제외한다.
5. root `next.config.ts`, `playwright*.config.ts`, `eslint.config.mjs`, `tsconfig*.json`, connector `package.json`·`tsconfig.json` — 동일한 설정으로 기계적 포맷한다. connector에 formatter 의존성이나 workspace를 추가하지 않는다.

`README.md`와 이력 수치는 포맷 대상에서 제외한다. root 사용 명령 안내와 진행 정본의 해당 절만 기능 변경과 분리해 갱신한다.

## Affected Dependents

- root·connector의 타입·lint·unit·build, root 통합 컴파일과 CLI `dist/src/cli.js` — 기존 실행 명령과 import 경로를 유지한다.
- 웹의 사람·기기·조사 route, cookie 인증, local file·native transport·journal — 변경 전 AST와 실행 문자열을 비교하며 동작을 바꾸지 않는다.
- 두 계약 mirror — web/device ↔ connector/contracts, web/workflow ↔ connector/workflow-contracts를 같은 설정으로 포맷한다. 기존 workflow byte-parity 검사와 두 쌍의 바이트 비교를 유지한다.
- desktop/mobile의 prototype·Auth·기기·조사 화면 — JSX 공백과 CSS selector/값/선언 순서가 표시·입력·접근성에 영향을 주지 않아야 한다.
- 적용된 SQL001–008, 모든 완료 명세, Claude 실험·private 검증 증거 — hash를 동결하고 포맷에서 제외한다.

## Implementation Steps

### [ ] Step 1: 고정 기준점과 포맷 도구
**File**: root package·lock, 신규 formatter 설정·프로젝트 AGENTS

- 기능 변경을 논리별 검증된 로컬 커밋으로 기록한 뒤 포맷만 있는 커밋을 만든다. 기존 index에는 007 보관 rename이 있으므로 먼저 inventory를 확인한다. 다른 기여자의 변경을 임의로 포함하거나 되돌리지 않는다. 원격 push·병합은 수행하지 않는다.
- Node 24에서 Prettier `3.9.9`를 root에 설치한다. 공식 설치 문서와 npm registry의 버전·integrity를 확인했다. lock diff에서 기존 의존성 갱신이 없는지 검사한다.
- `.prettierrc.json`은 `printWidth:100`과 `trailingComma:all`을 사용한다. 나머지는 고정 버전 기본값이다. formatter plugin·Husky·개인 editor 설정·전역 hook은 설치하지 않는다.
- 명령은 위 명시한 코드·설정 집합만 선택한다. `.prettierignore`는 `supabase/**`, `docs/**`, `README.md`, `experiments/**`, `tests/fixtures/**`, `**/node_modules/**`, `**/dist/**`, `.next/**`, `.test-build/**`, `.integration-build/**`, `.workflow-artifacts/**`, `test-results/**`, `playwright-report/**`, `**/*.tsbuildinfo`, `next-env.d.ts`와 lockfile 자동 포맷을 제외한다. `package-lock.json`의 의존성 추가는 별도 변경이다.
- 최소 프로젝트 AGENTS는 커밋 전 두 포맷 명령과 기능 변경·포맷 변경 분리만 명시한다. 기존 전역 규칙을 다시 정의하지 않는다.

### [ ] Step 2: 의미를 유지한 기계적 포맷
**File**: 고정 코드 inventory

- 대상 파일과 보호 파일의 포맷 전 원문·hash를 private scratch snapshot에 보존한다. 작성 중인 파일이나 생성물을 inventory에 넣지 않는다.
- `npm run format`을 한 번 적용한다. `format:check`가 통과하고 두 계약 mirror가 같은 바이트인지 확인한다.
- 일회성 검증 도구에서 TS/TSX/MJS의 위치·서식·불필요한 괄호를 제외한 AST와 문자열/정규식/template 원문 의미를 비교한다. directive·연산자·import/export·optional/type 조건을 유지한다. JSX는 같은 TypeScript JSX 변환 뒤 생성되는 텍스트·props·자식 순서를 비교한다.
- 설정 JSON의 파싱 값은 같은지 확인한다. package/lock의 허용 차이는 formatter 의존성과 두 명령뿐이다. CSS는 parser로 selector·값·important·선언/규칙 순서를 비교하고 화면 검사로 실제 표시를 확인한다. 일반 공백 제거로 CSS selector 의미를 비교하지 않는다.
- 보호 SQL·완료 문서·원문 fixture·실험 파일은 변경 전 hash와 일치해야 한다. 검증 도구는 이 포맷 단계의 일회성 증거로 유지하며 문구를 그대로 확인하는 영구 unit test는 추가하지 않는다.

### [ ] Step 3: 검사·독립 리뷰·기록
**File**: 해당 코드, AGENTS, 진행 정본

- Node 24에서 root·connector 타입, root·connector unit, root lint, 두 build와 통합 컴파일을 수행한다. 포맷으로 생긴 실패를 수정하고 형식이 다시 깨지지 않게 `format:check`를 수행한다.
- 웹 JSX/CSS의 영향을 받는 prototype/Auth/device/workflow desktop/mobile 검사를 소유 환경에서 확인한다. DB fixture는 직렬 실행하고 실제 AI 입력을 만들지 않는다.
- 독립 reviewer가 포맷 외 변경 여부, 입력/권한/프로토콜 문자열과 mirror·보호 파일·새 AGENTS를 검토한다. 유효한 기존 기능 리뷰는 의미·설정·입력이 같은 범위에서만 재사용하고 재사용 근거를 보고한다.
- 기능 변경과 포맷 변경을 Git diff에서 구분한다. 포맷 전 기능 커밋을 기준으로 포맷만 있는 커밋을 남기고 새 지침의 diff를 공개한다. 상태·검사 수치는 진행 정본 한 곳에 유지하고 전체 후속 구현 완료로 확대하지 않는다.
- 모든 단계·필수 검사·리뷰를 마친 뒤 이 명세를 완료 보관한다. 다음 실제 구현은 큰 함수의 책임 분리와 HTTP 내부 정책 공유이며, 현재 형식 정리로 그 작업을 대신했다고 표시하지 않는다.

## Tests

none needed — 신규 제품 동작이 없으므로 형식을 그대로 확인하는 unit test는 추가하지 않는다. 위험 표면의 기존 동작 검사는 아래 Verification에서 전부 사용한다. 일회성 의미 비교·보호 hash·mirror 증거는 포맷의 기계적 변경 전제를 입증한다.

## Risks

- 미완료 기능 diff와 포맷 diff가 섞이면 검토가 어려워진다. 기능 기준점과 별도 커밋을 먼저 확보한다.
- JSX/CSS의 공백과 텍스트는 의미가 있을 수 있다. 변환 결과·parser·실제 desktop/mobile 검사를 함께 사용한다.
- 완료 명세와 적용된 SQL은 서식도 동결 기록이다. glob과 ignore·hash 검사로 보호한다.
- 의존성 추가가 다른 라이브러리를 갱신하거나 지침이 권한을 넓히지 않아야 한다. diff와 독립 리뷰로 확인한다.

## Verification

- `npm run format`, `npm run format:check`.
- Node 24 root `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Node 24 `npm --prefix packages/local-connector run typecheck`, `test`, `run build`; root integration compile.
- 기존 소유 local stack과 browser fixture의 prototype/Auth/device/workflow desktop/mobile 검사. 실제 모델 입력 0회.
- 고정 snapshot 전후 의미 비교, 두 계약 mirror byte parity, 보호 hash, `git diff --check`, 새 control-plane 및 기계적 변경 독립 리뷰.

## Review Notes

| Finding | Severity | Disposition | Rationale |
|---------|----------|-------------|-----------|
| 사용자 유지보수 지적: 압축된 코드 형식 | HIGH | ACCEPTED — CORRECTION PLANNED | formatter 도입·기계적 형식 정리를 기능 변경과 분리한다. 큰 책임 분리와 HTTP 중복 제거는 후속 실제 구현으로 유지한다. |
| Independent plan round1 | INFO | PASS | C0/H0/M0/L0. 기능/포맷 분리·보호 경로·의미 보존·기존 검사·신규 지침 리뷰의 계획을 확인했다. 실제 포맷이나 AGENTS 적용의 완료 판정은 아니다. |
