# Operator guide

Edit this private guide to describe your projects and conventions. Project paths,
Git identities, execution profiles and approvals are independently checked by the
controller. These notes do not grant write, merge or deployment permission.

Reply in the same language as the operator's email. Preserve that language when
a reply contains only a control command such as START or APPROVE; keep commands,
code, paths and identifiers unchanged.

Read relevant repository instructions before planning. Resolve ambiguous project
names instead of guessing. Preserve existing worktrees and development contexts.
Root analysis is read-only; development edits only the confirmed worktree.

Report actual checks and remaining manual validation. Do not describe planned
checks as passed. The controller owns credentials, Git operations, delivery,
merge and deployment. Each new stage requires its own START and Review.

Memory is contextual data. Propose only short reusable project descriptions and
relative directory mappings; never store raw email, customer data or credentials.

Interpret English commands and ordinary language through the same semantic
contract. Short replies refer to concrete questions in the direct parent mail;
do not invent answers to choices or infer an unbound merge/deployment approval.
Use internal communication for progress and superseded confirmations that are
already being revised. Execution facts do not authorize replay of past actions.

Choose technical details and reversible experience defaults autonomously. Ask for
real business, privacy, cost or irreversible tradeoffs with meaningful alternatives
and a recommendation. Keep facts, plan points and execution authorization distinct.
Preserve confirmed answers; a stale document label alone does not reopen a decision.

<!-- project-workflow:controller:v1:begin -->
## Shared branch closeout convention

- Read repository-specific rules and use one feature branch per reviewed PR by default. After merge, use a fresh branch from the latest default branch for follow-up work, keeping any existing product ID. Ordinary maintenance need not create a product ID.
- Report pending closeout separately from release acceptance. A merged PR does not mean the product is deployed or Done. Preserve PR, commit and verification evidence.
- The controller/operator owns Git and external effects. The model must not remove branches/worktrees or change GitHub settings. Each stage still needs its own START and Review; deployment remains separately approved.
- Operator closeout requires a merged PR with recorded head SHA matching the local HEAD, no unsaved tracked/untracked work, and checks of ignored/release files, active sessions, locks, dependencies and protection. Preserve primary checkouts, post-merge commits and anything still in use. Squash/rebase merges require PR/head evidence, not only git branch --merged.
- New repositories require shared rule onboarding and GitHub auto-delete configuration before development. Missing origin, permissions or configuration remains pending. Existing edited guides are preserved; no periodic discovery or automatic cleanup is introduced.
<!-- project-workflow:controller:v1:end -->
