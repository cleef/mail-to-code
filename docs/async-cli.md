# Mail as an asynchronous Codex CLI

The opt-in `async-cli` engine runs one persistent Codex conversation per feature,
starting in `~/projects` on the host running the service. Codex discovers relevant projects, reads their rules and
understands authenticated new email bodies directly. Full MIME, quoted history
and attachments are preserved as reference, never new authorization. Verified
mail identities route replies; subject words and Gmail grouping do not.

A fresh message without reply headers creates a new conversation, even with the
same subject/provider thread. A reply resumes its direct parent's conversation;
if the parent is unknown, use the nearest known `References` ancestor. Unknown or
conflicting references are quarantined for inspection, without starting a second
execution. Completed tasks, restarts, repository switches and failed checks retain
the original conversation. Codex may recommend a separate email for a genuinely
independent task; task text is never a routing keyword. No directory links are
required; the runtime discovers Git projects under its configured projects root.

There is no analyzer/executor split, business result schema, document phase gate
or automatic START loop. Codex plans, implements, checks, repairs and continues
across approved repositories. Technical and reversible experience choices are
autonomous. Real questions provide a recommended option, reasons, alternatives
and impact. Missing facts have no invented answer. Progress, issues, decisions,
validation and PR evidence live in each feature's `notes/FEATURE.md`.

## Runtime and permissions

Use Node 22.13+ and **Codex CLI 0.159.2**. The stdio app-server uses `initialize`,
`thread/start`, `thread/resume`, `turn/start` and `turn/steer`. Dynamic tools use
the experimental API capability and persist with the thread; there is no business
`outputSchema`. Revalidate protocol and sandbox before changing the CLI version.

Up to four feature turns run concurrently. Idle processes close; their thread
IDs persist and replies resume the original conversation. Native subagents may
help when available; there is no custom swarm platform. Only the primary queues
mail or calls permission and external-effect adapters.

The projects root is read-only. Source writes are confined to feature worktrees;
Git metadata, conventional secrets, private guides, credentials and other tasks'
runtime state are restricted. Native shell networking is disabled. Package
commands use configured source domains and the sandbox adapter. Account MCP
servers, plugins and hooks are disabled. Credentials remain in the bridge's
Gmail, GitHub and trusted deployment adapters.

Optional [controlled operations](controlled-operations.md) extend the bridge with
administrator-owned scripts. New threads receive `project_operations` and
`project_operation`; existing 0.159.2 threads use the fixed `project_command`
compatibility entry. Production writes require explicit new-body authorization,
and configured deployment prerequisites run before the deployment effect.

An explicit initial implementation request may authorize its stated scope.
Added repositories and reference-to-write changes need a concrete scope request
and its explicit authenticated direct reply. The bridge validates evidence,
mail identity, repository identity, roles and exact targets; **Codex decides
human intent**, without matching approval keywords. Scope persists through docs,
tests, technical changes and repository handoffs. Merge and deploy always need
independent exact-target confirmations. Silence, generic assent, recommendations
and quotations grant nothing.

`project_worktree` can discover unconfigured GitHub projects and derive baseline
checks without changing private configuration or granting deployment access.
Operator profiles take precedence. `project_command` returns failed checks as
ordinary results in the same session. Success receipts bind current source bytes;
`project_pr` requires mandatory checks before publishing. Merge binds PR head/base;
deployment binds merged commit and operator profile. Target changes invalidate
that operation approval rather than the feature's implementation scope.

## Communication and recovery

New installation templates enable `asyncMailOutput: "assistant-final"`: the native
final assistant reply becomes the email, unchanged except for Markdown/MIME
formatting. Commentary remains internal. See [final replies and confirmations](final-replies.md)
for delivery recovery, private-guide migration and older-thread compatibility.
Existing configuration without this field retains `"queue-mail"`.

In queue-mail mode the primary explicitly calls `queue_mail` for a real decision, important blocker,
requested status or final result. Tool failures, internal progress and completed
turns do not create email. Escaped Markdown HTML accompanies the identical text
snapshot. When waiting for a human, preserve the draft and finish the turn.
Unexpected native interactive approvals decline permissions or return a tool
error instead of inventing answers or leaving a terminal prompt open.

```
<dataDir>/async-cli/features/<feature-id>/notes/FEATURE.md
<dataDir>/async-cli.sqlite
```

SQLite stores transport facts, thread identities, grants, check receipts and
immutable outbox snapshots, without a business phase machine. Native Codex
history retains input and tool context. Before sends or privileged effects,
durable intent is recorded. Unknown outcomes are never replayed automatically.
Mail reconciliation uses the existing sent-message/RFC verifier; search absence
is not proof of non-delivery. Lost turn acknowledgements reconcile the exact
input marker in persisted user-message items. Missing evidence stays an internal
inspection issue, without another START. Interrupted accepted turns continue in
the same conversation with preserved grants and operation receipts.

## Opt-in, cutover and rollback

Existing configuration defaults to `engine: "legacy"`. `serve-async` explicitly
starts the new runtime. After independent review and cutover approval, setting
`engine: "async-cli"` directs the existing `serve` service to it. Both engines
share a process lease, preventing two mailbox consumers.

Stop the old service and reconcile pending/uncertain effects before cutover. The
new engine initializes its Gmail cursor at startup; old inbox history is not
ingested as new instructions. History-gap recovery searches only after that
initial cursor timestamp and deduplicates message IDs.

While the service is stopped:

```sh
node dist/src/cli.js async-status
node dist/src/cli.js async-doctor
node dist/src/cli.js async-import
```

Import opens legacy SQLite read-only, stores original session/outbox JSON as
reference snapshots, retains known mail identities for reply routing, creates
paused conversations and restores no grants. It
queues no historical mail or instructions. Legacy state, worktrees, snapshots
and edited private guides are preserved. Import is idempotent; no legacy schema
migration is added.

Before adopting an imported task, inspect actual versions, worktrees, commits and
uncertain operations, then run while stopped:

```sh
node dist/src/cli.js async-adopt <feature-id> --verified-runtime
```

This enables new input to a new thread only. It does not restore old approval,
replay instructions or grant access to old worktrees. Reply to a known imported message with a concrete
new instruction after adoption. A fresh email instead starts an independent task. Rollback stops the new engine and restores legacy
configuration; inspect post-cutover messages before resuming the old consumer.
Never run both engines or blindly replay historical approvals.

Recovery is explicit and performed with the service stopped:

```sh
node dist/src/cli.js async-reconcile <feature-id> <operation-id>
node dist/src/cli.js async-reconcile-send <mail-id>
```

These inspect remote PR/release or sent-message identity without repeating the
operation. Known results become durable receipts. Unknown results remain blocked.
Only after independent operator inspection, `--verified-no-effect` resets an
operation, `--verified-absent` resets an absent send, or
`async-reconcile-input <input-id> --verified-not-accepted` requeues an ambiguous
input. Each reset preserves an audit snapshot and executes nothing by itself.
Search or history absence alone never performs a reset.

## Verification

After adding controlled operations to an installation with existing conversations,
validate model discovery as well as direct adapter execution:

```sh
node scripts/verify-operation-resume.mjs
node scripts/verify-final-mail.mjs
```

This Linux/Codex 0.159.2 check seeds a synthetic thread with old capability notes
and no native operation tools, restarts it with a configured local inspection
script, and requires Codex to discover the compatibility entry in the same thread.
It uses no real mailbox, SSH transport or business deployment.

`npm test` runs offline Node 22 tests for routing, persistent replies, duplicates,
acknowledgement loss, interrupted turns, immutable snapshots, approval bindings,
unknown effects, primary-only tools and read-only import. Real acceptance:

```sh
ASYNC_CODEX_COMMAND=/path/to/codex-0.159.2 node scripts/verify-async-cli.mjs
```

The script uses three disposable example worktrees, observes and repairs real
TypeScript TS2339, completes approved cross-repository work, verifies one final
queued email with no repeated confirmation, resumes a follow-up in the same
thread and compares direct CLI under the same model defaults, source and policy.
It creates no Gmail/GitHub clients, sends no real mail, creates no real PR and
performs no merge or deployment. Reports remain private temporary artifacts.

`scripts/verify-async-sandbox.mjs` separately probes the real CLI sandbox without
calling a model: runtime database, token, secret file, foreign feature and Git
metadata access must fail; original-checkout writes must fail; task-note writes
must succeed. A synthetic run on Codex 0.159.2 completed the three-repository
repair with one task prompt, zero scope reconfirmations and one final queued
mail, then accepted one follow-up in the same thread. In a Linux run, the bridge took
about 193 seconds and direct CLI about 146 seconds; both used one initial human
prompt. Earlier macOS runs were about two minutes each. Timing is sample evidence,
not a guarantee of equal latency or general performance.
