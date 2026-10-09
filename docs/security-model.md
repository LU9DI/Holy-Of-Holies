# Security model and non-claims

## Assets to protect

- Project source, user data and task history.
- Credentials, encryption keys and provider tokens.
- Integrity of task state, policy decisions and verification evidence.
- Local machine availability and resource budgets.
- Provenance of tools, adapters, model output and generated changes.

## Adversaries and untrusted inputs

Assume model output, imported repositories, binaries, tool output, provider responses, network data and task descriptions can be malicious or malformed. A connected peer or installed tool is not trusted merely because it is reachable. Treat path names, archive contents, symbolic links, environment variables and serialized state as attack surfaces.

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

The verification engine accepts only short-lived signed attestations from configured trusted verifier IDs, bound to a task, project, outcome, and result hash. It does not execute tests or build artifacts itself. The attestation signing capability and key must remain in a separate trusted runner/service and must never be exposed to the planner, tool handlers, or model. The current reference implementation stores attestations in memory; restart-safe persistence and separate signing/verifying principals are production prerequisites.
