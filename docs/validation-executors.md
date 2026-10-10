# Dual executor validation

The approved design is implemented as a fixed per-task executor selection in the
async engine. See [workflow, configuration and recovery](executors.md).

## Automated checks

`npm test` passed all **281 tests** using Node **22.23.2**. The added tests cover:

- Fresh subject selection, default Codex, historical Codex records, changed reply
  subjects, duplicate messages, unknown references and immutable session bindings.
- Shared primary-session guards, delivered exact-target confirmation bindings and
  uncertain-effect deduplication for both executors.
- Claude tool/settings restrictions and authentication-only environment loading.
- Persistent native-session continuation, immutable final replies with executor
  labels, queued follow-ups and restart deduplication.
- Lost acknowledgements with and without native evidence, interrupted accepted
  work with preserved scope/receipts, unexpected tool inventories and unavailable
  executors without fallback.

## Real runtime checks

Synthetic Linux acceptance used Claude Code **2.1.296**, Claude Agent SDK
**0.3.296** and Codex **0.159.2**. `verify-claude-cli.mjs` passed:

- A real in-process MCP tool call wrote and read a task-note fixture through the
  OS sandbox.
- A second email after bridge restart resumed the same native session and
  recalled context from the first email.
- A changed `[codex]` reply subject retained Claude as the executor.
- Exactly two native final replies were queued; another restart queued no copy.
- No real mail was sent, and no PR, merge or deployment operation occurred.

The existing `verify-async-sandbox.mjs` also passed its real Linux checks for
read-only original/linked checkouts, writable task notes/worktrees, denied runtime
databases, secrets, Git metadata, private operation scripts/logs, foreign tasks,
frozen image artifacts and native networking. The check adapter and native
Codex thread startup passed under that same policy.

All fixtures and descriptions are synthetic. Runtime paths, account settings,
credentials and native transcripts are excluded from this repository.

## Remaining release acceptance

This evidence validates the implementation, not a live controller upgrade.
Manual PR review, merge and installation remain required. After the reviewed
upgrade, accept actual `[claude]`/`[codex]` mailbox replies, executor labels and
client threading. Production merge/deployment permissions remain separate.
