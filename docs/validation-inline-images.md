# Inline-image reply validation

Validated on 2026-10-08 with Node 22.23.2 and the pinned Codex CLI 0.159.2.
All examples and runtime fixtures are synthetic.

## Automated contract checks

`npm test` completed the clean TypeScript build and **271/271 tests passed**.
The seven image tests cover:

- PNG/JPEG decoding, one/multiple images, Unicode filenames, escaped captions,
  relative and same-task absolute paths, literal code examples and plain mail.
- Missing/nonregular files, symlinks/hard links, traversal, external URLs,
  disguised/truncated formats, decoder dimensions and total 10 MiB limits.
- Import into immutable private artifacts, source changes after queuing,
  repeated queue keys, frozen-body/hash/confirmation/parent immutability.
- Native final eligibility, commentary exclusion, historical-answer exclusion,
  held invalid replies, event replay and reopened database deduplication.
- Synthetic raw MIME composed from the captured official-tool payload:
  multipart/related with multipart/alternative, CID HTML, exact PNG/JPEG bytes,
  recipient/RFC/thread identity, names/hashes and declared MIME-type rejection.
- Frozen-file modification blocks the bridge before a send attempt and blocks
  the transport before its send RPC. Undelivered image confirmations grant nothing.

Existing engine tests continue to cover uncertain delivery without automatic
resending, scopes, controller protection, old-thread recovery and approval rules.

## Real Linux and native-thread checks

`node scripts/verify-async-sandbox.mjs` passed on Linux with the pinned CLI:
task image-directory writes succeed; frozen images (including files created
after policy generation), mailbox credentials, databases, other task state,
Git metadata and effect logs are denied. Original/linked checkouts remain
read-only, native networking is denied, the command adapter matches the policy,
and a real app-server thread starts.

The pinned Linux mount helper cannot mount a denied dataDir parent around nested
writable task roots reliably. Artifacts are therefore created and masked directly
before native session startup, while existing database, credential and task masks
remain in force. The real probe verifies this behavior.

`node scripts/verify-final-mail.mjs` passed using a real historical old-tool
thread resumed through the bridge. Native tools copied a supplied visible
640×360 PNG into the task image directory. The result was:

- Same Codex thread; original native final text preserved.
- One queued mail with one CID image and the exact frozen content hash.
- One prepared scope confirmation bound to that mail, with existing grants intact.
- One synthetic read-only inspection; no business writes or historical replies.
- One mail after restarting/resuming; no duplicate final reply.
- Zero real mailbox sends, merges or deployments.

The supplied image is read-only fixture data; native tools perform the copy.
The run explicitly exercises queue_mail's retained confirmation field in the
old thread without adding dynamic tools.

## Production acceptance remains pending

No production build, output setting or OAuth credentials were changed by these
checks. Review/merge and manual upgrade come first. Then reply in the original
image-test thread and verify actual plugin delivery, QQ inline display, saved
image bytes, RFC identity and same-thread continuation. Follow the
[rollout checklist](final-replies.md#reviewed-rollout); finish authorized OAuth
cleanup only after that real acceptance passes.
