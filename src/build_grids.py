"""
Phase 4: Common metric grids – Moon fix using source bounds + transform_bounds.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.fill import fillnodata
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds
from pyproj import Transformer

from src.config import (
    DATA_PROCESSED,
    DATA_RAW,
    EARTH_REGIONS,
    MOON_BBOX,
    MOON_CRS,
    MOON_RADIUS_M,
)
from src.sources import log_source

COMMON_RES_M = 30.0
EARTH_HALF_M = 25_000.0
MAX_FILL_PX = 3
MAX_MISSING_FRAC = 0.05
MOON_LONLAT = f"+proj=longlat +R={MOON_RADIUS_M} +no_defs"


def utm_epsg(lat: float, lon: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def reproject_to_grid(
    src_path: Path,
    dst_path: Path,
    dst_crs: str,
    res_m: float,
    bounds: tuple[float, float, float, float],
    src_crs_override=None,
    src_nodata=None,
) -> dict:
    west, south, east, north = bounds
    width = max(1, int(np.ceil((east - west) / res_m)))
    height = max(1, int(np.ceil((north - south) / res_m)))
    transform = from_origin(west, north, res_m, res_m)
    dst = np.full((height, width), np.nan, dtype=np.float32)

    with rasterio.open(src_path) as src:
        src_crs = src_crs_override or src.crs or "EPSG:4326"
        data = src.read(1).astype(np.float32)
        nodata = src.nodata if src.nodata is not None else src_nodata
        if nodata is not None:
            data[data == nodata] = np.nan
        data[data < -1000] = np.nan

        n_valid_src = int(np.isfinite(data).sum())
        print(f"    source valid pixels: {n_valid_src} / {data.size}")

        reproject(
            source=data,
            destination=dst,
            src_transform=src.transform,
            src_crs=src_crs,
            dst_transform=transform,
            dst_crs=dst_crs,
            resampling=Resampling.bilinear,
            src_nodata=np.nan,
            dst_nodata=np.nan,
        )

    valid_before = np.isfinite(dst)
    miss_before = 1.0 - float(valid_before.mean())

    if 0 < miss_before < 0.15:
        mask = (~valid_before).astype(np.uint8)
        filled = fillnodata(dst, mask=mask, max_search_distance=MAX_FILL_PX)
        dst = np.where(valid_before, dst, filled)

    valid_after = np.isfinite(dst)
    miss_after = 1.0 - float(valid_after.mean())

    profile = {
        "driver": "GTiff",
        "dtype": "float32",
        "count": 1,
        "height": height,
        "width": width,
        "crs": dst_crs,
        "transform": transform,
        "nodata": np.nan,
        "compress": "deflate",
    }
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(dst_path, "w", **profile) as out:
        out.write(dst, 1)

    return {
        "path": str(dst_path),
        "shape": (height, width),
        "res_m": res_m,
        "crs": dst_crs,
        "missing_before": round(miss_before, 4),
        "missing_after": round(miss_after, 4),
        "bounds": bounds,
    }


def build_moon() -> dict:
    src = DATA_RAW / "lola" / "hadley_crop.tif"
    if not src.exists():
        src = DATA_PROCESSED / "moon_dem.tif"
    if not src.exists():
        raise FileNotFoundError("Moon DEM not found. Run crop_lola first.")

    with rasterio.open(src) as ds:
        left, bottom, right, top = ds.bounds
        print(f"    crop bounds (deg): L={left:.4f} B={bottom:.4f} R={right:.4f} T={top:.4f}")
        print(f"    crop shape: {ds.width} x {ds.height}")

    try:
        west, south, east, north = transform_bounds(
            MOON_LONLAT, MOON_CRS, left, bottom, right, top, densify_pts=21
        )
    except Exception:
        tf = Transformer.from_crs(MOON_LONLAT, MOON_CRS, always_xy=True)
        corners = [(left, bottom), (left, top), (right, bottom), (right, top)]
        xs, ys = zip(*(tf.transform(x, y) for x, y in corners))
        west, south, east, north = min(xs), min(ys), max(xs), max(ys)

    pad = 500.0
    bounds = (west - pad, south - pad, east + pad, north + pad)
    print(f"    stereo bounds (m): {bounds}")

    dst = DATA_PROCESSED / "moon_dem.tif"
    stats = reproject_to_grid(
        src, dst, MOON_CRS, COMMON_RES_M, bounds, src_crs_override=MOON_LONLAT
    )
    print(f"[Moon] {stats['shape']}  miss {stats['missing_before']} → {stats['missing_after']}")
    if stats["missing_after"] > MAX_MISSING_FRAC:
        print(f"  [WARN] missing fraction {stats['missing_after']:.1%} > {MAX_MISSING_FRAC:.0%}")
    return stats


def build_earth_region(name: str, info: dict) -> dict:
    folder = DATA_RAW / "dem_earth" / name
    hgt_files = list(folder.glob("*.hgt")) + list(folder.glob("*.HGT"))
    if not hgt_files:
        raise FileNotFoundError(f"No .hgt in {folder}")

    src = hgt_files[0]
    lat, lon = info["lat"], info["lon"]
    epsg = utm_epsg(lat, lon)
    dst_crs = f"EPSG:{epsg}"

    with rasterio.open(src) as ds:
        tile_w, tile_s, tile_e, tile_n = ds.bounds

    half_deg_lat = EARTH_HALF_M / 111_000.0
    half_deg_lon = EARTH_HALF_M / (111_000.0 * max(np.cos(np.radians(lat)), 0.2))
    des_w = max(lon - half_deg_lon, tile_w)
    des_e = min(lon + half_deg_lon, tile_e)
    des_s = max(lat - half_deg_lat, tile_s)
    des_n = min(lat + half_deg_lat, tile_n)

    tf = Transformer.from_crs("EPSG:4326", dst_crs, always_xy=True)
    corners = [(des_w, des_s), (des_w, des_n), (des_e, des_s), (des_e, des_n)]
    xs, ys = zip(*(tf.transform(x, y) for x, y in corners))
    bounds = (min(xs), min(ys), max(xs), max(ys))

    dst = DATA_PROCESSED / f"{name}_dem.tif"
    stats = reproject_to_grid(
        src, dst, dst_crs, COMMON_RES_M, bounds, src_nodata=-32768
    )
    print(f"[{name}] EPSG:{epsg}  {stats['shape']}  miss {stats['missing_before']} → {stats['missing_after']}")
    if stats["missing_after"] > MAX_MISSING_FRAC:
        print(f"  [WARN] missing fraction {stats['missing_after']:.1%} > {MAX_MISSING_FRAC:.0%}")
    return stats


def main() -> None:
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)
    print(f"Common resolution: {COMMON_RES_M} m")
    print(f"Moon source CRS  : {MOON_LONLAT}")
    print("-" * 50)

    results = {"moon": build_moon()}
    for name, info in EARTH_REGIONS.items():
        try:
            results[name] = build_earth_region(name, info)
        except Exception as e:
            print(f"[{name}] FAILED: {e}")
            results[name] = {"error": str(e)}

    print("-" * 50)
    print("Phase 4 summary")
    ok = True
    for k, v in results.items():
        if "error" in v:
            print(f"  {k}: ERROR – {v['error']}")
            ok = False
        else:
            flag = " OK" if v["missing_after"] <= MAX_MISSING_FRAC else " WARN"
            print(
                f"  {k}: {v['shape'][1]}×{v['shape'][0]} px  "
                f"res={v['res_m']} m  miss={v['missing_after']:.2%}{flag}"
            )
            if v["missing_after"] > MAX_MISSING_FRAC:
                ok = False

    log_source(
        name="common_grids",
        version="phase4-moonfix",
        portal="derived",
        url="",
        res_m=COMMON_RES_M,
        notes="Moon bounds from crop; Earth OK",
    )
    if ok:
        print("\nPhase 4 quality gate passed. Next: Phase 5 (slope + roughness)")
    else:
        print("\nPhase 4 finished with warnings.")
        print("Earth grids are OK. If Moon still high missing, we can keep degree grid for Moon.")


if __name__ == "__main__":
    main()