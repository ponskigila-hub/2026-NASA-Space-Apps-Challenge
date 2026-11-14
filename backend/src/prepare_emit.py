"""Build an Earth reflectance raster from a downloaded EMIT L2A RFL and MASK pair."""
import argparse
import json
import re
from pathlib import Path

import h5py
import numpy as np
import rasterio
from affine import Affine
from rasterio.windows import from_bounds, Window

from .config import REGIONS, SCIENCE
from .terrain import load_grid

COLLECTION = "https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/EMITL2ARFL.001"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=REGIONS)
    parser.add_argument("reflectance", type=Path)
    parser.add_argument("mask", type=Path)
    args = parser.parse_args()
    prepare(args.site, args.reflectance, args.mask, SCIENCE / "spectra")


def prepare(site, reflectance, mask, folder):
    pattern = r"EMIT_L2A_RFL_001_(\d{8}T\d{6}_\d+_\d+)"
    match = re.fullmatch(pattern, reflectance.stem)
    if not match or mask.stem != "EMIT_L2A_MASK_001_" + match[1]:
        raise ValueError("Use matching NASA EMIT L2A V001 RFL and MASK files with original filenames.")
    with h5py.File(reflectance) as source, h5py.File(mask) as quality:
        rfl = source["reflectance"]
        band_parameters = source["sensor_band_parameters"]
        wavelengths = band_parameters["wavelengths"][:]
        good = band_parameters["good_wavelengths"][:] if "good_wavelengths" in band_parameters else np.ones_like(wavelengths)
        if quality["mask"].shape[:2] != rfl.shape[:2] or quality["band_mask"].shape[:2] != rfl.shape[:2]:
            raise ValueError("EMIT reflectance and mask footprints differ.")
        transform = Affine.from_gdal(*np.asarray(source.attrs["geotransform"], dtype=float))
        raw_window = from_bounds(*load_grid(site).meta["bounds"], transform)
        x, y = source["location/glt_x"], source["location/glt_y"]
        col = max(0, int(np.floor(raw_window.col_off)))
        row = max(0, int(np.floor(raw_window.row_off)))
        width = min(x.shape[1], int(np.ceil(raw_window.col_off + raw_window.width))) - col
        height = min(x.shape[0], int(np.ceil(raw_window.row_off + raw_window.height))) - row
        if min(width, height) <= 0:
            raise ValueError("This scene does not intersect the region.")
        win = Window(col, row, width, height)
        subset = win.toslices()
        ix, iy = x[subset].astype(int) - 1, y[subset].astype(int) - 1
        geo_valid = (ix >= 0) & (iy >= 0) & (ix < rfl.shape[1]) & (iy < rfl.shape[0])
        if not np.any(geo_valid):
            raise ValueError("This scene has no valid geolocated pixels within the region.")
        # Read each native row once and retain the channels around the two diagnostic bands.
        channels = np.flatnonzero((wavelengths >= 700) & (wavelengths <= 2490))
        data = np.full((height * width, len(channels)), np.nan, dtype=np.float32)
        target_rows = iy[geo_valid]
        target_cols = ix[geo_valid]
        target_ids = np.flatnonzero(geo_valid)
        for native in np.unique(target_rows):
            locations = target_rows == native
            cols = target_cols[locations]
            original = rfl[native, :, :][:, channels][cols]
            clear = quality["mask"][native, :, 7][cols] == 0
            flagged = np.unpackbits(quality["band_mask"][native, :, :], axis=-1)[:, channels][cols]
            allowed = clear[:, None] & (flagged == 0) & (good[channels] > 0) & (original > 0) & np.isfinite(original)
            data[target_ids[locations]] = np.where(allowed, original, np.nan)
        folder.mkdir(parents=True, exist_ok=True)
        with rasterio.open(folder / f"{site}.tif", "w", driver="GTiff", width=width, height=height,
                           count=len(channels), dtype="float32", nodata=np.nan, crs="EPSG:4326",
                           transform=rasterio.windows.transform(win, transform), compress="deflate") as dst:
            dst.write(data.T.reshape(len(channels), height, width))
        scene = reflectance.stem
        (folder / f"{site}.json").write_text(json.dumps({
            "scene": scene, "url": f"{COLLECTION}/{scene}/{reflectance.name}",
            "mask": f"{COLLECTION}/{scene}/{mask.name}", "wavelengthNm": wavelengths[channels].tolist(),
            "nativePixelM": 60, "processing": "One-based NASA GLT, aggregate spatial and packed per-channel quality flags.",
        }, indent=2))
        print(scene, f"{np.isfinite(data).any(axis=1).mean():.1%} of the clipped footprint is usable.")


if __name__ == "__main__":
    main()
