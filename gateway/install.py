#!/usr/bin/env python3
"""Install the Hermes Web Gateway provider profile; no Chrome extension/native host required."""
from __future__ import annotations

import argparse
import os
import secrets
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def hermes_home(raw: str | None) -> Path:
    return Path(raw or os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser().resolve()


def ensure_gateway_token(env_path: Path) -> None:
    env_path.parent.mkdir(parents=True, exist_ok=True)
    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    for line in existing.splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == "HERMEXTENT_BRIDGE_TOKEN" and len(value.strip().strip("\"'")) >= 32:
            return
    token = secrets.token_urlsafe(48)
    addition = f"\n# Local Hermes Web Gateway credential\nHERMEXTENT_BRIDGE_TOKEN={token}\n"
    env_path.write_text(existing.rstrip() + addition, encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except OSError:
        pass


def install_profile(home: Path) -> Path:
    source = ROOT / "plugins" / "model-providers" / "hermes-browser"
    target = home / "plugins" / "model-providers" / "hermes-browser"
    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        if item.is_file():
            shutil.copy2(item, target / item.name)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", help="Hermes home directory (defaults to $HERMES_HOME or ~/.hermes)")
    args = parser.parse_args()
    home = hermes_home(args.hermes_home)
    profile = install_profile(home)
    ensure_gateway_token(home / ".env")
    print(f"Hermes home: {home}")
    print(f"Provider profile installed: {profile}")
    print("Gateway endpoint: http://127.0.0.1:20128/v1")
    print("A local gateway credential was preserved or created in Hermes .env; its value was not displayed.")
    print("Start Hermes Web Gateway with: npm run gateway")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
