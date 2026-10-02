# 문서 정리 기록

아래는 2026-09-30에 수행한 문서 정리와 당시 독립 리뷰의 범위다. 제품 요구·현재 구현 상태·런타임 검증 결과로 사용하지 않는다. 반복된 검사 개수와 작업 진행 로그는 제거하고 변경 이유와 검토 한계만 남겼다.

## 설계 내용 정리

- 초기 리뷰에서 권한 출처, UNKNOWN 실행, 중단 요청과 실제 종결, private context 분리, DB 내구성, snapshot 근거를 보완했다. 이어서 방향 수정은 interrupt 후 새 turn으로 통일하고, room revision·binding epoch·조사 사이클 한도·옛 답변의 자동 후속 실행 차단을 정리했다. 독립 리뷰에서 HIGH/CRITICAL 지적 없이 확인한 문서 설계이며 실제 실행 검증은 아니다. 현재 규칙은 [BUSINESS-LOGIC](BUSINESS-LOGIC.md)이 정본이다.
- 사용자 확인에 따라 개인·비상업용 초기 범위와 무료 플랜 운영 가정을 반영했다. 해당 변경은 별도 독립 리뷰를 통과했지만 실제 무료 한도 내 운영 여부는 측정하지 않았다.
- `system-design.md`와 `collaboration-protocol.md`의 내용을 표준 문서로 통합하고 사용자 요청에 따라 중복 원본을 삭제했다. 미선택 기술안 5개는 ADR에서 미결 문서로 옮겼다.

## 검토 범위와 한계

| 당시 검토 | 결과 | 적용 범위·한계 |
|---|---|---|
| 로컬 AI 연결 조사 독립 리뷰 | PASS | 브라우저/프로세스 경계, outbound 연결, resume/live attach, 인증·정보 공유, 로컬 증거와 미검증 사항 구분. 당시 조사 본문 검토이며 두 PC·실제 추론·계정 적격성·중단 실험 결과가 아님 |
| second-brain 전체 문서 독립 리뷰 | 형식·배치 PASS, freshness PARTIAL | 표준 파일 생성 조건, ADR, PRD, GLOSSARY 확인. 코드·Git commit 부재로 ARCHITECTURE의 freshness stamp는 미적용 |

실제 로컬 CLI/schema/stdio handshake 증거는 [연결 조사](local-ai-connection-research.md#이번에-실제-확인한-로컬-증거), 현재 표준 문서 적용 상태는 [README](../README.md#second-brain-규칙-적용-상태)를 따른다. 문서 링크·앵커·코드펜스 검사는 제품 동작 검증을 대신하지 않는다.
