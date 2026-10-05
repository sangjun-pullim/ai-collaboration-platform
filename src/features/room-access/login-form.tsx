"use client";
import { type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, formValues } from "./client-actions";
import styles from "./access.module.css";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export function LoginForm({ destination = "/app" }: { destination?: string }) {
  const router = useRouter();
  const { send, busy, errorNode, errorCode } = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = formValues(form);
    // Keep the code only in the in-flight request, never in the rendered form.
    const code = form.elements.namedItem("code");
    if (code instanceof HTMLInputElement) code.value = "";
    if (await send("/api/auth/enter", values)) {
      router.replace(destination);
      router.refresh();
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-5 py-10">
      <section className="w-full space-y-6 rounded-xl border p-6 sm:p-8">
        <h1 className="text-xl font-semibold">AI 채팅방 입장</h1>
        <p className="text-sm text-neutral-500">
          회사에서 받은 입장 코드와 대화에 사용할 이름을 입력하세요.
        </p>
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
          <Button disabled={busy}>입장하기</Button>
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
              disabled={busy}
              onClick={async () => {
                if (await send("/api/auth/logout", {})) router.refresh();
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
