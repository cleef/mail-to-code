# MailToCode

**Your inbox, your coding workflow.**

A self-hosted, email-driven coding workflow with Codex, human review, and approval-controlled deployment.

Send a request by email, discuss the plan, review the changes, and decide when to merge and deploy.

## Project status

This repository currently contains the project overview only. The existing `mail-agent` implementation will be migrated here in a later step. Installation instructions and runnable code will be added with that migration.

## Intended workflow

1. **Request** — Describe a task in an email.
2. **Plan** — Discuss the scope, affected repositories, and verification steps.
3. **Develop** — Confirm the plan and run Codex in isolated Git worktrees.
4. **Review** — Receive pull requests, check results, and preview evidence.
5. **Approve** — Approve the specific version to merge.
6. **Deploy** — Separately authorize deployment where configured.

## Scope

- Natural-language requests and follow-up discussion through email.
- Persistent tasks and resumable Codex sessions.
- Single-repository and coordinated multi-repository work.
- Independent build and test checks, with preview evidence where applicable.
- Human approval tied to the reviewed commits.
- Separate merge and deployment decisions.

MailToCode focuses on human-to-agent development workflows. Agent-to-agent coordination may be added through optional integrations as the project evolves.
