"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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

const ConnectionNavigationContext = createContext<((mounted: boolean) => void) | null>(null);
const HeaderContext = createContext<{ host: HTMLDivElement | null } | null>(null);

export function ConnectionNavigationProvider({
  connection,
  children,
}: {
  connection: ReactNode;
  children: ReactNode;
}) {
  const [hasShell, setHasShell] = useState(false);
  return (
    <ConnectionNavigationContext.Provider value={setHasShell}>
      <div className="relative h-dvh min-w-0 overflow-hidden">
        <div
          className={`h-full min-h-0 min-w-0 overflow-y-auto [&>main]:h-full [&>main]:min-h-0 ${hasShell ? "" : "pt-14"}`}
        >
          {children}
        </div>
        <div
          aria-label="내 AI 연결 확인"
          data-placement={hasShell ? "navigation" : "fallback"}
          className={`group/connection absolute z-20 ${hasShell ? "right-2 top-2.5 lg:bottom-0 lg:left-0 lg:right-auto lg:top-auto lg:w-60" : "right-2 top-2.5"}`}
        >
          {connection}
        </div>
      </div>
    </ConnectionNavigationContext.Provider>
  );
}

export function ChatHeaderControls({ children }: { children: ReactNode }) {
  const header = useContext(HeaderContext);
  if (!header) return <div className="flex min-w-0 items-center gap-2">{children}</div>;
  return header.host ? createPortal(children, header.host) : null;
}

export function ChatShell({
  rooms = [],
  roomId,
  page = "chat",
  title,
  children,
  details,
  actions,
  metadata,
  newRoom,
  onNewRoom,
}: {
  rooms?: Room[];
  roomId?: string;
  page?: "chat" | "connections";
  title: string;
  children: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
  metadata?: ReactNode;
  newRoom?: ReactNode;
  onNewRoom?: (returnFocus: HTMLElement | null) => void;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const pendingNewRoom = useRef(false);
  const registerShell = useContext(ConnectionNavigationContext);
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    registerShell?.(true);
    return () => registerShell?.(false);
  }, [registerShell]);
  const contextRoom = rooms.find((room) => room.id === roomId);
  const connectionsHref = contextRoom
    ? `/app/connections?room=${contextRoom.id}`
    : "/app/connections";
  const navigation = (inSheet = false) => (
    <div
      className="flex h-full min-w-0 flex-col bg-neutral-100/80"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) setNavigationOpen(false);
      }}
    >
      <Link
        href="/app"
        className="flex items-center gap-3 px-5 py-6 text-sm font-semibold tracking-tight text-neutral-900"
      >
        <span className="flex size-8 items-center justify-center rounded-xl bg-teal-800 text-white">
          <MessageSquare className="size-4" aria-hidden="true" />
        </span>
        AI 채팅방
      </Link>
      <div className="px-3 pb-4">
        {inSheet && onNewRoom ? (
          <Button
            variant="outline"
            className="w-full justify-start rounded-lg border-neutral-200 bg-white text-sm shadow-none"
            onClick={() => {
              pendingNewRoom.current = true;
              setNavigationOpen(false);
            }}
          >
            <Plus className="size-4" />새 채팅방
          </Button>
        ) : (
          (newRoom ?? (
            <Button
              variant="outline"
              className="w-full justify-start rounded-lg border-neutral-200 bg-white text-sm shadow-none"
              asChild
            >
              <Link href="/app">
                <Plus className="size-4" />새 채팅방
              </Link>
            </Button>
          ))
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <p className="px-6 pb-2 text-[11px] font-medium text-neutral-500">내 채팅방</p>
        <nav aria-label="AI 채팅방 목록" className="space-y-1 px-3 pb-4">
          {rooms.map((room) => (
            <Link
              key={room.id}
              href={`/app/rooms/${room.id}`}
              aria-current={page === "chat" && room.id === roomId ? "page" : undefined}
              className={`flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-teal-700 ${page === "chat" && room.id === roomId ? "bg-white font-medium text-teal-900 shadow-sm ring-1 ring-neutral-200/70" : "text-neutral-600 hover:bg-neutral-200/60 hover:text-neutral-900"}`}
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
      <div
        className={`border-t border-neutral-200/80 p-3 ${registerShell && !inSheet ? "pb-20" : ""}`}
      >
        <Button
          variant="ghost"
          className="w-full justify-start rounded-lg text-neutral-700 hover:bg-neutral-200/60"
          asChild
        >
          <Link href={connectionsHref} aria-current={page === "connections" ? "page" : undefined}>
            <Plug className="size-4" />내 AI 연결{" "}
            <span className="ml-auto text-xs text-neutral-500">선택 사항</span>
          </Link>
        </Button>
        <p className="px-3 pt-1 text-xs text-neutral-500">내 AI 없이 질문만 해도 됩니다.</p>
      </div>
    </div>
  );
  return (
    <HeaderContext.Provider value={{ host: headerHost }}>
      <main
        className={`grid h-dvh min-h-0 min-w-0 grid-cols-1 overflow-hidden bg-white lg:grid-cols-[240px_minmax(0,1fr)] ${details ? "xl:grid-cols-[240px_minmax(0,1fr)_288px]" : ""}`}
      >
        <aside
          aria-label="채팅방 탐색"
          className="hidden min-h-0 border-r border-neutral-200/80 bg-neutral-100/80 lg:block"
        >
          {navigation()}
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-[#fdfdfc]">
          <header
            className={`flex h-14 shrink-0 items-center justify-between gap-1 border-b border-neutral-200/70 bg-white pl-2 md:pl-6 ${registerShell ? "pr-12 lg:pr-6" : "pr-2 md:pr-6"}`}
          >
            <div className="flex min-w-0 items-center gap-1 md:gap-2">
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
                  className="flex w-[min(320px,90vw)] flex-col bg-neutral-100 p-0"
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
              <h1 className="truncate text-sm font-semibold tracking-tight text-neutral-900 md:text-base">
                {title}
              </h1>
              {metadata}
            </div>
            <div className="flex shrink-0 items-center gap-0.5 md:gap-1 max-md:[&_button]:h-8 max-md:[&_button]:w-auto max-md:[&_button]:px-1 max-md:[&_button]:text-[10px]">
              <div ref={setHeaderHost} className="flex min-w-0 items-center gap-1 md:gap-2" />
              <div className="lg:hidden">{newRoom}</div>
              {(actions || details) && (
                <div
                  className="relative"
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Escape" ||
                      !event.currentTarget.contains(event.target as Node)
                    )
                      return;
                    setActionsOpen(false);
                    event.currentTarget
                      .querySelector<HTMLButtonElement>("button[aria-expanded]")
                      ?.focus();
                  }}
                >
                  <button
                    type="button"
                    aria-label="채팅방 기능 열기"
                    aria-expanded={actionsOpen}
                    onClick={() => setActionsOpen(!actionsOpen)}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-md hover:bg-neutral-100 lg:hidden"
                  >
                    <Menu className="size-4" aria-hidden="true" />
                  </button>
                  <div
                    className={`absolute right-0 top-10 z-30 ${actionsOpen ? "flex" : "hidden"} w-48 flex-col items-start gap-2 rounded-md border bg-white p-3 shadow-lg lg:static lg:flex lg:w-auto lg:flex-row lg:items-center lg:gap-1 lg:border-0 lg:p-0 lg:shadow-none`}
                  >
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
                </div>
              )}
            </div>
          </header>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </section>
        {details && (
          <aside
            aria-label="참가자 정보"
            className="hidden min-h-0 overflow-y-auto border-l border-neutral-200/80 bg-neutral-50/70 p-5 xl:block [overflow-wrap:anywhere]"
          >
            {details}
          </aside>
        )}
      </main>
    </HeaderContext.Provider>
  );
}
