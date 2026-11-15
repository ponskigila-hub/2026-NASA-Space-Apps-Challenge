"""Resolve a lunar coordinate against the USGS/IAU catalog of feature centers."""
from functools import lru_cache
import json
from math import asin, cos, radians, sin
from urllib.request import urlopen
from xml.etree import ElementTree
from zipfile import ZipFile

from scipy.spatial import cKDTree

from .config import MOON_RADIUS, ROOT

CATALOG_URL = ("https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/"
               "MOON_nomenclature_center_pts.kmz")
CATALOG_PATH = ROOT / "data" / "lunar_names.json"


def unit_vector(lat, lon):
    lat, lon = radians(lat), radians(lon)
    return cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)


def parse_catalog(archive):
    with ZipFile(archive) as kmz:
        root = ElementTree.fromstring(kmz.read("MOON_nomenclature_center_pts.kml"))
    rows = []
    for entry in root.findall(".//{*}Placemark"):
        fields = {field.attrib["name"]: field.text for field in entry.findall(".//{*}SimpleData")}
        name = entry.findtext("{*}name")
        if fields.get("approval") != "Adopted by IAU" or not name:
            continue
        rows.append([name, float(fields["center_lat"]), round((float(fields["center_lon"]) + 180) % 360 - 180, 6),
                     fields["link"].rsplit("/", 1)[-1]])
    return rows


@lru_cache(maxsize=1)
def catalog():
    rows = json.loads(CATALOG_PATH.read_text())
    return rows, cKDTree([unit_vector(lat, lon) for _, lat, lon, _ in rows])


def locate(lat, lon):
    rows, index = catalog()
    chord, row = index.query(unit_vector(lat, lon))
    distance_km = 2 * MOON_RADIUS * asin(min(1, float(chord) / 2)) / 1000
    if distance_km > 50:
        return None
    name, _, _, feature_id = rows[row]
    return {"name": name, "distanceKm": round(distance_km, 2),
            "sourceUrl": f"https://planetarynames.wr.usgs.gov/Feature/{feature_id}"}


if __name__ == "__main__":
    from io import BytesIO
    import sys

    if len(sys.argv) > 1:
        rows = parse_catalog(sys.argv[1])
    else:
        with urlopen(CATALOG_URL, timeout=25) as response:
            rows = parse_catalog(BytesIO(response.read()))
    CATALOG_PATH.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Cached {len(rows):,} approved lunar names.")
