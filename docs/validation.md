# Validation

Run npm test under Node 22.13+ 22.x. Unit/integration fixtures are synthetic and
cover authenticated identity, mail/RFC deduplication, immutable replies and images,
uncertain sends/input acknowledgements, retained sessions, retired tools, fresh
native contracts, interrupted work waiting for mail, and separate mail/development
environments. Old gateway-only checks/tests/scripts were removed with their modules.

Run the matching-version real acceptance separately:

```sh
node scripts/verify-async-sandbox.mjs
node scripts/verify-async-cli.mjs
node scripts/verify-claude-cli.mjs
```

The sandbox script probes both the direct Codex boundary and the exact whole-process
Claude launch path with synthetic child code: project/Git writes, controlled local
network, developer login configuration, forbidden mail/state/foreign task/outside
writes. Model acceptance exercises native tools and original session continuity
using synthetic projects and no real mailbox, PR, merge or deploy. Both binaries
must match the pinned version. These checks are not part of routine npm test because
they require host sandbox support and (for model turns) authenticated model access.
Missing runtime support is reported, not replaced by mocks. Actual mail delivery
still requires separate owner-mail acceptance.

Record results, platform, exact versions and any missing runtime in the PR and
[validation-native-passthrough.md](validation-native-passthrough.md).
