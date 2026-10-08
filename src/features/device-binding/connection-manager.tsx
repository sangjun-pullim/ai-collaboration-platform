"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { messages, type ConnectionErrorCode, type OwnedDevice } from "./contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { RuntimeSettingsForm } from "../runtime-settings/runtime-settings-form";
import { LocalConnectionGuide } from "./local-connection-guide";
import { consumeConnectionFragment } from "./local-connection-command";
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
  origin,
  userId,
}: {
  devices: OwnedDevice[];
  rooms: RoomOption[];
  origin: string;
  userId: string;
}) {
  const router = useRouter();
  const alert = useRef<HTMLParagraphElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConnectionErrorCode | null>(null);
  const [notice, setNotice] = useState("");
  const [roomId, setRoomId] = useState(rooms[0]?.roomId ?? "");
  const [pairingCode, setPairingCode] = useState("");
  useEffect(() => {
    if (!window.location.hash) return;
    const hash = window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    const pairing = consumeConnectionFragment(hash, rooms);
    if (pairing) {
      queueMicrotask(() => {
        setRoomId(pairing.roomId);
        setPairingCode(pairing.code);
      });
    }
  }, [rooms]);
  const [settingsRoomId, setSettingsRoomId] = useState(
    devices.find((device) => device.state === "active")?.roomId ?? rooms[0]?.roomId ?? "",
  );
  const [settingsDeviceId, setSettingsDeviceId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const availableDevices = devices.filter(
    (device) =>
      device.state === "active" &&
      device.roomId === settingsRoomId &&
      device.expiresAt !== null &&
      Date.parse(device.expiresAt) > now,
  );
  const settingsDevice =
    availableDevices.find((device) => device.deviceId === settingsDeviceId) ?? availableDevices[0];
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
          ? `기기 ${result.data.deviceAlias} 승인을 완료했습니다. 실행 중인 터미널에서 내 계정과 방을 확인한 뒤 아래 AI 설정을 진행하세요. 수동 연결은 펼침 안내를 확인하세요.`
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
    ) {
      form.reset();
      setPairingCode("");
    }
  }
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/app">내 AI 채팅방</Link>
        <h1 className="text-xl font-semibold">내 AI 연결</h1>
      </header>
      <div className={styles.content}>
        <p className={styles.notice}>
          내 AI 연결은 선택 사항입니다. 질문만 하는 참가자는 AI 설정 없이 AI 채팅방에 들어갈 수
          있습니다. AI를 제공할 때만 본인 기기를 승인하고 자기 PC에서 설정을 확인하세요.
        </p>
        <Link href="/app" className="text-sm underline">
          질문만 하기
        </Link>
        <LocalConnectionGuide
          origin={origin}
          userId={userId}
          rooms={rooms}
          roomId={roomId}
          onRoomChange={setRoomId}
        />
        <details className={styles.panel}>
          <summary className="cursor-pointer text-sm">기존 수동 연결을 사용하는 경우</summary>
          <p className="mt-2 text-sm text-neutral-600">
            기존 pair 명령의 코드를 아래에서 승인한 뒤, 자기 PC에서 계정·방을 확인하고 exchange를
            실행하세요. 같은 프로필로 manage를 실행하면 아래 AI 설정을 사용할 수 있습니다.
          </p>
        </details>
        {error && (
          <p role="alert" aria-label="기기 연결 오류" tabIndex={-1} ref={alert}>
            {messages[error]}
          </p>
        )}
        {notice && (
          <p role="status" aria-label="기기 연결 결과">
            {notice}
          </p>
        )}
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
                <Input
                  name="code"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
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
              <Button disabled={busy}>기기 승인</Button>
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
                      <Button
                        disabled={busy}
                        variant="outline"
                        aria-label={`${device.deviceAlias} 연결 취소`}
                        onClick={() => send("revoke", { deviceId: device.deviceId })}
                      >
                        연결 취소
                      </Button>
                    )}
                    {device.state !== "removed" && (
                      <Button
                        disabled={busy}
                        variant="outline"
                        aria-label={`${device.deviceAlias} 기기 제거`}
                        onClick={() => send("remove", { deviceId: device.deviceId })}
                      >
                        기기 제거
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>연결된 기기가 없습니다. 로컬 프로그램에서 새 코드를 만들고 승인하세요.</p>
          )}
        </section>
        <section className={styles.panel} aria-label="본인 기기 AI 설정">
          <h2 className="font-semibold">AI 설정</h2>
          <label className={styles.field}>
            설정할 AI 채팅방
            <select
              value={settingsRoomId}
              disabled={busy}
              onChange={(event) => {
                setSettingsRoomId(event.target.value);
                setSettingsDeviceId("");
              }}
            >
              {rooms.map((room) => (
                <option key={room.roomId} value={room.roomId}>
                  {room.organizationName} · {room.roomTitle}
                </option>
              ))}
            </select>
          </label>
          {availableDevices.length ? (
            <>
              <label className={styles.field}>
                설정할 본인 기기
                <select
                  value={settingsDevice?.deviceId ?? ""}
                  disabled={busy}
                  onChange={(event) => setSettingsDeviceId(event.target.value)}
                >
                  {availableDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.deviceAlias}
                    </option>
                  ))}
                </select>
              </label>
              {settingsDevice && (
                <RuntimeSettingsForm
                  key={settingsDevice.deviceId}
                  deviceId={settingsDevice.deviceId}
                  deviceAlias={settingsDevice.deviceAlias}
                  disabled={busy}
                />
              )}
            </>
          ) : (
            <p className="text-sm text-neutral-600">
              이 방에 인증이 유효한 본인 기기가 없습니다. 기기를 승인한 뒤 자기 PC에서 scope 확인과
              exchange를 완료하세요.
            </p>
          )}
          {settingsRoomId && (
            <Link href={`/app/rooms/${settingsRoomId}`} className="text-sm underline">
              이 AI 채팅방에서 질문만 하기
            </Link>
          )}
        </section>
      </div>
    </main>
  );
}
