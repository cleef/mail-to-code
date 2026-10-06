# Native final replies over mail

Use `engine: "async-cli"` with `asyncMailOutput: "assistant-final"`. Existing
installations without the output field retain queue-mail behavior; legacy rejects
assistant-final mode. Changing output mode requires a service restart.

Completed native `agentMessage` items with phase `final_answer` are authoritative.
Commentary, reasoning and tool logs are not sent. Older pinned CLI turns lacking
phase use only their terminal assistant item; a terminal native plan is supported.
There is no second model or notification draft. Multiple steered inputs share one
final reply. Empty/failed turns produce a held diagnostic, not fabricated success.

Delivery eligibility is recorded before dispatch, so historical answers are never
backfilled. Completed replies and immutable outbox snapshots are queued atomically
by conversation/root-turn and exact final item IDs. Duplicate native events,
acknowledgement loss, reconnection and restarts cannot queue another copy. Recovery
reads native history without rerunning user input; interrupted continuations keep
the original reply identity. Uncertain email sends use the existing RFC verifier,
never automatic resending.

## Confirmation tools and old threads

`request_confirmation({key,request})` prepares one exact scope/merge/deploy target
for the turn, using the same request shape as queue_mail. Explain its project,
revision, environment and prerequisite effects naturally in the final reply.
The request becomes usable only after that reply has a verified delivered RFC
identity. Natural-language explicit confirmation in its authenticated direct reply
is evidence; no fixed sentence or copying a complete hash is necessary. Generic
assent, silence and quoted instructions still grant nothing.

Existing threads retaining only `queue_mail` use its `request` field to prepare
the same binding. In assistant-final mode queue_mail's text is not sent separately;
write the user-facing reply as the native final message. Conflicting targets in
one turn are rejected. Prepared requests without delivered final replies cannot
authorize anything. Historical grants and mail snapshots remain unchanged.

Async sessions load only private `ASYNC_AGENTS.md` under the config directory.
`async-agent-guide init` creates it as 600 without overwriting edits. Manually
migrate useful project conventions; old AGENTS.md and WORKFLOW.md are preserved,
but this engine no longer loads their stage/analyzer/executor instructions.
Current guide and transport facts also reach resumed, steered and recovery turns.

## Safe execution evidence

`project_operation_status({project,operationId?})` returns this conversation's
uncertain effects and the latest 20 completed receipts, or one exact receipt.
Only an approved repository identity is accessible. Older threads use
project_command with executable `mail-to-code-operation`, cwd `.`, network false,
args `["status","{}"]` (or operationId in the JSON).

Deploy scripts may emit newline-delimited stage events on stdout:

```text
MAIL_TO_CODE_EVENT {"stage":"migration","status":"completed"}
MAIL_TO_CODE_EVENT {"stage":"worker","status":"failed"}
```

Only the bounded stage/status schema crosses the bridge. Invalid events and raw
stdout/stderr remain in `<dataDir>/effect-logs/<sha256-operation-id>/` as private
600 files in 700 directories. Failed deployment results preserve the verified
prerequisite receipts and known stages; unknown effects remain uncertain. Scripts
are responsible for keeping structured results non-sensitive. Shell credential
and network isolation is unchanged, including access to these raw logs.

The controller retains umask0077. Trusted project scripts must set explicit
permissions for public packages and service-account access. Do not change the
controller umask to make deployment work or chmod secrets as public files.

## Reviewed baseline and partial-failure reconciliation

Optional deployment `trustedScriptSha` selects an administrator-reviewed immutable
40-character baseline commit. Its configured value is part of the deployment
fingerprint. Without it, the original session base remains the trusted baseline.
The candidate script must still match that baseline and the approved commit must
remain clean. Changing the baseline/profile requires a new deployment confirmation.

For a failed deployment with independently verified partial effects, stop the
service and inspect every effect and remote process before invoking:

```sh
node dist/src/cli.js async-resolve-failed <feature-id> <operation-id> --evidence-file /private/path/resolution.json
```

The regular private JSON file (600, at most 64 KiB) contains `operationId`,
`project`, the **original** deployment `fingerprint`, `summary`, ISO `inspectedAt`,
`effects` (`partial` or `none`), `noEffectInFlight: true` and bounded non-sensitive
`evidence`. This operator-only CLI shares the controller lease. It preserves the
uncertain receipt in an audit record and records a terminal **failed** result;
it never declares deployment success, restores data, sends mail or retries.
Identical resolution calls and the original deploy request return that failed
result. Conflicting resolution evidence is rejected. Other uncertain project
writes remain blocked. Further deployment requires new exact-target confirmation.

Do not reset partially applied migration/switch/rollback attempts with
`--verified-no-effect`. Upgrade the reviewed controller manually, preserve live
history and databases, install private guide/config separately, resolve the old
attempt truthfully, and obtain fresh deployment confirmation. Controller upgrade
does not automatically deploy any project.

## Verification

Run `npm test`, then the synthetic real CLI checks `verify-final-mail.mjs` and
`verify-async-sandbox.mjs` on Linux with the pinned CLI. The former resumes an
old-tool thread and checks native final equality, one queued reply and zero real
mail/effects. The latter verifies real denial of credentials, raw effect logs and
native networking. Neither check sends email or performs a business deployment.
