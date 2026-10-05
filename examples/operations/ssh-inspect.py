#!/usr/bin/env python3
"""Copy to a private executable location; configure one fixed SSH destination."""
import json
import re
import subprocess
import sys


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[a-zA-Z0-9_][a-zA-Z0-9_.@-]*", sys.argv[1]):
        raise ValueError("Configure one SSH destination")
    # Fixed remote code, no model-provided commands or interpolation.
    remote = "python3 -c 'import json,os,socket; print(json.dumps({\"ok\":True,\"summary\":\"SSH inspection completed\",\"evidence\":{\"hostname\":socket.gethostname(),\"uid\":os.getuid()}}))'"
    completed = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
         "-o", "ConnectTimeout=10", sys.argv[1], remote],
        capture_output=True, text=True, timeout=20, check=True,
    )
    result = json.loads(completed.stdout)
    if set(result) != {"ok", "summary", "evidence"}:
        raise ValueError("Unexpected result")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not expose SSH stderr, credentials or unchecked remote output.
        print("SSH inspection failed; verify private connection setup.", file=sys.stderr)
        sys.exit(1)
