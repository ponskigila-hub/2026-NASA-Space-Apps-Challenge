"""Eight-connected least-cost solver adapted from the prototype's grid router."""
from heapq import heappop, heappush
from math import atan2, degrees, hypot, inf

import numpy as np
from numba import njit

from .config import MAX_GRADE, RESOLUTION, SNAP_RADIUS

NEIGHBORS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def snap_to_valid(valid, row, col, max_distance=SNAP_RADIUS):
    radius = max_distance / RESOLUTION
    rows, cols = valid.shape
    candidates = (
        (hypot(r - row, c - col), r, c)
        for r in range(max(0, int(np.ceil(row - radius))), min(rows, int(np.floor(row + radius)) + 1))
        for c in range(max(0, int(np.ceil(col - radius))), min(cols, int(np.floor(col + radius)) + 1))
        if valid[r, c] and hypot(r - row, c - col) <= radius
    )
    nearest = min(candidates, default=None)
    return (nearest[1], nearest[2]) if nearest else None


@njit(cache=True)
def route_ab(dem, rough, valid, start, end, distance_only=False):
    rows, cols = dem.shape
    distances = np.full((rows, cols), inf)
    parent = np.full((rows, cols), -1, dtype=np.int32)
    sr, sc = start
    er, ec = end
    # Numba needs a typed empty list on the no-path return.
    path = [start][:0]
    distances[sr, sc] = 0.0
    heap = [(hypot(er - sr, ec - sc) * RESOLUTION, 0.0, sr, sc)]
    while heap:
        _, cost, r, c = heappop(heap)
        if cost > distances[r, c]:
            continue
        if r == er and c == ec:
            path.append((r, c))
            while r != sr or c != sc:
                r, c = divmod(parent[r, c], cols)
                path.append((r, c))
            return path[::-1]
        for dr, dc in NEIGHBORS:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < rows and 0 <= nc < cols) or not valid[nr, nc]:
                continue
            if dr and dc and not (valid[r, nc] and valid[nr, c]):
                continue
            horizontal = hypot(dr, dc) * RESOLUTION
            rise = float(dem[nr, nc]) - float(dem[r, c])
            grade = degrees(atan2(abs(rise), horizontal))
            if grade > MAX_GRADE:
                continue
            step = hypot(horizontal, rise)
            if not distance_only:
                step *= 1 + grade / MAX_GRADE + (rough[r, c] + rough[nr, nc]) * 0.025
            total = cost + step
            if total < distances[nr, nc]:
                distances[nr, nc] = total
                parent[nr, nc] = r * cols + c
                heappush(heap, (total + hypot(er - nr, ec - nc) * RESOLUTION, total, nr, nc))
    return path


def path_distances(dem, cells):
    elevation = dem[cells[:, 0], cells[:, 1]].astype(float)
    horizontal = np.linalg.norm(np.diff(cells, axis=0), axis=1) * RESOLUTION
    rise = np.diff(elevation)
    lengths = np.hypot(horizontal, rise)
    return elevation, rise, horizontal, np.r_[0.0, lengths.cumsum()]
