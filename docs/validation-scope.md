# Cross-repository scope continuation

The executor receives canonical project IDs, Git identities, relative directories,
execution roles, the current project and completion facts. It returns `scopeDecision`
with one of `within_approved_scope`, `propose_scope_change` or `need_context`, a reason,
structured repository requests and any concrete missing-human-fact questions.

Known requests copy `projectId` and `identity` and use `path: null`. New requests
use null IDs and an in-root relative directory clue. Roles use `modify`, `reference`
and `product_record`; evidence-only targets are distinguished from normal model
write targets that also collect product evidence. The controller checks identity,
role and result consistency, never description strings or command words.

A legacy `requestedProjects` array or an inconsistent scope result gets one
read-only Codex interpretation. That call cannot alter the executor's completion
outcome or questions. Valid normalized output is not interpreted a second time.
Invalid repair becomes an internal failed execution, preserves work, and does not
produce a new START or human question. Genuine scope changes retain worktrees,
queue read-only planning and require a new bound START before wider access.

Scope-change facts are carried separately from prose through the planning job,
outcome interpretation and new outbound snapshot. Plan emails therefore display
specific role/repository changes, the reason and impact even if a generated brief
omits them. Existing pending/sent presentation snapshots remain immutable.

## Verification

Verified locally with Node 22.23.0 and Codex CLI 0.159.0: the complete suite
passed 188/188, and real Codex synthetic acceptance passed 9/9. See the
[synthetic acceptance report](acceptance-scope.json). Actual mail sends and
business operations were both zero.

Use Node 22.13+ (22.x):

```sh
npm test
node scripts/verify-scope.mjs
```

The real Codex script creates only private temporary synthetic state. Mail,
Git/PR, merge and deployment adapters are prohibited. A simulated code result
is fixture data, never a claim that business implementation was executed.

Coverage includes:

- Three approved repositories continue under one START, including natural-language
  legacy handoffs and product-evidence work; no planning reset or duplicate START.
- Valid new scope output, identity repair, a new repository, read-to-write expansion,
  mixed existing/new requests and missing human-only facts.
- Real `needs_input` remains blocked; scope interpretation cannot mark it complete.
  When scope also changes, its unfinished facts and questions accompany read-only planning.
- A same-version confirmed design stays confirmed despite an old document label.
- A concrete short START reply binds only its current version; duplicate receipt
  does not replay it or grant merge/deployment authority.
- Old sent and pending snapshots survive the new renderer. A genuine change's new
  confirmation includes its actual differences. Invalid scope fails internally.
- Existing baseline/configuration/stage guards and uncertain-effect recovery remain
  covered by the complete suite; historical approval is never restored or replayed.

No database migration or edited-private-guide replacement is introduced. This
change does not repair live task state automatically. Manual PR review/merge and
an independently authorized controller upgrade remain required.
