"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { WorkflowError, projectEnvelope, validateBody, type HumanAction, type Body,
  type HistoryPage, type PublicBinding } from "./contracts";
import { emptyHistory, mergeHistory } from "./history-state";
import { pollingDelay } from "./polling-policy";

const labels: Record<string, string> = {
  QUEUED: "대기", LEASED: "실행 준비 보고", RUNNING: "실행 보고 · provider 미검증",
  UNKNOWN: "종결 미확인 · 사람 확인 필요", COMPLETED: "완료 보고", FAILED: "실패 보고",
  INTERRUPTED: "중단 확인 보고", CANCELLED: "시작 전 취소", ACTIVE: "활성",
  HUMAN_INPUT_REQUIRED: "사람 확인 필요", PAUSING: "중단 확인 대기", PAUSED: "일시정지 확인",
  PENDING: "후속 채택 대기", ACCEPTED: "현재 조사 채택", HISTORICAL: "과거 기록 · 미채택",
};
const denied = (code: string) => ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(code);

async function call(action: HumanAction, body: Body, signal: AbortSignal) {
  const validated = validateBody(action, body);
  try {
    const response = await fetch(`/api/investigations/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      cache: "no-store", redirect: "error",
    });
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new WorkflowError("UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError("UNAVAILABLE");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262_144) { await reader.cancel(); throw new WorkflowError("UNAVAILABLE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return projectEnvelope(action, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), response.status);
  } catch (error) {
    if (signal.aborted || error instanceof WorkflowError) throw error;
    throw new WorkflowError("UNAVAILABLE");
  }
}

type Props = { roomId: string; role: "owner" | "participant" | "observer" };
export function InvestigationView(props: Props) {
  return <RoomInvestigation key={props.roomId} {...props} />;
}
function RoomInvestigation({ roomId, role }: Props) {
  const [history, setHistory] = useState(() => emptyHistory(roomId));
  const historyRef = useRef(history);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [originId, setOriginId] = useState("");
  const [peerId, setPeerId] = useState("");
  const [tick, setTick] = useState(0);
  const [observedAt, setObservedAt] = useState(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const mutationAbort = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);
  const mounted = useRef(false);
  const error = actionError ?? pollError;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutationAbort.current?.abort(); };
  }, []);
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
        const page = await call("read", { protocol: 1, roomId, afterSequence: state.cursor }, controller.signal) as HistoryPage;
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
        setPollError(denied(code) ? "접근 권한을 확인해 주세요." : "공동 기록을 불러올 수 없습니다. 다시 시도합니다.");
        if (denied(code)) {
          controller.abort();
          historyRef.current = emptyHistory(roomId);
          setHistory(historyRef.current);
          setPermissionDenied(true);
          return;
        }
        failures++;
      }
      const active = backfill || state.runs.some(run => ["QUEUED", "LEASED", "RUNNING"].includes(run.state));
      timer = setTimeout(poll, pollingDelay(active, document.hidden, failures));
    }
    timer = setTimeout(poll, 0);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [roomId, tick, permissionDenied]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const snapshot = history.snapshot;
  const bindings = snapshot?.bindings ?? [];
  const origin = bindings.find(binding => binding.agentId === originId);
  const peer = bindings.find(binding => binding.agentId === peerId);
  const cycle = snapshot?.cycle;
  const writable = role !== "observer" && !permissionDenied;
  const cycleOwned = !!cycle && bindings.some(binding => binding.agentId === cycle.originAgentId && binding.owned);
  const blocked = history.runs.some(run => ["LEASED", "RUNNING", "UNKNOWN"].includes(run.state));
  const ready = (binding: PublicBinding | undefined) => !!binding?.reportedReady &&
    !!binding.validUntil && Date.parse(binding.validUntil) > observedAt;

  async function mutate(action: HumanAction, fields: Body) {
    if (!snapshot || !writable || mutationPending.current) return false;
    mutationPending.current = true;
    pollAbort.current?.abort();
    const controller = new AbortController();
    mutationAbort.current = controller;
    setBusy(true);
    setActionError(null);
    try {
      await call(action, { protocol: 1, roomId, operationId: crypto.randomUUID(), ...fields }, controller.signal);
      return mounted.current && !controller.signal.aborted;
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return false;
      const code = failure instanceof WorkflowError ? failure.code : "UNAVAILABLE";
      setActionError(code === "CONFLICT" ? "상태가 바뀌었습니다. 기록을 갱신한 뒤 다시 시도해 주세요." :
        "요청을 완료할 수 없습니다. 접근 권한과 연결 보고를 확인해 주세요.");
      if (denied(code)) {
        historyRef.current = emptyHistory(roomId);
        setHistory(historyRef.current);
        setPermissionDenied(true);
      }
      return false;
    } finally {
      mutationPending.current = false;
      if (mounted.current) { setBusy(false); setTick(value => value + 1); }
    }
  }
  async function speak(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await mutate("speak", { publicText: String(new FormData(form).get("speech")) })) form.reset();
  }
  async function start(event: FormEvent<HTMLFormElement>, resume = false) {
    event.preventDefault();
    if (!origin || !peer || !snapshot) return;
    const form = event.currentTarget;
    if (await mutate(resume ? "resume" : "start", {
      originAgentId: origin.agentId, peerAgentId: peer.agentId,
      originEpoch: origin.bindingEpoch, peerEpoch: peer.bindingEpoch,
      expectedRoomRevision: snapshot.roomRevision, publicText: String(new FormData(form).get("direction")),
      confirmed: true, ...(resume && cycle ? { mode: "cycle", cycleId: cycle.cycleId } : {}),
    })) form.reset();
  }
  function bindingOption(binding: PublicBinding) {
    return <option value={binding.agentId} key={binding.agentId}>{binding.ownerAlias} · {binding.sessionAlias}</option>;
  }
  return <section aria-label="실제 공동 조사" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h2>공동 기록</h2>
    <p>기기 준비와 실행은 로컬 보고이며 실제 provider 검증은 아직 없습니다. 등록만으로 실행되지 않습니다.</p>
    <p role="status">방: {snapshot ? labels[snapshot.roomMode] : "조회 중"}{cycle ? ` · 조사: ${labels[cycle.state]}` : ""}</p>
    {error && <p ref={errorRef} role="alert" aria-label="조사 오류" tabIndex={-1}>{error}</p>}
    {busy && <p aria-live="polite">요청을 전송 중입니다. 확정된 내용은 공동 이력에 표시됩니다.</p>}
    <ul aria-label="공개 실행 보고">{history.runs.map(run => <li key={run.requestId}>{run.requestKind} · {labels[run.state]}</li>)}</ul>
    <ol aria-label="확정 공동 이력">{history.events.filter(event => event.kind !== "RUN_STATE").map(event => <li key={event.eventId}>
      <span>{event.senderAlias}</span> · <span>{event.kind === "SPEECH" ? (event.senderKind === "AGENT" ? "공개 조사 결과" : "공동 발언") :
        event.kind === "QUESTION" ? "질문" : event.kind === "ANSWER" ? "답변" : event.kind.startsWith("ROOM_") ? labels[event.roomMode ?? ""] :
        event.kind === "HUMAN_INPUT_REQUIRED" ? "사람 확인 필요" : "공개 기록"}</span>
      {event.publicText && <p style={{ whiteSpace: "pre-wrap" }}>{event.publicText}</p>}
      {event.adoption !== "NONE" && <small>{labels[event.adoption]}</small>}
    </li>)}</ol>
    {writable && <>
      <form onSubmit={speak}><label>공동 발언<textarea name="speech" required maxLength={4000} style={{ display: "block", maxWidth: "100%" }} /></label>
        <button className="button" disabled={busy || !snapshot}>공동 발언 저장</button></form>
      <p>조사 시작에는 서로 다른 참가자의 현재 준비 보고 두 개와 공유 확인이 필요합니다.</p>
      <form onSubmit={event => start(event)}>
        <label>내 조사 binding<select value={originId} onChange={event => setOriginId(event.target.value)}><option value="">선택</option>{bindings.filter(binding => binding.owned).map(bindingOption)}</select></label>
        <label>질문받을 binding<select value={peerId} onChange={event => setPeerId(event.target.value)}><option value="">선택</option>{bindings.filter(binding => !binding.owned).map(bindingOption)}</select></label>
        <label>공유 조사 방향<textarea name="direction" required maxLength={4000} style={{ display: "block", maxWidth: "100%" }} /></label>
        <label><input type="checkbox" required /> 이 내용을 두 참가자에게 공유합니다</label>
        <button className="button" disabled={busy || !ready(origin) || !ready(peer) || snapshot?.roomMode !== "ACTIVE" || cycle?.state === "ACTIVE" || blocked}>조사 시작</button>
      </form>
      {bindings.filter(binding => binding.owned).map(binding => <p key={binding.agentId}>{binding.sessionAlias} · {ready(binding) ? "준비 보고 · 미검증" : "준비 미보고 · 실행 미검증"}
        <button className="button" disabled={busy || !snapshot} onClick={() => mutate("interrupt", { agentId: binding.agentId, bindingEpoch: binding.bindingEpoch, expectedRoomRevision: snapshot!.roomRevision })}>내 {binding.sessionAlias} 중단 요청</button></p>)}
      <button className="button" disabled={busy || !snapshot || snapshot.roomMode !== "ACTIVE"} onClick={() => mutate("pause", { expectedRoomRevision: snapshot!.roomRevision })}>방 일시정지 요청</button>
      <button className="button" disabled={busy || !snapshot || snapshot.roomMode === "ACTIVE" || blocked} onClick={() => mutate("resume", { mode: "room", expectedRoomRevision: snapshot!.roomRevision })}>방 발언·조사 접수 재개</button>
      {cycleOwned && cycle?.state === "HUMAN_INPUT_REQUIRED" && cycle.runsReserved < 11 && cycle.peerRoundsReserved < 5 && Date.parse(cycle.deadline) > observedAt &&
        <form onSubmit={event => start(event, true)}><label>재개할 공유 조사 방향<textarea name="direction" required maxLength={4000} style={{ display: "block", maxWidth: "100%" }} /></label>
          <label><input type="checkbox" required /> 현재 두 binding에 공유합니다</label>
          <button className="button" disabled={busy || blocked || originId !== cycle.originAgentId || peerId !== cycle.peerAgentId || !ready(origin) || !ready(peer)}>기존 조사 명시적 재개</button>
          <p>위에서 원래 두 binding을 선택하세요. 남은 실행 예약과 기한을 유지합니다.</p></form>}
    </>}
  </section>;
}
