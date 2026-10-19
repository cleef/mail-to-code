# Native passthrough validation

Recorded 2026-10-19. All fixtures use synthetic repositories, mail, authentication
values and PR/deployment targets. No real mailbox, business project, merge or
deployment was used. The running adapter was not upgraded or restarted.

## Regression suite

`npm test` passed **92/92**, with no skipped tests, on Node **22.23.2**, macOS.
The suite builds from a clean dist directory and covers transport identity and
deduplication, original executor/session continuity, retired operation tools,
current contracts on new/resumed inputs, immutable final replies/images, lost
acknowledgement and uncertain sends. Failed/interrupted/missing native histories
hold unfinished work without generating a recovery execution turn. Edited private
guides survive initialization. Static policy tests include canonical directory links
and future SQLite sidecar masks. Preview tests use localhost only.

## Matching-version acceptance: unavailable

The formal scripts remain strict about Codex **0.159.2**, Claude Code **2.1.296**
and Agent SDK **0.3.296**. The installed CLIs are Codex **0.163.0** and Claude Code
**2.1.302**; the SDK dependency remains **0.3.296**. No software versions were upgraded.
Retrieving the matching CLI binaries did not complete because downloads timed out.

| Command | Observed result |
| --- | --- |
| node scripts/verify-async-sandbox.mjs | Stops at the pinned Codex version assertion |
| node scripts/verify-async-cli.mjs | ASYNC_CODEX_VERSION_REQUIRED:0.159.2; no model turn |
| node scripts/verify-claude-cli.mjs | ASYNC_CODEX_VERSION_REQUIRED:0.159.2; no model turn |

Real model/native protocol, original-session resumption and synthetic email
merge/deployment confirmation acceptance **have not passed** with matching versions.
Linux OS sandbox acceptance is also outstanding. These results must be obtained on
the service host before a manual switch. Mock SDK tests do not replace them.

## Supplemental macOS isolation diagnosis

A temporary, explicitly labeled diagnostic copy used the installed CLIs and the
same policy/process-launch implementation against synthetic files and localhost.
Its result is `diagnosticPassed: true, pinnedAcceptance: false`. This is supplemental
evidence, not matching-version CLI/model acceptance. The Claude boundary runs a Node
probe through the SDK's whole-process launcher; it does not run a Claude model turn.

Both direct Codex OS sandbox and the Claude process launch path verified:

- Native project/Git metadata writes, Git init/commit/worktree creation without
  scope, prepared worktrees or authorization records.
- Native gh invocation and PR-shaped JSON lookup through `gh api` on a local server;
  synthetic Git/gh configuration reads and local outbound HTTP succeed.
- Mail login, SQLite, adapter lock, frozen images, foreign task/native history and
  outside files reject reads/writes; newly created sidecars/images/task files and
  neighboring UUID task names remain protected after policy creation.
- Runtime, foreign task and mail-login directory renames fail. Current task input
  is readable but immutable; notes and current Claude native history are writable.
- Protected fixture bytes remain unchanged. Real mail sent: **0**; business effects: **0**.

The missing sandbox-launcher regression also verifies no unsandboxed Claude fallback.
Use [manual switching steps](native-passthrough.md) after review and completion of
the outstanding matching-version and service-host isolation checks.
