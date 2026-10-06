"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import { requestSettings } from "./settings-client";
import { validateSelection, type ErrorCode, type State } from "./contracts";
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
const field = "grid gap-2 text-sm";
const select = "h-9 rounded-md border border-neutral-200 bg-white px-3 disabled:opacity-50";

export function RuntimeSettingsForm({
  deviceId,
  deviceAlias,
  disabled = false,
}: {
  deviceId: string;
  deviceAlias: string;
  disabled?: boolean;
}) {
  const controller = useMemo(() => new SettingsController(deviceId, requestSettings), [deviceId]);
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const { response, draft, busy, reservedOperationId } = view;
  const operation = response?.operation;
  const catalog = confirmedCatalog(response);
  const model = catalog?.models.find((item) => item.model === draft?.model);
  const saved = selectionSaved(view);
  const blocked = disabled || !!busy;
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

  return (
    <section
      className="grid gap-4 rounded-lg border border-neutral-200 p-4"
      aria-label={`${deviceAlias} AI 설정`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{deviceAlias}의 AI 설정</h3>
        <Badge variant="secondary">
          {operation
            ? operation.state === "CANCELLED" && operation.receipt?.state === "CANCELLED"
              ? "취소 · PC 정리 완료"
              : states[operation.state]
            : reservedOperationId
              ? "요청 결과 확인 중"
              : response
                ? "설정 요청 가능"
                : "현재 설정 확인 중"}
        </Badge>
      </div>
      <p className="text-sm text-neutral-600">
        자기 PC에서 <code>manage --profile &lt;profile&gt;</code>을 실행해 두세요. 프로필은 기기
        연결에 사용한 이름입니다. 새 폴더의 필요한 코드 자동 탐색과 답·근거 경로 기록을 해당 Mac에서
        승인합니다.
      </p>
      {(operation?.receipt?.readMode === "AUTO_CODE" ||
        (appliedCurrent && applied?.readMode === "AUTO_CODE")) && (
        <p className="text-sm text-neutral-600">
          필요한 코드 자동 탐색 · 답과 근거 상대 경로/hash를 채팅 기록에 공유
        </p>
      )}
      {view.error && (
        <p role="alert" className="text-sm text-red-700">
          {messages[view.error]}
        </p>
      )}
      {response && !response.current && (
        <p role="alert" className="text-sm text-amber-800">
          이전에 적용한 AI 연결이 현재 연결과 다릅니다. 자기 PC에서 연결 상태를 확인하세요.
        </p>
      )}
      <label className={field}>
        AI 프로그램
        <select
          className={select}
          value={view.provider ?? ""}
          disabled={blocked || !!reservedOperationId}
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
        variant="outline"
        disabled={blocked || !view.provider || !response?.current || !!reservedOperationId}
        onClick={() => void controller.selectFolder()}
      >
        Mac에서 폴더 선택
      </Button>
      {!!reservedOperationId && (
        <p role="status" className="text-sm text-neutral-600">
          {operation?.state === "CANCELLED"
            ? operation.receipt?.state === "CANCELLED"
              ? "PC에서 취소와 정리가 확인되었습니다. 새 설정을 요청할 수 있습니다."
              : "취소를 요청했습니다. PC에서 후보 설정 정리가 확인될 때까지 기다립니다."
            : operation?.state === "COMMITTED"
              ? "서버에 저장했습니다. PC가 설정을 확정할 때까지 기다립니다."
              : operation?.state === "APPLYING"
                ? "자기 PC에서 설정을 적용하고 있습니다. 실행 중인 AI 요청이 있으면 기다립니다."
                : operation?.state === "UNKNOWN" || operation?.state === "FAILED"
                  ? "같은 요청의 상태를 확인합니다. 자기 PC에서 미확정 작업을 확인하세요."
                  : operation?.state === "LOCAL_CONFIRMATION"
                    ? "PC에서 폴더와 공유 범위를 확인했습니다. 다른 프로그램이나 모델을 고르려면 먼저 취소하세요."
                    : "Mac의 폴더 선택 창과 공유 범위 확인을 완료하세요. PC가 꺼져 있거나 관리 프로그램이 종료되면 기다립니다."}
        </p>
      )}
      {operation?.state === "LOCAL_CONFIRMATION" && response?.catalog?.policy === "unsupported" && (
        <p role="alert" className="text-sm text-amber-800">
          이 PC에서 프로그램의 모델과 추론 강도를 검증하지 못했습니다. 자기 PC에서 설치 버전,
          로그인과 실행 권한을 확인한 뒤 이 요청을 취소하세요. 웹에서 로그인을 대신하지 않습니다.
        </p>
      )}
      {catalog && (
        <div className="grid gap-4 rounded-md bg-neutral-50 p-4">
          <p className="text-sm">공유 저장소: {operation!.receipt!.repositoryAlias}</p>
          <p className="text-xs text-neutral-500">
            PC에서 확인한 {catalog.runtime === "codex" ? "Codex" : "Claude"} {catalog.version}의
            모델만 표시합니다.
          </p>
          <label className={field}>
            모델
            <select
              className={select}
              value={draft?.model ?? ""}
              disabled={blocked || saved}
              onChange={(event) => controller.setModel(event.target.value)}
            >
              <option value="" disabled>
                모델 선택
              </option>
              {catalog.models.map((item) => (
                <option key={item.id} value={item.model}>
                  {item.model}
                </option>
              ))}
            </select>
          </label>
          {model && model.efforts.length > 0 ? (
            <label className={field}>
              추론 강도 (effort)
              <select
                className={select}
                value={draft?.effort ?? ""}
                disabled={blocked || saved}
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
          <Button
            variant="outline"
            disabled={blocked || !validSelection || saved}
            onClick={() => void controller.selectRuntime()}
          >
            {saved ? "모델 선택 확인됨" : "모델 선택 확인"}
          </Button>
          <label className={field}>
            공개 세션 별칭
            <Input
              value={view.sessionAlias}
              maxLength={40}
              disabled={blocked}
              placeholder="예: 내 작업 AI"
              onChange={(event) => controller.setSessionAlias(event.target.value)}
            />
          </label>
          <p className="text-xs text-neutral-500">
            공유 저장소와 세션 별칭은 연결한 AI 채팅방에 공개됩니다. 실제 경로와 인증 정보는 PC에
            남습니다.
          </p>
          <Button
            disabled={
              blocked ||
              !saved ||
              !view.sessionAlias.trim() ||
              response?.currentBinding === undefined
            }
            onClick={() => void controller.apply()}
          >
            PC에 설정 적용
          </Button>
        </div>
      )}
      {canCancel && (
        <Button variant="outline" disabled={blocked} onClick={() => void controller.cancel()}>
          설정 요청 취소
        </Button>
      )}
      {operation && (
        <div className="grid gap-1 border-t pt-3 text-sm" aria-label="요청한 설정">
          <h4 className="font-medium">요청한 설정</h4>
          <p>
            {operation.requested.runtime === "codex" ? "Codex" : "Claude"}
            {typeof operation.requested.model === "string"
              ? ` · ${operation.requested.model}`
              : " · 모델 선택 전"}
            {typeof operation.requested.effort === "string"
              ? ` · ${operation.requested.effort}`
              : ""}
          </p>
        </div>
      )}
      <div className="grid gap-1 border-t pt-3 text-sm" aria-label="PC에 적용된 설정">
        <h4 className="font-medium">PC에 적용된 설정</h4>
        {applied ? (
          <>
            <p>
              {applied.runtime === "codex" ? "Codex" : "Claude"} · {applied.model}
              {applied.effort !== null ? ` · ${applied.effort}` : ""}
            </p>
            <p>
              {applied.repositoryAlias} · {applied.sessionAlias}
            </p>
            <p className="text-neutral-600">
              {appliedCurrent ? "PC 설정 적용이 확인되었습니다." : "이전 연결에 적용된 설정입니다."}{" "}
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
    </section>
  );
}
