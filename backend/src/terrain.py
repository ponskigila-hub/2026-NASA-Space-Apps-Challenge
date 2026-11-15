"""Load versioned terrain grids and turn solver output into geographic profiles."""
from functools import lru_cache
from math import atan2, cos, radians, sin, sqrt
import json

import numpy as np
from affine import Affine
from pyproj import Transformer
from scipy.ndimage import distance_transform_edt

from .config import CORRIDOR_WIDTH, MOON_RADIUS, PROCESSED, RESOLUTION
from .routing import path_distances


@lru_cache(maxsize=1)
def source_manifest():
    return json.loads((PROCESSED / "sources.json").read_text())


class Grid:
    def __init__(self, name):
        with np.load(PROCESSED / f"{name}.npz") as data:
            self.dem = data["dem"]
            self.rough = data["rough"]
            self.slope = data["slope"]
            self.valid = data["eligible"]
            self.windows = data["windows"]
        self.set_metadata(json.loads((PROCESSED / f"{name}.json").read_text()))

    @classmethod
    def from_arrays(cls, dem, slope, rough, eligible, windows, meta):
        grid = cls.__new__(cls)
        grid.dem, grid.slope, grid.rough = dem, slope, rough
        grid.valid, grid.windows = eligible, windows
        grid.set_metadata(meta)
        return grid

    def set_metadata(self, meta):
        self.meta = meta
        self.transform = Affine(*self.meta["transform"])
        self.to_metric = Transformer.from_crs(self.meta["geographicCrs"], self.meta["crs"], always_xy=True)
        self.to_geo = Transformer.from_crs(self.meta["crs"], self.meta["geographicCrs"], always_xy=True)

    def project(self, point):
        x, y = self.to_metric.transform(point["lon"], point["lat"])
        col, row = (~self.transform) @ (x, y)
        return row - 0.5, col - 0.5

    def geographic(self, rows, cols):
        x, y = self.transform @ (np.asarray(cols) + 0.5, np.asarray(rows) + 0.5)
        return self.to_geo.transform(x, y)

    def corridor(self, cells):
        # Include unknown cells outside the array in the coverage denominator.
        pad = int(np.ceil(CORRIDOR_WIDTH / RESOLUTION))
        r0, c0 = cells.min(axis=0) - pad
        r1, c1 = cells.max(axis=0) + pad + 1
        local = np.ones((r1 - r0, c1 - c0), dtype=bool)
        local[cells[:, 0] - r0, cells[:, 1] - c0] = False
        mask = distance_transform_edt(local, sampling=RESOLUTION) <= CORRIDOR_WIDTH
        first_row, last_row = max(r0, 0), min(r1, self.dem.shape[0])
        first_col, last_col = max(c0, 0), min(c1, self.dem.shape[1])
        grid_slice = np.s_[first_row:last_row, first_col:last_col]
        clipped = mask[first_row-r0:last_row-r0, first_col-c0:last_col-c0]
        valid = clipped & np.isfinite(self.slope[grid_slice]) & np.isfinite(self.rough[grid_slice])
        samples = {"slope": self.slope[grid_slice][valid], "roughness": self.rough[grid_slice][valid]}
        return samples, float(valid.sum() / mask.sum()), int(mask.sum())

    def profile(self, cells, samples, coverage, support):
        elevation, rise, horizontal, distance = path_distances(self.dem, cells)
        lon, lat = self.geographic(cells[:, 0], cells[:, 1])
        grades = np.r_[0.0, np.degrees(np.arctan2(np.abs(rise), horizontal))]
        slope = self.slope[cells[:, 0], cells[:, 1]]
        roughness = self.rough[cells[:, 0], cells[:, 1]]
        path = [{"lat": float(y), "lon": float(x)} for x, y in zip(lon, lat)]
        return {
            "path": path,
            "lengthKm": float(distance[-1] / 1000),
            "ascentM": float(rise[rise > 0].sum()),
            "descentM": float(-rise[rise < 0].sum()),
            "steepestDeg": float(grades.max()),
            "profile": [
                {"point": point, "distanceKm": float(d / 1000), "elevationM": float(z),
                 "slopeDeg": float(s), "gradeDeg": float(g), "roughnessM": float(r)}
                for point, d, z, s, g, r in zip(path, distance, elevation, slope, grades, roughness)
            ],
            "corridor": {"coverage": coverage, "halfWidthM": CORRIDOR_WIDTH, "sampleCount": len(samples["slope"]),
                         "totalCells": support, **{
                             name: {"mean": float(np.mean(values)), "p90": float(np.percentile(values, 90))}
                             for name, values in samples.items()
                         }},
        }


@lru_cache(maxsize=4)
def load_grid(name):
    return Grid(name)


def lunar_distance(a, b):
    lat_a, lat_b = radians(a["lat"]), radians(b["lat"])
    d_lon = radians(b["lon"] - a["lon"])
    t = sin((lat_b - lat_a) / 2)**2 + cos(lat_a) * cos(lat_b) * sin(d_lon / 2)**2
    t = min(max(t, 0), 1)
    return 2 * MOON_RADIUS * atan2(sqrt(t), sqrt(1 - t))
