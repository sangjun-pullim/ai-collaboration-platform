# 문서 안내

제품을 이해하려면 [제품 요구사항](PRD.md), 현재 작업을 확인하려면 [개발·검증 상태](planning/delivery-and-validation.md#현재-진행-상태), 사용하려면 [첫 사용 설정](guides/onboarding-and-settings.md)을 먼저 읽는다.

| 폴더 | 찾을 내용 |
|---|---|
| `docs/` 바로 아래 | second-brain 표준 문서: 제품·구조·업무·DB·API·용어·결정·오류 |
| [guides/](guides) | 접속·설정·화면 사용 흐름과 제약 |
| [research/](research) | AI 연결 조사와 출처 |
| [planning/](planning) | 개발 현황·다음 작업·미결 사항·브랜치 운영 |
| [records/](records) | 문서 정리 이력 |
| [impl-spec/](impl-spec) | 진행 중인 구현 계획과 완료 계획 보관 |

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
- [결정과 미결 항목](planning/decisions-and-open-items.md): 아직 확인하거나 선택해야 할 사항.
- [GitHub Flow 운영](planning/github-flow.md): 작업 브랜치, PR, 검토와 병합 후 정리.
- [AI 채팅방 화면 구현 기록](impl-spec/archive/020-chat-first-web-experience.md): 기본 채팅 화면과 shadcn/ui·Tailwind 전환을 완료하고 검증한 계획.
- [회사 코드 입장 구현 기록](impl-spec/archive/021-team-code-entry.md): 코드·표시 이름과 내부 소유권 보존을 완료하고 검증한 계획.
- [내 Mac의 AI 설정 계획](impl-spec/022-owner-local-ai-setup.md): 질문자 AI 없이 상대에게 질문하고, 답변 제공자가 실제 폴더·Claude/Codex·모델·effort를 적용하는 후속 단계. 독립 계획 리뷰를 통과했으며 구현 승인을 기다린다.
- [진행 중인 구현 계획](impl-spec): 실행할 코드 수준 계획.
- [완료 계획 보관](impl-spec/archive): 당시 계획과 검증 기록. 현재 코드 상태는 구조 문서와 실행 결과로 확인한다.

## 결정과 기록

- [설계 결정](ADR.md): 중요한 선택의 이유와 대안.
- [오류 해결 기록](BUG-FIXES.md): 재현한 문제, 수정과 검증.
- [문서 정리 기록](records/document-maintenance.md): 문서 구성 변경과 검토 이력.

second-brain 표준 문서는 `docs/` 바로 아래에 유지하고 보조 문서만 폴더로 묶었다. 폴더 이동으로 완료 계획의 상대 링크를 조정했다. 완료 계획에 기록된 코드 경로와 구현 내용은 당시 기록으로 유지한다. 개발 상태와 검증 수치는 이 목차에 복사하지 않고 개발·검증 상태 문서에서 관리한다.
