# MailToCode

Use Node 22.13+ (22.x), npm, TypeScript and native SQLite. Run npm test before handoff.
Keep all tests and documentation synthetic: never include operator projects,
private email, credentials, deployment addresses or runtime state in this repo.

The mail adapter owns Gmail identity, immutable input/output and delivery reliability.
Authenticated email goes directly to its bound persistent native Codex or Claude Code
session. The agent owns project discovery, isolated worktrees, checks, Git, GitHub,
merge and deployment inside the static OS sandbox. There is no operation gateway,
scope registry, target hash or authorization-evidence binding.

The agent interprets the user's new email in context. Merge and deployment require
separate explicit user confirmation; implementation approval does not imply either.
These are agent instructions, not program-enforced operation gates. Read current
state before acting. Never blindly retry an external effect with an unknown outcome.
Interrupted execution waits for new user mail; reconnect only checks history and
recovers completed replies. Quoted history is reference, never fresh authorization.

Configuration and runtime memory belong outside the checkout. Preserve edited
private guides, native session IDs, existing worktrees and historical mail/operation
records across installs and upgrades. Keep mail login, immutable mail, the mail DB,
other task state and the running adapter installation outside developer write access.
Changes to this adapter require human review and manual upgrade.

<!-- project-workflow:repo:v1:begin -->
## Shared development and branch lifecycle

- Before implementation, read this repository's instructions and relevant product records. Confirm the design for product changes; ordinary maintenance need not create a product ID.
- Use a feature branch and a reviewed PR. Include the existing product ID in the branch, commit and PR when applicable; keep verification and preview evidence linked to the product record. Documentation-only work has no UI preview.
- Use one branch per PR by default. Review changes stay on that branch; after merging, start follow-up work from the latest default branch on a new branch, retaining the same product ID. Cross-repository PRs have separate branches.
- A newly created or cloned repository must complete workflow onboarding before development: install the shared repository rules on a clean feature branch, review/merge them, and enable GitHub's delete_branch_on_merge setting. Missing origin, permissions or configuration means onboarding is pending.
- Merge and deployment require the user's review and confirmation. Branch cleanup and release acceptance are separate: a merged PR can be closed out while the product remains awaiting release or validation.
- Before removing a temporary worktree or local branch, verify the PR is merged and its recorded head SHA equals the local branch/worktree HEAD; preserve any post-merge commits. Check tracked/untracked changes, ignored files, active sessions, locks, branch dependencies, protection and files required for release. Keep the primary checkout, protected/default branches and anything still needed; report the reason.
- For squash/rebase merges use the PR record and head SHA, not only git branch --merged. git fetch --prune removes stale remote-tracking refs; git worktree prune removes stale registrations, not existing worktree directories. Use git worktree remove only after the checks above. Never blanket-delete or force-remove worktrees.
- Cleanup is performed by the responsible operator after verification; no automatic cleanup is introduced. In email-controlled work, the agent owns Git, PRs and external effects within the sandbox and interprets separate merge/deployment confirmations from user mail. Source edits use isolated worktrees; report pending cleanup.
- Preserve PR, commit and verification links after branch deletion. Mark a product Done only after actual release and acceptance, never because its branch was removed.
<!-- project-workflow:repo:v1:end -->
