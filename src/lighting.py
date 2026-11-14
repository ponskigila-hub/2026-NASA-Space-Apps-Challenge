"""
Shadow mask (identical function for Moon and Earth) + Earth test windows.
Uses geometric elevation for shadow geometry (handoff §12 item 9 recommendation).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import pvlib

from src.config import SHADOW_MAX_DIST_M


def shadow_mask(
    dem: np.ndarray,
    res: float,
    az_deg: float,
    elev_deg: float,
    max_dist_m: float = SHADOW_MAX_DIST_M,
    radius_m: float = 1_737_400.0,
) -> np.ndarray:
    """
    Boolean shadow mask. Assumes north is up in the raster.
    Curvature correction: d²/(2R).
    """
    az = np.radians(az_deg)
    # north-up raster: +y is north → dy negative when stepping toward north
    dx = np.sin(az)
    dy = -np.cos(az)

    tan_e = np.tan(np.radians(elev_deg))
    n_steps = int(max_dist_m / res)
    pad = n_steps + 1

    z = np.pad(dem, pad, constant_values=np.nan)
    h, w = dem.shape
    base = z[pad : pad + h, pad : pad + w]
    shadow = np.zeros((h, w), dtype=bool)

    for k in range(1, n_steps + 1):
        sx = int(round(k * dx))
        sy = int(round(k * dy))
        if sx == 0 and sy == 0:
            continue
        d = np.hypot(sx, sy) * res
        shifted = z[pad + sy : pad + sy + h, pad + sx : pad + sx + w]
        # curvature-corrected height difference
        shadow |= ((shifted - d * d / (2 * radius_m)) - base) / d > tan_e

    return shadow


def lighting_score(d_elev: float, d_frac: float) -> float:
    """Build Guide additive form (bounded 0..1). [DECIDE] vs multiplicative."""
    return 0.5 * np.exp(-abs(d_elev) / 3.0) + 0.5 * np.exp(-abs(d_frac) / 0.15)


def find_windows(
    lat: float,
    lon: float,
    dem: np.ndarray,
    res: float,
    corridor: np.ndarray,
    moon_elev: float,
    moon_frac: float,
    start: str,
    end: str,
    tz: str,
    radius_m: float = 6_371_000.0,
    elev_tol: float = 2.0,
    shadow_tol: float = 0.10,
) -> list[dict[str, Any]]:
    """
    Search for Earth timestamps whose Sun elevation and geometric shadow
    fraction match the lunar values within tolerance.
    Returns list of hits (or empty list — caller must supply a reason).
    """
    times = pd.date_range(start, end, freq="10min", tz="UTC")
    sp = pvlib.solarposition.get_solarposition(times, lat, lon)

    # Prefer geometric elevation if available; fall back to apparent
    elev_col = "elevation" if "elevation" in sp.columns else "apparent_elevation"
    cand = sp[(sp[elev_col] > 0) & ((sp[elev_col] - moon_elev).abs() <= elev_tol)]

    hits = []
    # evaluate every ~30 min
    for t, row in cand.iloc[::3].iterrows():
        sh = shadow_mask(
            dem, res, row["azimuth"], row[elev_col], radius_m=radius_m
        )
        frac = float(sh[corridor].mean()) if corridor.any() else 0.0
        if abs(frac - moon_frac) <= shadow_tol:
            hits.append(
                {
                    "utc": t.isoformat(),
                    "local": t.tz_convert(tz).isoformat(),
                    "azimuth": float(row["azimuth"]),
                    "elevation": float(row[elev_col]),
                    "shadow_fraction": frac,
                }
            )
    return hits
