#!/usr/bin/env bash
set -euo pipefail
# Recovery selects another reviewed plugin-only build; it never restores a DB.
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_ref="${1:?Usage: rollback.sh reviewed-compatible-plugin-ref}"
[[ -z "$(git -C "$task_root" status --porcelain)" ]] || { echo 'Checkout has changes; inspect first'; exit 1; }
git -C "$task_root" cat-file -e "$task_ref:src/mail-transport.ts"
git -C "$task_root" cat-file -e "$task_ref:src/mail-migration.ts"
if git -C "$task_root" cat-file -e "$task_ref:src/oauth.ts" 2>/dev/null; then
  echo 'Blocked: recovery cannot restore the retired OAuth transport'; exit 1
fi
echo 'Audit current inbox, outbox, effects, database and build compatibility before running this operator recovery command.'
systemctl --user stop mail-to-code.service
git -C "$task_root" switch --detach "$task_ref"
cd "$task_root"
npm ci
npm test
node dist/src/cli.js doctor
systemctl --user start mail-to-code.service
