"""Regenerate the two offline analyses and their selected-site reports."""
import json

from .config import DEFAULT_LUNAR_UTC, FRONTEND, PRESETS
from .science import apply_preset, enrich
from .pipeline import compute, publish, snap_endpoints
from .reports import export_bundle

CASES = {
    "hadley": {
        "A": {"lat": 26.143017, "lon": 3.079142},
        "B": {"lat": 26.357301, "lon": 4.389023},
    },
    "rille": {
        "A": {"lat": 26.19, "lon": 3.47},
        "B": {"lat": 26.12, "lon": 3.70},
    },
}


def main():
    for name, points in CASES.items():
        cells, snapped = snap_endpoints(points)
        terrain = compute(cells)
        science = enrich(terrain, DEFAULT_LUNAR_UTC, "2026-11-14")
        result = publish(terrain, points, snapped, "rover_navigation", f"replay-{name}", science)
        result["mode"] = "replay"
        output = FRONTEND / "public" / "replay" / name
        output.mkdir(parents=True, exist_ok=True)
        (output / "analysis.json").write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
        for preset in PRESETS:
            report_result = apply_preset(result, preset)
            for site in [None, *(c["id"] for c in result["candidates"])]:
                filename = f"{preset}-{site or 'overview'}.zip"
                (output / filename).write_bytes(export_bundle(report_result, site))
        print(name, f"{result['lunar']['lengthKm']:.2f} km", [c["id"] for c in result["candidates"]], flush=True)


if __name__ == "__main__":
    main()
