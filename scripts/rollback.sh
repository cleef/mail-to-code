#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_ref="${1:?Usage: rollback.sh known-good-compatible-ref}"
[[ -z "$(git -C "$task_root" status --porcelain)" ]] || { echo 'Checkout contains local changes; inspect first'; exit 1; }
git -C "$task_root" rev-parse --verify "$task_ref^{commit}" >/dev/null
systemctl --user stop mail-to-code.service
cd "$task_root"
# Never put old code against the live v2 database. Offline v1 backup restoration
# requires explicit inspection of all external effects/outbox after the snapshot.
task_schema="$(node dist/src/cli.js migration-status)"
if [[ "$task_schema" == *'"schema":"7"'* ]]; then
  git show "$task_ref:src/store.ts" | grep -Fq "'1','2','3','4','5','6','7'" || { echo 'Blocked: selected code cannot handle v7 semantic decisions. Audit external effects before restoring any backup.'; exit 1; }
elif [[ "$task_schema" == *'"schema":"6"'* ]]; then
  git show "$task_ref:src/store.ts" | grep -Fq "'1','2','3','4','5','6'" || { echo 'Blocked: selected code cannot handle v6 multi-item replies. Audit external effects before restoring any backup.'; exit 1; }
elif [[ "$task_schema" == *'"schema":"5"'* ]]; then
  git show "$task_ref:src/store.ts" | grep -Fq "'1','2','3','4','5'" || { echo 'Blocked: selected code cannot handle v5 stage workflows. Audit external effects before restoring any backup.'; exit 1; }
elif [[ "$task_schema" == *'"schema":"4"'* ]]; then
  git show "$task_ref:src/store.ts" | grep -Fq "'1','2','3','4'" || { echo 'Blocked: selected code cannot handle v4 reply jobs. Never restore a backup without auditing external effects.'; exit 1; }
elif [[ "$task_schema" == *'"schema":"3"'* ]]; then
  git show "$task_ref:src/store.ts" | grep -q "'1','2','3'" || { echo 'Blocked: selected code cannot read v3 SQLite. Inspect a stopped backup offline before any downgrade.'; exit 1; }
elif [[ "$task_schema" == *'"schema":"2"'* ]]; then
  git show "$task_ref:src/projects.ts" >/dev/null 2>&1 || { echo 'Blocked: selected code does not support v2 SQLite. Use a compatible v2 ref, or audit a stopped v1 snapshot offline.'; exit 1; }
fi
git switch --detach "$task_ref"
npm ci
npm test
node dist/src/cli.js doctor
systemctl --user start mail-to-code.service
