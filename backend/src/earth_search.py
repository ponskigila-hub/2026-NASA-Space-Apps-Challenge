"""Deterministic window shortlisting and route matching across the Earth regions."""
import numpy as np

from .config import MIN_COVERAGE, REGIONS, RESOLUTION
from .routing import path_distances, route_ab, snap_to_valid
from .scoring import score_terrain
from .terrain import load_grid


def shortlist(windows, target, lunar):
    minimum_size = min(78_000, max(4_000, 1.08 * target))
    sizes = np.unique(windows[:, 2])
    # Allow rounding of physical window sizes to a whole number of cells.
    size = next((value for value in sizes if value * RESOLUTION + RESOLUTION / 2 >= minimum_size), None)
    if size is None:
        return []
    candidates = windows[windows[:, 2] == size]
    slope = np.mean(lunar["slope"])
    roughness = np.mean(lunar["roughness"])
    differences = abs(candidates[:, 4] - slope) / max(slope, 1) + abs(candidates[:, 5] - roughness) / max(roughness, 1)
    ordered = sorted(zip(differences, candidates), key=lambda pair: (pair[0], pair[1][0], pair[1][1]))
    return [window for _, window in ordered[:10]]


def endpoint_pairs(size, target, seed):
    rng = np.random.default_rng(seed)
    base = rng.uniform(0, np.pi)
    for index in range(5):
        angle = base + index * np.pi / 5
        vector = np.array([np.sin(angle), np.cos(angle)])
        separation = min(target / RESOLUTION * (0.93 - 0.035 * (index % 3)),
                         (size - 5) / np.max(np.abs(vector)))
        half = vector * separation / 2
        room = np.maximum(0, (size - 5) / 2 - np.abs(half))
        midpoint = (size - 1) / 2 + rng.uniform(-0.75, 0.75, 2) * room
        yield midpoint - half, midpoint + half


def search_region(site_id, target, lunar_samples, grid=None, region=None):
    grid = load_grid(site_id) if grid is None else grid
    tolerance = max(target * 0.20, 2 * RESOLUTION)
    best = None
    coverage_rejected = False
    attempts = 0
    for window_number, window in enumerate(shortlist(grid.windows, target, lunar_samples)):
        row, col, size = map(int, window[:3])
        window_slice = np.s_[row:row + size, col:col + size]
        dem = grid.dem[window_slice]
        rough = grid.rough[window_slice]
        valid = grid.valid[window_slice]
        for requested_a, requested_b in endpoint_pairs(size, target, 230 + window_number):
            start = snap_to_valid(valid, *requested_a)
            end = snap_to_valid(valid, *requested_b)
            if start is None or end is None or start == end:
                continue
            attempts += 1
            path = route_ab(dem, rough, valid, start, end)
            if len(path) < 2:
                continue
            cells = np.asarray(path) + [row, col]
            length = path_distances(grid.dem, cells)[3][-1]
            if abs(length - target) > tolerance:
                continue
            samples, coverage, support = grid.corridor(cells)
            if coverage < MIN_COVERAGE:
                coverage_rejected = True
                continue
            features, terrain_score = score_terrain(lunar_samples, samples)
            score_key = (-terrain_score, abs(length - target), tuple(cells[0]), tuple(cells[-1]))
            if best is None or score_key < best[0]:
                best = score_key, cells, samples, coverage, support, features, terrain_score

    region = REGIONS[site_id] if region is None else region
    result = {k: region[k] for k in ("name", "location", "description")}
    result.update(id=site_id, attempts=attempts, bounds=grid.meta["bounds"], center={"lat": region["center"][1], "lon": region["center"][0]})
    if best is None:
        reason = (
            "Routes in the target length range had insufficient DEM corridor coverage."
            if coverage_rejected else "No eligible route within the target length range was found in the bounded search."
        )
        return {**result, "status": "unevaluable", "reason": reason}
    _, cells, samples, coverage, support, features, terrain_score = best
    return {**result, "status": "matched", "route": grid.profile(cells, samples, coverage, support),
            "featureScores": features, "score": terrain_score}
