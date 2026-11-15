# AstroScan terrain analysis

Pick two points in Hadley–Apennine, calculate a lunar traverse up to 50 km, and compare it with candidate routes on Earth. The ranking weights slope, roughness, and comparable lighting or mineral evidence according to the selected mission objective.

## Explore the results

- **Terrain** comparisons include route lengths, slope and roughness statistics, and elevation profiles. Select a distribution range to highlight the matching stretches on both route maps.
- **Earth matches** explains each site's rank and strongest advantage under the current objective. **Evidence** shows terrain, lighting, and mineral coverage alongside the limits of the data. **Ranking stability** reports how often each site ranks first when 5 or 10 percentage points move between active scoring factors.
- **Lighting** compares modeled route shadows on the Moon and Earth. Select an observation window to preview its available times and export it as a CSV with local and UTC timestamps. Use **Shadows** on either main map to turn the overlay on or off.
- **Minerals** compares spectral bands and mapped rock units where data is available. Use **Rock units** on the main maps to see the mapped geology along each route.

The current lunar terrain grid covers Hadley–Apennine at 90 m resolution. The Earth ranking compares routes found by a bounded search. Rover-scale hazards, traction, wheel slip, thermal conditions, and field safety require separate evaluation.

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

Open [the local app](http://127.0.0.1:5173), choose **Explore the Moon**, load the Hadley example or select two points, then choose **Analyze route**. **Replay Hadley** and **Replay the rille** also work with just the frontend running.

The clone includes prepared terrain, lunar reflectance, lighting inputs, geology, and replay reports. The earlier challenge prototype is preserved in the root `api/`, `src/`, and `outputs/` directories. Use `backend/` for the current API.

If you change the API address, set `VITE_ASTROSCAN_API_URL` before starting Vite. For a custom frontend origin, set `ASTROSCAN_ORIGINS` to the allowed frontend URLs, separated by commas, before starting the API.

## Search more Earth analogs

A live analysis requests the seven NASA catalog sites alongside the built-in regions of Pinacate, Harrat Khaybar, and Payún Matrú. The saved replays start with the three built-in regions. In **Earth matches**, choose **Fetch and rank NASA sites** or use the fetch control on an individual site. To include a different area, enter its center latitude and longitude in the **Custom Earth region** form and select **Rank custom region**.

The backend streams the public Copernicus elevation needed for each 84 × 84 km search area, builds the terrain and relief maps in memory, and ranks computed routes using the selected mission objective. If a region cannot be evaluated, its card shows why. Results for the expanded comparison expire when the API restarts or the results are evicted from memory.

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
python -m src.prepare_science
python -m src.prepare_m3
python -m src.build_replays
```

## API


- `GET /health` returns readiness and the data version.
- `GET /config` returns Hadley coverage, coordinate conventions, limits, presets, assets, and provenance.
- `GET /earth-sites` returns the catalog of Earth analogs and source links.
- `POST /analyses` accepts `a` and `b` objects with `lat` and `lon` in decimal degrees, plus optional `preset`, `lunarUtc` (ISO timestamp with timezone), and `earthStart` (UTC date).
- Pass `earthSites` as a list of catalog IDs and `earthCenter` as a latitude and longitude object to include additional Earth regions.
- `GET /analyses/{id}` returns queued, running, complete, or failed status and the result or error.
- `GET /analyses/{id}/report?site=pinacate` exports the stored result as a ZIP with a Markdown report, source manifest, profiles, Earth GeoJSON, and separately framed lunar geometry. Omit `site` for the top matched candidate. Pass `preset` to apply a different report objective to the same terrain analysis.

Lunar routes use ordered snapped endpoints and a 20° along-step grade ceiling. Earth matching uses bounded deterministic sampling and a ±20% path-length tolerance with a two-cell minimum. A missing Earth result means the search found no eligible match within its configured limits.
