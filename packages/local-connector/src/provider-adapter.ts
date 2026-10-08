import { ClaudeAdapter, type ClaudeAdapterOptions } from "./claude/adapter.ts";
import { ClaudeLaunchPolicy, type SyntheticClaudeEvidence } from "./claude/launch-policy.ts";
import { NativeClaudePolicy } from "./claude/native-policy.ts";
import { ClaudeCatalogStore, type CatalogLease, type CatalogSync } from "./claude/catalog-store.ts";
import { ClaudeTransport } from "./claude/transport.ts";
import { CodexAdapter, type CodexAdapterOptions } from "./codex-adapter.ts";
import { CodexTransport } from "./codex-transport.ts";
import { RuntimeFilePolicy } from "./runtime-file-policy.ts";
import { RuntimeError, type RuntimeAdapter, type RuntimeProvider } from "./runtime-contracts.ts";
import type { StateStore } from "./state-store.ts";

export interface ProviderAdapterOptions {
  profile: Pick<StateStore, "dir" | "profile">;
  reserveCatalog?: ClaudeAdapterOptions["reserveCatalog"];
  // Internal constructor seams only. No CLI/env/web evidence or executable overrides.
  claude?: {
    evidence?: SyntheticClaudeEvidence;
    environment?: NodeJS.ProcessEnv;
    transport?: ClaudeAdapterOptions["transport"];
    transportOptions?: ClaudeAdapterOptions["transportOptions"];
  };
  codex?: CodexAdapterOptions;
  catalogSync?: CatalogSync;
}

/** Every production caller shares policy/history construction and the profile startup barrier. */
export function createProviderAdapter(
  provider: RuntimeProvider,
  options: ProviderAdapterOptions,
): RuntimeAdapter {
  const catalog = new ClaudeCatalogStore(options.profile, options.catalogSync);
  if (provider === "codex") {
    const original = options.codex?.transportFactory;
    return new CodexAdapter({
      ...options.codex,
      transportFactory: async (root, overrides, check) => {
        check();
        catalog.assertStartup();
        check();
        return original
          ? original(root, overrides, check)
          : CodexTransport.launch(root, overrides, check);
      },
    });
  }
  if (provider !== "claude") throw new RuntimeError("INVALID_RUNTIME");
  let lease: CatalogLease | undefined;
  const policy =
    options.claude?.evidence !== undefined
      ? new ClaudeLaunchPolicy(options.claude.evidence, options.claude.environment)
      : new NativeClaudePolicy(options.claude?.environment);
  return new ClaudeAdapter({
    policy,
    beforeContextCreation: () => catalog.assertStartup(),
    history: (context, check) => policy.history(context, check),
    reserveCatalog: async (root, version, fingerprint) => {
      catalog.assertStartup();
      if (options.reserveCatalog) return options.reserveCatalog(root, version, fingerprint);
      const selected = await RuntimeFilePolicy.select(root, []);
      lease = catalog.reserve(selected.root, version, fingerprint);
      return structuredClone(lease.context);
    },
    transportOptions: options.claude?.transportOptions,
    transport: (launch, check) => {
      catalog.assertStartup(lease);
      check();
      const transport =
        options.claude?.transport?.(launch, check) ??
        new ClaudeTransport(launch, check, options.claude?.transportOptions);
      if (lease) {
        const owned = lease;
        const close = transport.close.bind(transport);
        let closing: ReturnType<typeof close> | undefined;
        // Preserve the transport itself; intercept only its exact cleanup result.
        transport.close = () =>
          (closing ??= (async () => {
            try {
              const result = await close();
              catalog.finish(owned, result);
              if (result.reaped && result.code === "REAPED") lease = undefined;
              return result;
            } catch {
              // A close exception is not native cleanup confirmation.
              try {
                catalog.finish(owned, { reaped: false, code: "CLEANUP_INCOMPLETE" });
              } catch {
                /* Existing unresolved ledger remains a barrier. */
              }
              throw new RuntimeError("CLEANUP_INCOMPLETE");
            }
          })());
      }
      return transport;
    },
  });
}
