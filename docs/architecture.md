# Holy of Holies core architecture

## Scope

This repository owns orchestration and policy contracts. It does not own the Zion network implementation and does not vendor the REA engine. Those systems are external providers connected through versioned adapters.

## Trust boundaries

1. **User / UI → Core API**: treat all task objectives, project paths, model output, tool output and imported artifacts as untrusted input.
2. **Core → Policy Engine**: authorization is deny-by-default and scoped to exact principal, action and resource identifiers.
3. **Core → Tool adapter**: a policy decision must be enforced at the actual operation boundary. The policy evaluator alone does not sandbox or authorize an operating-system process.
4. **Tool adapter → external provider**: capabilities, versions, unavailable reasons, timeouts and cancellation must be explicit. Do not silently fall back to a different provider.
5. **Task state → persistent storage**: state transitions and evidence need durable, crash-consistent persistence before recovery guarantees can be claimed.

## Core modules

- **Task machine**: validates task input and legal lifecycle transitions.
- **Policy engine**: exact-match rules, deny overrides, temporal constraints and fail-closed handling of malformed policy documents.
- **Task orchestrator**: replays durable events, serializes local state changes, uses compare-and-append to detect stale writers, enforces policy checks, and requires resume verification.
- **Event ledger**: append-only JSONL records with sequence numbers, SHA-256 hash chaining, fsync and lock-based writer coordination.
- **Provider registry**: explicit provider selection, declared capabilities, status probing and policy authorization before invocation.
- **Workspace manager**: canonical-root path checks, symlink rejection, bounded reads, atomic writes, file hashes and expected-version checks.
- **Tool registry**: strict JSON contracts, input/output byte limits, cancellation, timeout requests, deny-by-default policy checks, and independently verified short-lived approval for side effects. Timeouts cannot terminate hostile in-process code; production still needs OS isolation.
- **Container verification runner**: digest-pinned OCI image, no network, read-only source mount, dropped capabilities, non-root user, read-only container root and bounded CPU/memory/PIDs/output/time.
- **Provider adapters (next)**: REA, model providers and later Zion integration.

## Lifecycle invariants

- 'completed', 'failed' and 'cancelled' are terminal for a given attempt. A retry should create a new attempt or explicit child record; it must not erase the failed attempt.
- A task requiring approval cannot transition directly from planning to running.
- Approval records must identify the approving principal.
- An interrupted task may be requeued only after a resume check.
- A transition helper is not a trusted persistence layer. The orchestrator must serialize transitions and persist them atomically to prevent concurrent writers from racing.
- Completion requires a structured evidence record and a configured verification callback; without one, the orchestrator refuses completion. The callback must independently validate the referenced result rather than trust model-generated claims.

## Design constraints

- No mandatory paid model API or proprietary hosted service for essential local workflows.
- No central controller required for local task creation, policy evaluation or project inspection.
- External providers are optional and replaceable.
- No implicit network access for tool execution.
- No untrusted code execution without a separately verified operating-system isolation boundary.
- APIs are versioned and strict; unknown permissions, invalid policy documents and missing capabilities fail closed.

## Implementation sequence

1. Task state machine and policy evaluator.
2. Tests for transition invariants, malformed policies and approval requirements.
3. Durable event store and serialized orchestration.
4. Tool registry with schema validation, bounded payloads, cancellation, and trusted approval-verifier hooks.
5. Workspace transactions and safe rollback.
6. Provider gateway with explicit capability negotiation.
7. Integration, fault-injection and security tests.
8. SBOM, license/notice validation and reproducible release process.

## Current limitations

The current modules provide orchestration primitives and local file operations, but they are not a complete autonomous agent, distributed runtime, hardened sandbox, transactional database, cryptographic identity system, built-in independent verifier, or production authorization boundary. Workspace path checks do not eliminate all races against a hostile process running as the same OS user. Those properties must be implemented and independently tested before the platform claims them.


**Signed verification attestations**: `VerificationEngine` checks short-lived HMAC-SHA-256 attestations bound to task ID, project ID, trusted verifier identity, outcome, and result hash. This is a trust hook, not a build/test runner. Its in-memory record store is lost on restart, and its signing capability must be isolated from the agent. Production must split signing and verification into separate principals/services and persist attestations with replay/revocation controls.


## Verification execution boundary

`VerificationRunner` invokes only preconfigured command descriptors using `spawn` with `shell: false`, explicit arguments, policy authorization, bounded runtime and bounded captured output. It records exit status and SHA-256 hashes for captured stdout/stderr and the report. It is not an OS sandbox: descendant processes may survive, and host filesystem/network/resource access is not contained. The container runner is a meaningful defense-in-depth boundary but is not a VM or formal sandbox; runtime/host-kernel vulnerabilities remain in scope. Prefer rootless Podman or a disposable dedicated worker. A trusted attestation service must remain separate from the planner and runner process.


## Verification coordination and audit trail

The coordinator records verification lifecycle events in the event ledger and persists only report metadata and output hashes, not raw captured output. It delegates signing to an injected attestation issuer and rejects attestations whose task, project, verification ID, outcome, or result hash do not match the runner report. This is integration glue, not a trusted signing service: issuer isolation, durable key management, independently selected test plans, and a hardened worker remain deployment responsibilities.


**Restart-safe attestation verification:** a complete signed attestation can be supplied with evidence and verified cryptographically after process restart, provided the verifier retains the correct key and trusted-verifier allowlist. When configured with `RevocationRegistry`, the verifier checks durable revocation state on every verification and fails closed if that store is unavailable. A locally revoked ID cannot be re-attested by the same engine instance. The ledger remains tamper-evident rather than immutable against privileged full-file rewrites.


The coordinator returns a `completionEvidence` envelope that can be supplied to the orchestrator's `verifying → completed` transition. Completion remains guarded by the separately configured `verifyCompletion` callback, which can validate the signed attestation using the verifier's key and trusted-verifier policy.
