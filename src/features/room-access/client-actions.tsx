"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { messages, type AccessErrorCode } from "./contracts";
import styles from "./access.module.css";
export function useMutation() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function send<T>(path: string, body: Record<string, string>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const result = await response.json();
      if (!result.ok) {
        const code = result.error?.code as AccessErrorCode;
        setError(messages[code] ?? messages.UNAVAILABLE);
        return;
      }
      return result.data as T;
    } catch {
      setError(messages.UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }
  return {
    send,
    busy,
    errorNode: error ? (
      <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}>
        {error}
      </p>
    ) : null,
  };
}
export function formValues(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
}
export function LogoutButton() {
  const router = useRouter();
  const { send, busy, errorNode } = useMutation();
  return (
    <div>
      {errorNode}
      <button
        className="button"
        disabled={busy}
        onClick={async () => {
          if (await send("/api/auth/logout", {})) {
            router.replace("/login");
            router.refresh();
          }
        }}
      >
        로그아웃
      </button>
    </div>
  );
}
export function RoomFields() {
  return (
    <>
      <label className={styles.field}>
        방 이름
        <input name="title" required maxLength={160} />
      </label>
      <label className={styles.field}>
        조사 목표
        <textarea name="goal" required maxLength={2000} />
      </label>
      <label className={styles.field}>
        관찰 근거
        <textarea name="observation" required maxLength={2000} />
      </label>
      <label className={styles.field}>
        환경
        <textarea name="environment" required maxLength={2000} />
      </label>
    </>
  );
}
