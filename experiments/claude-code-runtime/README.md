# Claude Code runtime experiment

This independent experiment implements a synthetic transport and evidence harness for
approved spec 009. It is not a product adapter, Claude compatibility acceptance, or
permission to execute the installed CLI. It imports no root, connector, SDK or server code.

## Current admission boundary

The supervisor's current native target is the unmodified official Claude Code CLI
**2.1.287** using the user's existing direct native login. Static SDK **0.3.287** types
inform that diagnostic. This package's original **2.1.286** fixture is synthetic and
does not attest native compatibility. No SDK is installed as a dependency or executed.

**Every production command currently refuses with
`EXECUTION_PRECEDENCE_UNCONFIRMED` before launching a provider.** There is no CLI flag,
environment override, generic boolean, profile exception, or supplied policy JSON that
turns this refusal into confirmation. Constructor-injected synthetic policy evidence is
accepted only with the exact local Node fake fixture launch. It cannot authorize an
official executable. A future reviewed change must add genuine version-specific native
evidence before the real probe path can be enabled.

The public package has no native admission bridge for task overrides, managed policy
precedence, reload, inherited plugin/hook startup and automatic user input. Separate
supervisor-owned startup guards and zero-input observations are tracked in
[delivery and validation](../../docs/delivery-and-validation.md#현재-진행-상태).
They do not enable this CLI. A post-start settings response or manifest alone does not
prove that earlier commands did not execute. Mandatory managed execution is refused.

The private diagnostic distinguishes command-fate metadata and history storage from
execution evidence. An own-input queued/completed command status is not an input ACK,
tool authorization or typed result. A matching saved user record proves storage only.
An unresolved input and its consumed budget slot remain preserved. A separately
proposed followup does not authorize an automatic retry or enable this package.

Other native facts are independently unverified:

- A zero-input native session's identity ACK, durable materialization and fresh-process
  resume. Initialization success or `getSessionMessages=[]` does not prove persistence.
- The exact on-disk native history schema/location and full owned-history proof.
  The exact-file reader is synthetic, accepts only the reserved UUID filename, never
  lists sessions, and is not wired to a guessed personal history path in the CLI.
- Native tool-use-to-MCP dispatch correlation. Fixture `_meta` fields are explicitly
  synthetic, not claimed official Claude fields. Missing native evidence must refuse.
- Version/host support for optional applied effort, same-input result correlation,
  completed/aborted terminal reasons and durable typed-result recovery.
- Effective task permission and instruction preservation under the user's managed
  configuration, plus exclusive-managed-MCP conflicts with strict owned configuration.

`preflight`, `probe-zero`, `probe-tools` and `probe-interrupt` are explicit command names.
The CLI exposes no arbitrary prompt or model option. Real tool/interrupt submission and
native history mapping remain refused until the missing facts and a reviewed driver are
implemented. The constructor-only synthetic runtime exercises their state machines now.

## Synthetic checks

Run from this directory with Node **24.21.0** on PATH. Set `TMPDIR` to the assigned private
task scratch for **every** test command. Dependencies are local to this package:
TypeScript 5.9.3, ESLint 9.39.5, parser 8.71.0, Node declarations 24.7.0.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run lint
npm run lint -- --debug
```

Lint's dedicated inventory is `src/**/*.ts`, `test/**/*.ts` and
`test/fixtures/**/*.mjs`, including the fake subprocess. Root experiment ignores are
not used. The twelve spec test names remain exact; subtests cover failure variants.
Fake processes use only isolated synthetic files/environment and no network fallback.

## Supervisor-owned approval budget

The product CLI does **not** create, reset or replenish an actual approval budget.
The supervisor must initialize one fixed canonical private directory, an approval
anchor, and its budget before any future permitted command. Directory mode is **0700**;
both regular files are **0600**, single-link and current-user-owned, with no symlink.
The supervisor writes and fsyncs files and directory. Keep the same approval path/ID,
budget ID/path across commands, restarts and roots. Do not copy an empty budget or make
a second approval to retry an ambiguous operation.

Approval anchor schema (illustration only; these are not actual authorization values):

```json
{
  "version": 1,
  "approvalId": "00000000-0000-4000-8000-000000000001",
  "budgetId": "00000000-0000-4000-8000-000000000002",
  "budgetPath": "/SUPERVISOR_PRIVATE_DIRECTORY/budget.json",
  "maxInputs": 3
}
```

Initial budget schema:

```json
{
  "version": 1,
  "approvalId": "00000000-0000-4000-8000-000000000001",
  "budgetId": "00000000-0000-4000-8000-000000000002",
  "maxInputs": 3,
  "slots": []
}
```

Both schemas reject unknown fields. Budget and anchor share the same directory.
Each consumed slot adds `slot` (1–3), `inputId` UUID, reserved `sessionId` UUID,
canonical `root`, `command` (`probe-tools` or `probe-interrupt`) and `promptHash` SHA256.
Slot consumption and complete input intent are written together under `budget.lock`,
then the local journal is fsynced before IPC. An orphaned budget intent blocks that
session's further launch. Completed, interrupted, lost ACK and ambiguous writes never
return a slot. This caps direct host inputs, not provider-internal/background usage.

The session journal is also private and held under `session.lock` until child cleanup.
Unresolved input becomes `UNKNOWN` on reopening. No automatic retry, new session
fallback, stale lock deletion or arbitrary native session adoption is provided.
Existing lock refusal requires owner investigation, not force-removal by this CLI.

## Safe zero-input opt-in command

After build, the supervisor may use the following command with its own exact approved
private paths. **It currently refuses before provider spawn and consumes zero slots.**
Do not run it to infer native compatibility or substitute the opt-in for policy proof.

```sh
node dist/src/cli.js probe-zero --native-opt-in \
  --approval /SUPERVISOR_PRIVATE_DIRECTORY/approval.json \
  --approval-id SUPERVISOR_APPROVAL_UUID \
  --root /SUPERVISOR_NEW_SYNTHETIC_ROOT \
  --state /SUPERVISOR_NEW_PRIVATE_STATE \
  --claude /OFFICIAL_UNMODIFIED_CLAUDE_EXECUTABLE
```

Once native admission is independently implemented, the root must be a fresh canonical
0700 synthetic directory with selected `owned-fixture.txt`; the state directory is new.
The same UUID must persist through graceful reap and a new process's read/resume.
No `shouldQuery:false`, priming turn, rename materialization, unrelated session listing,
authentication copy, persistent settings rewrite or private profile substitution is allowed.

Task arguments preserve user/project/local settings sources and omit model/effort
requests. They apply hooks disabled, known plugins explicitly false, no built-ins,
strict empty inherited MCP config and only two SDK-hosted tools registered over
initialize. Empty objects alone do not establish removal of inherited execution.
Native authentication/proxy/certificate/custom environment variables remain native-owned;
only explicit product namespaces/names are removed. Reserved-name collisions cannot
be inferred as personal versus product. These overlays have synthetic coverage, not
native precedence acceptance.

## Evidence and cleanup

Store host UUID reservation, native identity init, native history materialization,
input intent, transmission, ACK and typed terminal as distinct observations. SHA256
evidence and terminal text remain private. Public CLI output contains fixed status/code
or structural counts, never raw native paths/IDs, prompts, settings, credentials or errors.

Policy source fingerprints are checked at startup, input, callbacks and public result;
the active monitor runs at most 100ms apart by timer scheduling. Drift seals admissions
and results, preserves confirmed terminal evidence and marks unresolved input UNKNOWN.
Cleanup closes stdin, waits 250ms, sends TERM, waits 1s, sends KILL, waits 1s for owned
child reap; handler draining has a separate 1s bound and late jobs remain closed.
`CLEANUP_INCOMPLETE` is independent of input terminal status. No claim is made that
external changes are atomically prevented or native caches have zero side effects.

Only after confirmed completion and child reap may a host-owned synthetic file be
atomically replaced. New inode/size/hash snapshots must be fsynced in the journal before
the next input. Active input file changes cannot refresh a snapshot.

Private native evidence schema for root acceptance:

```text
kind: SYNTHETIC | ACTUAL_NATIVE
planSHA256, experimentSourceManifestSHA256, CLI version/binary SHA256
approvalId/budgetId (private), directInputCount, nativeObservationHashes
policy: CONFIRMED | UNVERIFIED | UNSUPPORTED (+ fixed reason)
instructions/settings preservation: same statuses, before/after hashes
zero-context persistence and fresh resume: same statuses, exact owned identity proof
tool correlation/selected-file identity: same statuses, native proof hashes
default model: requested / initialized / per-response observed (private)
effort: UNVERIFIED | OBSERVED (nullable/missing remain unverified)
completion/interrupt: typed evidence / ACK separately / UNKNOWN
cleanup: REAPED | CLEANUP_INCOMPLETE
```

No actual evidence, completed spec marker, review approval or Claude product registration
is claimed here. The supervisor owns the independent review, native opt-in, maximum-three
input acceptance, root docs and follow-up provider contract.
