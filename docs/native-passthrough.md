# Manual switch to native passthrough

This change removes controller operation dispatch, scope grants, authorization
requests/evidence, target fingerprints, operation receipts, PR checks credentials
and automatic deployment prerequisites. The agent owns native development and
external effects. The hard boundaries are authenticated mail identity and OS sandbox;
mail integrity/reliability is retained. Separate merge/deployment confirmation is
an agent instruction. No program prevents a model from misunderstanding a target
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
6. Run doctor and all three synthetic real-runtime acceptance scripts on the service
   host with the pinned binaries. Verify the policy protects actual mail/state/install
   paths and opens intended project/auth paths. A failed sandbox is a stop condition;
   never fall back to unsandboxed Claude. Check service PATH and auth independently.
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
