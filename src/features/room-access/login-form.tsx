"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, formValues } from "./client-actions";
import styles from "./access.module.css";
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const { send, busy, errorNode } = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    if (email === null) {
      if (await send("/api/auth/code", values)) setEmail(values.email);
    } else if (await send("/api/auth/verify", { email, code: values.code })) {
      router.replace("/app");
      router.refresh();
    }
  }
  return (
    <main className={styles.shell}>
      <section className={styles.panel}>
        <h1>조사실 로그인</h1>
        <p>이메일로 받은 일회용 코드로 로그인하세요.</p>
        {errorNode}
        <form onSubmit={submit} className={styles.form}>
          {email === null ? (
            <label className={styles.field}>
              이메일
              <input name="email" type="email" autoComplete="email" required maxLength={254} />
            </label>
          ) : (
            <>
              <p>입력한 이메일로 코드를 보냈습니다.</p>
              <label className={styles.field}>
                로그인 코드
                <input
                  key="code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                  maxLength={6}
                  autoFocus
                />
              </label>
            </>
          )}
          <button className="button primary" disabled={busy}>
            {email === null ? "코드 받기" : "로그인"}
          </button>
        </form>
        {email !== null && (
          <div className={styles.actions}>
            <button
              className="button"
              disabled={busy}
              onClick={() => send("/api/auth/code", { email })}
            >
              코드 다시 받기
            </button>
            <button className="button" disabled={busy} onClick={() => setEmail(null)}>
              다른 이메일 사용
            </button>
          </div>
        )}
        <Link href="/">모의 체험으로 돌아가기</Link>
      </section>
    </main>
  );
}
