# AstroScan terrain analysis

Pick two points in Hadley–Apennine, calculate a DEM-based lunar traverse up to 50 km, and compare it with computed volcanic-field routes at Pinacate, Harrat Khaybar, and Payún Matrú. Matches can use slope, roughness and comparable lighting or mineral-band evidence.

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

## Fetch Earth mineral data

Earthdata sign-in enables live EMIT downloads. Stop the API, then run this command from `backend/` with the virtual environment active.

```sh
python -c 'import earthaccess; earthaccess.login(strategy="interactive", persist=True)'
```

Enter your NASA Earthdata credentials at the terminal prompt. This saves them to your local Earthdata netrc file. You can also set `EARTHDATA_TOKEN` in the backend environment. Keep authentication details in your local environment.

Restart the API, open an analysis or replay, select an Earth site, and choose **Fetch mineral data**. The app searches NASA CMR for scenes covering the route, fetches matching reflectance and quality-mask files, and checks the usable coverage. The first fetch can take a while because it downloads and processes large files. Prepared scenes are cached locally.

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
- `POST /analyses` accepts `a` and `b` objects with `lat` and `lon` in decimal degrees, plus optional `preset`, `lunarUtc` (ISO timestamp with timezone), and `earthStart` (UTC date).
- `GET /analyses/{id}` returns queued, running, complete, or failed status and the result or error.
- `GET /analyses/{id}/report?site=pinacate` exports the stored result as a ZIP with a Markdown report, source manifest, profiles, Earth GeoJSON, and separately framed lunar geometry. Omit `site` for the top matched candidate. Pass `preset` to apply a different report objective to the same terrain analysis.

Lunar routes use ordered snapped endpoints and a 20° along-step grade ceiling. Earth matching uses bounded deterministic sampling and a ±20% path-length tolerance with a two-cell minimum. A missing Earth result means the search found no eligible match within its configured limits.
