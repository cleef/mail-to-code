# Gmail plugin migration validation

The transport is validated against Node 22.23.2, Codex CLI 0.159.2 and official
Gmail plugin 0.1.10. Changing either protocol version requires another server
capability and delivery check.

- A dedicated server ChatGPT login exposed official Gmail. Direct app-server
  calls verified the configured identity without a model turn.
- Search pagination returned immutable `message_ids`; the terminal
  `next_page_token` is `null`. A real raw read retained authentication headers,
  From/To, RFC Message-ID, provider thread and labels.
- An owner-only reply verified actual sender, recipient, thread and In-Reply-To.
  The plugin appends quoted parent text; the new verifier checked it against a
  frozen parent digest separately from the immutable new reply.
- A real multipart reply used synthetic fixtures only. HTML, a CID image and an
  ordinary attachment were retained; delivered content hashes and the actual
  RFC identity passed the same controller verifier. Its private test outbox was
  persisted before sending. No project work, merge or deployment was authorized.
- A private consistent copy of both production databases retained the async
  `started_at` baseline. Rehearsal found an unresolved deployment record and
  correctly blocked state migration. Production data and services were unchanged.
  That outcome is a cutover prerequisite, not a completed production migration.

The automated suite covers pagination and repeated tokens, overlap/daily scans,
long downtime, interrupted scans, missing raw fields/RFC identity, uncertainty
without resend, immutable reply/attachment evidence, historical mail/context
preservation and isolated account credentials. Migration fixtures verify both
SQLite backups, idempotence, unchanged approvals/outbox and no OAuth copies.

Production acceptance still requires a reviewed merge, an idle stop point with
all uncertain effects reconciled, private-copy migration without blockers,
service cutover, a real owner request/reply, and old OAuth credential/grant cleanup.
Do not describe a successful profile or preflight test as completed cutover.
