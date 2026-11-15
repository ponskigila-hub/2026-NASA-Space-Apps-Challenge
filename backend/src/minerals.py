"""Route lithology and continuum-removed absorption bands from prepared reflectance."""
from collections import Counter
from functools import lru_cache
import json

import numpy as np
from scipy.stats import wasserstein_distance

from .config import SCIENCE
from .terrain import load_grid

M3_DATA = "https://doi.org/10.17189/1520414"
EMIT_DATA = "https://cmr.earthdata.nasa.gov/search/concepts/C2408750690-LPCLOUD.html"
BANDS = {
    "oneMicron": (750, 850, 1050, 1300),
    "twoMicron": (1600, 1800, 2250, 2420),
}
MIN_COVERAGE = .70
MIN_PIXELS = 5


@lru_cache(maxsize=4)
def geology_grid(site):
    path = SCIENCE / "geology" / f"{site}.npz"
    if path.is_file():
        with np.load(path) as data:
            return data["units"], data["labels"].tolist()
    return None


def lithology(site, route):
    layer = geology_grid(site)
    if layer is None:
        return {"coverage": 0, "units": [], "segments": []}
    codes, labels = layer
    grid = load_grid(site)
    cells = np.rint([grid.project(point) for point in route["path"]]).astype(int)
    identified = codes[cells[:, 0], cells[:, 1]]
    distances = np.array([entry["distanceKm"] for entry in route["profile"]])
    edges = np.r_[0, (distances[:-1]+distances[1:])/2, route["lengthKm"]]
    lengths = np.diff(edges)
    totals = Counter()
    for code, length in zip(identified, lengths):
        if code:
            totals[labels[code-1]] += length
    changes = np.r_[0, np.flatnonzero(np.diff(identified)) + 1, len(identified)]
    segments = [{"unit": labels[identified[a]-1] if identified[a] else "Unmapped",
                 "startKm": float(edges[a]), "endKm": float(edges[b])}
                for a, b in zip(changes[:-1], changes[1:])]
    return {"coverage": float(np.clip(sum(totals.values()) / route["lengthKm"], 0, 1)),
            "units": [{"name": unit, "fraction": float(value / route["lengthKm"])}
                      for unit, value in totals.most_common()], "segments": segments}


def extract_bands(wavelengths, reflectance):
    output = {}
    for name, (left, low, high, right) in BANDS.items():
        samples = np.arange(low, high+1, 20)
        x = np.r_[left, samples, right]
        if wavelengths[0] > x[0] or wavelengths[-1] < x[-1]:
            continue
        after = np.searchsorted(wavelengths, x)
        before = np.maximum(0, after - 1)
        # Avoid interpolating across large gaps between instrument channels.
        if np.any(wavelengths[after] - wavelengths[before] > 75):
            continue
        frac = (x - wavelengths[before]) / np.maximum(wavelengths[after] - wavelengths[before], 1e-8)
        interpolated = reflectance[:, before] * (1-frac) + reflectance[:, after] * frac
        continuum = interpolated[:, :1] + (interpolated[:, -1:] - interpolated[:, :1]) * (samples-left) / (right-left)
        good = (interpolated > 0).all(axis=1) & np.isfinite(interpolated).all(axis=1)
        relative = interpolated[:, 1:-1] / np.where(continuum > 0, continuum, 1)
        minimum = relative.argmin(axis=1)
        depth = 1 - relative[np.arange(len(relative)), minimum]
        measured = good & (depth >= .015) & (minimum != 0) & (minimum != len(samples)-1)
        output[name] = (depth[measured], samples[minimum[measured]], measured)
    return output


def spectral_route_points(route):
    count = max(2, min(501, int(route["lengthKm"] * 1000 / 280) + 1))
    profile = route["profile"]
    distances = [p["distanceKm"] for p in profile]
    indices = np.searchsorted(distances, np.linspace(0, route["lengthKm"], count))
    indices = np.minimum(indices, len(profile)-1)
    return [profile[i]["point"] for i in indices], [distances[i] for i in indices]


def spectral_samples(site, route, folder=None):
    import rasterio
    from pyproj import Transformer
    folder = folder or SCIENCE / "spectra"
    metadata = folder / f"{site}.json"
    if not metadata.is_file():
        reason = ("No calibrated M³ reflectance is installed." if site == "moon" else
                  "Use Fetch mineral data to look for EMIT measurements along this route.")
        return {"status": "unavailable", "reason": reason}, {}
    config = json.loads(metadata.read_text())
    path = folder / f"{site}.tif"
    wavelength = np.array(config["wavelengthNm"], dtype=float)
    if wavelength.size == 0 or not np.isfinite(wavelength).all() or np.any(np.diff(wavelength) <= 0):
        raise ValueError(f"Invalid wavelength metadata for {site}.")
    with rasterio.open(path) as raster:
        if len(wavelength) != raster.count or not raster.crs:
            raise ValueError(f"Reflectance raster or band metadata does not match {site}.")
        transform = Transformer.from_crs(load_grid(site).meta["geographicCrs"], raster.crs, always_xy=True)
        points, distances = spectral_route_points(route)
        xy = [transform.transform(p["lon"], p["lat"]) for p in points]
        rowcols = [raster.index(*position) for position in xy]
        inside = np.array([0 <= r < raster.height and 0 <= c < raster.width for r, c in rowcols])
        reflectance = np.full((len(points), raster.count), np.nan)
        reflectance[inside] = [sample.astype(float).filled(np.nan)
                               for sample in raster.sample([value for value, valid in zip(xy, inside) if valid], masked=True)]
    return summarize_spectra(config, wavelength, reflectance, rowcols, inside, distances)


def summarize_spectra(config, wavelength, reflectance, rowcols, inside, distances):
    unique_rows = list({pixel: i for i, pixel in enumerate(rowcols) if inside[i]}.values())
    spectrum = []
    if unique_rows:
        distinct = reflectance[unique_rows]
        for nm, channel in zip(wavelength, distinct.T):
            valid = channel[np.isfinite(channel) & (channel > 0)]
            if len(valid) >= max(1, len(unique_rows) / 2):
                low, median, high = np.quantile(valid, [.25, .5, .75])
                spectrum.append({"nm": float(nm), "median": float(median), "p25": float(low), "p75": float(high),
                                 "pixels": len(valid)})
            else:
                spectrum.append({"nm": float(nm), "median": None})
    bands = {}
    values = {}
    support = {}
    for name, (depth, center, measured) in extract_bands(wavelength, reflectance).items():
        coverage = float(measured.mean())
        support[name] = measured.tolist()
        sampled = [pixel for pixel, has_band in zip(rowcols, measured) if has_band]
        unique = sorted({pixel: index for index, pixel in enumerate(sampled)}.values())
        pixels = len(unique)
        if pixels:
            bands[name] = {"medianDepth": float(np.median(depth[unique])), "medianCenterNm": float(np.median(center[unique])),
                           "coverage": coverage, "independentPixels": pixels}
        if coverage >= MIN_COVERAGE and pixels >= MIN_PIXELS:
            values[name] = (depth[unique], center[unique])
    return {"status": "available" if values else "insufficient", "scene": config["scene"], "url": config["url"],
            "bands": bands, "spectrum": spectrum, "sampleDistancesKm": distances, "bandSupport": support,
            "reason": None if values else "Fewer than five distinct pixels or 70% route support for usable bands."}, values


def mineral_score(lunar, earth):
    shared = lunar.keys() & earth.keys()
    return {name: float(np.exp(-wasserstein_distance(lunar[name][0], earth[name][0])/.08
                               -wasserstein_distance(lunar[name][1], earth[name][1])/80)) for name in sorted(shared)}


def analyze_minerals(data):
    def read_spectra(site, route):
        try:
            return spectral_samples(site, route)
        except (OSError, ValueError, KeyError) as error:
            return {"status": "unavailable", "reason": f"Cannot read the prepared reflectance for {site}.",
                    "detail": str(error)}, {}

    if data.get("lunarRegion", {}).get("id", "hadley") == "hadley":
        moon, lunar_bands = read_spectra("moon", data["lunar"])
        lunar = {"lithology": lithology("moon", data["lunar"]), "spectral": moon}
    else:
        lunar_bands = {}
        lunar = {"spectral": {"status": "unavailable", "reason": "Lunar spectral and geology assets are available for Hadley–Apennine."}}
    candidates = {}
    for candidate in data["candidates"]:
        if candidate["status"] != "matched":
            continue
        site, route = candidate["id"], candidate["route"]
        spectral, earth_bands = read_spectra(site, route)
        candidates[site] = {"lithology": lithology(site, route), "spectral": spectral,
                            "bandScores": mineral_score(lunar_bands, earth_bands)}
    return lunar, candidates
