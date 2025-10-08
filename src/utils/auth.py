"""Authentication helpers for Google Tag Manager API."""

from __future__ import annotations

import os
from typing import Iterable

from google.auth import default as google_auth_default
from google.oauth2 import service_account
from google_auth_oauthlib.flow import InstalledAppFlow


def get_credentials(auth_method: str, credentials_path: str | None, scopes: Iterable[str]):
    """
    Return Google credentials using service account, OAuth user, or ADC.

    Parameters
    ----------
    auth_method:
        One of "service", "user", or "adc".
    credentials_path:
        Location of the JSON key / client secrets file when required. Ignored for ADC.
    scopes:
        Iterable of OAuth scopes to request.
    """
    scopes_list = list(scopes)

    if auth_method == "adc":
        credentials, _ = google_auth_default(scopes=scopes_list)
        return credentials

    if auth_method == "service":
        _ensure_credentials_file(credentials_path)
        return service_account.Credentials.from_service_account_file(
            credentials_path,
            scopes=scopes_list,
        )

    if auth_method == "user":
        _ensure_credentials_file(credentials_path)
        flow = InstalledAppFlow.from_client_secrets_file(credentials_path, scopes_list)
        return flow.run_local_server(port=0)

    raise ValueError("auth must be 'service', 'user', or 'adc'")


def _ensure_credentials_file(path: str | None) -> None:
    if not path or not os.path.exists(path):
        raise FileNotFoundError(
            "Credentials file not found. Provide --credentials /path/to/file.json",
        )
