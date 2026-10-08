# Operations and migration

Use `scripts/service.sh` for user-service status and logs. `doctor [project]` verifies configuration, runtimes, GitHub access, Gmail and optional screenshot dependencies. It synchronizes project metadata and is not a read-only status command. `status` and `mail-links check` inspect task and delivery state.

## Existing installation

1. Prepare and test the reviewed MailToCode revision without starting it.
2. Copy private configuration and editable guides into the new config directory. Keep the same mailbox, service user, Codex home, projects and existing explicit dataDir.
3. Express project-specific behavior as explicit profiles. Convert deployment to the generic script adapter; supply its arguments and health checks explicitly.
4. Stop the old controller. Check for active jobs and unresolved sends/effects. Make a WAL-consistent SQLite backup plus private config/unit backups and snapshots of referenced worktrees, Git metadata, artifacts and Codex session files.
5. Run `node dist/src/cli.js migrate`. Run `adopt-config --dry-run`, inspect its affected tasks, then run `adopt-config`. Every active target and reference requires an explicit private profile. Partially merged or uncertain tasks must be reconciled first.
6. Adoption retains inbox, historical outbox, cursor, stage history, PRs, commits and development contexts. It invalidates current approval bindings and queues read-only planning only. Each task requires a fresh START and Review; historical replies and failed jobs are not replayed.
7. Validate the stopped installation, disable the old service, install the new service and start one controller only. Shared dataDir keeps the same daemon lock across names.

Preserve the old deployment and cutover backup for 30 days. Do not delete a still-used data directory or Git repository referenced by a worktree. The old service stays disabled during retention.

## Gmail transport migration

Both engines use the official Codex Gmail plugin. Mail transport migration does
not change the business engine or output mode. Follow the [mailbox cutover
procedure](gmail-plugin-readiness.md#existing-installations): prepare a reviewed
build, validate the dedicated server login, reach an idle stopping point, stop
both services, back up both SQLite databases without old OAuth credentials, run
`migrate-mail --dry-run` and `migrate-mail`, verify with `doctor`, update the service
definition, and perform real owner-mail acceptance before cleaning credentials.

## Recovery

For the reviewed inline-image/automatic-reply upgrade, follow the
[image rollout checklist](final-replies.md#reviewed-rollout). Back up and stop at
an idle point, keep the existing runtime directories, explicitly select
`assistant-final` and restart one service. Historical final messages are not
backfilled. Image preparation errors appear in `async-status` and `doctor`;
request a corrected new final reply instead of replaying its original turn.
Do not finish old OAuth cleanup until real image-mail and thread-continuation
acceptance passes. The mail output change grants no merge/deployment permission.

After plugin cutover, recovery uses the current database and a reviewed compatible
plugin-only build. Inspect processed mail, outbox and external operations before
repairing a connection or changing builds. Never restore an older SQLite snapshot,
replay historical approvals or run the retired transport against live state.

`reconcile-send`, `reconcile-merge` and `reconcile-deploy` resolve uncertain outcomes. Read their CLI output before retrying. `upgrade.sh` backs up and checks a reviewed revision; `rollback.sh` rejects retired OAuth builds and never restores a database. Format-specific compatibility still requires testing on a private database copy.

## Internal progress records

Intermediate notifications are stored as `notification_internal` events in the
private SQLite `events` table, with their kind, text, stage and summary snapshot.
They are not outbox entries, cannot be sent by `flush`, and do not replace an
approval notice. Reply item status and dependencies remain in each task's
conversation ledger. Historical mail snapshots and delivery identities remain unchanged. The v7
semantic protocol requires a stopped migration and rejects older controllers;
this prevents a rollback from restoring command shortcuts for new queued work.

Codex receives known stage-merge facts and chooses whether to plan another step; its next proposal,
question or completion is the next email. Code merge notices that authorize a
separate deployment, cancellation results, failures and requested status replies
remain visible to the owner. Automatic reanalysis invalidates old approval
bindings immediately, even though the intermediate status is internal.

## Semantic protocol upgrade

V7 adds structured `nextStep`, `revisionPhase` and `communication` decisions to
read-only interpretation jobs. All intake and commands use that path. Outcome
jobs receive typed execution facts and can request read-only planning, but cannot
authorize development, merge or deployment. The controller checks evidence,
references, stage, current version, scope, uncertainty and idempotency. It does
not rewrite intent or invent questions from a refusal.

Migration preserves historical sessions, jobs, outbox, inbox and cursor. Pending
old command/result envelopes are reinterpreted by Codex when processed. Done jobs
and known effects are not replayed. Old pending feedback without a phase decision
is guarded and returned to Codex rather than executed with an inferred phase.
Rehearse this on a private copy before stopping an idle controller for the normal
backup/migrate/doctor/manual upgrade. Edited private guides are preserved; the
new contract lives in built-in instructions as well as fresh guide templates.

If interpretation is unavailable, no mail-command fallback exists. One factual
failure is stored per failed interpretation job. Check model connectivity before
retrying; cancellation by email also needs Codex. Stop the service administratively
if immediate shutdown is required. Never retry an uncertain external effect.

## Operator decisions

Codex selects technical details and reversible experience defaults. Plan points
are explanatory; only structured human questions require decisions. Choice
questions explain why the operator must decide and provide two or three options,
a recommendation and its tradeoffs. Missing facts do not acquire invented answers.
Execution approvals remain bound to the current version and are shown separately.
Choosing a recommendation does not authorize development, merge or deployment.

Optional question metadata is additive within v7. Historical questions without
it remain readable, and existing sent/pending presentation snapshots are never
regenerated. Privately edited guides are preserved; the shared built-in policy
also reaches analysis, development and reply interpretation.
