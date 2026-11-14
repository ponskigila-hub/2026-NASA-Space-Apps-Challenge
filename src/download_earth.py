"""
Download NASADEM (or SRTM fallback) tiles for the three Earth regions
using the official NASA Earthdata Search / earthaccess library.

Official portal: https://search.earthdata.nasa.gov/
Short name: NASADEM_HGT  [VERIFY on the collection page if search returns zero]
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from src.config import DATA_RAW, EARTH_REGIONS
from src.sources import log_source


def download_region(name: str, lat: float, lon: float, half_deg: float = 0.6) -> None:
    """Search and download NASADEM HGT tiles covering the region box."""
    try:
        import earthaccess
    except ImportError as e:
        raise SystemExit(
            "earthaccess is required. pip install earthaccess\n"
            "Then run: earthaccess login  (or earthaccess.login(persist=True))"
        ) from e

    # Persist token so subsequent runs do not re-prompt
    earthaccess.login(persist=True)

    bbox = (lon - half_deg, lat - half_deg, lon + half_deg, lat + half_deg)
    print(f"Searching NASADEM_HGT for {name} bbox={bbox}")

    results = earthaccess.search_data(
        short_name="NASADEM_HGT",
        bounding_box=bbox,
        count=20,
    )

    if not results:
        print(
            f"[WARN] zero granules for {name}. "
            "Copy the exact short_name from Earthdata Search collection info."
        )
        return

    out_dir = DATA_RAW / "dem_earth" / name
    out_dir.mkdir(parents=True, exist_ok=True)

    files = earthaccess.download(results, str(out_dir))
    print(f"Downloaded {len(files)} items → {out_dir}")

    # Unzip any .zip
    for f in Path(out_dir).glob("*.zip"):
        with zipfile.ZipFile(f, "r") as z:
            z.extractall(out_dir)
        print(f"Unzipped {f.name}")

    log_source(
        name=f"NASADEM_{name}",
        version="NASADEM_HGT",
        portal="NASA Earthdata",
        url="https://search.earthdata.nasa.gov/",
        res_m=30.0,  # approx; record actual after inspection
        notes=f"bbox={bbox}; tiles for region centre {lat},{lon}",
    )


def main() -> None:
    for name, info in EARTH_REGIONS.items():
        download_region(name, info["lat"], info["lon"])


if __name__ == "__main__":
    main()
