# Operator workflow

Discuss the request and propose a decision-complete next step with deliverables,
acceptance checks and unresolved questions. Missing design documents are context,
not an automatic failure. Choose documentation, implementation or maintenance
based on the request and repository instructions.

The documentation stage means product planning records such as PRDs and designs.
It requires a configured product documentation repository and writes only that
repository; application repositories are read-only references. Ordinary README,
docs and acceptance-file changes within an application or controller repository
use maintenance, even when all deliverables are Markdown. They do not require a
product ID or a product record repository.
Implementation requires a fresh START. Review all actual changes and independent
checks. Product evidence follows application changes in the merge order.

Approving a Review authorizes its bound commits only. Deployment needs separate
confirmation. Controller changes are delivered as PRs and upgraded manually.

Codex interprets every new email, command, short acknowledgement and execution
outcome. Return an explicit next step and communication decision. Current-delivery
feedback chooses planning or development from the confirmed scope and worktree
facts, never from command words or project-header patterns. A scope change must
return to read-only planning.

Accepted feedback, queue state, automatic reanalysis and superseded approvals
remain internal while work can continue. Ask only concrete questions the human
must answer; do not turn a guard refusal into an open question. Combine real
questions and requested status into one communication. A completed stage's known
merge is a fact for Codex to decide the next step, with no carried START.

Codex decides technical implementation and reversible experience defaults after
checking code, existing conventions and confirmed operator preferences. Page
sizes, stable order, filtering before pagination and request-reset behavior do
not normally require a discussion. Inspect old-client assumptions and propose
an adaptation/release plan; default pagination alone is not compatibility.

Ask humans about unresolved business goals, material product tradeoffs, privacy
or public exposure, significant costs, irreversible effects or confirmed-requirement
conflicts that cannot be resolved from the evidence. Each choice includes why a
human decision is needed, two or three meaningful options, the recommended option,
its rationale and costs. Missing objective facts have no invented recommendations.
Plan points, human decisions and execution confirmation are separate. A recommendation
is never permission; silence or generic agreement does not select an option.

Use document versions and real confirmation records. Do not repeat a resolved
question merely because a document still says it awaits confirmation. Changed
scope or versions still require the appropriate fresh execution approval.

<!-- project-workflow:controller:v1:begin -->
## Shared branch closeout convention

- Read repository-specific rules and use one feature branch per reviewed PR by default. After merge, use a fresh branch from the latest default branch for follow-up work, keeping any existing product ID. Ordinary maintenance need not create a product ID.
- Report pending closeout separately from release acceptance. A merged PR does not mean the product is deployed or Done. Preserve PR, commit and verification evidence.
- The controller/operator owns Git and external effects. The model must not remove branches/worktrees or change GitHub settings. Each stage still needs its own START and Review; deployment remains separately approved.
- Operator closeout requires a merged PR with recorded head SHA matching the local HEAD, no unsaved tracked/untracked work, and checks of ignored/release files, active sessions, locks, dependencies and protection. Preserve primary checkouts, post-merge commits and anything still in use. Squash/rebase merges require PR/head evidence, not only git branch --merged.
- New repositories require shared rule onboarding and GitHub auto-delete configuration before development. Missing origin, permissions or configuration remains pending. Existing edited guides are preserved; no periodic discovery or automatic cleanup is introduced.
<!-- project-workflow:controller:v1:end -->
