"""Read a bounded Copernicus elevation window over HTTPS and prepare a transient grid."""
from base64 import b64encode
from contextlib import ExitStack
from io import BytesIO
import math

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rasterio.merge import merge
from rasterio.warp import reproject, Resampling, transform_bounds

from .config import RESOLUTION, SEARCH_BUFFER
from .prepare import (EARTH_BUCKET, build_window_index, centers, destination, earth_grid,
                      earth_urls, generate_features, relief_image)
from .terrain import Grid


GEOGRAPHIC_CRS = "EPSG:4326"


def custom_region(point):
    lat, lon = point["lat"], point["lon"]
    zone = math.floor((lon + 180) / 6) + 1
    return {"name": "Custom Earth region", "location": f"{lat:.4f}°, {lon:.4f}°",
            "center": (lon, lat), "crs": f"EPSG:{32600 + zone if lat >= 0 else 32700 + zone}",
            "description": "An 84 × 84 km search area centered on the supplied coordinates."}


def read_terrain(region, site_id="custom"):
    crs = region["crs"]
    bounds = earth_grid(region)
    geobounds = transform_bounds(crs, GEOGRAPHIC_CRS, *bounds)
    dem, transform = destination(bounds)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_CONNECTTIMEOUT="5",
                      GDAL_HTTP_TIMEOUT="12", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"), ExitStack() as stack:
        tiles = []
        for url in earth_urls(geobounds):
            try:
                tiles.append(stack.enter_context(rasterio.open(url)))
            except RasterioIOError as error:
                # Public tiles can be absent over ocean or where GLO-30 is restricted.
                if "404" not in str(error) and "403" not in str(error):
                    raise
        if not tiles:
            raise ValueError("No public Copernicus GLO-30 tiles cover this area.")
        mosaic, source_transform = merge(tiles, bounds=geobounds, nodata=np.nan, dtype="float32",
                                         target_aligned_pixels=True, masked=True)
        urls = [tile.name for tile in tiles]

    reproject(mosaic[0].filled(np.nan), dem, src_transform=source_transform, src_crs=GEOGRAPHIC_CRS,
              src_nodata=np.nan, dst_transform=transform, dst_crs=crs, dst_nodata=np.nan,
              resampling=Resampling.average)
    slope, rough = generate_features(dem)
    x, y = centers(transform, dem.shape)
    west, south, east, north = bounds
    eligible = ((x >= west + SEARCH_BUFFER) & (x <= east - SEARCH_BUFFER)
                & (y >= south + SEARCH_BUFFER) & (y <= north - SEARCH_BUFFER)
                & np.isfinite(dem) & np.isfinite(slope) & np.isfinite(rough))
    windows = build_window_index(slope, rough, eligible)
    grid = Grid.from_arrays(dem, slope, rough, eligible, windows, {
        "transform": list(transform)[:6], "crs": crs, "bounds": geobounds, "geographicCrs": GEOGRAPHIC_CRS,
    })
    source = {"id": f"copernicus-glo30-{site_id}", "regions": [site_id], "version": "GLO-30 Public, 2021 release",
              "kind": "elevation", "url": f"{EARTH_BUCKET}/readme.html", "coverage": geobounds,
              "files": [{"url": url} for url in urls], "license": "Copernicus DEM GLO-30 public license",
              "verticalReference": "EGM2008 orthometric height", "nativeResolutionM": 30,
              "analysisResolutionM": RESOLUTION, "processing": "Read by HTTPS byte ranges and averaged onto a 90 m grid."}
    with BytesIO() as output:
        relief_image(dem, transform, crs, geobounds).save(output, format="WEBP", quality=80)
        relief = "data:image/webp;base64," + b64encode(output.getvalue()).decode("ascii")
    return grid, source, relief
