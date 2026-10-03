#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  start|stop|restart|status) systemctl --user "$1" mail-to-code.service ;;
  logs) journalctl --user -u mail-to-code.service -n 100 --no-pager ;;
  *) echo 'Usage: service.sh start|stop|restart|status|logs'; exit 2 ;;
esac
