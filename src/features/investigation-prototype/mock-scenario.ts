export const bindings = [
  {
    alias: "repository-a",
    owner: "나 · 예제 개발자 A",
    branch: "investigate/state",
    snapshot: "demo-a17 · 미커밋 변경 1개",
    dirty: true,
    evidenceType: "코드 발췌",
    location: "src/state.ts:42",
    session: "상태 흐름 조사",
  },
  {
    alias: "repository-b",
    owner: "예제 개발자 B",
    branch: "main",
    snapshot: "demo-b08 · 변경 없음",
    dirty: false,
    evidenceType: "합성 검증 기록",
    location: "tests/state.spec.ts:18",
    session: "갱신 경로 조사",
  },
] as const;

export const exampleSetup = {
  goal: "두 저장소의 상태 갱신 차이 조사",
  symptom: "작업 완료 응답 이후 화면에 이전 상태가 남습니다.",
  expected: "완료한 상태가 다음 조회에 반영되어야 합니다.",
  environment: "로컬 개발 환경 · 예제 브라우저",
  bindingA: "repository-a",
  bindingB: "repository-b",
  scope: ["code", "validation", "events"],
};

export const initialEvents = [
  {
    kind: "질문",
    sender: "AI A",
    owner: "예제 개발자 A",
    recipient: "AI B",
    text: "완료 응답 이후 상태를 다시 읽는 시점은 어디인가요?",
    repository: "repository-a",
    snapshot: bindings[0].snapshot,
    location: bindings[0].location,
  },
  {
    kind: "근거",
    sender: "AI B",
    owner: "예제 개발자 B",
    recipient: "모든 참가자",
    text: "합성 예제에서 갱신 전 값을 재사용하는 분기를 확인했습니다. 실제 저장소 검증은 수행하지 않았습니다.",
    repository: "repository-b",
    snapshot: bindings[1].snapshot,
    location: bindings[1].location,
  },
] as const;

export const outboundText = "상태 변경 후 캐시를 다시 읽는 순서를 함께 확인해 주세요.";

export const replayEvents = [
  {
    kind: "답변",
    sender: "AI B",
    owner: "예제 개발자 B",
    recipient: "AI A",
    text: "예제 조회 경로가 이전 snapshot을 참조합니다. 갱신 순서가 원인 후보입니다.",
    repository: "repository-b",
    snapshot: bindings[1].snapshot,
    location: bindings[1].location,
  },
  {
    kind: "근거",
    sender: "AI A",
    owner: "예제 개발자 A",
    recipient: "모든 참가자",
    text: "예제 코드의 갱신 호출과 조회 호출 순서를 비교했습니다. 실제 테스트는 아직 실행하지 않았습니다.",
    repository: "repository-a",
    snapshot: bindings[0].snapshot,
    location: bindings[0].location,
  },
] as const;

export const resultProposal = {
  fact: "합성 예제의 두 조회 경로가 서로 다른 snapshot을 참조합니다.",
  hypothesis: "갱신과 재조회 순서가 이전 상태 노출의 원인일 수 있습니다.",
  proposal: "갱신 이후 재조회 순서를 정리하고 양쪽 저장소에서 회귀 검증을 제안합니다.",
  tasks: [
    {
      repository: "repository-a",
      owner: "예제 개발자 A",
      evidence: "src/state.ts:42 · demo-a17 (미커밋 변경 포함)",
      proposal: "갱신 완료 이후 재조회하도록 수정 제안",
      nextValidation: "갱신 직후 조회에 대한 회귀 테스트",
    },
    {
      repository: "repository-b",
      owner: "예제 개발자 B",
      evidence: "tests/state.spec.ts:18 · demo-b08",
      proposal: "snapshot 재사용 조건 확인",
      nextValidation: "양쪽 응답 순서를 바꾸는 통합 검증",
    },
  ],
  validation: "미검증 · 실제 저장소 테스트를 실행하지 않았습니다.",
} as const;
