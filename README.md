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

Use email as an asynchronous CLI: send an instruction, read the result, then reply
with the next instruction in the same conversation. For example, using the
synthetic repository `example-org/demo`:

| Email | Example instruction |
| --- | --- |
| New subject `[claude] Improve the form` | Implement the form change in demo, run checks and open a PR for my review. |
| Reply requesting status | Read the current GitHub status and checks for PR #7. |
| Reply after reviewing the PR | I have reviewed PR #7. Verify its current head and checks, then merge it. |
| Separate deployment reply | Deploy demo's version merged from PR #7 to its staging environment. |

Each confirmation names its action and target. Approval to implement a change
does not approve merging or deploying it. The agent reads current state and
interprets the new message; the adapter does not require scope grants or a special
confirmation syntax. Native GitHub queries use the service user's `gh` login.

Set `asyncMailOutput` to `assistant-final` for native final replies (the default
for new installs). Commentary and tool logs stay internal. `queue-mail` exposes
only `queue_mail({key,text})`; the agent explicitly queues the reply in this mode,
and its final assistant message stays internal. Existing installations retain
their configured output mode.
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

For a new installation:

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
read-only to agents, including its Git metadata. Use a separate development clone
and isolated worktree for changes to the adapter.

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
The service PATH must resolve Node, Git, gh and the required CLIs; absolute
`codexCommand` / `claudeCommand` paths can select CLI installations. On Linux,
`CLAUDE_CONFIG_DIR` (default `~/.claude`) must be outside writable project roots
and readable tool directories; overlapping paths stop Claude startup. See
[executor setup](docs/executors.md) for the sandbox requirements.

`doctor` checks versions, Git, gh login, guide and mail readiness without sending.
Existing installations follow [manual migration](docs/native-passthrough.md),
preserving configuration, edited private guides, native session IDs, mail records
and worktrees. Run real sandbox acceptance on the actual host before starting the
service. Adapter upgrades remain manual and require human review.

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

| Command | What it verifies | Runtime needed |
| --- | --- | --- |
| `npm test` | Build and synthetic regression suite | Node 22.13+ (22.x) and installed npm dependencies |
| `node scripts/verify-async-sandbox.mjs` | Both OS sandbox launch paths, native Git/gh, local networking and protected host files | Pinned CLIs, Git, gh and host sandbox support; no model login |
| `node scripts/verify-claude-startup.mjs` | Real Claude SDK/CLI initialization with a fresh session | Pinned CLIs and host sandbox support; no model input or login |
| `node scripts/verify-async-cli.mjs` | Codex native tools, session continuity and synthetic merge/deploy confirmations | Pinned CLIs, host sandbox support and model authentication |
| `node scripts/verify-claude-cli.mjs` | Claude native tools, session continuity and synthetic merge/deploy confirmations | Pinned CLIs, host sandbox support and model authentication |

All fixtures are synthetic; these scripts never connect a real mailbox or
merge/deploy a real project. CI runs the regression suite, sandbox probes and
Claude startup check without model credentials. Model sessions and actual mailbox
round trips require separate acceptance. Missing runtime support is reported as
failed/unavailable, never replaced by mock evidence.

See [validation instructions](docs/validation.md) and the
[native startup/session acceptance record](docs/validation-claude-startup.md).

## License

[MIT](LICENSE).
