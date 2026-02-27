from __future__ import annotations

import sys
from pathlib import Path


def pytest_configure() -> None:
    src_root = Path(__file__).resolve().parents[1] / "src"
    sys.path.insert(0, str(src_root))
