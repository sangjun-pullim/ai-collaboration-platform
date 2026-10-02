import { useRef, useState } from "react";
import type { Dispatch, KeyboardEvent } from "react";
import { bindings, replayEvents } from "./mock-scenario.ts";
import { pauseStatus } from "./prototype-state.ts";
import type { Action, Decision, Outcome, PrototypeState, Run, RunId } from "./prototype-state.ts";

type Props = { state: PrototypeState; dispatch: Dispatch<Action> };
const outcomeNames: Record<Outcome, string> = { completed: "정상 완료", failed: "실패", interrupted: "중단" };
function runLabel(run: Run) {
  return ({
    running: "모의 조사 중", requested: "정지 요청됨 · 종결 미확인",
    acknowledged: "connector 확인 · 종결 미확인", unknown: "UNKNOWN · offline · 종결 확인 필요",
    terminal: `종결 확인 · ${run.outcome ? outcomeNames[run.outcome] : ""}`,
  })[run.phase];
}
export function RoomView({ state, dispatch }: Props) {
  const [mobilePanel, setMobilePanel] = useState<"shared" | "private">("shared");
  const observer = state.role === "observer";
  const status = pauseStatus(state);
  const cannotReplay = observer || state.pauseRequested || Object.values(state.runs).some((run) => run.phase !== "running") || state.replayIndex >= replayEvents.length;
  return (
    <div className="room-layout">
      <section className="room-heading" aria-labelledby="room-title">
        <div><p className="eyebrow">02 / 공동 조사 · 모의 조사방</p><h1 id="room-title">{state.setup.goal}</h1><p className="lead compact">{state.setup.symptom}</p></div>
        <span className="badge role-badge">{observer ? "관찰자 체험 · 입력 불가" : "예제 개발자 A · 참가자 체험"}</span>
      </section>
      <details className="room-context"><summary>조사 맥락과 공유 범위</summary><dl className="metadata"><dt>기대 동작</dt><dd>{state.setup.expected}</dd><dt>대상 환경</dt><dd>{state.setup.environment}</dd><dt>공유 범위</dt><dd>{state.setup.scope.map((key) => ({ code: "코드 발췌", validation: "검증 결과", events: "작업 이벤트" })[key as "code" | "validation" | "events"]).join(" · ")}</dd></dl></details>
      {observer && <div className="observer-notice"><strong>connector 없이 관찰 중</strong><span>예제 공동 기록을 읽는 체험 역할입니다. 실제 인증·접근 권한은 검증하지 않습니다.</span></div>}
      <section className="run-control-panel panel" aria-label="실행 확인 및 전체 일시정지">
        <div className="control-top"><div><span className="eyebrow">모의 실행 확인</span><p className="pause-summary" data-testid="pause-summary">{status === "complete" ? "방 일시정지 완료 · 두 실행 종결 확인" : status === "waiting" ? "방 일시정지 대기 · 종결 확인 필요" : "방 일시정지 요청 없음"}</p></div><button className="button pause" disabled={observer || state.pauseRequested} onClick={() => dispatch({ type: "pause-room" })}>전체 일시정지</button></div>
        <div className="run-grid">{(["a", "b"] as RunId[]).map((run) => <RunControl key={run} run={run} state={state} dispatch={dispatch} />)}</div>
        <p className="hint control-hint">단계는 버튼으로만 재생합니다. connector의 요청 확인은 실행 종결과 다릅니다.</p>
      </section>
      <div className="mobile-tabs" role="tablist" aria-label="조사 영역">
        <button id="shared-tab" role="tab" aria-selected={mobilePanel === "shared"} aria-controls="shared-panel" tabIndex={mobilePanel === "shared" ? 0 : -1} onClick={() => setMobilePanel("shared")} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setMobilePanel("private"); document.getElementById("private-tab")?.focus(); } }}>공동 기록</button>
        <button id="private-tab" role="tab" aria-selected={mobilePanel === "private"} aria-controls="private-panel" tabIndex={mobilePanel === "private" ? 0 : -1} onClick={() => setMobilePanel("private")} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setMobilePanel("shared"); document.getElementById("shared-tab")?.focus(); } }}>내 AI · 개인 설명</button>
      </div>
      <div className={`investigation-grid mobile-${mobilePanel}`}>
        <section id="shared-panel" className="panel shared-panel" aria-labelledby="shared-title">
          <div className="panel-heading"><div><p className="eyebrow">모든 참가자에게 공개</p><h2 id="shared-title">공동 기록 <span className="count">{state.shared.length}</span></h2></div><button className="button small" disabled={cannotReplay} onClick={() => dispatch({ type: "replay-event" })}>다음 공동 기록 재생</button></div>
          <ol className="timeline" aria-label="확정 공동 기록">{state.shared.map((event) => <li key={event.id} className="timeline-event"><div className="event-top"><span className={`event-kind ${event.sender === "사람" ? "human" : ""}`}>{event.kind}</span><span className="event-sender">{event.sender}</span><span className="confirmed">확정 · 모의 기록</span></div><p className="event-routing">{event.owner} → {event.recipient}</p><p className="event-text">{event.text}</p>{event.repository && <div className="evidence"><span className="repo-name">{event.repository}</span>{event.location && <code>{event.location}</code>}<span>{event.snapshot}</span><span className="evidence-note">예제 snapshot · 실제 코드 검증 아님</span></div>}</li>)}</ol>
          <Composer mode="speak" state={state} dispatch={dispatch} />
        </section>
        <section id="private-panel" className="panel private-panel" aria-labelledby="private-title">
          <div className="panel-heading"><div><p className="eyebrow">내 작업 공간</p><h2 id="private-title">내 AI</h2></div><span className="badge private-badge">나에게만</span></div>
          <div className="own-binding"><span className="avatar" aria-hidden="true">A</span><div><strong>repository-a</strong><p>{bindings[0].branch} · {bindings[0].session}</p></div></div>
          <div className="own-status"><span>최근 실행 확인</span><strong>{observer ? "내 연결 없음 · 관찰자" : runLabel(state.runs.a)}</strong><span className="hint">모의 확인 단계 · 실제 heartbeat 아님</span></div>
          <button className="button wide" disabled={observer || state.runs.a.phase !== "running"} onClick={() => dispatch({ type: "stop-own" })}>내 AI만 정지</button>
          <section className="draft-card" aria-label="미확정 발신 초안"><div className="subheading"><h3>발신 초안</h3><span className="badge">{state.draft ? "미확정 · 나에게만" : observer ? "내 연결 없음" : "공동 공개됨"}</span></div>{state.draft ? <><p className="hint">수신자: {state.draft.recipient}</p><p className="draft-text">{state.draft.text}</p><p className="check-state">공개 검사: {state.draft.check === "passed" ? "모의 검사 통과 · 아직 미공개" : "모의 검사 대기 · 아직 미공개"}</p><div className="inline-actions"><button className="button small" disabled={observer || state.draft.check !== "pending"} onClick={() => dispatch({ type: "check-draft" })}>공개 검사 재생</button><button className="button small primary" disabled={observer || state.draft.check !== "passed"} onClick={() => dispatch({ type: "finalize-draft" })}>발신 초안 확정</button></div></> : <p className="hint">{observer ? "관찰자는 개인 초안과 연결이 없습니다." : "확정된 내용은 공동 기록에서 볼 수 있습니다."}</p>}</section>
          <div className="private-composer"><Composer mode="private" state={state} dispatch={dispatch} /></div>
          {(state.pendingDirection || state.appliedDirection) && <div className="direction-state"><strong>{state.pendingDirection ? "방향 적용 대기 · 내 AI 종결 확인 필요" : "새 방향 적용됨 · 모의 종결 확인 후"}</strong><p>{state.pendingDirection ?? state.appliedDirection}</p></div>}
          <section className="private-history" aria-label="개인 설명 기록"><h3>개인 설명 <span className="count">{state.privateHistory.length}</span></h3>{!state.privateHistory.length && <p className="hint">공동 메시지를 골라 내 AI에 설명을 요청하세요.<br />질문과 답변은 공동 기록에 들어가지 않습니다.</p>}{state.privateHistory.map((entry) => <article className="explanation-card" key={entry.id}><p className="snapshot-reference">대상 기록 #{entry.target.id} · {entry.target.sender}<br />{entry.target.text}</p><strong>내 질문</strong><p>{entry.question}</p><strong>모의 개인 설명</strong><p>{entry.answer}</p><label className="publish-choice"><span>공개할 내용 선택</span><select id={`publish-${entry.id}`} defaultValue="answer" aria-label={`개인 설명 ${entry.id} 공개할 내용`}><option value="answer">설명 답변만</option><option value="question">내 질문만</option></select></label><button className="button small" disabled={observer} onClick={() => { const select = document.getElementById(`publish-${entry.id}`) as HTMLSelectElement; dispatch({ type: "publish-private", explanationId: entry.id, part: select.value as "answer" | "question" }); }}>선택한 내용만 공동 공개</button><p className="hint">선택한 문구가 사람의 공동 발언으로 공개됩니다.</p></article>)}</section>
        </section>
      </div>
      <ResultView state={state} dispatch={dispatch} />
    </div>
  );
}

function RunControl({ state, dispatch, run }: Props & { run: RunId }) {
  const [outcome, setOutcome] = useState<Outcome>("interrupted");
  const current = state.runs[run];
  const disabled = state.role === "observer";
  const waiting = ["requested", "acknowledged", "unknown"].includes(current.phase);
  const name = run.toUpperCase();
  return <article className="run-card" aria-label={`AI ${name} 실행 확인`}><div className="run-card-heading"><strong>AI {name} <span>{run === "a" ? "내 AI" : "상대 AI"}</span></strong><span className="mono">{run === "a" ? "repository-a" : "repository-b"}</span></div><p className={`run-status phase-${current.phase}`}>{runLabel(current)}</p><details className="replay-controls"><summary>모의 확인 단계 재생</summary><div className="replay-buttons"><button className="button small" disabled={disabled || !["requested", "unknown"].includes(current.phase)} onClick={() => dispatch({ type: "ack", run })}>AI {name} connector 확인 재생</button><button className="button small" disabled={disabled || !["requested", "acknowledged"].includes(current.phase)} onClick={() => dispatch({ type: "unknown", run })}>AI {name} offline 재생</button></div><label className="terminal-choice"><span>AI {name} 종결 결과</span><select aria-label={`AI ${name} 종결 결과`} disabled={disabled || !waiting} value={outcome} onChange={(event) => setOutcome(event.target.value as Outcome)}><option value="interrupted">중단 (interrupted)</option><option value="completed">정상 완료 (completed)</option><option value="failed">실패 (failed)</option></select></label><button className="button small" disabled={disabled || !waiting} onClick={() => dispatch({ type: "terminal", run, outcome })}>AI {name} 종결 확인 재생</button></details></article>;
}

function Composer({ state, dispatch, mode }: Props & { mode: "speak" | "private" }) {
  const [inputMode, setInputMode] = useState<"explain" | "steer">("explain");
  const [drafts, setDrafts] = useState({ speak: "", explain: "", steer: "" });
  const [targetId, setTargetId] = useState(state.shared[0]?.id ?? 0);
  const composing = useRef(false);
  const observer = state.role === "observer";
  const actionType = mode === "speak" ? "speak" : inputMode;
  const text = drafts[actionType];
  function setText(value: string) {
    setDrafts((previous) => ({ ...previous, [actionType]: value }));
  }
  const labels = { speak: "공동 발언", explain: "개인 설명", steer: "방향 수정" };
  const cannotSubmit = observer || !text.trim() || (actionType === "steer" && !!state.pendingDirection) || (actionType === "explain" && !state.shared.some((event) => event.id === targetId));
  function submit() {
    if (cannotSubmit || composing.current) return;
    if (actionType === "explain") dispatch({ type: "explain", text, targetId });
    else dispatch({ type: actionType, text });
    setText("");
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  }
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    {mode === "private" && <div className="input-modes" role="group" aria-label="내 AI 입력 종류"><button className={inputMode === "explain" ? "selected" : ""} type="button" aria-pressed={inputMode === "explain"} onClick={() => setInputMode("explain")}>개인 설명</button><button className={inputMode === "steer" ? "selected" : ""} type="button" aria-pressed={inputMode === "steer"} onClick={() => setInputMode("steer")}>방향 수정</button></div>}
    <label htmlFor={`input-${mode}`}>{labels[actionType]}</label>
    <p className={`audience ${actionType === "explain" ? "private" : "public"}`} id={`audience-${mode}`}>{actionType === "explain" ? "나에게만 · 선택한 공동 기록의 설명 · 조사 실행 없음" : actionType === "steer" ? "모든 참가자에게 공개 · 내 AI 종결 확인 후 새 방향 적용" : "모든 참가자에게 공개 · 사람의 발언 · AI 자동 실행 없음"}</p>
    {actionType === "explain" && <label className="target-select"><span>설명할 공동 메시지</span><select value={targetId} disabled={observer} onChange={(event) => setTargetId(Number(event.target.value))}>{state.shared.map((event) => <option key={event.id} value={event.id}>#{event.id} {event.sender} · {event.text}</option>)}</select></label>}
    <textarea id={`input-${mode}`} rows={3} disabled={observer} placeholder={actionType === "explain" ? "이 근거가 무엇을 뜻하는지 물어보세요." : actionType === "steer" ? "다음 조사 방향을 공개 문구로 작성하세요." : "함께 확인할 사실이나 의견을 남기세요."} value={text} onChange={(event) => setText(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={onKeyDown} aria-describedby={`audience-${mode}`} />
    <div className="composer-bottom"><span className="hint">Enter 전송 · Shift+Enter 줄바꿈</span><button className="button small primary" type="submit" disabled={cannotSubmit}>{labels[actionType]} 제출</button></div>
  </form>;
}

function ResultView({ state, dispatch }: Props) {
  const observer = state.role === "observer";
  return <section className="panel result-panel" aria-labelledby="result-title"><div className="panel-heading"><div><p className="eyebrow">03 / 다음 작업</p><h2 id="result-title">공동 조사 결과 초안</h2></div><span className="badge">사람 판단 필요</span></div>{!state.result ? <div className="result-empty"><div><h3>근거에서 다음 작업으로</h3><p>모의 결과 초안에서 사실·가설·제안과 저장소별 다음 검증을 확인하세요.</p></div><button className="button" disabled={observer} onClick={() => dispatch({ type: "propose-result" })}>모의 결과 초안 보기</button></div> : <><div className="result-summary"><div><span className="result-label">예제 사실</span><p>{state.result.fact}</p></div><div><span className="result-label">원인 가설 · 미확인</span><p>{state.result.hypothesis}</p></div><div><span className="result-label">수정 제안</span><p>{state.result.proposal}</p></div></div><div className="task-grid">{state.result.tasks.map((task) => <article key={task.repository} className="task-card"><div className="subheading"><h3>{task.repository}</h3><span className="badge">{task.owner}</span></div><dl className="metadata"><dt>근거</dt><dd>{task.evidence}</dd><dt>제안</dt><dd>{task.proposal}</dd><dt>다음 검증</dt><dd>{task.nextValidation}</dd></dl></article>)}</div><p className="validation-notice">{state.result.validation}</p><div className="human-decision"><div><h3>사람의 판단</h3><p className="hint">판단은 공동 기록에 남습니다. 선택만으로 실제 검증이 통과하지 않습니다.</p><p className="decision-state">{state.decision ? `기록된 판단: ${state.decision}` : "아직 사람의 판단이 없습니다."}</p></div><div className="inline-actions">{(["해결", "추가 조사", "보류"] as Decision[]).map((decision) => <button className={`button small ${state.decision === decision ? "active" : ""}`} aria-pressed={state.decision === decision} key={decision} disabled={observer} onClick={() => dispatch({ type: "decide", decision })}>{decision}</button>)}</div></div></>}</section>;
}
