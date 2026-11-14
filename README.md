# Earth Analogs for a Lunar Route

NASA Space Apps Challenge 2026  
Moon target: **Hadley Rille** (Apollo 15 vicinity)  
Earth regions: **Pinacate**, **Harrat Khaybar**, **Payun Matru**

Skeleton + Phase 1–2 tooling, **fully compatible with the LDEM product you ordered**.

---

## Your LOLA dataset (already partially present)

| Item | Value |
|------|-------|
| PRODUCT_ID | `LDEM_1024_15N_30N_000_030` |
| Resolution | 1024 ppd ≈ **29.61 m/pixel** |
| Coverage | 15°N–30°N, 0°–30°E (covers Hadley Rille) |
| Scaling | `HEIGHT (m) = DN × 0.5` |
| Reference radius / OFFSET | 1 737 400 m |
| Projection | Simple Cylindrical, positive east |

**Label + aux files are already in the zip:**
```
data/raw/lola/
  ldem_1024_15n_30n_000_030_jp2.lbl
  ldem_1024_15n_30n_000_030_aux.xml
  derived/...
```

**You must still place the large image file** (the `.JP2` or `.IMG` that belongs to the same product) into the same folder:

```
data/raw/lola/LDEM_1024_15N_30N_000_030.JP2   ← put your real file here
```

(The cart-order split volumes contain this file in one of the other parts.)

---

## Official data portals

- [NASA Earthdata Search](https://search.earthdata.nasa.gov/) – NASADEM, EMIT, …
- [NASA PDS Geosciences / LRO](https://pds-geosciences.wustl.edu/missions/lro/) – LOLA, LROC, Diviner
- [NASA Worldview](https://worldview.earthdata.nasa.gov/) – basemap imagery
- Copernicus Data Space, CSA RCM, JAXA G-Portal (optional layers)

---

## Quick start (Phase 0 → Phase 2)

```bash
cd lunar-analogs

python -m venv nasa-venv
source nasa-venv/Scripts/activate          # Windows Git Bash
# source nasa-venv/bin/activate            # Linux / macOS

pip install -r requirements.txt

# Phase 1 Done-when check
python -c "from src.config import MOON_SITE, LOLA_PRODUCT_ID; print(MOON_SITE); print(LOLA_PRODUCT_ID)"

# Place your large JP2/IMG into data/raw/lola/ then:
python -m src.crop_lola                    # crops to MOON_BBOX, applies scale 0.5, writes hadley_crop.tif
python -m src.inspect_data                 # writes outputs/metadata.csv

# Earth DEMs (optional for now)
python -c "import earthaccess; earthaccess.login(persist=True)"
python -m src.download_earth
```

---

## What this zip contains

- Full folder layout from the handoff
- `src/config.py` – constants + your exact LOLA product parameters
- `src/sources.py` – source logging
- `src/terrain.py`, `routing.py`, `scoring.py`, `lighting.py` – starter math (with §12 fixes)
- `src/crop_lola.py` – **ready for LDEM_1024_15N_30N_000_030**
- `src/inspect_data.py` – metadata table
- `src/download_earth.py` – NASADEM via earthaccess
- `api/main.py` – FastAPI skeleton
- Label/aux files for your ordered product
- One illustrative fixture (clearly labelled)
- `.gitignore` that excludes all large data

**Not included (by design):** the multi-GB JP2/IMG itself. Put it in `data/raw/lola/` yourself.

---

## Integrity rules

- Never invent scores, shadow fractions or coverage.
- High score = matching statistics at the common pixel size, not “the site behaves like the Moon”.
- Fixed cannot-be-matched list on every candidate (gravity, atmosphere, radiation, dust, DEM limits, lighting scattering).

---

## Next after crop succeeds

Phase 3 → metadata.csv + pixel-size note in README  
Phase 4 → common metric grid (stereographic for Moon, UTM for Earth)  
Phase 5 → slope + roughness  
Phase 6 → lunar routing  

Ask for the next phase when the crop finishes cleanly.
