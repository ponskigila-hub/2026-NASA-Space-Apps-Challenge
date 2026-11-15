"""Combine terrain with comparable lighting and mineral evidence."""
from functools import lru_cache
from hashlib import sha256
import logging

from .analog_sites import NASA_ANALOGS
from .config import NOMINAL_WEIGHTS, REGIONS, SCIENCE
from .lighting import analyze_lighting
from .minerals import analyze_minerals, M3_DATA, EMIT_DATA
from .prepare_science import MOON_GEOLOGY

LOG = logging.getLogger(__name__)
SOURCES = [
    {"id": "NAIF-DE440", "regions": ["moon"], "kind": "solar geometry", "version": "DE440 / ME421",
     "url": "https://naif.jpl.nasa.gov/naif/data_lunar.html", "license": "NASA NAIF public archive"},
    {"id": "USGS-lunar-geology", "regions": ["moon"], "kind": "mapped geology", "version": "2020, 1:5M",
     "url": MOON_GEOLOGY, "license": "USGS public data"},
    {"id": "GLiM", "regions": list(REGIONS), "kind": "mapped lithology", "version": "1.1",
     "url": "https://doi.org/10.1029/2012GC004370", "license": "Hartmann and Moosdorf (2012)"},
    {"id": "M3-L2", "regions": ["moon"], "kind": "reflectance catalogue", "version": "1.0",
     "url": M3_DATA, "license": "NASA PDS public archive"},
    {"id": "EMIT-L2A", "regions": [*REGIONS, *NASA_ANALOGS, "custom"], "kind": "reflectance catalogue", "version": "001",
     "url": EMIT_DATA, "license": "NASA Earthdata"},
    {"id": "pvlib-SPA", "regions": [*REGIONS, *NASA_ANALOGS, "custom"], "kind": "solar geometry", "version": "0.16.1",
     "url": "https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.solarposition.get_solarposition.html",
     "license": "BSD 3-Clause"},
]


@lru_cache(maxsize=1)
def science_version():
    digest = sha256(b"lighting-closest-frame-v2")
    for path in sorted([SCIENCE / "manifest.json", *(SCIENCE / "spectra").glob("*.json"),
                        *(SCIENCE / "spectra").glob("*.tif")]):
        if path.is_file():
            digest.update(path.name.encode())
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(2**20), b""):
                    digest.update(block)
    return digest.hexdigest()[:16]


def enrich(data, lunar_utc, earth_start, remote_grids=None):
    try:
        lighting, light_sites = analyze_lighting(data, lunar_utc, earth_start, remote_grids)
    except Exception:
        LOG.exception("Could not compute lighting evidence")
        lighting, light_sites = {"status": "unavailable", "reason": "Solar or terrain-horizon calculation failed."}, {}
    try:
        minerals, mineral_sites = analyze_minerals(data)
    except Exception:
        LOG.exception("Could not compute mineral evidence")
        minerals, mineral_sites = {"spectral": {"status": "unavailable",
                                 "reason": "A geology or calibrated reflectance input could not be read."}}, {}
    return {"lighting": lighting, "minerals": minerals,
            "candidateScience": {c["id"]: {"lighting": light_sites.get(c["id"]), "minerals": mineral_sites.get(c["id"])}
                                 for c in data["candidates"]}}


def rankings(candidates):
    eligible = [c for c in candidates if c["status"] == "matched"]
    light = bool(eligible) and all((c.get("lighting") or {}).get("score") is not None for c in eligible)
    shared_bands = set.intersection(*(set((c.get("minerals") or {}).get("bandScores", {})) for c in eligible)) if eligible else set()
    result = {}
    for preset, weights in NOMINAL_WEIGHTS.items():
        active = {name: weight for name, weight in weights.items()
                  if name in {"slope", "roughness"} or (name == "lighting" and light) or (name == "mineral" and shared_bands)}
        weights = {name: weight / sum(active.values()) for name, weight in active.items()}
        scores = {}
        for candidate in eligible:
            evidence = dict(candidate["featureScores"])
            if light:
                evidence["lighting"] = candidate["lighting"]["score"]
            if shared_bands:
                measured = candidate["minerals"]["bandScores"]
                evidence["mineral"] = sum(measured[key] for key in sorted(shared_bands)) / len(shared_bands)
            scores[candidate["id"]] = sum(weight * evidence[name] for name, weight in weights.items())
        ordered = sorted(scores, key=lambda key: (-scores[key], key))
        result[preset] = {"weights": weights, "sharedBands": sorted(shared_bands),
                          "sites": {key: {"score": scores[key], "rank": i} for i, key in enumerate(ordered, 1)}}
    return result


def apply_preset(result, preset):
    ranking = result.get("rankings", {}).get(preset)
    if ranking is None:
        return {**result, "preset": preset}
    sites = ranking["sites"]
    candidates = [{**candidate, **sites.get(candidate["id"], {})} for candidate in result["candidates"]]
    candidates.sort(key=lambda candidate: (candidate.get("rank", float("inf")), candidate["id"]))
    return {**result, "preset": preset, "candidates": candidates, "effectiveWeights": ranking["weights"],
            "rankingMode": "combined" if len(ranking["weights"]) > 2 else "terrain_only"}
