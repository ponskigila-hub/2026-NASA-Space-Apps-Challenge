"""
Phase 3 helper: inspect every raster under data/raw and write outputs/metadata.csv
Also prints key facts for the known LDEM_1024 product.
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import rasterio

from src.config import DATA_RAW, OUTPUTS, MOON_RADIUS_M

OUTPUTS.mkdir(parents=True, exist_ok=True)


def inspect_one(path: Path) -> dict:
    info = {
        "path": str(path.relative_to(DATA_RAW.parent.parent) if DATA_RAW.parent.parent in path.parents else path),
        "exists": path.exists(),
        "size_mb": round(path.stat().st_size / 1e6, 2) if path.exists() else None,
    }
    if not path.exists() or path.suffix.lower() not in {".tif", ".tiff", ".jp2", ".img", ".hgt"}:
        return info

    try:
        with rasterio.open(path) as ds:
            info.update(
                {
                    "crs": str(ds.crs) if ds.crs else None,
                    "width": ds.width,
                    "height": ds.height,
                    "count": ds.count,
                    "dtype": str(ds.dtypes[0]),
                    "nodata": ds.nodata,
                    "res_x": ds.res[0] if ds.res else None,
                    "res_y": ds.res[1] if ds.res else None,
                    "bounds": list(ds.bounds),
                    "transform": list(ds.transform)[:6],
                }
            )
            # quick sample stats (first band, small window)
            data = ds.read(1, window=((0, min(100, ds.height)), (0, min(100, ds.width))))
            finite = data[np.isfinite(data)]
            if finite.size:
                info["sample_min"] = float(finite.min())
                info["sample_max"] = float(finite.max())
                info["sample_mean"] = float(finite.mean())
    except Exception as e:
        info["error"] = str(e)
    return info


def main() -> None:
    rows = []
    patterns = ["**/*.tif", "**/*.tiff", "**/*.jp2", "**/*.JP2", "**/*.img", "**/*.IMG", "**/*.hgt"]
    files = []
    for pat in patterns:
        files.extend(DATA_RAW.rglob(pat))

    # always record the known label even if image is missing
    label = DATA_RAW / "lola" / "ldem_1024_15n_30n_000_030_jp2.lbl"
    if label.exists():
        print("=== Known product from label ===")
        print("PRODUCT_ID          : LDEM_1024_15N_30N_000_030")
        print("MAP_RESOLUTION      : 1024 pix/deg  (~29.61 m/pix)")
        print("SCALING_FACTOR      : 0.5")
        print("OFFSET (radius)     : 1737400 m")
        print("HEIGHT = DN * 0.5")
        print("PLANETARY_RADIUS = DN * 0.5 + 1737400")
        print("Coverage            : 15N-30N, 0-30E  (covers Hadley Rille)")
        print("================================\n")

    if not files:
        print("No raster images found under data/raw/.")
        print("Place the LDEM_1024_15N_30N_000_030.JP2 (or .IMG) next to the .lbl file.")
        print("Expected path: data/raw/lola/LDEM_1024_15N_30N_000_030.JP2")
    else:
        for f in sorted(set(files)):
            rows.append(inspect_one(f))
            print(f"Inspected: {f.name}  size={rows[-1].get('size_mb')} MB")

    out = OUTPUTS / "metadata.csv"
    if rows:
        keys = sorted({k for r in rows for k in r})
        with open(out, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)
        print(f"Wrote {out}")
    else:
        print("No metadata.csv written (no rasters found).")


if __name__ == "__main__":
    main()
