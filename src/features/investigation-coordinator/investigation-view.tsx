"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  WorkflowError,
  type HumanAction,
  type Body,
  type HistoryPage,
  type PublicBinding,
} from "./contracts";
import { emptyHistory, mergeHistory } from "./history-state";
import { pollingDelay } from "./polling-policy";
import { callInvestigation as call } from "./investigation-client";
import {
  directIntentKey,
  restoreDirectIntent,
  mutationBody,
  type DirectIntent,
} from "./direct-intents";

import { OwnInputControls } from "./own-input-controls";
import { ChatTimeline } from "./chat-timeline";
import { ChatComposer } from "./chat-composer";
import { AdvancedControls } from "./advanced-controls";
import { nearTimelineBottom } from "./chat-presentation";
import { Button } from "../../components/ui/button";

const labels: Record<string, string> = {
  QUEUED: "대기",
  LEASED: "실행 준비 보고",
  RUNNING: "실행 보고 · provider 미검증",
  UNKNOWN: "종결 미확인 · 사람 확인 필요",
  COMPLETED: "완료 보고",
  FAILED: "실패 보고",
  INTERRUPTED: "중단 확인 보고",
  CANCELLED: "시작 전 취소",
  ACTIVE: "활성",
  HUMAN_INPUT_REQUIRED: "사람 확인 필요",
  PAUSING: "중단 확인 대기",
  PAUSED: "일시정지 확인",
  PENDING: "후속 채택 대기",
  ACCEPTED: "현재 조사 채택",
  HISTORICAL: "과거 기록 · 미채택",
};
const denied = (code: string) => ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(code);

type Props = { userId: string; roomId: string; role: "owner" | "participant" | "observer" };

export function InvestigationView(props: Props) {
  return <RoomInvestigation key={`${props.userId}:${props.roomId}`} {...props} />;
}
function RoomInvestigation({ userId, roomId, role }: Props) {
  const [history, setHistory] = useState(() => emptyHistory(roomId));
  const historyRef = useRef(history);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [originId, setOriginId] = useState("");
  const [peerId, setPeerId] = useState("");
  const [targetPin, setTargetPin] = useState<{ agentId: string; epoch: number } | null | undefined>(
    undefined,
  );
  const [pendingDirect, setPendingDirect] = useState<DirectIntent | null>(null);
  const [tick, setTick] = useState(0);
  const [observedAt, setObservedAt] = useState(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);
  const mounted = useRef(false);
  const pendingKey = directIntentKey(userId, roomId);
  const error = actionError ?? pollError;
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"ask" | "speak">("ask");
  const [unread, setUnread] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latestSequence = useRef(0);
  const accessLost = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const sequence =
      history.events.filter((event) => event.kind !== "RUN_STATE").at(-1)?.sequence ?? 0;
    if (element && sequence > latestSequence.current) {
      if (follow.current) element.scrollTop = element.scrollHeight;
      else setUnread(true);
    }
    latestSequence.current = sequence;
  }, [history.events]);

  useEffect(() => {
    mounted.current = true;
    // Restore only this authenticated actor's exact public intent.
    try {
      const intent = restoreDirectIntent(sessionStorage, userId, roomId);
      if (intent)
        queueMicrotask(() => {
          if (mounted.current) setPendingDirect(intent);
        });
    } catch {
      /* Access to sessionStorage itself may be unavailable; fail closed. */
    }
    return () => {
      mounted.current = false;
      mutationAbort.current?.abort();
    };
  }, [userId, roomId]);
  useEffect(() => {
    if (permissionDenied || mutationPending.current) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let state = historyRef.current;
    const controller = new AbortController();
    pollAbort.current = controller;
    async function poll() {
      if (stopped || controller.signal.aborted) return;
      let backfill = false;
      try {
        const page = (await call(
          "read",
          { protocol: 1, roomId, afterSequence: state.cursor },
          controller.signal,
        )) as HistoryPage;
        if (stopped || controller.signal.aborted) return;
        state = mergeHistory(state, page);
        historyRef.current = state;
        setHistory(state);
        setObservedAt(Date.now());
        failures = 0;
        setPollError(null);
        backfill = page.hasMore || state.gap;
      } catch (failure) {
        if (stopped || controller.signal.aborted) return;
        const code = failure instanceof WorkflowError ? failure.code : "UNAVAILABLE";
        setPollError(
          denied(code)
            ? "접근 권한을 확인해 주세요."
            : "공동 기록을 불러올 수 없습니다. 다시 시도합니다.",
        );
        if (denied(code)) {
          controller.abort();
          historyRef.current = emptyHistory(roomId);
          setHistory(historyRef.current);
          setPermissionDenied(true);
          return;
        }
        failures++;
      }
      const active =
        backfill || state.runs.some((run) => ["QUEUED", "LEASED", "RUNNING"].includes(run.state));
      timer = setTimeout(poll, pollingDelay(active, document.hidden, failures));
    }
    timer = setTimeout(poll, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [roomId, tick, permissionDenied]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // The user/room key remounts this callback; refs always hold the latest requests.
  const [loseAccess] = useState(() => () => {
    accessLost.current = true;
    pollAbort.current?.abort();
    mutationAbort.current?.abort();
    historyRef.current = emptyHistory(roomId);
    setHistory(historyRef.current);
    setPermissionDenied(true);
    setPollError("접근 권한을 확인해 주세요.");
  });

  const snapshot = history.snapshot;
  const bindings = snapshot?.bindings ?? [];
  const origin = bindings.find((binding) => binding.agentId === originId);
  const peer = bindings.find((binding) => binding.agentId === peerId);
  const cycle = snapshot?.cycle;
  const pairedCycle = cycle && !("mode" in cycle) ? cycle : null;
  const directCycle = cycle && "mode" in cycle ? cycle : null;
  const writable = role !== "observer" && !permissionDenied;
  const cycleOwned =
    !!pairedCycle &&
    bindings.some((binding) => binding.agentId === pairedCycle.originAgentId && binding.owned);
  const blocked = history.runs.some((run) =>
    ["QUEUED", "LEASED", "RUNNING", "UNKNOWN"].includes(run.state),
  );
  const ready = (binding: PublicBinding | undefined) =>
    !!binding?.reportedReady && !!binding.validUntil && Date.parse(binding.validUntil) > observedAt;
  const availableTargets = bindings.filter((binding) => !binding.owned && ready(binding));
  const target = targetPin
    ? availableTargets.find(
        (binding) =>
          binding.agentId === targetPin.agentId && binding.bindingEpoch === targetPin.epoch,
      )
    : targetPin === undefined && availableTargets.length === 1
      ? availableTargets[0]
      : undefined;
  // Undefined means no selection yet; null means the person explicitly cleared it.
  // Pin the initial single responder once so later observations cannot replace its epoch.
  if (targetPin === undefined && availableTargets.length === 1) {
    const binding = availableTargets[0];
    setTargetPin({ agentId: binding.agentId, epoch: binding.bindingEpoch });
  }
  const directRun = directCycle
    ? snapshot?.runs.find((run) => run.cycleId === directCycle.cycleId)
    : undefined;

  async function mutate(action: HumanAction, fields: Body, retryBody?: Body) {
    if (
      !snapshot ||
      !writable ||
      accessLost.current ||
      mutationPending.current ||
      (pendingDirect && !retryBody)
    )
      return false;
    mutationPending.current = true;
    pollAbort.current?.abort();
    const controller = new AbortController();
    mutationAbort.current = controller;
    setBusy(true);
    setActionError(null);
    let directIntent = false;
    const clearIntent = () => {
      try {
        sessionStorage.removeItem(pendingKey);
      } catch {
        throw new WorkflowError("UNAVAILABLE");
      }
      setPendingDirect(null);
    };
    try {
      const body = mutationBody(action, fields, userId, roomId, retryBody);
      if (action === "ask" || action === "cancel") {
        const intent = { action, body };
        sessionStorage.setItem(pendingKey, JSON.stringify(intent));
        setPendingDirect(intent);
        directIntent = true;
      }
      await call(action, body, controller.signal);
      if (!mounted.current || controller.signal.aborted) return false;
      if (directIntent) clearIntent();
      return true;
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return false;
      const code = failure instanceof WorkflowError ? failure.code : "UNAVAILABLE";
      if (directIntent && code !== "UNAVAILABLE") {
        try {
          clearIntent();
        } catch {
          /* Retain the exact intent if storage removal fails. */
        }
      }
      setActionError(
        code === "CONFLICT"
          ? "상태가 바뀌었습니다. 기록을 갱신한 뒤 다시 시도해 주세요."
          : "요청을 완료할 수 없습니다. 접근 권한과 연결 보고를 확인해 주세요.",
      );
      if (denied(code)) {
        historyRef.current = emptyHistory(roomId);
        setHistory(historyRef.current);
        setPermissionDenied(true);
      }
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) {
        setBusy(false);
        setTick((value) => value + 1);
      }
    }
  }
  async function speak(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!draft.trim() || busy || pendingDirect) return false;
    const sent = await mutate("speak", { publicText: String(new FormData(form).get("speech")) });
    if (sent) {
      form.reset();
      setDraft("");
    }
    return sent;
  }
  async function start(event: FormEvent<HTMLFormElement>, resume = false) {
    event.preventDefault();
    if (!origin || !peer || !snapshot) return;
    const form = event.currentTarget;
    if (
      await mutate(resume ? "resume" : "start", {
        originAgentId: origin.agentId,
        peerAgentId: peer.agentId,
        originEpoch: origin.bindingEpoch,
        peerEpoch: peer.bindingEpoch,
        expectedRoomRevision: snapshot.roomRevision,
        publicText: String(new FormData(form).get("direction")),
        confirmed: true,
        ...(resume && cycle ? { mode: "cycle", cycleId: cycle.cycleId } : {}),
      })
    )
      form.reset();
  }
  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || !snapshot || askDisabled || !draft.trim()) return false;
    const form = event.currentTarget;
    const sent = await mutate("ask", {
      targetAgentId: target.agentId,
      targetEpoch: target.bindingEpoch,
      expectedRoomRevision: snapshot.roomRevision,
      publicText: String(new FormData(form).get("humanQuestion")),
      confirmed: true,
    });
    if (sent) {
      form.reset();
      setDraft("");
    }
    return sent;
  }
  function bindingOption(binding: PublicBinding) {
    return (
      <option value={binding.agentId} key={binding.agentId}>
        {binding.ownerAlias} · {binding.runtime} · {binding.repositoryAlias} ·{" "}
        {binding.sessionAlias}
      </option>
    );
  }
  const askDisabled =
    busy ||
    !!pendingDirect ||
    !target ||
    snapshot?.roomMode !== "ACTIVE" ||
    cycle?.state === "ACTIVE" ||
    blocked;
  return (
    <section
      aria-label="실제 공동 조사"
      className="flex min-h-0 min-w-0 flex-1 flex-col [overflow-wrap:anywhere]"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-5 py-2">
        <p role="status" aria-label="방 상태" className="text-xs text-neutral-500">
          방: {snapshot ? labels[snapshot.roomMode] : "조회 중"}
          {cycle ? ` · 조사: ${labels[cycle.state]}` : ""}
        </p>
        {writable && (
          <AdvancedControls>
            {" "}
            <p>조사 시작에는 서로 다른 참가자의 현재 준비 보고 두 개와 공유 확인이 필요합니다.</p>
            <form onSubmit={(event) => start(event)}>
              <label>
                내 AI
                <select value={originId} onChange={(event) => setOriginId(event.target.value)}>
                  <option value="">선택</option>
                  {bindings.filter((binding) => binding.owned).map(bindingOption)}
                </select>
              </label>
              <label>
                상대 AI
                <select value={peerId} onChange={(event) => setPeerId(event.target.value)}>
                  <option value="">선택</option>
                  {bindings.filter((binding) => !binding.owned).map(bindingOption)}
                </select>
              </label>
              <label>
                공유 조사 방향
                <textarea
                  name="direction"
                  required
                  maxLength={4000}
                  style={{ display: "block", maxWidth: "100%" }}
                />
              </label>
              <label>
                <input type="checkbox" required /> 이 내용을 두 참가자에게 공유합니다
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  !ready(origin) ||
                  !ready(peer) ||
                  snapshot?.roomMode !== "ACTIVE" ||
                  cycle?.state === "ACTIVE" ||
                  blocked
                }
              >
                조사 시작
              </Button>
            </form>
            {bindings
              .filter((binding) => binding.owned)
              .map((binding) => (
                <p key={binding.agentId}>
                  {binding.sessionAlias} ·{" "}
                  {ready(binding) ? "준비 보고 · 미검증" : "준비 미보고 · 실행 미검증"}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !snapshot}
                    onClick={() =>
                      mutate("interrupt", {
                        agentId: binding.agentId,
                        bindingEpoch: binding.bindingEpoch,
                        expectedRoomRevision: snapshot!.roomRevision,
                      })
                    }
                  >
                    내 {binding.sessionAlias} 중단 요청
                  </Button>
                </p>
              ))}
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !snapshot || snapshot.roomMode !== "ACTIVE"}
              onClick={() => mutate("pause", { expectedRoomRevision: snapshot!.roomRevision })}
            >
              방 일시정지 요청
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !snapshot || snapshot.roomMode === "ACTIVE" || blocked}
              onClick={() =>
                mutate("resume", { mode: "room", expectedRoomRevision: snapshot!.roomRevision })
              }
            >
              방 발언·조사 접수 재개
            </Button>
            {cycleOwned &&
              pairedCycle?.state === "HUMAN_INPUT_REQUIRED" &&
              pairedCycle.runsReserved < 11 &&
              pairedCycle.peerRoundsReserved < 5 &&
              Date.parse(pairedCycle.deadline) > observedAt && (
                <form onSubmit={(event) => start(event, true)}>
                  <label>
                    재개할 공유 조사 방향
                    <textarea
                      name="direction"
                      required
                      maxLength={4000}
                      style={{ display: "block", maxWidth: "100%" }}
                    />
                  </label>
                  <label>
                    <input type="checkbox" required /> 현재 두 AI 연결에 공유합니다
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      busy ||
                      blocked ||
                      originId !== pairedCycle.originAgentId ||
                      peerId !== pairedCycle.peerAgentId ||
                      !ready(origin) ||
                      !ready(peer)
                    }
                  >
                    기존 조사 명시적 재개
                  </Button>
                  <p>위에서 원래 두 AI 연결을 선택하세요. 남은 실행 예약과 기한을 유지합니다.</p>
                </form>
              )}
          </AdvancedControls>
        )}
      </div>
      {writable && bindings.some((binding) => binding.owned) && (
        <OwnInputControls userId={userId} roomId={roomId} bindings={bindings} />
      )}
      {error && (
        <p
          ref={errorRef}
          role="alert"
          aria-label="조사 오류"
          tabIndex={-1}
          className="shrink-0 border-b bg-red-50 px-5 py-2 text-xs text-red-800"
        >
          {error}
        </p>
      )}
      {busy && (
        <p aria-live="polite" className="shrink-0 px-5 py-2 text-xs text-neutral-500">
          요청을 전송 중입니다. 확정된 내용은 공동 이력에 표시됩니다.
        </p>
      )}
      <ChatTimeline
        events={history.events}
        runs={snapshot?.runs ?? []}
        historicalRuns={history.runs}
        bindings={bindings}
        labels={labels}
        onAccessLost={loseAccess}
        scrollRef={scrollRef}
        unread={unread}
        onLatest={() => {
          follow.current = true;
          setUnread(false);
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) {
            follow.current = nearTimelineBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
            if (follow.current) setUnread(false);
          }
        }}
      />
      <div className="max-h-28 shrink-0 overflow-y-auto px-5 text-xs text-neutral-500">
        <ul aria-label="공개 실행 보고">
          {history.runs.map((run) => (
            <li key={run.requestId}>
              {run.requestKind} · {labels[run.state]}
            </li>
          ))}
        </ul>
        {writable && (
          <>
            {" "}
            {pendingDirect && (
              <p role="status">
                전송 결과 미확정 · 새 질문으로 재전송하지 않습니다.
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !snapshot}
                  onClick={() => mutate(pendingDirect.action, {}, pendingDirect.body)}
                >
                  같은 요청 확인
                </Button>
              </p>
            )}
            {directCycle && (
              <div aria-label="직접 질문 상태">
                <p>대상 답변: {labels[directRun?.state ?? directCycle.state]}</p>
                {Date.parse(directCycle.deadline) <= observedAt && (
                  <p>직접 질문 기한이 지났습니다. 늦은 답변은 현재 결과로 채택하지 않습니다.</p>
                )}
                {!ready(
                  bindings.find(
                    (binding) =>
                      binding.agentId === directCycle.targetAgentId &&
                      binding.bindingEpoch === directCycle.targetEpoch,
                  ),
                ) && <p>대상 준비 보고 만료 또는 연결 변경 · 실제 종결을 기다립니다.</p>}
                {directCycle.canInterrupt && directRun && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !!pendingDirect}
                    onClick={() =>
                      mutate("cancel", {
                        requestId: directRun.requestId,
                        expectedRoomRevision: snapshot!.roomRevision,
                      })
                    }
                  >
                    이 직접 질문 중단 요청
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {writable ? (
        <ChatComposer
          mode={mode}
          onMode={setMode}
          draft={draft}
          onDraft={setDraft}
          targets={availableTargets}
          target={target}
          targetValue={targetPin?.agentId ?? target?.agentId ?? ""}
          stale={!!targetPin && !target}
          onTarget={(agentId) => {
            const selected = availableTargets.find((binding) => binding.agentId === agentId);
            setTargetPin(
              selected ? { agentId: selected.agentId, epoch: selected.bindingEpoch } : null,
            );
          }}
          busy={busy}
          pending={!!pendingDirect}
          disabled={mode === "ask" ? askDisabled : busy || !!pendingDirect || !snapshot}
          onSubmit={mode === "ask" ? ask : speak}
        />
      ) : (
        <p className="shrink-0 border-t px-5 py-4 text-xs text-neutral-500">
          읽기 전용입니다. 질문과 메시지를 보낼 수 없습니다.
        </p>
      )}
    </section>
  );
}
