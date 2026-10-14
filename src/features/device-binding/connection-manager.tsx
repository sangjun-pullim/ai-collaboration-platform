"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { messages, type ConnectionErrorCode, type OwnedDevice } from "./contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { RuntimeSettingsForm } from "../runtime-settings/runtime-settings-form";
import { LocalConnectionGuide } from "./local-connection-guide";
import { connectionSnapshot } from "./connection-presence";
import { consumeConnectionFragment } from "./local-connection-command";
import { ChatShell } from "../room-access/chat-shell";
import type { Room } from "../room-access/contracts";
import styles from "../room-access/access.module.css";
type RoomOption = {
  roomId: string;
  organizationId: string;
  roomTitle: string;
  organizationName: string;
};

function ConnectionCard({
  device,
  busy,
  onAction,
}: {
  device: OwnedDevice;
  busy: boolean;
  onAction: (action: "revoke" | "remove", deviceId: string) => void;
}) {
  return (
    <li className={styles.member}>
      <div>
        <strong>{device.deviceAlias}</strong>
        <p className="break-all text-xs" aria-label="공개 연결 ID">
          연결 ID: {device.deviceId}
        </p>
        <p>
          {device.state === "active"
            ? "등록 · 실행 미검증"
            : device.state === "removed"
              ? "제거됨 · 새 승인 필요"
              : "취소됨 · 새 승인 필요"}
        </p>
        <p>
          최근 수신:{" "}
          {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString("ko-KR") : "아직 없음"}
        </p>
        <p>
          인증 만료:{" "}
          {device.expiresAt ? new Date(device.expiresAt).toLocaleString("ko-KR") : "사용 불가"}
        </p>
        <Link href={`/app/rooms/${device.roomId}`}>연결한 방 보기</Link>
      </div>
      {device.state !== "removed" && (
        <div>
          {device.state === "active" && (
            <Button
              disabled={busy}
              variant="outline"
              aria-label={`${device.deviceAlias} 연결 취소`}
              onClick={() => onAction("revoke", device.deviceId)}
            >
              연결 취소
            </Button>
          )}
          <Button
            disabled={busy}
            variant="outline"
            aria-label={`${device.deviceAlias} 기기 제거`}
            onClick={() => onAction("remove", device.deviceId)}
          >
            기기 제거
          </Button>
        </div>
      )}
    </li>
  );
}

export function ConnectionManager({
  devices,
  rooms,
  origin,
  userId,
  navigationRooms = [],
  returnRoomId,
}: {
  devices: OwnedDevice[];
  rooms: RoomOption[];
  origin: string;
  userId: string;
  navigationRooms?: Room[];
  returnRoomId?: string;
}) {
  const router = useRouter();
  const returnRoom = navigationRooms.find((room) => room.id === returnRoomId);
  const initialRoomId = rooms.find((room) => room.roomId === returnRoom?.id)?.roomId;
  const alert = useRef<HTMLParagraphElement>(null);
  const confirmation = useRef<HTMLInputElement>(null);
  // StrictMode repeats effect setup after the fragment has already left the URL.
  const pendingFragment = useRef<{ hash: string } | null>(null);
  const approvedPairings = useRef(new Set<string>());
  const pendingRegistration = useRef<{
    roomId: string;
    deviceIds: Set<string>;
    deadline: number;
  } | null>(null);
  const settingsSection = useRef<HTMLElement>(null);
  const settingsEntryHandled = useRef(false);
  const approvalSection = useRef<HTMLElement>(null);
  const pendingApprovalFocus = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ConnectionErrorCode | null>(null);
  const [notice, setNotice] = useState("");
  const [roomId, setRoomId] = useState(
    initialRoomId ??
      devices.find(
        (device) =>
          device.state === "active" && rooms.some((room) => room.roomId === device.roomId),
      )?.roomId ??
      rooms[0]?.roomId ??
      "",
  );
  const [pairingCode, setPairingCode] = useState("");
  const [settingsDeviceId, setSettingsDeviceId] = useState("");
  const [registrationRoomId, setRegistrationRoomId] = useState<string | null>(null);
  const currentDevices = devices.filter((device) => device.state !== "removed");
  const removedDevices = devices.filter((device) => device.state === "removed");
  useEffect(() => {
    let active = true;
    const consume = (focusSettings: boolean) => {
      if (window.location.hash === "#ai-settings") {
        if (focusSettings) {
          settingsSection.current?.focus({ preventScroll: true });
          settingsSection.current?.scrollIntoView({ block: "start" });
        }
        return;
      }
      if (window.location.hash) {
        const hash = window.location.hash;
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
        pendingFragment.current = { hash };
      }
      const pending = pendingFragment.current;
      if (!pending) return;
      const pairing = consumeConnectionFragment(pending.hash, rooms);
      queueMicrotask(() => {
        if (!active || pendingFragment.current !== pending) return;
        pendingFragment.current = null;
        // A router refresh may restore the original URL fragment after it was scrubbed.
        if (pairing && approvedPairings.current.has(`${pairing.roomId}:${pairing.code}`)) return;
        if (confirmation.current) confirmation.current.checked = false;
        if (pairing) {
          setRoomId(pairing.roomId);
          setSettingsDeviceId("");
          pendingApprovalFocus.current = true;
        }
        setPairingCode(pairing?.code ?? "");
        setNotice("");
        setError(null);
      });
    };
    const focusOnEntry = !settingsEntryHandled.current;
    settingsEntryHandled.current = true;
    consume(focusOnEntry);
    const onHashChange = () => consume(true);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [rooms]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      const pending = pendingRegistration.current;
      if (!pending) return;
      const registered = devices.some(
        (device) =>
          device.roomId === pending.roomId &&
          !pending.deviceIds.has(device.deviceId) &&
          device.state === "active" &&
          device.expiresAt !== null &&
          Date.parse(device.expiresAt) > time,
      );
      if (registered || time >= pending.deadline) {
        pendingRegistration.current = null;
        setRegistrationRoomId(null);
        if (!registered)
          setNotice(
            "기기 등록을 확인하지 못했습니다. 터미널 상태를 확인한 뒤 연결 명령을 다시 실행하세요.",
          );
      } else if (document.visibilityState === "visible") router.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [devices, router]);
  const availableDevices = devices.filter(
    (device) =>
      device.state === "active" &&
      device.roomId === roomId &&
      device.expiresAt !== null &&
      Date.parse(device.expiresAt) > now,
  );
  const settingsDevice =
    availableDevices.find((device) => device.deviceId === settingsDeviceId) ?? availableDevices[0];
  const recent =
    !!settingsDevice &&
    connectionSnapshot({ devices: [settingsDevice], rooms }, new Date(now).toISOString()).state ===
      "connected";
  const awaitingRegistration = registrationRoomId === roomId;
  function changeRoom(value: string) {
    setRoomId(value);
    setSettingsDeviceId("");
    setPairingCode("");
    setNotice("");
    setError(null);
    if (confirmation.current) confirmation.current.checked = false;
  }
  useEffect(() => {
    if (pairingCode && pendingApprovalFocus.current) {
      pendingApprovalFocus.current = false;
      approvalSection.current?.focus({ preventScroll: true });
      approvalSection.current?.scrollIntoView({ block: "start" });
    }
  }, [pairingCode]);
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
          ? `기기 ${result.data.deviceAlias} 승인을 완료했습니다. 실행 중인 터미널에서 계정과 방을 확인하고 yes를 입력하세요. 등록이 끝나면 2단계에서 AI와 폴더를 설정하세요.`
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
      approvedPairings.current.add(`${room.roomId}:${String(fields.get("code"))}`);
      pendingRegistration.current = {
        roomId: room.roomId,
        deviceIds: new Set(devices.map((device) => device.deviceId)),
        deadline: Date.now() + 5 * 60 * 1000,
      };
      setRegistrationRoomId(room.roomId);
      setSettingsDeviceId("");
      form.reset();
      setPairingCode("");
    }
  }
  return (
    <ChatShell
      rooms={navigationRooms}
      roomId={returnRoom?.id}
      page="connections"
      title="내 AI 연결"
      actions={
        <Link
          href={returnRoom ? `/app/rooms/${returnRoom.id}` : "/app"}
          className="text-sm underline"
        >
          {returnRoom ? "이전 채팅방으로" : "채팅방 목록으로"}
        </Link>
      }
    >
      <div role="region" aria-label="AI 연결 설정 내용" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[960px] gap-4 px-4 py-4 md:px-6">
          <p className="text-sm text-neutral-600">
            내 AI를 제공할 때만 연결하세요.{" "}
            <Link href={roomId ? `/app/rooms/${roomId}` : "/app"} className="underline">
              질문만 하기
            </Link>
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {rooms.length > 0 && (
              <label className={styles.field}>
                AI를 제공할 채팅방
                <select
                  name="roomId"
                  aria-label="AI를 제공할 채팅방"
                  value={roomId}
                  disabled={busy}
                  onChange={(event) => changeRoom(event.target.value)}
                >
                  {rooms.map((room) => (
                    <option key={room.roomId} value={room.roomId}>
                      {room.organizationName} · {room.roomTitle}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {availableDevices.length > 0 && (
              <label className={styles.field}>
                설정할 본인 기기
                <select
                  aria-label="설정할 본인 기기"
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
            )}
          </div>
          <section className="grid gap-3 rounded-xl border p-4" aria-label="Mac 연결 단계">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">1. Mac 연결</h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="연결 상태 새로 확인"
                onClick={() => router.refresh()}
              >
                다시 확인
              </Button>
            </div>
            <p role="status" aria-label="Mac 연결 상태" className="text-sm text-neutral-600">
              {pairingCode
                ? "다음: 내 계정과 선택한 방을 확인하고 기기를 승인하세요."
                : awaitingRegistration
                  ? "다음: 실행 중인 터미널에서 내 계정과 방을 확인하고 yes를 입력하세요."
                  : recent
                    ? "Mac의 최근 통신이 확인되었습니다. 아래에서 AI를 설정하세요."
                    : "최근 통신을 확인하지 못했습니다. 다음: Mac에서 연결 명령을 실행하고 이 화면을 새로 확인하세요."}
            </p>
            {!recent && settingsDevice?.lastSeenAt && (
              <p className="text-xs text-neutral-500">
                마지막 수신: {new Date(settingsDevice.lastSeenAt).toLocaleString("ko-KR")}
              </p>
            )}
            <details
              tabIndex={-1}
              id="mac-connection"
              open={!recent && !pairingCode && !awaitingRegistration}
              className="text-sm"
            >
              <summary className="cursor-pointer text-sm">Mac 연결 명령·다시 연결</summary>
              <LocalConnectionGuide
                origin={origin}
                userId={userId}
                rooms={rooms}
                roomId={roomId}
                onRoomChange={changeRoom}
                showRoomSelection={false}
                prominent={!recent && !pairingCode && !awaitingRegistration}
                deviceAliasHint={settingsDevice?.deviceAlias}
                deviceIdHint={settingsDevice?.deviceId}
              />
            </details>
            <details open={!!pairingCode} className="text-sm" aria-label="기기 승인 안내">
              <summary className="cursor-pointer text-sm">웹에서 새 기기 승인</summary>
              <section
                ref={approvalSection}
                tabIndex={-1}
                aria-label="새 기기 승인"
                id="connection-approval"
                className="space-y-3"
              >
                <h3 className="font-semibold">새 기기 승인</h3>
                {rooms.length ? (
                  <form className={styles.form} onSubmit={approve}>
                    <p>
                      현재 로그인한 내 계정과 선택한 방에 연결합니다. 코드에 지정된 기기 별칭과 직접
                      확인한 저장소·세션 별칭, Git 브랜치·커밋, 최근 수신 시각이 방 참가자에게
                      공개됩니다. 실제 경로·세션 식별자·인증 정보는 로컬에만 보관합니다.
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
                      <input ref={confirmation} name="confirmed" type="checkbox" required /> 내
                      계정·선택한 방·기기 별칭과 공개 정보 범위를 확인했습니다
                    </label>
                    <Button
                      aria-label="기기 승인"
                      variant={pairingCode ? "default" : "outline"}
                      disabled={busy}
                    >
                      기기 승인
                    </Button>
                  </form>
                ) : (
                  <p>
                    승인할 수 있는 참가 방이 없습니다. 소유자 또는 참여자 권한의 초대를 받아 주세요.
                  </p>
                )}
              </section>
            </details>
            <details className="text-sm">
              <summary className="cursor-pointer">기존 수동 연결을 사용하는 경우</summary>
              <p className="mt-2 text-neutral-600">
                기존 pair 명령의 코드를 위에서 승인한 뒤, 자기 PC에서 계정·방을 확인하고 exchange를
                실행하세요. 같은 프로필로 manage를 실행하면 아래 AI 설정을 사용할 수 있습니다.
              </p>
            </details>
          </section>
          <section
            id="ai-settings"
            ref={settingsSection}
            tabIndex={-1}
            className="grid gap-3 rounded-xl border p-4"
            aria-label="본인 기기 AI 설정"
          >
            <h2 className="font-semibold">2. AI와 폴더 선택</h2>
            <p className="text-sm text-neutral-600">
              Claude 또는 Codex를 고르고 Mac에서 폴더를 확인하세요.
            </p>
            {availableDevices.length ? (
              <>
                {settingsDevice && (
                  <RuntimeSettingsForm
                    key={settingsDevice.deviceId}
                    deviceId={settingsDevice.deviceId}
                    deviceAlias={settingsDevice.deviceAlias}
                    disabled={busy || !!pairingCode || !!awaitingRegistration}
                    connectionRecent={recent}
                    roomHref={`/app/rooms/${roomId}`}
                    guidanceActive={!pairingCode && !awaitingRegistration}
                  />
                )}
              </>
            ) : (
              <p className="text-sm text-neutral-600">
                Mac 연결과 기기 등록을 마치면 AI와 폴더를 선택할 수 있습니다. 먼저 1단계를
                완료하세요.
              </p>
            )}
            {roomId && (
              <Link href={`/app/rooms/${roomId}`} className="text-sm underline">
                이 AI 채팅방에서 질문만 하기
              </Link>
            )}
          </section>
          {!settingsDevice && (
            <section className={styles.panel} aria-label="모델 선택과 채팅 시작">
              <h2 className="font-semibold">3. 모델 선택과 채팅 시작</h2>
              <p className="text-sm text-neutral-600">
                AI와 폴더를 확인한 뒤 모델을 선택하고 설정을 적용하세요.
              </p>
            </section>
          )}
          {error && (
            <p role="alert" aria-label="기기 연결 오류" tabIndex={-1} ref={alert}>
              {messages[error]}
              {error === "UNAVAILABLE" &&
                " 요청 결과가 미확정일 수 있습니다. 다시 승인하거나 새 연결을 만들기 전에 Mac 터미널에서 같은 연결의 승인 상태를 확인하세요."}
            </p>
          )}
          {notice && (
            <p role="status" aria-label="기기 연결 결과">
              {notice}
            </p>
          )}
          <details className={styles.panel}>
            <summary className="cursor-pointer text-sm">내 연결 관리</summary>
            {currentDevices.length ? (
              <ul className={styles.list}>
                {currentDevices.map((device) => (
                  <ConnectionCard
                    key={device.deviceId}
                    device={device}
                    busy={busy}
                    onAction={(action, deviceId) => void send(action, { deviceId })}
                  />
                ))}
              </ul>
            ) : (
              <p>연결된 기기가 없습니다. 로컬 프로그램에서 새 코드를 만들고 승인하세요.</p>
            )}
          </details>
          {removedDevices.length > 0 && (
            <details className={styles.panel}>
              <summary className="cursor-pointer text-sm">이전 연결 기록</summary>
              <ul className={styles.list}>
                {removedDevices.map((device) => (
                  <ConnectionCard
                    key={device.deviceId}
                    device={device}
                    busy={busy}
                    onAction={(action, deviceId) => void send(action, { deviceId })}
                  />
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </ChatShell>
  );
}
