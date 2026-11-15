"""AstroScan geographic terrain analysis API."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from hashlib import sha256
from threading import Lock
from typing import Literal
import httpx
import json
import logging
import os
import subprocess
import sys
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from src.analog_sites import NASA_ANALOGS
from src.config import (ALGORITHM_VERSION, CACHE, CORRIDOR_WIDTH, MAX_GRADE, MAX_LENGTH, MIN_COVERAGE,
                        MOON_BOUNDS, MOON_FRAME, MOON_RADIUS, PRESETS, RESOLUTION, ROOT, ROUGHNESS_WINDOW,
                        SEARCH_DEADLINE, SNAP_RADIUS, TERRAIN_WEIGHTS)
from src.earth_imagery import imagery_enabled, satellite_image
from src.lunar_regions import available_lunar_regions, terrain_version
from src.pipeline import AnalysisError, publish, snap_endpoints
from src.reports import export_bundle
from src.science import SOURCES, apply_preset, rankings, science_version
from src.fetch_emit import fetch, replay
from src.config import DEFAULT_LUNAR_UTC, NOMINAL_WEIGHTS
from src.terrain import source_manifest

LOG = logging.getLogger(__name__)
MAX_PENDING = 4
Preset = Literal["rover_navigation", "camera_lighting", "mineral_mapping"]


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class EarthCenter(Point):
    # Keep the full search window inside UTM limits and away from the date line.
    lat: float = Field(ge=-79, le=83)
    lon: float = Field(ge=-176, le=176)


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    a: Point
    b: Point
    lunarRegion: Literal["hadley", "serenitatis"] = "hadley"
    earthCenter: EarthCenter | None = None
    earthSite: str | None = None
    earthSites: list[str] = Field(default_factory=list, max_length=len(NASA_ANALOGS))
    preset: Preset = "rover_navigation"
    lunarUtc: AwareDatetime = datetime.fromisoformat(DEFAULT_LUNAR_UTC)
    earthStart: date = Field(default_factory=lambda: datetime.now(timezone.utc).date())

    @field_validator("lunarUtc", "earthStart", mode="after")
    @classmethod
    def valid_scenario(cls, value):
        if not 1900 <= value.year <= 2100:
            raise ValueError("Choose a scenario between 1900 and 2100.")
        return value

    @model_validator(mode="after")
    def valid_earth_selection(self):
        if self.earthSite is not None and (self.earthSites or self.earthCenter is not None):
            raise ValueError("Use one named site or the multi-site selection.")
        sites = [self.earthSite] if self.earthSite is not None else self.earthSites
        if any(site not in NASA_ANALOGS for site in sites):
            raise ValueError("Choose NASA analogs from the Earth site catalog.")
        return self


def digest(value):
    return sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def read_result(path):
    return json.loads(path.read_text()) if path.is_file() else None


def write_result(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".tmp").open("w") as output:
        json.dump(value, output, ensure_ascii=False, allow_nan=False)
    path.with_suffix(".tmp").replace(path)


class Analyses:
    def __init__(self):
        self.lock = Lock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="terrain")
        self.jobs = {}
        self.custom_results = {}

    def status(self, analysis_id):
        with self.lock:
            status = self.jobs.get(analysis_id) or self.custom_results.get(analysis_id)
            if status:
                return status
        result = read_result(CACHE / "analyses" / f"{analysis_id}.json")
        return {"id": analysis_id, "status": "complete", "result": result} if result else None

    def submit(self, request):
        requested = {"A": request.a.model_dump(), "B": request.b.model_dump()}
        cells, snapped = snap_endpoints(requested, request.lunarRegion)
        cache_key = digest([
            cells, request.lunarRegion, ALGORITHM_VERSION, terrain_version(request.lunarRegion), RESOLUTION, SNAP_RADIUS,
            MAX_LENGTH, MAX_GRADE, CORRIDOR_WIDTH, MIN_COVERAGE, ROUGHNESS_WINDOW, TERRAIN_WEIGHTS,
        ])
        lunar_utc = request.lunarUtc.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        earth_start = request.earthStart.isoformat()
        science_key = digest([cache_key, lunar_utc, earth_start, science_version()])
        analysis_id = digest([science_key, requested, request.preset])[:24]
        result_path = CACHE / "analyses" / f"{analysis_id}.json"
        sites = [request.earthSite] if request.earthSite is not None else request.earthSites
        regions = {site: NASA_ANALOGS[site]["center"] for site in sorted(set(sites))}
        if request.earthCenter is not None:
            regions["custom"] = request.earthCenter.model_dump()
        if regions:
            analysis_id = digest([analysis_id, regions, "remote-earth-v3"])[:24]
        with self.lock:
            cached = self.custom_results.get(analysis_id)
            if cached and all(c.get("relief") for c in cached["result"]["candidates"] if c["id"] in regions):
                return cached
            if self.jobs.get(analysis_id, {}).get("status") in ("queued", "running"):
                return self.jobs[analysis_id]
            result = read_result(result_path) if not regions else None
            if result is not None:
                return {"id": analysis_id, "status": "complete", "result": result}
            pending = sum(job["status"] in ("queued", "running") for job in self.jobs.values())
            if pending >= MAX_PENDING:
                raise HTTPException(503, detail={"code": "busy", "message": "The terrain queue is full. Try again shortly."})
            self.jobs[analysis_id] = {"id": analysis_id, "status": "queued"}
            self.pool.submit(self.run, analysis_id, result_path, cache_key, cells, requested, snapped, request.preset,
                             science_key, lunar_utc, earth_start, regions, request.lunarRegion)
            return self.jobs[analysis_id]

    def run(self, analysis_id, result_path, cache_key, cells, requested, snapped, preset,
            science_key, lunar_utc, earth_start, regions, lunar_region):
        with self.lock:
            self.jobs[analysis_id] = {"id": analysis_id, "status": "running"}
        try:
            if regions:
                worker = subprocess.run([sys.executable, "-m", "src.worker", "custom"], cwd=ROOT, text=True,
                                        input=json.dumps({"cells": cells, "regions": regions, "lunarUtc": lunar_utc,
                                                          "earthStart": earth_start, "lunarRegion": lunar_region}),
                                        capture_output=True, timeout=210, check=True)
                output = json.loads(worker.stdout)
                if "error" in output:
                    raise AnalysisError(output["error"]["code"], output["error"]["message"])
                science = output["science"]
                science["lighting"] = {"utc": lunar_utc, "earthStart": earth_start, **(science.get("lighting") or {})}
                result = publish(output["data"], requested, snapped, preset, analysis_id, science)
                result["customImagery"] = imagery_enabled()
                with self.lock:
                    self.custom_results[analysis_id] = {"id": analysis_id, "status": "complete", "result": result}
                    if len(self.custom_results) > 12:
                        self.custom_results.pop(next(iter(self.custom_results)))
                    self.jobs.pop(analysis_id)
                return
            terrain_path = CACHE / "terrain" / f"{cache_key}.json"
            data = read_result(terrain_path)
            if data is None:
                result = subprocess.run([sys.executable, "-m", "src.worker"], cwd=ROOT, text=True,
                                        input=json.dumps({"cells": cells, "lunarRegion": lunar_region}),
                                        capture_output=True, timeout=SEARCH_DEADLINE)
                if result.returncode:
                    raise RuntimeError(result.stderr)
                output = json.loads(result.stdout)
                if "error" in output:
                    error = output["error"]
                    raise AnalysisError(error["code"], error["message"])
                data = output["data"]
                write_result(terrain_path, data)
            science_path = CACHE / "science" / f"{science_key}.json"
            science = read_result(science_path)
            if science is None:
                try:
                    worker = subprocess.run([sys.executable, "-m", "src.worker", "science"], cwd=ROOT,
                                            text=True, input=json.dumps({
                                                "terrain": data, "lunarUtc": lunar_utc, "earthStart": earth_start,
                                            }), capture_output=True, timeout=SEARCH_DEADLINE, check=True)
                    science = json.loads(worker.stdout)["data"]
                    write_result(science_path, science)
                except (subprocess.SubprocessError, ValueError, KeyError):
                    LOG.exception("Scientific layers unavailable for %s", analysis_id)
                    science = {"lighting": {"status": "unavailable", "reason": "The scientific calculation could not finish."}}
            science["lighting"] = {"utc": lunar_utc, "earthStart": earth_start, **(science.get("lighting") or {})}
            write_result(result_path, publish(data, requested, snapped, preset, analysis_id, science))
        except subprocess.TimeoutExpired:
            self.fail(analysis_id, "timeout", "On-demand Earth terrain analysis timed out. Try again or choose another area."
                      if regions else "Terrain analysis reached its time limit. Try a different route or use a replay case.")
        except AnalysisError as error:
            self.fail(analysis_id, error.code, str(error))
        except Exception:
            LOG.exception("Terrain analysis %s failed", analysis_id)
            self.fail(analysis_id, "unavailable", "Terrain analysis is unavailable. Try again or use a replay case.")
        else:
            with self.lock:
                self.jobs.pop(analysis_id, None)

    def fail(self, analysis_id, code, message):
        with self.lock:
            self.jobs[analysis_id] = {"id": analysis_id, "status": "failed", "error": {"code": code, "message": message}}
            failures = [key for key, job in self.jobs.items() if job["status"] == "failed"]
            for key in failures[:-64]:
                self.jobs.pop(key, None)


class EmitJobs:
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="emit")
        self.lock = Lock()
        self.jobs = {}
        self.requests = {}

    def start(self, result, site):
        key = (result["id"], site)
        with self.lock:
            previous = self.requests.get(key)
            if previous and self.jobs.get(previous, {}).get("status") in ("queued", "running", "complete"):
                return {"id": previous}
            pending = sum(job["status"] in ("queued", "running") for job in self.jobs.values())
            if pending >= MAX_PENDING:
                raise HTTPException(503, detail={"message": "The mineral fetch queue is full. Try again shortly."})
            job_id = uuid4().hex[:24]
            self.jobs[job_id] = {"status": "queued", "message": "Waiting for the mineral fetch worker."}
            finished = [job for job, entry in self.jobs.items() if entry["status"] in ("complete", "failed")]
            for job in finished[:max(0, len(self.jobs) - 20)]:
                self.jobs.pop(job)
            self.requests[key] = job_id
            self.requests = {request: job for request, job in self.requests.items() if job in self.jobs}
            self.pool.submit(self.run, job_id, result, site)
        return {"id": job_id}

    def run(self, job_id, result, site):
        def progress(message):
            with self.lock:
                self.jobs[job_id] = {"status": "running", "message": message}

        progress("Searching NASA’s catalog.")
        try:
            strategy = "environment" if (os.getenv("EARTHDATA_TOKEN") or
                        (os.getenv("EARTHDATA_USERNAME") and os.getenv("EARTHDATA_PASSWORD"))) else "netrc"
            evidence = fetch(result, site, strategy, progress)
            candidates = [{**c, "minerals": evidence} if c["id"] == site else c for c in result["candidates"]]
            updated = apply_preset({**result, "id": job_id, "mode": "live", "fetchedSite": site, "candidates": candidates,
                                    "rankings": rankings(candidates)}, result["preset"])
            status = {"status": "complete", "result": updated}
        except PermissionError:
            status = {"status": "failed", "message": "Sign in locally using the Earthdata command in the README, or configure an Earthdata token on the backend and restart it."}
        except Exception as error:
            LOG.warning("EMIT remote read failed (%s)", type(error).__name__)
            status = {"status": "failed", "message": "Could not fetch matching EMIT files from NASA. Check Earthdata access or try again."}
        with self.lock:
            self.jobs[job_id] = status


@asynccontextmanager
async def lifespan(app):
    app.state.analyses = Analyses()
    app.state.emit = EmitJobs()
    try:
        yield
    finally:
        app.state.analyses.pool.shutdown(cancel_futures=True)
        app.state.emit.pool.shutdown(cancel_futures=True)


app = FastAPI(title="AstroScan terrain analysis", version=ALGORITHM_VERSION, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv(
    "ASTROSCAN_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173"
).split(","), allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.get("/health")
def health():
    try:
        manifest = source_manifest()
    except FileNotFoundError:
        raise HTTPException(503, detail="Terrain assets are missing. Run python -m src.prepare.")
    return {"status": "ok", "dataVersion": manifest["dataVersion"], "scienceVersion": science_version()}


@app.get("/earth-sites")
def earth_sites():
    return [{"id": site_id, **site} for site_id, site in NASA_ANALOGS.items()]


@app.get("/config")
def config():
    try:
        manifest = source_manifest()
    except FileNotFoundError as error:
        raise HTTPException(503, detail="Terrain assets are missing. Run python -m src.prepare.") from error
    return {
        "lunarRegions": available_lunar_regions(),
        "coverage": MOON_BOUNDS, "coordinateOrder": ["longitude", "latitude"], "frame": MOON_FRAME,
        "moonRadiusM": MOON_RADIUS, "maxRouteKm": MAX_LENGTH / 1000, "snapRadiusM": SNAP_RADIUS,
        "resolutionM": RESOLUTION, "maxGradeDeg": MAX_GRADE, "roughnessWindowM": ROUGHNESS_WINDOW,
        "corridorHalfWidthM": CORRIDOR_WIDTH, "minimumCorridorCoverage": MIN_COVERAGE,
        "algorithmVersion": ALGORITHM_VERSION, "defaultLunarUtc": DEFAULT_LUNAR_UTC,
        "scienceVersion": science_version(),
        "presets": [{"id": key, "label": value, "nominalWeights": NOMINAL_WEIGHTS[key]}
                    for key, value in PRESETS.items()],
        "assets": {"moonBasemap": "terrain/hadley-wac.webp", "moonBasemapBounds": "terrain/hadley-wac.json"},
        **manifest, "sources": manifest["sources"] + SOURCES,
    }


@app.post("/analyses", status_code=202)
def submit(request: AnalysisRequest):
    try:
        return app.state.analyses.submit(request)
    except AnalysisError as error:
        raise HTTPException(422, detail={"code": error.code, "message": str(error)}) from error
    except FileNotFoundError as error:
        raise HTTPException(503, detail={"code": "unavailable", "message": "The terrain assets have not been prepared."}) from error


def known_analysis(analysis_id):
    with app.state.emit.lock:
        fetched = app.state.emit.jobs.get(analysis_id)
    if fetched and fetched["status"] == "complete":
        return {"id": analysis_id, **fetched}
    status = app.state.analyses.status(analysis_id)
    if status is None:
        raise HTTPException(404, detail="Analysis not found.")
    return status


@app.get("/analyses/{analysis_id}")
def analysis(analysis_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    validate_id(analysis_id)
    return known_analysis(analysis_id)


@app.get("/analyses/{analysis_id}/report")
def report(analysis_id: str, site: str | None = Query(None), preset: Preset | None = Query(None)):
    validate_id(analysis_id)
    status = known_analysis(analysis_id)
    if status["status"] != "complete":
        raise HTTPException(409, detail="The analysis has no completed result.")
    try:
        result = status["result"]
        bundle = export_bundle(apply_preset(result, preset or result["preset"]), site)
    except ValueError as error:
        raise HTTPException(404, detail=str(error)) from error
    return Response(bundle, media_type="application/zip",
                    headers={"Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="astroscan-{analysis_id}.zip"'})


@app.get("/analyses/{analysis_id}/earth-imagery")
def earth_imagery(analysis_id: str, site: str | None = None):
    validate_id(analysis_id)
    status = known_analysis(analysis_id)
    result = status.get("result", {})
    remote = next((candidate for candidate in result.get("candidates", [])
                   if candidate.get("relief") and (site is None or candidate["id"] == site)), None)
    if remote is None or not imagery_enabled():
        raise HTTPException(404, detail="Satellite imagery is unavailable for this analysis.")
    try:
        image = satellite_image(tuple(remote["bounds"]), datetime.now(timezone.utc).date())
    except (httpx.HTTPError, KeyError, ValueError) as error:
        LOG.warning("Sentinel-2 imagery request failed (%s)", type(error).__name__)
        raise HTTPException(502, detail="Could not load Sentinel-2 imagery.") from None
    return Response(image, media_type="image/png", headers={"Cache-Control": "no-store"})


def validate_id(analysis_id):
    if len(analysis_id) != 24 or any(character not in "0123456789abcdef" for character in analysis_id):
        raise HTTPException(404, detail="Analysis not found.")


@app.post("/analyses/{analysis_id}/emit/{site}", status_code=202)
def start_emit(analysis_id: str, site: str):
    if analysis_id in ("replay-rille", "replay-hadley"):
        result = replay(analysis_id.removeprefix("replay-"))
    else:
        validate_id(analysis_id)
        status = known_analysis(analysis_id)
        if status["status"] != "complete":
            raise HTTPException(409, detail={"message": "Complete the route analysis first."})
        result = status["result"]
    if not any(c["id"] == site and c.get("route") for c in result["candidates"]):
        raise HTTPException(404, detail={"message": "Select an Earth site with a computed route."})
    return app.state.emit.start(result, site)


@app.get("/emit/{job_id}")
def emit_status(job_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    validate_id(job_id)
    with app.state.emit.lock:
        status = app.state.emit.jobs.get(job_id)
    if status is None:
        raise HTTPException(404, detail={"message": "EMIT fetch not found."})
    return status
