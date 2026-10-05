# Controlled operations

The `async-cli` engine can run administrator-configured production operations.
Codex chooses an operation; the controller runs its trusted script outside the
model sandbox. Scripts can use SSH or another transport. Native model commands
still have no network or production credentials. This is a fixed-operation
interface, not a remote terminal.

## Private configuration

Configure operations under the existing repository entry in your private
`config.json`. Nothing is enabled for other repositories or installations.
The following fragment is synthetic; scripts and SSH setup are yours:

```json
{
  "engine": "async-cli",
  "repositories": {
    "sample": {
      "path": "/home/operator/projects/sample",
      "github": "example-org/sample",
      "operations": {
        "inspect": {
          "description": "Inspect the staging service",
          "target": "sample-staging",
          "effect": "read",
          "script": "/home/operator/.config/mail-to-code/operations/inspect.py",
          "args": ["ops@server.example.test"],
          "timeoutSeconds": 30
        },
        "backup": {
          "description": "Create and verify a new application backup",
          "target": "sample-staging",
          "effect": "write",
          "script": "/home/operator/.config/mail-to-code/operations/backup.sh",
          "args": [],
          "timeoutSeconds": 1800,
          "reconcileScript": "/home/operator/.config/mail-to-code/operations/verify-backup.sh"
        }
      },
      "deployment": {
        "enabled": true,
        "host": "ops@server.example.test",
        "domain": "app.example.test",
        "remoteBase": "/srv/sample",
        "script": "scripts/deploy.sh",
        "args": ["{release}"],
        "preDeployOperations": ["backup"]
      }
    }
  }
}
```

Operation IDs use lowercase letters, digits, `_` and `-`, starting with a letter.
`description`, `target`, `effect` and absolute `script` are required. Arguments
are fixed by the administrator; the default timeout is 1800 seconds, maximum
3600. `reconcileScript` is optional and uses the same fixed arguments.
`preDeployOperations` is ordered and cannot contain missing or duplicate IDs.
Legacy installations without operations retain their behavior; configuring this
capability with `engine: legacy` is rejected explicitly.

Install scripts outside project checkouts and feature worktrees. Use private
executable files (`700`) in an administrator-owned directory without group or
other write permission. Entry-point symlinks and scripts owned by unrelated users
are rejected. Script directories and operation locks are masked from model shell
commands, including the package-command sandbox. Prefer a standalone script;
protect every configuration file, dependency and remote helper it trusts too.
Do not put credentials in arguments or guides. Scripts run with the controller's
core shell environment, proxy settings and optional SSH agent socket; Gmail and
GitHub token environment variables are not forwarded. Administrator scripts are
trusted code and can access the controller account's files. `effect: read` is the
administrator's declaration of behavior, not shell-command classification.

`examples/operations/ssh-inspect.py` demonstrates a fixed, read-only SSH operation.
Copy it to a private location, review its target, then set mode `700`. No example
implements an application-specific backup or includes real installation data.
Run `async-doctor` after configuring scripts; it verifies them without invoking
production operations. Do not add operations to an older controller's active
configuration before its reviewed upgrade.

## Tools and authorization

`project_operations({project})` returns configured IDs, descriptions, targets,
effects and fingerprints. It omits script paths and fixed arguments.
`project_operation({project,operation,key,sourceMailId?,evidence?})` executes one
operation. Both require the primary Codex thread, an approved writable project
scope and unchanged GitHub repository identity; no prepared worktree is required.
Reference-only source access does not grant production access.

Reads need no additional mail approval. Writes require explicit intent in an
authenticated new mail body belonging to the same conversation. Codex interprets
that intent and quotes it using `sourceMailId`/`evidence`; the controller checks
identity, evidence membership and binding. Recommendations, quoted history and
generic assent are not authority. One source-mail/operation authorization binds
one key and one target/configuration fingerprint. Reuse that key for retries;
changing keys or configuration needs new authorization. Keys contain letters,
digits, `:`, `.`, `_` and `-`, starting with a letter or digit, at most 200 characters.
Results never count as build/test receipts for `project_pr`.

Codex 0.159.2 cannot add dynamic tools when resuming an old thread. Existing
threads retain their IDs/history and use the same adapter via `project_command`:

```json
{"project":"sample","executable":"mail-to-code-operation","args":["list","{}"],"cwd":".","network":false}
```

For execution, use `args: ["run", JSON.stringify({operation,key,sourceMailId,evidence})]`.
The controller parses this reserved entry strictly; it never executes a shell
command. New threads receive the native tools. Updated developer instructions
explain the compatibility entry without replaying email or restoring approvals.

## Script contract

Exit zero and emit exactly one JSON object to stdout:

```json
{"ok":true,"summary":"Backup verified","evidence":{"backupPath":"/srv/backups/example","completed":"2026-01-01T00:00:00Z","databaseSha256":"synthetic-checksum","fileCount":4}}
```

`ok`, `summary` and `evidence` are required; extra top-level keys are rejected.
Evidence values are strings, finite numbers, booleans or null. Output is limited
to 64 KiB, summary/evidence strings to 4000 characters, and evidence to 100 fields.
Scripts must emit only nonsecret results. The controller cannot identify secrets
hidden inside administrator-provided prose. Raw stdout/stderr from failed or
invalid executions is never returned to Codex or persisted as an operation result.
Use stderr for private process diagnostics; it is not returned by this interface.

The controller provides three environment variables:

- `MAIL_TO_CODE_OPERATION_ID`: stable receipt identity; hash it before constructing paths.
- `MAIL_TO_CODE_OPERATION_TARGET`: configured target label.
- `MAIL_TO_CODE_OPERATION_FINGERPRINT`: bound script/configuration fingerprint.

Scripts should store durable receipts under that identity. A reconciliation script
receives the same variables/arguments. It must independently check that the exact
operation completed, and return `ok: true` only for a verified successful result;
`ok: false` leaves the outcome uncertain. Reconciliation must be read-only.
Use `ok: false` from the normal script only for a conclusively completed failure.
Exit nonzero when the effect's outcome is unknown. SSH disconnection or local
cancellation does not prove that a remote operation stopped.

## Deployment and recovery

Exact deployment authorization includes ordered prerequisites, their definitions,
script contents and optional reconciliation script contents. A change invalidates
that deployment confirmation. Installations without prerequisites retain their
existing deployment authorization shape.

After the build and trusted deployment-script check, prerequisites run in order.
A failed prerequisite prevents the deployment script from running. Every new
deployment attempt creates new prerequisite operation identities, including an
operator-reset retry of the same deployment request. Successful standalone backup
receipts are not substituted for new deployment prerequisites.

Same-project operations/deployments serialize across feature conversations and
use a cross-process lease. Different projects have independent locks. Uncertain
writes block new writes/deployments for the project; inspection remains available.
Duplicates return their completed receipts without executing again. A running or
uncertain effect is never automatically retried.

Inspect private state with `async-status`. After checking the remote receipt,
run `async-reconcile <feature-id> <operation-id>` while the service is stopped.
The configured reconciler may confirm completion. With no reconciler, or a changed
script/configuration, human inspection is required. Only after independently
proving that no effect occurred may the operator use `--verified-no-effect` to
reset the operation; this audits the old record and never executes anything.
A failed deployment may also need its separate operation reset after confirming
that the deployment script did not run. Neither an upgrade nor reconciliation
automatically restarts a business deployment.
