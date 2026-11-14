"""Terrain similarity adapted from the prototype's Wasserstein scoring."""
import numpy as np
from scipy.stats import wasserstein_distance

from .config import SCALE_FLOORS, TERRAIN_WEIGHTS


def score_terrain(lunar, earth):
    scores = {
        name: float(np.exp(-wasserstein_distance(lunar[name], earth[name])
                           / max(float(np.std(lunar[name])), SCALE_FLOORS[name])))
        for name in TERRAIN_WEIGHTS
    }
    return scores, sum(TERRAIN_WEIGHTS[name] * score for name, score in scores.items())
