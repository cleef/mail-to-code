# Configured async project checks

`project_checks({project, action: "inspect" | "run"})` is shared by Codex and
Claude Code. It requires the primary task session and an approved writable
repository with a prepared worktree. Inspection reports required commands,
environment variable names (not values), images, services, readiness issues and
missing/stale receipts. Running executes configured installation, build and test
steps, including repository-level `checks`, and returns `checkIds` for
`project_pr`. A failure returns to the same session without removing scope,
creating mail or authorizing another effect.

Old persistent sessions use the existing tool without changing thread/history:

```json
{"project":"sample","executable":"mail-to-code-checks","args":["inspect"],"cwd":".","network":false}
```

Use `args: ["run"]` to execute. This reserved entry never starts an arbitrary
shell command. Current capability instructions are included with new inputs,
steered turns and recovery turns, so older capability notes do not block access.

## Configuration and isolation

Use the existing private profile fields: `install`, `build`, `checks`, `image`,
`services`, command `env` and `packageSources`. Repository-level checks join the
required set with an empty environment. Identical commands/environments are
deduplicated; the same command with different environments remains two checks.
Configuration is validated before execution, including private profiles and
repository-level commands. Credentials never belong in command environments;
service accounts/data must be synthetic.

Source is copied into `<dataDir>/artifacts/checks/run-*/workspace`, which native
model commands cannot access. Only tracked/nonignored source files and allowed
`node_modules` under source directories are included. Git metadata, conventional
secret/config files, ignored runtime files and `.run`/`.release` state are
excluded. Outside, missing or excluded symlink targets and submodules are
rejected. Safe internal links are relocated into the copy. Dependency trees
are rechecked for protected files and escaping links after installation.

Install steps run in the OS sandbox with only the copied workspace and its
private temporary directory writable. They use the package-source proxy
allowlist. Prefer `npm ci`; installation must not rewrite existing source or
lock files. No install/build output is copied back into the approved worktree.
Native checks retain the disabled network policy.

With `image` configured, checks run in a fresh Podman Pod using that image;
`services` require an image. Test containers have a read-only root, dropped
capabilities, no privilege escalation and only the sanitized workspace mounted.
The Pod has no external network, published ports or host networking. Services
and tests communicate through their private loopback, such as `127.0.0.1:3306`.
The controller passes each step's configured environment. Database services have
no workspace mount. Images are digest-pinned and must already exist locally;
test execution uses `--pull=never`. Service health is checked before commands.
Pods, containers and their anonymous volumes are removed on exit, failure,
timeout or cancellation. Copied files and temporary caches are removed; private
step diagnostics remain under the run directory. An abrupt host/process kill
can leave owned test resources for operator inspection and cleanup.

The container path requires Linux, working Podman **4.3+**, cgroups and prepared
images. This avoids older Podman releases that implicitly pull an infrastructure
image. `inspect` and `async-doctor` check configuration, Podman metadata and local
image availability without creating containers. Actual namespace, service and
browser compatibility must pass the real acceptance below. Runtime failures do
not enable another execution mode or expand the native sandbox.

For example, a generic test wrapper that accepts connection JSON can use command
`env: {"TEST_DB_CONFIG":"{\"host\":\"127.0.0.1\",\"user\":\"root\",\"password\":\"\"}"}`,
with a disposable MySQL service configured for an empty synthetic password.
Use that project's documented variable name. Set `image` and each service image
to the actual reviewed local `registry.example.test/name@sha256:<64 hex digits>`;
never copy placeholder image references into active configuration. Browser tests
also need matching browser binaries and libraries in their test image.

## Receipts and PR diagnostics

Receipts bind the conversation, repository, exact command/arguments/directory,
environment, source bytes and effective configuration fingerprint. The
fingerprint includes install steps, runtimes, test images/services and package
sources. Source changes during copying, in the test copy or in the approved
worktree invalidate success. Each run preserves an attempt record. A failed
rerun replaces the current success for its required commands.

Plain `project_command` receipts can satisfy only matching native checks with
no configured container/service/environment and no package-network permission.
Configured environments and services require `project_checks`. Historical
receipts without a fingerprint remain stored but require fresh verification.

`project_pr` retains `CURRENT_SOURCE_CHECK_RECEIPTS_REQUIRED` and
`REQUIRED_CHECKS_NOT_PASSED`, with structured `missing` details. Reasons include
`not_executed`, `failed`, `source_changed`, `configuration_changed` and
`required_checks_not_configured`. Rejections happen before commit/push/PR effects.
No database schema migration or historical approval/mail rewrite is performed.

## Verification and manual rollout

Run `npm test` with Node 22.x. The unit suite exercises both executor identities,
the old-session entry, source/credential/link isolation, command environments,
service health/cleanup, readiness and PR fencing. Its mocked Podman calls do not
prove real container isolation.

On a Linux test host, prepare matching Playwright and MySQL images and supply
their local repository digests:

```sh
CHECKS_BROWSER_IMAGE='registry.example.test/browser@sha256:ACTUAL_DIGEST' \
CHECKS_MYSQL_IMAGE='registry.example.test/mysql@sha256:ACTUAL_DIGEST' \
node scripts/verify-project-checks.mjs
```

The script requires the pinned Codex CLI but starts no model turns. It runs real
sandboxed npm installation, a MySQL service and Chromium: an intentional failed
test must produce no successful receipts, a fix must pass, the rendered page
must contain database data, host files/loopback must stay inaccessible, and a
later source edit must fence PR submission. It calls the native tool and the
compatibility entry under both task executor identities; actual model discovery
in an already-running session remains a release acceptance check. All mail and
GitHub mutations are disabled in the fixture. CI runs this separately from unit
tests and reports the resolved image digests.

Review the controller PR before merging/upgrading. Preserve runtime state,
sessions, worktrees and edited private guides. Prepare per-project private
profiles and images, check readiness under the service account, then validate
real service health and browser execution. After a manual upgrade, resume the
original task and rerun its required checks before PR submission. Merge,
deployment and release acceptance remain separate human decisions.
