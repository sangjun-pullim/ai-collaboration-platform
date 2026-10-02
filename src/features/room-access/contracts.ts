export type AccessErrorCode = "NOT_FOUND" | "INVALID_BODY" | "UNSAFE_ORIGIN" | "BODY_TOO_LARGE" | "UNAUTHENTICATED" | "FORBIDDEN" | "INVITE_UNAVAILABLE" | "ALREADY_MEMBER" | "CODE_REJECTED" | "CODE_COOLDOWN" | "UNAVAILABLE";
export const errorStatus: Record<AccessErrorCode, number> = {
  NOT_FOUND: 404, INVALID_BODY: 400, UNSAFE_ORIGIN: 403, BODY_TOO_LARGE: 400,
  UNAUTHENTICATED: 401, FORBIDDEN: 403, INVITE_UNAVAILABLE: 409, ALREADY_MEMBER: 409,
  CODE_REJECTED: 400, CODE_COOLDOWN: 429, UNAVAILABLE: 503,
};
export class AccessError extends Error {
  constructor(public readonly code: AccessErrorCode) { super(code); }
}
export type RoomRole = "owner" | "participant" | "observer";
export type Organization = { id: string; name: string; owner_user_id: string };
export type Room = { id: string; organization_id: string; title: string; goal: string; observation: string; environment: string };
export type Member = { user_id: string; role: RoomRole; display_alias: string; status: "active" | "removed" };
export type GroupMember = { user_id: string; role: "owner" | "member"; display_alias: string; status: "active" | "removed" };
export const authActions = ["code", "verify", "logout"] as const;
export const accessActions = ["bootstrap", "room", "invite", "join", "revoke-room-member", "revoke-group-member"] as const;
export type AuthAction = typeof authActions[number];
export type AccessAction = typeof accessActions[number];
export const messages: Record<AccessErrorCode, string> = {
  NOT_FOUND: "방을 찾을 수 없습니다. 로그인과 초대를 확인하세요.", INVALID_BODY: "입력 내용을 확인하세요.",
  UNSAFE_ORIGIN: "이 화면에서 다시 요청하세요.", BODY_TOO_LARGE: "입력 내용을 줄여 주세요.",
  UNAUTHENTICATED: "다시 로그인해 주세요.", FORBIDDEN: "이 작업을 수행할 권한이 없습니다.",
  INVITE_UNAVAILABLE: "초대가 만료되었거나 취소되었습니다. 새 초대를 요청하세요.", ALREADY_MEMBER: "이미 참가한 방입니다.",
  CODE_REJECTED: "코드가 올바르지 않거나 만료되었습니다. 새 코드를 요청하세요.", CODE_COOLDOWN: "잠시 뒤 코드를 다시 요청하세요.",
  UNAVAILABLE: "서비스를 준비 중입니다. 잠시 뒤 다시 시도하세요.",
};
