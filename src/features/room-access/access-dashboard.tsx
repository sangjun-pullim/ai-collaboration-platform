"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageSquare, Plus } from "lucide-react";
import type { Organization, Room } from "./contracts";
import { LogoutButton, formValues, useMutation } from "./client-actions";
import { roomDefaults } from "./room-defaults";
import { ChatShell } from "./chat-shell";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../../components/ui/dialog";

export function AccessDashboard({
  userId,
  organizations,
  rooms,
  displayName,
}: {
  userId: string;
  organizations: Organization[];
  rooms: Room[];
  displayName: string;
}) {
  const router = useRouter();
  const { send, busy, errorNode } = useMutation();
  const owned = organizations.filter((org) => org.owner_user_id === userId);
  const [createOpen, setCreateOpen] = useState(false);
  const createFocus = useRef<HTMLElement | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [invitation, setInvitation] = useState("");
  useEffect(() => {
    const code = new URL(window.location.href).searchParams.get("invite");
    if (code && /^[a-f0-9]{64}$/.test(code)) {
      queueMicrotask(() => {
        setInvitation(code);
        setJoinOpen(true);
      });
    }
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    const body = {
      ...roomDefaults(values.title),
      ...(owned.length
        ? { organizationId: owned[0].id }
        : { groupName: "내 AI 채팅방", displayAlias: displayName }),
    };
    const data = await send<{ roomId: string }>(
      `/api/access/${owned.length ? "room" : "bootstrap"}`,
      body,
    );
    if (data) {
      router.push(`/app/rooms/${data.roomId}`);
      router.refresh();
    }
  }
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    const data = await send<{ roomId: string }>("/api/access/join", {
      ...values,
      displayAlias: displayName,
    });
    if (data) {
      // Remove one-use invitation before navigation; never keep it in the room URL.
      window.history.replaceState(null, "", "/app");
      setInvitation("");
      setJoinOpen(false);
      router.push(`/app/rooms/${data.roomId}`);
      router.refresh();
    }
  }
  const createTrigger = (
    <DialogTrigger asChild>
      <Button variant="outline" className="justify-start">
        <Plus className="size-4" />새 채팅방
      </Button>
    </DialogTrigger>
  );
  const createContent = (
    <DialogContent
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        createFocus.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>새 채팅방</DialogTitle>
        <DialogDescription>이름을 정하면 동료의 AI와 대화를 시작할 수 있습니다.</DialogDescription>
      </DialogHeader>
      {errorNode}
      <form onSubmit={create} className="grid gap-4">
        <label className="grid gap-2">
          방 이름
          <Input name="title" required maxLength={160} placeholder="예: 제품 개발팀" />
        </label>
        <Button disabled={busy}>방 만들기</Button>
      </form>
    </DialogContent>
  );
  return (
    <Dialog
      open={createOpen}
      onOpenChange={(open) => {
        if (open && document.activeElement instanceof HTMLElement)
          createFocus.current = document.activeElement;
        setCreateOpen(open);
      }}
    >
      <ChatShell
        rooms={rooms}
        title="내 AI 채팅방"
        actions={
          <div className="flex items-center gap-2">
            <details className="max-w-56 text-xs text-neutral-500">
              <summary className="cursor-pointer">접속 안내</summary>
              <p>
                로그아웃하거나 브라우저 쿠키를 잃으면 새 사용자로 입장합니다. 같은 표시 이름으로
                이전 계정을 복구할 수 없습니다.
              </p>
            </details>
            <LogoutButton />
          </div>
        }
        newRoom={createTrigger}
        onNewRoom={(returnFocus) => {
          createFocus.current = returnFocus;
          setCreateOpen(true);
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 md:px-10">
          <div className="mx-auto max-w-2xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold">어떤 AI와 대화할까요?</h2>
              <p className="mt-2 text-sm text-neutral-500">
                채팅방을 선택하세요. 내 AI가 없어도 준비된 동료 AI에게 질문할 수 있습니다.
              </p>
            </div>
            <ul className="divide-y rounded-lg border">
              {rooms.map((room) => (
                <li key={room.id}>
                  <Link
                    className="flex items-center gap-3 p-4 hover:bg-neutral-50"
                    href={`/app/rooms/${room.id}`}
                  >
                    <MessageSquare className="size-5 text-neutral-400" />
                    <span className="min-w-0 truncate font-medium">{room.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-neutral-500">대화 열기</span>
                  </Link>
                </li>
              ))}
              {!rooms.length && (
                <li className="p-6 text-neutral-500">
                  아직 참가한 채팅방이 없습니다. 새 채팅방을 만들거나 초대로 참가하세요.
                </li>
              )}
            </ul>
            <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">초대로 참가</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>초대로 참가</DialogTitle>
                  <DialogDescription>
                    방 초대는 한 번만 사용할 수 있습니다. 회사 입장 코드와 다릅니다.
                  </DialogDescription>
                </DialogHeader>
                {errorNode}
                <form onSubmit={join} className="grid gap-4">
                  <label className="grid gap-2">
                    초대 코드
                    <Input
                      name="code"
                      value={invitation}
                      onChange={(event) => setInvitation(event.target.value)}
                      required
                      maxLength={64}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <Button disabled={busy}>방 참가</Button>
                </form>
              </DialogContent>
            </Dialog>
            <p className="text-xs text-neutral-500">
              내 AI 연결은 선택 사항입니다.{" "}
              <Link href="/app/connections" className="underline underline-offset-4">
                내 AI 연결
              </Link>
            </p>
          </div>
        </div>
      </ChatShell>
      {createContent}
    </Dialog>
  );
}
