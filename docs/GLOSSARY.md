| 용어 | Canonical identifier | 정의 (1줄) | 금지 표현 |
|---|---|---|---|
| 로컬 연결 프로그램 | `connector` | 각 PC에서 등록한 저장소와 AI 런타임을 중앙 서비스에 연결하는 프로세스 | 웹페이지 자체, 중앙 AI 프로세스 |
| 내 AI 연결 | `AgentBinding` | 방에서 선택한 소유자·기기·등록 저장소·런타임 세션의 연결 | 모델 이름만으로 대상 식별, AI 계정과 동일 취급 |
| 등록 저장소 | `WorkspaceBinding` | 로컬 root·worktree를 확인해 만든 저장소 연결 정보 | 웹에 입력한 경로 문자열만으로 등록 |
| 저장 세션 | `runtimeSessionId` | 공급자가 저장·식별하는 대화 문맥의 세션 | 실행 중 프로세스, 활성 turn |
| 활성 실행 | `runtimeTurnId` | 런타임에서 시작한 한 turn의 실행 식별자 | 저장 세션 ID, 기기 연결 ID |
| 저장 세션 이어가기 | `L2` | 저장된 대화 문맥을 공식 resume/fork로 사용하는 [연결 수준](ai-runtime-integration.md#내-ai를-연결한다는-의미) | live attach, 같은 실행에 동시 연결 |
| 실행 중 세션 연결 | `L3` | 현재 작동하는 동일 런타임에 client를 연결하는 [연결 수준](ai-runtime-integration.md#내-ai를-연결한다는-의미) | 저장 기록 재개, 새 세션 시작 |
| 브라우저 폴더 handle | `FileSystemDirectoryHandle` | 사용자가 브라우저에 접근을 허용한 폴더의 참조 | OS 절대 경로, CLI 실행 권한 |
| 방 공유 정보 | `publicText` / `publicScopeConfirmed` | 권한 있는 방에 선택 근거와 AI 생성 결론을 사전 동의하여 공유하는 범위; [개인 설정과의 경계](ai-runtime-integration.md#기존-개인-에이전트-설정-유지) | 인터넷 전체 공개, 전체 문구 출처 인증, 로컬 AI의 모든 입력과 동일 취급 |
| 자동 질문 동의 | `autoQuestionsConfirmed` | 확인한 조사 목적·선택 근거에 관한 AI 생성 질문을 지정 상대에게 자동 전송하는 동의 | 설정 원문 공개 승인, 상대의 파일 수정 승인 |
| 확정 답변 증거 | `FINAL_ANSWER` | 해당 native turn의 확정 답변 이벤트·item임을 확인한 상태 | 모든 내용의 출처 인증, 소유자가 최종 문구를 직접 승인한 상태 |
