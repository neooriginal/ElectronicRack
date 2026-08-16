Import("env")  # type: ignore  # PlatformIO pre script

import gzip
from pathlib import Path

data = Path(env["PROJECT_DIR"]) / "data"
for src in sorted(data.iterdir()):
    if src.suffix not in {".js", ".css", ".json", ".md"}:
        continue
    dest = src.with_name(src.name + ".gz")
    raw = src.read_bytes()
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime and dest.stat().st_size:
        continue
    with gzip.open(dest, "wb", compresslevel=9) as out:
        out.write(raw)
    print("gzip %s %d -> %d" % (src.name, len(raw), dest.stat().st_size))
