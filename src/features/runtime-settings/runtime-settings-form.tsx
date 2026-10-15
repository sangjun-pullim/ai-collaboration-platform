"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { requestSettings } from "./settings-client";
import { validateSelection, type Capability, type ErrorCode, type State } from "./contracts";
import { SetupProgress } from "../connection-setup/setup-status";
import { parseInspection, requestSetup } from "../connection-setup/setup-controller";
import { SettingsController, confirmedCatalog, selectionSaved } from "./settings-controller";

const messages: Record<ErrorCode, string> = {
  INVALID_BODY: "모델, 추론 강도와 공개 세션 별칭을 확인하세요.",
  BODY_TOO_LARGE: "설정 정보가 지원 크기를 넘었습니다. 자기 PC의 연결 프로그램을 확인하세요.",
  UNSAFE_ORIGIN: "이 화면에서 다시 요청하세요.",
  UNAUTHENTICATED: "로그인과 자기 PC의 기기 연결 인증을 확인하세요.",
  FORBIDDEN: "본인 기기와 참가 권한을 확인하세요.",
  NOT_FOUND: "설정 요청을 찾을 수 없습니다. 자기 PC의 연결 프로그램을 확인하세요.",
  CONFLICT: "설정이나 연결이 변경되었거나 AI가 사용 중입니다. 현재 상태와 자기 PC를 확인하세요.",
  QUOTA: "기기 설정 한도에 도달했습니다. 사용하지 않는 연결을 확인하세요.",
  UNAVAILABLE:
    "상태를 확인할 수 없습니다. 같은 요청의 상태를 계속 확인하며 자동으로 재적용하지 않습니다.",
};
const states: Record<State, string> = {
  REQUESTED: "PC 확인 기다림",
  LOCAL_CONFIRMATION: "PC 확인 완료 · 모델 선택",
  APPLYING: "PC 적용 기다림",
  COMMITTED: "서버 저장 완료 · PC 확정 기다림",
  APPLIED: "PC 설정 적용 완료",
  CANCELLED: "취소 요청됨",
  FAILED: "실패 · PC 확인 필요",
  UNKNOWN: "결과 미확정 · PC 확인 필요",
};
const field = "grid min-w-0 grid-cols-1 gap-2 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border border-neutral-200 bg-white px-3 disabled:opacity-50";

function modelLabel(
  model: string | null,
  catalog: Capability | null | undefined,
  runtime: unknown = catalog?.runtime,
  snapshotHash: unknown = catalog?.snapshotHash,
): string {
  if (catalog?.runtime !== runtime || catalog?.snapshotHash !== snapshotHash) return model ?? "";
  const name = catalog?.models.find((item) => item.model === model)?.displayName;
  return name && name !== model ? `${name} (${model})` : (model ?? "");
}

export function RuntimeSettingsForm({
  deviceId,
  deviceAlias,
  disabled = false,
  connectionRecent = true,
  guidanceActive = true,
  roomHref,
}: {
  deviceId: string;
  deviceAlias: string;
  disabled?: boolean;
  connectionRecent?: boolean;
  guidanceActive?: boolean;
  roomHref?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const controller = useMemo(
    () =>
      new SettingsController(
        deviceId,
        requestSettings,
        2500,
        undefined,
        deviceAlias,
        roomHref
          ? async (signal) =>
              parseInspection(
                await requestSetup(
                  "inspect",
                  { roomId: roomHref.split("/").at(-1)!, requestId: null, deviceId },
                  signal,
                ),
              )
          : undefined,
      ),
    [deviceId, deviceAlias, roomHref],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    const changed = () => controller.setVisible(document.visibilityState === "visible");
    changed();
    controller.start();
    document.addEventListener("visibilitychange", changed);
    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", changed);
    };
  }, [controller]);
  const { response, draft, busy, reservedOperationId } = view;
  const operation = response?.operation;
  const catalog = confirmedCatalog(response);
  const model = catalog?.models.find((item) => item.model === draft?.model);
  const saved = selectionSaved(view);
  const blocked = disabled || !!busy;
  const setupBlocked = blocked || !connectionRecent;
  const canCancel =
    !!reservedOperationId &&
    operation?.state !== "COMMITTED" &&
    operation?.state !== "APPLIED" &&
    operation?.state !== "CANCELLED" &&
    !(
      (operation?.state === "FAILED" || operation?.state === "UNKNOWN") &&
      Object.hasOwn(operation.requested, "expectedEpoch")
    );
  let validSelection = false;
  try {
    if (draft && catalog) {
      validateSelection(draft, catalog);
      validSelection = true;
    }
  } catch {}
  const applied = response?.applied;
  const appliedCurrent =
    response?.current &&
    applied?.state === "APPLIED" &&
    applied.configRevision === response.configRevision &&
    applied.agentId === response.currentBinding?.agentId &&
    applied.workspaceId === response.currentBinding?.workspaceId &&
    applied.bindingEpoch === response.currentBinding?.bindingEpoch;

  const cancellationPending =
    operation?.state === "CANCELLED" && operation.receipt?.state !== "CANCELLED";
  const phase = !connectionRecent
    ? "connection"
    : cancellationPending
      ? "cancellation"
      : operation?.state === "UNKNOWN" || operation?.state === "FAILED"
        ? "uncertain"
        : operation?.state === "COMMITTED" || operation?.state === "APPLYING"
          ? "applying"
          : operation?.state === "REQUESTED" || (reservedOperationId && !operation)
            ? "terminal"
            : catalog
              ? saved
                ? "apply"
                : "model"
              : appliedCurrent && !reservedOperationId
                ? "applied"
                : reservedOperationId
                  ? "terminal"
                  : "folder";
  const nextAction = {
    connection: cancellationPending
      ? "취소 확인을 기다리고 있지만 최근 통신을 확인하지 못했습니다. 다음: 1단계의 연결 명령을 Mac에서 실행하세요. PC가 취소와 정리를 확인해야 새 설정을 요청할 수 있습니다. 기기를 제거할 필요는 없습니다."
      : "최근 통신을 확인하지 못했습니다. 먼저 1단계의 연결 명령을 Mac에서 실행하세요. 기기와 이전 적용 설정은 그대로 유지됩니다.",
    cancellation:
      "PC의 취소 확인을 기다립니다. 다음: 실행 중인 연결 터미널을 확인하세요. 최근 통신만으로 취소와 정리가 완료되지는 않습니다.",
    uncertain:
      "결과가 아직 확정되지 않았거나 요청이 실패했습니다. 다음: 실행 중인 연결 터미널에서 같은 요청의 상태를 확인하세요. 새 요청이나 재적용은 하지 않습니다.",
    applying:
      "PC의 설정 확정을 기다립니다. 다음: 실행 중인 연결 터미널의 적용 상태를 확인하세요. 서버 저장만으로 적용이 완료되지는 않습니다.",
    terminal:
      operation?.state === "LOCAL_CONFIRMATION"
        ? "PC에서 모델 목록을 확인하지 못했습니다. 다음: 연결 터미널에서 설치 버전과 로그인 상태를 확인하고 이 요청을 취소하세요."
        : "다음: Mac의 폴더 선택 창에서 폴더와 공유 범위를 확인하세요. 연결 터미널을 열어 두세요.",
    model: "모델·추론 강도·공개 세션 별칭을 확인하고 설정 저장을 누르세요.",
    apply: "선택이 확인되었습니다. 공개 세션 별칭을 확인하고 저장 계속을 누르세요.",
    applied:
      "PC 설정 적용이 확인되었습니다. 다음: 채팅방에서 질문 대상을 선택하고 AI 응답 준비를 확인하세요.",
    folder: view.provider
      ? "다음: Mac에서 폴더 선택을 눌러 폴더와 공유 범위를 확인하세요."
      : "다음: 사용할 AI 프로그램을 선택하세요. 그러면 Mac에서 폴더를 선택할 수 있습니다.",
  }[phase];

  function openConnectionCommand() {
    const section = document.getElementById("mac-connection");
    if (section) section.hidden = false;
    section?.focus();
  }

  return (
    <section className="grid min-w-0 grid-cols-1 gap-3" aria-label={`${deviceAlias} AI 설정`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-3 font-semibold">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${phase === "applied" ? "bg-emerald-50 text-emerald-700" : "bg-neutral-900 text-white"}`}
          >
            {phase === "applied" ? "✓" : catalog ? "3" : "2"}
          </span>
          {phase === "applied" ? "AI 설정 완료" : catalog ? "모델과 답변 설정" : "AI와 폴더 선택"}
        </h3>
        <Badge variant="secondary">
          {operation
            ? operation.state === "CANCELLED" && operation.receipt?.state === "CANCELLED"
              ? "취소 · PC 정리 완료"
              : states[operation.state]
            : reservedOperationId
              ? "요청 결과 확인 중"
              : appliedCurrent
                ? "PC 설정 적용 완료"
                : response
                  ? "설정 요청 가능"
                  : "현재 설정 확인 중"}
        </Badge>
      </div>
      {guidanceActive && (
        <div
          id="settings-next-action"
          data-phase={phase}
          role="status"
          className="space-y-2 rounded-md bg-neutral-50 p-3 text-sm"
        >
          {reservedOperationId ? (
            <SetupProgress
              embedded
              inspection={
                view.setupInspection ? { ...view.setupInspection, runtime: response } : null
              }
              now={view.setupCheckedAt}
              error={view.setupError}
              manual={view.pollManual}
              fallback={
                view.applyUnconfirmed
                  ? "적용 요청 결과가 미확정입니다. 같은 요청의 상태를 다시 확인하세요. 자동으로 다시 적용하지 않습니다."
                  : nextAction
              }
              onCheck={() => {
                void controller.poll();
              }}
            />
          ) : (
            <>
              <p>{nextAction}</p>
              {(view.error || view.setupError || view.pollManual) && (
                <Button variant="outline" onClick={() => controller.poll()}>
                  상태 다시 확인
                </Button>
              )}
            </>
          )}
          {view.error && (
            <p role="alert" className="text-red-700">
              {messages[view.error]}
            </p>
          )}
          {guidanceActive && connectionRecent && phase === "applied" && roomHref && (
            <a
              href={roomHref}
              aria-label="채팅 시작"
              className="inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground"
            >
              채팅 시작
            </a>
          )}

          {!connectionRecent && (
            <a
              href="#mac-connection"
              onClick={openConnectionCommand}
              aria-label="Mac 연결 명령으로 이동"
              className="inline-block rounded-md border px-3 py-2 font-medium"
            >
              Mac 연결 명령 보기
            </a>
          )}
          {phase === "cancellation" && (
            <div>
              <p className="mt-2">
                실행 중인 연결이 없는지 Mac에서 확인한 뒤{" "}
                <a href="#mac-connection" onClick={openConnectionCommand} className="underline">
                  1단계의 연결 명령
                </a>
                을 실행하세요. 기기를 제거할 필요는 없습니다.
              </p>
            </div>
          )}
        </div>
      )}
      {(operation?.receipt?.readMode === "AUTO_CODE" ||
        (appliedCurrent && applied?.readMode === "AUTO_CODE")) && (
        <p className="text-sm text-neutral-600">
          필요한 코드 자동 탐색 · 답과 근거 상대 경로/hash를 채팅 기록에 공유
        </p>
      )}
      {response && !response.current && (
        <p role="alert" className="text-sm text-amber-800">
          이전에 적용한 AI 연결이 현재 연결과 다릅니다. 자기 PC에서 연결 상태를 확인하세요.
        </p>
      )}
      {appliedCurrent && !reservedOperationId && (
        <Button
          type="button"
          variant="outline"
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "변경 닫기" : "AI·폴더 변경"}
        </Button>
      )}
      <section
        hidden={!!catalog || !!reservedOperationId || (!!appliedCurrent && !editing)}
        aria-label="AI와 폴더 선택"
      >
        <div className="grid gap-3 pt-2">
          <label className={field}>
            AI 프로그램
            <select
              className={select}
              value={view.provider ?? ""}
              aria-label="AI 프로그램"
              aria-describedby="settings-prerequisites"
              disabled={setupBlocked || !!reservedOperationId}
              onChange={(event) => {
                if (event.target.value === "codex" || event.target.value === "claude")
                  controller.setProvider(event.target.value);
              }}
            >
              <option value="" disabled>
                프로그램 선택
              </option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <Button
            aria-label="Mac에서 폴더 선택"
            variant={
              guidanceActive && connectionRecent && phase === "folder" ? "default" : "outline"
            }
            disabled={setupBlocked || !view.provider || !response?.current || !!reservedOperationId}
            onClick={() => {
              setEditing(false);
              void controller.selectFolder();
            }}
          >
            Mac에서 폴더 선택
          </Button>
          <p id="settings-prerequisites" className="text-xs text-neutral-600">
            {!connectionRecent
              ? "AI와 폴더 선택은 Mac의 최근 통신을 확인한 뒤 가능합니다. 먼저 1단계를 완료하세요."
              : reservedOperationId
                ? "진행 중인 요청이 끝나거나 PC의 취소·정리가 확인되어야 AI와 폴더를 새로 선택할 수 있습니다."
                : !response?.current
                  ? "현재 기기 설정을 확인해야 폴더 선택이 가능합니다."
                  : !view.provider
                    ? "AI 프로그램을 먼저 선택하면 Mac에서 폴더 선택을 사용할 수 있습니다."
                    : "폴더와 공유 범위를 Mac에서 확인하면 3단계의 모델 선택을 사용할 수 있습니다."}
          </p>
        </div>
      </section>
      {operation?.state === "LOCAL_CONFIRMATION" && response?.catalog?.policy === "unsupported" && (
        <p role="alert" className="text-sm text-amber-800">
          이 PC에서 프로그램의 모델과 추론 강도를 검증하지 못했습니다. 자기 PC에서 설치 버전,
          로그인과 실행 권한을 확인한 뒤 이 요청을 취소하세요. 웹에서 로그인을 대신하지 않습니다.
        </p>
      )}
      <section aria-label="모델 선택과 채팅 시작" hidden={!catalog}>
        {catalog ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 rounded-lg bg-neutral-50 p-4">
            <p className="text-sm">공유 저장소: {operation!.receipt!.repositoryAlias}</p>
            <p className="text-xs text-neutral-500">
              PC에서 확인한 {catalog.runtime === "codex" ? "Codex" : "Claude"} {catalog.version}의
              모델만 표시합니다.
            </p>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className={field}>
                모델
                <select
                  className={select}
                  aria-label="모델"
                  value={draft?.model ?? ""}
                  disabled={setupBlocked || saved}
                  onChange={(event) => controller.setModel(event.target.value)}
                >
                  <option value="" disabled>
                    모델 선택
                  </option>
                  {catalog.models.map((item) => (
                    <option key={item.id} value={item.model}>
                      {modelLabel(item.model, catalog)}
                    </option>
                  ))}
                </select>
              </label>
              {model && model.efforts.length > 0 ? (
                <label className={field}>
                  추론 강도
                  <select
                    className={select}
                    aria-label="추론 강도"
                    value={draft?.effort ?? ""}
                    disabled={setupBlocked || saved}
                    onChange={(event) => controller.setEffort(event.target.value)}
                  >
                    <option value="" disabled>
                      추론 강도 선택
                    </option>
                    {model.efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              ) : model ? (
                <p className="text-sm">이 모델은 별도의 추론 강도 설정을 사용하지 않습니다.</p>
              ) : null}
            </div>
            <p className="text-xs text-neutral-500">
              추론 강도는 AI가 답을 검토하는 정도입니다. Mac에서 지원하는 값만 표시합니다.
            </p>
            <label className={field}>
              공개 세션 별칭
              <Input
                aria-label="공개 세션 별칭"
                value={view.sessionAlias}
                maxLength={40}
                disabled={setupBlocked}
                placeholder="예: 내 작업 AI"
                onChange={(event) => controller.setSessionAlias(event.target.value)}
              />
            </label>
            <p className="text-xs text-neutral-500">
              공유 저장소와 세션 별칭은 연결한 AI 채팅방에 공개됩니다. 실제 경로와 인증 정보는 PC에
              남습니다.
            </p>
            <Button
              aria-label="설정 저장"
              variant={
                guidanceActive && connectionRecent && (phase === "apply" || phase === "model")
                  ? "default"
                  : "outline"
              }
              disabled={
                setupBlocked ||
                !!view.applyUnconfirmed ||
                !validSelection ||
                !view.sessionAlias.trim() ||
                response?.currentBinding === undefined
              }
              onClick={() => void controller.save()}
            >
              {saved ? "저장 계속" : "설정 저장"}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-neutral-600">
            {appliedCurrent && !reservedOperationId
              ? "PC에 적용된 설정은 아래에서 확인하세요. 채팅방의 질문 대상 선택에서 AI 응답 준비를 확인할 수 있습니다."
              : "모델 선택과 적용은 Mac에서 AI와 폴더를 확인한 뒤 가능합니다."}
          </p>
        )}
      </section>
      {canCancel && (
        <Button variant="outline" disabled={blocked} onClick={() => void controller.cancel()}>
          설정 요청 취소
        </Button>
      )}
      {saved && (
        <p className="text-sm">
          서버에 저장된 모델 선택은 고정됩니다. 다른 모델을 원하면 같은 요청의 취소와 PC 정리 확인
          후 새 설정을 시작하세요.
        </p>
      )}
      <div className="border-t pt-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={showTechnical}
          onClick={() => setShowTechnical(!showTechnical)}
        >
          설정 상세 · 도움말
        </Button>
        <div hidden={!showTechnical} className="space-y-3 pt-3">
          {operation && (
            <section className="grid gap-1 text-sm" aria-label="요청한 설정">
              <h4 className="font-medium">요청한 설정</h4>
              <p>
                {operation.requested.runtime === "codex" ? "Codex" : "Claude"}
                {typeof operation.requested.model === "string"
                  ? ` · ${modelLabel(operation.requested.model, response?.catalog, operation.requested.runtime, operation.requested.snapshotHash)}`
                  : " · 모델 선택 전"}
                {typeof operation.requested.effort === "string"
                  ? ` · ${operation.requested.effort}`
                  : ""}
              </p>
            </section>
          )}
          <p className="text-sm text-neutral-600">
            연결 명령을 실행한 터미널을 계속 열어 두세요. 추가 관리 프로세스는 필요하지 않습니다.
          </p>
          <p className="text-sm text-neutral-600">
            수동 pair·exchange 연결만 같은 프로필로 <code>manage --profile &lt;profile&gt;</code>을
            실행하세요.
          </p>
        </div>
      </div>
      <div hidden={!applied} aria-label="PC에 적용된 설정">
        <div className="grid gap-1 rounded-lg bg-neutral-50 p-4 text-sm">
          <h4 className="font-medium">PC에 적용된 설정</h4>
          {applied ? (
            <>
              <p>
                {applied.runtime === "codex" ? "Codex" : "Claude"} ·{" "}
                {modelLabel(
                  applied.model,
                  response?.catalog,
                  applied.runtime,
                  applied.snapshotHash,
                )}
                {applied.effort !== null ? ` · ${applied.effort}` : ""}
              </p>
              <p>
                {applied.repositoryAlias} · {applied.sessionAlias}
              </p>
              <p className="text-neutral-600">
                {appliedCurrent
                  ? "PC 설정 적용이 확인되었습니다."
                  : "이전 연결에 적용된 설정입니다."}{" "}
                AI 응답 준비는 AI 채팅방의 질문 대상 선택에서 확인하세요.
              </p>
            </>
          ) : (
            <p className="text-neutral-600">
              아직 PC 적용 확인이 없습니다. 기기 등록과 서버 저장만으로 AI 응답 준비가 완료되지는
              않습니다.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
