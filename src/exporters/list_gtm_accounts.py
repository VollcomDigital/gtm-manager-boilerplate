#!/usr/bin/env python3
"""
List GTM accounts (and optionally containers) using the Tag Manager API.
"""
import argparse
import json
import pathlib
import sys
from typing import Dict, List

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SRC_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from utils.auth import get_credentials  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]


def fetch_accounts(service) -> List[Dict]:
    """Return all accessible GTM accounts."""
    accounts: List[Dict] = []
    next_page_token = None

    while True:
        request = service.accounts().list(pageToken=next_page_token)
        response = request.execute()
        accounts.extend(response.get("account", []))
        next_page_token = response.get("nextPageToken")
        if not next_page_token:
            break

    return accounts


def fetch_containers(service, account_id: str) -> List[Dict]:
    """Return containers for an account."""
    containers: List[Dict] = []
    next_page_token = None
    parent = f"accounts/{account_id}"

    while True:
        request = service.accounts().containers().list(
            parent=parent,
            pageToken=next_page_token,
        )
        response = request.execute()
        containers.extend(response.get("container", []))
        next_page_token = response.get("nextPageToken")
        if not next_page_token:
            break

    return containers


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List Google Tag Manager accounts accessible with the provided credentials.",
    )
    parser.add_argument(
        "--auth",
        choices=["service", "user", "adc"],
        default="adc",
        help="Auth method: service (Service Account), user (OAuth), or adc (gcloud / ADC). Default: adc",
    )
    parser.add_argument(
        "--credentials",
        help=(
            "Path to Service Account JSON (for --auth service) or OAuth client_secrets.json "
            "(for --auth user). Not required for --auth adc."
        ),
    )
    parser.add_argument(
        "--with-containers",
        action="store_true",
        help="If set, include containers for each account in the output.",
    )
    parser.add_argument(
        "--output",
        help="Optional path to write the results as JSON. Defaults to printing to stdout.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        credentials = get_credentials(args.auth, args.credentials, SCOPES)
        service = build("tagmanager", "v2", credentials=credentials, cache_discovery=False)

        accounts = fetch_accounts(service)
        if args.with_containers:
            for account in accounts:
                account_id = account.get("accountId")
                if not account_id:
                    continue
                account["containers"] = fetch_containers(service, account_id)

        payload = {"accounts": accounts}
        output = json.dumps(payload, indent=2, ensure_ascii=False)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(output)
            print(f"Wrote GTM accounts to {args.output}")
        else:
            print(output)
    except HttpError as error:
        print(f"GTM API error: {error}")
        raise
    except Exception as error:
        print(f"Error: {error}")
        raise


if __name__ == "__main__":
    main()
