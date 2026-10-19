# Configuration

Public templates are synthetic. Active configuration, mail login, native histories
and runtime SQLite stay outside the checkout. Private directories use 700, files 600.
`MAIL_TO_CODE_CONFIG_DIR` selects the configuration directory. `init` and guide init
use exclusive creation and preserve existing edited guides.

| Field | Native adapter behavior |
| --- | --- |
| engine | async-cli |
| asyncMailOutput | assistant-final (new installs), or queue-mail |
| projectsRoot | Writable discovery root, default ~/projects |
| repositories | Explicit additional writable paths; GitHub, checks, operations and deployment definitions are reference facts only |
| productDocs | Optional additional writable product records root |
| profiles | Existing build/test/service configuration as reference, no automatic execution or checks receipt gate |
| dataDir | Preserve existing runtime data path |
| codexCommand / claudeCommand | Pinned CLI paths; default codex / claude through service PATH |
| gmailAddress / ownerAddress | Different mailbox addresses; authenticated owner input only |
| mailCodexHome | Independent Gmail login, default configDir/codex-mail |
| pollSeconds / timeoutSeconds | Polling/turn limits |
| githubTokenFile | Deprecated compatibility field; never loaded, masked from agents |
| controllerRepository / protectedRepositories | Historical context only, no gateway authorization |
| previewEnabled / screenshotImage | Legacy context only; agent runs its own preview/checks |

Native Git, gh and SSH reuse the selected service user's login and configuration,
including GH_TOKEN/GITHUB_TOKEN when supplied to development. The mail environment
excludes them. Deploy settings do not automatically trigger prerequisites or deployment.
Agent-interpreted confirmation is still required. Credentials belong in host auth
stores/environment, not repository examples or profile command arguments.
