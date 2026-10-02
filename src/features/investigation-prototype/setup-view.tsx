import { useState } from "react";
import type { Dispatch } from "react";
import { bindings } from "./mock-scenario.ts";
import type { Action, PrototypeState, Setup } from "./prototype-state.ts";

type Props = { state: PrototypeState; dispatch: Dispatch<Action> };
export function SetupView({ state, dispatch }: Props) {
  const [setup, setSetup] = useState<Setup>(state.setup);
  function field(key: keyof Setup, value: string | string[]) {
    setSetup((previous) => ({ ...previous, [key]: value }));
  }
  return (
    <div className="setup-layout">
      <section className="setup-intro">
        <p className="eyebrow">01 / 조사 준비</p>
        <h1>다른 저장소,<br />하나의 조사 목표.</h1>
        <p className="lead">각자의 AI가 찾은 근거를 한곳에서 살펴보고,<br className="desktop-break" /> 다음 작업은 사람이 결정합니다.</p>
        <div className="journey"><span className="current">1 준비</span><span>2 공동 조사</span><span>3 사람 판단</span></div>
        <div className="intro-note"><span className="note-symbol" aria-hidden="true">◎</span><div><strong>내 설명은 나에게만</strong><p>공동 발언과 방향 수정은 공개됩니다.<br />개인 설명은 직접 선택한 내용만 공유합니다.</p></div></div>
      </section>
      <section className="panel setup-form-panel" aria-labelledby="setup-title">
        <div className="panel-heading"><div><p className="eyebrow">새 조사방</p><h2 id="setup-title">무엇을 함께 확인할까요?</h2></div><span className="badge">예제 연결 2개</span></div>
        <form noValidate onSubmit={(event) => { event.preventDefault(); dispatch({ type: "create", setup }); }}>
          <div className="field"><label htmlFor="goal">조사 목표</label><input id="goal" value={setup.goal} onChange={(event) => field("goal", event.target.value)} aria-invalid={!!state.errors.goal} aria-describedby={state.errors.goal ? "goal-error" : undefined} />{state.errors.goal && <p className="error" id="goal-error">{state.errors.goal}</p>}</div>
          <div className="field"><label htmlFor="symptom">관찰한 현상</label><textarea id="symptom" rows={2} value={setup.symptom} onChange={(event) => field("symptom", event.target.value)} aria-invalid={!!state.errors.symptom} aria-describedby={state.errors.symptom ? "symptom-error" : undefined} />{state.errors.symptom && <p className="error" id="symptom-error">{state.errors.symptom}</p>}</div>
          <div className="field"><label htmlFor="expected">기대 동작</label><input id="expected" value={setup.expected} onChange={(event) => field("expected", event.target.value)} aria-invalid={!!state.errors.expected} aria-describedby={state.errors.expected ? "expected-error" : undefined} />{state.errors.expected && <p className="error" id="expected-error">{state.errors.expected}</p>}</div>
          <div className="field"><label htmlFor="environment">대상 환경</label><input id="environment" value={setup.environment} onChange={(event) => field("environment", event.target.value)} aria-invalid={!!state.errors.environment} aria-describedby={state.errors.environment ? "environment-error" : undefined} />{state.errors.environment && <p className="error" id="environment-error">{state.errors.environment}</p>}</div>
          <div className="binding-selects">
            {(["bindingA", "bindingB"] as const).map((key, i) => <div className="field" key={key}><label htmlFor={key}>예제 연결 {i === 0 ? "A · 내 AI" : "B · 상대 AI"}</label><select id={key} value={setup[key]} onChange={(event) => field(key, event.target.value)} aria-invalid={!!state.errors[key]} aria-describedby={state.errors[key] ? `${key}-error` : undefined}><option value="">선택해 주세요</option><option value={bindings[i].alias}>{bindings[i].alias}</option></select>{state.errors[key] && <p className="error" id={`${key}-error`}>{state.errors[key]}</p>}</div>)}
          </div>
          <fieldset className="scope-field" aria-describedby={state.errors.scope ? "scope-error" : "scope-hint"}><legend>공유 범위</legend><div className="scope-options">{[["code", "코드 발췌"], ["validation", "검증 결과"], ["events", "작업 이벤트"]].map(([key, label]) => <label key={key}><input type="checkbox" checked={setup.scope.includes(key)} onChange={(event) => field("scope", event.target.checked ? [...setup.scope, key] : setup.scope.filter((item) => item !== key))} />{label}</label>)}</div><p id="scope-hint" className="hint">개인 설명과 인증 정보는 공동 공개에 포함되지 않습니다.</p>{state.errors.scope && <p className="error" id="scope-error">{state.errors.scope}</p>}</fieldset>
          <button className="button primary wide" type="submit">모의 조사방 만들기 <span aria-hidden="true">↗</span></button>
        </form>
        <div className="observer-entry"><span>연결 프로그램 없이 기록만 살펴보기</span><button className="button quiet" type="button" onClick={() => dispatch({ type: "observe" })}>관찰자로 체험하기 →</button></div>
      </section>
      <section className="readiness-section" aria-labelledby="readiness-title">
        <div className="section-heading"><div><p className="eyebrow">예제 준비 상태</p><h2 id="readiness-title">연결할 두 작업 공간</h2></div><p className="hint">아래 정보는 합성 예제입니다. 실제 계정이나 기기를 확인한 값이 아닙니다.</p></div>
        <div className="readiness-grid">{bindings.map((binding, i) => <article className="panel readiness-card" key={binding.alias}><div className="repo-heading"><span className={`avatar ${i ? "teal" : ""}`} aria-hidden="true">{i ? "B" : "A"}</span><div><h3>{binding.alias}</h3><p>{binding.owner}</p></div><span className="badge">모의 준비</span></div><dl className="metadata"><dt>사람 / PC</dt><dd>예제 참가자 · 예제 PC {i ? "B" : "A"} · 모의 온라인 · 확인 14:32</dd><dt>브랜치</dt><dd>{binding.branch}</dd><dt>코드 상태</dt><dd>{binding.snapshot}</dd><dt>AI / 계정</dt><dd>모의 AI · 예제 버전 · 인증 미연결 · 실제 과금 없음</dd><dt>세션</dt><dd>{binding.session} · 합성 기록 이어보기</dd><dt>실행 범위</dt><dd>모의 읽기 · 검증 예시 · 수정 제안</dd><dt>공유 범위</dt><dd>{setup.scope.length ? setup.scope.map((key) => ({ code: "코드 발췌", validation: "검증 결과", events: "작업 이벤트" })[key as "code" | "validation" | "events"]).join(" · ") : "선택 필요"}</dd></dl><p className="card-foot">실제 runtime·connector에 연결되어 있지 않습니다.</p></article>)}</div>
      </section>
    </div>
  );
}
