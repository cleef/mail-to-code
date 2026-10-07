#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null
task_node="$(command -v node)"
task_config="${MAIL_TO_CODE_CONFIG_DIR:-$HOME/.config/mail-to-code}"
mkdir -p "$HOME/.config/systemd/user" "$task_config" "$HOME/.local/share/mail-to-code"
chmod 700 "$task_config" "$HOME/.local/share/mail-to-code"
[[ "$task_root$task_node$task_config" != *[[:space:]]* ]] || { echo "Installation paths must not contain whitespace"; exit 1; }
# Keep the operator's edited standalone guide across installations/upgrades.
if [[ ! -e "$task_config/AGENTS.md" ]]; then
  (umask 077; set -o noclobber; cat "$task_root/config-templates/AGENTS.md" > "$task_config/AGENTS.md")
fi
"$task_node" "$task_root/dist/src/cli.js" workflow-guide init
"$task_node" "$task_root/dist/src/cli.js" async-agent-guide init
cat > "$HOME/.config/systemd/user/mail-to-code.service" <<UNIT
[Unit]
Description=Email driven Codex development controller
After=network-online.target
ConditionPathExists=$task_config/config.json

[Service]
Type=simple
WorkingDirectory=$task_root
ExecStart=$task_node $task_root/dist/src/cli.js serve
Environment=MAIL_TO_CODE_CONFIG_DIR=$task_config
Environment=PATH=/usr/local/bin:/usr/bin:/bin
UMask=0077
Restart=on-failure
RestartSec=30
TimeoutStopSec=20
KillMode=control-group

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable mail-to-code.service
printf '%s\n' 'User service installed. Run mail-connect and doctor before starting.'
