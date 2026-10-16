"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { type PublicBinding } from "./contracts";
import { useRoomChat } from "./use-room-chat";

import { OwnInputControls } from "./own-input-controls";
import { ChatTimeline } from "./chat-timeline";
import { ChatAnswerStatusPanel } from "./chat-answer-status-panel";
import { ChatComposer } from "./chat-composer";
import { RequestRetirementControls } from "./request-retirement-controls";
import { recoverySnapshot } from "./history-state";
import { AdvancedControls } from "./advanced-controls";
import { answerStatuses, nearTimelineBottom } from "./chat-presentation";
import { Button } from "../../components/ui/button";
import { ChatHeaderControls } from "../room-access/chat-shell";

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

type Props = { userId: string; roomId: string; role: "owner" | "participant" | "observer" };

export function InvestigationView(props: Props) {
  return <RoomInvestigation key={`${props.userId}:${props.roomId}`} {...props} />;
}
function RoomInvestigation({ userId, roomId, role }: Props) {
  const {
    history,
    pollError,
    actionError,
    storageError,
    permissionDenied,
    busy,
    pendingDirect,
    outboxConflict,
    confirmStoredConflict,
    realtimeState,
    observedAt,
    cancelReceipts,
    requiredRecoveryRevision,
    mutate,
    loseAccess,
  } = useRoomChat({ userId, roomId, role });
  const [originId, setOriginId] = useState("");
  const [peerId, setPeerId] = useState("");
  const [targetPin, setTargetPin] = useState<{ agentId: string; epoch: number } | null | undefined>(
    undefined,
  );
  const errorRef = useRef<HTMLParagraphElement>(null);
  const error = actionError ?? pollError;
  const [draft, setDraft] = useState("");
  const speechDraft = useRef<string | null>(null);
  const [mode, setMode] = useState<"ask" | "speak">("ask");
  const [unread, setUnread] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const latestSequence = useRef(0);
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
    if (error) errorRef.current?.focus();
  }, [error]);

  const snapshot = history.snapshot;
  const bindings = useMemo(() => snapshot?.bindings ?? [], [snapshot]);
  const origin = bindings.find((binding) => binding.agentId === originId);
  const peer = bindings.find((binding) => binding.agentId === peerId);
  const cycle = snapshot?.cycle;
  const pairedCycle = cycle && !("mode" in cycle) ? cycle : null;
  const directCycle = cycle && "mode" in cycle ? cycle : null;
  const writable = role !== "observer" && !permissionDenied;
  const cycleOwned =
    !!pairedCycle &&
    bindings.some((binding) => binding.agentId === pairedCycle.originAgentId && binding.owned);
  const recovery = recoverySnapshot(history);
  const blocked =
    !recovery ||
    !!pollError ||
    recovery.recovery.hasBlockingRuns ||
    recovery.roomRevision < requiredRecoveryRevision;
  const candidate = recovery?.recovery.candidate;
  const retirementCandidate =
    candidate && !history.retirements.some((entry) => entry.requestId === candidate.requestId)
      ? candidate
      : null;
  const ready = (binding: PublicBinding | undefined) =>
    !!binding?.reportedReady && !!binding.validUntil && Date.parse(binding.validUntil) > observedAt;
  const availableTargets = bindings.filter(ready);
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

  const presentation = useMemo(
    () =>
      answerStatuses({
        events: history.events,
        runs: snapshot?.runs ?? [],
        historicalRuns: history.runs,
        bindings,
        cycle: cycle ?? null,
        observedAt,
        pollError,
        gap: history.gap,
        role,
        cancelReceipts,
        retirements: history.retirements,
      }),
    [
      history.events,
      history.runs,
      history.retirements,
      snapshot,
      bindings,
      cycle,
      observedAt,
      pollError,
      history.gap,
      role,
      cancelReceipts,
    ],
  );
  const cycleStatuses = cycle
    ? presentation.statuses.filter((status) => status.cycleId === cycle.cycleId)
    : [];
  const currentStatuses = cycleStatuses.filter((status) =>
    ["QUEUED", "LEASED", "RUNNING", "UNKNOWN"].includes(status.state),
  );
  const showAnswerStatus =
    currentStatuses.length > 0 ||
    (writable && (!!retirementCandidate || (!!pendingDirect && pendingDirect.action !== "speak")));
  const directStatus = directRun
    ? cycleStatuses.find(
        (status) =>
          status.requestId === directRun.requestId &&
          status.agentId === directRun.agentId &&
          status.epoch === directRun.bindingEpoch,
      )
    : undefined;
  const cancelConfirmed = !!directStatus?.interruptStage || !!directStatus?.cancelReceiptState;
  const cancelUncertain =
    pendingDirect?.action === "cancel" && pendingDirect.body.requestId === directRun?.requestId;

  async function speak(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!draft.trim() || busy || pendingDirect) return false;
    const submittedDraft = draft;
    speechDraft.current = submittedDraft;
    const sent = await mutate("speak", { publicText: String(new FormData(form).get("speech")) });
    if (sent) setDraft((current) => (current === submittedDraft ? "" : current));
    return sent;
  }
  async function confirmSpeech() {
    if (pendingDirect?.action !== "speak") return false;
    const submittedDraft = speechDraft.current ?? (pendingDirect.body.publicText as string);
    const sent = await mutate("speak", {}, pendingDirect.body);
    if (sent) setDraft((current) => (current === submittedDraft ? "" : current));
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
      <ChatHeaderControls>
        <p
          role="status"
          aria-label="방 상태"
          className="max-w-16 truncate text-[10px] text-neutral-500 md:max-w-56 md:text-xs"
          title={`방: ${snapshot ? labels[snapshot.roomMode] : pollError ? "확인 불가" : "조회 중"}${cycle ? ` · 조사: ${labels[cycle.state]}` : ""}${pollError && snapshot ? " · 조회 실패" : ""}`}
        >
          <span className="sr-only">방: </span>
          {snapshot ? labels[snapshot.roomMode] : pollError ? "확인 불가" : "조회 중"}
          {cycle && (
            <span className="sr-only md:not-sr-only">{` · 조사: ${labels[cycle.state]}`}</span>
          )}
          {pollError && snapshot && <span className="sr-only"> · 조회 실패</span>}
        </p>
        <span role="status" aria-label="실시간 연결 상태" className="text-[10px] text-neutral-500">
          {realtimeState === "connected"
            ? "실시간 연결"
            : realtimeState === "connecting"
              ? "연결 중"
              : "재연결 중"}
        </span>
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
      </ChatHeaderControls>
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
      {storageError && (
        <p role="status" className="shrink-0 px-5 py-2 text-xs">
          {storageError}
        </p>
      )}
      {writable && outboxConflict && (
        <section aria-label="저장 메시지 충돌" className="shrink-0 border-b px-5 py-2 text-xs">
          <p>이 탭과 브라우저에 서로 다른 메시지가 있습니다. 두 원문을 보존했습니다.</p>
          <p className="max-h-24 overflow-auto whitespace-pre-wrap">
            이 탭: {outboxConflict.body.publicText as string}
          </p>
          <p>
            브라우저에 저장된 메시지를 먼저 확인하면 이 탭의 메시지도 같은 작업 번호로 이어서
            보관합니다.
          </p>
          <Button variant="outline" size="sm" onClick={confirmStoredConflict}>
            브라우저 저장 메시지 먼저 선택
          </Button>
        </section>
      )}
      {writable && pendingDirect?.action === "speak" && (
        <section aria-label="일반 발언 전송 상태" className="shrink-0 border-b px-5 py-2 text-xs">
          <p>
            일반 발언 원문은 이 기기에 최대 7일 보관합니다. 브라우저가 저장소를 지우면 복구할 수
            없습니다.
          </p>
          <p role="status">{busy ? "메시지 전송 중" : "메시지 전송 결과 확인 필요"}</p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap">
            {pendingDirect.body.publicText as string}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !snapshot || !!outboxConflict}
            onClick={confirmSpeech}
          >
            같은 메시지 확인
          </Button>
        </section>
      )}
      <ChatTimeline
        events={history.events}
        loading={history.gap || !!history.snapshot?.hasMore}
        runs={snapshot?.runs ?? []}
        historicalRuns={history.runs}
        bindings={bindings}
        labels={labels}
        presentation={presentation}
        cycle={cycle ?? null}
        observedAt={observedAt}
        pollError={pollError}
        gap={history.gap}
        role={role}
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
      {showAnswerStatus && (
        <ChatAnswerStatusPanel statuses={currentStatuses}>
          {writable && (
            <>
              <RequestRetirementControls
                userId={userId}
                roomId={roomId}
                candidate={retirementCandidate}
                disabled={busy || !!pendingDirect || !!pollError}
                mutate={mutate}
              />{" "}
              {pendingDirect && pendingDirect.action !== "speak" && (
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
              {directCycle && currentStatuses.length > 0 && (
                <div>
                  {Date.parse(directCycle.deadline) <= observedAt && (
                    <p>직접 질문 기한이 지났습니다. 늦은 답변은 현재 결과로 채택하지 않습니다.</p>
                  )}
                  {directRun &&
                    ["QUEUED", "LEASED", "RUNNING", "UNKNOWN"].includes(directRun.state) &&
                    !ready(
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
                      disabled={busy || !!pendingDirect || cancelConfirmed}
                      onClick={() =>
                        mutate("cancel", {
                          requestId: directRun.requestId,
                          expectedRoomRevision: snapshot!.roomRevision,
                        })
                      }
                    >
                      {cancelUncertain
                        ? busy
                          ? "중단 요청 전송 중"
                          : "중단 요청 결과 미확정"
                        : directStatus?.interruptStage === "ACKNOWLEDGED"
                          ? "중단 요청 수신 확인"
                          : directStatus?.cancelReceiptState === "NO_ACTIVE_RUN"
                            ? "중단할 활성 실행 없음"
                            : cancelConfirmed
                              ? "중단 요청 접수"
                              : "이 직접 질문 중단 요청"}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </ChatAnswerStatusPanel>
      )}
      {writable ? (
        <ChatComposer
          roomId={roomId}
          readinessUnconfirmed={!snapshot || !!pollError}
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
