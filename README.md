# Holy of Holies

Holy of Holies is the sovereign, open-source orchestration core for a free, decentralized and security-first software engineering platform. The core is licensed under **GNU AGPL-3.0-or-later**, chosen as an initial copyleft default so modified network-served versions remain available to their users. This is a project licensing decision, not legal advice.

This repository is the **Holy of Holies core**, not the Zion implementation. Zion is maintained separately and must be integrated only through versioned external adapters/contracts. REA is an external engineering-analysis capability, not the core itself.

## Architectural boundaries

- **Core:** task lifecycle, policy decisions, project/workspace coordination, evidence and recovery.
- **REA adapter:** optional, capability-declared integration for engineering analysis.
- **Zion adapter:** optional, capability-declared integration for distributed transport/storage; implementation belongs in its own repository.
- **Model providers:** replaceable. Essential workflows must not require a paid API or a proprietary hosted service.
- **Security:** deny by default. A policy decision is not a substitute for operating-system isolation; untrusted code must not run unless an effective sandbox is independently established.

## Initial implementation

The current foundation includes a task state machine, fail-closed policy evaluator, tamper-evident JSONL event ledger, durable task orchestrator, explicitly selected provider registry with input/output validators, scoped workspace reads/atomic writes, Ed25519 attestation signing and public-key verification, durable revocation, and an OCI container verification runner with bounded resources, no network, and a SHA-256 workspace manifest checked before and after execution. Successful workspace digests are included in the signed completion evidence. Task completion still depends on a separately operated trusted issuer and configured verifier. The container runner is defense in depth, not a VM or a formal sandbox. Automated tests and GitHub Actions exercise the modules; the full autonomous engineering workflow and production trust deployment remain incomplete.

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

The core now exposes `ToolRegistry` for explicit tool allowlisting. Each registered tool declares strict JSON input/output contracts, whether it is read-only, and bounded input/output sizes and execution time. Every invocation is checked against the configured policy evaluator. Side-effecting tools require an independently verified, short-lived approval record through an injected `verifyApproval` function; caller-supplied approval metadata alone is not trusted.

Cancellation and timeout signals are cooperative. They do **not** terminate hostile code running inside the same process. Do not register untrusted handlers in-process; production execution requires a separately hardened OS/container boundary, credential scoping, and resource enforcement.

## Verification Runner

`VerificationRunner` executes only explicitly configured commands, with a fixed executable and argument list, no shell, policy authorization, timeouts, output limits, and hashed reports. A passing exit code is necessary but not sufficient: a trusted verification service must independently issue an Ed25519-signed attestation through `VerificationAttestor`. `VerificationEngine` holds only the public key and cannot sign.

This runner is a constrained process launcher, **not a security sandbox**. It does not provide CPU/memory quotas, network isolation, filesystem isolation, syscall filtering, or a reliable way to kill descendants. Do not run untrusted project code directly on the host. Use `ContainerVerificationRunner` for a digest-pinned OCI container with no network, read-only source mount and explicit CPU, memory and process limits; prefer rootless Podman or an equivalent dedicated worker, and persist signed evidence outside the worker. Container isolation still depends on the host kernel and runtime and is not a VM or a formal sandbox. The pre/post workspace digest detects persistent changes during a run but is not an immutable snapshot against a hostile host process that changes and restores files between checks.

## Verification Coordination and Durable Evidence

`VerificationCoordinator` links the allowlisted runner to an injected external attestation issuer and the hash-chained `EventLedger`. It records start, completion, runner failure, and attestation rejection events. The ledger stores command metadata and hashes, not raw stdout/stderr, reducing accidental persistence of secrets. A passing run is not treated as complete unless the external attestation issuer returns an Ed25519-signed attestation bound to the same task, project, and result hash. The verifier holds only the public key; the issuer alone holds the private signing key.

The issuer is an interface, not a built-in isolated service. The deployment must implement it as a separate trusted principal and configure it to sign only after independent verification. The local hash chain is tamper-evident, not immutable against a privileged attacker who can rewrite the entire ledger. The coordinator claims verification IDs with compare-and-append against the shared ledger head, preventing two successful starts for the same ID in one shared ledger. This is not a general transactional database and cannot coordinate independent ledger copies; stale locks and crash recovery remain operator-visible failure cases.


For successful runs, `completionEvidence` is returned in the exact envelope expected by the completion verifier: verification ID, trusted verifier ID, outcome, result hash, and the complete signed attestation. Pass this evidence to the task transition that requests `verifying → completed`; the orchestrator still invokes its independently configured verifier and fails closed if verification is unavailable or returns false.
