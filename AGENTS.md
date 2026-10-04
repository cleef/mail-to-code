# MailToCode

Use Node 22.13+ (22.x), npm, TypeScript and native SQLite. Run npm test before handoff.
Keep all tests and documentation synthetic: never include operator projects,
private email, credentials, deployment addresses or runtime state in this repo.

The bridge owns Gmail, privileged Git, PRs, merge and deployment. Async email goes
directly to a persistent Codex session; the bridge does not advance business stages.
Source edits stay in approved worktrees. Preserve immutable mail and exact operation
bindings. Never retry uncertain effects. Stage rules remain in the legacy engine.

Configuration and runtime memory belong outside the checkout. Preserve edited
private guides across installs and upgrades. Async scope persists through technical
changes and repository handoffs; merge and deployment need separate confirmation.
Changes to this controller must be reviewed and upgraded manually.

<!-- project-workflow:repo:v1:begin -->
## Shared development and branch lifecycle

- Before implementation, read this repository's instructions and relevant product records. Confirm the design for product changes; ordinary maintenance need not create a product ID.
- Use a feature branch and a reviewed PR. Include the existing product ID in the branch, commit and PR when applicable; keep verification and preview evidence linked to the product record. Documentation-only work has no UI preview.
- Use one branch per PR by default. Review changes stay on that branch; after merging, start follow-up work from the latest default branch on a new branch, retaining the same product ID. Cross-repository PRs have separate branches.
- A newly created or cloned repository must complete workflow onboarding before development: install the shared repository rules on a clean feature branch, review/merge them, and enable GitHub's delete_branch_on_merge setting. Missing origin, permissions or configuration means onboarding is pending.
- Merge and deployment require the user's review and confirmation. Branch cleanup and release acceptance are separate: a merged PR can be closed out while the product remains awaiting release or validation.
- Before removing a temporary worktree or local branch, verify the PR is merged and its recorded head SHA equals the local branch/worktree HEAD; preserve any post-merge commits. Check tracked/untracked changes, ignored files, active sessions, locks, branch dependencies, protection and files required for release. Keep the primary checkout, protected/default branches and anything still needed; report the reason.
- For squash/rebase merges use the PR record and head SHA, not only git branch --merged. git fetch --prune removes stale remote-tracking refs; git worktree prune removes stale registrations, not existing worktree directories. Use git worktree remove only after the checks above. Never blanket-delete or force-remove worktrees.
- Cleanup is performed by the responsible operator after verification; no automatic cleanup is introduced. In email-controlled work, the controller/operator owns Git, PRs and external effects; the model reports pending cleanup and edits only its confirmed worktree. START/Review/deployment boundaries remain in force.
- Preserve PR, commit and verification links after branch deletion. Mark a product Done only after actual release and acceptance, never because its branch was removed.
<!-- project-workflow:repo:v1:end -->
