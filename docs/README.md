# 문서 안내

제품을 이해하려면 [제품 요구사항](PRD.md), 현재 작업을 확인하려면 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태), 사용하려면 [첫 사용 설정](guides/onboarding-and-settings.md)을 먼저 읽는다.

| 폴더 | 찾을 내용 |
|---|---|
| `docs/` 바로 아래 | second-brain 표준 문서: 제품·구조·업무·DB·API·용어·결정·오류 |
| [guides/](guides) | 접속·설정·화면 사용 흐름과 제약 |
| [research/](research) | AI 연결 조사와 출처 |
| [planning/](planning) | 개발 현황·다음 작업·미결 사항·브랜치 운영 |
| [records/](records) | 문서 정리·과거 검증 이력 |
| [impl-spec/](impl-spec) | 구현 중·검증 대기·보류된 계획과 완료 기록. 상태 구분은 개발·검증 상태에서 확인 |

## 제품과 용어

- [제품 요구사항](PRD.md): 사용자, 기능 범위, 비목표, 성공 기준.
- [용어집](GLOSSARY.md): 문서와 코드에서 사용하는 이름.

## 구조와 동작

- [시스템 구조](ARCHITECTURE.md): 웹·중앙 서비스·로컬 연결 프로그램의 경계와 흐름.
- [업무 규칙](BUSINESS-LOGIC.md): 질문·답변·개입·복구의 상태와 불변 조건.
- [프론트엔드 구조](FRONTEND-ARCHITECTURE.md): 웹 화면, 상태, 라우팅과 검사 범위.
- [DB 설계](DB-SCHEMA.md): 데이터 모델, 권한과 저장 제약.
- [API 계약](API-SPEC.md): 웹·로컬 연결 프로그램의 요청, 응답과 오류.
- [제약과 보안](guides/constraints-and-security.md): 정보 공유, 권한, 운영·비용·환경 조건.

## 접속과 화면 사용

- [첫 사용 설정](guides/onboarding-and-settings.md): 로그인, 기기·저장소·AI 연결과 준비 상태.
- [화면과 상호작용](guides/interaction-design.md): 공동 대화, 개인 입력과 방향 수정의 사용 흐름.

## AI 연결 조사

- [AI 연동](research/ai-runtime-integration.md): Codex·Claude의 실행·맥락·인증 조건.
- [로컬 AI 연결 조사](research/local-ai-connection-research.md): 브라우저와 PC의 경계, 접속 방식과 실제 확인 범위.
- [출처](research/sources.md): 공식 자료와 확인일.

## 개발 현황과 계획

- [개발·검증 상태](planning/delivery-and-validation.md): 현재 진행 상태, 검증 근거와 다음 작업의 정본.
- [남아 있는 계획서의 상태](planning/delivery-and-validation.md#남아-있는-계획서를-읽는-기준): 소스 구현과 실제 검증 대기·새 구현 계획을 구분하는 목록.
- [다음 작업 순서](planning/delivery-and-validation.md#다음-작업-순서): 기존 계획을 닫을 검증 묶음과 후속 기능.
- [결정과 미결 항목](planning/decisions-and-open-items.md): 아직 확인하거나 선택해야 할 사항.
- [GitHub Flow 운영](planning/github-flow.md): 작업 브랜치, PR, 검토와 병합 후 정리.
- [AI 채팅방 화면 구현 기록](impl-spec/archive/020-chat-first-web-experience.md): 기본 채팅 화면과 shadcn/ui·Tailwind 전환을 완료하고 검증한 계획.
- [회사 코드 입장 구현 기록](impl-spec/archive/021-team-code-entry.md): 코드·표시 이름과 내부 소유권 보존을 완료하고 검증한 계획.
- [내 Mac의 AI 설정 계획](impl-spec/022-owner-local-ai-setup.md): 질문자 AI 없이 상대에게 질문하고, 답변 제공자가 폴더·Claude/Codex·모델·effort를 적용하는 단계. 기존 승인으로 구현 중이며 현재 검증과 미완료 범위는 개발·검증 상태를 따른다.
- [Claude 중단 복구 보정 계획](impl-spec/archive/023-claude-interrupt-recovery.md): 중단 증거의 내구 저장과 같은 입력 복구 오류를 보정하는 계획. 전체 AI 설정 단계를 대체하지 않는다.
- [Claude 실행 정책·이력 연결 기록](impl-spec/archive/024-claude-native-policy-and-history.md): 실행 생성 지점의 정책·소유 이력 공급과 모델 목록 조회 예약을 연결한 계획이다. 실제 Claude 수용과 운영 허용은 별도 검증한다.
- [내 AI의 새 답변 일시정지 구현 기록](impl-spec/archive/025-own-ai-input-pause.md): 진행 중인 답변을 유지하면서 본인 AI의 다음 실행만 막는 제어. 실제 DB·HTTP·브라우저와 종료 리뷰를 마쳐 보관했다. 검증 근거는 개발·검증 상태 문서에서 확인한다.
- [AI 입력 당시 저장소 관찰 구현 기록](impl-spec/archive/026-input-source-observation.md): 당시 commit·선택 파일 hash를 로컬 실행 기록에 보존한 단계. 중앙 채팅 이력과의 연결은 아래 질문 당시 대상·코드 이력 계획에서 다룬다.
- [승인 폴더의 코드 탐색 구현 기록](impl-spec/archive/028-bounded-repository-reader.md): 파일 사전 선택을 없애기 위한 제한된 목록·검색·읽기 모듈. 소유자 승인과 실제 AI 연결은 후속 통합에 포함한다.
- [폴더 승인과 실제 AI 도구 연결 기록](impl-spec/archive/029-owner-approved-repository-tools.md): 로컬 승인·웹 설정·Codex/Claude 탐색 도구와 기록을 연결한 완료 계획. 실제 설정·Mac 선택과 별도의 공식 자동 탐색을 검증하고 보관했다.
- [공식 Claude 연결과 후속 질문 계획](impl-spec/030-native-claude-chat-and-follow-up.md): 기본 factory의 실제 설치·설정 검증과 같은 소유 대화의 후속 질문을 보정한다. 자동 공동 조사의 방향 수정은 기본 채팅의 선행 조건이 아니다.
- [명령 한 번으로 내 Mac 연결 구현 기록](impl-spec/archive/031-one-command-local-connection.md): 별도 앱·저장소·npm 설치 없이 운영 연결 코드를 임시 실행하고 기기 승인부터 웹 AI 설정까지 이어가는 단계. 현재 실행기를 재사용하는 배포·승인·설정 연결이다. 구현·검증 상태는 개발·검증 상태 문서에서 확인한다.
- [질문 당시 대상·코드 이력 구현 기록](impl-spec/archive/027-shared-input-source-history.md): 중앙 채팅에 예약 당시 대상과 저장한 파일 관찰을 연결한다. 입력 전 허용 파일과 실제 도구 반환을 구분하며 메시지별 상세 조회를 제공하는 단계다.
- [진행 중인 구현 계획](impl-spec): 실행할 코드 수준 계획.
- [계획 보관](impl-spec/archive): 완료 계획과 대체된 구계획의 당시 결정·검증 기록. 현재 코드 상태는 구조 문서와 실행 결과로 확인한다.

## 결정과 기록

- [설계 결정](ADR.md): 중요한 선택의 이유와 대안.
- [오류 해결 기록](BUG-FIXES.md): 재현한 문제, 수정과 검증.
- [문서 정리 기록](records/document-maintenance.md): 문서 구성 변경과 검토 이력.
- [이전 개발·검증 기록](records/verification-history-20261008.md): 과거 환경 제한과 검증 당시 결과. 현재 진행 상태와 구분해 보관한다.

second-brain 표준 문서는 `docs/` 바로 아래에 유지하고 보조 문서만 폴더로 묶었다. 폴더 이동으로 완료 계획의 상대 링크를 조정했다. 완료 계획에 기록된 코드 경로와 구현 내용은 당시 기록으로 유지한다. 개발 상태와 검증 수치는 이 목차에 복사하지 않고 개발·검증 상태 문서에서 관리한다.
