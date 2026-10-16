"use client";
import {
  clearChatSession,
  chatCleanupNotice,
  subscribeChatCleanup,
} from "../investigation-coordinator/chat-session-cleanup";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, formValues } from "./client-actions";
import styles from "./access.module.css";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function LoginForm({ destination = "/app" }: { destination?: string }) {
  const router = useRouter();
  const [preparing, setPreparing] = useState(false);
  const cleanupError = useSyncExternalStore(subscribeChatCleanup, chatCleanupNotice, () => false);
  const { send, busy, errorNode, errorCode } = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(form);
    // Keep the code only in the in-flight request, never in the rendered form.
    const code = form.elements.namedItem("code");
    if (code instanceof HTMLInputElement) code.value = "";
    if (busy || preparing) return;
    setPreparing(true);
    try {
      // Explicit admission starts only after old local requests have been removed.
      if (!(await clearChatSession())) return;
      const entered = await send<{ userId: string }>("/api/auth/enter", values);
      if (entered) {
        router.replace(destination);
        router.refresh();
      }
    } finally {
      setPreparing(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-5 py-10">
      <section className="w-full space-y-6 rounded-xl border p-6 sm:p-8">
        <h1 className="text-xl font-semibold">AI 채팅방 입장</h1>
        <p className="text-sm text-neutral-500">
          회사에서 받은 입장 코드와 대화에 사용할 이름을 입력하세요.
        </p>
        {cleanupError && (
          <p role="alert" className="text-sm text-red-800">
            저장 메시지 정리를 완료하지 못했습니다. 이전 내용은 숨겼습니다. 브라우저 저장 공간을
            확인한 뒤 다시 입장해 주세요. 정리가 끝나야 입장할 수 있습니다.
          </p>
        )}
        {errorNode}
        <form onSubmit={submit} className={styles.form}>
          <label className={styles.field}>
            회사 입장 코드
            <Input
              name="code"
              type="password"
              autoComplete="off"
              required
              maxLength={128}
              autoFocus
            />
          </label>
          <label className={styles.field}>
            표시 이름
            <Input name="displayName" autoComplete="off" required maxLength={80} />
          </label>
          <Button disabled={busy || preparing}>입장하기</Button>
        </form>
        {errorCode === "UNAUTHENTICATED" && (
          <div className="space-y-3 text-sm">
            <p className="text-neutral-500">
              현재 사용자 세션을 사용할 수 없습니다. 로그아웃하면 새 사용자로 입장할 수 있습니다.
              이전 사용자와 AI 소유권은 같은 표시 이름으로 복구할 수 없습니다.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy || preparing}
              onClick={async () => {
                if (await send("/api/auth/logout", {})) {
                  await clearChatSession();
                  router.refresh();
                }
              }}
            >
              로그아웃하고 새 입장 준비
            </Button>
          </div>
        )}
        <Link href="/demo">예제 체험</Link>
      </section>
    </main>
  );
}
