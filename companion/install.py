#!/usr/bin/env python3
"""Install the Hermes provider plugin and Chrome Native Messaging registration."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST_SCRIPT = (ROOT / "companion" / "native_host.py").resolve()
HOST_NAME = "com.hermextent.bridge"
BROWSER_BASES = {
    "chrome": "Google/Chrome",
    "chromium": "Chromium",
    "brave": "BraveSoftware/Brave-Browser",
}
LINUX_BROWSER_BASES = {
    "chrome": "google-chrome",
    "chromium": "chromium",
    "brave": "BraveSoftware/Brave-Browser",
}


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().resolve()


def env_token(path: Path) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "HERMEXTENT_BRIDGE_TOKEN":
            return value.strip().strip("\"'")
    return None


def install_token(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    token = env_token(path)
    if not token or len(token) < 32:
        token = secrets.token_urlsafe(48)
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        addition = f"\n# Hermes Browser local model relay\nHERMEXTENT_BRIDGE_TOKEN={token}\n"
        path.write_text(existing.rstrip() + addition, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return token


def install_provider(home: Path) -> Path:
    destination = home / "plugins" / "model-providers" / "hermes-browser"
    destination.mkdir(parents=True, exist_ok=True)
    source = ROOT / "plugins" / "model-providers" / "hermes-browser"
    for item in source.iterdir():
        if item.is_file():
            shutil.copy2(item, destination / item.name)
    return destination


def host_manifest(extension_id: str, home: Path) -> dict:
    return {
        "name": HOST_NAME,
        "description": "Hermes Browser local model relay",
        "path": str(Path(sys.executable).resolve()),
        "args": [str(HOST_SCRIPT), "--hermes-home", str(home)],
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def install_manifest(extension_id: str, browser: str, home: Path) -> Path:
    manifest = host_manifest(extension_id, home)
    if os.name == "nt":
        try:
            import winreg
            root = winreg.HKEY_CURRENT_USER
            vendor = {"chrome": "Google\\Chrome", "chromium": "Chromium", "brave": "BraveSoftware\\Brave-Browser"}[browser]
            key_path = "Software\\" + vendor + "\\NativeMessagingHosts\\" + HOST_NAME
            manifest_path = _write_windows_manifest(manifest)
            with winreg.CreateKeyEx(root, key_path, 0, winreg.KEY_SET_VALUE) as key:
                winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path))
            return manifest_path
        except ImportError as exc:
            raise RuntimeError("Windows registry API is unavailable") from exc
    if sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / BROWSER_BASES[browser] / "NativeMessagingHosts"
    else:
        config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        root = config / LINUX_BROWSER_BASES[browser] / "NativeMessagingHosts"
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{HOST_NAME}.json"
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return target


def _write_windows_manifest(manifest: dict) -> Path:
    target = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "HermesBrowser" / f"{HOST_NAME}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True, help="Chrome extension id from chrome://extensions")
    parser.add_argument("--browser", choices=sorted(BROWSER_BASES), default="chrome")
    parser.add_argument("--hermes-home", help="Hermes profile home (defaults to $HERMES_HOME or ~/.hermes)")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("--extension-id must be the 32-character id shown by Chrome")
    home = Path(args.hermes_home).expanduser().resolve() if args.hermes_home else hermes_home()
    env_path = home / ".env"
    install_token(env_path)
    provider = install_provider(home)
    manifest = install_manifest(args.extension_id, args.browser, home)
    print(f"Hermes home: {home}")
    print(f"Provider plugin: {provider}")
    print(f"Native Messaging manifest: {manifest}")
    print(f"Local relay: http://127.0.0.1:8765/v1 (bearer token stored in {env_path})")
    print("Restart Hermes after installation. Keep the bridge token private; the local relay exposes agent inference to whoever possesses it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
