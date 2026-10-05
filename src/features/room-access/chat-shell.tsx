"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { Menu, Users, MessageSquare, Plus, Plug } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "../../components/ui/sheet";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { Room } from "./contracts";

export function ChatShell({
  rooms = [],
  roomId,
  title,
  children,
  details,
  actions,
  newRoom,
  onNewRoom,
}: {
  rooms?: Room[];
  roomId?: string;
  title: string;
  children: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
  newRoom?: ReactNode;
  onNewRoom?: (returnFocus: HTMLElement | null) => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const pendingNewRoom = useRef(false);
  const navigation = (inSheet = false) => (
    <div
      className="flex h-full min-w-0 flex-col"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setNavigationOpen(false);
      }}
    >
      <Link href="/app" className="flex items-center gap-2 px-5 py-6 text-base font-semibold">
        <MessageSquare className="size-5" /> AI 채팅방
      </Link>
      <div className="px-3 pb-4">
        {inSheet && onNewRoom ? (
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              pendingNewRoom.current = true;
              setNavigationOpen(false);
            }}
          >
            <Plus className="size-4" />새 채팅방
          </Button>
        ) : (
          (newRoom ?? (
            <Button variant="outline" className="w-full justify-start" asChild>
              <Link href="/app">
                <Plus className="size-4" />새 채팅방
              </Link>
            </Button>
          ))
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="AI 채팅방 목록" className="space-y-1 px-3">
          {rooms.map((room) => (
            <Link
              key={room.id}
              href={`/app/rooms/${room.id}`}
              aria-current={room.id === roomId ? "page" : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-md px-3 py-2.5 hover:bg-neutral-100 ${room.id === roomId ? "bg-neutral-100 font-medium" : "text-neutral-600"}`}
            >
              <MessageSquare className="size-4 shrink-0" />
              <span className="truncate">{room.title}</span>
            </Link>
          ))}
          {!rooms.length && (
            <p className="px-3 py-3 text-xs text-neutral-500">참가한 채팅방이 없습니다.</p>
          )}
        </nav>
      </ScrollArea>
      <div className="border-t p-4">
        <Button variant="ghost" className="w-full justify-start" asChild>
          <Link href="/app/connections">
            <Plug className="size-4" />내 AI 연결{" "}
            <span className="ml-auto text-xs text-neutral-500">선택 사항</span>
          </Link>
        </Button>
        <p className="px-3 pt-1 text-xs text-neutral-500">내 AI 없이 질문만 해도 됩니다.</p>
      </div>
    </div>
  );
  return (
    <main
      className={`grid h-dvh min-h-0 min-w-0 grid-cols-1 overflow-hidden bg-white lg:grid-cols-[240px_minmax(0,1fr)] ${details ? "xl:grid-cols-[240px_minmax(0,1fr)_288px]" : ""}`}
    >
      <aside aria-label="채팅방 탐색" className="hidden min-h-0 border-r lg:block">
        {navigation()}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
              <SheetTrigger asChild>
                <Button
                  ref={navigationTrigger}
                  variant="ghost"
                  size="icon"
                  aria-label="채팅방 목록 열기"
                  className="lg:hidden"
                >
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="flex w-[min(320px,90vw)] flex-col p-0"
                onCloseAutoFocus={(event) => {
                  if (!pendingNewRoom.current) return;
                  event.preventDefault();
                  pendingNewRoom.current = false;
                  onNewRoom?.(navigationTrigger.current);
                }}
              >
                <SheetHeader className="px-5 pt-5">
                  <SheetTitle>AI 채팅방 목록</SheetTitle>
                  <SheetDescription>참가한 채팅방으로 이동합니다.</SheetDescription>
                </SheetHeader>
                {navigation(true)}
              </SheetContent>
            </Sheet>
            <h1 className="truncate text-base font-semibold">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="lg:hidden">{newRoom}</div>
            {actions}
            {details && (
              <Sheet>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="참가자 정보 열기"
                    className="xl:hidden"
                  >
                    <Users className="size-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent className="w-[min(360px,94vw)] overflow-y-auto [overflow-wrap:anywhere]">
                  <SheetHeader>
                    <SheetTitle>참가자와 AI</SheetTitle>
                    <SheetDescription>현재 공개 연결 정보입니다.</SheetDescription>
                  </SheetHeader>
                  <div className="mt-6">{details}</div>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </section>
      {details && (
        <aside
          aria-label="참가자 정보"
          className="hidden min-h-0 overflow-y-auto border-l p-5 xl:block [overflow-wrap:anywhere]"
        >
          {details}
        </aside>
      )}
    </main>
  );
}
