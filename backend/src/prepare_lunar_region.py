"""Prepare the bundled Mare Serenitatis terrain and offline map from NASA SLDEM2015."""
import numpy as np
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling

from .config import FRONTEND, MOON_GEO
from .lunar_regions import LUNAR_REGIONS, SERENITATIS_CRS
from .prepare import resample_sldem, save_grid


def main():
    region = LUNAR_REGIONS["serenitatis"]
    bounds = region["bounds"]
    dem, transform, eligible, _, _ = resample_sldem(bounds, SERENITATIS_CRS)
    save_grid(region["id"], dem, transform, SERENITATIS_CRS, bounds, eligible, MOON_GEO, lunar=True)

    # The lunar map uses an equirectangular overlay in longitude and latitude.
    dy, dx = np.gradient(dem)
    shade = .61 + .32 * np.tanh((dx + dy) / 4)
    relief = np.full((720, 1000), np.nan, dtype=np.float32)
    reproject(shade, relief, src_transform=transform, src_crs=SERENITATIS_CRS, src_nodata=np.nan,
              dst_transform=from_bounds(*bounds, 1000, 720), dst_crs=MOON_GEO,
              dst_nodata=np.nan, resampling=Resampling.bilinear)
    image = Image.fromarray((np.nan_to_num(relief) * 255).astype(np.uint8))
    image.save(FRONTEND / "public" / region["relief"], quality=86)


if __name__ == "__main__":
    main()
