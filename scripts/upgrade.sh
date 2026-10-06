#!/usr/bin/env bash
set -euo pipefail
# This command is run manually by the operator, never by an email task.
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_ref="${1:?Usage: upgrade.sh reviewed-git-ref}"
[[ -z "$(git -C "$task_root" status --porcelain)" ]] || { echo 'Checkout has local changes; inspect first'; exit 1; }
git -C "$task_root" rev-parse --verify "$task_ref^{commit}" >/dev/null
systemctl --user stop mail-to-code.service
cd "$task_root"
node scripts/backup.mjs "$task_ref"
git switch --detach "$task_ref"
npm ci
npm test
node dist/src/cli.js agent-guide init
node dist/src/cli.js async-agent-guide init
node dist/src/cli.js workflow-guide init
node dist/src/cli.js migrate
node dist/src/cli.js mail-links backfill
node dist/src/cli.js doctor
node scripts/sandbox-probe.mjs
node scripts/verify-reply.mjs --permissions
./scripts/build-preview.sh
systemctl --user start mail-to-code.service
systemctl --user is-active mail-to-code.service
