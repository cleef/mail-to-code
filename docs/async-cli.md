# Native asynchronous mail sessions

Each fresh mail conversation binds permanently to Codex or Claude Code. Native
session IDs, exact input identity markers and immutable mail snapshots persist in
SQLite. Reply references select the conversation; subject tags only select the
executor for a new conversation. A maximum of four primary conversations run.
Codex can steer an active turn; Claude queues follow-ups until its active turn ends.

Only queue-mail sessions advertise a transport-only queue_mail tool. Final mode
advertises no tools. Retained Codex sessions may retain old dynamic tool schemas;
every operation tool returns TOOL_RETIRED_USE_NATIVE, without side effects. Every
new input injects the current contract after the private guide, overriding historical
scope, START, operation, hash and evidence instructions. No historical input is replayed.

The adapter does not run checks, Git, PR, merge, deploy or configured operation scripts.
Repositories, profiles and deployment definitions are reference facts. Native agents
perform the work using host development login inside the static sandbox. Merge and
deployment each need agent-interpreted explicit user email authorization. Both may
be authorized in one new email. Merge-only approval does not permit deployment.
With both authorized, merge and complete required checks before deploying the
corresponding version to the confirmed environment. Inspect deployment triggers
before merging; automatic deployment requires deployment authorization before merge.
Material changes to scope or deployment conditions require renewed confirmation.

After restart, the adapter checks native history for acknowledged input and completed
final replies. Missing acknowledgement evidence remains ambiguous and blocks replay.
Interrupted/missing/failed work is held until new user mail; no recovery turn is created.
A late completed final can still be recovered when it was not previously held as
interrupted. Mail reconciliation never resends uncertain mail automatically.
