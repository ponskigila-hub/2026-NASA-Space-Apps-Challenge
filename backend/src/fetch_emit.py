"""Discover, fetch and evaluate NASA EMIT scenes for a selected route."""
import argparse
import json
import logging
import re
from contextlib import ExitStack
from urllib.parse import urlsplit

import h5py
import httpx
import numpy as np
from affine import Affine
from aiohttp import ClientError

from .config import FRONTEND, REGIONS
from .minerals import MIN_COVERAGE, MIN_PIXELS, mineral_score, spectral_route_points, spectral_samples, summarize_spectra

LOG = logging.getLogger(__name__)
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
FILENAME = re.compile(r"EMIT_L2A_(RFL|MASK)_001_(\d{8}T\d{6}_\d+_\d+)\.nc")


def contains(point, polygon):
    inside = False
    for (a, b), (c, d) in zip(polygon, polygon[1:] + polygon[:1]):
        if (a > point["lat"]) != (c > point["lat"]):
            if point["lon"] < b + (d - b) * (point["lat"] - a) / (c - a):
                inside = not inside
    return inside


def scenes(route):
    points = route["path"]
    lon = [p["lon"] for p in points]
    lat = [p["lat"] for p in points]
    response = httpx.get(CMR, params={"collection_concept_id": "C2408750690-LPCLOUD", "page_size": 200,
                        "bounding_box": f"{min(lon)-.001},{min(lat)-.001},{max(lon)+.001},{max(lat)+.001}"}, timeout=20)
    response.raise_for_status()
    candidates = []
    for granule in response.json()["feed"]["entry"]:
        assets = {}
        suffix = granule["title"].removeprefix("EMIT_L2A_RFL_001_")
        for link in granule.get("links", []):
            url = urlsplit(link["href"])
            match = FILENAME.fullmatch(url.path.rsplit("/", 1)[-1])
            if url.scheme == "https" and url.netloc == "data.lpdaac.earthdatacloud.nasa.gov" and match and match[2] == suffix:
                assets[match[1]] = link["href"]
        if assets.keys() != {"RFL", "MASK"}:
            continue
        polygons = []
        for group in granule.get("polygons", []):
            for raw in group:
                coords = list(map(float, raw.split()))
                polygons.append(list(zip(coords[::2], coords[1::2])))
        if all(any(contains(p, polygon) for polygon in polygons) for p in points):
            candidates.append((float(granule["cloud_cover"]) if granule.get("cloud_cover") not in (None, "") else 100, granule["title"], assets))
    return sorted(candidates)


def remote_spectra(scene, url, source, quality, route):
    """Sample orthorectified route points using the scene's native pixel lookup."""
    points, distances = spectral_route_points(route)
    transform = ~Affine.from_gdal(*np.asarray(source.attrs["geotransform"], dtype=float))
    colrows = [transform @ (p["lon"], p["lat"]) for p in points]
    rowcols = [(int(np.floor(row)), int(np.floor(col))) for col, row in colrows]
    x, y = source["location/glt_x"], source["location/glt_y"]
    rfl = source["reflectance"]
    mask, band_mask = quality["mask"], quality["band_mask"]
    if mask.shape[:2] != rfl.shape[:2] or band_mask.shape[:2] != rfl.shape[:2]:
        raise ValueError("EMIT reflectance and mask footprints differ.")

    parameters = source["sensor_band_parameters"]
    wavelengths = parameters["wavelengths"][:]
    channels = np.flatnonzero((wavelengths >= 700) & (wavelengths <= 2490))
    channel_slice = slice(channels[0], channels[-1]+1)
    good = parameters["good_wavelengths"][:][channels] > 0 if "good_wavelengths" in parameters else True
    reflectance = np.full((len(points), len(channels)), np.nan)
    inside = np.array([0 <= r < x.shape[0] and 0 <= c < x.shape[1] for r, c in rowcols])

    lookup = {}
    for row, col in sorted({pixel for pixel, valid in zip(rowcols, inside) if valid}):
        native = int(y[row, col])-1, int(x[row, col])-1
        if 0 <= native[0] < rfl.shape[0] and 0 <= native[1] < rfl.shape[1]:
            lookup[row, col] = native

    clear = {}
    for row, col in sorted(set(lookup.values())):
        if mask[row, col, 7] == 0:
            flagged = np.unpackbits(band_mask[row, col, :])[channels]
            allowed = (flagged == 0) & good
            if allowed.any():
                clear[row, col] = allowed

    # Read each clear native pixel once, in file order, for the plot and both bands.
    spectra = {}
    for (row, col), allowed in clear.items():
        values = rfl[row, col, channel_slice][channels - channels[0]]
        spectra[row, col] = np.where(allowed & (values > 0) & np.isfinite(values), values, np.nan)

    for index, pixel in enumerate(rowcols):
        native = lookup.get(pixel)
        if native in spectra:
            reflectance[index] = spectra[native]
    return summarize_spectra({"scene": scene, "url": url}, wavelengths[channels], reflectance,
                             rowcols, inside, distances)


def fetch(result, site, strategy, progress=print):
    import earthaccess

    candidate = next(c for c in result["candidates"] if c["id"] == site)
    route = candidate["route"]
    existing = dict(candidate.get("minerals") or {})
    best = existing.get("spectral") or {}
    best_scores = existing.get("bandScores", {})
    _, lunar_bands = spectral_samples("moon", result["lunar"])

    def quality(spectral):
        bands = spectral.get("bands", {}).values()
        return (sum(b["coverage"] >= MIN_COVERAGE and b["independentPixels"] >= MIN_PIXELS for b in bands),
                sum(b["coverage"] for b in bands), any(p["median"] is not None for p in spectral.get("spectrum", [])))

    if best.get("status") == "available":
        return existing
    progress("Searching NASA for scenes that cover the route.")
    choices = [(scene, assets) for _, scene, assets in scenes(route) if scene != best.get("scene")][:3]
    if not choices:
        if best.get("scene"):
            return existing
        raise ValueError("NASA returned no EMIT scenes covering the complete route.")

    progress("Connecting to NASA Earthdata.")
    try:
        auth = earthaccess.login(strategy=strategy, persist=False)
    except Exception:
        raise PermissionError("Earthdata sign-in failed.") from None
    if not auth.authenticated:
        raise PermissionError("Earthdata sign-in is required to read EMIT data.")

    readable = 0
    for index, (scene, assets) in enumerate(choices, 1):
        progress(f"Reading route data from NASA scene {index} of {len(choices)}.")
        urls = [assets["RFL"], assets["MASK"]]
        try:
            with ExitStack() as stack:
                streams = earthaccess.open(urls, provider="LPCLOUD", show_progress=False,
                                           open_kwargs={"cache_type": "blockcache", "block_size": 1024**2,
                                                        "cache_options": {"maxblocks": 48}})
                for stream in streams:
                    stack.callback(stream.close)
                source, mask = [stack.enter_context(h5py.File(stream, "r", rdcc_nbytes=16*1024**2))
                                for stream in streams]
                spectral, earth_bands = remote_spectra(scene, assets["RFL"], source, mask, route)
        except (ClientError, OSError, ValueError, KeyError, RuntimeError) as error:
            LOG.warning("EMIT scene %s could not be read (%s, status %s)", scene,
                        type(error).__name__, getattr(error, "status", None))
            continue
        readable += 1
        if not best or quality(spectral) > quality(best):
            best, best_scores = spectral, mineral_score(lunar_bands, earth_bands)
        if best.get("status") == "available":
            break
    if not readable:
        raise RuntimeError("No candidate EMIT scene could be read.")
    return {**existing, "spectral": best, "bandScores": best_scores}


def replay(case):
    return json.loads((FRONTEND / "public" / "replay" / case / "analysis.json").read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=REGIONS)
    parser.add_argument("--replay", choices=("rille", "hadley"), default="rille")
    parser.add_argument("--list", action="store_true", help="Search the public catalogue without authentication.")
    args = parser.parse_args()
    result = replay(args.replay)
    if args.list:
        route = next(c["route"] for c in result["candidates"] if c["id"] == args.site)
        for cloud, scene, _ in scenes(route)[:5]:
            print(f"{scene} · {cloud:g}% catalog cloud cover")
        return
    evidence = fetch(result, args.site, "interactive")
    print(json.dumps({k: evidence["spectral"].get(k) for k in ("scene", "status", "bands")}, indent=2))


if __name__ == "__main__":
    main()
