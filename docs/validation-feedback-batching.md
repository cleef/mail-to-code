# Feedback batching validation

## Trigger and correction

A reply with several independent edits previously queued one plan/development
job per item. The first analysis already included all accepted stage feedback,
but the remaining items still replanned and published new approval notices.

Compatible feedback items from the same message and stage now share one job.
Each item retains its own ledger entry, question references and completion
status. Unmet dependencies, blocked items, other messages and control actions
remain separate. Every explicit `PROJECTS:` declaration is retained.

Successful feedback produces its revised plan or Review without an additional
receipt email. Questions, refused actions, mixed commands and execution failures
still produce a notification. START continues to require the latest bound plan;
batching grants no merge or deployment authorization.

## Synthetic regression coverage

- Four independent edits: one planning job, all edits included, one ready-plan
  notice, and its START remains valid after repeated queue advancement.
- Duplicate intake: no duplicate reply interpretation or planning job.
- Shared interrupted job: all items become blocked without automatic replay.
- Unmet dependencies and unclear items: never absorbed into a ready batch.
- Separate source emails: their job and completion boundaries remain separate.
- Multiple repository declarations: all hints survive combined feedback.
- Existing tests retain approval invalidation for current-delivery edits, future
  requests, cancellation, transaction rollback and stale version bindings.

The plan test uses the real controller and in-memory state with synthetic work
and mail adapters. Its two analysis calls are the initial and pinned-baseline
passes of one planning job. No actual mailbox, project or production effects are
performed by these tests.
