"""
FastAPI skeleton for the lunar-analogs service.
Implements the contract in handoff §8.
Full pipeline (Phases 6–9) is intentionally left as a TODO so the frontend
can be developed against fixtures / replay first.
"""

from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from src.config import VERSION

app = FastAPI(title="Earth Analogs for a Lunar Route", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

pool = ThreadPoolExecutor(max_workers=2)
jobs: dict[str, dict[str, Any]] = {}
cache: dict[str, dict[str, Any]] = {}


class AnalysisRequest(BaseModel):
    a: tuple[float, float] = Field(..., description="[lon, lat]")
    b: tuple[float, float] = Field(..., description="[lon, lat]")
    preset: str = "rover_navigation"
    utc: str | None = None


@app.get("/config")
def get_config() -> dict:
    return {
        "version": VERSION,
        "moon_bbox": [3.0, 25.6, 4.3, 26.6],
        "route_limits_m": [5000, 10000],
        "presets": {
            "rover_navigation": {"slope": 0.35, "rough": 0.35, "lighting": 0.25, "minerals": 0.05},
            "camera_lighting": {"slope": 0.15, "rough": 0.15, "lighting": 0.60, "minerals": 0.10},
            "mineral_mapping": {"slope": 0.10, "rough": 0.10, "lighting": 0.15, "minerals": 0.65},
        },
        "note": "Skeleton – full grids and live routing not yet loaded.",
    }


@app.post("/analyses")
def start_analysis(req: AnalysisRequest) -> dict:
    # Cache key must include snapped endpoints + parameters + version (handoff §12 item 7)
    # For now we hash the raw request; replace with snapped coords once routing exists.
    key_src = json.dumps([req.a, req.b, req.utc, req.preset, VERSION], sort_keys=True)
    key = hashlib.sha1(key_src.encode()).hexdigest()[:16]

    if key in cache:
        return {"id": key, "status": "done", "cached": True}

    job_id = key
    jobs[job_id] = {"status": "queued", "result": None}

    def work():
        jobs[job_id]["status"] = "running"
        time.sleep(0.5)  # placeholder
        # TODO: call real pipeline (snap → lunar route → earth search → lighting → rank)
        # For now return a fixture-shaped response so the frontend can be wired.
        result = {
            "scenario": "skeleton",
            "lunar": {"length_m": None, "slope_mean": None, "rough_mean": None},
            "candidates": [],
            "note": "Replace with real pipeline output. Use /fixtures or replay for development.",
        }
        jobs[job_id] = {"status": "done", "result": result}
        cache[job_id] = result

    pool.submit(work)
    return {"id": job_id, "status": "queued"}


@app.get("/analyses/{job_id}")
def get_analysis(job_id: str) -> dict:
    if job_id not in jobs and job_id not in cache:
        raise HTTPException(404, "Unknown analysis id")
    if job_id in cache:
        return {"status": "done", "cached": True, "result": cache[job_id]}
    return jobs[job_id]


@app.get("/moon/xy_to_lonlat")
def xy_to_lonlat(x: float, y: float) -> dict:
    """Single conversion implementation (pyproj). Skeleton returns identity for now."""
    # TODO: Transformer.from_crs(MOON_CRS, MOON_LONLAT, always_xy=True)
    return {"lon": None, "lat": None, "note": "Implement with pyproj once grids exist"}
