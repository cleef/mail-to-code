# Configuration

`config/example.json` is a minimal template, without predefined repositories or deployment permissions. All paths, aliases and commands below are illustrative.

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

`controllerRepository` is inferred from the installation's GitHub origin unless explicitly supplied. `protectedRepositories` can preserve manual-only controller identities during transitions. Credentials must never appear in profiles or guides.
