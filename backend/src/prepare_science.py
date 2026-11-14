"""Prepare NAIF kernels and local rock-unit rasters from published geology maps."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
from io import BytesIO
from urllib.parse import urlencode
from zipfile import ZipFile
import json
import shutil

from rasterio.features import rasterize
from rasterio.warp import transform_bounds, transform_geom
from shapefile import Reader

from .config import MOON_RADIUS, REGIONS, SCIENCE
from .prepare import download
from .terrain import load_grid
import numpy as np

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
KERNELS = ("lsk/naif0012.tls", "fk/satellites/moon_de440_250416.tf",
           "pck/moon_pa_de440_200625.bpc", "spk/planets/de440s.bsp")
MOON_ZIP = "https://asc-astropedia.s3.us-west-2.amazonaws.com/Moon/Geology/Unified_Geologic_Map_of_the_Moon_GIS_v2.zip"
MOON_GEOLOGY = "https://astrogeology.usgs.gov/search/map/Moon/Geology/Unified_Geologic_Map_of_the_Moon_GIS_v2/"
GLIM = "https://services8.arcgis.com/4KhTMTZ1x0f76DSg/ArcGIS/rest/services/GLiM_Niveau_I/FeatureServer/1/query"


def save_map(name, geometries, native_crs):
    grid = load_grid(name)
    labels = sorted({label for _, label in geometries})
    codes = {label: index for index, label in enumerate(labels, 1)}
    shapes = [(transform_geom(native_crs, grid.meta["crs"], shape), codes[label]) for shape, label in geometries]
    values = rasterize(shapes, out_shape=grid.dem.shape, transform=grid.transform, dtype=np.uint16)
    np.savez_compressed(SCIENCE / "geology" / f"{name}.npz", units=values, labels=np.array(labels))


def prepare_moon():
    path = download(MOON_ZIP, "moon-geology.zip")
    grid = load_grid("moon")
    native = f"+proj=eqc +lat_ts=0 +lon_0=0 +R={MOON_RADIUS} +units=m"
    bounds = transform_bounds(grid.meta["geographicCrs"], native, *grid.meta["bounds"])
    with ZipFile(path) as archive:
        name = next(name for name in archive.namelist() if name.endswith("/GeoUnits.shp"))
        with Reader(shp=BytesIO(archive.read(name)), dbf=BytesIO(archive.read(name[:-3] + "dbf"))) as source:
            records = sorted(source.iterShapeRecords(bbox=bounds),
                             key=lambda item: -item.record.as_dict()["Shape_Area"])
            shapes = [(item.shape.__geo_interface__,
                       f"{item.record.as_dict()['FIRST_Un_2']} ({item.record.as_dict()['FIRST_Unit']})")
                      for item in records]
    save_map("moon", shapes, native)


def prepare_earth(name):
    grid = load_grid(name)
    query = urlencode({"geometry": ",".join(map(str, grid.meta["bounds"])), "geometryType": "esriGeometryEnvelope",
                       "inSR": 4326, "outSR": 4326, "outFields": "xx_Description",
                       "returnGeometry": "true", "f": "geojson"})
    response = json.loads(download(f"{GLIM}?{query}", f"glim-{name}.geojson").read_text())
    if response.get("exceededTransferLimit"):
        raise ValueError(f"GLiM query was truncated for {name}")
    shapes = [(feature["geometry"], feature["properties"]["xx_Description"])
              for feature in response["features"]
              if feature["geometry"] and feature["properties"]["xx_Description"]]
    save_map(name, shapes, "EPSG:4326")


def main():
    (SCIENCE / "kernels").mkdir(parents=True, exist_ok=True)
    (SCIENCE / "geology").mkdir(exist_ok=True)
    for name in KERNELS:
        filename = name.split("/")[-1]
        target = SCIENCE / "kernels" / filename
        if not target.exists():
            shutil.copyfile(download(f"{NAIF}/{name}"), target)
    prepare_moon()
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(prepare_earth, REGIONS))
    manifest = {}
    for path in sorted(SCIENCE.glob("*/*")):
        if path.is_file() and path.parent.name in {"geology", "kernels"}:
            with path.open("rb") as stream:
                manifest[str(path.relative_to(SCIENCE))] = file_digest(stream, "sha256").hexdigest()
    (SCIENCE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Prepared lunar and Earth geology maps and four SPICE kernels.")


if __name__ == "__main__":
    main()
