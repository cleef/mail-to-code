# Operation and recovery

Changes to the adapter are reviewed and upgraded manually. This PR/build does not
upgrade any service. Follow [native switching steps](native-passthrough.md) before
using this architecture. Preserve private guides, native histories, worktrees and
mail/operation records. Never restore an old DB over newer acknowledged effects.

Read-only status: `node dist/src/cli.js async-status` includes historical operation
records. `async-mail-errors <mail-id>` exposes private send diagnostics locally.
Mail and input reconciliation commands remain; inspect CLI usage before acting.
Operation execution, confirmation, reconciliation and reset commands are retired.
`async-reconcile` / `async-resolve-failed` fail with OPERATION_GATEWAY_RETIRED.
The agent inspects external state with native commands and reports uncertain outcomes.

An interruption reconnects history and recovers completed mail only. Unfinished
execution waits for the next user email. Ambiguous input is never replayed until an
operator reconciles it; uncertain sends are never automatically retried. Explicit
manual mail reset is a transport decision, not business authorization.

`doctor` checks Node, project root, pinned executor versions, guide, Git, gh login
and Gmail plugin identity/protocol. It does not execute configured scripts, project
checks or deployments. Delivery failures and held replies are reported separately.
Backups retain old operation records as history; they do not restore live grants.
