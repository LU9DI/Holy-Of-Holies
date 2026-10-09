# Holy of Holies

Holy of Holies is the sovereign, open-source orchestration core for a free, decentralized and security-first software engineering platform.

This repository is the **Holy of Holies core**, not the Zion implementation. Zion is maintained separately and must be integrated only through versioned external adapters/contracts. REA is an external engineering-analysis capability, not the core itself.

## Architectural boundaries

- **Core:** task lifecycle, policy decisions, project/workspace coordination, evidence and recovery.
- **REA adapter:** optional, capability-declared integration for engineering analysis.
- **Zion adapter:** optional, capability-declared integration for distributed transport/storage; implementation belongs in its own repository.
- **Model providers:** replaceable. Essential workflows must not require a paid API or a proprietary hosted service.
- **Security:** deny by default. A policy decision is not a substitute for operating-system isolation; untrusted code must not run unless an effective sandbox is independently established.

## Initial implementation

The current foundation includes a task state machine, fail-closed policy evaluator, tamper-evident JSONL event ledger, durable task orchestrator, and an explicitly selected provider registry. Automated tests and a GitHub Actions workflow exercise these modules. This is a foundation, not a claim that the full platform, distributed networking, sandboxing, or autonomous engineering workflow is complete.

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

Early core foundation. The task and provider APIs are expected to evolve before a stable release. The repository is public, but a formal open-source release must not be declared until the project license, contribution policy and release verification are finalized.
