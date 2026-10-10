# Native final replies over mail

Use `engine: "async-cli"` with `asyncMailOutput: "assistant-final"`. Existing
installations without the output field retain queue-mail behavior; legacy rejects
assistant-final mode. Changing output mode requires a service restart.

Completed native `agentMessage` items with phase `final_answer` are authoritative.
Claude Code's adapter normalizes its successful terminal result into this same
final-message contract. New tasks add a frozen executor label to rendered MIME,
while preserving the native final text verbatim in the outbox audit record.
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

## Image replies

Each async task has its own writable directory:
`<dataDir>/async-cli/features/<feature-id>/notes/mail-images/`. Generate an image
there or copy an existing screenshot into it, then use Markdown:

```md
![Preview](mail-images/preview.png)
![Second view](<mail-images/second view.jpg>)
```

PNG, JPG and JPEG extensions must match a decodable PNG or JPEG. All images
together may occupy at most **10 MiB**. PNG decoding is limited to 16 megapixels
and 16,384 pixels per dimension; JPEG decoding is limited to 16 megapixels and
bounded decoder memory. A safe absolute path inside the same image directory is
accepted for older threads; relative references are preferred. Missing files,
symlinks, hard links, path traversal, other tasks' files, disguised formats and
external/data URLs are rejected. References inside backtick code examples are
literal examples, not attachments. Arbitrary HTML and unrelated file attachments
are not supported by this convention.

Both native final replies and queue_mail text use the same importer. No additional
dynamic tool is required by older threads. The original final wording remains
stored for audit. The queued snapshot separately freezes plain text (image caption
and filename), escaped HTML with `cid:` references, image filenames, types and
SHA-256 hashes. Server paths are removed from rendered image references.
Controller-owned artifacts are copied as private read-only files before queuing;
native tools cannot read or modify them. MIME delivery uses multipart/alternative
inside multipart/related, so the HTML displays the image and the mail client can
save its MIME part.

Invalid images create a held diagnostic rather than a partial or fabricated
email. Inspect `async-status` for conversation errors, outbox `lastError` and image
metadata/hashes;
`doctor` includes `heldReplies`. Correct the file and request a **new** reply
in the original mail thread; duplicate events and restarts do not retry a held
final answer. Once queued, body, images, confirmation target and reply-parent
message selection cannot be changed. A changed frozen file blocks sending.
Actual sent raw MIME must match the recipient, thread, RFC reply parent, text,
CID references, declared image types, filenames and hashes before a confirmation
can be used. An unclear send remains uncertain and is never automatically resent.

### Reviewed rollout

1. Review and merge the feature PR manually. Prepare the reviewed build, check
   active turns, queued mail and uncertain effects, then stop at an idle point.
2. Back up both SQLite databases consistently (including WAL state), private
   configuration and required recovery files. Keep current dataDir, worktrees,
   artifacts and development Codex history.
3. Install the reviewed build. Explicitly set `asyncMailOutput: "assistant-final"`
   in the private config and restart the single controller. Do not overwrite
   edited guides or regenerate old mail/approval snapshots.
4. Reply to the original image-test thread and request a visibly colored 640×360
   PNG. Verify same-thread continuation, automatic final mail, inline display and
   image saving in the owner's actual mail client. Read the sent raw MIME and
   compare its verified RFC identity and image hash with the queued snapshot.
5. Only after actual reply and continuation acceptance, finish the separately
   authorized old OAuth cleanup. Until then retain those files; never restore
   the retired transport, restore old SQLite state or replay old final answers.

Synthetic tests establish the controller/MIME contract; they do not establish
the actual client's rendering or the official plugin's production delivery.

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
old-tool thread and checks native final equality, one queued reply, a frozen
640×360 PNG with CID HTML and zero real mail/effects. The latter verifies real
image-directory writes and denial of frozen artifacts, credentials, raw effect
logs and native networking. Neither check sends email or performs a business deployment.

See the [recorded image validation and remaining acceptance](validation-inline-images.md).
