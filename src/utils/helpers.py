"""Shared helpers for GTM tooling."""

from __future__ import annotations

from pathlib import Path


def ensure_output_directory(path: str) -> None:
    """Ensure the output directory exists for a given file or directory path.

    Args:
        path: A filesystem path. If it looks like a file path (has a suffix),
            the parent directory is created. Otherwise the path itself is treated
            as a directory to create.

    Returns:
        None.
    """
    candidate = Path(path).expanduser()
    directory = candidate.parent if candidate.suffix else candidate
    if str(directory) == "":
        return
    directory.mkdir(parents=True, exist_ok=True)
