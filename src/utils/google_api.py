"""Small helpers around Google API client pagination and retries."""

from __future__ import annotations

import random
import time
from typing import Any, Callable, TypeVar

from googleapiclient.errors import HttpError

T = TypeVar("T")

_RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def _status_code_from_http_error(error: HttpError) -> int | None:
    resp = getattr(error, "resp", None)
    status = getattr(resp, "status", None)
    return int(status) if isinstance(status, int) else None


def is_retryable_google_api_error(error: BaseException) -> bool:
    """Return True when an exception is likely transient/retryable."""
    if isinstance(error, HttpError):
        status = _status_code_from_http_error(error)
        return status in _RETRYABLE_STATUS_CODES
    if isinstance(error, (TimeoutError, ConnectionError, OSError)):
        return True
    return False


def execute_with_retry(
    fn: Callable[[], T],
    *,
    retries: int = 4,
    base_delay_s: float = 0.5,
    max_delay_s: float = 8.0,
) -> T:
    """Execute `fn()` with exponential backoff retries for transient errors.

    Args:
        fn: Callable that performs a single API request and returns the decoded payload.
        retries: Number of retries after the initial attempt.
        base_delay_s: Base delay in seconds.
        max_delay_s: Max delay in seconds.

    Returns:
        The return value of `fn()`.

    Raises:
        The last exception if all retries fail or the error is non-retryable.
    """
    attempt = 0
    while True:
        try:
            return fn()
        except BaseException as exc:
            if attempt >= retries or not is_retryable_google_api_error(exc):
                raise
            delay_s = min(max_delay_s, base_delay_s * (2**attempt))
            delay_s *= 0.5 + random.random()  # jitter in [0.5x, 1.5x)
            time.sleep(delay_s)
            attempt += 1


def list_all_pages(
    fetch_page: Callable[[str | None], dict[str, Any]],
    *,
    items_field: str,
) -> list[dict[str, Any]]:
    """Collect all items across a paginated GTM list endpoint.

    Args:
        fetch_page: Function that accepts an optional page token and returns a parsed
            response payload (dict) from the GTM API.
        items_field: Response field containing list items (e.g., "tag", "trigger").

    Returns:
        All items from all pages, in received order.
    """
    items: list[dict[str, Any]] = []
    page_token: str | None = None

    while True:
        page = fetch_page(page_token)
        raw_items = page.get(items_field) or []
        if isinstance(raw_items, list):
            items.extend([x for x in raw_items if isinstance(x, dict)])
        page_token = page.get("nextPageToken")
        if not page_token:
            break

    return items
