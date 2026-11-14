"""
Wasserstein feature scores + preset ranking.
Preserves unevaluable regions (handoff §12 item 5).
"""

from __future__ import annotations

from typing import Any

import numpy as np
from scipy.stats import wasserstein_distance

from src.config import FLOORS, PRESETS


def feature_score(
    moon_vals: np.ndarray,
    earth_vals: np.ndarray,
    floor: float,
) -> float:
    """exp(-D / s) where D = Wasserstein-1, s = max(std_moon, floor)."""
    if len(moon_vals) < 2 or len(earth_vals) < 2:
        return 0.0
    d = wasserstein_distance(moon_vals, earth_vals)
    s = max(float(np.std(moon_vals)), floor)
    return float(np.exp(-d / s))


def rank(
    candidates: list[dict[str, Any]],
    preset: str,
) -> tuple[list[dict], dict[str, float], dict[str, Any]]:
    """
    Rank evaluable candidates by weighted total.
    Unevaluable regions stay in the list (with reason) after the ranked ones.
    """
    if preset not in PRESETS:
        raise ValueError(f"Unknown preset: {preset}")

    ok = [c for c in candidates if c.get("status") == "ok"]
    uneval = [c for c in candidates if c.get("status") != "ok"]

    # Active features = those present for EVERY evaluable candidate
    feats = [
        f
        for f in PRESETS[preset]
        if all(c.get("scores", {}).get(f) is not None for c in ok)
    ]

    weights = {f: PRESETS[preset][f] for f in feats}
    total_w = sum(weights.values()) or 1.0
    weights = {f: v / total_w for f, v in weights.items()}

    for c in ok:
        c["total"] = sum(weights[f] * c["scores"][f] for f in feats)

    ok.sort(key=lambda c: (-c["total"], c.get("region", "")))

    # Keep unevaluable after the ranked list
    ranked = ok + uneval

    meta = {
        "terrain_only_proxy": preset == "mineral_mapping" and "minerals" not in feats,
        "active_features": feats,
        "effective_weights": weights,
    }
    return ranked, weights, meta
