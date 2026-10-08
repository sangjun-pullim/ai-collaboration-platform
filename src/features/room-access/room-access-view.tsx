"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Settings, Copy, Users } from "lucide-react";
import type { Room, RoomRole, Member, Organization, GroupMember } from "./contracts";
import { LogoutButton, useMutation, formValues } from "./client-actions";
import { ChatShell } from "./chat-shell";
import { Button } from "../../components/ui/button";
import { Avatar, AvatarFallback } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../../components/ui/dialog";
import styles from "./access.module.css";
const roles: Record<RoomRole, string> = {
  owner: "소유자",
  participant: "참여자",
  observer: "관찰자",
};
export function RoomAccessView({
  userId,
  room,
  role,
  members,
  organization,
  groupMembers,
  bindings,
  investigation,
  rooms = [room],
}: {
  userId: string;
  room: Room;
  role: RoomRole;
  members: Member[];
  organization: Organization;
  groupMembers: GroupMember[];
  bindings?: ReactNode;
  investigation?: ReactNode;
  rooms?: Room[];
}) {
  const router = useRouter();
  const { send, busy, errorNode } = useMutation();
  const [invitation, setInvitation] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInvitation(null);
    setCopyNotice("");
    const data = await send<{ code: string }>("/api/access/invite", {
      roomId: room.id,
      ...formValues(event.currentTarget),
    });
    if (data) setInvitation(data.code);
  }
  async function remove(action: string, member: string) {
    const scope: Record<string, string> =
      action === "revoke-room-member" ? { roomId: room.id } : { organizationId: organization.id };
    if (await send(`/api/access/${action}`, { ...scope, userId: member })) router.refresh();
  }
  const details = (
    <div className="space-y-6">
      <section aria-label="방 멤버">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" />
          참가자 <span className="text-neutral-400">{members.length}</span>
        </h2>
        <ul className="space-y-4">
          {members.map((member) => (
            <li key={member.user_id} className="flex min-w-0 items-center gap-3">
              <Avatar className="size-8">
                <AvatarFallback>{member.display_alias.slice(0, 1)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {member.display_alias} · {roles[member.role]}
                </p>
                {member.user_id === userId && <span className="text-xs text-neutral-500">나</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {bindings}
      <p className="border-t pt-4 text-xs text-neutral-500">
        저장소와 작업 영역은 공개 별칭으로만 표시합니다.
      </p>
    </div>
  );
  const management = (
    <Dialog
      onOpenChange={() => {
        setInvitation(null);
        setCopyNotice("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="채팅방 관리">
          <Settings className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>채팅방 관리</DialogTitle>
          <DialogDescription>
            내 역할: {roles[role]}. 초대와 멤버 변경은 기존 방 권한을 따릅니다.
          </DialogDescription>
        </DialogHeader>
        {errorNode}
        <section className="space-y-3">
          <h2 className="font-medium">방 준비 정보</h2>
          <dl className={styles.details}>
            <dt>조사 목표</dt>
            <dd>{room.goal}</dd>
            <dt>관찰 근거</dt>
            <dd>{room.observation}</dd>
            <dt>환경</dt>
            <dd>{room.environment}</dd>
          </dl>
        </section>
        {role === "owner" && (
          <section className="space-y-3 border-t pt-4">
            <h2 className="font-medium">멤버 초대</h2>
            <form className="flex flex-wrap items-end gap-3" onSubmit={invite}>
              <label className="grid gap-2">
                초대 역할
                <select className="rounded-md border p-2" name="role">
                  <option value="participant">참여자</option>
                  <option value="observer">관찰자</option>
                </select>
              </label>
              <Button disabled={busy}>초대 발급</Button>
            </form>
            {invitation && (
              <div className="space-y-3">
                <p className="text-xs text-neutral-500">
                  24시간 안에 한 번 사용할 수 있습니다. 초대할 사람에게 직접 전달하세요.
                </p>
                <p
                  aria-label="발급된 초대 코드"
                  className="break-all rounded-md bg-neutral-50 p-3 text-xs"
                >
                  {invitation}
                </p>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${window.location.origin}/app?invite=${invitation}`,
                      );
                      setCopyNotice("초대 링크를 복사했습니다.");
                    } catch {
                      setCopyNotice("복사할 수 없습니다. 초대 코드를 직접 복사하세요.");
                    }
                  }}
                >
                  <Copy className="size-4" />
                  초대 링크 복사
                </Button>
                <Button variant="ghost" onClick={() => setInvitation(null)}>
                  코드 숨기기
                </Button>
                {copyNotice && <p role="status">{copyNotice}</p>}
              </div>
            )}
          </section>
        )}
        {role === "owner" && (
          <section className="space-y-3 border-t pt-4">
            <h2 className="font-medium">방 멤버 관리</h2>
            <ul className="space-y-3">
              {members.map((member) => (
                <li key={member.user_id} className="flex items-center justify-between gap-2">
                  <span>
                    {member.display_alias} · {roles[member.role]}
                  </span>
                  {member.role !== "owner" && member.user_id !== userId && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${member.display_alias} 방에서 제거`}
                      onClick={() => remove("revoke-room-member", member.user_id)}
                    >
                      방에서 제거
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {organization.owner_user_id === userId && (
          <section className="space-y-3 border-t pt-4">
            <h2 className="font-medium">그룹 멤버 관리</h2>
            <p className="text-xs text-neutral-500">
              그룹에서 제거하면 그룹 내 모든 방의 접근이 취소됩니다.
            </p>
            <ul className="space-y-3">
              {groupMembers
                .filter((member) => member.role !== "owner")
                .map((member) => (
                  <li key={member.user_id} className="flex items-center justify-between gap-2">
                    <span>{member.display_alias}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${member.display_alias} 그룹에서 제거`}
                      onClick={() => remove("revoke-group-member", member.user_id)}
                    >
                      그룹에서 제거
                    </Button>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
  return (
    <ChatShell
      rooms={rooms}
      roomId={room.id}
      title={room.title}
      details={details}
      actions={
        <>
          {management}
          <LogoutButton />
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2 text-xs text-neutral-500">
        <span>
          내 역할: <strong>{roles[role]}</strong>
        </span>
        <Badge variant="secondary">{role === "observer" ? "읽기 전용" : "질문 · 대화"}</Badge>
        <span className="ml-auto">내 AI 연결은 선택 사항</span>
      </div>
      {investigation}
    </ChatShell>
  );
}
