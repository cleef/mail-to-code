# Validation

Run `npm test` on Node 22. The suite uses synthetic repositories and mail transports. It covers sender authentication, routing, multi-repository scope, immutable baselines, approval/version/stage binding, independent checks, cancellation, restart recovery, uncertain effects, delivery identity, task memory, presentations, and offline configuration adoption.

`node scripts/verify-conversations.mjs --local-synthetic` exercises the v2 semantic contract through the real Codex CLI, without sending mail or running business adapters. It includes superseded approval plus pagination feedback, exact English status, negation, quotation and conditional authorization. The synthetic unit suite also covers communication repair, typed guard facts, phase decisions, stale observations, v6-to-v7 preservation and restart deduplication. `sandbox-probe.mjs` and `verify-reply.mjs --permissions` check development and reply isolation using private operator configuration.

Before deployment, rehearse migration on a WAL-consistent private database copy. Compare historical outbox/inbox, Gmail cursor, PRs, commits, worktrees and Codex contexts. Confirm that adoption queues planning only and that stale confirmations cannot execute. Test both pre-start restoration and database-compatible recovery. Keep live task content and acceptance reports private.

A real mailbox acceptance requires an authenticated request from the configured owner. Confirm intake, proposal, START, implementation, independent checks and Review. It does not authorize merge or deployment.

`node scripts/verify-discussions.mjs` checks autonomous pagination defaults, real
privacy choices with recommendations, missing facts, confirmed document versions
and explicit recommendation replies through the real Codex CLI. All inputs are
synthetic; mail sending and business execution are forbidden. The unit suite
checks shared prompts, option/reference validation, metadata propagation,
separate discussion/authorization rendering and untouched historical snapshots.

For pagination compatibility decisions, [AIP-158](https://google.aip.dev/158#backwards-compatibility) explains why changing an existing full-list response to a finite default changes old-client behavior. Inspect those assumptions before proposing adaptation and rollout.
