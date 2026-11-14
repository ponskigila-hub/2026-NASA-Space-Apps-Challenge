"""
Least-cost routing on a metric grid + corridor statistics.
Uses scikit-image route_through_array (A*/Dijkstra, 8-connected).
"""

from __future__ import annotations

from typing import Any

import numpy as np
from rasterio.features import geometry_mask
from shapely.geometry import LineString
from skimage.graph import route_through_array

from src.config import (
    COST_R_REF,
    COST_W_ROUGH,
    COST_W_SLOPE,
    MAX_SLOPE_DEG,
)


def cost_surface(
    slope: np.ndarray,
    rough: np.ndarray,
    max_slope: float = MAX_SLOPE_DEG,
    w_s: float = COST_W_SLOPE,
    w_r: float = COST_W_ROUGH,
    r_ref: float = COST_R_REF,
) -> np.ndarray:
    """Cell cost = 1 + w_s*(slope/10)^2 + w_r*(rough/r_ref). Inf where blocked."""
    cost = 1.0 + w_s * (slope / 10.0) ** 2 + w_r * (rough / r_ref)
    bad = ~np.isfinite(slope) | ~np.isfinite(rough) | (slope > max_slope)
    cost[bad] = np.inf
    return cost


def find_route(
    cost: np.ndarray,
    start_rc: tuple[int, int],
    end_rc: tuple[int, int],
    res: float,
) -> dict[str, Any] | None:
    """
    Returns path (row,col), cumulative distance, total length, or None if no path.
    """
    path, total = route_through_array(
        cost, start_rc, end_rc, fully_connected=True, geometric=True
    )
    if not np.isfinite(total):
        return None

    p = np.asarray(path)
    steps = np.hypot(*np.diff(p, axis=0).T) * res
    return {
        "path": p,
        "cum_m": np.concatenate([[0.0], np.cumsum(steps)]),
        "length_m": float(steps.sum()),
        "total_cost": float(total),
    }


def rc_to_xy(path: np.ndarray, transform) -> tuple[np.ndarray, np.ndarray]:
    """path is (row, col); returns x, y in the CRS of the transform."""
    # Affine: x = c + col * a, y = f + row * e  (north-up → e usually negative)
    x = transform.c + (path[:, 1] + 0.5) * transform.a
    y = transform.f + (path[:, 0] + 0.5) * transform.e
    return x, y


def corridor_stats(
    route: dict,
    dem: np.ndarray,
    slope: np.ndarray,
    rough: np.ndarray,
    transform,
    half_width_m: float,
) -> dict[str, Any]:
    """Buffer the route, collect valid slope/roughness samples + along-route profile."""
    x, y = rc_to_xy(route["path"], transform)
    line = LineString(np.column_stack([x, y])).buffer(half_width_m)
    inside = geometry_mask(
        [line], out_shape=dem.shape, transform=transform, invert=True
    )

    pr = route["path"][:, 0]
    pc = route["path"][:, 1]
    ok = inside & np.isfinite(slope) & np.isfinite(rough)

    return {
        "slope_vals": slope[ok].astype(np.float64),
        "rough_vals": rough[ok].astype(np.float64),
        "valid_fraction": float(ok.sum() / max(inside.sum(), 1)),
        "profile": {
            "dist_m": route["cum_m"],
            "elev_m": dem[pr, pc],
            "slope_deg": slope[pr, pc],
            "rough_m": rough[pr, pc],
        },
    }
