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
    kind: "registration" | "communication";
    communicationDeviceId: string | null;
    lastSeen: Map<string, string | null>;
    roomId: string;
    deviceIds: Set<string>;
    deadline: number;
  } | null>(null);
  const settingsSection = useRef<HTMLElement>(null);
  const settingsEntryHandled = useRef(false);
  const approvalSection = useRef<HTMLElement>(null);
  const pendingApprovalFocus = useRef(false);
  const [showRecords, setShowRecords] = useState(false);
  const [showManagement, setShowManagement] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
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
      const registeredDevices = devices.filter(
        (device) =>
          device.roomId === pending.roomId &&
          !pending.deviceIds.has(device.deviceId) &&
          device.state === "active" &&
          device.expiresAt !== null &&
          Date.parse(device.expiresAt) > time,
      );
      const registered = registeredDevices.length > 0;
      // A heartbeat recheck is independent of where the copied command actually runs.
      const communication =
        pending.kind === "communication" &&
        devices.some(
          (device) =>
            device.roomId === pending.roomId &&
            device.deviceId === pending.communicationDeviceId &&
            device.state === "active" &&
            device.expiresAt !== null &&
            Date.parse(device.expiresAt) > time &&
            device.lastSeenAt !== null &&
            pending.lastSeen.has(device.deviceId) &&
            Date.parse(device.lastSeenAt) >
              Date.parse(pending.lastSeen.get(device.deviceId) ?? "1970-01-01"),
        );
      if (
        registeredDevices.length === 1 &&
        !devices.some(
          (device) =>
            device.deviceId === settingsDeviceId &&
            device.state === "active" &&
            device.roomId === pending.roomId &&
            device.expiresAt !== null &&
            Date.parse(device.expiresAt) > time,
        )
      )
        setSettingsDeviceId(registeredDevices[0].deviceId);
      if (registered || communication || time >= pending.deadline) {
        pendingRegistration.current = null;
        setRegistrationRoomId(null);
        if (pending.kind === "registration" && !registered)
          setNotice(
            "새 기기 등록 결과가 아직 도착하지 않았습니다. 기존 기기의 등록·설정은 유지됩니다. 승인한 연결의 터미널 상태를 확인하세요.",
          );
      } else if (document.visibilityState === "visible") router.refresh();
    }, 2500);
    return () => clearInterval(timer);
  }, [devices, router, settingsDeviceId]);
  const availableDevices = devices.filter(
    (device) =>
      device.state === "active" &&
      device.roomId === roomId &&
      device.expiresAt !== null &&
      Date.parse(device.expiresAt) > now,
  );
  const settingsDevice =
    availableDevices.find((device) => device.deviceId === settingsDeviceId) ??
    (availableDevices.length === 1 ? availableDevices[0] : undefined);
  const recent =
    !!settingsDevice &&
    connectionSnapshot({ devices: [settingsDevice], rooms }, new Date(now).toISOString()).state ===
      "connected";
  const awaitingRegistration = registrationRoomId === roomId;
  function changeRoom(value: string) {
    pendingRegistration.current = null;
    setRegistrationRoomId(null);
    setRoomId(value);
    setShowCommand(false);
    setShowApproval(false);
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
        kind: "registration",
        communicationDeviceId: null,
        lastSeen: new Map(devices.map((device) => [device.deviceId, device.lastSeenAt])),
        roomId: room.roomId,
        deviceIds: new Set(devices.map((device) => device.deviceId)),
        deadline: Date.now() + 5 * 60 * 1000,
      };
      setRegistrationRoomId(room.roomId);
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
        <div className="mx-auto grid w-full min-w-0 grid-cols-1 max-w-[880px] gap-6 px-4 py-8 md:px-8">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">내 AI를 채팅방에 연결</h1>
            <p className="text-sm text-neutral-600">
              내 Mac의 Claude 또는 Codex가 선택한 폴더를 읽고 답합니다.{" "}
              <Link href={roomId ? `/app/rooms/${roomId}` : "/app"} className="underline">
                연결 없이 질문만 하기
              </Link>
            </p>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
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
                  {availableDevices.length > 1 && !settingsDevice && (
                    <option value="">기기를 선택하세요</option>
                  )}
                  {availableDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.deviceAlias}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <section
            className="min-w-0 space-y-4 rounded-xl border bg-white p-5 sm:p-6"
            aria-label="Mac 연결 단계"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-3 font-semibold">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${recent ? "bg-emerald-50 text-emerald-700" : "bg-neutral-900 text-white"}`}
                >
                  {recent ? "✓" : "1"}
                </span>
                Mac 연결
              </h2>
              <div className="flex items-center gap-2">
                {recent && <span className="text-sm text-emerald-700">최근 통신 확인</span>}
                {recent && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={showCommand}
                    onClick={() => setShowCommand(!showCommand)}
                  >
                    다시 연결
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="연결 상태 새로 확인"
                  onClick={() => router.refresh()}
                >
                  상태 확인
                </Button>
              </div>
            </div>
            <p
              hidden={recent && !pairingCode && !awaitingRegistration && !showCommand}
              role="status"
              aria-label="Mac 연결 상태"
              className="text-sm text-neutral-600"
            >
              {pairingCode
                ? "다음: 내 계정과 선택한 방을 확인하고 기기를 승인하세요."
                : awaitingRegistration
                  ? "다음: 실행 중인 터미널에서 내 계정과 방을 확인하고 yes를 입력하세요."
                  : recent
                    ? "Mac과 통신하고 있습니다. 아래에서 AI와 폴더를 설정하세요."
                    : "Mac에서 연결 명령을 실행하세요. 실행한 터미널은 계속 열어 두세요."}
            </p>
            {!recent && settingsDevice?.lastSeenAt && (
              <p className="text-xs text-neutral-500">
                마지막 수신: {new Date(settingsDevice.lastSeenAt).toLocaleString("ko-KR")}
              </p>
            )}
            <div
              tabIndex={-1}
              id="mac-connection"
              hidden={(recent && !showCommand) || !!pairingCode || awaitingRegistration}
              className="text-sm"
            >
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
                onLaunch={() => {
                  setNotice("");
                  if (registrationRoomId !== roomId)
                    pendingRegistration.current = {
                      kind: "communication",
                      communicationDeviceId: settingsDevice?.deviceId ?? null,
                      lastSeen: new Map(
                        devices.map((device) => [device.deviceId, device.lastSeenAt]),
                      ),
                      roomId,
                      deviceIds: new Set(devices.map((device) => device.deviceId)),
                      deadline: Date.now() + 5 * 60 * 1000,
                    };
                  router.refresh();
                }}
              />
            </div>
            <div
              hidden={!pairingCode && !showApproval}
              className="rounded-lg border bg-neutral-50 p-4 text-sm"
              aria-label="기기 승인 안내"
            >
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
            </div>
            {!pairingCode && !awaitingRegistration && (!recent || showCommand) && (
              <Button
                type="button"
                variant="link"
                size="sm"
                aria-expanded={showApproval}
                onClick={() => setShowApproval(!showApproval)}
              >
                {showApproval ? "코드 입력 닫기" : "터미널에 연결 코드가 표시됐나요?"}
              </Button>
            )}
          </section>
          <section
            id="ai-settings"
            ref={settingsSection}
            tabIndex={-1}
            className="grid min-w-0 grid-cols-1 gap-4 rounded-xl border bg-white p-5 sm:p-6"
            aria-label="본인 기기 AI 설정"
          >
            <h2 className="sr-only">AI와 답변 설정</h2>
            {settingsDevice ? (
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
                {availableDevices.length > 1
                  ? "위에서 설정할 본인 기기를 선택하세요. 연결 명령은 실행하는 Mac의 저장 연결을 사용합니다."
                  : "Mac 연결과 기기 등록을 마치면 AI와 폴더를 선택할 수 있습니다."}
              </p>
            )}
          </section>
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
          <div className="border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              aria-expanded={showManagement}
              onClick={() => setShowManagement(!showManagement)}
            >
              기기 관리 · 연결 기록
            </Button>
            <section
              hidden={!showManagement}
              aria-label="연결 문제 해결"
              className="mt-3 space-y-4 rounded-xl border p-5"
            >
              <h2 className="font-semibold">등록한 기기 관리</h2>
              <p className="text-sm text-neutral-600">
                기기를 제거하면 다시 승인해야 합니다. 연결이 끊겼다면 먼저 위의 연결 명령을 다시
                실행하세요.
              </p>
              <Button variant="outline" onClick={() => setShowRecords(!showRecords)}>
                연결 기록 확인
              </Button>
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
              {showRecords && removedDevices.length > 0 && (
                <section aria-label="이전 연결 기록" className="border-t pt-4">
                  <h3 className="text-sm font-semibold">제거된 기기 기록</h3>
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
                </section>
              )}
              <p className="text-xs text-neutral-500">
                수동 pair·exchange 연결은 해당 Mac에서 같은 프로필로 manage를 실행하세요.
              </p>
            </section>
          </div>
        </div>
      </div>
    </ChatShell>
  );
}
