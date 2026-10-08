"use client";

import { useReducer } from "react";
import Link from "next/link";
import { initialState, prototypeReducer } from "./prototype-state.ts";
import { SetupView } from "./setup-view";
import { RoomView } from "./room-view";

export function PrototypeApp() {
  const [state, dispatch] = useReducer(prototypeReducer, undefined, initialState);
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link className="brand" href="/demo" aria-label="조사실 처음으로">
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>
          조사실<span className="brand-sub">함께 찾는 다음 단서</span>
        </Link>
        <span className="simulation-label">
          <span aria-hidden="true" />
          모의 체험
        </span>
      </header>
      <div className="simulation-banner">
        <strong>예제 데이터로 체험 중</strong>
        <span>
          실제 로그인·저장소 연결·AI 실행은 연결되지 않았습니다. 새로고침하면 기록이 초기화됩니다.
        </span>
      </div>
      <main>
        {state.stage === "setup" ? (
          <SetupView state={state} dispatch={dispatch} />
        ) : (
          <RoomView state={state} dispatch={dispatch} />
        )}
      </main>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.announcement}
      </div>
      <footer className="site-footer">
        <span>조사실 / WEB PREVIEW 002</span>
        <span>공동 기록과 개인 설명의 경계를 확인하는 체험</span>
      </footer>
    </div>
  );
}
