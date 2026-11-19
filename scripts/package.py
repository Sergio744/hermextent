#!/usr/bin/env python3
"""Package the complete Hermes Web Gateway source tree without local secrets/build caches."""
from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release"
EXCLUDED_DIRS = {
    ".git", ".research", ".venv", "node_modules", "release", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "coverage", "target", "build",
}
EXCLUDED_FILES = {".env", ".coverage"}


def main() -> int:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    RELEASE.mkdir(parents=True, exist_ok=True)
    output = RELEASE / f"hermes-web-gateway-{version}.zip"
    prefix = "hermes-web-gateway/"

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for directory, subdirs, filenames in os.walk(ROOT):
            current = Path(directory)
            relative_dir = current.relative_to(ROOT)
            subdirs[:] = [name for name in subdirs if name not in EXCLUDED_DIRS]
            if relative_dir == Path("tests"):
                subdirs[:] = [name for name in subdirs if name != ".build"]
            if relative_dir == Path("gateway"):
                subdirs[:] = [name for name in subdirs if name != "dist"]
            for filename in filenames:
                path = current / filename
                relative = path.relative_to(ROOT)
                if filename in EXCLUDED_FILES or filename.endswith(".pyc") or filename.endswith(".log"):
                    continue
                if filename.startswith(".env.") and filename != ".env.example":
                    continue
                if relative.parts[:2] == ("tests", ".build"):
                    continue
                if relative.parts[:2] == ("gateway", "dist"):
                    continue
                archive.write(path, prefix + relative.as_posix())
        archive.writestr(prefix + "INSTALL.txt", (
            "Hermes Web Gateway installation\n"
            "1. Install Node.js 22+ and npm, Hermes Agent, and Chrome or Edge.\n"
            "2. Extract this archive and open a terminal in its hermes-web-gateway directory.\n"
            "3. Run npm ci.\n"
            "4. Run: py -3 gateway/install.py --hermes-home <your Hermes home> (Windows)\n"
            "   or python3 gateway/install.py (macOS/Linux).\n"
            "5. Restart Hermes, then run: npm run gateway.\n"
            "6. Open http://127.0.0.1:20128 and sign in from the dedicated browser window.\n"
            "The bearer credential is stored in Hermes .env and must remain private. No extension/native host is required.\n"
        ))

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"{output.relative_to(ROOT)}  {output.stat().st_size} bytes  sha256:{digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
