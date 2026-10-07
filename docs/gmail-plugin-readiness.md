# Official Gmail plugin transport

MailToCode uses the official Codex Gmail plugin through a dedicated app-server
process. The controller directly calls only `get_profile`, `search_email_ids`,
`read_email` and `send_email`. Mail polling, MIME parsing and sending do not run
model turns. The mailbox process has no project workflow or hooks; development
sessions disable account apps, plugins and hooks and cannot read the mail home.
The controller itself restricts direct RPC dispatch to these four tools; a
broader app-server metadata catalog does not grant a model access to that catalog.

## Connection and readiness

The default mail home is `<configDir>/codex-mail/`. `mailCodexHome` may select
another private directory outside development and project checkouts. Use `700`
for directories and `600` for private files. Existing development API keys,
models, histories and worktree paths are retained.

```sh
node dist/src/cli.js mail-connect --device-auth
node dist/src/cli.js mail-connect
node dist/src/cli.js mail-plugin-check
node dist/src/cli.js doctor
```

Complete the device login using the intended ChatGPT account. Enable device
sign-in in ChatGPT Security settings if required. In interactive Codex use
`/plugins` to install/enable official Gmail and connect the configured agent
mailbox. This still grants Google access through the official connection flow;
MailToCode does not maintain a Google client or refresh token. Reconnect through
`mail-connect` when authorization expires or is revoked. Never copy another
Codex home's authentication files.

See [plugins](https://learn.chatgpt.com/docs/plugins),
[authentication](https://learn.chatgpt.com/docs/auth) and
[app-server](https://learn.chatgpt.com/docs/app-server).

The readiness check requires direct RPC routes and a matching profile. It does
not send mail, ingest messages or run a model. `deliveryVerified: false` means
real delivery acceptance remains separate. Missing raw MIME, pagination, reply
parameters or delivered identity blocks cutover; never synthesize mail through
a model or restore the retired transport.

## Intake and delivery

Polling defaults to 60 seconds. Every scan uses the last successful checkpoint
with a 24-hour overlap, bounded by the installation baseline. A full scan from
that baseline runs daily and after long downtime. All search pages and message
processing must complete before the checkpoint advances. IDs already in inbox,
rejected or quarantine records are not dispatched again; unread flags are unused.
A first installation establishes its baseline without ingesting older mail.

Raw RFC messages retain authentication headers, quoted history, MIME attachments
and RFC reply identities. Only authenticated new owner content can authorize
work. Missing required fields fails closed and preserves the checkpoint.

Before a send, the controller persists the frozen reply parent's Gmail ID,
actual RFC identity, quoted-body digest and attachment content hashes. The plugin threads the reply and
appends the parent's quoted text. Delivery verification checks the frozen new
body separately from the exact quoted parent, plus recipient, sender, SENT
label, thread, attachments, delivery marker and actual RFC Message-ID. No CC/BCC
is allowed. Uncertain sends are reconciled by reading/searching sent mail and
are never automatically retried; unverified notices grant no execution authority.

## Existing installations

Migration changes mailbox transport only. Keep the existing dataDir, attachments,
worktrees, development Codex home, output mode, task IDs and approval evidence.
Prepare a reviewed build and validate the server connection before stopping the
existing service. Do not remove credentials while that service still needs them.

1. Inspect active native turns, jobs, outbox and external operations. Resolve
   in-flight and uncertain effects and reach an idle stopping point.
2. Stop both controller services and use `scripts/backup.mjs` to save consistent
   copies of **both** SQLite databases, private guides and service definitions.
   This backup excludes old OAuth credentials. Preserve referenced worktrees,
   Git refs, attachments and development session files separately.
3. Run `migrate-mail --dry-run`, inspect the baseline and blockers, then
   `migrate-mail`. These commands acquire the same exclusive dataDir lease.
   A real migration rechecks the direct-call connection before writing state.
   They remove `oauthPort`, configure the independent mail home and add search
   checkpoints. The async baseline retains `started_at`; historical cursor,
   inbox, rejected, quarantine, outbox and task records are not rewritten.
4. Run `doctor` and sandbox checks. Start one service. Verify a real authenticated
   owner request, continued conversation and verified reply, without merging or
   deploying its project.
5. Only after acceptance remove confirmed old `oauth-client.json`, `token.json`
   and temporary copies from the current/old config directories and private
   backups. Remove obsolete Gmail MCP registrations, OAuth environment variables
   and callback forwarding entries. Revoke the **old self-managed app** in the
   Google account, then delete only its dedicated OAuth client if applicable.
   Preserve the Cloud project, official plugin authorization, current credentials,
   live databases and all recovery/task files.

There is no old Gmail transport, `auth` command or downgrade entry point.
Recovery means reconnecting the plugin or installing another reviewed compatible
plugin-only build. Stop mail processing on failure; never restore an old SQLite
snapshot to replay effects. `rollback.sh` rejects OAuth builds and does not
restore databases. `migrate-mail` is idempotent and cannot replay business work.
