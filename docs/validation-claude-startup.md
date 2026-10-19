# Claude native startup validation

Recorded 2026-10-19 for the follow-up to PR 24. All mail, projects, confirmations
and session-history fixtures are synthetic. No real email, merge or deployment
is performed. Test artifacts and host-specific evidence remain outside the repo.

## Failure and repair

The pinned CLI rejects `--session-id` when its transcript already exists, including
an empty file. `prepareNativeFilesystem` previously created that file before launch.
Removing only the pre-creation is insufficient on Linux: an absent exact file is
not available as a persistent bind mount in the pinned sandbox.

New sessions now use a task-specific cwd and native project directory. Only that
directory is writable; the CLI creates its own transcript. The launcher preserves
the SDK cwd instead of switching back to the shared project root, and history
reads use the same cwd. Existing transcripts keep their original project directory,
cwd, ID and exact grants. Tests cover existing task contents and the pinned SDK's
long-path encoding as well as byte-for-byte history preservation during preparation.

## Results

Pinned runtimes: Codex **0.159.2**, Claude Code **2.1.296**, Agent SDK **0.3.296**.
Node **22.23.2** was used for the local and Linux checks.

| Check | Result |
| --- | --- |
| `npm test`, macOS and Linux | **96/96**, no skips |
| Linux OS sandbox | **51** Codex + **52** Claude process checks passed |
| `verify-claude-startup.mjs`, macOS and Linux | Native SDK initialization passed; transcript absent before launch; **0** model inputs |
| `verify-claude-cli.mjs`, Linux | Native worktree and file checks; restart continuity; separate synthetic merge/deploy confirmations; **4** immutable replies |
| Legacy-layout continuity, final implementation | Same session resumed from the pre-upgrade directory; first-email token recovered; existing task cwd preserved |
| `verify-async-cli.mjs`, Linux | **3** immutable replies; same session after restart; native worktree and separate synthetic confirmations passed |

The legacy fixture copies only a freshly generated synthetic native history into
the old layout and retains its original history as a backup. It does not migrate
or use an operator conversation as a fixture. A fourth real Claude turn verifies
the original token and session ID using the legacy file grants.

CI runs the real pinned Claude SDK initialization without model credentials, in
addition to the filesystem process probes. The implementation commit passed both
[push](https://github.com/cleef/mail-to-code/actions/runs/39202010370) and
[pull request](https://github.com/cleef/mail-to-code/actions/runs/39202066027) checks.
The startup probe specifically catches the pre-created-transcript regression;
process-boundary assertions independently verify the actual native cwd.

Supplemental host probes verified private file read/write denial, read-only staging
installation, task writes, native Git, read-only GitHub login queries and SSH config
resolution through both sandbox launch paths. SSH was tested with an explicit
user-owned configuration and a synthetic hostname, without making a connection.
The pinned Linux user namespace maps root-owned system includes to an unmapped UID;
default SSH config ownership checks fail there even with read grants. Explicit
user config selection avoids that issue without changing host configuration.

Model acceptance and immutable queued replies do not send mail. Actual mailbox
round trips and release acceptance remain part of the separately confirmed manual
upgrade in [the switching procedure](native-passthrough.md).
