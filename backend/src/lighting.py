"""Sun geometry, DEM horizons, and candidate field-test windows."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
from numba import njit
import pandas as pd
from pyproj import Geod
from pvlib.solarposition import get_solarposition
import spiceypy as spice

from .analog_sites import NASA_ANALOGS
from .config import MOON_RADIUS, RESOLUTION, SCIENCE
from .prepare_science import KERNELS
from .lunar_regions import DEFAULT_LUNAR_REGION, lunar_grid_name
from .terrain import load_grid

TIMEZONES = {"pinacate": "America/Hermosillo", "harrat-khaybar": "Asia/Riyadh",
             "payun-matru": "America/Argentina/Mendoza"}
HORIZON_M = 12_000
AZIMUTH_STEP = 5
INTERVAL_MIN = 10
DAYS = 30
ELEVATION_TOLERANCE = 2
SHADOW_TOLERANCE = .10
MIN_SUPPORT = .95
METHOD = ("Geometric solar elevation at the route midpoint and DEM terrain shadows sampled along the route. "
          "Horizon search extends to 12 km at 5° azimuth spacing. Terrain and shadows below DEM resolution, "
          "reflected light, atmosphere and weather can affect camera tests.")


def lunar_sun(point, utc):
    lat, lon = np.radians([point["lat"], point["lon"]])
    pos, _ = spice.spkpos("SUN", spice.str2et(utc), "MOON_ME_DE440_ME421", "LT+S", "MOON")
    up = np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])
    east = np.array([-np.sin(lon), np.cos(lon), 0])
    north = np.cross(up, east)
    direction = pos - MOON_RADIUS / 1000 * up
    return (float(np.degrees(np.arcsin(np.dot(up, direction) / np.linalg.norm(direction)))),
            float(np.degrees(np.arctan2(np.dot(east, direction), np.dot(north, direction))) % 360))


@njit(cache=True)
def trace_horizons(dem, cells, directions, steps, radius):
    horizons = np.zeros((len(directions), len(cells)))
    known = np.ones_like(horizons, dtype=np.bool_)
    for i, (dy, dx) in enumerate(directions):
        for j, (r, c) in enumerate(cells):
            origin = dem[r, c]
            for step in range(1, steps + 1):
                rr = round(r + dy * step)
                cc = round(c + dx * step)
                if rr < 0 or rr >= dem.shape[0] or cc < 0 or cc >= dem.shape[1] or not np.isfinite(dem[rr, cc]):
                    known[i, j] = False
                    break
                distance = np.hypot(rr-r, cc-c) * RESOLUTION
                if distance > 0:
                    rise = dem[rr, cc] - origin - distance**2 / (2 * radius)
                    horizons[i, j] = max(horizons[i, j], np.degrees(np.arctan2(rise, distance)))
    return horizons, known


def route_horizons(site, route, grid=None):
    grid = load_grid(site) if grid is None else grid
    points = route["path"]
    indices = np.unique(np.append(np.arange(0, len(points), max(1, len(points) // 220)), len(points)-1))
    midpoint = min(route["profile"], key=lambda sample: abs(sample["distanceKm"] - route["lengthKm"]/2))
    location = midpoint["point"]
    lat, lon = location["lat"], location["lon"]
    azimuth = np.arange(0., 360., AZIMUTH_STEP)
    geod = Geod(a=MOON_RADIUS, b=MOON_RADIUS) if site == "moon" else Geod(ellps="WGS84")
    lng, lats, _ = geod.fwd(np.full_like(azimuth, lon), np.full_like(azimuth, lat), azimuth, np.full_like(azimuth, 1000))
    x0, y0 = grid.to_metric.transform(lon, lat)
    x, y = grid.to_metric.transform(lng, lats)
    directions = np.column_stack([y0-y, x-x0])
    directions /= np.linalg.norm(directions, axis=1)[:, None]
    cells = np.array([grid.project(points[i]) for i in indices]).round().astype(np.int64)
    distances = np.array([route["profile"][i]["distanceKm"] for i in indices])
    edges = np.r_[0, (distances[:-1] + distances[1:]) / 2, route["lengthKm"]]
    weights = np.diff(edges) / route["lengthKm"]
    radius = MOON_RADIUS if site == "moon" else 6_371_000
    horizons, known = trace_horizons(grid.dem, cells, directions, HORIZON_M // RESOLUTION, radius)
    return location, midpoint["elevationM"], indices, horizons, known, weights


def shadow_at(horizons, known, weights, elevations, azimuths):
    position = np.asarray(azimuths) / AZIMUTH_STEP
    lower = position.astype(int) % len(horizons)
    upper = (lower + 1) % len(horizons)
    fraction = (position % 1)[:, None]
    elevation = np.asarray(elevations)[:, None]
    outline = horizons[lower] * (1-fraction) + horizons[upper] * fraction
    shadowed = outline > elevation
    night = elevation <= 0
    # An already-observed obstruction establishes shadow even if farther terrain is unknown.
    reliable = night | (known[lower] & (known[upper] | (fraction == 0))) | shadowed
    dark = night | shadowed
    support = reliable @ weights
    shadow = ((dark & reliable) @ weights) / np.maximum(support, 1e-9)
    return shadow, support, np.where(reliable, dark.astype(np.int8), -1)


def candidate_lighting(site, route, target, earth_start, grid=None):
    location, altitude, indices, horizons, known, weights = route_horizons(site, route, grid)
    dates = pd.date_range(earth_start, periods=DAYS*24*60//INTERVAL_MIN, freq=f"{INTERVAL_MIN}min", tz="UTC")
    sun = get_solarposition(dates, location["lat"], location["lon"], altitude=max(0, altitude))
    levels, azimuths = sun.elevation.to_numpy(), sun.azimuth.to_numpy()
    fractions, support, states = shadow_at(horizons, known, weights, levels, azimuths)
    usable = (levels > 0) & (support >= MIN_SUPPORT)
    if not usable.any():
        return {"windows": [], "score": None, "reason": "Insufficient valid daytime horizon coverage."}
    el_diff = abs(levels - target["elevationDeg"])
    sh_diff = abs(fractions - target["shadowFraction"])
    scores = np.exp(-el_diff / ELEVATION_TOLERANCE - sh_diff / SHADOW_TOLERANCE)
    eligible = np.flatnonzero(usable & (el_diff <= ELEVATION_TOLERANCE) & (sh_diff <= SHADOW_TOLERANCE))
    groups = [group for group in np.split(eligible, np.flatnonzero(np.diff(eligible) > 1) + 1) if len(group)]
    groups.sort(key=lambda group: -scores[group].max())
    timezone_name = TIMEZONES.get(site, NASA_ANALOGS.get(site, {}).get("timeZone", "UTC"))
    tz = ZoneInfo(timezone_name)
    def make_frame(index):
        return {
            "utc": dates[index].isoformat(), "local": dates[index].to_pydatetime().astimezone(tz).isoformat(),
            "elevationDeg": float(levels[index]), "azimuthDeg": float(azimuths[index]),
            "shadowFraction": float(fractions[index]), "coverage": float(np.clip(support[index], 0, 1)),
            "states": states[index].tolist(),
        }

    windows = []
    for group in groups[:5]:
        best = group[scores[group].argmax()]
        render = np.unique(np.append(np.linspace(group[0], group[-1], min(7, len(group)), dtype=int), best))
        frames = [make_frame(index) for index in render]
        windows.append({"startUtc": dates[group[0]].isoformat(), "endUtc": dates[group[-1]].isoformat(),
                        "startLocal": dates[group[0]].to_pydatetime().astimezone(tz).isoformat(),
                        "endLocal": dates[group[-1]].to_pydatetime().astimezone(tz).isoformat(),
                        "timeZone": timezone_name, "frames": frames, "bestFrame": int(np.flatnonzero(render == best)[0])})
    usable_indices = np.flatnonzero(usable)
    closest = usable_indices[scores[usable_indices].argmax()]
    return {"windows": windows, "score": float(scores[closest]), "sampleIndices": indices.tolist(),
            "closestFrame": None if windows else make_frame(closest),
            "reason": None if windows else "No daytime window met both the 2° Sun elevation and 10-point shadow tolerances."}


def analyze_lighting(data, lunar_utc, earth_start, remote_grids=None, lunar_grid=None):
    paths = [SCIENCE / "kernels" / name.split("/")[-1] for name in KERNELS]
    if not all(path.is_file() for path in paths):
        return {"status": "unavailable", "reason": "The NASA SPICE kernels have not been prepared."}, {}
    for path in paths:
        spice.furnsh(str(path))
    try:
        region_id = data.get("lunarRegion", {}).get("id", DEFAULT_LUNAR_REGION)
        location, _, indices, horizons, known, weights = route_horizons(
            "moon", data["lunar"], load_grid(lunar_grid_name(region_id)) if lunar_grid is None else lunar_grid)
        elevation, azimuth = lunar_sun(location, lunar_utc)
    finally:
        for path in reversed(paths):
            spice.unload(str(path))
    fraction, support, states = shadow_at(horizons, known, weights, [elevation], [azimuth])
    illumination = {"status": "available", "utc": lunar_utc, "earthStart": earth_start,
                    "earthDays": DAYS, "method": METHOD, "elevationDeg": elevation, "azimuthDeg": azimuth,
                    "shadowFraction": float(fraction[0]), "coverage": float(np.clip(support[0], 0, 1)),
                    "sampleIndices": indices.tolist(), "states": states[0].tolist()}
    if elevation <= 0 or support[0] < MIN_SUPPORT:
        message = ("The lunar Sun is below the horizon at this time." if elevation <= 0
                   else "The lunar route has insufficient known terrain horizon coverage.")
        return {**illumination, "status": "unavailable", "reason": message}, {}
    candidates = {c["id"]: candidate_lighting(c["id"], c["route"], illumination, earth_start,
                                             (remote_grids or {}).get(c["id"]))
                  for c in data["candidates"] if c["status"] == "matched"}
    return illumination, candidates
