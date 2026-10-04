# Async sandbox mask validation

A configured GitHub token inside the controller configuration directory was
masked twice: the base policy denied its parent directory, then the asynchronous
policy appended a separate child-file deny. On Linux, Bubblewrap attempted to
create a child mount point inside the denied directory and failed before
`thread/start` could finish loading repository instructions.

The task policy now merges additional asynchronous permissions before a single
normalization and serialization pass. Exact child denies covered by a denied
parent are removed unless an intervening read/write rule reopens that subtree.
Glob restrictions remain, including restrictions for future task secret files.
A token outside the configuration directory keeps its own deny rule.

## Synthetic regression

Local and Linux Node 22 full regression: 217/217 passed on each host. Tests cover nested and external tokens, path-boundary siblings,
reopened subtrees, preserved glob restrictions, and startup retry. A failed
thread start leaves the input queued; the next successful start accepts it once
in the same conversation and clears transient failure metadata. No manual input
reset, historical approval replay, protocol change, or SQLite migration is needed.

## Actual Linux acceptance

The fixed Codex CLI 0.159.2 probe uses a disposable projects directory, sibling
runtime-data directory and denied configuration directory with synthetic GitHub
and OAuth tokens. It verifies:

- Project instructions and linked project source remain readable.
- Original and linked checkout writes are denied.
- Runtime database, OAuth and GitHub tokens, foreign feature state, task `.env`,
  Git metadata and a later-created `.key` file remain unreadable.
- Task-worktree and task-note writes succeed.
- The command adapter enforces the same checks.
- An external GitHub token remains unreadable.
- A real app-server `thread/start` succeeds without starting a model turn.

The previous release reproduces the nested-token Bubblewrap failure with the
same synthetic configuration. All fixed-release acceptance checks passed. This probe is Linux-specific because the existing
command adapter uses the Linux Bash/stdio wrapper. All files, addresses and
credentials in acceptance are synthetic. No real mail, PR, merge, deployment or
business operation runs in the probe.

Controller upgrade remains manual after reviewed merge. Preserve the current
async database and queued input; let the existing scheduler retry naturally.
If rollback is needed, stop the service and restore compatible code while
retaining the current database rather than replaying a historical snapshot.
