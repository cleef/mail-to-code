# Manual switch to native passthrough

This change removes controller operation dispatch, scope grants, authorization
requests/evidence, target fingerprints, operation receipts, PR checks credentials
and automatic deployment prerequisites. The agent owns native development and
external effects. The hard boundaries are authenticated mail identity and OS sandbox;
mail integrity/reliability is retained. Explicit authorization for each merge and
deployment is an agent instruction; both may be authorized in one new email.
Merge-only approval does not authorize deployment, including deployment triggered
automatically by a merge. Material changes to scope or deployment conditions
require renewed confirmation. No program prevents a model from misunderstanding a target
or a stale confirmation; the old TOCTOU guarantee is deliberately removed.

## Operator procedure after review

1. Review/merge this release manually. Do not change pinned CLI/SDK versions.
2. Stop mailbox services; verify there are no active/dispatching/ambiguous tasks.
   Inspect uncertain sends/effects before switching. Preserve consistent private DB
   backups, native session histories, edited guides, existing worktrees and old records.
3. Install the reviewed ref and dependencies using Node 22.13+ 22.x. Build/run npm test.
   Preserve dataDir, mail scan checkpoints, native session IDs and output mode.
4. Confirm the service user's native Git/gh/SSH login. Remove reliance on
   githubTokenFile (deprecated and unused). Existing repositories/profiles/scripts
   and deployment configuration remain context only. No scripts run automatically.
5. Review private ASYNC_AGENTS.md; installation never overwrites edits. Each input
   appends the current native contract, superseding historical controller instructions.
6. Run doctor and all four synthetic real-runtime acceptance scripts listed in the README on the service
   host with the pinned binaries. Verify the policy protects actual mail/state/install
   paths and opens intended project/auth paths. A failed sandbox is a stop condition;
   never fall back to unsandboxed Claude. Check service PATH and auth independently.
   With the pinned Linux user namespace, root-owned SSH configuration includes can
   fail SSH ownership checks. Select an operator-owned SSH config explicitly with
   `ssh -F /path/to/user-config` (or `GIT_SSH_COMMAND`); do not relax host permissions.
7. Start one mailbox consumer manually. Verify a synthetic email round trip and an
   existing session reply. Historical inputs/approvals are not replayed or restored.
   No unfinished execution starts until the next new user email.

Old Codex dynamic operation schemas may persist inside native history; their handlers
only return TOOL_RETIRED_USE_NATIVE. New final sessions advertise no adapter tools;
new queue sessions advertise only queue_mail. Old records remain in async-status;
operation execution/confirmation/reset entry points cannot run. Manual input and
mail reconciliation remain available and retain immutable snapshots.

This implementation is delivered for PR review only; no runtime switch, service
upgrade, real merge or deployment is performed as part of its tests.

For future adapter development, use a separate clone and isolated worktree. A
worktree sharing Git metadata with the protected live installation cannot assume
that its Git metadata is writable.

New Claude sessions start in a task-specific cwd so their native project directory
can be mounted without pre-creating a transcript. Project discovery still uses the
configured project locations supplied in the prompt. Existing native transcripts
retain their original cwd, session ID and exact file grants; initialization does
not move, truncate or replace history. See [startup fix acceptance](validation-claude-startup.md).
