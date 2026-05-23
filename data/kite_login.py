#!/usr/bin/env python3
"""
Interactive Kite Connect login -> access_token. RUN THIS IN YOUR OWN TERMINAL
(it needs your Zerodha login + 2FA in a browser):

    python3 data/kite_login.py

Reads KITE_API_KEY / KITE_API_SECRET from the root .env, prints the Kite login
URL, prompts for the request_token from the redirect, exchanges it for an
access_token, and writes KITE_ACCESS_TOKEN into frontend/.env.local.

Re-run daily — Kite access tokens expire every morning (~07:30 IST).
"""

import os
import re
import sys
from pathlib import Path

from kiteconnect import KiteConnect

ROOT = Path(__file__).resolve().parent.parent


def read_env(path: Path, key: str):
    try:
        for line in path.read_text().splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return None


def main():
    api_key = os.environ.get("KITE_API_KEY") or read_env(ROOT / ".env", "KITE_API_KEY")
    api_secret = os.environ.get("KITE_API_SECRET") or read_env(
        ROOT / ".env", "KITE_API_SECRET"
    )
    if not api_key or not api_secret:
        sys.exit("KITE_API_KEY / KITE_API_SECRET not found in .env or environment")

    kite = KiteConnect(api_key=api_key)
    print("\n1) Open this URL, log in to Zerodha, and approve:\n")
    print("   " + kite.login_url() + "\n")
    print("2) You'll be redirected to your app's redirect URL with")
    print("   ...?request_token=XXXX&action=login&status=success in the address bar.")
    print("   Copy the request_token value.\n")

    request_token = input("Paste request_token here: ").strip()
    data = kite.generate_session(request_token, api_secret=api_secret)
    access_token = data["access_token"]

    print("\naccess_token:", access_token)

    env_local = ROOT / "frontend" / ".env.local"
    text = env_local.read_text() if env_local.exists() else ""
    if re.search(r"^KITE_ACCESS_TOKEN=", text, re.M):
        text = re.sub(
            r"^KITE_ACCESS_TOKEN=.*$",
            f"KITE_ACCESS_TOKEN={access_token}",
            text,
            flags=re.M,
        )
    else:
        text = text.rstrip("\n") + f"\nKITE_ACCESS_TOKEN={access_token}\n"
    env_local.write_text(text)
    print(f"\nWrote KITE_ACCESS_TOKEN to {env_local}")
    print("Done. The token is valid until ~07:30 IST tomorrow; re-run then.")


if __name__ == "__main__":
    main()
