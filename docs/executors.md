# Email tasks with Codex or Claude Code

The async engine binds one executor to each task. This does not change the legacy
engine or introduce a business-stage machine.

## Email workflow

Start a **fresh email** titled `[claude] Add CSV export to the sample project` or
`[codex] Add CSV export to the sample project`. Tags are case-insensitive and
must lead the subject (optional leading whitespace). An untagged email uses
Codex. A new email without reply references starts a separate task even when its
subject or Gmail grouping matches another task.

Reply normally to continue. Verified RFC reply references select the task;
changing a reply's subject or mentioning another executor in its body does not
switch executors. Existing tasks without executor metadata remain Codex tasks,
including historical subjects containing `[claude]`. In-task switching and
two-executor collaboration are not supported in this version.

Both executors discuss unclear requirements, implement explicit authorized
requests in approved worktrees, run checks and prepare a PR. A discussion-only
request does not authorize edits. No extra START round is required. New write
targets require scope confirmation; merge and deployment each need a separate,
delivered, exact-target request and an explicit direct reply. Changed PR heads
invalidate the old merge approval.

New tasks' email MIME snapshots include `Executor: Codex` or
`Executor: Claude Code` above the answer. The native final text remains unchanged
in the audit record, and subjects stay unchanged. Queued historical replies are
not relabeled or regenerated. Intermediate native messages stay internal.

Claude follow-ups arriving during a turn remain queued until that turn finishes;
Codex retains its existing steering behavior. A stop request sent by email is
interpreted when its turn runs, not an immediate process kill. An operator can
stop the service for an immediate runtime stop.

## Runtime and permissions

Use Node 22.13+ (22.x), Codex CLI 0.159.2 and Claude Code **2.1.296**, with the
pinned Claude Agent SDK **0.3.296**. `claudeCommand` defaults to `claude`; set an
absolute path in private configuration when needed. The adapter uses that
installed executable, not the SDK's bundled binary. Authenticate the service
user with Claude Code before use. This adapter uses the CLI's saved login and
allowlisted authentication/model environment values from the service environment
or the regular private (600) `~/.claude/settings.json` file (service environment wins). The
allowlist is `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and the
`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
`ANTHROPIC_DEFAULT_HAIKU_MODEL` aliases. These values go only to Claude's model
process, never workspace commands. Account settings are otherwise disabled;
authentication helper scripts are not executed.
Private configuration and native history stay outside the checkout.

Gmail still uses the existing Codex official plugin. Codex's OS sandbox also
executes Claude's workspace/check commands, so **Codex remains required** for
Claude tasks. The optional Claude version check in `async-doctor` reports
availability without preventing Codex-only installations from passing readiness.
Version readiness is not proof of authentication or successful model execution.

Claude receives no native shell, file-editing, web, subagent or skill tools.
Account/project settings, plugins, hooks and external MCP servers are disabled;
the adapter checks the actual tool inventory and fails closed on unexpected
capabilities. Only the controller's in-process MCP tools are exposed. The new
`workspace_command` uses the existing OS sandbox for discovery, source edits
and task notes. It returns no check receipt: PR validation still requires
`project_command` receipts for the current source. Credentials, Git metadata,
other tasks, runtime databases and native networking remain inaccessible to
these commands. `project_*` tools retain all existing authorization checks.

The SDK requires Zod 4. Existing controller validators explicitly use its `zod/v3`
compatibility entry point; their validation semantics are unchanged.

## Persistence and failures

SQLite stores `executor` and `executorSession` on the conversation; historical
`codexThread` remains supported. These bindings cannot change after creation.
Claude's native history retains its context. A controller journal binds each
prompt UUID, exact input, turn and final result before the bridge sends mail.
Native user acknowledgements or matching native transcript evidence establish
acceptance; a local dispatch intent alone does not.

On restart, completed journaled replies are recovered once. An unacknowledged
input is checked against native history by UUID and exact text. Missing evidence
requires operator inspection; it is never submitted again automatically.
Interrupted accepted work resumes with instructions to inspect worktrees and
operation receipts. Unknown external effects keep the existing reconciliation
requirements. No fallback to Codex or session fork occurs on Claude failure.

An unavailable executor leaves queued inputs intact and sends one fixed blocker
per latest input, without copying raw diagnostics or credentials into email.
Use `async-status` and private runtime diagnostics to inspect the task. Fix the
runtime/login to resume queued work. Ambiguous inputs still require the existing
operator reconciliation command with independently verified non-acceptance.

## Reviewed rollout and validation

Review and merge the controller PR manually, stop at an idle point, back up its
private SQLite state/configuration and install the reviewed build. Preserve
native Codex/Claude histories, approved worktrees and edited `ASYNC_AGENTS.md`.
Restart the single mailbox consumer. Do not run an old controller against new
Claude tasks: it cannot understand their executor bindings. Rollback requires
stopping the service and inspecting those tasks first; do not replay approvals.

Run `npm test` and the synthetic real-runtime checks on Linux:

```sh
node scripts/verify-claude-cli.mjs
node scripts/verify-async-sandbox.mjs
```

The Claude check uses the service user's model account and may incur usage. It
creates synthetic temporary projects, task notes and private native history,
checks a sandboxed file write, changes a reply subject, resumes the same native
session after restart, and verifies final-mail deduplication. Neither script
accesses a mailbox, creates a GitHub PR, merges or deploys. Actual mailbox
delivery and client rendering still need separate acceptance after the reviewed
upgrade.
