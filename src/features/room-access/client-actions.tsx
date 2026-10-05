"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { messages, type AccessErrorCode } from "./contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import styles from "./access.module.css";
export function useMutation() {
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<AccessErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  async function send<T>(path: string, body: Record<string, string>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    setErrorCode(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const result = await response.json();
      if (!result.ok) {
        const code: AccessErrorCode = Object.hasOwn(messages, result.error?.code)
          ? result.error.code
          : "UNAVAILABLE";
        setError(messages[code]);
        setErrorCode(code);
        return;
      }
      return result.data as T;
    } catch {
      setError(messages.UNAVAILABLE);
      setErrorCode("UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  return {
    send,
    busy,
    errorCode,
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
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={async () => {
          if (await send("/api/auth/logout", {})) {
            router.replace("/login");
            router.refresh();
          }
        }}
      >
        로그아웃
      </Button>
    </div>
  );
}
export function RoomFields() {
  return (
    <label className={styles.field}>
      방 이름
      <Input name="title" required maxLength={160} />
    </label>
  );
}
