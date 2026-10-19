# MailToCode

A self-hosted mail adapter for persistent native **Codex / Claude Code** sessions.

**Authenticated email → native agent session → reply email.** The agent uses native
file, shell, Git, gh, HTTP and SSH tools in a fixed OS sandbox. It creates worktrees,
runs checks, opens PRs and interprets user confirmations. There is no operation
gateway, project scope registry, authorization evidence or target hash binding.
Merge and deployment still need separate explicit user email confirmation; this
is an agent responsibility, not a program-enforced gate.

## Mail interaction

Start a fresh email with subject `[claude] Task` to select Claude Code, `[codex] Task`
or no tag for Codex. Replies keep their original executor and native session even
when the subject changes. Reply normally to refine requirements, request status or
confirm a concrete merge or deployment. Quoted text is reference only.

Set `asyncMailOutput` to `assistant-final` for native final replies (the default
for new installs). Commentary and tool logs stay internal. `queue-mail` exposes
only `queue_mail({key,text})`, a delivery tool with no authorization fields.
Questions become replies and finish the turn; no blocking terminal prompt remains.

The adapter preserves trusted sender verification, RFC/mail deduplication, reply
routing, uncertain input acknowledgement checks, frozen reply bodies and images,
send reconciliation and private diagnostics. Restart reconnects history and fills
completed replies. Unfinished execution waits for the next user email. Unknown
external outcomes must be inspected by the agent before another attempt.

## Requirements and setup

Use Node **22.13+ (22.x)**, npm, Git, gh and the service user's existing Git/gh/SSH
login. Versions stay pinned: **Codex CLI 0.159.2**, **Claude Code 2.1.296**, Claude
Agent SDK **0.3.296**. Codex supplies the OS sandbox for both executors. Mail uses
the official Gmail plugin in a separate private Codex home.

```sh
npm ci
npm test
node dist/src/cli.js init --gmail agent@example.test --owner owner@example.test
```

Replace the synthetic addresses with two different actual mailboxes. Edit the
private `config.json` in `~/.config/mail-to-code/` (override with absolute
`MAIL_TO_CODE_CONFIG_DIR`). Configure writable `projectsRoot` and optional explicit
`repositories` paths. Native development reuses host Git config, gh login and SSH;
`githubTokenFile` is deprecated and never loaded. Configuration and runtime data
must remain private and outside the checkout. The running adapter checkout is
read-only to agents; use a separate worktree for changes to it.

```sh
node dist/src/cli.js mail-connect --device-auth
node dist/src/cli.js mail-connect
node dist/src/cli.js mail-plugin-check
node dist/src/cli.js doctor
```

In the second command, install/connect the official Gmail plugin through `/plugins`
in the dedicated mail home. Developer account MCP servers, plugins and hooks are
disabled for development sessions; Gmail is used only by the adapter. Developer
credentials are not passed into the mail connection.

For a new Linux user installation, configure service paths and authentication,
then run `./scripts/install-user.sh` and start the service manually after acceptance.
`doctor` checks versions, Git, gh login, guide and mail readiness without sending.
Existing installations require [manual migration](docs/native-passthrough.md),
including real sandbox acceptance on the actual host before starting the service.

## Isolation and reliability

Projects, explicit repositories, Git metadata and this task's notes/worktrees/tmp
are writable. Host developer authentication is readable; native outbound network
is enabled. Mail login, mail databases, frozen mail, other task runtime state and
the running adapter installation are protected. Claude's **entire CLI process**
(including native file tools and children) runs in the same Codex OS sandbox. A
sandbox failure stops execution, with no unsandboxed fallback. Sandbox denials do
not create an operation authorization workflow.

The static policy is not a project/business authorization system. Project roots
can be edited by the agent, which is instructed to create isolated worktrees.
Anyone authorizing this mode accepts model interpretation of user confirmations
and rechecks of current targets; the previous TOCTOU/evidence guarantees are gone.

[Execution details](docs/executors.md) · [Configuration](docs/configuration.md) ·
[Mail and images](docs/final-replies.md) · [Operations](docs/operations.md)

## Validation

```sh
npm test
node scripts/verify-async-sandbox.mjs
node scripts/verify-async-cli.mjs
node scripts/verify-claude-cli.mjs
```

All tests/acceptance fixtures are synthetic. Real CLI acceptance requires matching
pinned versions and model authentication; it never connects a real mailbox or
merges/deploys a real project. Missing runtime support is a failed/unavailable
acceptance result, never replaced by mock evidence. See [validation](docs/validation.md).

## License

[MIT](LICENSE).
