"""Download published rasters, align them, and build the runtime terrain assets."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import file_digest, sha256
from math import ceil, floor
from urllib.request import urlopen
from xml.etree import ElementTree
import json
import shutil

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import Window, from_bounds
from scipy.ndimage import uniform_filter

from .config import (FRONTEND, MOON_BOUNDS, MOON_CRS, MOON_FRAME, MOON_GEO,
                     PROCESSED, RAW, REGIONS, RESOLUTION, ROUGHNESS_WINDOW, SEARCH_BUFFER,
                     SEARCH_HALF_WIDTH)

PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/jp2"
LUNAR_TILE = "sldem2015_512_00n_30n_000_045"
EARTH_BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"
WAC = "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0"
WAC_METADATA = "https://trek.nasa.gov/moon/TrekWS/rest/cat/metadata/fgdc/html?label=LRO_WAC_Mosaic_Global_303ppd_v02"


def download(url, name=None):
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / (name or url.rsplit("/", 1)[1])
    if not path.exists():
        partial = path.with_suffix(path.suffix + ".part")
        with urlopen(url, timeout=60) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output)
        partial.replace(path)
    return path


def checksum(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def earth_grid(region):
    transform = Transformer.from_crs("EPSG:4326", region["crs"], always_xy=True)
    x, y = transform.transform(*region["center"])
    h = region.get("searchHalfWidthM", SEARCH_HALF_WIDTH) + SEARCH_BUFFER
    return x - h, y - h, x + h, y + h


def earth_urls(bounds):
    west, south, east, north = bounds
    urls = []
    for lat in range(floor(south), ceil(north)):
        for lon in range(floor(west), ceil(east)):
            ns, ew = ("N" if lat >= 0 else "S"), ("E" if lon >= 0 else "W")
            tile = f"Copernicus_DSM_COG_10_{ns}{abs(lat):02}_00_{ew}{abs(lon):03}_00_DEM"
            urls.append(f"{EARTH_BUCKET}/{tile}/{tile}.tif")
    return urls


def generate_features(dem):
    valid = np.isfinite(dem)
    dy, dx = np.gradient(dem, RESOLUTION)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))
    window = ROUGHNESS_WINDOW // RESOLUTION
    support = uniform_filter(valid.astype(np.float32), window, mode="constant")
    local_mean = uniform_filter(np.where(valid, dem, 0), window, mode="constant") / np.maximum(support, 1e-6)
    residual_valid = valid & (support >= 0.8)
    residual2 = np.where(residual_valid, (dem - local_mean) ** 2, 0)
    residual_support = uniform_filter(residual_valid.astype(np.float32), window, mode="constant")
    mean_square = uniform_filter(residual2, window, mode="constant") / np.maximum(residual_support, 1e-6)
    rough = np.sqrt(np.maximum(mean_square, 0))
    rough[~valid | (residual_support < 0.8)] = np.nan
    slope[~valid] = np.nan
    return slope, rough


def build_window_index(slope, rough, eligible):
    valid = eligible & np.isfinite(slope) & np.isfinite(rough)
    arrays = [valid, np.where(valid, slope, 0), np.where(valid, rough, 0)]
    integrals = [np.pad(a.cumsum(axis=0, dtype=float).cumsum(axis=1), ((1, 0), (1, 0))) for a in arrays]
    output = []
    for km in (4, 8, 16, 32, 48, 64, 78, 88, 96):
        size = round(km * 1000 / RESOLUTION)
        stride = size // 2
        rows, cols = eligible.shape
        for r in sorted(set(range(0, rows - size + 1, stride)) | {rows - size}):
            for c in sorted(set(range(0, cols - size + 1, stride)) | {cols - size}):
                if r < 0 or c < 0:
                    continue
                sums = [a[r+size, c+size] - a[r, c+size] - a[r+size, c] + a[r, c] for a in integrals]
                if sums[0] >= size**2 * 0.80:
                    output.append([r, c, size, sums[0] / size**2, sums[1] / sums[0], sums[2] / sums[0]])
    return np.array(output, dtype=float).reshape(-1, 6)


def save_grid(name, dem, transform, crs, bounds, eligible, geog, *, lunar=False):
    slope, rough = generate_features(dem)
    eligible &= np.isfinite(dem) & np.isfinite(slope) & np.isfinite(rough)
    index = build_window_index(slope, rough, eligible) if not lunar else np.empty((0, 6))
    np.savez_compressed(PROCESSED / f"{name}.npz", dem=dem, slope=slope, rough=rough, eligible=eligible,
                        windows=index)
    meta = {"transform": list(transform)[:6], "crs": crs, "bounds": list(bounds), "geographicCrs": geog,
            "gridSpacingM": RESOLUTION, "validFraction": float(np.mean(np.isfinite(dem))),
            "shape": list(dem.shape)}
    (PROCESSED / f"{name}.json").write_text(json.dumps(meta, indent=2))
    if not lunar:
        save_relief(name, dem, transform, crs, bounds)
    print(name, meta["shape"], f"{meta['validFraction']:.1%} elevation coverage", flush=True)


def relief_image(dem, transform, crs, bounds):
    # Match Leaflet's Web Mercator image overlay so every route has local map context.
    dy, dx = np.gradient(dem, RESOLUTION)
    illumination = (1 - 0.7 * dx - 0.7 * dy) / np.sqrt(1 + dx**2 + dy**2)
    west, south, east, north = transform_bounds("EPSG:4326", "EPSG:3857", *bounds)
    shape = (min(dem.shape[0], 1000), min(dem.shape[1], 1000))
    dest_transform = rasterio.transform.from_bounds(west, south, east, north, shape[1], shape[0])
    dest = np.full(shape, np.nan, dtype=np.float32)
    reproject(illumination, dest, src_transform=transform, src_crs=crs, src_nodata=np.nan,
              dst_transform=dest_transform, dst_crs="EPSG:3857", dst_nodata=np.nan, resampling=Resampling.bilinear)
    brightness = np.nan_to_num(np.clip(dest, 0, 1.35) / 1.35)
    rgba = np.stack([30 + 124 * brightness, 32 + 121 * brightness, 24 + 107 * brightness,
                     255 * np.isfinite(dest)], axis=-1).astype(np.uint8)
    return Image.fromarray(rgba)


def save_relief(name, dem, transform, crs, bounds):
    output = FRONTEND / "public" / "terrain"
    output.mkdir(exist_ok=True)
    relief_image(dem, transform, crs, bounds).save(output / f"{name}-relief.webp", quality=84)
    (output / f"{name}-relief.json").write_text(json.dumps({"bounds": list(bounds)}))


def destination(bounds):
    x0, y0, x1, y1 = bounds
    transform = from_origin(floor(x0 / RESOLUTION) * RESOLUTION, ceil(y1 / RESOLUTION) * RESOLUTION,
                            RESOLUTION, RESOLUTION)
    width = ceil((x1 - transform.c) / RESOLUTION)
    height = ceil((transform.f - y0) / RESOLUTION)
    return np.full((height, width), np.nan, dtype=np.float32), transform


def centers(transform, shape):
    row, col = np.ogrid[:shape[0], :shape[1]]
    x = transform.c + (col + 0.5) * transform.a
    y = transform.f + (row + 0.5) * transform.e
    return np.broadcast_arrays(x, y)


def resample_sldem(bounds, crs):
    urls = [f"{PDS}/{LUNAR_TILE}{suffix}" for suffix in (".jp2", "_aux.xml", "_jp2.lbl")]
    with ThreadPoolExecutor(max_workers=3) as pool:
        image, aux, label = list(pool.map(download, urls))
    label_text = label.read_text()
    if "MEAN EARTH/POLAR AXIS OF DE421" not in label_text:
        raise ValueError("Unexpected lunar datum in PDS label")
    metadata = ElementTree.parse(aux)
    scale = float(metadata.findtext(".//Scale"))
    nodata = float(metadata.findtext(".//NoDataValue"))
    west, south, east, north = bounds
    with rasterio.open(image) as source:
        w = from_bounds(west - 0.1, south - 0.1, east + 0.1, north + 0.1, source.transform)
        window = Window(floor(w.col_off), floor(w.row_off), ceil(w.width) + 2, ceil(w.height) + 2)
        raw = source.read(1, window=window)
        source_transform = source.window_transform(window)
    elevations = np.where(raw == nodata, np.nan, raw * scale).astype(np.float32)
    dem, transform = destination(transform_bounds(MOON_GEO, crs, *bounds))
    reproject(elevations, dem, src_transform=source_transform, src_crs=MOON_GEO, src_nodata=np.nan,
              dst_transform=transform, dst_crs=crs, dst_nodata=np.nan, resampling=Resampling.average)
    x, y = centers(transform, dem.shape)
    lng, lat = Transformer.from_crs(crs, MOON_GEO, always_xy=True).transform(x, y)
    eligible = (lng >= west) & (lng <= east) & (lat >= south) & (lat <= north)
    return dem, transform, eligible, urls, (image, aux, label)


def prepare_moon():
    dem, transform, eligible, urls, files = resample_sldem(MOON_BOUNDS, MOON_CRS)
    save_grid("moon", dem, transform, MOON_CRS, MOON_BOUNDS, eligible, MOON_GEO, lunar=True)
    return {
        "id": LUNAR_TILE.upper(), "regions": ["moon"], "version": "V2.0", "kind": "elevation",
        "url": urls[2], "files": [{"url": url, "sha256": checksum(path)} for url, path in zip(urls, files)],
        "coverage": MOON_BOUNDS, "crs": MOON_FRAME, "verticalReference": "Height above a 1,737,400 m lunar sphere",
        "units": "m", "nativeResolutionM": 59.225, "analysisResolutionM": RESOLUTION,
        "license": "NASA Planetary Data System public archive",
        "processing": "Decoded with the PDS auxiliary scale 0.5 m/LSB and nodata -32768, reprojected by area averaging.",
    }


def prepare_earth(site_id, region):
    bounds = earth_grid(region)
    geobounds = transform_bounds(region["crs"], "EPSG:4326", *bounds)
    urls = earth_urls(geobounds)
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = list(pool.map(download, urls))
    dem, transform = destination(bounds)
    mosaic, source_transform = merge(paths, bounds=geobounds, nodata=np.nan, dtype="float32",
                                     target_aligned_pixels=True, masked=True)
    reproject(mosaic[0].filled(np.nan), dem, src_transform=source_transform, src_crs="EPSG:4326",
              src_nodata=np.nan, dst_transform=transform, dst_crs=region["crs"], dst_nodata=np.nan,
              resampling=Resampling.average)
    x, y = centers(transform, dem.shape)
    x0, y0, x1, y1 = bounds
    eligible = ((x >= x0 + SEARCH_BUFFER) & (x <= x1 - SEARCH_BUFFER)
                & (y >= y0 + SEARCH_BUFFER) & (y <= y1 - SEARCH_BUFFER))
    save_grid(site_id, dem, transform, region["crs"], geobounds, eligible, "EPSG:4326")
    return {
        "id": f"copernicus-glo30-{site_id}", "regions": [site_id], "version": "GLO-30 Public, 2021 release",
        "kind": "elevation", "url": f"{EARTH_BUCKET}/readme.html", "coverage": geobounds,
        "files": [{"id": path.stem, "url": url, "sha256": checksum(path)} for url, path in zip(urls, paths)],
        "crs": "WGS 84", "verticalReference": "EGM2008 orthometric height",
        "units": "m", "nativeResolutionM": 30, "analysisResolutionM": RESOLUTION,
        "license": "Copernicus DEM GLO-30 public license",
        "processing": "Mosaicked source surface heights and averaged onto the local metric grid. Vegetation or structures may influence heights.",
    }


def prepare_basemap():
    zoom = 8
    size = 256
    scale = (2 ** (zoom + 1)) * size / 360
    west, south, east, north = MOON_BOUNDS
    x0, x1 = floor((west + 180) * scale), ceil((east + 180) * scale)
    y0, y1 = floor((90 - north) * scale), ceil((90 - south) * scale)
    c0, r0 = x0 // size, y0 // size
    tiles = [(r, c) for r in range(r0, ceil(y1 / size)) for c in range(c0, ceil(x1 / size))]

    def get_tile(rc):
        r, c = rc
        url = f"{WAC}/default/default028mm/{zoom}/{r}/{c}.jpg"
        return download(url, f"wac-{zoom}-{r}-{c}.jpg"), url

    with ThreadPoolExecutor(max_workers=10) as pool:
        images = list(pool.map(get_tile, tiles))
    composite = Image.new("RGB", (ceil(x1 / size) * size - c0 * size, ceil(y1 / size) * size - r0 * size))
    for (r, c), (path, _) in zip(tiles, images):
        with Image.open(path) as tile:
            if tile.size != (size, size):
                raise ValueError(f"Unexpected WAC tile dimensions in {path.name}")
            composite.paste(tile, ((c - c0) * size, (r - r0) * size))
    output = FRONTEND / "public" / "terrain"
    output.mkdir(exist_ok=True)
    composite.crop((x0-c0*size, y0-r0*size, x1-c0*size, y1-r0*size)).save(output / "hadley-wac.webp", quality=91)
    bounds = [x0/scale-180, 90-y1/scale, x1/scale-180, 90-y0/scale]
    (output / "hadley-wac.json").write_text(json.dumps({"bounds": bounds}))
    return {
        "id": "LRO_WAC_Mosaic_Global_303ppd_v02", "regions": ["moon"], "version": "2",
        "kind": "imagery", "url": WAC_METADATA, "coverage": bounds,
        "files": [{"url": url, "sha256": checksum(path)} for path, url in images],
        "crs": "Moon 2000 equirectangular tiles", "nativeResolutionM": 100,
        "license": "NASA Moon Trek public dataset. Credit LROC team.",
        "processing": "Moon Trek WMTS level 8 tiles stitched and cropped at pixel boundaries.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    PROCESSED.mkdir(parents=True, exist_ok=True)
    manifest = PROCESSED / "sources.json"
    manifest.unlink(missing_ok=True)
    sources = [prepare_moon()]
    sources.extend(prepare_earth(site_id, region) for site_id, region in REGIONS.items())
    sources.append(prepare_basemap())
    routes = json.loads((FRONTEND / "src" / "data" / "earth-routes.json").read_text())
    for route in routes:
        sources.append({
            "id": f"sentinel-2-{route['id']}", "regions": [route["id"]], "version": "L2A",
            "kind": "imagery", "url": route["imagery"][0], "sceneUrls": route["imagery"],
            "coverage": route["bounds"], "crs": "WGS 84 overlay", "nativeResolutionM": 10,
            "license": "Modified Copernicus Sentinel data 2024",
            "processing": "Bundled frontend imagery for context.",
        })
    digest = sha256()
    for source in sources:
        digest.update(json.dumps(source, sort_keys=True).encode())
        source["preparedUtc"] = datetime.now(timezone.utc).isoformat()
    for path in sorted(path for path in PROCESSED.iterdir() if path.suffix in (".json", ".npz")):
        digest.update(checksum(path).encode())
    temporary = manifest.with_suffix(".tmp")
    temporary.write_text(json.dumps({"dataVersion": digest.hexdigest()[:16], "sources": sources}, indent=2))
    temporary.replace(manifest)


if __name__ == "__main__":
    main()
