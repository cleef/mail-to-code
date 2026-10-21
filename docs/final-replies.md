# Replies and questions

In assistant-final mode, each eligible completed native turn queues one immutable
final reply. Commentary/tool logs remain internal. In queue-mail mode, the primary
session calls queue_mail with key/text; reusing a key with different text fails.
There is no business authorization request field. Old schemas' request fields are
ignored for compatibility and create no authorization records. Old operation tools
return a retirement message. Questions and explicit authorization for each merge/deploy
action are ordinary prose interpreted by the agent from new email, with no
hashes/evidence gates. Both actions may be authorized in one new email; merge-only
approval does not authorize deployment.

Historical turns are not backfilled. Lost input acknowledgement is checked against
exact persisted input identity; a missing match stays ambiguous. A completed final
can be recovered once after restart; unfinished work never creates an automatic
continuation. Unknown send results are reconciled, never automatically resent.

## Image replies

Create PNG/JPEG in this task's notes/mail-images directory and reference
`![Preview](mail-images/preview.png)` in the final reply or queue_mail text. Total
image bytes are limited to 10 MiB. The adapter validates real content and dimensions,
rejects symlink/escape paths, freezes exact bytes and renders CID images. Invalid
images hold the mail with a diagnostic. Body, attachment and quote hashes ensure
transport integrity only; none authorizes a project operation. Frozen replies and
their original reply parent remain immutable after later input.
