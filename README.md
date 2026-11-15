# AstroScan

AstroScan is an interactive map for finding Earth test routes that resemble a planned lunar traverse. Pick two points on the Moon, calculate a route up to 75 km, and compare candidate routes on Earth. The app shows why each candidate ranked where it did and how much of its route has usable data.

## Problem and challenge

Teams planning lunar field tests need Earth sites that resemble the specific terrain they expect to cross. A broad resemblance between two landscapes leaves practical questions about their slopes, roughness, shadows, and geology. AstroScan compares candidate routes at the same analysis scale and lets researchers choose what matters most for rover navigation, camera testing, or mineral mapping.

AstroScan is the lunar traverse entry by **Tim Ga Bakal Menang** for the 2026 NASA Space Apps Challenge. [Identify Earth Locations that Analog the Permanent Moon Base Locations and Mars](https://www.spaceappschallenge.org/2026/challenges/permanent-moon-base-locations-and-mars/)

## How it works

1. **Place two lunar endpoints.** Use **Whole Moon** to select coordinates or start with Hadley–Apennine or Mare Serenitatis. A bundled gazetteer lets the app label a point with the nearest named feature center within 50 km.
2. **Calculate a lunar traverse.** The backend loads a prepared grid or fetches the required lunar elevation tiles. An A* search runs on a 90 m grid, favors gentler and smoother terrain, and limits the grade of each step to 20°.
3. **Find and rank Earth routes.** The app samples candidate paths within bounded Earth regions and compares distributions of slope and roughness using Wasserstein distance. It combines the scores using weights for the selected mission objective and includes lighting or mineral evidence when the same measurements are available across the ranked sites.
4. **Inspect and export the result.** Compare each candidate with the lunar route, check evidence coverage and ranking stability, and export the report ZIP with route data and sources.

## Explore the results

- **Terrain** comparisons include route lengths, slope and roughness statistics, and elevation profiles. Select a distribution range to highlight the matching stretches on both route maps.
- **Earth matches** explains each site's rank and strongest advantage under the current objective. **Evidence** shows terrain, lighting, and mineral coverage alongside the limits of the data. **Ranking stability** reports how often each site ranks first when 5 or 10 percentage points move between active scoring factors.
- **Lighting** compares modeled route shadows on the Moon and Earth. Select an observation window to preview its available times and export it as a CSV with local and UTC timestamps. Use **Shadows** on either main map to turn the overlay on or off.
- **Minerals** compares spectral bands and mapped rock units where data is available. Use **Rock units** on the main maps to see the mapped geology along each route.

## Datasets and models

| Source | How AstroScan uses it |
| --- | --- |
| [SLDEM2015 lunar elevation](https://pgda.gsfc.nasa.gov/products/54) | Combines NASA LRO laser altimetry with JAXA SELENE/Kaguya stereo terrain. AstroScan uses it for lunar routing, slope and roughness, and terrain horizons. |
| [Copernicus DEM GLO-30 Public](https://copernicus-dem-30m.s3.amazonaws.com/readme.html) | Supplies the Earth elevations for candidate routes, terrain comparisons, and shadow modeling. AstroScan resamples both bodies to a 90 m analysis grid. |
| [NASA Moon Trek LROC WAC imagery](https://trek.nasa.gov/moon/) and [USGS/IAU Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/Page/MOON/target) | Provide the lunar basemap and nearby feature names. The repository includes a low-resolution mosaic for offline browsing. |
| [NASA/JPL NAIF SPICE kernels](https://naif.jpl.nasa.gov/naif/data_lunar.html) and [pvlib](https://pvlib-python.readthedocs.io/en/stable/reference/generated/pvlib.solarposition.get_solarposition.html) | Compute lunar and Earth Sun positions. The lighting model compares them with terrain horizons and searches 30 days of Earth observations. |
| [Chandrayaan-1 Moon Mineralogy Mapper (M³)](https://doi.org/10.17189/1520414) and [NASA EMIT L2A reflectance](https://cmr.earthdata.nasa.gov/search/concepts/C2408750690-LPCLOUD.html) | Supply lunar and Earth spectra. AstroScan compares the depths and centers of absorption bands where both routes have usable measurements. Live EMIT access uses NASA Earthdata. |
| [USGS Unified Geologic Map of the Moon](https://pubs.usgs.gov/sim/3463/) and [Global Lithological Map (GLiM)](https://doi.org/10.1029/2012GC004370) | Supply mapped rock units for the prepared lunar and Earth layers. These give context for interpreting spectral evidence. |
| [Copernicus Sentinel-2 imagery](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html) | Provides an optional Earth satellite basemap through Sentinel Hub credentials. |

## Coverage and limitations

- **Lunar coverage.** Prepared terrain grids cover selected areas of Hadley–Apennine and Mare Serenitatis. **Whole Moon** lets users browse the globe. On-demand routing uses SLDEM2015 tiles from 60°S to 60°N and a 75 km traverse limit. The first analysis in a new area can take longer while tiles download.
- **Earth search.** Rankings describe the candidates found within the configured search areas and path-length tolerance. The results serve as a shortlist for field evaluation.
- **Terrain resolution.** The 90 m grid describes broad terrain. Boulder-scale hazards, traction, wheel slip, thermal conditions, and field safety require separate evaluation.
- **Science coverage.** Lighting results model terrain shadows for a given Sun position. Field conditions and camera performance require separate checks. Lunar geology and reflectance assets cover Hadley–Apennine, and Earth mineral comparisons depend on the availability and quality of EMIT observations.
- **Interpreting evidence.** Coverage describes the share of the route with usable data. Ranking stability measures how often the same candidate leads when weights change.

## Run locally

Install Python 3.12 and Node.js 22 or later with npm. These shell commands are for macOS and Linux. On Windows, activate the virtual environment with `.venv\Scripts\Activate.ps1` in PowerShell.

```sh
git clone https://github.com/ponskigila-hub/2026-NASA-Space-Apps-Challenge.git
cd 2026-NASA-Space-Apps-Challenge
```

Start the API from the repository root in one terminal.

```sh
cd backend
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

Open [API health](http://127.0.0.1:8000/health) and check for `"status": "ok"`.

Start the frontend from the repository root in a second terminal.

```sh
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Open [the local app](http://127.0.0.1:5173) and choose **Explore the Moon**. Load a prepared example or use **Whole Moon** to place two endpoints in the supported latitude range, then choose **Analyze route**. **Replay Hadley** and **Replay the rille** use bundled results and work with only the frontend running.

The clone includes prepared terrain, lunar reflectance, lighting inputs, geology, and replay reports. The earlier challenge prototype is preserved in the root `api/`, `src/`, and `outputs/` directories. Use `backend/` for the current API.

If you change the API address, set `VITE_ASTROSCAN_API_URL` before starting Vite. For a custom frontend origin, set `ASTROSCAN_ORIGINS` to the allowed frontend URLs, separated by commas, before starting the API.

## Try a longer lunar route

Select **Mare Serenitatis**, choose **Load Mare Serenitatis example**, and run the analysis. This example exercises the 75 km route cap and Earth analog search with a bundled lunar grid.

For a shorter demo, **Replay the rille** shows how the app compares lunar terrain with a candidate route in Harrat Khaybar, Saudi Arabia. The saved rover-navigation result gives that candidate an 81.4% match score.

## Search more Earth analogs

A live analysis requests the seven NASA catalog sites alongside the built-in regions of Pinacate, Harrat Khaybar, and Payún Matrú. The saved replays start with the three built-in regions. In **Earth matches**, choose **Fetch and rank NASA sites** or use the fetch control on an individual site. To include a different area, enter its center latitude and longitude in the **Custom Earth region** form and select **Rank custom region**.

The backend streams the public Copernicus elevation needed for search areas up to 104 × 104 km, builds the terrain and relief maps in memory, and ranks computed routes using the selected mission objective. If a region cannot be evaluated, its card shows why. Results for the expanded comparison expire when the API restarts or the results are evicted from memory.

Terrain relief works without a Copernicus account. To add a Sentinel-2 satellite layer, register a [Sentinel Hub OAuth client](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html) and set `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` in the backend environment before starting the API. Select an Earth site with a computed route to fetch mineral data separately.

## Fetch Earth mineral data

Earthdata sign-in enables live EMIT access. Stop the API, then run this command from `backend/` with the virtual environment active.

```sh
python -c 'import earthaccess; earthaccess.login(strategy="interactive", persist=True)'
```

Enter your NASA Earthdata credentials at the terminal prompt. This saves them to your local Earthdata netrc file. You can also set `EARTHDATA_TOKEN` in the backend environment. Keep authentication details in your local environment.

Restart the API, open an analysis or replay, select an Earth site, and choose **Fetch mineral data**. The app searches NASA CMR for scenes covering the route and reads the quality flags and reflectance for sampled route pixels over HTTPS. It keeps the live result in backend memory for up to 20 recent fetch jobs or until the API restarts. Use the report export if you want to save a copy.

The bundled Rille replay includes the original Harrat Khaybar EMIT results. To use that exact scene in new analyses, download the RFL and MASK NetCDF files for `20240924T104630_2426807_014` from the [NASA EMIT collection](https://cmr.earthdata.nasa.gov/search/concepts/C2408750690-LPCLOUD.html). From `backend/` run:

```sh
python -m src.prepare_emit harrat-khaybar /path/to/EMIT_L2A_RFL_001_20240924T104630_2426807_014.nc /path/to/EMIT_L2A_MASK_001_20240924T104630_2426807_014.nc
```

Restart the API after preparing the scene. The same command accepts `pinacate` and `payun-matru` with the corresponding scene files.

## Verify and rebuild

Run the backend tests from `backend/` with the virtual environment active.

```sh
python -m unittest discover -s tests
```

Build the frontend from `frontend/` after running `npm ci`.

```sh
npm run build
```

Run the frontend tests with `node --test tests/*.test.mjs` from `frontend/`.

To refresh the bundled data, stop the API and run these commands from `backend/`. Preparation downloads large source files into `backend/data/raw/`.

```sh
python -m src.prepare
python -m src.prepare_lunar_region
python -m src.prepare_science
python -m src.prepare_m3
python -m src.build_replays
```

## API

- `GET /health` returns readiness and the data version.
- `GET /config` returns lunar regions and bounds, example coordinates, route limits, presets, assets, and provenance.
- `GET /earth-sites` returns the catalog of Earth analogs and source links.
- `POST /analyses` accepts `a` and `b` objects with `lat` and `lon` in decimal degrees, plus optional `preset`, `lunarUtc` (ISO timestamp with timezone), and `earthStart` (UTC date).
- Pass `lunarRegion` as `auto` to select elevation from the two coordinates, or use `hadley` or `serenitatis` to select a prepared area. Omitted values default to Hadley.
- `GET /lunar-location?lat=-43.31&lon=-11.36` returns the closest named feature within 50 km and indicates on-demand terrain coverage. Refresh the catalog from `backend/` with `python -m src.lunar_names`.
- Pass `earthSites` as a list of catalog IDs and `earthCenter` as a latitude and longitude object to include additional Earth regions.
- `GET /analyses/{id}` returns queued, running, complete, or failed status and the result or error.
- `GET /analyses/{id}/report?site=pinacate` exports the stored result as a ZIP with a Markdown report, source manifest, profiles, Earth GeoJSON, and separately framed lunar geometry. Omit `site` for the top matched candidate. Pass `preset` to apply a different report objective to the same terrain analysis.

Lunar routes use ordered snapped endpoints and a 20° along-step grade ceiling. Earth matching uses bounded deterministic sampling and a ±20% path-length tolerance with a two-cell minimum. A missing Earth result means the search found no eligible match within its configured limits.

## Team

**Tim Ga Bakal Menang**

- Rivaldo Caga Prawira Tjong
- Nicholas Tjoe
- Mitchell Revelin
