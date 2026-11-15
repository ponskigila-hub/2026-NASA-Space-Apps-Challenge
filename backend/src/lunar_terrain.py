"""Prepare a bounded lunar routing grid from the SLDEM2015 tiles it intersects."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from math import ceil, floor
from urllib.error import URLError
from xml.etree import ElementTree

import numpy as np
from pyproj import Geod, Transformer
import rasterio
from rasterio.errors import RasterioError
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds

from .config import CACHE, MAX_LENGTH, MOON_GEO, MOON_RADIUS, RAW
from .lunar_names import locate
from .pipeline import AnalysisError
from .prepare import PDS, destination, download, generate_features
from .terrain import Grid

LATITUDE_BANDS = (-60, -30, 0, 30)
PADDING_M = 20_000
TILE_CACHE = CACHE / "lunar-tiles"


def fetch_tile_file(url):
    filename = url.rsplit("/", 1)[-1]
    bundled = RAW / filename
    if bundled.is_file():
        return bundled
    path = download(url, destination_dir=TILE_CACHE)
    path.touch()
    return path


def unwrap(lon, center):
    return center + (lon - center + 180) % 360 - 180


def tiles_for_bounds(west, south, east, north):
    for bottom in LATITUDE_BANDS:
        top = bottom + 30
        if top <= south or bottom >= north:
            continue
        hemisphere = "s" if bottom < 0 else "n"
        for left in range(floor(west / 45) * 45, ceil(east / 45) * 45, 45):
            column = left % 360
            key = (f"sldem2015_512_{abs(bottom):02}{hemisphere}_{abs(top):02}{hemisphere}"
                   f"_{column:03}_{column + 45:03}")
            yield key, left - column, (max(west, left), max(south, bottom),
                                       min(east, left + 45), min(north, top))


def read_tile(dem, transform, crs, item):
    key, shift, (west, south, east, north) = item
    urls = [f"{PDS}/{key}{suffix}" for suffix in (".jp2", "_aux.xml", "_jp2.lbl")]
    with ThreadPoolExecutor(max_workers=3) as pool:
        image, aux, label = pool.map(fetch_tile_file, urls)
    if "MEAN EARTH/POLAR AXIS OF DE421" not in label.read_text():
        raise ValueError("Unexpected lunar datum")
    metadata = ElementTree.parse(aux)
    scale = float(metadata.findtext(".//Scale"))
    nodata = float(metadata.findtext(".//NoDataValue"))
    with rasterio.open(image) as source:
        extent = from_bounds(west - shift, south, east - shift, north, source.transform)
        col, row = max(0, floor(extent.col_off) - 2), max(0, floor(extent.row_off) - 2)
        right = min(source.width, ceil(extent.col_off + extent.width) + 2)
        bottom = min(source.height, ceil(extent.row_off + extent.height) + 2)
        window = Window(col, row, right - col, bottom - row)
        raw = source.read(1, window=window)
        origin = Affine.translation(shift, 0) * source.window_transform(window)
    data = np.where(raw == nodata, np.nan, raw * scale).astype(np.float32)
    tile = np.full_like(dem, np.nan)
    reproject(data, tile, src_transform=origin, src_crs=MOON_GEO, src_nodata=np.nan,
              dst_transform=transform, dst_crs=crs, dst_nodata=np.nan, resampling=Resampling.average)
    valid = np.isfinite(tile)
    dem[valid] = tile[valid]
    return {"url": urls[2], "tile": key, "labelHash": sha256(label.read_bytes()).hexdigest()}


def prepare_route_grid(points):
    a, b = points["A"], points["B"]
    geod = Geod(a=MOON_RADIUS, b=MOON_RADIUS)
    azimuth, _, distance = geod.inv(a["lon"], a["lat"], b["lon"], b["lat"])
    lon, lat, _ = geod.fwd(a["lon"], a["lat"], azimuth, distance / 2)
    crs = f"+proj=aeqd +lat_0={lat} +lon_0={lon} +R={MOON_RADIUS} +units=m +type=crs"
    project = Transformer.from_crs(MOON_GEO, crs, always_xy=True)
    x, y = project.transform([a["lon"], b["lon"]], [a["lat"], b["lat"]])
    metric = (min(x) - PADDING_M, min(y) - PADDING_M, max(x) + PADDING_M, max(y) + PADDING_M)
    west, south, east, north = project.transform_bounds(*metric, direction="INVERSE", densify_pts=21)
    bounds = (unwrap(west, lon), max(-60, south), unwrap(east, lon), min(60, north))
    dem, transform = destination(metric)
    try:
        files = [read_tile(dem, transform, crs, item) for item in tiles_for_bounds(*bounds)]
    except (OSError, URLError, RasterioError, ValueError) as error:
        raise AnalysisError("lunar_elevation_unavailable", "NASA lunar elevation could not be loaded. Try again shortly.") from error
    cached = sorted(TILE_CACHE.glob("*.jp2"), key=lambda path: path.stat().st_mtime, reverse=True)
    for old in cached[6:]:
        old.unlink(missing_ok=True)
        for suffix in ("_aux.xml", "_jp2.lbl"):
            old.with_name(old.stem + suffix).unlink(missing_ok=True)
    slope, rough = generate_features(dem)
    valid = np.isfinite(dem) & np.isfinite(slope) & np.isfinite(rough)
    name = locate(lat, lon)
    title = f"Near {name['name']}" if name else "Custom lunar area"
    region = {"id": "auto", "name": title, "shortName": title, "bounds": bounds, "maxRouteKm": MAX_LENGTH / 1000}
    grid = Grid.from_arrays(dem, slope, rough, valid, np.empty((0, 6)), {
        "transform": list(transform)[:6], "crs": crs, "geographicCrs": MOON_GEO, "bounds": bounds,
    })
    return grid, region, files
