# MailToCode

Self-hosted, email-driven coding with Codex, human review, and approval-controlled deployment.

Describe a task by email. MailToCode identifies the relevant repositories, discusses a plan, runs Codex in isolated worktrees, independently checks the changes, and replies with a Review. Merge and deployment require separate approval of the current version.

## Workflow

**Request → Plan → START → Develop → Review → APPROVE → Merge → DEPLOY**

- Natural-language requests can involve multiple repositories and read-only references.
- Discussions, staged documentation and implementation, multi-item replies, and follow-up requests remain attached to the task.
- SQLite preserves task state, Gmail history, verified delivery identities, approval snapshots, worktrees and Codex resume contexts.
- The controller owns email, Git, credentials and deployment. Codex cannot access controller secrets or production services.
- Changes to MailToCode itself require manual review, merge and upgrade.

## Requirements

Node.js **22.13+ (22.x)**, npm, Git, an authenticated Codex CLI with named filesystem permission support, Gmail OAuth, and repository-scoped GitHub credentials. Linux user services use systemd. Podman is required for screenshots or isolated test services.

## Setup

```sh
git clone https://github.com/cleef/mail-to-code.git ~/projects/mail-to-code
cd ~/projects/mail-to-code
npm ci
npm test
node dist/src/cli.js init --gmail agent@gmail.com --owner owner@example.com
```

Edit `~/.config/mail-to-code/config.json`. Supply your Gmail desktop OAuth client as `oauth-client.json`, and write your GitHub token to the configured private token file. Run `node dist/src/cli.js auth`, then configure projects and run `node dist/src/cli.js doctor`.

Configuration and credentials live in `~/.config/mail-to-code/` (directory 700, files 600). Override the directory with `MAIL_TO_CODE_CONFIG_DIR`. New installations store runtime data in `~/.local/share/mail-to-code/`; existing installations may retain an explicit `dataDir`. Neither belongs in Git.

Private `AGENTS.md` and `WORKFLOW.md` hold operator conventions. Installation and upgrades preserve edits. Repository instructions remain authoritative for project-specific work. Product documentation is optional and configured with `productDocs`.

On Linux, install the user service with `./scripts/install-user.sh`. Enable user lingering through an administrator. Optional screenshot image: `./scripts/build-preview.sh`. Start only after configuration, migration and readiness checks pass.

## Usage

Email a description of the project and requested change. Explicit routing is also supported with `NEW <project>:`. Reply to the latest proposal with `START`, then reply to the latest Review with `APPROVE`. Deployment uses a separate `DEPLOY <project>` confirmation after merge.

`STATUS`, `CANCEL` and `RETRY` are available in the task thread. Uncertain sends, merges or deployments require reconciliation; they are not automatically retried. Old or quoted approvals cannot authorize a new version.

See [configuration](docs/configuration.md), [operations and migration](docs/operations.md), and [validation](docs/validation.md).

## License

[MIT](LICENSE).
