| 용어 | Canonical identifier | 정의 (1줄) | 금지 표현 |
|---|---|---|---|
| AI 채팅방 | `Room` | 사람이 원하는 상대 AI에 직접 질문하고 참가자가 같은 대화를 보는 방; 공동 조사는 선택 기능 | 사용자 화면의 조사실·조사방, 두 AI 연결이 필수인 방 |
| 로컬 연결 프로그램 | `connector` | 각 PC에서 등록한 저장소와 AI 런타임을 중앙 서비스에 연결하는 프로세스 | 웹페이지 자체, 중앙 AI 프로세스 |
| 내 AI 연결 | `AgentBinding` | 방에서 선택한 소유자·기기·등록 저장소·런타임 세션의 연결 | 모델 이름만으로 대상 식별, AI 계정과 동일 취급 |
| 등록 저장소 | `WorkspaceBinding` | 로컬 root·worktree를 확인해 만든 저장소 연결 정보 | 웹에 입력한 경로 문자열만으로 등록 |
| 저장 세션 | `runtimeSessionId` | 공급자가 저장·식별하는 대화 문맥의 세션 | 실행 중 프로세스, 활성 turn |
| 활성 실행 | `runtimeTurnId` | 런타임에서 시작한 한 turn의 실행 식별자 | 저장 세션 ID, 기기 연결 ID |
| 저장 세션 이어가기 | `L2` | 저장된 대화 문맥을 공식 resume/fork로 사용하는 [연결 수준](research/ai-runtime-integration.md#내-ai를-연결한다는-의미) | live attach, 같은 실행에 동시 연결 |
| 실행 중 세션 연결 | `L3` | 현재 작동하는 동일 런타임에 client를 연결하는 [연결 수준](research/ai-runtime-integration.md#내-ai를-연결한다는-의미) | 저장 기록 재개, 새 세션 시작 |
| 브라우저 폴더 handle | `FileSystemDirectoryHandle` | 사용자가 브라우저에 접근을 허용한 폴더의 참조 | OS 절대 경로, CLI 실행 권한 |
| 방 공유 정보 | `publicText` / `publicScopeConfirmed` | 권한 있는 방에 선택 근거와 AI 생성 결론을 사전 동의하여 공유하는 범위; [개인 설정과의 경계](research/ai-runtime-integration.md#기존-개인-에이전트-설정-유지) | 인터넷 전체 공개, 전체 문구 출처 인증, 로컬 AI의 모든 입력과 동일 취급 |
| 자동 질문 동의 | `autoQuestionsConfirmed` | 확인한 조사 목적·선택 근거에 관한 AI 생성 질문을 지정 상대에게 자동 전송하는 동의 | 설정 원문 공개 승인, 상대의 파일 수정 승인 |
| 확정 답변 증거 | `FINAL_ANSWER` | 해당 native turn의 확정 답변 이벤트·item임을 확인한 상태 | 모든 내용의 출처 인증, 소유자가 최종 문구를 직접 승인한 상태 |
| 로컬 root 참조 | `localRootReference` | PC가 확인한 root를 설정 요청에 연결하는 불투명 식별자 | 절대 경로, 파일 접근 권한 |
| 기기 설정 버전 | `configRevision` | 해당 기기의 서버 확정 설정을 구분하는 버전 | 방 revision, AI 연결 epoch |
| 설정 generation | `GenerationPointer.generation` | 한 root/provider의 로컬 맥락·설정·실행 기록을 분리하는 식별자 | 조사 cycle generation, 옛 UNKNOWN의 새 저장소 이관 |
| 설정 서버 확정 | `COMMITTED` | binding·epoch·설정 receipt가 중앙 DB에 함께 확정된 상태 | PC 적용 완료, AI 준비 완료 |
| 설정 PC 적용 | `APPLIED` | PC가 generation 기록·현재 pointer·profile mapping을 영속 저장한 뒤 보고한 상태 | provider 실행 검증, 질문 답변 완료 |
| 모델 선택 근거 | `Capability.snapshotHash` | PC에서 확인한 provider 버전·모델·effort·정책 catalog의 내용 hash | 임의 웹 모델 목록, 미래 버전의 지원 보장 |
| 입력 당시 저장소 관찰 | `AttemptJournal.sourceObservation` | 입력 직전 재검증한 허용 파일의 상대 경로·hash·시각과 Git 관찰을 한 번 보존한 로컬 기록 | 원자적 전체 snapshot, 실제 인용·도구 검증·native 입력의 성공 증거, 과거 기록의 현재 정보 채우기 |
| 폴더 자동 탐색 승인 | `RepositoryAccess` / `AUTO_CODE` | 해당 Mac의 소유자가 등록 폴더와 새 설정 세대에 묶어 승인한 코드 탐색 범위 | 빈 선택 목록, 웹 모드 값, 개인 전역 지침만으로 승인 |
| 실제 반환 파일 관찰 | `RepositoryToolObservation` | 자동 읽기·검색 도구가 AI에 반환한 파일 발췌의 상대 경로·hash·시각·바이트 범위를 보존한 로컬 기록 | 입력 전 파일 목록, 검색 중 검사한 모든 파일, 최종 답변의 실제 인용 증명 |
| 상대 질문 사전 근거 관찰 | `PeerEvidenceObservation` | 상대에게 질문을 보내기 전에 검증한 파일과 요청 줄 범위를 원래 발송 요청에 연결한 로컬 기록 | AI에 반환한 발췌, 상대의 수락·전달 완료 증거 |
| 예약 당시 대상 | `SourceTarget` | 실행 요청 예약 때 고정한 사람·AI·저장소·세션 별칭과 연결 버전 | 현재 연결의 표시 정보, 공동 AI 질문의 발신 요청 |
| 채팅 자료 기록 | `PublicSourceManifest` | 검증한 로컬 관찰에서 공개 허용 항목만 투영한 불변 자료. 입력 전 허용 파일·도구 반환·상대 질문 전 근거를 구분한다 | 전체 파일 본문, 개인 설정, 모델 사용·인용·테스트 통과 증명 |
| 자료 전체 확정 | source `CONFIRMED` | 같은 attempt/fence의 전송 조각·전체 hash·형식 검사가 끝난 상태 | 조각 하나의 ACK, AI 답변 종결·현재 준비 완료 |
