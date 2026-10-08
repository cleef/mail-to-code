# Configuration

`config-templates/example.json` is a minimal template, without predefined repositories or deployment permissions. All paths, aliases and commands below are illustrative.

Templates are kept separate from active configuration in `~/.config/mail-to-code/`.
`init` creates `config.json` and initializes the private `AGENTS.md` and `WORKFLOW.md`
without overwriting edited guides. The official Gmail plugin uses an independent
Codex home at `<configDir>/codex-mail/`, configurable with `mailCodexHome`. Run
`mail-connect` on the service host to log in and connect Gmail via `/plugins`.
Development keeps its existing Codex configuration and API key. Keep credentials
outside the checkout. See the [README setup guide](../README.md#setup) for file
roles, permissions and plugin connection steps.

For automatic async replies set `engine: "async-cli"` and explicitly set
`asyncMailOutput: "assistant-final"`, then restart the service. New installs
already use this output mode; an existing config that omits it still uses
`queue-mail`. Switching output mode does not backfill historical final answers.
The bridge adds the current task's writable `notes/mail-images/` directory and
image rules to each new, resumed and recovery turn, including older Codex threads.
The frozen `<dataDir>/artifacts/mail-images/` copies and mailbox credentials remain
unavailable to native tools. Edited private guides are never overwritten.

```json
{
  "gmailAddress": "agent@gmail.com",
  "ownerAddress": "owner@example.com",
  "projectsRoot": "~/projects",
  "productDocs": "~/projects/documentation",
  "repositories": {
    "sample": {"path": "~/projects/sample", "github": "example-org/sample", "baseBranch": "main"}
  },
  "profiles": {
    "sample": {
      "kind": "generic",
      "runtime": ["node"],
      "install": [{"executable": "npm", "args": ["ci"], "cwd": "."}],
      "build": [{"executable": "npm", "args": ["run", "build"], "cwd": "."}],
      "checks": [{"executable": "npm", "args": ["test"], "cwd": "."}],
      "preview": {"kind": "static", "mounts": [{"source": "dist", "destination": "."}], "paths": ["/"]}
    }
  }
}
```

Profiles describe install/build/check steps, runtimes, package sources, preview mounts, routes, synthetic fixtures and optional pinned test containers. Commands run inside the approved worktree and sandbox. Declare generated tracked files in `generatedFiles` if a deployment build must restore those outputs before verifying the exact approved source commit. Undeclared changes fail deployment.

Profiles are inferred from immutable default-branch snapshots, or supplied explicitly in the private configuration. Explicit profiles are not overwritten by model proposals. Changed configuration requires fresh approval. The configured product document repository uses Markdown validation and is merged last when recording product evidence.

Deployment is disabled by default. To enable it, configure a trusted repository-relative script, host, domain, remoteBase, healthPaths and argument list. Arguments may contain `{commit}`, `{release}`, `{host}`, `{domain}` and `{remoteBase}` placeholders. The script must match the original trusted baseline. Deployment still needs a separate latest confirmation.

Async installations may add private `repositories.<project>.operations` and
ordered `deployment.preDeployOperations`. These use trusted external scripts,
not ordinary build profiles or arbitrary model shell commands. See
[controlled operations](controlled-operations.md) for configuration, authorization,
script results, existing-thread compatibility and uncertain-effect recovery.

`controllerRepository` is inferred from the installation's GitHub origin unless explicitly supplied. `protectedRepositories` can preserve manual-only controller identities during transitions. Credentials must never appear in profiles or guides.
