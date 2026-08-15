#!/usr/bin/env python3
"""Write dist/version.json for GitHub Releases / OTA."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "neooriginal/ElectronicRack"


def git(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()
    except Exception:
        return ""


def fw_version() -> str:
    text = (ROOT / "include" / "Config.h").read_text(encoding="utf-8")
    m = re.search(r'#define\s+FW_VERSION\s+"([^"]+)"', text)
    return m.group(1) if m else "0.0.0"


def main() -> None:
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "version.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    sha = os.environ.get("GITHUB_SHA") or git("rev-parse", "HEAD") or "unknown"
    payload = {
        "version": fw_version(),
        "git": sha[:7],
        "sha": sha,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": os.environ.get("GITHUB_REPOSITORY", REPO),
        "firmware": "firmware.bin",
        "filesystem": "littlefs.bin",
    }
    dest.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print("wrote", dest)


if __name__ == "__main__":
    main()
