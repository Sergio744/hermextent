#!/usr/bin/env python3
"""Create reproducible-ish Chrome and local companion release archives after a successful build."""
from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release"


def add_file(archive: zipfile.ZipFile, path: Path, archive_name: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Missing release input: {path}; run npm run build first")
    archive.write(path, archive_name)


def main() -> int:
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    RELEASE.mkdir(parents=True, exist_ok=True)
    extension_zip = RELEASE / f"hermes-browser-chrome-{version}.zip"
    companion_zip = RELEASE / f"hermes-browser-companion-{version}.zip"

    with zipfile.ZipFile(extension_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        add_file(archive, ROOT / "extension" / "manifest.json", "manifest.json")
        add_file(archive, ROOT / "extension" / "sidepanel.html", "sidepanel.html")
        for name in ("background.js", "sidepanel.js", "sidepanel.css"):
            add_file(archive, ROOT / "extension" / "dist" / name, f"dist/{name}")
        add_file(archive, ROOT / "extension" / "src" / "background" / "web-providers" / "UPSTREAM-LICENSE", "THIRD_PARTY_CHROMECLAW_LICENSE.txt")
        add_file(archive, ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")
        add_file(archive, ROOT / "third_party" / "HERMES-AGENT-LICENSE", "THIRD_PARTY_HERMES_LICENSE.txt")
        add_file(archive, ROOT / "LICENSE", "LICENSE")

    with zipfile.ZipFile(companion_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        add_file(archive, ROOT / "README.md", "README.md")
        add_file(archive, ROOT / "docs" / "capability-matrix.md", "docs/capability-matrix.md")
        add_file(archive, ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")
        add_file(archive, ROOT / "third_party" / "HERMES-AGENT-LICENSE", "THIRD_PARTY_HERMES_LICENSE.txt")
        add_file(archive, ROOT / "LICENSE", "LICENSE")
        for path in (ROOT / "companion").glob("*.py"):
            add_file(archive, path, path.relative_to(ROOT).as_posix())
        for path in (ROOT / "plugins" / "model-providers" / "hermes-browser").rglob("*"):
            if path.is_file():
                add_file(archive, path, path.relative_to(ROOT).as_posix())
        instructions = (
            "Hermes Browser companion installation\n"
            "1. Extract this archive into a permanent directory. Do not move it after registering Native Messaging.\n"
            "2. Install Hermes Agent and enable its API server on loopback with API_SERVER_KEY.\n"
            "3. Load the Hermes Browser Chrome extension and copy its id from chrome://extensions.\n"
            "4. Run: python companion/install.py --extension-id <chrome-extension-id>\n"
            "5. Restart Hermes, open the extension side panel, and choose Settings.\n"
            "6. Unregister with: python companion/uninstall.py --browser chrome. Add --remove-plugin --remove-token for optional profile cleanup.\n"
        )
        archive.writestr("INSTALL.txt", instructions)

    for path in (extension_zip, companion_zip):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size} bytes  sha256:{digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
