# MailToCode

MailToCode is a self-hosted, email-driven coding controller with **Codex and
Claude Code** executors. Mailbox access uses the official Codex Gmail plugin.

Describe a task by email. The controller passes it to a persistent session of the
selected executor and returns its final reply in the same mail thread. The agent
discovers repositories, discusses choices and works in approved isolated
worktrees. Merge and deployment require separate approval of the exact current
target.

## Workflow

**Email request → Codex or Claude Code session → Implementation and review → Separate merge and deployment confirmations**

| Action | Email example | Behavior |
| --- | --- | --- |
| Start with Claude Code | Subject: `[claude] Add CSV export`; body: `Implement export for the current filters, run tests and prepare a PR.` | Creates a new task bound to Claude Code |
| Start with Codex | Subject: `[codex] Add CSV export`, or an untagged subject | Creates a new task bound to Codex |
| Clarify or revise | Reply: `Use YYYY-MM-DD for dates.` | Continues the same task, executor, native session and PR when present |
| Confirm merge | Reply to the latest merge request: `Merge this reviewed PR version.` | Verifies the current PR head and base before merging |
| Confirm deployment | Reply to the separate deployment request: `Deploy this version to the environment specified in your email.` | Verifies the approved commit and deployment target |

- Executor tags must lead a fresh email's subject and are case-insensitive. No tag defaults to Codex. Existing tasks continue with their original executor. Changing a reply's subject does not switch executors; start a separate email to choose another executor.
- Use the `async-cli` engine. An explicit implementation request can authorize its stated scope without an extra start command. A discussion-only request stays in discussion until you request implementation. The selected agent asks for missing decisions when needed.
- A fresh email without reply references starts a new conversation. Replying to a known message continues its conversation across follow-ups, repository changes and service restarts.
- Requests can include multiple repositories and read-only references. Implementation stays in approved worktrees; adding repositories or changing a reference into a write target requires explicit scope confirmation.
- Merge and deployment each require a separate confirmation bound to the exact current target and a verified delivered request. A direct natural-language reply can confirm the proposed action; fixed command words are not required.
- SQLite preserves mail identities, inputs, grants, operation receipts and immutable replies. The corresponding native Codex or Claude history preserves session context, while `FEATURE.md` records progress and decisions.
- Both executors use the same scope grants, PR checks and approval rules. Implementation permission does not authorize merge or deployment; a changed PR head invalidates its previous merge approval.
- The controller owns email, privileged Git, credentials and external effects. Agents use approved bridge tools; development commands cannot access controller secrets or unrestricted networking.
- Reply normally to provide requirements, request progress or ask the agent to stop. Claude processes follow-ups after its active turn finishes; Codex can accept follow-ups during a turn. Email stop requests require interpretation; an operator can stop the service immediately when needed.
- An unavailable Claude executor leaves its task blocked with the original session and queued input. It does not fall back to Codex.
- Changes to MailToCode itself require manual review, merge and upgrade.

See [executor selection, permissions and recovery](docs/executors.md).

## Requirements

Node.js **22.13+ (22.x)**, npm, Git, repository-scoped GitHub credentials and
**Codex CLI 0.159.2** with the official Gmail plugin. Mailbox access uses a
separate ChatGPT login in a private Codex home; development can continue using
its existing API key, model settings and history.

For `[claude]` tasks, also install **Claude Code 2.1.296** and authenticate the
service user. `npm ci` installs the pinned Claude Agent SDK **0.3.296**; the
adapter uses your installed Claude executable. Codex remains required for Claude
tasks because it provides Gmail access and the OS sandbox for development
commands. Revalidate plugin tools, executor protocols and sandbox compatibility
before changing versions or installation paths.

Linux services use systemd. Podman is required for configured previews and
isolated project services.

## Setup

Use Node.js 22.x and run these commands for a **new installation**:

```sh
git clone https://github.com/cleef/mail-to-code.git ~/projects/mail-to-code
cd ~/projects/mail-to-code
npm ci
npm test
node dist/src/cli.js init --gmail agent@gmail.com --owner owner@example.com
```

Replace both email addresses. `gmailAddress` is the agent's Gmail mailbox;
`ownerAddress` is the operator's mailbox used to send requests and approvals.
They must be different. `init` selects `engine: "async-cli"` and
`asyncMailOutput: "assistant-final"`, so the selected executor's native final
replies become email. It creates private configuration and guide files without
overwriting an existing `config.json`. Existing installations should
edit their private files and follow the [upgrade procedure](docs/operations.md).

### Private configuration and templates

[`config-templates/`](config-templates/) contains public **templates**, not your
installation's active configuration. `init` generates `config.json` and
initializes the active operator guide, `ASYNC_AGENTS.md`, in
`~/.config/mail-to-code/`. Installation and upgrades preserve edited guides;
there is no need to copy the entire template directory on each upgrade.

| Private file | Purpose | How it is created |
| --- | --- | --- |
| `config.json` | Mailboxes, project directories and execution settings | Generated by `init`; edit for your installation |
| `ASYNC_AGENTS.md` | Operator conventions injected into both Codex and Claude sessions | Initialized by `init` or `async-agent-guide init`; editable |
| `codex-mail/` | Dedicated Codex login and official Gmail plugin connection | Created by `mail-connect`; managed by Codex |
| `github-token` | Repository-scoped GitHub credentials | Supply privately at the configured `githubTokenFile` path |

The configuration directory must have permissions `700`, and private files
`600`. Keep this directory outside Git. Override its location with
`MAIL_TO_CODE_CONFIG_DIR`, using an absolute path. If you override it, also set
`githubTokenFile` to the location where you store your GitHub credential.

The controller injects `ASYNC_AGENTS.md` at session startup or resume and reads
it again for subsequent mail inputs. This does not require
`~/.codex/AGENTS.md`. If the private guide is absent, the bundled template is
used. The agent also receives instructions to read relevant repository rules.
Initialize the guide separately with
`node dist/src/cli.js async-agent-guide init`; an existing edited guide is
preserved.

Edit `config.json` before running the service:

| Setting | What to provide |
| --- | --- |
| `engine` | Set explicitly to `async-cli` |
| `asyncMailOutput` | Set to `assistant-final` for native final replies; `queue-mail` selects explicit bridge-tool delivery |
| `gmailAddress` / `ownerAddress` | Agent Gmail address and the authorized operator address |
| `projectsRoot` | Directory containing your project repositories, default `~/projects` |
| `githubTokenFile` | Private GitHub token file; repository write access is required |
| `repositories` / `profiles` | Optional explicit repository and install/build/check/preview settings; projects can also be discovered and profiles inferred |
| `productDocs` | Optional product-record repository; omit if you do not use one |
| `dataDir` | Runtime state, default `~/.local/share/mail-to-code/`; preserve the existing path during upgrades |
| `codexCommand` | Codex CLI command, default `codex` through PATH; use an absolute binary path if your service PATH does not contain it |
| `claudeCommand` | Optional Claude Code executable, default `claude` through PATH; requires version 2.1.296 for `[claude]` tasks |
| `pollSeconds` | Gmail polling interval, default `60` seconds |
| `mailCodexHome` | Dedicated private Codex home, default `<configDir>/codex-mail/`; keep it separate from development and project checkouts |

Deployment is disabled by default and requires private settings plus a separate
approval. See [configuration examples](docs/configuration.md) for profiles,
previews and deployment settings. Runtime state and credentials do not belong
in the checkout.

The installed service uses `PATH=/usr/local/bin:/usr/bin:/bin`. Configure absolute
executor paths when needed, and verify Codex's executable and runtime files are
accessible under the configured OS sandbox. Restart the service after changing
executor paths or output mode.

### Connect Gmail

Run these commands **on the service host**, using its private configuration:

```sh
node dist/src/cli.js mail-connect --device-auth
node dist/src/cli.js mail-connect
```

The first command prints a device login URL and a short-lived code. Sign in
using the ChatGPT account intended for the mail connection. If prompted, enable
device-code sign-in in ChatGPT Security settings, then run the command again.
Wait for the successful login message. It is safe to exit a completed login.

The second command opens interactive Codex in the dedicated mail home. Use
`/plugins` to install/enable the **official Gmail plugin** and connect the agent
Gmail account. Exit Codex after connecting, then verify:

```sh
node dist/src/cli.js mail-plugin-check
node dist/src/cli.js doctor
```

The plugin still requires Google authorization, and its connection can expire
or be revoked. Reconnect through `mail-connect`; MailToCode does not own a
Google OAuth client or refresh token. No Google Cloud project, callback server,
application website or SSH callback forwarding is needed for this workflow.
The development Codex home is not copied or replaced. Keep mail credentials
private with directory permissions `700` and file permissions `600`.

`mail-plugin-check` checks the tool protocol and makes an actual profile call;
`doctor` does not send mail. A profile success is not delivery acceptance.
See [Gmail plugin readiness](docs/gmail-plugin-readiness.md).

### Enable Claude Code

Install the required Claude Code version on the service host and authenticate
the service user, then verify:

```sh
claude --version
```

The expected version is `2.1.296 (Claude Code)`. Set `claudeCommand` to an absolute
path if the executable is outside the service's PATH.

The adapter uses Claude's saved login and allowlisted authentication/model values
from the service environment or a regular private (`600`)
`~/.claude/settings.json` file. It disables account/project customizations,
plugins, hooks and native tools; Claude uses controller MCP tools for sandboxed
development and approved external effects. See [Claude setup and permissions](docs/executors.md#runtime-and-permissions)
for supported authentication variables and restrictions.

### Verify and start

Configure GitHub credentials and your projects before starting the service. The
commands below are for a new async installation on Linux with systemd. Have an
administrator enable user lingering so the service continues after logout.
Build the preview image with `./scripts/build-preview.sh` if your projects need
screenshots or isolated test services, then check readiness:

```sh
node dist/src/cli.js doctor
```

With `engine: "async-cli"`, `doctor` runs the same checks as `async-doctor`: Node,
projects root, pinned Codex version, optional Claude version, operator guide,
configured project test runtimes/images, private operation scripts and Gmail
plugin protocol and identity. Database/browser checks use
[configured project checks](docs/project-checks.md), including older sessions.
The Claude check is optional for Codex-only installations; verify it passes when
enabling Claude tasks. Version checks do not prove Claude authentication or
successful model execution. Prepare GitHub credentials and project profiles
separately; they are not fully tested by this readiness check. The runtime
database initializes when the service starts.

Start the controller only after readiness passes. Install and start the user service:

```sh
./scripts/install-user.sh
systemctl --user start mail-to-code.service
```

Run one mailbox consumer. See [operations](docs/operations.md) for upgrades,
backups and recovery. A controller upgrade does not deploy its projects.

**Email language:** write requests in your preferred language. The operator guide
and model instructions tell the agent to use the same language for generated
plans, discussion, summaries and questions. Keep code, paths and identifiers
unchanged. Built-in controller status tables and approval boilerplate currently
include Chinese text; full localization of those fixed templates is not yet
implemented.

## Asynchronous CLI engine

The `async-cli` engine starts one persistent Codex or Claude Code session per
task in the configured `projectsRoot` on the service host (default `~/projects`).
Work continues within approved scope, and progress lives in
`<dataDir>/async-cli/features/<feature-id>/notes/FEATURE.md`.

Use `asyncMailOutput: "assistant-final"`: the selected executor's native final
reply becomes the email in the same conversation. New tasks' replies identify
the executor. Commentary, reasoning and tool logs remain internal; no second
notification is drafted. In `queue-mail` mode, only an explicit `queue_mail`
call sends a decision, blocker, requested status or result.
See [final replies and confirmations](docs/final-replies.md) and
[async runtime details](docs/async-cli.md).

**Image replies:** either executor can generate or copy PNG/JPEG files into the
current task's `notes/mail-images/` directory and reference them with
`![Preview](mail-images/preview.png)` in its final reply. The controller freezes
the actual bytes before queuing mail, renders images inline with CID MIME parts,
and leaves the files available for saving in the mail client. Both assistant-final
and queue-mail threads support this convention. Total image size is
limited to 10 MiB. Invalid files hold the reply with a visible diagnostic; they
are never replaced by a filename-only success message. See the
[image rules](docs/final-replies.md#image-replies).

Administrator-configured [controlled operations](docs/controlled-operations.md)
let the async controller run trusted inspection/backup scripts over SSH or another
transport. Scripts and credentials stay private; the agent chooses only configured
operations. Deployment can require verified prerequisites before its trusted
script runs. This feature is disabled until an administrator configures it.
Receipts retain verified backups and bounded deployment stage events; raw
diagnostics stay private. An uncertain effect requires operator inspection and
reconciliation before further writes, including after a controller upgrade.

Service restarts recover the task's original executor and native session.
Uncertain mail delivery or external effects require operator inspection and
reconciliation; they are never retried automatically. An executor failure does
not authorize a session switch or permission expansion. Preserve native
histories, approved worktrees and private guides across upgrades.

## Validation

Run `npm test` before handing off changes. For synthetic real-runtime acceptance
on Linux, with the pinned executors available:

```sh
node scripts/verify-async-cli.mjs
node scripts/verify-claude-cli.mjs
node scripts/verify-async-sandbox.mjs
```

The model checks may incur account usage. They use synthetic projects and mail
fixtures, without connecting a real mailbox or performing real PR, merge or
deployment effects. Mail delivery and client threading still need actual
owner-mail acceptance. See [dual executor validation](docs/validation-executors.md).

## License

[MIT](LICENSE).
