"""
Phase 2e: Crop the LDEM_1024 product to MOON_BBOX and write a float32 GeoTIFF
with heights in metres.

Compatible with the exact product the team ordered:
  LDEM_1024_15N_30N_000_030  (1024 ppd, Simple Cylindrical, OFFSET=1737400, SCALE=0.5)

Place the image file next to the label:
  data/raw/lola/LDEM_1024_15N_30N_000_030.JP2   (or .IMG / .jp2)
  data/raw/lola/ldem_1024_15n_30n_000_030_jp2.lbl
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.transform import from_origin

from src.config import DATA_RAW, DATA_PROCESSED, MOON_BBOX, MOON_RADIUS_M, MOON_CRS
from src.sources import log_source

# Product constants taken from the PDS label you provided
PRODUCT_ID = "LDEM_1024_15N_30N_000_030"
SCALING_FACTOR = 0.5
OFFSET_M = 1737400.0          # reference radius
MAP_RES_PPD = 1024
PIXEL_M = 30323.0 / MAP_RES_PPD   # ≈ 29.612 m  (handoff arithmetic)


def find_image() -> Path | None:
    """Locate the JP2 or IMG that belongs to the label."""
    candidates = [
        DATA_RAW / "lola" / f"{PRODUCT_ID}.JP2",
        DATA_RAW / "lola" / f"{PRODUCT_ID}.jp2",
        DATA_RAW / "lola" / f"{PRODUCT_ID}.IMG",
        DATA_RAW / "lola" / f"{PRODUCT_ID}.img",
        DATA_RAW / "lola" / "ldem_1024_15n_30n_000_030.JP2",
        DATA_RAW / "lola" / "ldem_1024_15n_30n_000_030.jp2",
        DATA_RAW / "lola" / "ldem_1024_15n_30n_000_030.IMG",
    ]
    for p in candidates:
        if p.exists():
            return p
    # also accept any jp2/img sitting in the folder
    for p in (DATA_RAW / "lola").glob("*.JP2"):
        return p
    for p in (DATA_RAW / "lola").glob("*.jp2"):
        return p
    for p in (DATA_RAW / "lola").glob("*.IMG"):
        return p
    return None


def crop_and_convert(src_path: Path) -> Path:
    """
    Open the cylindrical LDEM, crop to MOON_BBOX (lon/lat degrees),
    apply scale so values become heights in metres relative to the
    reference sphere, write float32 GeoTIFF.
    """
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    out_path = DATA_RAW / "lola" / "hadley_crop.tif"   # also keep under raw for Phase 2
    out_path_proc = DATA_PROCESSED / "moon_dem.tif"

    west, south, east, north = MOON_BBOX  # degrees

    with rasterio.open(src_path) as src:
        print(f"Opened {src_path.name}")
        print(f"  size     : {src.width} x {src.height}")
        print(f"  crs      : {src.crs}")
        print(f"  bounds   : {src.bounds}")
        print(f"  res      : {src.res}")

        # Many LOLA JP2s arrive without a proper CRS; build one if missing
        # Simple cylindrical on a sphere of radius 1737400 m
        if src.crs is None:
            print("  [info] source has no CRS – assuming Simple Cylindrical degrees")
            # We will work in lon/lat degrees for the window
            window = from_bounds(west, south, east, north, src.transform)
        else:
            window = from_bounds(west, south, east, north, src.transform)

        window = window.round_offsets().round_lengths()
        data = src.read(1, window=window).astype(np.float32)

        # Convert DN → height (m) relative to reference sphere
        # HEIGHT = DN * SCALING_FACTOR   (label convention)
        # We keep height above the reference radius so values are
        # typically a few thousand metres (topography), not planetary radius.
        height = data * SCALING_FACTOR

        # nodata handling – LOLA often uses a large negative or zero for voids
        height[~np.isfinite(height)] = np.nan
        # optional: treat extreme outliers as nodata
        height[np.abs(height) > 20000] = np.nan   # safety

        # Build an affine transform for the cropped window (still in degrees)
        transform = src.window_transform(window)

        profile = src.profile.copy()
        profile.update(
            {
                "driver": "GTiff",
                "dtype": "float32",
                "count": 1,
                "height": height.shape[0],
                "width": height.shape[1],
                "transform": transform,
                "nodata": np.nan,
                "compress": "deflate",
                "crs": "EPSG:4326",  # degrees; later Phase 4 reprojects to MOON_CRS
            }
        )

        for dest in (out_path, out_path_proc):
            dest.parent.mkdir(parents=True, exist_ok=True)
            with rasterio.open(dest, "w", **profile) as dst:
                dst.write(height, 1)
            print(f"Wrote {dest}  shape={height.shape}")

    log_source(
        name=PRODUCT_ID,
        version="V1.05",
        portal="NASA PDS Geosciences Node / LRO LOLA",
        url="https://pds-geosciences.wustl.edu/missions/lro/",
        res_m=round(PIXEL_M, 2),
        notes=(
            f"1024 ppd Simple Cylindrical; SCALING_FACTOR={SCALING_FACTOR}; "
            f"OFFSET={OFFSET_M}; cropped to MOON_BBOX={MOON_BBOX}; "
            f"height = DN * {SCALING_FACTOR}"
        ),
        extra={
            "coverage": "15N-30N, 0-30E",
            "product_id": PRODUCT_ID,
            "pixel_m_approx": PIXEL_M,
        },
    )
    return out_path


def main() -> None:
    img = find_image()
    if img is None:
        print("=" * 60)
        print("IMAGE FILE NOT FOUND")
        print("=" * 60)
        print("Expected one of:")
        print(f"  data/raw/lola/{PRODUCT_ID}.JP2")
        print(f"  data/raw/lola/{PRODUCT_ID}.IMG")
        print("  (or any .JP2 / .IMG in data/raw/lola/)")
        print()
        print("The label and aux files are already present.")
        print("Copy the large image file into data/raw/lola/ then re-run:")
        print("  python -m src.crop_lola")
        print("=" * 60)
        return

    print(f"Found image: {img}")
    crop_and_convert(img)
    print("Done. Next: python -m src.inspect_data")


if __name__ == "__main__":
    main()
