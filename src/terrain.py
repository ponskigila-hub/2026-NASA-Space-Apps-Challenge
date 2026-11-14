"""
Terrain feature computation (slope + roughness).
Identical calculation on Moon and Earth grids at the same metre pixel size.

Known issues from handoff §12:
1. Roughness = RMS residual from moving mean includes slope component.
   On a tilted plane it is NOT near zero.
   Analytic for square n×n window, gradient g: rms ≈ g * res * sqrt((n²-1)/12)
   [DECIDE] keep definition and update tests, or switch to local plane detrend.
2. uniform_filter default mode="reflect" inflates edge support counts.
   Use mode="constant", cval=0 so the validity mask works.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter


def slope_deg(dem: np.ndarray, res: float) -> np.ndarray:
    """Slope in degrees from a metric DEM using central differences."""
    dzdy, dzdx = np.gradient(dem, res)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def roughness_m(
    dem: np.ndarray,
    res: float,
    window_m: float = 500.0,
    min_support: float = 0.7,
) -> tuple[np.ndarray, int]:
    """
    RMS residual from local moving mean.
    Window size forced odd. Cells with support < min_support become NaN.
    """
    win = max(3, int(round(window_m / res)) | 1)  # force odd
    valid = np.isfinite(dem)
    z = np.where(valid, dem, 0.0)

    # Critical: mode="constant" so edges do not look fully supported
    n = uniform_filter(valid.astype(np.float32), size=win, mode="constant", cval=0.0)
    mean = uniform_filter(z, size=win, mode="constant", cval=0.0) / np.maximum(n, 1e-6)

    resid2 = np.where(valid, (dem - mean) ** 2, 0.0)
    rms = np.sqrt(
        uniform_filter(resid2, size=win, mode="constant", cval=0.0) / np.maximum(n, 1e-6)
    )
    rms[n < min_support] = np.nan
    return rms, win


def analytic_plane_roughness(grad: float, res: float, n: int) -> float:
    """
    Expected RMS residual for a perfect plane of gradient `grad`
    inside an n×n window (for unit tests). See handoff §12 item 1.
    """
    return abs(grad) * res * np.sqrt((n * n - 1) / 12.0)
