# Controlled operations validation

Validated on 2026-10-05 using Node.js 22.23.2. All public fixtures, repository
identities, email bodies, scripts and SSH examples use synthetic data.

- Full `npm test`: 233 passing on macOS and Linux, including 16 operation tests.
- Coverage includes multiple projects, fixed arguments, private script validation,
  scope/identity checks, trusted mail binding, malformed/oversized outputs,
  serialization, deployment fingerprints and prerequisite failure, idempotency,
  timeout uncertainty, restart/reconciliation and old-thread compatibility.
- `node scripts/verify-async-sandbox.mjs` passed against Linux Codex CLI 0.159.2.
  Both native and package-command sandboxes denied private operation scripts,
  credentials/runtime files and original-checkout writes. Task worktree writes
  remained available. Native socket access was denied. App-server thread startup
  succeeded with approval policy `never`.
- Sandbox verification sent no real email and performed no business operation.
  Controller upgrade, active private configuration and production acceptance
  remain separate manual steps after review.

Reproduce with the supported Node.js 22 runtime:

```sh
npm ci
npm test
# Linux, with the required Codex CLI version installed:
node scripts/verify-async-sandbox.mjs
```

These checks establish controller behavior and sandbox isolation. An installation's
private scripts still need transport, service-environment and backup-integrity
acceptance against its own infrastructure after their review and activation.
