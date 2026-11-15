"""Lunar routing regions and their published map metadata."""
from functools import lru_cache
from hashlib import file_digest, sha256

from .terrain import source_manifest
from .config import MAX_LENGTH, MOON_BOUNDS, MOON_RADIUS, PROCESSED

DEFAULT_LUNAR_REGION = "hadley"
LUNAR_REGIONS = {
    "hadley": {
        "id": "hadley", "name": "Hadley–Apennine", "shortName": "Hadley", "bounds": MOON_BOUNDS,
        "example": {"A": {"lat": 26.143017, "lon": 3.079142}, "B": {"lat": 26.357301, "lon": 4.389023}},
    },
    "serenitatis": {
        "id": "serenitatis", "name": "Mare Serenitatis", "shortName": "Mare Serenitatis",
        "bounds": (16.0, 23.4, 20.4, 26.4), "relief": "terrain/serenitatis-relief.webp",
        "example": {"A": {"lat": 24.8, "lon": 16.5}, "B": {"lat": 24.8, "lon": 19.13}},
    },
}
SERENITATIS_CRS = f"+proj=aeqd +lat_0=24.9 +lon_0=18.2 +R={MOON_RADIUS} +units=m +type=crs"


def lunar_grid_name(region_id):
    return "moon" if region_id == DEFAULT_LUNAR_REGION else region_id


def lunar_region(region_id):
    return {**LUNAR_REGIONS[region_id], "maxRouteKm": MAX_LENGTH / 1000}


def available_lunar_regions():
    return [lunar_region(region_id) for region_id in LUNAR_REGIONS
            if all((PROCESSED / (lunar_grid_name(region_id) + suffix)).is_file()
                   for suffix in (".json", ".npz"))]


def lunar_source(region):
    return {
        "id": "SLDEM2015-SERENITATIS", "kind": "elevation", "version": "SLDEM2015 V2.0",
        "regions": [region["id"]], "url": "https://pgda.gsfc.nasa.gov/products/54",
        "coverage": region["bounds"], "license": "NASA Planetary Data System public archive",
    }


@lru_cache(maxsize=len(LUNAR_REGIONS))
def terrain_version(region_id):
    version = source_manifest()["dataVersion"]
    if region_id == DEFAULT_LUNAR_REGION:
        return version
    digest = sha256(version.encode())
    for suffix in (".json", ".npz"):
        with (PROCESSED / (lunar_grid_name(region_id) + suffix)).open("rb") as stream:
            digest.update(file_digest(stream, "sha256").digest())
    return digest.hexdigest()[:16]
