"""Discover, fetch and evaluate NASA EMIT scenes for a selected route."""
import argparse
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

import httpx

from .config import CACHE, FRONTEND, REGIONS
from .minerals import mineral_score, spectral_samples
from .prepare_emit import prepare

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
        return (sum(b["coverage"] >= .7 and b["independentPixels"] >= 5 for b in bands),
                sum(b["coverage"] for b in bands), any(p["median"] is not None for p in spectral.get("spectrum", [])))

    progress("Searching NASA for scenes that cover the route.")
    choices = scenes(route)
    if not choices:
        raise ValueError("NASA returned no EMIT scenes covering the complete route.")
    (CACHE / "emit").mkdir(parents=True, exist_ok=True)
    auth = None
    if best.get("status") == "available":
        return existing
    attempted = 0
    for _, scene, assets in choices:
        if scene == best.get("scene"):
            continue
        if attempted >= 3:
            break
        attempted += 1
        folder = CACHE / "emit" / scene
        if not (folder / f"{site}.json").is_file():
            if auth is None:
                progress("Connecting to NASA Earthdata.")
                try:
                    auth = earthaccess.login(strategy=strategy, persist=False)
                except Exception:
                    raise PermissionError("Earthdata sign-in failed. Check your local credentials and authorize LP DAAC in Earthdata Login.") from None
                if not auth.authenticated:
                    raise PermissionError("Earthdata sign-in is required to fetch the files.")
            progress(f"Fetching scene {attempted} of up to 3 from NASA.")
            with TemporaryDirectory(prefix="emit-", dir=folder.parent) as temp:
                paths = {kind: Path(temp) / url.rsplit("/", 1)[-1] for kind, url in assets.items()}
                earthaccess.download(list(assets.values()), temp, threads=2)
                if not all(path.is_file() for path in paths.values()):
                    raise RuntimeError("NASA did not return both EMIT files. Check LP DAAC access in Earthdata Login.")
                progress("Applying the quality mask and measuring coverage along the route.")
                prepare(site, paths["RFL"], paths["MASK"], folder)
        spectral, earth_bands = spectral_samples(site, route, folder)
        if not best or quality(spectral) > quality(best):
            best, best_scores = spectral, mineral_score(lunar_bands, earth_bands)
        if best.get("status") == "available":
            break
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
    (CACHE / "emit").mkdir(parents=True, exist_ok=True)
    evidence = fetch(result, args.site, "interactive")
    print(json.dumps({k: evidence["spectral"].get(k) for k in ("scene", "status", "bands")}, indent=2))


if __name__ == "__main__":
    main()
