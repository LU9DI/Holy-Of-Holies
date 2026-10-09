# Security model and non-claims

## Assets to protect

- Project source, user data and task history.
- Credentials, encryption keys and provider tokens.
- Integrity of task state, policy decisions and verification evidence.
- Local machine availability and resource budgets.
- Provenance of tools, adapters, model output and generated changes.

## Adversaries and untrusted inputs

Assume model output, imported repositories, binaries, tool output, provider responses, network data and task descriptions can be malicious or malformed. No external system—including Zion or REA—is required or inherently trusted. A connected peer or installed tool is not trusted merely because it is reachable or because the user enabled an adapter. Treat path names, archive contents, symbolic links, environment variables and serialized state as attack surfaces. Every integration is user-opt-in, least-privilege, and revocable.

## Authorization principles

- Deny by default.
- Match the principal, action and resource explicitly.
- Explicit deny overrides allow.
- Expired, not-yet-active, malformed or absent policy fails closed.
- No implicit wildcard, role inheritance or network permission.
- Policy evaluation and permission declarations do not themselves enforce operating-system restrictions.

## Execution principles

- Do not execute untrusted code until an effective OS-level isolation boundary is verified.
- Bound execution time, output, memory, process count and concurrency at enforcement points.
- Keep credentials out of untrusted processes and model context unless explicitly required and scoped.
- Network egress is denied by default for untrusted tool execution.
- Cancellation must terminate owned child processes and confirm cleanup before reporting completion.
- Record provenance and sanitized results; never store secrets in the event ledger.

## Event ledger limitations

The JSONL ledger uses sequence numbers and a SHA-256 hash chain to detect corruption or edits that do not recompute the chain. It is not a signature, trusted timestamp, WORM store or remote transparency log. A privileged attacker can rewrite the whole file and recompute hashes. Access control, secure backups, key-backed signatures and external anchoring are future work.

A lock file prevents concurrent writers from silently racing. If a process crashes and leaves a lock behind, the ledger fails closed; operators must inspect the lock and data before removing it. Do not automatically steal stale locks without a proven ownership and recovery protocol.

## Availability and recovery

Resource exhaustion is a security concern. Every future scheduler and adapter must enforce deadlines and output budgets. Recovery must preserve failed attempts and avoid repeating non-idempotent actions unless the previous outcome has been resolved.

## Reporting

Report suspected vulnerabilities privately through GitHub's repository security reporting mechanism when it is enabled. Until a private reporting channel is verified, do not include exploit details, credentials or personal data in public issues.

## Explicitly not yet implemented

The current core does not yet provide cryptographic user identity, signed policy bundles, a hardened sandbox, encrypted storage, a production secrets vault, a durable transactional database, remote audit anchoring, a complete tool registry, or an autonomous end-to-end engineering runtime. No production security certification is implied.


## Independent verification boundary

`VerificationAttestor` issues short-lived Ed25519-signed attestations; `VerificationEngine` accepts only the corresponding public key and cannot sign. Attestations bind trusted verifier ID, task, project, outcome, result hash and validity window. Neither class executes tests or build artifacts. The signing service and private key must remain in a separate trusted process/service and must never be exposed to the planner, tool handlers, or model.


## Verification runner

The runner allowlists command IDs and fixes each executable, argument vector, exit-code policy, timeout and output budget in trusted configuration. It uses no shell and fails closed on missing authorization. These controls reduce accidental command injection but do not make arbitrary repository code safe: a child process can access the host's OS permissions and may spawn descendants. `ContainerVerificationRunner` provides a reference OCI path with digest-pinned images, network disabled, read-only project mount and root filesystem, dropped capabilities, non-root UID, bounded CPU/memory/PIDs/output/time, and forced cleanup on timeout/cancellation/output overflow, and a bounded canonical workspace manifest hashed before and after execution. The digest is included in the Ed25519-signed attestation and completion evidence. `VerificationEngine` recomputes the live workspace digest through the configured `getWorkspaceDigest` callback at completion and fails closed if the callback is missing, errors, or returns a different digest. A mismatch or unsupported workspace entry fails closed. This pre/post check is not an immutable snapshot against a hostile host process that changes and restores files between checks. Prefer a rootless runtime on a dedicated disposable worker. This is defense in depth, not a formal sandbox or VM: host-kernel/runtime vulnerabilities remain possible. Hashes prove report integrity relative to the report, not that a trusted test suite was correctly chosen or that the code is secure.


## Durable verification evidence

Verification lifecycle events are recorded in the local hash-chained ledger. The coordinator intentionally omits raw process output from durable records and stores SHA-256 hashes and bounded metadata instead. An external issuer must return an attestation bound to the exact task, project, verification ID and result hash. The coordinator cannot prove the issuer is isolated, that a command was a sufficient test plan, or that the ledger cannot be rewritten by a privileged attacker. Multi-process uniqueness and crash-recovery semantics still require a transactional persistent store or an external coordination mechanism.


Signed attestation persistence stores the complete signed record, not the signing key. The verifier can validate the signature without an in-memory issuance cache, allowing restart-safe verification. The optional `RevocationRegistry` persists revocations as `verification.revoked` events in the hash-chained ledger and checks the ledger on each completion verification. When the registry cannot be read, verification fails closed. This is durable across process restarts when the same intact ledger is reused, but a privileged attacker who can rewrite the complete ledger can also remove revocation events. Compare-and-append protects verification-ID claims within a shared ledger, but does not coordinate independent ledger copies or provide general transactional crash recovery. Stale locks remain fail-closed.


## Standalone operation and optional integrations

Holy of Holies must not require Zion, REA, a hosted model, or another external service for core local workflows. Integration must never be silently activated. The user controls whether to connect a system, which capabilities to expose, what data may cross the boundary, and when to disconnect it. Adapters must fail closed when authorization or capability declarations are missing, and disabling an adapter must not erase core records. The core's security and correctness must not depend on the availability or trustworthiness of any optional integration.


## Single-use approvals for side effects

The `ToolRegistry` requires an injected `consumeApproval` callback before dispatching any side-effecting tool. The callback must atomically validate the trusted approval record and claim its ID as single-use in durable storage shared by all competing workers. A read-only verification callback is insufficient: two concurrent invocations could otherwise both pass verification and execute. Policy and input validation run before consumption to avoid burning approvals for requests already denied locally; consumption occurs immediately before dispatch. Missing, failed, expired, revoked, or already-consumed approvals fail closed. If cancellation arrives after the atomic claim but before dispatch, the approval is burned rather than made reusable. The registry cannot enforce atomicity inside an external callback or make the claim and an arbitrary external side effect one transaction; implementations must use a transactional compare-and-set/unique constraint and reconcile ambiguous outcomes rather than blindly retrying.
