"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import type { PublicBinding } from "./contracts";
import { decodeSourceToken, type SourceFileRow, type SourceReadPage } from "./source-contracts";
import { callInvestigation } from "./investigation-client";
import {
  SourceViewController,
  type SourceRequest,
  type SourceViewState,
} from "./source-view-controller";
import { Button } from "../../components/ui/button";

// Escape control characters and unpaired UTF16 units without changing valid pairs.
export function safeSourceText(value: string): string {
  let text = "";
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      text += value[index] + value[++index];
    } else if (
      unit < 0x20 ||
      (unit >= 0x7f && unit <= 0x9f) ||
      (unit >= 0xd800 && unit <= 0xdfff) ||
      (unit >= 0x2028 && unit <= 0x202e) ||
      (unit >= 0x2066 && unit <= 0x2069)
    ) {
      text += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else text += value[index];
  }
  return text;
}

function SourceFile({ file }: { file: SourceFileRow }) {
  const phase =
    file.phase === "INPUT"
      ? "입력 전 선택 집합"
      : file.phase === "PEER"
        ? "공동 질문 전 파일 검증"
        : "실제 도구 반환 발췌";
  return (
    <li className="space-y-1 rounded border bg-white p-2">
      <p>
        {phase}
        {file.callIndex !== null
          ? ` · 호출 ${file.callIndex + 1} · 발췌 ${file.excerptIndex + 1}`
          : ""}
      </p>
      <p className="break-all font-mono">
        {safeSourceText(decodeSourceToken(file.pathJson) ?? "경로 확인 불가")}
      </p>
      <p className="break-all">파일 hash: {file.hash}</p>
      {file.byteStart !== null && (
        <p>
          {file.phase === "PEER" ? "질문 전 확인한 바이트 범위" : "실제 도구 반환 바이트 범위"}:{" "}
          {file.byteStart} 이상 {file.byteEnd} 미만
        </p>
      )}
      {file.excerptHash && <p className="break-all">발췌 hash: {file.excerptHash}</p>}
      {file.readAt && <p>파일 관찰 시각: {file.readAt}</p>}
      {file.requestedStartLine !== null && (
        <p>
          별도 요청 줄: {file.requestedStartLine}–{file.requestedEndLine} · 파일 전체{" "}
          {file.lineCount}줄
        </p>
      )}
      {file.resultHash && <p className="break-all">도구 반환 hash 보고: {file.resultHash}</p>}
      {file.phase === "PEER" && <p>저장된 파일 검증이며 질문 수락이나 전달을 확인하지 않습니다.</p>}
    </li>
  );
}

export function SourceDetails({
  page,
  bindings,
}: {
  page: SourceReadPage;
  bindings: PublicBinding[];
}) {
  const target = page.target;
  const current = target
    ? bindings.find(
        (binding) =>
          binding.agentId === target.agentId && binding.bindingEpoch === target.bindingEpoch,
      )
    : undefined;
  const summary = page.summary;
  return (
    <div className="space-y-3">
      {target ? (
        <div className="space-y-1">
          <p>질문 예약 당시 사람: {safeSourceText(target.ownerAlias)}</p>
          <p>당시 AI: {target.runtime === "claude" ? "Claude" : "Codex"}</p>
          <p>당시 공유 저장소: {safeSourceText(target.repositoryAlias)}</p>
          <p>당시 세션 별칭: {safeSourceText(target.sessionAlias)}</p>
          <p>예약 시각: {target.reservedAt}</p>
          {current ? (
            <p>
              현재 연결 정보: {safeSourceText(current.ownerAlias)} ·{" "}
              {current.runtime === "claude" ? "Claude" : "Codex"} ·{" "}
              {safeSourceText(current.repositoryAlias)} · {safeSourceText(current.sessionAlias)}
            </p>
          ) : (
            <p>현재 같은 연결 없음</p>
          )}
        </div>
      ) : (
        <p>당시 대상이 저장되지 않은 과거 기록입니다.</p>
      )}
      {page.state === "NO_SOURCE" && <p>당시 대상은 저장되어 있으나 파일 관찰 자료는 없습니다.</p>}
      {summary && (
        <>
          <div className="space-y-1">
            <p>
              {summary.readMode === "AUTO_CODE"
                ? "자동 탐색의 입력 전 선택 집합"
                : "입력 전 선택 집합"}
              : {summary.input.files.entryCount}개
            </p>
            {summary.readMode === "AUTO_CODE" && (
              <p>자동 탐색의 빈 선택 집합은 실제 파일 읽기가 없었다는 뜻이 아닙니다.</p>
            )}
            <p>입력 전 파일 검증 시각: {summary.input.files.validatedAt}</p>
            <p>
              도구 반환 기록: {summary.repositoryCallCount}회 · 공동 질문 전 파일 검증:{" "}
              {summary.peerCallCount}회
            </p>
            <p>
              파일 목록 도구: {summary.listCallCount}회 · 목록 반환은 파일 본문 읽기를 뜻하지
              않습니다.
            </p>
            <p>저장된 파일 항목: {summary.fileCount}개</p>
            <p>Git 관찰 시각: {summary.input.git.observedAt ?? "미확인"}</p>
            <p className="break-all">Git commit: {summary.input.git.commit ?? "미확인"}</p>
            <p className="break-all">
              Git ref:{" "}
              {summary.input.git.refJson === null
                ? "미확인"
                : safeSourceText(decodeSourceToken(summary.input.git.refJson) ?? "미확인")}
            </p>
            <p>Git 작업 상태: 미확인</p>
            <p className="break-all">자료 hash: {page.manifestHash}</p>
          </div>
          <ul aria-label="저장된 파일 관찰" className="space-y-2">
            {page.files.map((file) => (
              <SourceFile key={file.index} file={file} />
            ))}
          </ul>
          <p>
            저장된 관찰입니다. 모델 사용, 답변 인용, 질문 수락·전달, 테스트 통과를 입증하지
            않습니다.
          </p>
        </>
      )}
    </div>
  );
}

export function RunSourceView({
  roomId,
  eventId,
  bindings,
  onAccessLost,
  call = callInvestigation,
}: {
  roomId: string;
  eventId: string;
  bindings: PublicBinding[];
  onAccessLost: () => void;
  call?: SourceRequest;
}) {
  const [controller] = useState(
    () => new SourceViewController(roomId, eventId, call, onAccessLost),
  );
  useLayoutEffect(() => {
    controller.setCallbacks(call, onAccessLost);
  }, [controller, call, onAccessLost]);
  const [view, setView] = useState<SourceViewState>(controller.getSnapshot);
  useEffect(() => {
    controller.start();
    const unsubscribe = controller.subscribe(() => setView(controller.getSnapshot()));
    return () => {
      unsubscribe();
      controller.stop();
    };
  }, [controller]);
  const panelId = `source-${eventId}`;
  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={view.open}
        aria-controls={panelId}
        onClick={() => (view.open ? controller.close() : void controller.open())}
      >
        {view.open ? "저장소·자료 닫기" : "저장소·자료"}
      </Button>
      {view.open && (
        <section
          id={panelId}
          aria-label="당시 저장소·자료"
          className="mt-1 space-y-2 rounded-md border bg-neutral-50 p-3 text-xs text-neutral-600"
        >
          {view.busy && <p role="status">자료를 불러오는 중입니다.</p>}
          {view.error && (
            <p role="alert">
              {view.error === "ACCESS_LOST"
                ? "접근 권한을 확인해 주세요."
                : "자료를 불러올 수 없습니다."}
            </p>
          )}
          {view.page && <SourceDetails page={view.page} bindings={bindings} />}
          {view.error === "UNAVAILABLE" ? (
            <Button variant="outline" size="sm" onClick={() => void controller.retry()}>
              자료 다시 조회
            </Button>
          ) : (
            view.page?.nextIndex != null && (
              <Button
                variant="outline"
                size="sm"
                disabled={view.busy}
                onClick={() => void controller.next()}
              >
                다음 파일 관찰
              </Button>
            )
          )}
        </section>
      )}
    </div>
  );
}
