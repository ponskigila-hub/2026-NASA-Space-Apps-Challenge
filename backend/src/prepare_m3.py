"""Extract the Hadley subset of a public M3 Level 2 scene and its L1B geolocation."""
import json
import re

import httpx
import numpy as np
import rasterio
from rasterio.transform import from_origin
from scipy.spatial import cKDTree

from .config import MOON_BOUNDS, MOON_CRS, MOON_GEO, RAW, SCIENCE
from pyproj import Transformer
from rasterio.warp import transform_bounds

BASE = "https://planetarydata.jpl.nasa.gov/img/data/m3"
SCENE = "M3G20090109T022525"
REFLECTANCE = f"{BASE}/CH1M3_0004/DATA/20081118_20090214/200901/L2/{SCENE}_V01_RFL"
LOCATION = f"{BASE}/CH1M3_0003/DATA/20081118_20090214/200901/L1B/{SCENE}_V03_LOC"


def envi(text):
    return {key.lower().strip(): value.strip("{} \t\r\n") for key, value in
            re.findall(r"^([\w ]+)\s*=\s*(\{[^}]*\}|[^\r\n]*)", text, re.MULTILINE)}


def download(url):
    filename = RAW / url.rsplit("/", 1)[-1]
    if not filename.exists():
        RAW.mkdir(parents=True, exist_ok=True)
        partial = filename.with_suffix(".part")
        with httpx.stream("GET", url, follow_redirects=True, timeout=120) as response:
            response.raise_for_status()
            with partial.open("wb") as stream:
                for chunk in response.iter_bytes():
                    stream.write(chunk)
        partial.replace(filename)
    return filename


def read_subset(url, start, finish, row_size):
    start_byte = start * row_size
    end_byte = finish * row_size - 1
    filename = RAW / f"{SCENE}-rows-{start}-{finish}.bin"
    if not filename.exists():
        response = httpx.get(url, headers={"Range": f"bytes={start_byte}-{end_byte}"},
                             params={"rows": f"{start}-{finish}"}, follow_redirects=True, timeout=120)
        if response.status_code != 206 or not response.headers.get("content-range", "").startswith(
                f"bytes {start_byte}-{end_byte}/"):
            raise ValueError("NASA archive did not return the requested byte range.")
        if len(response.content) != (finish - start) * row_size:
            raise ValueError("Incomplete reflectance subset.")
        filename.write_bytes(response.content)
    return filename


def main():
    location_header = envi(download(LOCATION + ".HDR").read_text())
    reflectance_header = envi(download(REFLECTANCE + ".HDR").read_text())
    if not (location_header["interleave"] == reflectance_header["interleave"] == "bil"
            and location_header["byte order"] == reflectance_header["byte order"] == "0"
            and location_header["data type"] == "5" and reflectance_header["data type"] == "4"):
        raise ValueError("Unexpected M3 scene format.")
    rows, cols = [int(location_header[key]) for key in ("lines", "samples")]
    count = int(reflectance_header["bands"])
    if (rows, cols) != tuple(int(reflectance_header[key]) for key in ("lines", "samples")):
        raise ValueError("M3 image and geolocation shapes differ.")
    wavelengths = np.array([float(value) for value in reflectance_header["wavelength"].split(",")])
    if len(wavelengths) != count:
        raise ValueError("M3 wavelength metadata does not match reflectance bands.")
    selected = np.flatnonzero((wavelengths >= 700) & (wavelengths <= 2490))
    geo_image = download(LOCATION + ".IMG")
    if geo_image.stat().st_size != rows*3*cols*8:
        raise ValueError(f"Incomplete M3 geolocation file. Move {geo_image.name} out of data/raw and retry.")
    locations = np.memmap(geo_image, dtype="<f8", mode="r", shape=(rows, 3, cols))
    west, south, east, north = MOON_BOUNDS
    lon, lat = locations[:, 0], locations[:, 1]
    nearby = (lon >= west-.025) & (lon <= east+.025) & (lat >= south-.025) & (lat <= north+.025)
    native_rows, native_cols = np.nonzero(nearby)
    if not len(native_rows):
        raise ValueError("The M3 scene has no matching pixels in Hadley.")
    first, end = int(native_rows.min()), int(native_rows.max())+1
    data = np.memmap(read_subset(REFLECTANCE + ".IMG", first, end, count*cols*4),
                     dtype="<f4", mode="r", shape=(end-first, count, cols))
    metric = Transformer.from_crs(MOON_GEO, MOON_CRS, always_xy=True)
    tree = cKDTree(np.column_stack(metric.transform(lon[nearby], lat[nearby])))
    x0, y0, x1, y1 = transform_bounds(MOON_GEO, MOON_CRS, *MOON_BOUNDS)
    spacing = 150
    width, height = int(np.ceil((x1-x0)/spacing)), int(np.ceil((y1-y0)/spacing))
    grid_x, grid_y = np.meshgrid(x0 + (np.arange(width)+.5)*spacing, y1 - (np.arange(height)+.5)*spacing)
    distance, nearest = tree.query(np.column_stack([grid_x.ravel(), grid_y.ravel()]))
    # Leave gaps where the swath lacks nearby independent observations.
    available = distance <= 120
    selected_rows = native_rows[nearest[available]] - first
    selected_cols = native_cols[nearest[available]]
    folder = SCIENCE / "spectra"
    folder.mkdir(exist_ok=True)
    with rasterio.open(folder / "moon.tif", "w", driver="GTiff", width=width, height=height,
                       count=len(selected), dtype="float32", nodata=np.nan, crs=MOON_CRS,
                       transform=from_origin(x0, y1, spacing, spacing), compress="deflate") as output:
        for index, band in enumerate(selected, 1):
            values = data[selected_rows, band, selected_cols]
            target = np.full(width*height, np.nan, dtype=np.float32)
            target[available] = np.where((values > 0) & np.isfinite(values), values, np.nan)
            output.write(target.reshape(height, width), index)
    (folder / "moon.json").write_text(json.dumps({
        "scene": SCENE + "_V01", "url": REFLECTANCE + ".HDR", "wavelengthNm": wavelengths[selected].tolist(),
        "location": LOCATION + ".HDR", "processing": "Native Level 2 band masks; nearest L1B geolocation within 120 m.",
        "nativePixelM": 150,
    }, indent=2))
    print(SCENE, f"rows {first}–{end-1}", f"{available.mean():.1%} of target grid has reflectance pixels.")


if __name__ == "__main__":
    main()
