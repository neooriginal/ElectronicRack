Import("env")  # type: ignore  # PlatformIO pre script

from pathlib import Path

root = Path(env["PROJECT_DIR"])
dest = root / "include" / "secrets.h"
example = root / "include" / "secrets.example.h"
if not dest.exists() and example.exists():
    dest.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
    print("Created include/secrets.h from secrets.example.h — edit Wi-Fi SSID/password.")
