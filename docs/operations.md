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

## Recovery

Before the new controller performs any effects, the stopped cutover snapshot can restore the old installation. After startup, inspect processed mail, outbox and external operations first. Prefer a tested build compatible with the current database and profile format, keeping the current database. Never restore an earlier snapshot blindly, replay historical approvals, or run a v5 controller against v6 state.

`reconcile-send`, `reconcile-merge` and `reconcile-deploy` resolve uncertain outcomes. Read their CLI output before retrying. `upgrade.sh` backs up and checks a reviewed revision; `rollback.sh` checks schema compatibility and never restores a database automatically. Format-specific compatibility still requires testing on a private database copy.
