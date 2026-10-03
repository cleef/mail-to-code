# Validation

Run `npm test` on Node 22. The suite uses synthetic repositories and mail transports. It covers sender authentication, routing, multi-repository scope, immutable baselines, approval/version/stage binding, independent checks, cancellation, restart recovery, uncertain effects, delivery identity, task memory, presentations, and offline configuration adoption.

`node scripts/verify-conversations.mjs --local-synthetic` exercises reply interpretation through the real Codex CLI, without sending mail or running business adapters. `sandbox-probe.mjs` and `verify-reply.mjs --permissions` check development and reply isolation using private operator configuration.

Before deployment, rehearse migration on a WAL-consistent private database copy. Compare historical outbox/inbox, Gmail cursor, PRs, commits, worktrees and Codex contexts. Confirm that adoption queues planning only and that stale confirmations cannot execute. Test both pre-start restoration and database-compatible recovery. Keep live task content and acceptance reports private.

A real mailbox acceptance requires an authenticated request from the configured owner. Confirm intake, proposal, START, implementation, independent checks and Review. It does not authorize merge or deployment.
