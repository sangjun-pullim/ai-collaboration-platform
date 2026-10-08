"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { callInvestigation } from "./investigation-client";
import { WorkflowError, type InputState, type InputStates, type PublicBinding } from "./contracts";
import { pollingDelay } from "./polling-policy";
import {
  adoptInputState,
  projectOwnInputStates,
  inputIntent,
  inputIntentKey,
  inputReceipt,
  inputStatus,
  restoreInputIntent,
  type InputIntent,
} from "./own-input-control-state";

type Props = { userId: string; roomId: string; bindings: PublicBinding[] };
export function OwnInputControls({ userId, roomId, bindings }: Props) {
  const [states, setStates] = useState<Record<string, InputState>>({});
  const current = useRef(states);
  const [pending, setPending] = useState<InputIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(false);
  const working = useRef(false);
  const latestPins = useRef<readonly (readonly [string, number])[]>([]);
  const pendingRef = useRef<InputIntent | null>(pending);
  const mutation = useRef<AbortController | null>(null);
  const owned = bindings.filter((binding) => binding.owned);
  const scope = JSON.stringify(owned.map((binding) => [binding.agentId, binding.bindingEpoch]));
  useLayoutEffect(() => {
    latestPins.current = JSON.parse(scope) as [string, number][];
    pendingRef.current = pending;
  }, [scope, pending]);
  useEffect(() => {
    mounted.current = true;
    let restored: InputIntent | null = null;
    try {
      restored = restoreInputIntent(sessionStorage, userId, roomId);
    } catch {
      /* Storage access can fail. */
    }
    queueMicrotask(() => {
      if (mounted.current) setPending(restored);
    });
    return () => {
      mounted.current = false;
      mutation.current?.abort();
    };
  }, [userId, roomId]);
  useEffect(() => {
    const pins = JSON.parse(scope) as [string, number][];
    if (!pins.length) return;
    let stopped = false,
      failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const value = (await callInvestigation(
          "input-state",
          { protocol: 1, roomId },
          controller.signal,
        )) as InputStates;
        if (stopped || controller.signal.aborted) return;
        const next = projectOwnInputStates(current.current, value, roomId, pins);
        current.current = next;
        setStates(next);
        setUnavailable(false);
        failures = 0;
      } catch {
        if (stopped || controller.signal.aborted) return;
        setUnavailable(true);
        failures++;
      }
      const waiting =
        !!pendingRef.current ||
        Object.values(current.current).some(
          (state) =>
            state.appliedRevision !== state.revision || state.appliedEpoch !== state.bindingEpoch,
        );
      timer = setTimeout(poll, pollingDelay(waiting, document.hidden, failures));
    }
    timer = setTimeout(poll, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, roomId, tick]);
  async function send(intent: InputIntent) {
    if (working.current || intent.body.expectedUserId !== userId || intent.body.roomId !== roomId)
      return;
    working.current = true;
    setBusy(true);
    setMessage(null);
    const controller = new AbortController();
    mutation.current = controller;
    try {
      // Persist before transmitting, and always replay the same body after uncertain delivery.
      sessionStorage.setItem(inputIntentKey(userId, roomId), JSON.stringify(intent));
      setPending(intent);
      const value = await callInvestigation("input-control", intent.body, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const receipt = inputReceipt(intent, value);
      const pin = latestPins.current.find(([id]) => id === receipt.agentId);
      if (pin && pin[1] === receipt.bindingEpoch) {
        const accepted = adoptInputState(
          current.current[receipt.agentId],
          receipt,
          receipt.agentId,
          pin[1],
        );
        if (accepted) {
          current.current = { ...current.current, [receipt.agentId]: accepted };
          setStates(current.current);
        }
      }
      // The exact operation receipt resolves delivery; fresh reads resolve current state separately.
      sessionStorage.removeItem(inputIntentKey(userId, roomId));
      setPending(null);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const code = error instanceof WorkflowError ? error.code : "UNAVAILABLE";
      setMessage("전송 결과 미확정 · 같은 요청을 확인해 주세요.");
      if (code !== "UNAVAILABLE") {
        try {
          sessionStorage.removeItem(inputIntentKey(userId, roomId));
          setPending(null);
        } catch {
          /* Retain the exact intent when removal fails. */
        }
        setMessage("상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 선택해 주세요.");
      }
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        setTick((value) => value + 1);
      }
    }
  }
  if (!owned.length) return null;
  return (
    <div aria-label="내 AI 새 답변 제어" className="shrink-0 space-y-2 border-b px-5 py-2 text-xs">
      {owned.map((binding) => {
        const state =
          states[binding.agentId]?.bindingEpoch === binding.bindingEpoch
            ? states[binding.agentId]
            : undefined;
        const aliasId = `own-input-${roomId}-${binding.agentId}-alias`;
        const statusId = `own-input-${roomId}-${binding.agentId}-status`;
        const target = `${binding.repositoryAlias} · ${binding.sessionAlias}`;
        return (
          <div key={binding.agentId} className="flex flex-wrap items-center gap-2">
            <span id={aliasId}>{target}</span>
            <span
              id={statusId}
              role="status"
              aria-labelledby={aliasId}
              className="text-neutral-500"
            >
              {inputStatus(state, unavailable)}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={`${target} 새 답변 ${state?.paused ? "재개" : "일시정지"}`}
              aria-describedby={statusId}
              disabled={busy || !!pending || !state || unavailable}
              onClick={() => state && send(inputIntent(userId, roomId, state, crypto.randomUUID()))}
            >
              {state?.paused ? "내 AI 새 답변 재개" : "내 AI 새 답변 일시정지"}
            </Button>
          </div>
        );
      })}
      <p className="text-neutral-500">이미 실행 준비를 시작한 답변은 계속됩니다.</p>
      {pending && (
        <p role="status">
          전송 결과 미확정{" "}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => send(pending)}>
            같은 요청 확인
          </Button>
        </p>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
