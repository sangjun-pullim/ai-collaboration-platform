import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Connector } from "../cli.ts";
import { ConnectionError, isAlias, isHash, isId, type Scope } from "../contracts.ts";
import { RuntimeStore } from "../runtime-store.ts";
import { SettingsStore } from "../settings/store.ts";
import { prepareRecovery, MissingRecoveryRecordError } from "./connection-recovery.ts";
import type { StateStore } from "../state-store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";

export type ConnectInput = {
  organizationId: string;
  roomId: string;
  deviceAlias: string;
  previousProfile?: string;
  recoveryId?: string;
  recoveryChain?: string;
};
export type ConnectInteraction = {
  interactive: boolean;
  signal: AbortSignal;
  write: (message: string) => void;
  confirm: (scope: Scope, signal: AbortSignal) => Promise<boolean>;
  confirmRestart?: (signal: AbortSignal) => Promise<boolean>;
  confirmPreviousRevoked?: (signal: AbortSignal) => Promise<boolean>;
  confirmUnresolved?: (count: number, signal: AbortSignal) => Promise<boolean>;
  open: (url: string) => Promise<void>;
  pause?: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
  verifyPreparation?: () => Promise<void>;
};

function checkScope(scope: Scope | undefined, input: ConnectInput): Scope {
  if (!scope || scope.organizationId !== input.organizationId || scope.roomId !== input.roomId)
    throw new ConnectionError("FORBIDDEN");
  return scope;
}

/** The caller holds the settings device lock; profile writes keep their own transaction. */
export async function prepareConnection(
  connector: Connector,
  input: ConnectInput,
  interaction: ConnectInteraction,
  recoveryRunner?: (profile: StateStore, agentId: string) => WorkflowRunner,
  renewRegistered?: () => Promise<void>,
): Promise<void> {
  if (!isId(input.organizationId) || !isId(input.roomId) || !isAlias(input.deviceAlias))
    throw new ConnectionError("INVALID_BODY");
  if (!interaction.interactive) throw new ConnectionError("FORBIDDEN");
  if (input.previousProfile !== undefined || input.recoveryId !== undefined) {
    if (!recoveryRunner) throw new ConnectionError("INVALID_BODY");
    return prepareRecovery(connector, input, interaction, recoveryRunner, async (verify) => {
      if ((await connector.store.read())?.credential) await renewRegistered?.();
      await prepareConnection(
        connector,
        {
          organizationId: input.organizationId,
          roomId: input.roomId,
          deviceAlias: input.deviceAlias,
        },
        {
          ...interaction,
          verifyPreparation: async () => {
            await interaction.verifyPreparation?.();
            await verify();
          },
        },
      );
    });
  }
  const check = () => {
    if (interaction.signal.aborted) throw new ConnectionError("CONFLICT");
  };
  check();
  let state = await connector.store.read();
  if (
    state?.status === "disconnected" ||
    (state?.credential &&
      !(Date.parse(state.credentialExpiresAt ?? "") > (interaction.now ?? Date.now)()))
  )
    interaction.write(
      "이 연결의 인증은 다시 사용할 수 없습니다. 웹의 내 AI 연결에서 새 승인으로 다시 연결을 선택하세요. 이전 기록은 보존됩니다.\n",
    );
  if (state?.pending)
    interaction.write(
      state.pending.action === "rotate"
        ? "저장된 인증 갱신을 같은 명령으로 확인하세요. 새 프로필로 우회하지 마세요.\n"
        : "완료되지 않은 연결 작업이 있습니다. 같은 터미널과 원래 연결 상태를 먼저 확인하세요.\n",
    );
  if (state && state.server !== connector.client.origin) throw new ConnectionError("CONFLICT");
  if (state?.status === "disconnected") throw new ConnectionError("UNAUTHENTICATED");
  const transaction = <T>(job: () => Promise<T>) => connector.store.transaction(job);
  const now = interaction.now ?? Date.now;
  if (state?.status === "pairing" && Date.parse(state.pairingExpiresAt ?? "") <= now()) {
    if (
      state.pending ||
      state.registration ||
      state.credential ||
      state.deviceId ||
      state.mappings.length ||
      !state.proof ||
      !state.pairingId ||
      (await new SettingsStore(connector.store).read()) ||
      (await RuntimeStore.agents(connector.store.dir, connector.store.profile)).length
    )
      throw new ConnectionError("CONFLICT");
    if (state.scope) checkScope(state.scope, input);
    check();
    const status = await transaction(() => connector.status());
    check();
    if (status.state !== "expired") throw new ConnectionError("CONFLICT");
    interaction.write(
      "이전 기기 연결 코드가 만료됐습니다. 기존 기록을 보존하고 새 웹 승인을 받아야 합니다.\n",
    );
    if (!(await interaction.confirmRestart?.(interaction.signal)))
      throw new ConnectionError("CONFLICT");
    check();
    const expired = state;
    await interaction.verifyPreparation?.();
    check();
    await transaction(async () => {
      if (
        (await new SettingsStore(connector.store).read()) ||
        (await RuntimeStore.agents(connector.store.dir, connector.store.profile)).length
      )
        throw new ConnectionError("CONFLICT");
      check();
      await connector.store.archiveExpiredPairing(expired, check);
    });
    check();
    state = undefined;
  }
  let scope: Scope;
  if (state?.credential) {
    const status = await transaction(() => connector.status());
    check();
    if (status.state === "disconnected" && !status.pending)
      throw new ConnectionError("UNAUTHENTICATED");
    if (status.state !== "registered" || status.pending) throw new ConnectionError("CONFLICT");
    scope = checkScope(state.scope, input);
  } else if (state?.pending?.action === "exchange") {
    scope = checkScope(state.scope, input);
  } else {
    if (state?.pending && state.pending.action !== "begin") throw new ConnectionError("CONFLICT");
    const pairing = await transaction(async () => {
      await interaction.verifyPreparation?.();
      check();
      return connector.pair(input.deviceAlias);
    });
    check();
    if (!isHash(pairing.code)) throw new ConnectionError("CONFLICT");
    const expires = Date.parse(pairing.expiresAt ?? "");
    if (!Number.isFinite(expires) || expires <= now()) throw new ConnectionError("CONFLICT");
    const url = new URL("/app/connections", connector.client.origin);
    url.hash = new URLSearchParams({ code: pairing.code, room: input.roomId }).toString();
    interaction.write(`웹에서 기기를 승인하세요.\n${url.href}\n기기 연결 코드: ${pairing.code}\n`);
    try {
      await interaction.open(url.href);
    } catch {
      interaction.write("브라우저를 열지 못했습니다. 위 주소를 직접 열어 승인하세요.\n");
    }
    for (;;) {
      check();
      if (now() >= expires) throw new ConnectionError("CONFLICT");
      const status = await transaction(() => connector.status());
      check();
      if (now() >= expires) throw new ConnectionError("CONFLICT");
      if (status.state === "approved") {
        scope = checkScope(status.scope as Scope, input);
        break;
      }
      if (status.state !== "pending") throw new ConnectionError("CONFLICT");
      await (interaction.pause ?? ((signal) => delay(2000, undefined, { signal })))(
        interaction.signal,
      );
    }
  }
  check();
  if (!(await interaction.confirm(scope, interaction.signal)))
    throw new ConnectionError("FORBIDDEN");
  check();
  await interaction.verifyPreparation?.();
  check();
  if (!state?.credential) {
    await transaction(async () => {
      await interaction.verifyPreparation?.();
      check();
      return connector.exchange(input.roomId);
    });
    check();
  }
  const connected = await connector.store.read();
  checkScope(connected?.scope, input);
  if (connected?.status !== "connected" || connected.pending) throw new ConnectionError("CONFLICT");
  interaction.write(
    "기기 등록을 확인했습니다. 웹에서 AI와 폴더를 설정하고 이 터미널을 열어 두세요.\n",
  );
}

export function connectionFailureHint(error: unknown): string {
  if (error instanceof MissingRecoveryRecordError)
    return "이 명령의 이전 로컬 연결 기록을 찾지 못했습니다. 웹의 내 AI 연결에서 최신 명령을 다시 복사하세요. 기존 기록은 삭제하지 마세요.";
  const code = error && typeof error === "object" && "code" in error ? error.code : "UNAVAILABLE";
  if (
    [
      "RUNTIME_BUSY",
      "CLEANUP_INCOMPLETE",
      "CONTEXT_UNCONFIRMED",
      "AUTHORITY_LOST",
      "UNSAFE_STORAGE",
    ].includes(String(code))
  )
    return "이전 실행·종료 증거를 확인하지 못했습니다. 원래 터미널과 로컬 기록을 확인하세요. 새 이름으로 우회하거나 기록을 삭제하지 마세요.";
  if (code === "QUOTA")
    return "연결 한도에 도달했습니다. 내 AI 연결의 내 연결에서 이전 공개 연결 ID를 대조하고 해당 본인 연결의 연결 취소 여부를 확인하세요.";
  if (code === "UNAUTHENTICATED")
    return "이 기기의 인증은 더 이상 사용할 수 없습니다. 같은 명령을 다시 복사해도 복구되지 않습니다. 웹의 내 AI 연결에서 새 승인으로 다시 연결을 선택하세요. 이전 기록은 보존됩니다.";
  if (code === "CONFLICT")
    return "만료·끊김 또는 진행 중 연결 작업을 확인하세요. 같은 명령으로 상태를 확인하고, 완전히 만료된 연결은 웹의 내 AI 연결에서 새 승인으로 다시 연결을 선택하세요.";
  if (code === "FORBIDDEN")
    return "선택한 계정·방과 공개 연결 ID의 소유자를 확인하세요. 다른 참가자의 기기는 변경할 수 없습니다.";
  if (code === "INVALID_BODY")
    return "웹의 내 AI 연결에서 명령을 다시 복사하세요. 복구 명령의 일부 인자를 바꾸지 마세요.";
  return "연결 서비스를 확인한 뒤 같은 명령으로 다시 시도하세요. 이전 기록과 실패한 임시 실행 파일은 보존하세요.";
}

export function terminalInteraction(signal: AbortSignal): ConnectInteraction {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    signal,
    write: (message) => process.stdout.write(message),
    open: async (url) => {
      await promisify(execFile)("/usr/bin/open", [url], { timeout: 5000 });
    },
    confirmUnresolved: async (count, stop) => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new AbortController();
      input.once("close", () => closed.abort());
      try {
        return (
          (
            await input.question(
              `이전 답변 ${count}건을 보존하고 새 대화로 연결하려면 new를 입력하세요: `,
              { signal: AbortSignal.any([stop, closed.signal]) },
            )
          ).trim() === "new"
        );
      } finally {
        input.close();
      }
    },
    confirmPreviousRevoked: async (stop) => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new AbortController();
      input.once("close", () => closed.abort());
      try {
        return (
          (
            await input.question(
              "웹에서 이전 연결 ID를 확인하고 연결 취소를 마쳤으면 revoked를 입력하세요: ",
              { signal: AbortSignal.any([stop, closed.signal]) },
            )
          ).trim() === "revoked"
        );
      } finally {
        input.close();
      }
    },
    confirmRestart: async (stop) => {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new AbortController();
      input.once("close", () => closed.abort());
      try {
        const answer = await input.question(
          "새 연결 코드를 받으려면 restart를 입력하세요 (그 외 입력은 취소): ",
          {
            signal: AbortSignal.any([stop, closed.signal]),
          },
        );
        return answer.trim().toLowerCase() === "restart";
      } finally {
        input.close();
      }
    },
    confirm: async (scope, stop) => {
      const safe = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 160);
      process.stdout.write(
        `\n연결할 계정: ${safe(scope.ownerAlias)}\n조직: ${safe(scope.organizationName)} (${scope.organizationId})\n방: ${safe(scope.roomTitle)} (${scope.roomId})\n기기: ${safe(scope.deviceAlias)}\n`,
      );
      const input = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new AbortController();
      input.once("close", () => closed.abort());
      try {
        for (;;) {
          const answer = await input.question("내 계정과 선택한 방이 맞으면 yes를 입력하세요: ", {
            signal: AbortSignal.any([stop, closed.signal]),
          });
          const choice = answer.trim().toLowerCase();
          if (choice === "yes") return true;
          if (choice === "no") {
            process.stdout.write(
              "기기 연결을 취소했습니다. 같은 명령으로 다시 확인할 수 있습니다.\n",
            );
            return false;
          }
          process.stdout.write(
            "연결하려면 yes, 취소하려면 no를 입력하세요. Enter만 누르면 연결되지 않습니다.\n",
          );
        }
      } finally {
        input.close();
      }
    },
  };
}
