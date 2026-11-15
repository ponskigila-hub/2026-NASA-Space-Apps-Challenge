"""Fetch a projected, cropped Sentinel-2 image for an Earth map overlay."""
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import os
from threading import Lock
from time import monotonic

import httpx
from rasterio.warp import transform_bounds

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"
EVALSCRIPT = """//VERSION=3
function setup() {
    return {input: ["B04", "B03", "B02", "SCL", "dataMask"], output: {bands: 4}};
}
function evaluatePixel(s) {
    let clear = s.dataMask && [2, 4, 5, 6, 7, 11].includes(s.SCL);
    return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02, clear ? 1 : 0];
}
"""
_token = None
_token_expires = 0
_token_lock = Lock()


def imagery_enabled():
    return bool(os.getenv("CDSE_CLIENT_ID") and os.getenv("CDSE_CLIENT_SECRET"))


def access_token():
    global _token, _token_expires
    with _token_lock:
        if _token is None or monotonic() >= _token_expires:
            response = httpx.post(TOKEN_URL, data={
                "grant_type": "client_credentials", "client_id": os.environ["CDSE_CLIENT_ID"],
                "client_secret": os.environ["CDSE_CLIENT_SECRET"],
            }, timeout=10)
            response.raise_for_status()
            data = response.json()
            _token = data["access_token"]
            _token_expires = monotonic() + max(0, data["expires_in"] - 60)
        return _token


@lru_cache(maxsize=12)
def satellite_image(bounds, day):
    projected = transform_bounds("EPSG:4326", "EPSG:3857", *bounds)
    payload = {
        "input": {
            "bounds": {"bbox": projected, "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/3857"}},
            "data": [{"type": "sentinel-2-l2a", "dataFilter": {
                "timeRange": {"from": (day - timedelta(days=90)).isoformat() + "T00:00:00Z",
                              "to": datetime.combine(day, datetime.max.time(), timezone.utc).isoformat()},
                "mosaickingOrder": "leastCC", "maxCloudCoverage": 30,
            }}],
        },
        "output": {"width": 768, "height": 768,
                   "responses": [{"identifier": "default", "format": {"type": "image/png"}}]},
        "evalscript": EVALSCRIPT,
    }
    response = httpx.post(PROCESS_URL, json=payload, headers={
        "Authorization": f"Bearer {access_token()}", "Accept": "image/png",
    }, timeout=25)
    response.raise_for_status()
    if not response.content.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Sentinel Hub did not return a PNG.")
    return response.content
