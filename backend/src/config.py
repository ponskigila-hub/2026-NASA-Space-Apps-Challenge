"""Versioned terrain settings and analysis coverage."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT.parent / "frontend"
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
CACHE = ROOT / "data" / "cache"
RESOLUTION = 90
ROUGHNESS_WINDOW = 450
CORRIDOR_WIDTH = 500
MIN_COVERAGE = 0.95
MAX_GRADE = 20
SNAP_RADIUS = RESOLUTION * 2
MAX_LENGTH = 75_000
SEARCH_BUFFER = 2_000
SEARCH_HALF_WIDTH = 40_000
SEARCH_DEADLINE = 60
ALGORITHM_VERSION = "1.2.0-experiment"
MOON_RADIUS = 1_737_400
MOON_FRAME = "Mean Earth / Polar Axis (DE421), planetocentric, east-positive"
MOON_GEO = f"+proj=longlat +R={MOON_RADIUS} +type=crs"
MOON_BOUNDS = (2.5, 25.4, 4.9, 27.0)
MOON_CRS = f"+proj=aeqd +lat_0=26.2 +lon_0=3.7 +R={MOON_RADIUS} +units=m +type=crs"
REGIONS = {
    "pinacate": {"name": "Pinacate", "location": "Sonora, Mexico", "center": (-113.445, 31.775),
                 "crs": "EPSG:32612", "description": "Apollo training benchmark with lava flows and crater rims."},
    "harrat-khaybar": {"name": "Harrat Khaybar", "location": "Western Saudi Arabia", "center": (39.94, 25.67),
                      "crs": "EPSG:32637", "description": "Arid volcanic terrain with basalt flows, domes, and cones."},
    "payun-matru": {"name": "Payún Matrú", "location": "Mendoza, Argentina", "center": (-69.25, -36.5),
                   "crs": "EPSG:32719", "description": "Volcanic cones and lava fields around an Andean caldera."},
}
PRESETS = {
    "rover_navigation": "Rover navigation",
    "camera_lighting": "Camera / lighting",
    "mineral_mapping": "Mineral mapping",
}
TERRAIN_WEIGHTS = {"slope": 0.5, "roughness": 0.5}
SCALE_FLOORS = {"slope": 1.0, "roughness": 1.0}

SCIENCE = ROOT / "data" / "science"
DEFAULT_LUNAR_UTC = "2026-11-18T00:00:00Z"
NOMINAL_WEIGHTS = {
    "rover_navigation": {"slope": .35, "roughness": .35, "lighting": .25, "mineral": .05},
    "camera_lighting": {"slope": .15, "roughness": .15, "lighting": .60, "mineral": .10},
    "mineral_mapping": {"slope": .10, "roughness": .10, "lighting": .15, "mineral": .65},
}
