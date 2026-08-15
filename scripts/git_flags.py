Import("env")  # type: ignore  # PlatformIO pre script

import os
import subprocess

sha = os.environ.get("GITHUB_SHA", "").strip()
if not sha:
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=env["PROJECT_DIR"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        sha = "dev"

short = (sha[:7] if sha else "dev")
env.Append(CPPDEFINES=[("FW_GIT", '\\"%s\\"' % short)])
print("FW_GIT=%s" % short)
