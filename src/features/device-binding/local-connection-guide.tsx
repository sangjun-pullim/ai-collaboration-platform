"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  connectionOrigin,
  localConnectionCommand,
  parseConnectionManifest,
  type ConnectionManifest,
  connectionSelectionKey,
  readConnectionSelection,
  nextConnectionSelection,
  type ConnectionSelection,
} from "./local-connection-command";

import { requestSetup, type IssuedLaunch } from "../connection-setup/setup-controller";
import { SetupStatus } from "../connection-setup/setup-status";

type Room = { roomId: string; organizationId: string; roomTitle: string; organizationName: string };

async function readManifest(origin: string, signal: AbortSignal): Promise<ConnectionManifest> {
  const response = await fetch(`${connectionOrigin(origin)}/local-connection/manifest.json`, {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    throw new Error("DISTRIBUTION_UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("DISTRIBUTION_UNAVAILABLE");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("MANIFEST_SIZE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return parseConnectionManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

export function LocalConnectionGuide({
  origin,
  userId,
  rooms,
  roomId,
  onRoomChange,
  showRoomSelection = true,
  prominent = true,
  deviceAliasHint,
  deviceIdHint,
  onLaunch,
}: {
  origin: string;
  userId: string;
  rooms: Room[];
  roomId: string;
  onRoomChange: (value: string) => void;
  showRoomSelection?: boolean;
  prominent?: boolean;
  deviceAliasHint?: string;
  deviceIdHint?: string;
  onLaunch?: () => void;
}) {
  const [issued, setIssued] = useState<{ scope: string; value: IssuedLaunch } | null>(null);
  const currentKey = useRef("");
  const [copying, setCopying] = useState(false);
  const [expiredScope, setExpiredScope] = useState<string | null>(null);
  const [deviceAlias, setDeviceAlias] = useState("내 Mac");
  const [manifestReceipt, setManifest] = useState<{
    origin: string;
    value: ConnectionManifest;
  } | null>(null);
  const [prepared, setCommand] = useState<{ key: string; value: string } | null>(null);
  const [failure, setError] = useState<{ key: string; value: string } | null>(null);
  const [copied, setNotice] = useState<{ command: string; value: string } | null>(null);
  const commandField = useRef<HTMLTextAreaElement>(null);
  const preparingRef = useRef(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const scopeKey = rooms.some((item) => item.roomId === roomId)
    ? connectionSelectionKey(origin, userId, roomId)
    : "";
  const [selectionReceipt, setSelection] = useState<{
    key: string;
    raw: string | null;
    value: ConnectionSelection;
  } | null>(null);
  const [storageFailure, setStorageFailure] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [recoveryDialog, setRecoveryDialog] = useState<{ key: string; confirmed: boolean } | null>(
    null,
  );
  const [preparing, setPreparing] = useState<string | null>(null);
  const selection = selectionReceipt?.key === scopeKey ? selectionReceipt : null;
  const blocked = storageFailure?.key === scopeKey ? storageFailure.message : "";
  const recovering = recoveryDialog?.key === scopeKey ? recoveryDialog : null;
  const room = rooms.find((item) => item.roomId === roomId);
  const manifest = manifestReceipt?.origin === origin ? manifestReceipt.value : null;
  const key = JSON.stringify([
    origin,
    userId,
    roomId,
    room?.organizationId,
    deviceAlias,
    manifest?.bootstrap.sha256,
    selection?.raw,
    selection?.value.baseProfile,
  ]);
  const command =
    selection && !blocked && !recovering && preparing !== scopeKey && prepared?.key === key
      ? prepared.value
      : "";
  const error = failure?.key === key || failure?.key === `manifest:${origin}` ? failure.value : "";
  const notice = command && copied?.command === command ? copied.value : "";
  useEffect(() => {
    if (!scopeKey) return;
    let live = true;
    const load = async () => {
      try {
        const raw = window.localStorage.getItem(scopeKey);
        const value = await readConnectionSelection(raw, origin, userId, roomId);
        if (window.localStorage.getItem(scopeKey) !== raw) throw new Error("SELECTION_CHANGED");
        if (live) {
          setSelection({ key: scopeKey, raw, value });
          setStorageFailure(null);
        }
      } catch {
        if (live)
          setStorageFailure({
            key: scopeKey,
            message:
              "연결 선택을 읽지 못했습니다. 브라우저 저장소를 확인한 뒤 현재 선택을 다시 확인하세요.",
          });
      }
    };
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === scopeKey)
        setStorageFailure({
          key: scopeKey,
          message: "다른 탭에서 연결 선택이 바뀌었습니다. 현재 선택을 다시 확인한 뒤 복사하세요.",
        });
    };
    void load();
    window.addEventListener("storage", changed);
    return () => {
      live = false;
      window.removeEventListener("storage", changed);
    };
  }, [scopeKey, origin, userId, roomId]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    readManifest(origin, controller.signal)
      .then(
        (value) => {
          if (live) {
            setManifest({ origin, value });
            setError(null);
          }
        },
        () => {
          if (live)
            setError({
              key: `manifest:${origin}`,
              value: "연결 명령을 준비하지 못했습니다. 잠시 뒤 페이지를 새로고침하세요.",
            });
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [origin]);
  useEffect(() => {
    currentKey.current = key;
    return () => {
      if (currentKey.current === key) currentKey.current = "";
    };
  }, [key]);
  useEffect(() => {
    if (!issued) return;
    const timer = setTimeout(
      () => setExpiredScope(issued.scope),
      Math.max(0, Date.parse(issued.value.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [issued]);
  async function confirmSelection() {
    setSelection(null);
    setRecoveryDialog(null);
    try {
      const raw = window.localStorage.getItem(scopeKey);
      const value = await readConnectionSelection(raw, origin, userId, roomId);
      if (window.localStorage.getItem(scopeKey) !== raw) throw new Error("SELECTION_CHANGED");
      setSelection({ key: scopeKey, raw, value });
      setStorageFailure(null);
    } catch {
      setStorageFailure({
        key: scopeKey,
        message:
          "저장된 연결 선택을 확인할 수 없습니다. 브라우저 저장소와 선택한 계정·방을 확인하세요.",
      });
    }
  }
  async function prepareRecoveryCommand() {
    if (!selection || !recovering?.confirmed || blocked || preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(scopeKey);
    try {
      if (window.localStorage.getItem(scopeKey) !== selection.raw)
        throw new Error("SELECTION_CHANGED");
      const value = await nextConnectionSelection(selection.value, crypto.randomUUID());
      if (window.localStorage.getItem(scopeKey) !== selection.raw)
        throw new Error("SELECTION_CHANGED");
      const raw = JSON.stringify(value);
      window.localStorage.setItem(scopeKey, raw);
      if (window.localStorage.getItem(scopeKey) !== raw) throw new Error("SELECTION_CHANGED");
      setSelection({ key: scopeKey, raw, value });
      setRecoveryDialog(null);
    } catch {
      setStorageFailure({
        key: scopeKey,
        message:
          "새 연결 선택을 저장하지 못했거나 다른 탭에서 바뀌었습니다. 현재 선택을 다시 확인하세요.",
      });
    } finally {
      preparingRef.current = false;
      setPreparing(null);
    }
  }
  async function copy(fresh = false) {
    if (!manifest || !room || !selection || blocked || preparingRef.current) return;
    const requestedKey = key;
    let command = !fresh && prepared?.key === key ? prepared.value : "";
    try {
      if (window.localStorage.getItem(scopeKey) !== selection.raw)
        throw new Error("SELECTION_CHANGED");
      preparingRef.current = true;
      setCopying(true);
      if (
        !command ||
        !issued ||
        issued.scope !== key ||
        Date.parse(issued.value.expiresAt) <= Date.now()
      ) {
        const result = (await requestSetup(
          "issue",
          { requestId: crypto.randomUUID(), roomId, deviceAlias, selection: selection.value },
          AbortSignal.timeout(10000),
        )) as IssuedLaunch;
        if (currentKey.current !== requestedKey) return;
        if (window.localStorage.getItem(scopeKey) !== selection.raw)
          throw new Error("SELECTION_CHANGED");
        if (!result.key || !result.created) throw new Error("REISSUE_REQUIRED");
        command = await localConnectionCommand({
          origin,
          userId,
          roomId,
          organizationId: room.organizationId,
          deviceAlias,
          manifest,
          selection: selection.value,
          launch: { key: result.key, payloadHash: result.payloadHash },
        });
        if (currentKey.current !== requestedKey) return;
        if (window.localStorage.getItem(scopeKey) !== selection.raw)
          throw new Error("SELECTION_CHANGED");
        setIssued({ scope: key, value: result });
        setCommand({ key, value: command });
        onLaunch?.();
      }
      setError(null);
    } catch {
      if (currentKey.current === requestedKey)
        setError({
          key,
          value: "연결 명령을 발급하지 못했습니다. 같은 연결 선택으로 새 명령을 복사하세요.",
        });
      return;
    } finally {
      preparingRef.current = false;
      setCopying(false);
    }
    if (currentKey.current !== requestedKey) return;
    try {
      if (window.localStorage.getItem(scopeKey) !== selection.raw)
        throw new Error("SELECTION_CHANGED");
      await navigator.clipboard.writeText(command);
      setNotice({ command, value: "명령을 복사했습니다. 내 Mac의 터미널에 붙여 넣어 실행하세요." });
    } catch {
      if (commandField.current) commandField.current.value = command;
      setShowRaw(true);
      const panel = commandField.current?.closest<HTMLElement>("[data-command-panel]");
      if (panel) panel.hidden = false;
      commandField.current?.focus();
      commandField.current?.select();
      setNotice({ command, value: "아래 명령을 선택했습니다. 직접 복사해 터미널에서 실행하세요." });
    }
  }
  return (
    <section className="space-y-4" aria-label="명령 한 번으로 내 Mac 연결">
      {showRoomSelection && <h3 className="font-semibold">Mac 연결</h3>}
      <ol
        className="grid gap-2 text-sm text-neutral-600 sm:grid-cols-3"
        aria-label="터미널 연결 순서"
      >
        <li>① 아래 명령 복사</li>
        <li>② Mac 터미널에서 실행</li>
        <li>③ 안내에 따라 계정 확인</li>
      </ol>
      <Button
        type="button"
        aria-label="연결 명령 복사"
        variant={prominent ? "default" : "outline"}
        disabled={!manifest || !selection || !!blocked || !!recovering || copying}
        onClick={() => copy()}
      >
        {copying
          ? "명령 준비 중"
          : issued?.scope === key && expiredScope === key
            ? "새 명령 복사"
            : "연결 명령 복사"}
      </Button>
      <p className="text-xs text-neutral-500">
        별도 앱 설치 없이 실행합니다. 연결 중에는 터미널을 열어 두세요.
      </p>
      {rooms.length === 0 && (
        <p className="text-sm">참가한 채팅방을 선택해야 연결 명령을 만들 수 있습니다.</p>
      )}
      {blocked && (
        <div role="alert" aria-label="연결 선택 확인 필요" className="text-sm">
          <p>{blocked}</p>
          <Button type="button" variant="outline" onClick={confirmSelection}>
            현재 선택 다시 확인
          </Button>
        </div>
      )}
      {preparing === scopeKey && <p role="status">새 승인 명령을 준비하고 있습니다.</p>}
      {issued?.scope === key && (
        <SetupStatus
          key={issued.value.requestId}
          roomId={roomId}
          requestId={issued.value.requestId}
          onRetry={() => {
            void copy(true);
          }}
          onFreshApproval={() => {
            setShowOptions(true);
            setRecoveryDialog({ key: scopeKey, confirmed: false });
          }}
        />
      )}
      {notice && (
        <p role="status" aria-label="연결 명령 복사 결과" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" aria-label="연결 명령 준비 오류" className="text-sm">
          {error}
        </p>
      )}
      {!manifest && !error && (
        <p role="status" aria-label="연결 명령 준비 상태" className="text-sm text-neutral-500">
          연결 명령을 준비하고 있습니다.
        </p>
      )}
      <div className="flex flex-wrap gap-1 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showOptions}
          onClick={() => setShowOptions(!showOptions)}
        >
          연결 옵션
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={showRaw}
          onClick={() => setShowRaw(!showRaw)}
        >
          명령 직접 복사
        </Button>
      </div>
      <section
        hidden={!showOptions}
        aria-label="연결 추가 옵션"
        className="rounded-lg border bg-neutral-50 p-4 text-sm"
      >
        <h3 className="font-medium">연결 옵션</h3>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {showRoomSelection && (
              <label className="grid gap-1 text-sm">
                AI를 제공할 채팅방
                <select
                  className="rounded-md border p-2"
                  value={roomId}
                  onChange={(event) => onRoomChange(event.target.value)}
                >
                  {rooms.map((item) => (
                    <option key={item.roomId} value={item.roomId}>
                      {item.organizationName} · {item.roomTitle}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="grid gap-1 text-sm">
              내 기기 이름
              <Input
                value={deviceAlias}
                onChange={(event) => setDeviceAlias(event.target.value)}
                maxLength={40}
              />
            </label>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!selection || !!blocked || preparing === scopeKey}
            onClick={() => setRecoveryDialog({ key: scopeKey, confirmed: false })}
          >
            새 승인으로 다시 연결
          </Button>
          {recovering && (
            <div className="space-y-2 rounded-md border p-3 text-sm" aria-label="새 승인 연결 확인">
              <p>
                기존 AI 기록은 그대로 보존합니다. 만료된 연결은 새 웹 승인이 필요하며,
                AI·폴더·모델은 다시 선택합니다.
              </p>
              <p>
                기존 터미널 실행을 종료하세요. 준비만 하고 실행하지 않은 명령은 건너뛰고 실제 로컬
                기록을 확인합니다. 유효한 연결은 기존 설정을 유지해 재사용합니다. 만료된 연결을 새로
                승인하는 경우에만 공개 연결 ID를 보여 줍니다. 이때 내 연결 카드에서 같은 ID인 본인
                연결만 연결 취소하고 터미널에서 완료를 확인하세요.
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={recovering.confirmed}
                  onChange={(event) =>
                    setRecoveryDialog({ key: scopeKey, confirmed: event.target.checked })
                  }
                />
                이전 연결의 터미널 실행을 종료했습니다
              </label>
              <Button
                type="button"
                disabled={!recovering.confirmed || preparing === scopeKey || !!blocked}
                onClick={prepareRecoveryCommand}
              >
                새 승인 명령 준비
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={preparing === scopeKey}
                onClick={() => setRecoveryDialog(null)}
              >
                취소
              </Button>
            </div>
          )}
        </div>
      </section>

      <section
        hidden={!showRaw}
        data-command-panel
        aria-label="명령 직접 복사 영역"
        className="min-w-0 text-sm"
      >
        <h3 className="font-medium">명령 직접 복사</h3>
        {deviceAliasHint && (
          <p className="mt-2 break-all text-xs text-neutral-600">
            현재 설정 대상: {deviceAliasHint} ({deviceIdHint}). 명령은 이 방의 브라우저 저장 연결을
            재사용합니다. 기기 선택을 바꿔도 다른 기기의 명령으로 전환되지 않습니다. Mac 터미널의
            공개 연결 ID가 설정 대상과 같은지 확인하세요.
          </p>
        )}
        <textarea
          ref={commandField}
          aria-label="로컬 연결 명령"
          readOnly
          value={command}
          rows={8}
          className="mt-2 w-full rounded-md border bg-neutral-50 p-3 font-mono text-xs"
        />
      </section>
    </section>
  );
}
