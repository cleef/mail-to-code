# Executors and sandbox

Fresh subjects `[claude]` / `[codex]` choose an executor; an untagged subject chooses
Codex. Reply references preserve executor and native session identity. No fallback
switches an unavailable executor. Versions are Codex 0.159.2, Claude Code 2.1.296,
Agent SDK 0.3.296. Changing versions requires separate protocol/isolation acceptance.

Codex app-server uses native tools with approval_policy=never and a named static
permissions profile. Account MCP inventory is explicitly disabled; apps, plugins
and hooks are off. Claude SDK enables its native claude_code tool preset, disables
settings sources, hooks, plugins and inherited MCP, and launches the complete CLI
through `codex sandbox -P mail-to-code-task` using spawnClaudeCodeProcess. SDK
permission bypass only prevents interactive prompts **inside** that OS boundary;
it does not bypass the OS sandbox. No fallback starts Claude outside the sandbox.
Only queue-mail mode adds the queue_mail SDK MCP server. Unexpected inherited MCP
inventory fails initialization before accepting input.

The shared filesystem policy opens projectsRoot, configured repositories at their
canonical locations (directory links resolve to the same writable target), productDocs and this task's worktrees/notes/tmp; task input is
readable. Git metadata is available for native worktree/branch operations. The live
adapter installation is read-only. Private mail configuration/login, SQLite and its
sidecars, frozen images/backups/diagnostics and other task runtime directories are
masked. The policy must be accepted on the actual OS with the pinned CLI before use.
Claude native history is limited to its session's files within its host history store.
The runtime parent is denied with only the current task directory reopened and
input read-only. On Linux this creates a private mount view, so other task files
created after sandbox startup stay hidden too. Redundant child masks are omitted
to avoid pinned bubblewrap mount-order failures.

On Linux, CLAUDE_CONFIG_DIR (default ~/.claude) must remain outside broad writable
project and readable tool directories. The pinned helper cannot reopen individual
session/auth files beneath a denied parent; root-deny and exact file grants protect
this separate account store instead. Overlap fails closed before launching Claude.

Development inherits a whitelist of host Git/gh/SSH config and credentials, model
transport and proxy values. NODE_OPTIONS and arbitrary environment secrets are not
forwarded. Claude may read allowlisted model auth/model transport variables from a
private regular `~/.claude/settings.json` (or CLAUDE_CONFIG_DIR); hooks and helper
commands in that file are never imported. Git/gh/SSH login remains the service user's
responsibility. Mail uses a separate environment and Codex home without developer
credentials. Native outbound networking is enabled; local test networking is checked
by synthetic acceptance. Sandbox failures stop execution and never request scope.

Native questions are declined with an instruction to write the question in the final
email and end the turn. The agent interprets merge/deployment confirmation in the next
mail itself. This mode deliberately removes all deterministic business-operation gates.
