"""
Source logging helper. Every downloaded product must be recorded.
These records appear in the app data-sources panel and in the report.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

from src.config import SOURCES_JSON


def log_source(
    name: str,
    version: str,
    portal: str,
    url: str,
    res_m: float | None = None,
    notes: str = "",
    extra: dict[str, Any] | None = None,
) -> None:
    """Append one product record to sources.json."""
    try:
        data = json.loads(SOURCES_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        data = []

    record = {
        "name": name,
        "version": version,
        "portal": portal,
        "url": url,
        "resolution_m": res_m,
        "downloaded": str(date.today()),
        "notes": notes,
    }
    if extra:
        record.update(extra)

    data.append(record)
    SOURCES_JSON.write_text(json.dumps(data, indent=2))
    print(f"[sources] logged: {name} ({version})")


def load_sources() -> list[dict]:
    try:
        return json.loads(SOURCES_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []
