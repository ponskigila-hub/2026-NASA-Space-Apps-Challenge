"""
Shared configuration for Earth Analogs for a Lunar Route
NASA Space Apps Challenge 2026 · Hadley Rille target
All values live here. [VERIFY] items must be confirmed against product labels.
"""

from pathlib import Path

# Paths
ROOT = Path(__file__).resolve().parents[1]
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
KERNELS = ROOT / "kernels"
OUTPUTS = ROOT / "outputs"
SOURCES_JSON = ROOT / "sources.json"

# Moon site (Hadley Rille / Apollo 15 vicinity)
# [VERIFY] exact coordinates against LOLA product and Apollo 15 site
MOON_SITE = {
    "name": "Hadley Rille",
    "lat": 26.1,
    "lon": 3.6,
}

# Bounding box in degrees: west, south, east, north
# [FLAG] handoff notes this is ~35.4 x 30.3 km; grid uses ~40 km half-size
# Widen slightly if shadow padding is needed (issue 3)
MOON_BBOX = (3.0, 25.6, 4.3, 26.6)

MOON_RADIUS_M = 1_737_400.0  # confirmed in LDEM_1024 label (OFFSET)

# Product actually ordered by the team (from cartorder label)
LOLA_PRODUCT_ID = "LDEM_1024_15N_30N_000_030"
LOLA_PPD = 1024
LOLA_PIXEL_M = 30323.0 / LOLA_PPD          # ≈ 29.612 m
LOLA_SCALING_FACTOR = 0.5                  # HEIGHT = DN * 0.5
LOLA_OFFSET_M = 1_737_400.0

# Stereographic centred on the site
MOON_CRS = (
    "+proj=stere +lat_0=26.1 +lon_0=3.6 "
    "+R=1737400 +units=m +no_defs"
)

# Geographic Moon CRS
MOON_LONLAT = "+proj=longlat +R=1737400 +no_defs"

# Earth regions (lat, lon) — [VERIFY] against literature / maps
EARTH_REGIONS = {
    "Pinacate": {"lat": 31.8, "lon": -113.5, "name": "Pinacate Volcanic Field, Sonora, Mexico"},
    "Harrat_Khaybar": {"lat": 25.2, "lon": 39.8, "name": "Harrat Khaybar, Saudi Arabia"},
    "Payun_Matru": {"lat": -36.4, "lon": -69.2, "name": "Payun Matru volcanic field, Mendoza, Argentina"},
}

# Route design targets
ROUTE_LENGTH_M = (5000.0, 10000.0)  # design target range
CORRIDOR_HALF_WIDTH_M = 500.0
ROUGH_WINDOW_M = 500.0
MAX_SLOPE_DEG = 20.0

# Cost surface defaults [DECIDE]
COST_W_SLOPE = 1.0
COST_W_ROUGH = 0.5
COST_R_REF = 5.0  # metres

# Scoring floors [tune]
FLOORS = {
    "slope": 2.0,   # degrees
    "rough": 0.3,   # metres
}

# Presets (weights)
PRESETS = {
    "rover_navigation": {
        "slope": 0.35,
        "rough": 0.35,
        "lighting": 0.25,
        "minerals": 0.05,
    },
    "camera_lighting": {
        "slope": 0.15,
        "rough": 0.15,
        "lighting": 0.60,
        "minerals": 0.10,
    },
    "mineral_mapping": {
        "slope": 0.10,
        "rough": 0.10,
        "lighting": 0.15,
        "minerals": 0.65,
    },
}

# Earth search parameters
SEARCH_WINDOW_FACTOR = 1.3
SEARCH_STRIDE_FACTOR = 0.5
SEARCH_K = 15
SEARCH_N_PAIRS = 12
SEARCH_LENGTH_TOL = 0.15
SEARCH_BUDGET_S = 60
SEARCH_SEED = 42

# Lighting
SHADOW_MAX_DIST_M = 5000.0
LIGHTING_ELEV_TOL_DEG = 2.0
LIGHTING_SHADOW_TOL = 0.10

# Confidence thresholds [DECIDE]
CONF_HIGH = {"filled": 0.05, "corridor_valid": 0.90}
CONF_MED = {"filled": 0.15, "corridor_valid": 0.75}

# Version string for cache keys
VERSION = "v0.1.0-skeleton"
