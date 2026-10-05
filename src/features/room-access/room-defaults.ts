export function roomDefaults(title: string) {
  return {
    title: title.trim(),
    goal: "참가자 간 AI 채팅",
    observation: "입력하지 않음",
    environment: "입력하지 않음",
  };
}
