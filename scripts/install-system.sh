#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" = 0 ]] || { echo 'Run as root'; exit 1; }
task_user="${1:?Usage: install-system.sh service-user}"
if ! command -v podman >/dev/null; then
  if command -v dnf >/dev/null; then
    task_dnf_args=()
    # CentOS Stream's preinstalled SELinux extra packages need matching CRB
    # updates. Keep package protection and SELinux enabled.
    if rpm -q selinux-policy-extra >/dev/null 2>&1; then task_dnf_args+=(--enablerepo=crb); fi
    if [[ -n "${MAIL_TO_CODE_CENTOS_MIRROR:-}" ]]; then
      task_dnf_args+=(--disablerepo='*' --enablerepo=baseos --enablerepo=appstream --enablerepo=crb
        "--setopt=baseos.baseurl=$MAIL_TO_CODE_CENTOS_MIRROR/10-stream/BaseOS/$(uname -m)/os/"
        "--setopt=appstream.baseurl=$MAIL_TO_CODE_CENTOS_MIRROR/10-stream/AppStream/$(uname -m)/os/"
        "--setopt=crb.baseurl=$MAIL_TO_CODE_CENTOS_MIRROR/10-stream/CRB/$(uname -m)/os/")
    fi
    dnf "${task_dnf_args[@]}" install -y podman
  elif command -v apt-get >/dev/null; then apt-get update; apt-get install -y podman
  else echo 'Install Podman from your operating system package manager'; exit 1
  fi
fi
loginctl enable-linger "$task_user"
grep "^$task_user:" /etc/subuid /etc/subgid
echo 'System prerequisites installed; controller and containers run as the ordinary user.'
