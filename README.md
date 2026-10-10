# Holy of Holies

Holy of Holies is the sovereign, open-source orchestration core for a free, decentralized and security-first software engineering platform. The core is licensed under **GNU AGPL-3.0-or-later**, chosen as an initial copyleft default so modified network-served versions remain available to their users. This is a project licensing decision, not legal advice.

This repository is the **standalone Holy of Holies (HH) core**, not the Zion implementation. HH has no mandatory dependency on Zion, REA, or any other external system and must remain fully usable when all integrations are absent. Zion and REA are independently maintained projects. A user may explicitly opt into connecting HH to either of them—or to a different system—through versioned, documented adapters/contracts. No integration is enabled, assumed, or required by default; the user must control connection, permissions, data sharing, and disconnection.

## Architectural boundaries

- **Core:** task lifecycle, policy decisions, project/workspace coordination, evidence and recovery.
- **External integrations:** optional, independently versioned adapters selected and configured by the user. Zion, REA, and other systems are examples, not dependencies or privileged defaults.
- **Integration boundary:** the core must start and support its local workflows without any adapter installed. Adapters must declare capabilities, request only scoped permissions, and be removable without corrupting core data or lifecycle state.
- **Model providers:** replaceable. Essential workflows must not require a paid API or a proprietary hosted service.
- **Security:** deny by default. A policy decision is not a substitute for operating-system isolation; untrusted code must not run unless an effective sandbox is independently established.

## Initial implementation

The current foundation includes a task state machine, fail-closed policy evaluator, tamper-evident JSONL event ledger, durable task orchestrator, explicitly selected provider registry with input/output validators, scoped workspace reads/atomic writes, Ed25519 attestation signing and public-key verification, durable revocation, and an OCI container verification runner with bounded resources and concurrency, no network, and a SHA-256 workspace manifest checked before and after execution. Successful workspace digests are included in the schema-v3 signed completion evidence. The verifier must be configured with `getWorkspaceDigest` to recompute the live project digest at completion; without it, workspace-bound evidence is rejected. Task completion still depends on a separately operated trusted issuer and configured verifier. The container runner is defense in depth, not a VM or a formal sandbox. Automated tests and GitHub Actions exercise the modules; the full autonomous engineering workflow and production trust deployment remain incomplete.

## Requirements

- Node.js 22 or newer
- No runtime dependencies

## Development

```sh
npm test
```

## Project principles

1. Free essential capabilities; no mandatory subscriptions, credits, or proprietary service.
2. Open source and auditable implementation.
3. No mandatory central controller for core local workflows.
4. Explicit authorization and least privilege.
5. Verifiable outcomes: never equate a tool invocation with successful completion.
6. Recovery and portability by design.
7. External integrations must be replaceable and versioned.

## Status

Early core foundation. The task and provider APIs are expected to evolve before a stable release. The project license is now declared. A formal release still requires a contribution policy, dependency/notice audit, security review and release verification.


## Tool Registry

The core now exposes `ToolRegistry` for explicit tool allowlisting. Each registered tool declares strict JSON input/output contracts, whether it is read-only, and bounded input/output sizes and execution time. Every invocation is checked against the configured policy evaluator. Side-effecting tools require a short-lived approval record consumed through an injected `consumeApproval` function. The consumer must atomically claim each approval ID as single-use in durable shared storage and validate the trusted record against the invoking principal, exact tool/action/resource, and the supplied SHA-256 hash of the canonical normalized input; caller-supplied metadata alone is not trusted. The registry fails closed when atomic consumption is unavailable or rejects a replay. If cancellation arrives after consumption but before dispatch, the approval remains consumed and must be reissued.

Cancellation and timeout signals are cooperative. They do **not** terminate hostile code running inside the same process. Do not register untrusted handlers in-process; production execution requires a separately hardened OS/container boundary, credential scoping, and resource enforcement.


### Recommended durable composition

For registries that may execute side effects, prefer the exported `createDurableToolRegistry` composition instead of manually wiring `ToolRegistry` and `OperationRecovery`. It requires a compatible `EventLedger`, an explicit policy evaluator, and an atomic approval consumer, and returns both `tools` and `recovery`. This makes durable intent journaling part of the composition: every non-read-only invocation requires a stable `operationId`, and dispatch is denied if the intent cannot be recorded.

```js
import { EventLedger, createDurableToolRegistry } from "holy-of-holies-core";

const { tools, recovery } = createDurableToolRegistry({
  ledger: new EventLedger("./state/operations.jsonl"),
  authorize: policyEvaluator,
  consumeApproval: atomicApprovalConsumer,
});
```

The caller must supply real, trusted implementations of `policyEvaluator` and `atomicApprovalConsumer`; placeholder callbacks are not a production security boundary. Protect the ledger path and its directory with appropriate OS permissions and backups. The composition does not provide distributed consensus, external exactly-once execution, or automatic retries.

## Verification Runner

`VerificationRunner` executes only explicitly configured commands, with a fixed executable and argument list, no shell, policy authorization, timeouts, output limits, and hashed reports. A passing exit code is necessary but not sufficient: a trusted verification service must independently issue an Ed25519-signed attestation through `VerificationAttestor`. `VerificationEngine` holds only the public key and cannot sign.

This runner is a constrained process launcher, **not a security sandbox**. It does not provide CPU/memory quotas, network isolation, filesystem isolation, syscall filtering, or a reliable way to kill descendants. Do not run untrusted project code directly on the host. Use `ContainerVerificationRunner` for a digest-pinned OCI container with no network, read-only source mount and explicit CPU, memory and process limits; prefer rootless Podman or an equivalent dedicated worker, and persist signed evidence outside the worker. Container isolation still depends on the host kernel and runtime and is not a VM or a formal sandbox. The pre/post workspace digest detects persistent changes during a run but is not an immutable snapshot against a hostile host process that changes and restores files between checks.

## Verification Coordination and Durable Evidence

`VerificationCoordinator` links the allowlisted runner to an injected external attestation issuer and the hash-chained `EventLedger`. It records start, completion, runner failure, and attestation rejection events. The ledger stores command metadata and hashes, not raw stdout/stderr, reducing accidental persistence of secrets. A passing run is not treated as complete unless the external attestation issuer returns an Ed25519-signed attestation bound to the same task, project, and result hash. The verifier holds only the public key; the issuer alone holds the private signing key.

The issuer is an interface, not a built-in isolated service. The deployment must implement it as a separate trusted principal and configure it to sign only after independent verification. The local hash chain is tamper-evident, not immutable against a privileged attacker who can rewrite the entire ledger. The coordinator claims verification IDs with compare-and-append against the shared ledger head, preventing two successful starts for the same ID in one shared ledger. This is not a general transactional database and cannot coordinate independent ledger copies; stale locks and crash recovery remain operator-visible failure cases. `inspectRecoveries()` reports starts that have no terminal event as `unknown_after_interruption`; it is read-only and never retries commands. Operators must decide whether a run is safe to retry because a crash can occur after a command caused external side effects but before its result was durably recorded.


For successful runs, `completionEvidence` is returned in the exact envelope expected by the completion verifier: verification ID, trusted verifier ID, outcome, result hash, and the complete signed attestation. Pass this evidence to the task transition that requests `verifying → completed`; the orchestrator still invokes its independently configured verifier and fails closed if verification is unavailable or returns false.


## Interrupted Side-Effect Reconciliation

`OperationRecovery` records operations whose external outcome is unknown after an interruption, using the durable hash-chained `EventLedger`. Reusing an operation ID with different input metadata is rejected; repeated identical interruption records are idempotent. A separate principal must resolve the record with a bounded evidence reference, choosing only `confirmed_succeeded`, `confirmed_failed`, or `confirmed_not_executed`. Resolutions are durable and conflicting second resolutions fail closed.

**This is reconciliation, not exactly-once execution.** The component never retries an operation automatically and does not itself prove that an evidence reference is truthful or enforce the resolver's organizational role. Deployments must authenticate/authorize the resolving principal and validate evidence independently. A `confirmed_not_executed` result is a recorded operator decision, not permission for this component to dispatch a retry.


The recovery API also provides `inspect()`, which reconstructs pending and resolved operations from the ledger after process restart. It fails closed on semantic inconsistencies such as duplicate interruption/resolution records, malformed operation events, or a resolution without a corresponding interruption. This is a read-only reconstruction; it does not dispatch tools or authorize retries.


### Downstream idempotency for side effects

A durable `operationId` prevents the core from blindly dispatching the same journaled operation again, but it cannot prove whether a remote provider completed an action when the process crashes or completion recording fails. If a downstream provider supports idempotency keys, derive a stable key scoped to the provider account and operation:

```js
import { createIdempotencyKey } from "holy-of-holies-core";

const idempotencyKey = createIdempotencyKey({
  providerScope: "payments:merchant-42",
  operationId,
});

// Pass idempotencyKey to the provider's documented idempotency field.
// On an uncertain outcome, query provider status before resolving recovery.
```

Use the same provider scope and operation ID for every retry of the same logical action; use a distinct operation ID for a genuinely new action. Keep provider scope stable and specific to the tenant/account boundary. The helper returns a deterministic SHA-256 key; it does not call the provider, persist status, or guarantee exactly-once effects. Respect the provider's key retention window and semantics. If the provider offers neither idempotent requests nor reliable status lookup, do not automatically retry an uncertain side effect: leave it unresolved for independent reconciliation.

#### ToolRegistry adapter contract

For a side-effecting tool with a fixed provider-account boundary, declare `providerScope` in its registration. The registry then derives the key from the stable `operationId` and exposes it to the handler as `context.idempotencyKey`; the handler/adapter must forward that exact value using the provider's documented idempotency field. Provider-scoped tools require an `operationId`, even when the local operation journal is not enabled. Read-only tools cannot declare `providerScope`.

```js
 tools.register({
   toolId: "payments.charge",
   description: "Charge a payment provider account",
   readOnly: false,
   providerScope: "payments:merchant-42",
   inputSchema,
   outputSchema,
   handler: async ({ input, context }) => paymentClient.charge(input, {
     idempotencyKey: context.idempotencyKey,
   }),
 });
```

Use a separate registry/tool configuration for each provider-account scope, or otherwise ensure the scope is selected from trusted configuration rather than caller-controlled input. Do not generate a fresh operation ID for a retry. A stable key only protects against duplicates if the provider actually honors it; recovery remains manual and evidence-backed when the remote outcome is uncertain.


#### Evidence-verified provider reconciliation adapter

The exported `reconcileProviderOperation()` helper provides a fail-closed contract for deployments that can query a provider's authoritative operation state. It receives a configured `providerScope`, derives the same deterministic idempotency key, and passes the expected operation ID, scope, key, principal, tool, and input hash to the injected lookup adapter. The returned status must explicitly be `confirmed_succeeded`, `confirmed_failed`, `confirmed_not_executed`, or `unknown`, and the operation ID, provider scope, and key must exactly match the expected binding.

Only a non-unknown result proceeds to the injected `verifyEvidence` callback. That callback must authenticate the evidence and confirm it is bound to the exact operation, provider account/scope, idempotency key, and status; the helper requires an explicit `verified: true` result and a bounded evidence reference before writing a durable resolution. The helper does not treat a lookup exception, missing record, malformed response, or failed verification as proof of non-execution. An `unknown` status remains unresolved. No path in this helper dispatches or retries the side effect.

```js
import { reconcileProviderOperation } from "holy-of-holies-core";

const result = await reconcileProviderOperation({
  recovery,
  operationId,
  providerScope: "payments:merchant-42", // trusted configuration, never caller input
  resolvedBy: "operator:reviewer", // authenticated independent principal
  lookupOperation: providerAdapter.lookupOperation,
  verifyEvidence: providerAdapter.verifyEvidence,
});

if (!result.resolved) {
  // Keep the operation pending for independent investigation; do not retry.
}
```

These injected callbacks are security-critical trust boundaries, not generic provider integrations supplied by the core. The deployment must authenticate the provider response, validate account/tenant identity and operation/key binding, enforce authorization for the independent resolver, and ensure evidence references are durable and auditable. A boolean from an untrusted adapter is not proof. Provider lookup semantics, idempotency retention, and the authenticity of provider receipts must be validated for each concrete provider.


## Repository preservation and audit status

- **Main source branch:** [`main`](https://github.com/LU9DI/Holy-Of-Holies/tree/main)
- **Preservation snapshot:** [`backup-snapshot-2026-10-10`](https://github.com/LU9DI/Holy-Of-Holies/tree/backup-snapshot-2026-10-10)
- **Snapshot ZIP:** [Download source archive](https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/backup-snapshot-2026-10-10.zip)
- **Main ZIP:** [Download main branch archive](https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/main.zip)
- **Audit report:** [Audit and preservation notes](https://github.com/LU9DI/Holy-Of-Holies/blob/backup-snapshot-2026-10-10/backups/AUDIT-2026-10-10.md)
- **Holy of Holies preservation index:** [Audit index](https://github.com/LU9DI/Holy-Of-Holies/blob/backup-snapshot-2026-10-10/backups/AUDIT-AND-BACKUP-INDEX-2026-10-10.md)
- **Provider idempotency and recovery PR:** [PR #1 — merged](https://github.com/LU9DI/Holy-Of-Holies/pull/1)
- **Validation:** [PR CI result](https://github.com/LU9DI/Holy-Of-Holies/actions/runs/38014713909); check [Actions](https://github.com/LU9DI/Holy-Of-Holies/actions) for the latest `main` run.

The GitHub ZIP archives contain versioned files from the selected branch. They do not include uncommitted local files or recover content that was never saved to the repository. Provider idempotency is not an exactly-once guarantee; provider adapters must honor the key and reconcile uncertain outcomes using authoritative evidence.


## Complete preservation snapshot

A newer preservation branch was created directly from `main` to keep the same Git ancestry and include the latest source tree plus audit records:

- **Complete snapshot:** [backup-complete-2026-10-10](https://github.com/LU9DI/Holy-Of-Holies/tree/backup-complete-2026-10-10)
- **Snapshot ZIP:** [Download complete snapshot](https://github.com/LU9DI/Holy-Of-Holies/archive/refs/heads/backup-complete-2026-10-10.zip)
- **Full preservation audit:** [AUDIT-COMPLETE-2026-10-10.md](https://github.com/LU9DI/Holy-Of-Holies/blob/backup-complete-2026-10-10/backups/AUDIT-COMPLETE-2026-10-10.md)
- **Preservation index:** [PRESERVATION-INDEX-2026-10-10.md](https://github.com/LU9DI/Holy-Of-Holies/blob/backup-complete-2026-10-10/backups/PRESERVATION-INDEX-2026-10-10.md)

The snapshot is based on the main branch commit history and contains the same source files as `main`, plus two audit documents. It cannot recover uncommitted local files or content that existed only in deleted conversations.
