# ADR 0001: Keep Codex and Feishu CLIs outside the product core

Status: accepted

## Decision

i豆 launches Codex through the versioned `app-server` JSON-RPC boundary and accesses Feishu through a provider contract implemented first by SaaS `lark-cli`.

The repository does not vendor or modify either upstream source tree. Product-specific modes, policy, persistence, knowledge indexing, and UI live outside both runtimes.

## Why

- Codex releases can be adopted by regenerating/validating the app-server contract instead of rebasing a long-lived fork.
- SaaS and future private-cloud Feishu CLIs can coexist behind the same provider contract.
- Authentication state remains owned by each upstream runtime.
- Upstream process isolation gives enterprise deployments a clear place to add resource limits, auditing, and kill/restart behavior.

## Consequences

- App-server is an experimental upstream interface, so each version bump requires contract tests.
- The product must translate upstream events into its own stable event model before persisting or exposing them to clients.
- A small process supervisor is required in production.

