"use client";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { messages, type ConnectionErrorCode, type OwnedDevice } from "./contracts";
import styles from "../room-access/access.module.css";
type RoomOption = {
  roomId: string;
  organizationId: string;
  roomTitle: string;
  organizationName: string;
};
export function ConnectionManager({
  devices,
  rooms,
}: {
  devices: OwnedDevice[];
  rooms: RoomOption[];
}) {
  const router = useRouter();
  const alert = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConnectionErrorCode | null>(null);
  const [notice, setNotice] = useState("");
  const [roomId, setRoomId] = useState(rooms[0]?.roomId ?? "");
  async function send(action: string, body: unknown) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const response = await fetch(`/api/connections/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const code = result.error?.code;
        setError(Object.hasOwn(messages, code) ? code : "UNAVAILABLE");
        requestAnimationFrame(() => alert.current?.focus());
        return false;
      }
      setNotice(
        action === "approve"
          ? `기기 ${result.data.deviceAlias} 승인을 완료했습니다. 로컬에서 소유 계정과 방을 확인한 뒤 교환하세요.`
          : "연결을 취소했습니다. 다시 연결하려면 새 승인이 필요합니다.",
      );
      router.refresh();
      return true;
    } catch {
      setError("UNAVAILABLE");
      requestAnimationFrame(() => alert.current?.focus());
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room) return;
    if (
      await send("approve", {
        code: String(fields.get("code")),
        organizationId: room.organizationId,
        roomId: room.roomId,
        confirmed: fields.get("confirmed") === "on",
      })
    )
      form.reset();
  }
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/app">내 조사방</Link>
        <h1>기기 연결 관리</h1>
      </header>
      <div className={styles.content}>
        <p className={styles.notice}>
          로컬 연결 프로그램에서 코드를 생성하세요. 기기 등록은 가능하며 AI 실행은 아직
          미검증입니다. 로컬 경로와 AI 인증 정보는 이 화면에 입력하지 않습니다.
        </p>
        {error && (
          <p role="alert" aria-label="기기 연결 오류" tabIndex={-1} ref={alert}>
            {messages[error]}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <section className={styles.panel}>
          <h2>새 기기 승인</h2>
          {rooms.length ? (
            <form className={styles.form} onSubmit={approve}>
              <label className={styles.field}>
                연결할 방
                <select
                  name="roomId"
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                >
                  {rooms.map((room) => (
                    <option key={room.roomId} value={room.roomId}>
                      {room.organizationName} · {room.roomTitle}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                현재 로그인한 내 계정과 선택한 방에 연결합니다. 코드에 지정된 기기 별칭과 직접
                확인한 저장소·세션 별칭, Git 브랜치·커밋, 최근 수신 시각이 방 참가자에게 공개됩니다.
                실제 경로·세션 식별자·인증 정보는 로컬에만 보관합니다.
              </p>
              <label className={styles.field}>
                기기 연결 코드
                <input
                  name="code"
                  required
                  minLength={64}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <input name="confirmed" type="checkbox" required /> 내 계정·선택한 방·기기 별칭과
                공개 정보 범위를 확인했습니다
              </label>
              <button className="button primary" disabled={busy}>
                기기 승인
              </button>
            </form>
          ) : (
            <p>승인할 수 있는 참가 방이 없습니다. 소유자 또는 참여자 권한의 초대를 받아 주세요.</p>
          )}
        </section>
        <section className={styles.panel}>
          <h2>내 연결</h2>
          {devices.length ? (
            <ul className={styles.list}>
              {devices.map((device) => (
                <li key={device.deviceId} className={styles.member}>
                  <div>
                    <strong>{device.deviceAlias}</strong>
                    <p>
                      {device.state === "active"
                        ? "등록 · 실행 미검증"
                        : device.state === "removed"
                          ? "제거됨 · 새 승인 필요"
                          : "취소됨 · 새 승인 필요"}
                    </p>
                    <p>
                      최근 수신:{" "}
                      {device.lastSeenAt
                        ? new Date(device.lastSeenAt).toLocaleString("ko-KR")
                        : "아직 없음"}
                    </p>
                    <p>
                      인증 만료:{" "}
                      {device.expiresAt
                        ? new Date(device.expiresAt).toLocaleString("ko-KR")
                        : "사용 불가"}
                    </p>
                    <Link href={`/app/rooms/${device.roomId}`}>연결한 방 보기</Link>
                  </div>
                  <div>
                    {device.state === "active" && (
                      <button
                        disabled={busy}
                        className="button"
                        aria-label={`${device.deviceAlias} 연결 취소`}
                        onClick={() => send("revoke", { deviceId: device.deviceId })}
                      >
                        연결 취소
                      </button>
                    )}
                    {device.state !== "removed" && (
                      <button
                        disabled={busy}
                        className="button"
                        aria-label={`${device.deviceAlias} 기기 제거`}
                        onClick={() => send("remove", { deviceId: device.deviceId })}
                      >
                        기기 제거
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>연결된 기기가 없습니다. 로컬 프로그램에서 새 코드를 만들고 승인하세요.</p>
          )}
        </section>
      </div>
    </main>
  );
}
