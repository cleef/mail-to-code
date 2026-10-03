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
