"""Run an analysis with prepared terrain and build the published result."""
import numpy as np

from .config import (ALGORITHM_VERSION, MAX_LENGTH, MIN_COVERAGE, MOON_BOUNDS, MOON_FRAME, MOON_RADIUS,
                     RESOLUTION, TERRAIN_WEIGHTS, REGIONS)
from .earth_search import search_region
from .routing import path_distances, route_ab, snap_to_valid
from .terrain import load_grid, lunar_distance, source_manifest

LIMITATIONS = [
    "Elevation products resolve regional terrain at the analysis grid scale. Subpixel hazards and surface mechanics require separate evaluation.",
    "Earth and lunar elevations use different vertical references. Compare profiles relative to the start of each route.",
    "Terrain similarity describes slope and roughness. Gravity, atmosphere, radiation, dust and temperature differ between Earth and the Moon.",
    "Field access, weather, permits and on-site hazards require a separate review.",
]


class AnalysisError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def snap_endpoints(points):
    grid = load_grid("moon")
    west, south, east, north = MOON_BOUNDS
    cells = []
    for label in ("A", "B"):
        point = points[label]
        if not (west <= point["lon"] <= east and south <= point["lat"] <= north):
            raise AnalysisError("outside_coverage", f"Point {label} is outside the Hadley Rille terrain coverage.")
        cell = snap_to_valid(grid.valid, *grid.project(point))
        if cell is None:
            raise AnalysisError("cannot_snap", f"Point {label} is more than 180 m from an eligible terrain cell.")
        cells.append(cell)
    if cells[0] == cells[1]:
        raise AnalysisError("identical_endpoints", "Choose two points that snap to different terrain cells.")
    lon, lat = grid.geographic(*np.asarray(cells).T)
    snapped = {label: {"lat": float(y), "lon": float(x)} for label, x, y in zip(("A", "B"), lon, lat)}
    direct = lunar_distance(snapped["A"], snapped["B"])
    # The local azimuthal-equidistant map's metric distances are at least the corresponding spherical distances.
    if direct > MAX_LENGTH:
        raise AnalysisError("length_limit", "The snapped points are more than 50 km apart.")
    return cells, snapped


def compute(cells, remote_regions=()):
    grid = load_grid("moon")
    start, end = cells
    path = np.array(route_ab(grid.dem, grid.rough, grid.valid, tuple(start), tuple(end)))
    if len(path) < 2:
        raise AnalysisError("no_path", "No lunar route connects these points within the terrain constraints.")
    if path_distances(grid.dem, path)[3][-1] > MAX_LENGTH:
        path = np.array(route_ab(grid.dem, grid.rough, grid.valid, tuple(start), tuple(end), True))
        if len(path) < 2 or path_distances(grid.dem, path)[3][-1] > MAX_LENGTH:
            raise AnalysisError("length_limit", "The shortest eligible lunar route exceeds 50 km.")
    samples, coverage, support = grid.corridor(path)
    if coverage < MIN_COVERAGE:
        raise AnalysisError("coverage", "The lunar route corridor has less than 95% valid terrain coverage.")
    lunar = grid.profile(path, samples, coverage, support)
    candidates = [search_region(site_id, lunar["lengthKm"] * 1000, samples) for site_id in REGIONS]
    for site_id, grid, region in remote_regions:
        if grid is None:
            lon, lat = region["center"]
            candidates.append({**{key: region[key] for key in ("name", "location", "description")},
                               "id": site_id, "center": {"lat": lat, "lon": lon},
                               "bounds": [lon, lat, lon, lat], "status": "unevaluable", "attempts": 0,
                               "reason": "Could not read public Copernicus elevation for this area."})
        else:
            candidates.append(search_region(site_id, lunar["lengthKm"] * 1000, samples, grid, region))
    candidates.sort(key=lambda candidate: (candidate["status"] != "matched", -candidate.get("score", 0), candidate["id"]))
    for index, candidate in enumerate((c for c in candidates if c["status"] == "matched"), 1):
        candidate["rank"] = index
    return {"lunar": lunar, "candidates": candidates}


def publish(data, requested, snapped, preset, analysis_id, science=None):
    from .science import SOURCES, apply_preset, rankings, science_version
    science = science or {}
    details = science.get("candidateScience", {})
    manifest = source_manifest()
    sources = manifest["sources"] + SOURCES + data.get("customSources", [])

    def evidence(route, region):
        relevant = [s for s in sources if region in s["regions"]]
        coverage = route["corridor"]["coverage"] if route else None
        quality = "unavailable" if coverage is None else "high" if coverage >= 0.99 else "moderate"
        return {"coverage": coverage, "confidence": quality, "analysisResolutionM": RESOLUTION,
                "sourceIds": [s["id"] for s in relevant],
                "confidenceBasis": "Valid corridor support at 90 m. High ≥99%, moderate ≥95%."}

    lunar = {**data["lunar"], "evidence": evidence(data["lunar"], "moon")}
    endpoints = {
        label: {
            "requested": requested[label], "snapped": snapped[label],
            "snapDistanceM": lunar_distance(requested[label], snapped[label]),
        } for label in ("A", "B")
    }
    candidates = [{**c, **details.get(c["id"], {}), "evidence": evidence(c.get("route"), c["id"])}
                  for c in data["candidates"]]
    result = {
        "id": analysis_id, "schemaVersion": 2, "algorithmVersion": ALGORITHM_VERSION,
        "dataVersion": manifest["dataVersion"], "preset": preset, "effectiveWeights": TERRAIN_WEIGHTS,
        "scienceVersion": science_version(), "mode": "live", "endpoints": endpoints,
        "lighting": science.get("lighting"), "minerals": science.get("minerals"),
        "rankings": rankings(candidates),
        "directKm": lunar_distance(requested["A"], requested["B"]) / 1000, "moonFrame": MOON_FRAME,
        "moonRadiusM": MOON_RADIUS, "lunar": lunar, "candidates": candidates,
        "sources": sources, "limitations": LIMITATIONS,
    }
    return apply_preset(result, preset)
