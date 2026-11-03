#!/usr/bin/env python3
"""Unregister Hermes Browser's Native Messaging host; optionally remove its profile plugin/token."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from .install import BROWSER_BASES, LINUX_BROWSER_BASES, HOST_NAME, hermes_home
except ImportError:  # direct execution from the extracted companion directory
    from install import BROWSER_BASES, LINUX_BROWSER_BASES, HOST_NAME, hermes_home


def uninstall_manifest(browser: str) -> Path | None:
    if os.name == "nt":
        import winreg
        vendor = {"chrome": "Google\\Chrome", "chromium": "Chromium", "brave": "BraveSoftware\\Brave-Browser"}[browser]
        key_path = "Software\\" + vendor + "\\NativeMessagingHosts\\" + HOST_NAME
        manifest_path = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "HermesBrowser" / f"{HOST_NAME}.json"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
                try:
                    winreg.DeleteValue(key, None)
                except FileNotFoundError:
                    pass
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        except FileNotFoundError:
            return None
    else:
        if sys.platform == "darwin":
            root = Path.home() / "Library" / "Application Support" / BROWSER_BASES[browser] / "NativeMessagingHosts"
        else:
            root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / LINUX_BROWSER_BASES[browser] / "NativeMessagingHosts"
        manifest_path = root / f"{HOST_NAME}.json"
        try:
            value = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if value.get("name") != HOST_NAME:
            raise RuntimeError(f"Refusing to remove an unrelated manifest: {manifest_path}")
        manifest_path.unlink()
    try:
        manifest_path.unlink(missing_ok=True)
    except OSError:
        pass
    return manifest_path


def remove_provider(home: Path) -> bool:
    source = Path(__file__).resolve().parents[1] / "plugins" / "model-providers" / "hermes-browser"
    target = home / "plugins" / "model-providers" / "hermes-browser"
    removed = False
    for item in source.iterdir():
        candidate = target / item.name
        if item.is_file() and candidate.is_file() and candidate.read_bytes() == item.read_bytes():
            candidate.unlink()
            removed = True
    for directory in (target, target.parent, target.parent.parent):
        try:
            directory.rmdir()
        except OSError:
            break
    return removed


def remove_bridge_token(home: Path) -> bool:
    path = home / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    kept = [line for line in lines if line.partition("=")[0].strip() != "HERMEXTENT_BRIDGE_TOKEN"]
    if len(kept) == len(lines):
        return False
    path.write_text("\n".join(kept).rstrip() + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", choices=sorted(BROWSER_BASES), default="chrome")
    parser.add_argument("--hermes-home", help="Hermes profile home (defaults to $HERMES_HOME or ~/.hermes)")
    parser.add_argument("--remove-plugin", action="store_true", help="Remove only Hermes Browser's installed plugin files, preserving unrelated files")
    parser.add_argument("--remove-token", action="store_true", help="Remove HERMEXTENT_BRIDGE_TOKEN from Hermes .env")
    args = parser.parse_args()
    home = Path(args.hermes_home).expanduser().resolve() if args.hermes_home else hermes_home()
    manifest = uninstall_manifest(args.browser)
    print(f"Native Messaging registration: {'removed' if manifest else 'not found'}")
    if args.remove_plugin:
        print(f"Hermes provider plugin: {'removed' if remove_provider(home) else 'not found'}")
    if args.remove_token:
        print(f"Bridge token: {'removed' if remove_bridge_token(home) else 'not found'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
