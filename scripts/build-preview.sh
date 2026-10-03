#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
podman build -t "${1:-localhost/mail-to-code-preview:1.63.0}" -f "$task_root/preview/Containerfile" "$task_root/preview"
